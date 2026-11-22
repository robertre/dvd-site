// Tests for apps-script/Code.gs, run in Node against a small stand-in for the
// Google Sheets services. Run: node --test tests/test_appsscript.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SITE = path.join(__dirname, '..');
const CODE = fs.readFileSync(path.join(SITE, 'apps-script', 'Code.gs'), 'utf8');
const app = require(path.join(SITE, 'app.js'));

// ---------------------------------------------------------------------------
// Stand-in for a Sheet
// ---------------------------------------------------------------------------

/** What Sheets does to a typed or script-written value. */
function coerce(value) {
  if (typeof value !== 'string') return value;
  if (value[0] === "'") return value.slice(1);            // forced text
  if (value[0] === '=') return '#FORMULA';                // would be run as a formula
  if (/^[+-]\d+(\.\d+)?$/.test(value)) return Number(value);
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(value + 'T00:00:00');
  if (value === 'TRUE') return true;
  if (value === 'FALSE') return false;
  return value;
}

class FakeSheet {
  constructor(rows, {maxRows = 1000, maxCols = null} = {}) {
    this.grid = rows.map((r) => r.map(coerce));
    this.maxCols = maxCols || Math.max(...rows.map((r) => r.length));
    this.maxRows = Math.max(maxRows, rows.length);
    this.checkboxes = new Set();
    this.rules = [];
    this.frozen = 0;
    this.activeCell = null;
    this.selection = null;
    this.writes = 0;
    this.id = 7;
  }
  cell(r, c) {
    const row = this.grid[r - 1];
    const v = row ? row[c - 1] : undefined;
    return v === undefined ? '' : v;
  }
  setCell(r, c, v) {
    while (this.grid.length < r) this.grid.push([]);
    const row = this.grid[r - 1];
    while (row.length < c) row.push('');
    row[c - 1] = coerce(v);
  }
  getSheetId() { return this.id; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  getLastRow() {
    for (let r = this.grid.length; r >= 1; r--) {
      if (this.grid[r - 1].some((v) => v !== '' && v !== undefined)) return r;
    }
    return 0;
  }
  getLastColumn() {
    let last = 0;
    for (const row of this.grid) {
      for (let c = row.length; c > last; c--) {
        if (row[c - 1] !== '' && row[c - 1] !== undefined) { last = c; break; }
      }
    }
    return last;
  }
  insertRowAfter(r) { assert.equal(r, this.maxRows); this.maxRows++; }
  insertColumnAfter(c) { assert.equal(c, this.maxCols); this.maxCols++; }
  setFrozenRows(n) { this.frozen = n; }
  getConditionalFormatRules() { return this.rules.slice(); }
  setConditionalFormatRules(rules) { this.rules = rules.slice(); }
  getActiveRangeList() {
    if (!this.selection) return null;
    return {getRanges: () => this.selection.map(([r, n]) => this.getRange(r, 1, n, 1))};
  }
  getRange(r, c, nr = 1, nc = 1) {
    const sheet = this;
    if (r < 1 || c < 1 || nr < 1 || nc < 1 || r + nr - 1 > this.maxRows || c + nc - 1 > this.maxCols) {
      throw new Error(`Range (${r},${c},${nr},${nc}) is outside the sheet (${this.maxRows}x${this.maxCols}).`);
    }
    return {
      getRow: () => r,
      getNumRows: () => nr,
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const row = [];
          for (let j = 0; j < nc; j++) row.push(sheet.cell(r + i, c + j));
          out.push(row);
        }
        return out;
      },
      getValue: () => sheet.cell(r, c),
      setValues(values) {
        assert.equal(values.length, nr, 'setValues: wrong number of rows');
        values.forEach((row) => assert.equal(row.length, nc, 'setValues: wrong number of columns'));
        sheet.writes++;
        values.forEach((row, i) => row.forEach((v, j) => sheet.setCell(r + i, c + j, v)));
        return this;
      },
      setValue(v) {
        sheet.writes++;
        for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) sheet.setCell(r + i, c + j, v);
        return this;
      },
      insertCheckboxes() {
        for (let i = 0; i < nr; i++) {
          for (let j = 0; j < nc; j++) {
            sheet.checkboxes.add(`${r + i},${c + j}`);
            if (sheet.cell(r + i, c + j) === '') sheet.setCell(r + i, c + j, false);
          }
        }
        return this;
      },
      setFontWeight() { return this; },
      activate() { sheet.activeCell = [r, c]; return this; },
    };
  }

  // Test conveniences
  header() { return this.grid[0].map(String); }
  col(name) {
    const i = this.header().indexOf(name);
    assert.ok(i >= 0, `no column ${name}`);
    return i + 1;
  }
  get(row, name) { return this.cell(row, this.col(name)); }
  toCsv() {
    const width = this.getLastColumn();
    const quote = (v) => {
      let s = v instanceof Date ? v.toISOString().slice(0, 10)
          : v === true ? 'TRUE' : v === false ? 'FALSE' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [];
    for (let r = 1; r <= this.getLastRow(); r++) {
      const row = [];
      for (let c = 1; c <= width; c++) row.push(quote(this.cell(r, c)));
      lines.push(row.join(','));
    }
    return lines.join('\r\n') + '\r\n';
  }
}

