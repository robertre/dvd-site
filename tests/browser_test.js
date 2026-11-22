// Drives the real page in headless Chrome. Run: node --test tests/browser_test.js
//
// Starts a local web server for dvd-site/, starts Chrome, and talks to it over
// the DevTools protocol. Screenshots go to tests/shots/.
//
// The tests use a copy of the Sheet from 2026-11-21 (tests/fixtures/sheet.csv)
// and the old thumbnails only, so they keep passing as the collection changes.
// To also check that the page can read the real published Sheet (needs
// internet access): LIVE=1 node --test tests/browser_test.js
'use strict';

const assert = require('node:assert/strict');
const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const SITE = path.join(__dirname, '..');
const SHOTS = path.join(__dirname, 'shots');
const TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.csv': 'text/csv', '.jpg': 'image/jpeg', '.png': 'image/png'};

// ---------------------------------------------------------------------------
// Local web server with per-test overrides
// ---------------------------------------------------------------------------

const overrides = new Map(); // path -> {status, type, body}
const hits = new Map();

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    hits.set(p, (hits.get(p) || 0) + 1);
    const send = (status, type, body) => {
      res.writeHead(status, {'Content-Type': type, 'Cache-Control': 'no-store'});
      res.end(body);
    };
    if (overrides.has(p)) {
      const o = overrides.get(p);
      return send(o.status || 200, o.type || TYPES[path.extname(p)] || 'text/plain', o.body || '');
    }
    const file = path.join(SITE, p);
    if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return send(404, 'text/plain', 'not found');
    }
    send(200, TYPES[path.extname(p)] || 'application/octet-stream', fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---------------------------------------------------------------------------
// Chrome over the DevTools protocol
// ---------------------------------------------------------------------------

class Chrome {
  static async launch() {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dvd-chrome-'));
    const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
      '--remote-debugging-port=0', '--user-data-dir=' + profile,
      ...(process.env.CHROME_FLAGS ? process.env.CHROME_FLAGS.split(' ') : []), 'about:blank'];
    // Chrome's crash reporter needs writable config and cache folders; give it
    // throwaway ones so the test also runs where the home folder is read-only.
    const env = {...process.env,
      XDG_CONFIG_HOME: path.join(profile, 'config'), XDG_CACHE_HOME: path.join(profile, 'cache')};
    const proc = spawn(process.env.CHROME || 'google-chrome', args,
        {stdio: ['ignore', 'ignore', 'pipe'], env});
    let log = '';
    const wsUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chrome did not start:\n' + log)), 30000);
      proc.stderr.on('data', (chunk) => {
        log += chunk;
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(log);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
      proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Chrome exited (${code}):\n${log}`)); });
    });
    const chrome = new Chrome();
    chrome.proc = proc;
    chrome.profile = profile;
    chrome.nextId = 1;
    chrome.pending = new Map();
    chrome.listeners = [];
    chrome.ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      chrome.ws.addEventListener('open', resolve);
      chrome.ws.addEventListener('error', () => reject(new Error('DevTools socket failed')));
    });
    chrome.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && chrome.pending.has(msg.id)) {
        const {resolve, reject} = chrome.pending.get(msg.id);
        chrome.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      } else if (msg.method) {
        chrome.listeners.forEach((fn) => fn(msg));
      }
    });
    return chrome;
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      this.ws.send(JSON.stringify({id, method, params, sessionId}));
    });
  }

  /** Opens a tab with its own storage (nothing saved by other tests). */
  async newPage({width = 390, height = 844, dpr = 2, mobile = true} = {}) {
    const {browserContextId} = await this.send('Target.createBrowserContext');
    const {targetId} = await this.send('Target.createTarget', {url: 'about:blank', browserContextId});
    const {sessionId} = await this.send('Target.attachToTarget', {targetId, flatten: true});
    const page = new Page(this, sessionId);
    this.listeners.push((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        page.errors.push((d.exception && d.exception.description) || d.text);
      }
      if (msg.method === 'Page.javascriptDialogOpening') {
        page.dialogs.push(msg.params.message);
        page.send('Page.handleJavaScriptDialog', {accept: page.acceptDialogs});
      }
    });
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride',
        {width, height, deviceScaleFactor: dpr, mobile});
    return page;
  }

  async close() {
    // Chrome may drop the connection before it answers, so don't wait for long.
    await Promise.race([
      this.send('Browser.close').catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    this.ws.close();
    this.proc.kill('SIGKILL');
    fs.rmSync(this.profile, {recursive: true, force: true, maxRetries: 3});
  }
}

class Page {
  constructor(chrome, sessionId) {
    this.chrome = chrome;
    this.sessionId = sessionId;
    this.errors = [];
    this.dialogs = [];        // texts of confirm() boxes the page showed
    this.acceptDialogs = true; // what to answer
  }
  send(method, params) { return this.chrome.send(method, params, this.sessionId); }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate',
        {expression, awaitPromise: true, returnByValue: true});
    if (r.exceptionDetails) {
      throw new Error('In page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }

  async waitFor(expression, what = expression, timeout = 15000) {
    const end = Date.now() + timeout;
    for (;;) {
      if (await this.eval(`!!(${expression})`)) return;
      if (Date.now() > end) throw new Error('Timed out waiting for: ' + what);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async goto(url) {
    await this.send('Page.navigate', {url});
    await this.waitFor('document.readyState === "complete" && location.href !== "about:blank"', 'page load');
  }

  /** Waits until the list is drawn. */
  async ready(count) {
    await this.waitFor(`document.querySelectorAll("#grid:not([hidden]) .tile, #table:not([hidden]) tbody tr").length === ${count}`,
        `${count} titles on screen`);
  }

  type(text) {
    return this.eval(`(() => { const q = document.getElementById("q"); q.value = ${JSON.stringify(text)};
      q.dispatchEvent(new Event("input", {bubbles: true})); })()`);
  }

  choose(id, value) {
    return this.eval(`(() => { const s = document.getElementById(${JSON.stringify(id)});
      s.value = ${JSON.stringify(value)};
      if (s.value !== ${JSON.stringify(value)}) throw new Error("no option " + ${JSON.stringify(value)} + " in " + ${JSON.stringify(id)});
      s.dispatchEvent(new Event("change", {bubbles: true})); })()`);
  }

  click(selector) {
    return this.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)});
      if (!e) throw new Error("nothing matches " + ${JSON.stringify(selector)}); e.click(); })()`);
  }

  text(selector) {
    return this.eval(`(document.querySelector(${JSON.stringify(selector)}) || {}).textContent || ""`);
  }

  /** Folder numbers currently on screen, in order. */
  numbers() {
    return this.eval(`[...document.querySelectorAll("#grid:not([hidden]) .tile .num, #table:not([hidden]) .t-num")]
      .map((e) => Number(e.textContent))`);
  }

  async key(key, code) {
    const base = {key, code, windowsVirtualKeyCode: code === 'Escape' ? 27 : 0};
    await this.send('Input.dispatchKeyEvent', {type: 'keyDown', ...base});
    await this.send('Input.dispatchKeyEvent', {type: 'keyUp', ...base});
  }

  /** Types into a form field the way a person would: set the value, fire "input". */
  fill(selector, value) {
    return this.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)});
      if (!e) throw new Error("nothing matches " + ${JSON.stringify(selector)});
      e.value = ${JSON.stringify(String(value))};
      e.dispatchEvent(new Event("input", {bubbles: true}));
      e.dispatchEvent(new Event("change", {bubbles: true})); })()`);
  }

  /** Prints the page to a PDF file, as the print dialog would at 100% scale. */
  async pdf(name, {width = 8.27, height = 11.69} = {}) {
    fs.mkdirSync(SHOTS, {recursive: true});
    const {data} = await this.send('Page.printToPDF',
        {paperWidth: width, paperHeight: height, scale: 1, printBackground: false,
          preferCSSPageSize: false, displayHeaderFooter: false});
    const file = path.join(SHOTS, name + '.pdf');
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }

  async shot(name) {
    fs.mkdirSync(SHOTS, {recursive: true});
    const {data} = await this.send('Page.captureScreenshot', {format: 'png'});
    fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(data, 'base64'));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let server;
let chrome;
let base;

test.before(async () => {
  server = await startServer();
  base = `http://127.0.0.1:${server.address().port}`;
  chrome = await Chrome.launch();
});

