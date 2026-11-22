/*
 * DVD collection browser.
 *
 * Plain JavaScript: no build step, no libraries. The page is read-only. It
 * reads the published Google Sheet (see config.js), and falls back to the copy
 * saved on this device or to data/snapshot.csv when the Sheet can't be reached.
 *
 * Columns are found by their header name in row 1 of the Sheet, so the column
 * order doesn't matter, but the header names must stay as they are.
 */
(function (root) {
  "use strict";

  var LANGUAGE_NAMES = {
    ENG: "English",
    EN: "English",
    FR: "Français",
    DE: "Deutsch",
    RU: "Russian",
    JP: "Japanese",
  };

  var DEFAULT_STATE = {
    q: "",
    seen: "all",
    audio: "",
    subs: "",
    maxLen: 0,
    minRating: 0,
    series: "",
    genre: "",
  };

  // ---------------------------------------------------------------------
  // Data helpers (no DOM; also used by the tests)
  // ---------------------------------------------------------------------

  /** Parses CSV text into an array of rows, each an array of strings. */
  function parseCsv(text) {
    var rows = [];
    var row = [];
    var field = "";
    var inQuotes = false;
    var i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    for (; i < text.length; i++) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field);
        field = "";
        rows.push(row);
        row = [];
      } else {
        field += c;
      }
    }
    if (field !== "" || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  /** Turns parsed rows into objects keyed by the header names in row 1. */
  function toRecords(rows) {
    if (!rows.length) return [];
    var header = rows[0].map(function (h) {
      return h.trim().toLowerCase().replace(/\s+/g, "_");
    });
    return rows.slice(1).map(function (cells) {
      var rec = {};
      header.forEach(function (name, i) {
        if (name) rec[name] = (cells[i] || "").trim();
      });
      return rec;
    });
  }

  function toBool(value) {
    return /^(true|yes|y|x|1|✓|✔)$/i.test(String(value || "").trim());
  }

  /** Reads a number that may use a decimal comma. Returns null if not a number. */
  function toNumber(value) {
    var s = String(value == null ? "" : value).trim().replace(",", ".");
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    return parseFloat(s);
  }

  /** Reads minutes from "126 min" or "126". Returns null if there are none. */
  function parseMinutes(value) {
    var m = /^(\d+)(\s*min)?$/i.exec(String(value || "").trim());
    return m ? parseInt(m[1], 10) : null;
  }

  /** Splits "ENG FR" or "ENG, FR" into upper-case codes. */
  function splitCodes(value) {
    return String(value || "")
      .toUpperCase()
      .split(/[\s,;]+/)
      .filter(Boolean);
  }

  /** Splits "Action, Adventure" into trimmed names. */
  function splitNames(value) {
    return String(value || "")
      .split(",")
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s && s !== "N/A"; });
  }

  /** Lower-cases and strips accents, so "asterix" finds "Astérix". */
  function fold(s) {
    return String(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  function clean(value) {
    var s = String(value || "").trim();
    return s === "N/A" ? "" : s;
  }

  /** Builds one movie from a Sheet row, or returns null for rows without a number. */
  function normalizeMovie(rec) {
    var rawNumber = String(rec.number || "").trim();
    if (!/^\d+$/.test(rawNumber)) return null;
    var number = parseInt(rawNumber, 10);
    if (number <= 0) return null;

    var imdbTitle = clean(rec.imdb_title);
    var title = clean(rec.title) || imdbTitle || "(no title)";
    var ownLength = parseMinutes(rec.length_min);
    var imdbRuntime = parseMinutes(rec.imdb_runtime);
    var idMatch = /tt\d{5,}/.exec((rec.imdb_id || "") + " " + (rec.imdb_url || ""));
    var poster = clean(rec.poster_url);
    var year = clean(rec.year);
    var yearMatch = /\d{4}/.exec(year);
    var series = clean(rec.series);

    return {
      number: number,
      title: title,
      imdbTitle: imdbTitle,
      series: series,
      length: ownLength != null ? ownLength : imdbRuntime,
      imdbRuntime: imdbRuntime,
      zone: clean(rec.dvd_zone),
      audio: splitCodes(rec.audio),
      subs: splitCodes(rec.subtitles),
      imdbId: idMatch ? idMatch[0] : "",
      year: year,
      yearNum: yearMatch ? parseInt(yearMatch[0], 10) : null,
      rating: toNumber(clean(rec.imdb_rating)),
      metascore: toNumber(clean(rec.metascore)),
      genres: splitNames(rec.genre),
      director: clean(rec.director),
      actors: clean(rec.actors),
      plot: clean(rec.plot),
      posterUrl: /^https:\/\//i.test(poster) ? poster : "",
      seen: toBool(rec.seen),
      liked: toBool(rec.liked),
      search: fold(title + "\n" + imdbTitle + "\n" + series),
    };
  }

  /** Parses the Sheet's CSV. Throws if it doesn't look like the DVD sheet. */
  function buildMovies(csvText) {
    var rows = parseCsv(csvText);
    var records = toRecords(rows);
    if (!rows.length || rows[0].map(function (h) {
      return h.trim().toLowerCase();
    }).indexOf("number") < 0) {
      throw new Error("The sheet has no 'number' column.");
    }
    var movies = [];
    var uses = {};
    records.forEach(function (rec) {
      var movie = normalizeMovie(rec);
      if (!movie) return;
      uses[movie.number] = (uses[movie.number] || 0) + 1;
      movies.push(movie);
    });
    if (!movies.length) throw new Error("The sheet has no rows with a number.");
    // Two rows with the same number is a mistake in the Sheet; flag both.
    movies.forEach(function (movie) {
      movie.duplicate = uses[movie.number] > 1;
    });
    return movies;
  }

  /** True if the movie passes the search box and every active filter. */
  function matches(movie, state) {
    var tokens = fold(state.q).split(/\s+/).filter(Boolean);
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      var isNumber = /^\d+$/.test(t) && String(movie.number) === t;
      if (!isNumber && movie.search.indexOf(t) < 0) return false;
    }
    if (state.seen === "unseen" && movie.seen) return false;
    if (state.seen === "seen" && !movie.seen) return false;
    if (state.seen === "liked" && !movie.liked) return false;
    if (state.audio && movie.audio.indexOf(state.audio) < 0) return false;
    if (state.subs && movie.subs.indexOf(state.subs) < 0) return false;
    if (state.maxLen && !(movie.length != null && movie.length <= state.maxLen)) return false;
    if (state.minRating && !(movie.rating != null && movie.rating >= state.minRating)) return false;
    if (state.series && movie.series !== state.series) return false;
    if (state.genre && movie.genres.indexOf(state.genre) < 0) return false;
    return true;
  }

  var COLLATOR = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

  function sortValue(movie, key) {
    switch (key) {
      case "number": return movie.number;
      case "rating": return movie.rating;
      case "metascore": return movie.metascore;
      case "year": return movie.yearNum;
      case "length": return movie.length;
      case "series": return movie.series || null;
      default: return movie.title;
    }
  }

  /** Returns a sorted copy. Movies without a value for the key always go last. */
  function sortMovies(list, key, dir) {
    return list.slice().sort(function (a, b) {
      var va = sortValue(a, key);
      var vb = sortValue(b, key);
      if (va == null && vb != null) return 1;
      if (vb == null && va != null) return -1;
      var cmp = 0;
      if (va != null && vb != null) {
        cmp = typeof va === "number" ? va - vb : COLLATOR.compare(va, vb);
      }
      if (cmp) return cmp * dir;
      return COLLATOR.compare(a.title, b.title) || a.number - b.number;
    });
  }

  function formatLength(minutes) {
    if (minutes == null) return "";
    var h = Math.floor(minutes / 60);
    var m = minutes % 60;
    return h ? h + "h " + (m < 10 ? "0" : "") + m : m + " min";
  }

  function formatRating(rating) {
    return rating == null ? "" : rating.toFixed(1);
  }

  function languageName(code) {
    return LANGUAGE_NAMES[code] || code;
  }

  /** Image addresses to try for a movie, best first. */
  function coverCandidates(movie, manifest) {
    var out = [];
    var local = manifest.covers && manifest.covers[movie.number];
    if (local) out.push("covers/" + local);
    if (movie.posterUrl) out.push(movie.posterUrl);
    if (manifest.legacy && manifest.legacy.indexOf(movie.number) >= 0) {
      out.push("covers/legacy/" + movie.number + ".jpg");
    }
    return out;
  }

  /** Sorted unique values for the filter dropdowns. */
  function collectOptions(movies) {
    var sets = { audio: {}, subs: {}, series: {}, genre: {} };
    movies.forEach(function (m) {
      m.audio.forEach(function (c) { sets.audio[c] = true; });
      m.subs.forEach(function (c) { sets.subs[c] = true; });
      m.genres.forEach(function (g) { sets.genre[g] = true; });
      if (m.series) sets.series[m.series] = true;
    });
    var out = {};
    Object.keys(sets).forEach(function (k) {
      out[k] = Object.keys(sets[k]).sort(COLLATOR.compare);
    });
    return out;
  }

  // Where the browse page keeps its copy of the Sheet on this device.
  var CACHE_KEY = "dvd.sheet.v1";

  var api = {
    parseCsv: parseCsv,
    toRecords: toRecords,
    normalizeMovie: normalizeMovie,
    buildMovies: buildMovies,
    matches: matches,
    sortMovies: sortMovies,
    formatLength: formatLength,
    coverCandidates: coverCandidates,
    collectOptions: collectOptions,
    DEFAULT_STATE: DEFAULT_STATE,
    CACHE_KEY: CACHE_KEY,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document === "undefined") return;

  // Other pages (labels.html) load this file only for the helpers above.
  root.DVD = api;
  if (!document.getElementById("grid")) return;

  // ---------------------------------------------------------------------
  // Page
  // ---------------------------------------------------------------------

  var CONFIG = root.DVD_CONFIG || {};
  var PREFS_KEY = "dvd.prefs.v1";

  var movies = [];
  var byNumber = {};
  var manifest = { covers: {}, legacy: [] };
  var state = Object.assign({}, DEFAULT_STATE);
  var prefs = { view: "grid", sort: "title", dir: 1 };

  // State of the detail view; see "detail view: opening and closing" below.
  var openedByClick = false; // the "#number" in the address was put there by a tap
  var clickedMovie = null;   // the tapped row, in case two rows share a number
  var requests = 0;          // how many times a title was tapped
  var openings = [];         // times the dialog was shown whose "close" event is still to come
  var backPending = false;   // a history.back() of ours has not arrived yet
  var backCount = 0;
  var queuedMovie = null;    // a title tapped while backPending

  var $ = function (id) { return document.getElementById(id); };

  /** Creates an element. Text always goes in as text, never as HTML. */
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.slice(0, 2) === "on") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : v);
    });
    (children || []).forEach(function (child) {
      if (child == null || child === false) return;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  }

  function storageGet(key) {
    try { return root.localStorage.getItem(key); } catch (e) { return null; }
  }

  function storageSet(key, value) {
    try { root.localStorage.setItem(key, value); } catch (e) { /* private mode or full */ }
  }

  function fetchText(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.text();
    });
  }

  // ----- covers -----

  /** A cover image that walks down the list of addresses until one loads. */
  function coverImage(movie) {
    var candidates = coverCandidates(movie, manifest);
    var wrap = el("span", { class: "cover" });
    var index = 0;

    function showMissing() {
      wrap.classList.add("cover-missing");
      wrap.appendChild(el("span", { class: "cover-missing-title", text: movie.title }));
    }

    if (!candidates.length) {
      showMissing();
      return wrap;
    }
    var img = el("img", {
      alt: "",
      loading: "lazy",
      decoding: "async",
      referrerpolicy: "no-referrer",
      src: candidates[0],
    });
    img.addEventListener("error", function () {
      index++;
      if (index < candidates.length) {
        img.src = candidates[index];
      } else {
        img.remove();
        showMissing();
      }
    });
    wrap.appendChild(img);
    return wrap;
  }

  function marks(movie) {
    var text = (movie.seen ? "✓" : "") + (movie.liked ? "♥" : "");
    if (!text) return null;
    var label = movie.liked ? (movie.seen ? "Seen, liked" : "Liked") : "Seen";
    return el("span", { class: "marks", title: label, "aria-label": label, text: text });
  }

  // ----- list rendering -----

  function visibleMovies() {
    var list = movies.filter(function (m) { return matches(m, state); });
    return sortMovies(list, prefs.sort, prefs.dir);
  }

  function renderGrid(list) {
    var grid = $("grid");
    var frag = document.createDocumentFragment();
    list.forEach(function (m) {
      var cover = coverImage(m);
      cover.appendChild(el("span", { class: "num", text: String(m.number) }));
      var mk = marks(m);
      if (mk) cover.appendChild(mk);
      var meta = [formatLength(m.length), m.rating != null ? "★ " + formatRating(m.rating) : ""]
        .filter(Boolean).join(" · ");
      frag.appendChild(el("button", {
        class: "tile",
        type: "button",
        "aria-label": m.number + ": " + m.title,
        onclick: function () { openDetail(m); },
      }, [
        cover,
        el("span", { class: "tile-title", text: m.title }),
        el("span", { class: "tile-meta", text: meta }),
      ]));
    });
    grid.replaceChildren(frag);
  }

  var TABLE_COLUMNS = [
    { key: "number", label: "No.", firstDir: 1 },
    { key: "title", label: "Title", firstDir: 1 },
    { key: "length", label: "Length", firstDir: 1 },
    { key: "rating", label: "IMDb", firstDir: -1 },
    { key: "metascore", label: "Meta", firstDir: -1, extra: true },
    { key: "year", label: "Year", firstDir: -1, extra: true },
    { key: "series", label: "Series", firstDir: 1, extra: true },
  ];

  function renderTable(list) {
    var head = document.createDocumentFragment();
    TABLE_COLUMNS.forEach(function (col) {
      var active = prefs.sort === col.key;
      var arrow = active ? (prefs.dir > 0 ? " ▲" : " ▼") : "";
      head.appendChild(el("th", {
        class: col.extra ? "extra" : null,
        "aria-sort": active ? (prefs.dir > 0 ? "ascending" : "descending") : null,
      }, [
        el("button", {
          type: "button",
          text: col.label + arrow,
          onclick: function () {
            setSort(col.key, active ? -prefs.dir : col.firstDir);
          },
        }),
      ]));
    });
    $("table-head").replaceChildren(head);

    var body = document.createDocumentFragment();
    list.forEach(function (m) {
      var mk = marks(m);
      body.appendChild(el("tr", {
        tabindex: "0",
        onclick: function () { openDetail(m); },
        onkeydown: function (e) {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openDetail(m);
          }
        },
      }, [
        el("td", { class: "t-num", text: String(m.number) }),
        el("td", { class: "t-title" }, [m.title, mk ? " " : null, mk]),
        el("td", { text: formatLength(m.length) }),
        el("td", { text: formatRating(m.rating) }),
        el("td", { class: "extra", text: m.metascore != null ? String(m.metascore) : "" }),
        el("td", { class: "extra", text: m.year }),
        el("td", { class: "extra", text: m.series }),
      ]));
    });
    $("table-body").replaceChildren(body);
  }

  function activeFilterCount() {
    var n = 0;
    Object.keys(DEFAULT_STATE).forEach(function (k) {
      if (k !== "q" && state[k] !== DEFAULT_STATE[k]) n++;
    });
    return n;
  }

  function render() {
    var list = visibleMovies();
    var isGrid = prefs.view === "grid";
    $("grid").hidden = !isGrid;
    $("table").hidden = isGrid;
    if (isGrid) {
      renderGrid(list);
      $("table-body").replaceChildren();
    } else {
      renderTable(list);
      $("grid").replaceChildren();
    }

    $("empty").hidden = list.length > 0 || movies.length === 0;
    $("count").textContent = movies.length
      ? (list.length === movies.length
        ? movies.length + " titles"
        : list.length + " of " + movies.length)
      : "";
    $("view-toggle").textContent = isGrid ? "Table" : "Covers";
    var active = activeFilterCount();
    $("filters-toggle").textContent = active ? "Filters (" + active + ")" : "Filters";
    $("filters-toggle").classList.toggle("active", active > 0);
  }

  // ----- detail view -----

  function fact(label, value) {
    if (!value) return null;
    return el("div", { class: "fact" }, [
      el("dt", { text: label }),
      el("dd", { text: value }),
    ]);
  }

  function renderDetail(m) {
    var dialog = $("detail");
    var subtitle = [];
    if (m.imdbTitle && fold(m.imdbTitle) !== fold(m.title)) subtitle.push(m.imdbTitle);
    if (m.year) subtitle.push(m.year);

    var length = formatLength(m.length);
    if (length && m.imdbRuntime != null && m.imdbRuntime !== m.length) {
      length += " (IMDb: " + formatLength(m.imdbRuntime) + ")";
    }
    var status = m.liked ? (m.seen ? "Seen, liked" : "Liked") : (m.seen ? "Seen" : "Not seen yet");

    var seriesNode = null;
    if (m.series) {
      seriesNode = el("div", { class: "fact" }, [
        el("dt", { text: "Series" }),
        el("dd", {}, [
          el("button", {
            type: "button",
            class: "link",
            text: m.series,
            title: "Show all titles in this series",
            onclick: function () {
              resetFilters();
              state.series = m.series;
              syncControls();
              closeDetail();
              render();
              root.scrollTo(0, 0);
            },
          }),
        ]),
      ]);
    }

    var cover = coverImage(m);
    cover.classList.add("detail-cover");

    dialog.replaceChildren(el("div", { class: "detail-body" }, [
      el("button", {
        type: "button",
        class: "detail-close",
        "aria-label": "Close",
        text: "×",
        onclick: closeDetail,
      }),
      el("div", { class: "detail-head" }, [
        cover,
        el("div", { class: "detail-title" }, [
          el("div", { class: "detail-num" }, [
            el("span", { class: "detail-num-label", text: "Folder" }),
            el("span", { class: "detail-num-value", text: String(m.number) }),
          ]),
          el("h2", { text: m.title }),
          subtitle.length ? el("p", { class: "detail-sub", text: subtitle.join(" · ") }) : null,
          m.duplicate ? el("p", { class: "detail-warn", text: "This number is used by more than one row in the Sheet." }) : null,
          m.imdbId ? el("a", {
            class: "imdb-link",
            href: "https://www.imdb.com/title/" + m.imdbId + "/",
            target: "_blank",
            rel: "noopener noreferrer",
            text: "Open on IMDb",
          }) : null,
        ]),
      ]),
      el("dl", { class: "facts" }, [
        fact("Length", length),
        fact("IMDb rating", formatRating(m.rating)),
        fact("Metascore", m.metascore != null ? String(m.metascore) : ""),
        fact("Status", status),
        fact("Genre", m.genres.join(", ")),
        seriesNode,
        fact("Audio", m.audio.map(languageName).join(", ")),
        fact("Subtitles", m.subs.map(languageName).join(", ")),
        fact("DVD zone", m.zone),
        fact("Director", m.director),
        fact("Cast", m.actors),
      ]),
      m.plot ? el("p", { class: "plot", text: m.plot }) : null,
    ]));
  }

  // ----- detail view: opening and closing -----
  //
  // The "#number" in the address decides whether the detail view is open, so
  // the phone's Back button closes it and a link to "#135" opens it.
  //
  // Two things happen a moment after they are asked for, in no fixed order:
  // the browser's "close" event for the dialog, and history.back(). A tap on
  // another title can land in between. `openings` and `backPending` keep track
  // so that such a tap always ends with the tapped title open.

  function openDetail(movie) {
    if (backPending) {
      // The address is still changing from the last close. Opening now would
      // be undone when that change arrives, so wait for it (see onHashChange).
      queuedMovie = movie;
      return;
    }
    requests++;
    clickedMovie = movie;
    var target = "#" + movie.number;
    if (root.location.hash === target) {
      showDetailFromHash();
    } else if (root.location.hash && !$("detail").open) {
      // The address still shows the "#number" of a dialog that has just
      // closed (or something that is no title at all). Take its place in the
      // history instead of stacking on top of it, or closing this title
      // would bring the old one back.
      root.location.replace(target);
    } else {
      openedByClick = true;
      root.location.hash = target;
    }
  }

  /** Closes the dialog without touching the address. */
  function closeDialog() {
    var dialog = $("detail");
    if (!dialog.open) return;
    if (openings.length) openings[openings.length - 1].closedByCode = true;
    dialog.close();
  }

  /** Removes "#number" from the address. */
  function dropHash() {
    if (!root.location.hash) return;
    if (openedByClick) {
      // The tap added a history entry; going back removes it again. The
      // browser does that a moment later and then reports a "hashchange".
      openedByClick = false;
      backPending = true;
      var mine = ++backCount;
      root.history.back();
      // Should the browser never report it, don't leave taps waiting forever.
      root.setTimeout(function () {
        if (backPending && mine === backCount) onHashChange();
      }, 1000);
    } else {
      // Arrived by a link straight to "#number": there is nothing to go back to.
      root.history.replaceState(null, "", root.location.pathname + root.location.search);
    }
  }

  /** The user asked to close: the × button, a tap outside, or the series link. */
  function closeDetail() {
    closeDialog();
    dropHash();
  }

  function showDetailFromHash() {
    var number = parseInt(root.location.hash.slice(1), 10);
    var movie = clickedMovie && clickedMovie.number === number ? clickedMovie : byNumber[number];
    clickedMovie = null;
    var dialog = $("detail");
    if (movie) {
      renderDetail(movie);
      if (dialog.open) {
        openings[openings.length - 1].request = requests;
      } else {
        dialog.showModal();
        openings.push({ request: requests, closedByCode: false });
      }
      dialog.scrollTop = 0;
    } else {
      closeDialog();
    }
  }

  function onHashChange() {
    var next = queuedMovie;
    backPending = false;
    queuedMovie = null;
    showDetailFromHash();
    if (next) openDetail(next);
  }

  /**
   * The dialog's "close" event. It arrives a moment after the dialog closed,
   * once for every time it was shown, in the same order.
   */
  function onDetailClosed() {
    var opening = openings.shift();
    if (!opening || opening.closedByCode) return;
    // The browser closed it by itself (Esc key, or Back on some phones), so
    // the address still shows "#number". Remove it, unless another title was
    // tapped or shown in the meantime: then the address belongs to that one.
    if (openings.length || requests !== opening.request) return;
    dropHash();
  }

  // ----- controls -----

  function setSort(key, dir) {
    prefs.sort = key;
    prefs.dir = dir;
    savePrefs();
    syncControls();
    render();
  }

  function savePrefs() {
    storageSet(PREFS_KEY, JSON.stringify(prefs));
  }

  function loadPrefs() {
    try {
      var saved = JSON.parse(storageGet(PREFS_KEY) || "{}");
      if (saved.view === "grid" || saved.view === "table") prefs.view = saved.view;
      if (typeof saved.sort === "string") prefs.sort = saved.sort;
      if (saved.dir === 1 || saved.dir === -1) prefs.dir = saved.dir;
    } catch (e) { /* ignore a damaged entry */ }
  }

  function resetFilters() {
    Object.assign(state, DEFAULT_STATE);
  }

  function fillSelect(id, values, labelFor) {
    var select = $(id);
    var current = select.value;
    var first = select.options[0];
    var frag = document.createDocumentFragment();
    frag.appendChild(first);
    values.forEach(function (v) {
      frag.appendChild(el("option", { value: v, text: labelFor ? labelFor(v) : v }));
    });
    select.replaceChildren(frag);
    select.value = values.indexOf(current) >= 0 ? current : "";
  }

  /** Makes the form controls show what is in `state` and `prefs`. */
  function syncControls() {
    $("q").value = state.q;
    $("f-seen").value = state.seen;
    $("f-audio").value = state.audio;
    $("f-subs").value = state.subs;
    $("f-maxlen").value = String(state.maxLen);
    $("f-minrating").value = String(state.minRating);
    $("f-series").value = state.series;
    $("f-genre").value = state.genre;
    // A table-header sort with no entry in the dropdown leaves it blank.
    $("f-sort").value = prefs.sort + ":" + prefs.dir;
  }

  function bindControls() {
    $("q").addEventListener("input", function (e) {
      state.q = e.target.value;
      render();
    });
    var selects = {
      "f-seen": function (v) { state.seen = v; },
      "f-audio": function (v) { state.audio = v; },
      "f-subs": function (v) { state.subs = v; },
      "f-maxlen": function (v) { state.maxLen = parseInt(v, 10) || 0; },
      "f-minrating": function (v) { state.minRating = parseFloat(v) || 0; },
      "f-series": function (v) { state.series = v; },
      "f-genre": function (v) { state.genre = v; },
    };
    Object.keys(selects).forEach(function (id) {
      $(id).addEventListener("change", function (e) {
        selects[id](e.target.value);
        render();
      });
    });
    $("f-sort").addEventListener("change", function (e) {
      var parts = e.target.value.split(":");
      setSort(parts[0], parseInt(parts[1], 10) || 1);
    });
    $("filters-toggle").addEventListener("click", function () {
      var panel = $("filters");
      panel.hidden = !panel.hidden;
      $("filters-toggle").setAttribute("aria-expanded", String(!panel.hidden));
      // An open panel is tall; let it scroll away instead of pinning it.
      document.querySelector(".bar").classList.toggle("bar-open", !panel.hidden);
    });
    $("view-toggle").addEventListener("click", function () {
      prefs.view = prefs.view === "grid" ? "table" : "grid";
      savePrefs();
      render();
    });
    var resetAll = function () {
      resetFilters();
      syncControls();
      render();
    };
    $("filters-reset").addEventListener("click", resetAll);
    $("empty-reset").addEventListener("click", resetAll);

    var dialog = $("detail");
    dialog.addEventListener("close", onDetailClosed);
    dialog.addEventListener("click", function (e) {
      if (e.target === dialog) closeDetail(); // tap on the backdrop
    });
    root.addEventListener("hashchange", onHashChange);
  }

  // ----- loading -----

  function setStatus(text) {
    var node = $("status");
    node.textContent = text || "";
    node.hidden = !text;
  }

  function setData(csvText) {
    var list = buildMovies(csvText); // throws if the text isn't the sheet
    movies = list;
    byNumber = {};
    movies.forEach(function (m) {
      if (!byNumber[m.number]) byNumber[m.number] = m;
    });
    var options = collectOptions(movies);
    fillSelect("f-audio", options.audio, languageName);
    fillSelect("f-subs", options.subs, languageName);
    fillSelect("f-series", options.series);
    fillSelect("f-genre", options.genre);
    // A filter whose value disappeared from the data is switched off.
    ["audio", "subs", "series", "genre"].forEach(function (k) {
      if (state[k] && options[k].indexOf(state[k]) < 0) state[k] = "";
    });
    syncControls();
    render();
    showDetailFromHash();
  }

  function loadManifest() {
    return fetch("covers/index.json")
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        manifest = {
          covers: (data && data.covers) || {},
          legacy: (data && data.legacy) || [],
        };
      })
      .catch(function () { /* no list of covers: poster links only */ });
  }

  function init() {
    var title = CONFIG.title || "DVD collection";
    document.title = title;
    $("site-title").textContent = title;
    loadPrefs();
    bindControls();
    syncControls();
    setStatus("Loading…");

    loadManifest().then(function () {
      var shown = false;
      var cached = storageGet(CACHE_KEY);
      if (cached) {
        try {
          setData(cached);
          shown = true;
          setStatus("");
        } catch (e) { /* damaged copy: wait for the live data */ }
      }

      return fetchText(CONFIG.sheetCsvUrl)
        .then(function (csv) {
          if (!shown || csv !== cached) {
            setData(csv);
            storageSet(CACHE_KEY, csv);
          }
          setStatus("");
        })
        .catch(function () {
          if (shown) {
            setStatus("Couldn't reach the Sheet. Showing the copy saved on this device.");
            return null;
          }
          return fetchText("data/snapshot.csv").then(function (csv) {
            setData(csv);
            setStatus("Couldn't reach the Sheet. Showing the last snapshot stored with the site.");
          });
        });
    }).catch(function () {
      setStatus("Couldn't load the collection. Check the connection and reload.");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(typeof window !== "undefined" ? window : globalThis);