// ---------------------------------------------------------------------------
// Stand-in for the Apps Script services
// ---------------------------------------------------------------------------

function makeEnv(sheet, {omdb = null, key = 'testkey'} = {}) {
  const env = {
    sheet,
    alerts: [],
    alertAnswer: 'YES',
    promptAnswer: {button: 'OK', text: ''},
    dialogs: [],
    requests: [],
    batches: 0,
    properties: key ? {OMDB_API_KEY: key} : {},
    clock: Date.parse('2026-11-21T12:00:00Z'),
    msPerBatch: 0,
    omdb: omdb || (() => ({Response: 'False', Error: 'Incorrect IMDb ID.'})),
  };
  const reply = (url) => {
    env.requests.push(url);
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, 'https://www.omdbapi.com/');
    assert.equal(u.searchParams.get('apikey'), env.properties.OMDB_API_KEY);
    const answer = env.omdb(u.searchParams.get('i'));
    if (answer instanceof Error) throw answer;
    const code = answer && answer.__code ? answer.__code : 200;
    const text = answer && answer.__raw !== undefined ? answer.__raw : JSON.stringify(answer);
    return {getResponseCode: () => code, getContentText: () => text};
  };
  const ui = {
    Button: {OK: 'OK', YES: 'YES', NO: 'NO', CANCEL: 'CANCEL'},
    ButtonSet: {OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO'},
    alert(title, text, buttons) {
      env.alerts.push({title, text, buttons});
      return buttons === 'YES_NO' ? env.alertAnswer : 'OK';
    },
    prompt(title, text, buttons) {
      env.alerts.push({title, text, buttons, prompt: true});
      return {
        getSelectedButton: () => env.promptAnswer.button,
        getResponseText: () => env.promptAnswer.text,
      };
    },
    showModalDialog(html, title) { env.dialogs.push({html: html.content, title}); },
    createMenu(name) {
      env.menu = {name, items: []};
      const builder = {
        addItem(label, fn) { env.menu.items.push([label, fn]); return builder; },
        addSeparator() { return builder; },
        addToUi() { env.menu.added = true; },
      };
      return builder;
    },
  };
  class FakeDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(env.clock); }
    static now() { return env.clock; }
  }
  const spreadsheet = {
    getSheets: () => env.sheets || [sheet],
    getActiveSheet: () => env.activeSheet || sheet,
    getSpreadsheetTimeZone: () => 'Europe/Zurich',
  };
  const context = {
    Date: FakeDate,
    SpreadsheetApp: {
      getUi: () => ui,
      getActiveSpreadsheet: () => spreadsheet,
      newConditionalFormatRule() {
        const rule = {};
        const builder = {
          whenFormulaSatisfied(f) { rule.formula = f; return builder; },
          setBackground(c) { rule.background = c; return builder; },
          setRanges(r) { rule.ranges = r; return builder; },
          build: () => ({
            formula: rule.formula,
            getBooleanCondition: () => ({getCriteriaValues: () => [rule.formula]}),
          }),
        };
        return builder;
      },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in env.properties ? env.properties[k] : null),
        setProperty: (k, v) => { env.properties[k] = v; },
      }),
    },
    UrlFetchApp: {
      fetch: (url) => reply(url),
      fetchAll(requests) {
        env.batches++;
        env.clock += env.msPerBatch;
        if (env.failNetwork) throw new Error('DNS error');
        return requests.map((r) => {
          assert.equal(r.muteHttpExceptions, true);
          return reply(r.url);
        });
      },
    },
    Utilities: {
      formatDate(date, tz, format) {
        assert.equal(format, 'yyyy-MM-dd');
        return new Date(date.getTime()).toISOString().slice(0, 10);
      },
    },
    HtmlService: {
      createHtmlOutput(content) {
        const out = {content, setWidth: () => out, setHeight: () => out};
        return out;
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(CODE, context, {filename: 'Code.gs'});
  env.gs = context;
  return env;
}

const HEADER = ['number', 'title', 'series', 'length_min', 'dvd_zone', 'audio', 'subtitles',
  'imdb_id', 'imdb_url', 'imdb_title', 'year', 'imdb_rating', 'metascore', 'imdb_runtime',
  'genre', 'director', 'actors', 'plot', 'cover_file', 'seen', 'liked'];

function row(values) {
  return HEADER.map((h) => (h in values ? values[h] : ''));
}

function smallSheet(options) {
  return new FakeSheet([
    HEADER,
    row({number: '1', title: 'La Grande Vadrouille', length_min: '120', audio: 'FR',
      imdb_id: 'tt0060474', imdb_title: 'The Big Runaround', year: '1966',
      imdb_rating: '8.0', metascore: '55', imdb_runtime: '132 min', plot: 'Old plot.'}),
    row({number: '2', title: 'Moonraker', length_min: '122', imdb_id: 'tt0079574',
      imdb_title: 'Moonraker', imdb_rating: '6.2', metascore: 'N/A'}),
    row({number: '5', title: 'Home video'}),
    row({number: '7', title: '', imdb_id: 'tt0133093'}),
  ], options);
}

const OMDB = {
  tt0060474: {Title: 'La Grande Vadrouille', Year: '1966', Runtime: '132 min',
    Genre: 'Comedy, War', Director: 'Gérard Oury', Actors: 'Bourvil, Louis de Funès',
    Plot: 'New plot, with "quotes".', Poster: 'https://m.media-amazon.com/images/M/a._V1_SX300.jpg',
    Metascore: 'N/A', imdbRating: '7.9', imdbID: 'tt0060474', Response: 'True'},
  tt0079574: {Title: 'Moonraker', Year: '1979', Runtime: '126 min', Genre: 'Action',
    Director: 'Lewis Gilbert', Actors: 'Roger Moore', Plot: 'Space.',
    Poster: 'N/A', Metascore: '66', imdbRating: '6.3', Response: 'True'},
  tt0133093: {Title: 'The Matrix', Year: '1999', Runtime: '136 min', Genre: 'Action, Sci-Fi',
    Director: 'Lana Wachowski, Lilly Wachowski', Actors: 'Keanu Reeves', Plot: 'Neo.',
    Poster: 'https://m.media-amazon.com/images/M/m._V1_SX300.jpg', Metascore: '73',
    imdbRating: '8.7', Response: 'True'},
};
const omdbLookup = (id) => OMDB[id] || {Response: 'False', Error: 'Incorrect IMDb ID.'};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('menu lists every action and each one exists', () => {
  const env = makeEnv(smallSheet());
  env.gs.onOpen();
  assert.equal(env.menu.name, 'DVD');
  assert.ok(env.menu.added);
  assert.equal(env.menu.items.length, 6);
  for (const [, fn] of env.menu.items) assert.equal(typeof env.gs[fn], 'function', fn);
});

test('missing columns are added at the end, growing the sheet if needed', () => {
  const sheet = smallSheet({maxCols: 21});
  const env = makeEnv(sheet);
  const cols = env.gs.columns_(sheet);
  assert.deepEqual(sheet.header().slice(21), ['poster_url', 'fetched_on']);
  assert.equal(sheet.maxCols, 23);
  assert.equal(cols.poster_url, 22);
  assert.equal(cols.number, 1);
  env.gs.columns_(sheet); // again: nothing more is added
  assert.equal(sheet.header().length, 23);
});

test('a renamed column of yours stops the script instead of adding a new one', () => {
  const sheet = smallSheet();
  sheet.setCell(1, sheet.col('title'), 'Name');
  const env = makeEnv(sheet, {omdb: omdbLookup});
  const width = sheet.getLastColumn();
  for (const action of ['setUpSheet', 'refreshAll', 'fillInDetails', 'showAddDialog']) {
    assert.throws(() => env.gs[action](), /Row 1 has no "title" column/, action);
  }
  assert.throws(() => env.gs.addDvd({imdb: '', number: ''}), /Row 1 has no "title" column/);
  assert.equal(sheet.getLastColumn(), width, 'nothing was added');
  assert.equal(sheet.getLastRow(), 5);
  assert.equal(env.requests.length, 0);
});

test('seen and liked are added when the sheet has none', () => {
  const sheet = new FakeSheet([['number', 'title', 'length_min', 'imdb_id'], ['1', 'A', '90', '']]);
  const env = makeEnv(sheet);
  env.gs.setUpSheet();
  assert.deepEqual(sheet.header().slice(4, 6), ['seen', 'liked']);
  assert.equal(sheet.get(2, 'seen'), false);
  assert.ok(sheet.checkboxes.has(`2,${sheet.col('liked')}`));
});

test('set up sheet: checkboxes, frozen header, one duplicate rule', () => {
  const sheet = smallSheet();
  sheet.setCell(2, sheet.col('seen'), 'x'); // a hand-typed mark is kept as ticked
  const env = makeEnv(sheet);
  env.gs.setUpSheet();
  assert.equal(sheet.frozen, 1);
  for (const r of [2, 3, 4, 5]) {
    assert.ok(sheet.checkboxes.has(`${r},${sheet.col('seen')}`));
    assert.ok(sheet.checkboxes.has(`${r},${sheet.col('liked')}`));
  }
  assert.equal(sheet.get(2, 'seen'), true);
  assert.equal(sheet.get(3, 'seen'), false);
  assert.equal(sheet.get(2, 'liked'), false);
  assert.ok(!sheet.checkboxes.has(`6,${sheet.col('seen')}`), 'no checkboxes below the data');
  assert.equal(sheet.getLastRow(), 5);
  assert.equal(sheet.rules.length, 1);
  assert.equal(sheet.rules[0].formula, '=COUNTIF($A$2:$A,$A2)>1');
  assert.match(env.alerts[0].text, /Added columns: poster_url, fetched_on/);

  env.gs.setUpSheet();
  assert.equal(sheet.rules.length, 1, 'rule is not added twice');
  assert.equal(sheet.get(2, 'seen'), true);
  assert.doesNotMatch(env.alerts[1].text, /Added columns/);
});

test('add: IMDb link prefills, number defaults to max + 1', () => {
  const sheet = smallSheet();
  const env = makeEnv(sheet, {omdb: omdbLookup});
  env.gs.showAddDialog();
  assert.match(env.dialogs[0].html, /id="number"[^>]*value="8"/);

  const note = env.gs.addDvd({imdb: 'https://www.imdb.com/title/tt0133093/?ref_=x', number: ''});
  assert.equal(note, '');
  assert.equal(sheet.getLastRow(), 6);
  assert.equal(sheet.get(6, 'number'), 8);
  assert.equal(sheet.get(6, 'imdb_id'), 'tt0133093');
  assert.equal(sheet.get(6, 'imdb_url'), 'https://www.imdb.com/title/tt0133093/');
  assert.equal(sheet.get(6, 'title'), 'The Matrix');
  assert.equal(sheet.get(6, 'length_min'), 136);
  assert.equal(sheet.get(6, 'imdb_rating'), 8.7);
  assert.equal(sheet.get(6, 'metascore'), 73);
  assert.equal(sheet.get(6, 'year'), 1999);
  assert.equal(sheet.get(6, 'poster_url'), 'https://m.media-amazon.com/images/M/m._V1_SX300.jpg');
  assert.equal(sheet.get(6, 'seen'), false);
  assert.ok(sheet.checkboxes.has(`6,${sheet.col('liked')}`));
  assert.equal(sheet.get(6, 'audio'), '', 'languages are left for you');
  assert.deepEqual(sheet.activeCell, [6, sheet.col('title')]);
  assert.equal(env.requests.length, 1);
  // Other rows are untouched.
  assert.equal(sheet.get(2, 'title'), 'La Grande Vadrouille');
  assert.equal(sheet.get(2, 'plot'), 'Old plot.');
});

test('add: number can be overridden, manual row needs no IMDb ID', () => {
  const sheet = smallSheet();
  const env = makeEnv(sheet, {omdb: omdbLookup});
  assert.equal(env.gs.addDvd({imdb: '', number: '3'}), '');
  assert.equal(sheet.get(6, 'number'), 3);
  assert.equal(sheet.get(6, 'title'), '');
  assert.equal(sheet.get(6, 'imdb_id'), '');
  assert.equal(env.requests.length, 0);
  // The next default is still max + 1, not the gap.
  assert.equal(env.gs.addDvd({imdb: '  ', number: null}), '');
  assert.equal(sheet.get(7, 'number'), 8);
});

test('add: a used number or a bad IMDb value adds nothing', () => {
  const sheet = smallSheet();
  const env = makeEnv(sheet, {omdb: omdbLookup});
  assert.throws(() => env.gs.addDvd({imdb: '', number: '2'}),
      /Number 2 is already used by "Moonraker" \(row 3\)/);
  assert.throws(() => env.gs.addDvd({imdb: 'matrix', number: ''}), /not an IMDb ID/);
  assert.throws(() => env.gs.addDvd({imdb: '', number: '0'}), /whole number/);
  assert.throws(() => env.gs.addDvd({imdb: '', number: '1.5'}), /whole number/);
  assert.throws(() => env.gs.addDvd({imdb: '', number: 'abc'}), /whole number/);
  assert.equal(sheet.getLastRow(), 5);
  assert.equal(env.requests.length, 0);
});

test('add: row is kept and a note returned when details cannot be fetched', () => {
  let sheet = smallSheet();
  let env = makeEnv(sheet, {omdb: omdbLookup});
  let note = env.gs.addDvd({imdb: 'tt9999999', number: ''});
  assert.match(note, /Row 6 was added, but the details could not be fetched: OMDb says: Incorrect IMDb ID/);
  assert.equal(sheet.get(6, 'number'), 8);
  assert.equal(sheet.get(6, 'imdb_id'), 'tt9999999');
  assert.equal(sheet.get(6, 'title'), '');

  sheet = smallSheet();
  env = makeEnv(sheet, {omdb: omdbLookup, key: null});
  note = env.gs.addDvd({imdb: 'tt0133093', number: ''});
  assert.match(note, /no OMDb key is set/);
  assert.equal(sheet.get(6, 'number'), 8);
  assert.equal(env.requests.length, 0);

  sheet = smallSheet();
  env = makeEnv(sheet, {omdb: () => ({Response: 'False', Error: 'Invalid API key!'})});
  note = env.gs.addDvd({imdb: 'tt0133093', number: ''});
  assert.match(note, /Row 6 was added.*Invalid API key/);
});

test('add: appends a sheet row when the sheet is full', () => {
  const sheet = smallSheet({maxRows: 5});
  const env = makeEnv(sheet, {omdb: omdbLookup});
  env.gs.addDvd({imdb: '', number: ''});
  assert.equal(sheet.maxRows, 6);
  assert.equal(sheet.get(6, 'number'), 8);
});

test('fill in details: only rows with an ID and no IMDb title', () => {
  const sheet = smallSheet();
  const env = makeEnv(sheet, {omdb: omdbLookup});
  env.gs.fillInDetails();
  assert.deepEqual(env.requests.map((u) => new URL(u).searchParams.get('i')), ['tt0133093']);
  assert.equal(sheet.get(5, 'title'), 'The Matrix');
  assert.equal(sheet.get(5, 'length_min'), 136);
  assert.equal(sheet.get(5, 'imdb_title'), 'The Matrix');
  assert.equal(sheet.get(2, 'imdb_rating'), 8, 'filled rows are not fetched again');
  assert.match(env.alerts[0].text, /^Updated 1 row\./);

  env.gs.fillInDetails();
  assert.equal(env.requests.length, 1);
  assert.equal(env.alerts[1].title, 'Nothing to fill in');
});

test('refresh all: updates script columns, never your own', () => {
  const sheet = smallSheet();
  const env = makeEnv(sheet, {omdb: omdbLookup});
  env.gs.refreshAll();
  assert.match(env.alerts[0].text, /again for 3 rows/);
  assert.equal(env.requests.length, 3);

  // Row 2: your title and length stay; IMDb's values are refreshed.
  assert.equal(sheet.get(2, 'title'), 'La Grande Vadrouille');
  assert.equal(sheet.get(2, 'length_min'), 120);
  assert.equal(sheet.get(2, 'audio'), 'FR');
  assert.equal(sheet.get(2, 'imdb_title'), 'La Grande Vadrouille');
  assert.equal(sheet.get(2, 'imdb_rating'), 7.9);
  assert.equal(sheet.get(2, 'plot'), 'New plot, with "quotes".');
  assert.equal(sheet.get(2, 'metascore'), 55, 'N/A from OMDb keeps the old value');
  assert.equal(sheet.get(2, 'poster_url'), 'https://m.media-amazon.com/images/M/a._V1_SX300.jpg');
  assert.ok(sheet.get(2, 'fetched_on') instanceof Date);
  // Row 3: no poster at OMDb leaves the cell empty; metascore now known.
  assert.equal(sheet.get(3, 'poster_url'), '');
  assert.equal(sheet.get(3, 'metascore'), 66);
  assert.equal(sheet.get(3, 'imdb_runtime'), '126 min');
  assert.equal(sheet.get(3, 'length_min'), 122);
  // Row 4 has no IMDb ID and is left alone.
  assert.equal(sheet.get(4, 'title'), 'Home video');
  assert.equal(sheet.get(4, 'fetched_on'), '');
  assert.match(env.alerts[1].text, /^Updated 3 rows\.$/);
});

test('texts that Sheets would misread are stored as they are', () => {
  const sheet = smallSheet();
  const env = makeEnv(sheet, {
    omdb: (id) => ({
      tt0133093: {Title: '+1', Plot: '=cmd() is not a formula', Director: "'71 crew",
        Actors: '-30- cast', Runtime: '95 min', Response: 'True'},
      tt0079574: {Title: 'Moonraker', Response: 'True'},
    }[id] || {Response: 'False', Error: 'Incorrect IMDb ID.'}),
  });
  env.gs.fillInDetails(); // row 5 only
  assert.equal(sheet.get(5, 'imdb_title'), '+1');
  assert.equal(sheet.get(5, 'title'), '+1', 'prefilled title too');
  assert.equal(sheet.get(5, 'plot'), '=cmd() is not a formula');
  assert.equal(sheet.get(5, 'director'), "'71 crew");
  assert.equal(sheet.get(5, 'actors'), '-30- cast');

  // Refreshing another row rewrites whole columns; row 5 must survive that.
  sheet.selection = [[3, 1]];
  env.gs.refreshSelected();
  assert.equal(sheet.get(5, 'imdb_title'), '+1');
  assert.equal(sheet.get(5, 'plot'), '=cmd() is not a formula');
  assert.equal(sheet.get(5, 'director'), "'71 crew");
});

test('refresh all: answering No fetches nothing; no key asks for one', () => {
  let env = makeEnv(smallSheet(), {omdb: omdbLookup});
  env.alertAnswer = 'NO';
  env.gs.refreshAll();
  assert.equal(env.requests.length, 0);

  env = makeEnv(smallSheet(), {omdb: omdbLookup, key: null});
  env.gs.refreshAll();
  assert.equal(env.alerts[0].title, 'OMDb key needed');
  assert.equal(env.requests.length, 0);
});

test('refresh: per-row failures are listed, the rest still updates', () => {
  const sheet = smallSheet();
  sheet.setCell(4, sheet.col('imdb_id'), 'not-an-id');
  const env = makeEnv(sheet, {
    omdb: (id) => (id === 'tt0079574' ? {__code: 502, __raw: '<html>Bad gateway</html>'} : omdbLookup(id)),
  });
  env.gs.refreshAll();
  const text = env.alerts[1].text;
  assert.match(text, /^Updated 2 rows\./);
  assert.match(text, /2 could not be updated/);
  assert.match(text, /row 3: OMDb answered with HTTP 502/);
  assert.match(text, /row 4: the imdb_id cell is not an IMDb ID/);
  assert.doesNotMatch(text, /are left/);
  assert.equal(sheet.get(3, 'imdb_rating'), 6.2, 'failed row keeps its old values');
  assert.equal(sheet.get(2, 'imdb_rating'), 7.9);
});

test('refresh: request limit stops the run and keeps what was fetched', () => {
  const rows = [HEADER];
  for (let n = 1; n <= 25; n++) rows.push(row({number: String(n), title: 'T' + n, imdb_id: 'tt00000' + (10 + n)}));
  const sheet = new FakeSheet(rows);
  let served = 0;
  const env = makeEnv(sheet, {
    omdb: (id) => (++served > 12 ? {Response: 'False', Error: 'Request limit reached!'}
        : {Title: 'X ' + id, imdbRating: '5.0', Response: 'True'}),
  });
  env.gs.refreshAll();
  const text = env.alerts[1].text;
  assert.match(text, /^Updated 12 rows\./);
  assert.match(text, /Stopped early\. OMDb says: Request limit reached!/);
  assert.match(text, /13 rows are left/);
  assert.equal(env.batches, 2, 'no further batches after the limit');
  assert.equal(sheet.get(13, 'imdb_title'), 'X tt0000022');
  assert.equal(sheet.get(14, 'imdb_title'), '');
});

test('refresh: stops before the time limit and continues with the oldest rows', () => {
  const rows = [HEADER];
  for (let n = 1; n <= 45; n++) rows.push(row({number: String(n), title: 'T' + n, imdb_id: 'tt00000' + (10 + n)}));
  const sheet = new FakeSheet(rows);
  const env = makeEnv(sheet, {omdb: (id) => ({Title: 'X ' + id, imdbRating: '5.0', Response: 'True'})});
  env.msPerBatch = 2 * 60 * 1000; // each batch of 10 takes two minutes
  env.gs.refreshAll();
  assert.equal(env.batches, 3);
  assert.match(env.alerts[1].text, /^Updated 30 rows\./);
  assert.match(env.alerts[1].text, /15 rows are left\. Run the same menu item again/);
  assert.equal(sheet.get(31, 'imdb_title'), 'X tt0000040');
  assert.equal(sheet.get(32, 'imdb_title'), '');

  // Next day: the 15 rows never fetched go first.
  env.clock += 24 * 3600 * 1000;
  env.requests.length = 0;
  env.gs.refreshAll();
  const firstIds = env.requests.slice(0, 15).map((u) => new URL(u).searchParams.get('i'));
  assert.deepEqual(firstIds, Array.from({length: 15}, (_, i) => 'tt00000' + (41 + i)));
  assert.equal(sheet.get(46, 'imdb_title'), 'X tt0000055');
});

test('refresh: network failure is reported, nothing is written', () => {
  const sheet = smallSheet();
  const env = makeEnv(sheet, {omdb: omdbLookup});
  env.failNetwork = true;
  env.gs.refreshAll();
  assert.match(env.alerts[1].text, /Updated 0 rows\.[\s\S]*OMDb could not be reached: DNS error[\s\S]*3 rows are left/);
  assert.equal(sheet.get(2, 'imdb_rating'), 8);
});

test('refresh selected rows', () => {
  const sheet = smallSheet();
  const env = makeEnv(sheet, {omdb: omdbLookup});
  env.gs.refreshSelected();
  assert.match(env.alerts[0].text, /Select one or more rows/);

  sheet.selection = [[3, 2]]; // rows 3 and 4; row 4 has no IMDb ID
  env.gs.refreshSelected();
  assert.deepEqual(env.requests.map((u) => new URL(u).searchParams.get('i')), ['tt0079574']);
  assert.equal(sheet.get(3, 'imdb_rating'), 6.3);
  assert.equal(sheet.get(2, 'imdb_rating'), 8);

  sheet.selection = [[4, 1]];
  env.gs.refreshSelected();
  assert.match(env.alerts.at(-1).text, /None of the selected rows has an IMDb ID/);
});

test('set OMDb key: stored, tried out, and the result reported', () => {
  let env = makeEnv(smallSheet(), {omdb: omdbLookup, key: null});
  env.promptAnswer = {button: 'OK', text: '  abc123 \n'};
  env.gs.setApiKey();
  assert.equal(env.properties.OMDB_API_KEY, 'abc123');
  assert.match(env.alerts.at(-1).text, /saved and works/);

  env = makeEnv(smallSheet(), {omdb: () => ({Response: 'False', Error: 'Invalid API key!'}), key: null});
  env.promptAnswer = {button: 'OK', text: 'wrong'};
  env.gs.setApiKey();
  assert.match(env.alerts.at(-1).text, /test request failed\. OMDb says: Invalid API key!/);

  env = makeEnv(smallSheet(), {omdb: omdbLookup, key: 'old'});
  env.promptAnswer = {button: 'CANCEL', text: 'new'};
  env.gs.setApiKey();
  assert.equal(env.properties.OMDB_API_KEY, 'old');
});

test('finds the DVD tab even when it is not the first tab', () => {
  const dvd = smallSheet();
  const env = makeEnv(dvd);
  env.sheets = [new FakeSheet([['notes'], ['hello']]), new FakeSheet([[]]), dvd];
  assert.equal(env.gs.getSheet_(), dvd);
  env.sheets = [new FakeSheet([['notes']])];
  assert.throws(() => env.gs.getSheet_(), /No tab has a "number" column/);
});

test('small helpers', () => {
  const gs = makeEnv(smallSheet()).gs;
  assert.equal(gs.parseImdbId_('https://m.imdb.com/title/TT0133093/'), 'tt0133093');
  assert.equal(gs.parseImdbId_('tt123'), '');
  assert.equal(gs.parseImdbId_(null), '');
  assert.equal(gs.parseMinutes_('126 min'), 126);
  assert.equal(gs.parseMinutes_('N/A'), null);
  assert.equal(gs.columnLetter_(1), 'A');
  assert.equal(gs.columnLetter_(26), 'Z');
  assert.equal(gs.columnLetter_(27), 'AA');
  assert.equal(gs.nextNumber_([1, 435, '', 12]), 436);
  assert.equal(gs.nextNumber_([]), 1);
});

test('whole sheet as imported: set up + refresh, then the page can read the result', () => {
  const csvPath = path.join(__dirname, 'fixtures', 'sheet.csv');
  const original = app.parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const sheet = new FakeSheet(original, {maxCols: 21});
  const before = app.buildMovies(fs.readFileSync(csvPath, 'utf8'));
  const env = makeEnv(sheet, {
    omdb: (id) => ({
      Title: 'IMDb title for ' + id, Year: '2001', Runtime: '101 min', Genre: 'Drama, War',
      Director: 'D', Actors: 'A, B', Plot: 'Plot with, comma and "quote".',
      Poster: 'https://m.media-amazon.com/images/M/' + id + '._V1_SX300.jpg',
      Metascore: 'N/A', imdbRating: '7.7', Response: 'True',
    }),
  });

  env.gs.setUpSheet();
  env.gs.refreshAll();
  assert.match(env.alerts.at(-1).text, /^Updated 367 rows\.$/);
  assert.equal(env.requests.length, 367);
  assert.equal(env.batches, 37);
  assert.ok(sheet.writes < 60, `expected few writes, got ${sheet.writes}`);

  const after = app.buildMovies(sheet.toCsv());
  assert.equal(after.length, 367);
  const mine = (m) => [m.number, m.title, m.series, m.length, m.zone, m.audio, m.subs, m.seen, m.liked];
  assert.deepEqual(after.map(mine), before.map(mine), 'your own columns are unchanged');
  for (const m of after) {
    assert.match(m.posterUrl, /^https:\/\/m\.media-amazon\.com\//);
    assert.equal(m.rating, 7.7);
    assert.equal(m.imdbRuntime, 101);
    assert.deepEqual(m.genres, ['Drama', 'War']);
    assert.equal(m.plot, 'Plot with, comma and "quote".');
  }
  // Number 15 had no IMDb data at all before.
  const hobbit = after.find((m) => m.number === 15);
  assert.equal(before.find((m) => m.number === 15).imdbTitle, '');
  assert.equal(hobbit.imdbTitle, 'IMDb title for tt1170358');
  assert.equal(hobbit.title, 'The Hobbit: The Desolation of Smaug');
  // Old metascores survive an N/A answer.
  assert.equal(after.find((m) => m.number === 1).metascore, 64);
});