test.after(async () => {
  try {
    if (chrome) await chrome.close();
  } finally {
    if (server) {
      server.closeAllConnections();
      server.close();
    }
  }
});

const FIXTURE_CSV = fs.readFileSync(path.join(__dirname, 'fixtures', 'sheet.csv'));

/** Serves the 2026-11-21 copy of the Sheet with the old thumbnails as the only covers. */
function useFixtureCollection() {
  const legacy = fs.readdirSync(path.join(SITE, 'covers', 'legacy'))
      .map((f) => parseInt(f, 10)).filter((n) => n > 0).sort((a, b) => a - b);
  overrides.set('/config.js', {body: 'window.DVD_CONFIG = {sheetCsvUrl: "/sheet.csv", title: "DVD collection"};'});
  overrides.set('/sheet.csv', {body: FIXTURE_CSV});
  overrides.set('/data/snapshot.csv', {body: FIXTURE_CSV});
  overrides.set('/covers/index.json', {body: JSON.stringify({covers: {}, legacy})});
}

test.beforeEach(() => { overrides.clear(); hits.clear(); });

const localConfig = (url) => ({
  body: `window.DVD_CONFIG = {sheetCsvUrl: ${JSON.stringify(url)}, title: "Test shelf"};`,
});

test('whole collection on a phone: grid, search, filters, detail, table', async () => {
  useFixtureCollection();
  const page = await chrome.newPage();
  await page.goto(base + '/');
  await page.ready(367);
  assert.equal(await page.eval('document.getElementById("status").hidden'), true);

  assert.equal(await page.text('#count'), '367 titles');
  assert.equal(await page.eval('document.title'), 'DVD collection');
  // Default order is by title; every tile carries its folder number.
  const all = await page.numbers();
  assert.equal(all.length, 367);
  assert.equal(new Set(all).size, 367);

  // Covers above the fold really load.
  await page.waitFor(`[...document.querySelectorAll("#grid .tile img")].slice(0, 6)
      .every((i) => i.complete && i.naturalWidth > 0)`, 'first covers to load');
  await page.shot('phone-grid');

  // Number 15 has no cover of any kind: it shows its title instead.
  await page.type('desolation');
  assert.deepEqual(await page.numbers(), [15]);
  assert.equal(await page.eval('document.querySelectorAll("#grid .cover-missing").length'), 1);
  assert.match(await page.text('#grid .cover-missing-title'), /Desolation of Smaug/);

  // Search.
  await page.type('matrix');
  assert.deepEqual((await page.numbers()).sort((a, b) => a - b), [31, 32, 33]);
  assert.equal(await page.text('#count'), '3 of 367');
  await page.type('big runaround');
  assert.deepEqual(await page.numbers(), [135]);
  await page.type('135');
  assert.ok((await page.numbers()).includes(135));
  await page.type('qqqq');
  assert.deepEqual(await page.numbers(), []);
  assert.equal(await page.eval('document.getElementById("empty").hidden'), false);
  await page.click('#empty-reset');
  await page.ready(367);
  assert.equal(await page.eval('document.getElementById("q").value'), '');

  // Filters.
  assert.equal(await page.eval('document.getElementById("filters").hidden'), true);
  const barPosition = 'getComputedStyle(document.querySelector(".bar")).position';
  assert.equal(await page.eval(barPosition), 'sticky');
  await page.click('#filters-toggle');
  assert.equal(await page.eval('document.getElementById("filters").hidden'), false);
  assert.equal(await page.eval(barPosition), 'static', 'the open filter panel scrolls away');
  await page.choose('f-audio', 'RU');
  assert.equal(await page.text('#count'), '48 of 367');
  assert.equal(await page.text('#filters-toggle'), 'Filters (1)');
  await page.choose('f-genre', 'Animation');
  const russianAnimation = await page.numbers();
  assert.ok(russianAnimation.length > 0 && russianAnimation.length < 35);
  assert.equal(await page.text('#filters-toggle'), 'Filters (2)');
  await page.shot('phone-filters');
  await page.click('#filters-reset');
  await page.ready(367);
  assert.equal(await page.text('#filters-toggle'), 'Filters');
  await page.choose('f-series', 'James Bond');
  const bond = await page.numbers();
  assert.ok(bond.length >= 20, 'Bond films: ' + bond.length);
  await page.choose('f-sort', 'number:1');
  assert.deepEqual(await page.numbers(), bond.slice().sort((a, b) => a - b));
  await page.choose('f-maxlen', '120');
  const shortBond = await page.numbers();
  assert.ok(shortBond.length > 0 && shortBond.length < bond.length);
  await page.click('#filters-reset');
  await page.choose('f-sort', 'rating:-1');
  assert.equal(await page.eval('document.querySelector("#grid .tile-meta").textContent.includes("★")'), true);
  await page.choose('f-sort', 'title:1');
  await page.click('#filters-toggle');
  assert.equal(await page.eval(barPosition), 'sticky');

  // Detail view.
  await page.type('grande vadrouille');
  await page.click('#grid .tile');
  await page.waitFor('document.getElementById("detail").open', 'detail to open');
  assert.equal(await page.eval('location.hash'), '#135');
  assert.equal(await page.text('#detail .detail-num-value'), '135');
  assert.equal(await page.text('#detail h2'), 'La Grande Vadrouille');
  assert.match(await page.text('#detail .detail-sub'), /The Big Runaround · 1966/);
  assert.equal(await page.eval('document.querySelector("#detail .imdb-link").href'),
      'https://www.imdb.com/title/tt0060474/');
  const facts = await page.eval(`Object.fromEntries([...document.querySelectorAll("#detail .fact")]
      .map((f) => [f.querySelector("dt").textContent, f.querySelector("dd").textContent]))`);
  assert.equal(facts['Length'], '2h 00 (IMDb: 2h 12)');
  assert.equal(facts['IMDb rating'], '8.0');
  assert.equal(facts['Status'], 'Not seen yet');
  assert.equal(facts['Series'], 'Louis de Funès');
  assert.equal(facts['Audio'], 'Français');
  assert.ok(facts['Cast'].includes('Louis de Funès'));
  await page.waitFor('(() => { const i = document.querySelector("#detail img"); return i && i.complete && i.naturalWidth > 0; })()', 'detail cover');
  await page.shot('phone-detail');

  // Close with Esc: dialog closes and the #number goes away.
  await page.key('Escape', 'Escape');
  await page.waitFor('!document.getElementById("detail").open && location.hash === ""', 'Esc to close');
  // Open again, close with the phone's Back button.
  await page.click('#grid .tile');
  await page.waitFor('document.getElementById("detail").open');
  await page.eval('history.back()');
  await page.waitFor('!document.getElementById("detail").open && location.hash === ""', 'Back to close');
  assert.equal(await page.eval('location.pathname'), '/', 'Back stayed on the page');
  // Open again, close with the × button.
  await page.click('#grid .tile');
  await page.waitFor('document.getElementById("detail").open');
  await page.click('#detail .detail-close');
  await page.waitFor('!document.getElementById("detail").open && location.hash === ""', '× to close');
  // Closing one title and tapping another in the same instant opens the other one.
  await page.type('');
  await page.ready(367);
  await page.click('#grid .tile:nth-child(1)');
  await page.waitFor('document.getElementById("detail").open');
  const second = await page.eval('document.querySelector("#grid .tile:nth-child(2) .num").textContent');
  await page.eval(`(() => { document.querySelector("#detail .detail-close").click();
      document.querySelector("#grid .tile:nth-child(2)").click(); })()`);
  const secondIsOpen = `document.getElementById("detail").open && location.hash === "#${second}" &&
      document.querySelector("#detail .detail-num-value").textContent === "${second}"`;
  await page.waitFor(secondIsOpen, 'the second title to open');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await page.eval(secondIsOpen), true, 'and it stays open');
  // The same when the browser closes the dialog by itself, as it does for the
  // Esc key: its "close" event comes late, after the tap on the other title.
  const first = await page.eval('document.querySelector("#grid .tile:nth-child(1) .num").textContent');
  await page.eval(`(() => { document.getElementById("detail").close();
      document.querySelector("#grid .tile:nth-child(1)").click(); })()`);
  const firstIsOpen = `document.getElementById("detail").open && location.hash === "#${first}" &&
      document.querySelector("#detail .detail-num-value").textContent === "${first}"`;
  await page.waitFor(firstIsOpen, 'the first title to open');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await page.eval(firstIsOpen), true, 'and it stays open');
  // And with the real Esc key, tapping as soon as the dialog is gone.
  await page.key('Escape', 'Escape');
  await page.waitFor('!document.getElementById("detail").open');
  await page.click('#grid .tile:nth-child(2)');
  await page.waitFor(secondIsOpen, 'the second title to open again');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await page.eval(secondIsOpen), true, 'and it stays open');
  // After all that, one close really closes: no earlier title comes back,
  // and the page's own entry is the only one left to go back from.
  const closedForGood = '!document.getElementById("detail").open && location.hash === ""';
  await page.click('#detail .detail-close');
  await page.waitFor(closedForGood);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await page.eval(closedForGood), true, 'and it stays closed');
  await page.click('#grid .tile:nth-child(1)');
  await page.waitFor(firstIsOpen);
  await page.key('Escape', 'Escape');
  await page.waitFor(closedForGood, 'Esc to close for good');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await page.eval(closedForGood), true, 'and it stays closed');
  await page.type('grande vadrouille');
  // The series link in the detail view filters the list.
  await page.click('#grid .tile');
  await page.waitFor('document.getElementById("detail").open');
  await page.click('#detail .fact .link');
  await page.waitFor('!document.getElementById("detail").open');
  assert.equal(await page.eval('document.getElementById("f-series").value'), 'Louis de Funès');
  assert.equal(await page.eval('document.getElementById("q").value'), '');
  assert.ok((await page.numbers()).includes(135));
  await page.click('#filters-reset');

  // Table view.
  await page.click('#view-toggle');
  await page.ready(367);
  assert.equal(await page.eval('document.getElementById("grid").hidden'), true);
  assert.equal(await page.text('#view-toggle'), 'Covers');
  const headers = await page.eval(`[...document.querySelectorAll("#table-head th")]
      .filter((th) => getComputedStyle(th).display !== "none").map((th) => th.textContent.trim())`);
  assert.deepEqual(headers, ['No.', 'Title ▲', 'Length', 'IMDb'], 'narrow screens hide the extra columns');
  await page.click('#table-head th:nth-child(4) button'); // IMDb, best first
  const top = await page.eval(`[...document.querySelectorAll("#table-body tr")].slice(0, 3)
      .map((tr) => Number(tr.children[3].textContent))`);
  assert.ok(top[0] >= top[1] && top[1] >= top[2] && top[0] >= 8.8, 'best first: ' + top);
  assert.equal(await page.eval('document.querySelector("#table-body tr:last-child .t-num").textContent'), '15',
      'the title without a rating goes last');
  await page.click('#table-head th:nth-child(4) button'); // again: worst first
  const bottom = await page.eval('Number(document.querySelector("#table-body tr").children[3].textContent)');
  assert.ok(bottom < 5, 'worst first: ' + bottom);
  await page.click('#table-head th:nth-child(1) button');
  assert.deepEqual((await page.numbers()).slice(0, 5), [1, 2, 3, 4, 5]);
  await page.shot('phone-table');
  await page.click('#table-body tr');
  await page.waitFor('document.getElementById("detail").open');
  assert.equal(await page.text('#detail .detail-num-value'), '1');
  await page.key('Escape', 'Escape');

  // The chosen view and sort order survive a reload; filters do not.
  await page.choose('f-audio', 'JP');
  await page.goto(base + '/');
  await page.ready(367);
  assert.equal(await page.eval('document.getElementById("table").hidden'), false);
  assert.deepEqual((await page.numbers()).slice(0, 3), [1, 2, 3]);

  assert.deepEqual(page.errors, []);
});

test('desktop: wide grid and all table columns', async () => {
  useFixtureCollection();
  const page = await chrome.newPage({width: 1280, height: 900, dpr: 1, mobile: false});
  await page.goto(base + '/');
  await page.ready(367);
  await page.waitFor(`[...document.querySelectorAll("#grid .tile img")].slice(0, 16)
      .every((i) => i.complete && i.naturalWidth > 0)`, 'first covers to load');
  const perRow = await page.eval(`(() => { const tiles = [...document.querySelectorAll("#grid .tile")];
      const top = tiles[0].getBoundingClientRect().top;
      return tiles.filter((t) => t.getBoundingClientRect().top === top).length; })()`);
  assert.ok(perRow >= 6, 'tiles per row: ' + perRow);
  await page.shot('desktop-grid');
  await page.click('#view-toggle');
  const headers = await page.eval(`[...document.querySelectorAll("#table-head th")]
      .filter((th) => getComputedStyle(th).display !== "none").length`);
  assert.equal(headers, 7);
  await page.shot('desktop-table');
  await page.click('#table-body tr:nth-child(3)');
  await page.waitFor('document.getElementById("detail").open');
  await page.shot('desktop-detail');
  assert.deepEqual(page.errors, []);
});

test('a link with #number opens that title', async () => {
  useFixtureCollection();
  const page = await chrome.newPage();
  await page.goto(base + '/#33');
  await page.waitFor('document.getElementById("detail").open', 'detail to open from the link');
  assert.equal(await page.text('#detail .detail-num-value'), '33');
  assert.equal(await page.text('#detail h2'), 'The Matrix Revolutions');
  await page.click('#detail .detail-close');
  await page.waitFor('!document.getElementById("detail").open && location.hash === ""');
  await page.ready(367);
  // A number that doesn't exist just shows the list.
  await page.goto(base + '/#99999');
  await page.ready(367);
  assert.equal(await page.eval('document.getElementById("detail").open'), false);
  assert.deepEqual(page.errors, []);
});

test('covers fall back in order; marks, duplicates, and odd text are handled', async () => {
  const jpeg = fs.readFileSync(path.join(SITE, 'covers', 'legacy', '1.jpg'));
  overrides.set('/config.js', localConfig('/fixture.csv'));
  overrides.set('/fixture.csv', {body: [
    'number,title,poster_url,seen,liked,imdb_rating,imdb_id',
    '1,Repo cover,,TRUE,TRUE,7.5,tt0000001',
    '2,Repo cover listed but gone,' + base + '/dead.jpg,TRUE,FALSE,,',
    '3,Nothing at all,,FALSE,FALSE,,',
    '4,Dead poster only,https://127.0.0.1:9/dead.jpg,,,,',
    '5,Poster link works,https://poster.test/5.jpg,,,,',
    '6,"<img src=x onerror=""window.pwned=1"">",javascript:window.pwned=2,,,,"tt1"" onclick=""window.pwned=3"',
    '6,Second row with number 6,,,,,',
  ].join('\n')});
  overrides.set('/covers/index.json', {body: JSON.stringify(
      {covers: {1: '1.jpg', 2: '2.jpg'}, legacy: [2, 3]})});
  overrides.set('/covers/1.jpg', {body: jpeg});
  overrides.set('/covers/legacy/2.jpg', {body: jpeg});
  overrides.set('/covers/legacy/3.jpg', {body: jpeg});

  const page = await chrome.newPage();
  // Stand in for the external poster host, which the test machine can't reach.
  await page.send('Fetch.enable', {patterns: [{urlPattern: 'https://poster.test/*'}]});
  chrome.listeners.push((msg) => {
    if (msg.sessionId === page.sessionId && msg.method === 'Fetch.requestPaused') {
      page.send('Fetch.fulfillRequest', {requestId: msg.params.requestId, responseCode: 200,
        responseHeaders: [{name: 'Content-Type', value: 'image/jpeg'}], body: jpeg.toString('base64')});
    }
  });
  await page.goto(base + '/');
  await page.ready(7);
  assert.equal(await page.eval('document.title'), 'Test shelf');
  await page.choose('f-sort', 'number:1');
  await page.waitFor(`[...document.querySelectorAll("#grid .cover")].every((c) =>
      c.classList.contains("cover-missing") || (c.querySelector("img") && c.querySelector("img").complete
        && c.querySelector("img").naturalWidth > 0))`, 'every cover to settle');
  const covers = await page.eval(`[...document.querySelectorAll("#grid .tile")].map((t) => {
      const img = t.querySelector("img");
      return [Number(t.querySelector(".num").textContent),
        img ? img.getAttribute("src") : "missing", (t.querySelector(".marks") || {}).textContent || ""]; })`);
  assert.deepEqual(covers, [
    [1, 'covers/1.jpg', '✓♥'],
    [2, 'covers/legacy/2.jpg', '✓'], // repo file gone, poster dead, old thumbnail used
    [3, 'covers/legacy/3.jpg', ''],
    [4, 'missing', ''],
    [5, 'https://poster.test/5.jpg', ''],
    [6, 'missing', ''],
    [6, 'missing', ''],
  ]);
  assert.ok(hits.get('/covers/2.jpg') >= 1, 'the listed repo cover was tried first');
  assert.equal(hits.get('/dead.jpg') || 0, 0, 'an http poster link is never requested');

  // Text from the Sheet is shown as text, never run.
  const titles = await page.eval('[...document.querySelectorAll("#grid .tile-title")].map((e) => e.textContent)');
  assert.equal(titles[5], '<img src=x onerror="window.pwned=1">');
  await page.click('#grid .tile:nth-child(6)');
  await page.waitFor('document.getElementById("detail").open');
  assert.equal(await page.text('#detail h2'), '<img src=x onerror="window.pwned=1">');
  assert.equal(await page.eval('document.querySelector("#detail .imdb-link")'), null,
      'no IMDb link for a value that is not an IMDb ID');
  assert.match(await page.text('#detail .detail-warn'), /used by more than one row/);
  await page.key('Escape', 'Escape');
  await page.waitFor('!document.getElementById("detail").open');
  assert.equal(await page.eval('typeof window.pwned'), 'undefined');
  // The other row with the same number opens its own details, not the first row's.
  await page.click('#grid .tile:nth-child(7)');
  await page.waitFor('document.getElementById("detail").open');
  assert.equal(await page.text('#detail h2'), 'Second row with number 6');
  assert.match(await page.text('#detail .detail-warn'), /used by more than one row/);
  await page.key('Escape', 'Escape');
  await page.waitFor('!document.getElementById("detail").open');

  await page.click('#grid .tile:nth-child(1)');
  await page.waitFor('document.getElementById("detail").open');
  assert.equal(await page.eval('document.querySelector("#detail .detail-warn")'), null);
  const status = await page.eval(`[...document.querySelectorAll("#detail .fact")]
      .find((f) => f.querySelector("dt").textContent === "Status").querySelector("dd").textContent`);
  assert.equal(status, 'Seen, liked');
  await page.key('Escape', 'Escape');

  // Seen filter on the page.
  await page.click('#filters-toggle');
  await page.choose('f-seen', 'liked');
  assert.deepEqual(await page.numbers(), [1]);
  await page.choose('f-seen', 'seen');
  assert.deepEqual(await page.numbers(), [1, 2]);
  await page.choose('f-seen', 'unseen');
  assert.deepEqual(await page.numbers(), [3, 4, 5, 6, 6]);
  await page.shot('fixture-covers');
  assert.deepEqual(page.errors, []);
});

test('Sheet unreachable on a first visit: the snapshot in the repo is shown', async () => {
  useFixtureCollection();
  overrides.set('/config.js', localConfig('/gone.csv'));
  const page = await chrome.newPage();
  await page.goto(base + '/');
  await page.ready(367);
  assert.match(await page.text('#status'), /Couldn't reach the Sheet\. Showing the last snapshot/);
  assert.equal(await page.eval('document.getElementById("status").hidden'), false);
  await page.shot('phone-snapshot-fallback');
  assert.deepEqual(page.errors, []);
});

test('Sheet unreachable later: the copy saved on the device is shown', async () => {
  const csv = (title) => ({body: `number,title\n1,${title}\n2,Other\n`});
  overrides.set('/config.js', localConfig('/sheet.csv'));
  overrides.set('/sheet.csv', csv('First version'));
  const page = await chrome.newPage();
  await page.goto(base + '/');
  await page.ready(2);
  assert.equal(await page.eval('document.getElementById("status").hidden'), true);

  // The Sheet changes: a reload shows the new data.
  overrides.set('/sheet.csv', csv('Second version'));
  await page.goto(base + '/');
  await page.waitFor('[...document.querySelectorAll("#grid .tile-title")].some((e) => e.textContent === "Second version")', 'new data');

  // The Sheet goes away: the saved copy stays on screen, with a note.
  overrides.set('/sheet.csv', {status: 500, body: 'error'});
  await page.goto(base + '/');
  await page.waitFor('!document.getElementById("status").hidden && document.getElementById("status").textContent.includes("saved on this device")', 'saved-copy note');
  assert.deepEqual(await page.eval('[...document.querySelectorAll("#grid .tile-title")].map((e) => e.textContent)'),
      ['Other', 'Second version']);

  // The Sheet answers with a sign-in page instead of data: same thing.
  overrides.set('/sheet.csv', {body: '<html>Sign in</html>'});
  await page.goto(base + '/');
  await page.waitFor('document.getElementById("status").textContent.includes("saved on this device")');
  await page.ready(2);
  assert.deepEqual(page.errors, []);
});

test('nothing reachable at all: a plain message, no crash', async () => {
  overrides.set('/config.js', localConfig('/gone.csv'));
  overrides.set('/data/snapshot.csv', {status: 404, body: ''});
  overrides.set('/covers/index.json', {status: 404, body: ''});
  const page = await chrome.newPage();
  await page.goto(base + '/');
  await page.waitFor('document.getElementById("status").textContent.includes("Couldn\'t load the collection")', 'error message');
  assert.equal(await page.eval('document.querySelectorAll("#grid .tile").length'), 0);
  assert.equal(await page.eval('document.getElementById("empty").hidden'), true);
  assert.deepEqual(page.errors, []);
});

test('LIVE: the page reads the real published Sheet', {skip: !process.env.LIVE}, async () => {
  const page = await chrome.newPage();
  await page.goto(base + '/');
  await page.waitFor('document.querySelectorAll("#grid .tile").length > 0', 'titles on screen', 30000);
  // Nothing is saved on this fresh device, so data without a notice came from the Sheet itself.
  await page.waitFor('document.getElementById("status").hidden', 'the live Sheet to answer', 30000);
  const count = await page.eval('document.querySelectorAll("#grid .tile").length');
  console.log('    live Sheet:', await page.text('#count'));
  assert.ok(count >= 300, 'titles from the live Sheet: ' + count);
  assert.equal((hits.get('/data/snapshot.csv') || 0), 0, 'the snapshot was not needed');
  await page.shot('live');
  assert.deepEqual(page.errors, []);
});

// ---------------------------------------------------------------------------
// Folder labels (labels.html)
// ---------------------------------------------------------------------------

const CM = 96 / 2.54; // CSS pixels per centimetre

/** The fixture Sheet with extra "number,title" rows at the end. */
function sheetWithExtraRows(rows) {
  const text = FIXTURE_CSV.toString('utf8').replace(/\s*$/, '');
  return {body: text + '\r\n' + rows.join('\r\n') + '\r\n'};
}
const DESKTOP = {width: 1400, height: 1000, dpr: 1, mobile: false};

async function openLabels(page, count) {
  await page.goto(base + '/labels.html');
  await page.waitFor(`document.querySelectorAll("#sheet .label").length === ${count}`, `${count} labels`);
}

/** What each label on the page shows, and whether its text fits. */
const LABELS = `[...document.querySelectorAll("#sheet .label")].map((l) => {
  const r = l.getBoundingClientRect();
  const list = l.querySelector("ol.titles");
  const bigs = [...l.querySelectorAll(".big")];
  return {
    big: bigs.map((b) => b.textContent),
    titles: list ? [...list.children].map((li) => li.textContent) : [],
    w: r.width, h: r.height,
    listFits: !list || list.scrollHeight <= list.clientHeight,
    bigFits: bigs.every((b) => b.scrollWidth <= b.clientWidth),
    font: list ? parseFloat(getComputedStyle(list).fontSize) : null,
  }; })`;

/** The rows of the folder table. */
const ROWS = `[...document.querySelectorAll("#folder-rows tr")].map((r) => ({
  print: r.querySelector(".f-print").checked,
  start: r.querySelector(".f-start").value,
  end: r.querySelector(".f-end").value,
  count: r.querySelector(".f-count").textContent,
  problem: r.classList.contains("problem"),
}))`;

const WARNINGS = 'document.getElementById("warnings").hidden ? "" : document.getElementById("warnings").innerText';
const row = (n) => `#folder-rows tr:nth-child(${n})`;

test('labels: default split, real size, and every title fits', async () => {
  useFixtureCollection();
  const page = await chrome.newPage(DESKTOP);
  await openLabels(page, 23);

  const labels = await page.eval(LABELS);
  assert.deepEqual(labels[0].big, ['1', '22']);
  assert.equal(labels[0].titles.length, 16);
  assert.equal(labels[0].titles[0], "1Harry Potter and the Philosopher's Stone");
  assert.equal(labels[0].titles[15], '22Star Wars Episode II: Attack of the Clones');
  assert.deepEqual(labels[22].big.slice(-1), ['435']);
  assert.equal(labels[22].titles.length, 15);
  for (const l of labels) {
    assert.ok(Math.abs(l.w - 4.6 * CM) < 0.2, `width ${l.w}px is not 4.6 cm`);
    assert.ok(Math.abs(l.h - 11.8 * CM) < 0.2, `height ${l.h}px is not 11.8 cm`);
    assert.ok(l.listFits, `titles overflow on ${l.big.join('-')}`);
    assert.ok(l.bigFits, `numbers overflow on ${l.big.join('-')}`);
    assert.ok(l.font >= 6 && l.font <= 13.34, `font size ${l.font}`);
  }
  console.log('    title font sizes (pt):',
      [...new Set(labels.map((l) => (l.font * 0.75).toFixed(1)))].sort().join(' '));

  const rows = await page.eval(ROWS);
  assert.equal(rows.length, 23);
  assert.deepEqual(rows[0], {print: true, start: '1', end: '22', count: '16', problem: false});
  assert.deepEqual(rows[22], {print: true, start: rows[22].start, end: '435', count: '15', problem: false});
  assert.equal(await page.text('#summary'), '23 labels on 3 sheets (8 fit on A4 or Letter).');
  assert.equal(await page.eval(WARNINGS), '');
  assert.equal(await page.eval('document.getElementById("status").hidden'), true);
  assert.equal(await page.eval('document.getElementById("size").value + "/" + document.getElementById("mode").value'), '16/titles');
  await page.shot('labels-screen');
  assert.deepEqual(page.errors, []);
});

test('labels: changing folders by hand', async () => {
  useFixtureCollection();
  const page = await chrome.newPage(DESKTOP);
  await openLabels(page, 23);

  // Folder 1 really ends at 30: its label changes, and it now overlaps folder 2.
  await page.fill(row(1) + ' .f-end', 30);
  let labels = await page.eval(LABELS);
  assert.deepEqual(labels[0].big, ['1', '30']);
  assert.equal(labels[0].titles.length, 20);
  assert.ok(labels[0].listFits);
  let rows = await page.eval(ROWS);
  assert.deepEqual([rows[0].count, rows[0].problem, rows[1].problem, rows[2].problem], ['20', true, true, false]);
  assert.match(await page.eval(WARNINGS), /Rows 1 and 2 both contain numbers 23 to 30\./);

  // "Split the rest again" below folder 1 fixes everything after it.
  await page.click(row(1) + ' .f-continue');
  await page.waitFor(`document.querySelector(${JSON.stringify(row(2) + ' .f-start')}).value === "31"`, 'rows below to be redone');
  assert.deepEqual(page.dialogs, ['This replaces the 22 folders below this one.']);
  rows = await page.eval(ROWS);
  assert.equal(rows.length, 23);
  assert.deepEqual(rows[1], {print: true, start: '31', end: '79', count: '16', problem: false});
  assert.equal(rows[0].end, '30');
  assert.equal(await page.eval(WARNINGS), '');

  // Saying no to a confirmation changes nothing.
  page.acceptDialogs = false;
  await page.click('#rebuild');
  assert.equal(page.dialogs.length, 2);
  assert.equal((await page.eval(ROWS))[0].end, '30');
  await page.click(row(1) + ' .f-continue');
  assert.equal((await page.eval(ROWS)).length, 23);
  page.acceptDialogs = true;

  // An unfinished row makes no label and says so.
  await page.fill(row(3) + ' .f-start', '');
  assert.equal((await page.eval(LABELS)).length, 22);
  assert.match(await page.eval(WARNINGS), /Row 3 needs a first and a last number/);
  assert.match(await page.eval(WARNINGS), /16 DVDs are in no folder: 80, 81, /);
  assert.equal(await page.eval(`document.querySelector(${JSON.stringify(row(3) + ' .f-continue')}).disabled`), true);
  await page.fill(row(3) + ' .f-end', 5); // last below first is just as unusable
  await page.fill(row(3) + ' .f-start', 80);
  assert.match(await page.eval(WARNINGS), /Row 3 needs/);
  await page.fill(row(3) + ' .f-end', 95);
  assert.equal(await page.eval(WARNINGS), '');
  assert.equal((await page.eval(LABELS)).length, 23);

  // Print only one label.
  await page.click('#print-none');
  assert.equal((await page.eval(LABELS)).length, 0);
  assert.equal(await page.text('#summary'), 'No labels are ticked.');
  assert.equal(await page.eval('document.getElementById("print").disabled'), true);
  assert.match(await page.text('#sheet'), /No labels are ticked for printing/);
  await page.click(row(3) + ' .f-print');
  labels = await page.eval(LABELS);
  assert.deepEqual(labels.map((l) => l.big), [['80', '95']]);
  assert.equal(await page.text('#summary'), '1 label on 1 sheet (8 fit on A4 or Letter).');
  assert.equal(await page.eval('document.getElementById("print").disabled'), false);

  // The list of folders is still there after a reload.
  await openLabels(page, 1);
  rows = await page.eval(ROWS);
  assert.equal(rows.length, 23);
  assert.equal(rows[0].end, '30');
  assert.deepEqual(rows.map((r) => r.print).filter(Boolean).length, 1);
  assert.equal(rows[2].print, true);
  await page.click('#print-all');
  assert.equal((await page.eval(LABELS)).length, 23);

  // Removing a folder leaves its DVDs without one; nothing offers to move them, as they are in a gap.
  await page.click(row(2) + ' .f-remove');
  assert.equal((await page.eval(ROWS)).length, 22);
  assert.match(await page.eval(WARNINGS), /16 DVDs are in no folder: 31, 32, 33, 41, 42, 43, 51, 61, 71, 72, 74, 75, and 4 more\./);
  assert.equal(await page.eval('document.getElementById("place-new")'), null);

  // Add a folder by hand for them.
  await page.click('#add');
  rows = await page.eval(ROWS);
  assert.deepEqual(rows[22], {print: true, start: '436', end: '451', count: '0', problem: false});
  labels = await page.eval(LABELS);
  assert.deepEqual(labels[22].big, ['436', '451']);
  assert.match(await page.text('#sheet .label:last-child'), /No DVDs with these numbers/);
  await page.fill(row(23) + ' .f-start', 31);
  await page.fill(row(23) + ' .f-end', 79);
  assert.equal(await page.eval(WARNINGS), '');
  assert.equal((await page.eval(ROWS))[22].count, '16');

  // One folder for a single DVD shows the number once.
  await page.click('#add');
  await page.fill(row(24) + ' .f-start', 500);
  await page.fill(row(24) + ' .f-end', 500);
  assert.deepEqual((await page.eval(LABELS))[23].big, ['500']);
  await page.click(row(24) + ' .f-remove');

  // Fixed blocks of 20 numbers instead.
  await page.fill('#size', 20);
  await page.choose('mode', 'numbers');
  await page.click('#rebuild');
  await page.waitFor(`document.querySelector(${JSON.stringify(row(1) + ' .f-end')}).value === "20"`, 'new split');
  rows = await page.eval(ROWS);
  assert.deepEqual(rows.slice(0, 3).map((r) => `${r.start}-${r.end}:${r.count}`), ['1-20:14', '21-40:9', '41-60:4']);
  assert.equal(await page.eval(WARNINGS), '');
  assert.equal(page.dialogs.at(-1), 'This replaces every folder in the list, including the ones you changed by hand.');
  // Size and way of counting are remembered too.
  await page.goto(base + '/labels.html');
  await page.waitFor('document.querySelectorAll("#sheet .label").length > 0');
  assert.equal(await page.eval('document.getElementById("size").value + "/" + document.getElementById("mode").value'), '20/numbers');
  assert.deepEqual(page.errors, []);
});

test('labels: DVDs added to the Sheet later are offered a folder', async () => {
  useFixtureCollection();
  const page = await chrome.newPage(DESKTOP);
  await openLabels(page, 23);
  const lastStart = (await page.eval(ROWS))[22].start;

  overrides.set('/sheet.csv', sheetWithExtraRows(['436,New one', '437,<b>Bold</b> & <i>co</i>', '440,Third']));
  await page.goto(base + '/labels.html');
  await page.waitFor(`(${WARNINGS}).includes("in no folder")`, 'the warning');
  assert.match(await page.eval(WARNINGS), /3 DVDs are in no folder: 436, 437, 440\./);
  assert.equal(await page.text('#place-new'), 'Put them into folders');
  assert.equal((await page.eval(ROWS)).length, 23, 'nothing is moved before you ask');

  await page.click('#place-new');
  const rows = await page.eval(ROWS);
  assert.equal(rows.length, 24);
  // The last folder had 15 of 16, so it takes one more; the other two start a new folder.
  assert.deepEqual(rows[22], {print: true, start: lastStart, end: '436', count: '16', problem: false});
  assert.deepEqual(rows[23], {print: true, start: '437', end: '440', count: '2', problem: false});
  assert.equal(await page.eval(WARNINGS), '');
  const labels = await page.eval(LABELS);
  assert.deepEqual(labels[23].big, ['437', '440']);
  assert.deepEqual(labels[23].titles, ['437<b>Bold</b> & <i>co</i>', '440Third']);
  assert.equal(await page.eval('document.querySelector("#sheet .label b, #sheet .label i")'), null,
      'titles are shown as text');
  assert.deepEqual(page.errors, []);
});

test('labels: a folder with far too many titles is reported', async () => {
  useFixtureCollection();
  const page = await chrome.newPage(DESKTOP);
  await openLabels(page, 23);
  await page.fill('#size', 90);
  await page.click('#rebuild');
  await page.waitFor('document.querySelectorAll("#sheet .label").length === 5', '5 labels');
  const text = await page.eval(WARNINGS);
  assert.match(text, /has too many titles to print legibly \(90\)\. Split that folder\./);
  assert.equal(text.match(/too many titles/g).length, 4, 'four folders of 90; the last one has 7');
  const labels = await page.eval(LABELS);
  assert.equal(labels[4].titles.length, 7);
  assert.ok(labels[4].listFits);
  // Four-digit numbers still fit the width.
  await page.click('#add');
  await page.fill(row(6) + ' .f-start', 1000);
  await page.fill(row(6) + ' .f-end', 1016);
  const wide = (await page.eval(LABELS))[5];
  assert.deepEqual(wide.big, ['1000', '1016']);
  assert.ok(wide.bigFits, 'four digits fit');
  assert.deepEqual(page.errors, []);
});

test('labels: Sheet unreachable', async () => {
  useFixtureCollection();
  overrides.set('/sheet.csv', {status: 500, body: 'error'});
  const page = await chrome.newPage(DESKTOP);
  await openLabels(page, 23);
  assert.match(await page.text('#status'), /Couldn't reach the Sheet\. Using the last snapshot stored with the site/);

  // After the browse page saved a copy on this computer, that copy is used instead.
  overrides.set('/sheet.csv', sheetWithExtraRows(['436,Only in the saved copy']));
  await page.goto(base + '/');
  await page.ready(368);
  overrides.set('/sheet.csv', {status: 500, body: 'error'});
  await page.goto(base + '/labels.html');
  await page.waitFor('document.getElementById("status").textContent.includes("saved on this computer")', 'the note');
  assert.match(await page.eval(WARNINGS), /1 DVD is in no folder: 436\./);
  assert.equal(await page.text('#place-new'), 'Put it into folders');

  // Nothing at all.
  overrides.set('/data/snapshot.csv', {status: 404, body: ''});
  const fresh = await chrome.newPage(DESKTOP);
  await fresh.goto(base + '/labels.html');
  await fresh.waitFor('document.getElementById("status").textContent.includes("Couldn\'t load the collection")', 'error message');
  assert.equal(await fresh.eval('document.querySelectorAll("#sheet .label").length'), 0);
  assert.deepEqual(page.errors.concat(fresh.errors), []);
});

// ----- the printed page, measured from the PDF -----

const HAVE_PDF_TOOLS = ['pdftoppm', 'pdfinfo', 'pdftotext']
    .every((tool) => spawnSync(tool, ['-v']).error === undefined);
const DPI = 254; // 100 pixels per centimetre

function run(cmd, args) {
  const r = spawnSync(cmd, args, {encoding: 'utf8'});
  assert.equal(r.status, 0, `${cmd} failed: ${r.stderr}`);
  return r.stdout;
}

/** Renders one PDF page to a greyscale picture at 100 pixels per centimetre. */
function renderPage(pdf, pageNumber) {
  const prefix = pdf.replace(/\.pdf$/, '') + '-p' + pageNumber;
  run('pdftoppm', ['-r', String(DPI), '-gray', '-f', String(pageNumber), '-l', String(pageNumber), '-singlefile', pdf, prefix]);
  const buf = fs.readFileSync(prefix + '.pgm');
  const header = /^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(buf.subarray(0, 40).toString('latin1'));
  assert.ok(header, 'not a PGM file');
  return {w: Number(header[1]), h: Number(header[2]), data: buf.subarray(header[0].length)};
}

const isInk = (img, x, y) => img.data[y * img.w + x] < 235;

/** Groups of neighbouring true entries: [{start, end}]. */
function groups(flags) {
  const out = [];
  flags.forEach((flag, i) => {
    if (!flag) return;
    if (out.length && out.at(-1).end === i - 1) out.at(-1).end = i; else out.push({start: i, end: i});
  });
  return out;
}

/** The labels' vertical edges: columns that are ink for at least a label's height. */
function verticalEdges(img) {
  const flags = [];
  for (let x = 0; x < img.w; x++) {
    let ink = 0;
    for (let y = 0; y < img.h; y++) if (isInk(img, x, y)) ink++;
    flags.push(ink >= 1000);
  }
  return groups(flags);
}

/** The column with the most ink inside an edge (edges are a few pixels wide and soft at the sides). */
function darkestColumn(img, edge) {
  let best = edge.start;
  let most = -1;
  for (let x = edge.start; x <= edge.end; x++) {
    let ink = 0;
    for (let y = 0; y < img.h; y++) if (isInk(img, x, y)) ink++;
    if (ink > most) { most = ink; best = x; }
  }
  return best;
}

/** Unbroken stretches of ink down one column, ignoring short ones (text). */
function longRuns(img, x) {
  const flags = [];
  for (let y = 0; y < img.h; y++) flags.push(isInk(img, x, y));
  return groups(flags).filter((g) => g.end - g.start > 100);
}

/**
 * Checks the labels on one rendered page: each 4.6 x 11.8 cm, none cut by the
 * page end. Neighbouring labels share their cutting line (0.02 cm), so four
 * labels across have five vertical edges, and the edge to the right of a
 * column is one unbroken line as tall as the labels stacked in that column.
 */
function checkPrintedPage(img, expectedLabels) {
  const edges = verticalEdges(img);
  const across = Math.min(4, expectedLabels);
  assert.equal(edges.length, across + 1, `expected ${across} labels across, found ${edges.length} edges`);
  let seen = 0;
  for (let i = 0; i < across; i++) {
    const widthCm = (edges[i + 1].end - edges[i].start + 1) / 100;
    assert.ok(Math.abs(widthCm - 4.6) <= 0.03, `label ${i + 1} is ${widthCm} cm wide`);
    const runs = longRuns(img, darkestColumn(img, edges[i + 1]));
    assert.equal(runs.length, 1, `column ${i + 1}: labels are split up`);
    const heightCm = (runs[0].end - runs[0].start + 1) / 100;
    const stacked = Math.round(heightCm / 11.8);
    assert.ok(stacked >= 1 && stacked <= 2, `column ${i + 1} is ${heightCm} cm tall`);
    assert.ok(Math.abs(heightCm - (stacked * 11.8 - (stacked - 1) * 0.02)) <= 0.03,
        `column ${i + 1}: ${stacked} label(s) measure ${heightCm} cm`);
    assert.ok(runs[0].start > 50 && runs[0].end < img.h - 50, 'label touches the edge of the paper');
    seen += stacked;
  }
  assert.equal(seen, expectedLabels, 'labels on this page');
}

/**
 * Checks that no printed word hangs out of its label: every word lies between
 * the top and bottom cutting lines and none crosses the line between the two
 * rows. Returns the words, for further checks.
 */
function checkPrintedText(pdf, pageNumber, img) {
  const run0 = longRuns(img, darkestColumn(img, verticalEdges(img)[1]))[0];
  const toPt = (px) => px * 72 / DPI;
  const top = toPt(run0.start);
  const bottom = toPt(run0.end);
  const heightPt = 11.8 / 2.54 * 72;
  const rowLine = top + heightPt; // where the first row of labels ends
  const xml = run('pdftotext', ['-bbox', '-f', String(pageNumber), '-l', String(pageNumber), pdf, '-']);
  const words = [...xml.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
      .map((m) => ({yMin: Number(m[2]), yMax: Number(m[4]), text: m[5]}));
  assert.ok(words.length > 50, 'words found on the page: ' + words.length);
  for (const w of words) {
    assert.ok(w.yMin >= top - 1 && w.yMax <= bottom + 1, `"${w.text}" is outside the labels`);
    assert.ok(!(w.yMin < rowLine - 1 && w.yMax > rowLine + 1), `"${w.text}" crosses a cutting line`);
  }
  return {words, rowLine};
}

test('labels: printed at exactly 4.6 x 11.8 cm, 8 per sheet, none split across sheets',
    {skip: !HAVE_PDF_TOOLS && 'needs pdftoppm, pdfinfo, pdftotext'}, async () => {
  useFixtureCollection();
  const page = await chrome.newPage(DESKTOP);
  await openLabels(page, 23);

  // In print, only the labels are visible.
  await page.send('Emulation.setEmulatedMedia', {media: 'print'});
  assert.equal(await page.eval('getComputedStyle(document.querySelector(".controls")).display'), 'none');
  assert.equal(await page.eval('getComputedStyle(document.getElementById("sheet")).marginLeft'), '0px');
  for (const l of await page.eval(LABELS)) {
    assert.ok(l.listFits && l.bigFits, `text overflows in print on ${l.big.join('-')}`);
  }
  await page.send('Emulation.setEmulatedMedia', {media: ''});

  for (const paper of [{name: 'a4', width: 8.27, height: 11.69, size: /A4/},
    {name: 'letter', width: 8.5, height: 11, size: /letter/}]) {
    const pdf = await page.pdf('labels-' + paper.name, paper);
    const info = run('pdfinfo', [pdf]);
    assert.match(info, /Pages:\s+3\b/, paper.name + ': 23 labels need 3 sheets');
    assert.match(info, paper.size);
    const pages = [1, 2, 3].map((n) => renderPage(pdf, n));
    checkPrintedPage(pages[0], 8);
    checkPrintedPage(pages[1], 8);
    checkPrintedPage(pages[2], 7);
    // The text stays inside its label on paper too. The first label is the
    // fullest one; its last title must end above the line under the first row.
    const {words, rowLine} = checkPrintedText(pdf, 1, pages[0]);
    const clones = words.filter((w) => w.text === 'Clones');
    assert.equal(clones.length, 1);
    assert.ok(clones[0].yMax < rowLine - 5, 'the last title of the first label is inside it');
    checkPrintedText(pdf, 2, pages[1]);
    checkPrintedText(pdf, 3, pages[2]);

    const first = run('pdftotext', ['-f', '1', '-l', '1', pdf, '-']);
    assert.match(first, /Harry Potter and the/);
    assert.doesNotMatch(first, /Folder labels|Split the collection|Tick all/, 'the controls are not printed');
    const last = run('pdftotext', ['-f', '3', '-l', '3', pdf, '-']);
    assert.match(last, /Seven Samurai \(1954\)/);
  }

  // Printing a single label.
  await page.click('#print-none');
  await page.click(row(2) + ' .f-print');
  const single = await page.pdf('labels-single');
  assert.match(run('pdfinfo', [single]), /Pages:\s+1\b/);
  checkPrintedPage(renderPage(single, 1), 1);
  assert.deepEqual(page.errors, []);
});
