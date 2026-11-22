/*
 * Folder labels: splits the collection into folders and prints one label per
 * folder (4.6 cm x 11.8 cm; the size is set in labels.css).
 *
 * The list of folders is remembered in this browser only. It is not stored in
 * the Sheet, so on another computer the page starts from the default split.
 */
(function (root) {
  "use strict";

  // ---------------------------------------------------------------------
  // Folder logic (no DOM; also used by the tests)
  // ---------------------------------------------------------------------
  //
  // A folder is {start, end, print}. `numbers` is always the sorted list of
  // folder numbers that exist in the Sheet, without repeats.

  function sortedUnique(list) {
    var seen = {};
    return list.filter(function (n) {
      if (seen[n]) return false;
      seen[n] = true;
      return true;
    }).sort(function (a, b) { return a - b; });
  }

  function isValid(folder) {
    return Number.isInteger(folder.start) && Number.isInteger(folder.end) &&
        folder.start >= 1 && folder.end >= folder.start;
  }

  function contains(folder, number) {
    return number >= folder.start && number <= folder.end;
  }

  /**
   * Splits numbers into folders of `size`.
   *
   * mode "titles":  `size` DVDs that exist per folder; a folder runs from its
   *                 first to its last DVD, so unused numbers don't take space.
   * mode "numbers": `size` consecutive numbers per folder (1-16, 17-32, ...),
   *                 counted from `from`; ranges without any DVD get no folder.
   */
  function buildFolders(numbers, size, mode, from) {
    var out = [];
    size = Math.max(1, Math.floor(size) || 1);
    if (mode === "numbers") {
      var first = from || 1;
      var rest = numbers.filter(function (n) { return n >= first; });
      while (rest.length) {
        var start = first + Math.floor((rest[0] - first) / size) * size;
        var end = start + size - 1;
        rest = rest.filter(function (n) { return n > end; });
        out.push({ start: start, end: end, print: true });
      }
      return out;
    }
    for (var i = 0; i < numbers.length; i += size) {
      var chunk = numbers.slice(i, i + size);
      out.push({ start: chunk[0], end: chunk[chunk.length - 1], print: true });
    }
    return out;
  }

  /**
   * Finds what is wrong with a list of folders:
   *   invalid   positions of folders without a usable first/last number
   *   overlaps  [{a, b, from, to}] pairs of folders that share numbers
   *   uncovered existing numbers that are in no folder
   */
  function checkFolders(folders, numbers) {
    var invalid = [];
    var overlaps = [];
    folders.forEach(function (folder, i) {
      if (!isValid(folder)) {
        invalid.push(i);
        return;
      }
      for (var j = i + 1; j < folders.length; j++) {
        var other = folders[j];
        if (!isValid(other)) continue;
        var from = Math.max(folder.start, other.start);
        var to = Math.min(folder.end, other.end);
        if (from <= to) overlaps.push({ a: i, b: j, from: from, to: to });
      }
    });
    var valid = folders.filter(isValid);
    var uncovered = numbers.filter(function (n) {
      return !valid.some(function (folder) { return contains(folder, n); });
    });
    return { invalid: invalid, overlaps: overlaps, uncovered: uncovered };
  }

  /** Keeps folders up to and including `index` and splits everything after it again. */
  function continueFrom(folders, index, numbers, size, mode) {
    var anchor = folders[index];
    var after = numbers.filter(function (n) { return n > anchor.end; });
    return folders.slice(0, index + 1)
        .concat(buildFolders(after, size, mode, anchor.end + 1));
  }

  /**
   * Finds room for DVDs numbered above every folder: first in the last folder
   * while it has space, then in new folders. Other folders are not touched.
   */
  function placeNew(folders, numbers, size, mode) {
    var copy = folders.map(function (f) {
      return { start: f.start, end: f.end, print: f.print };
    });
    var last = -1;
    copy.forEach(function (f, i) {
      if (isValid(f) && (last < 0 || f.end > copy[last].end)) last = i;
    });
    if (last < 0) return copy.concat(buildFolders(numbers, size, mode));

    var target = copy[last];
    var pending = numbers.filter(function (n) { return n > target.end; });
    if (mode === "numbers") {
      var limit = target.start + size - 1;
      if (pending.length && pending[0] <= limit) {
        target.end = limit;
        pending = pending.filter(function (n) { return n > limit; });
      }
    } else {
      var count = numbers.filter(function (n) { return contains(target, n); }).length;
      while (pending.length && count < size) {
        target.end = pending.shift();
        count++;
      }
    }
    return copy.concat(buildFolders(pending, size, mode, target.end + 1));
  }

  var api = {
    sortedUnique: sortedUnique,
    isValid: isValid,
    buildFolders: buildFolders,
    checkFolders: checkFolders,
    continueFrom: continueFrom,
    placeNew: placeNew,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document === "undefined") return;

  // ---------------------------------------------------------------------
  // Page
  // ---------------------------------------------------------------------

  var DVD = root.DVD;
  var CONFIG = root.DVD_CONFIG || {};
  var STORE_KEY = "dvd.labels.v1";
  var LABELS_PER_SHEET = 8; // 4 across, 2 down, on A4 or Letter
  var LIST_MAX_PX = 13.33;  // 10 pt
  var LIST_MIN_PX = 6;      // 4.5 pt; smaller is not readable

  var movies = [];
  var numbers = [];
  var state = { size: 16, mode: "titles", folders: [] };

  var $ = function (id) { return document.getElementById(id); };

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else node.setAttribute(k, v === true ? "" : v);
    });
    (children || []).forEach(function (child) {
      if (child) node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  }

  function toInt(value) {
    var s = String(value == null ? "" : value).trim();
    return /^\d+$/.test(s) ? parseInt(s, 10) : null;
  }

  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many);
  }

  function listNumbers(list, limit) {
    var shown = list.slice(0, limit).join(", ");
    return list.length > limit ? shown + ", and " + (list.length - limit) + " more" : shown;
  }

  // ----- remembering the folders in this browser -----

  function save() {
    try {
      root.localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) { /* private mode or full: the page still works */ }
  }

  function restore() {
    var saved;
    try {
      saved = JSON.parse(root.localStorage.getItem(STORE_KEY) || "null");
    } catch (e) {
      saved = null;
    }
    if (!saved || !Array.isArray(saved.folders)) return false;
    var size = toInt(saved.size);
    if (size) state.size = size;
    if (saved.mode === "titles" || saved.mode === "numbers") state.mode = saved.mode;
    state.folders = saved.folders.map(function (f) {
      return { start: toInt(f && f.start), end: toInt(f && f.end), print: !(f && f.print === false) };
    });
    return state.folders.length > 0;
  }

  // ----- labels -----

  function titlesIn(folder) {
    return movies.filter(function (m) { return contains(folder, m.number); });
  }

  function buildLabel(folder) {
    var inside = titlesIn(folder);
    var range = el("div", { class: "range" }, [
      el("div", { class: "big", text: String(folder.start) }),
    ]);
    if (folder.end !== folder.start) {
      range.appendChild(el("div", { class: "range-dash" }));
      range.appendChild(el("div", { class: "big", text: String(folder.end) }));
    }
    var list;
    if (inside.length) {
      list = el("ol", { class: "titles" }, inside.map(function (m) {
        return el("li", {}, [
          el("span", { class: "n", text: String(m.number) }),
          el("span", { class: "t", text: m.title }),
        ]);
      }));
      // The number column is only as wide as the longest number on this label.
      var digits = String(inside[inside.length - 1].number).length;
      list.style.setProperty("--number-width", (0.56 * digits + 0.08).toFixed(2) + "em");
    } else {
      list = el("div", { class: "titles titles-empty", text: "No DVDs with these numbers" });
    }
    return el("section", {
      class: "label",
      "data-start": String(folder.start),
      "data-end": String(folder.end),
    }, [range, list]);
  }

  /**
   * Shrinks the text of a label that is already on the page until it fits.
   * Returns false if the list of titles can't fit even at the smallest size.
   */
  function fitLabel(label) {
    var range = label.querySelector(".range");
    var bigs = Array.prototype.slice.call(label.querySelectorAll(".big"));
    var px = parseFloat(root.getComputedStyle(range).fontSize);
    var tooWide = function () {
      return bigs.some(function (b) { return b.scrollWidth > b.clientWidth; });
    };
    while (tooWide() && px > 16) {
      px -= 2;
      range.style.fontSize = px + "px";
    }

    var list = label.querySelector("ol.titles");
    if (!list) return true;
    var fits = function (size) {
      list.style.fontSize = size + "px";
      return list.scrollHeight <= list.clientHeight;
    };
    if (fits(LIST_MAX_PX)) return true;
    if (!fits(LIST_MIN_PX)) return false;
    var lo = LIST_MIN_PX;
    var hi = LIST_MAX_PX;
    for (var i = 0; i < 8; i++) {
      var mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid; else hi = mid;
    }
    // A little smaller than the limit: a printer may break lines slightly differently.
    if (!fits(Math.max(LIST_MIN_PX, lo * 0.97))) fits(lo);
    return true;
  }

  /** Draws the ticked labels. Returns the folders whose titles don't fit. */
  function renderLabels() {
    var sheet = $("sheet");
    var printed = state.folders.filter(function (f) { return f.print && isValid(f); });
    sheet.replaceChildren();
    if (!printed.length) {
      sheet.appendChild(el("p", {
        class: "sheet-empty",
        text: movies.length ? "No labels are ticked for printing." : "",
      }));
      return [];
    }
    var crowded = [];
    printed.forEach(function (folder) {
      var label = buildLabel(folder);
      sheet.appendChild(label);
      if (!fitLabel(label)) crowded.push(folder);
    });
    return crowded;
  }

  // ----- the table of folders -----

  function renderRows() {
    var body = $("folder-rows");
    body.replaceChildren();
    state.folders.forEach(function (folder, i) {
      body.appendChild(el("tr", { "data-index": String(i) }, [
        el("td", {}, [el("input", {
          type: "checkbox", class: "f-print", checked: folder.print,
          "aria-label": "Print this label",
        })]),
        el("td", {}, [el("input", {
          type: "number", class: "f-start", min: "1", step: "1",
          value: folder.start == null ? "" : String(folder.start),
          "aria-label": "First number in the folder",
        })]),
        el("td", {}, [el("input", {
          type: "number", class: "f-end", min: "1", step: "1",
          value: folder.end == null ? "" : String(folder.end),
          "aria-label": "Last number in the folder",
        })]),
        el("td", { class: "f-count" }),
        el("td", { class: "f-actions" }, [
          el("button", {
            type: "button", class: "f-continue", text: "Split the rest again",
            title: "Keep this folder and the ones above; split all DVDs after it into folders again",
          }),
          " ",
          el("button", { type: "button", class: "f-remove", text: "Remove", title: "Remove this folder from the list" }),
        ]),
      ]));
    });
  }

  function renderWarnings(check, crowded) {
    var box = $("warnings");
    var lines = [];
    var rowOf = function (i) { return i + 1; };

    if (check.invalid.length) {
      lines.push(el("p", {
        text: (check.invalid.length === 1 ? "Row " : "Rows ") + check.invalid.map(rowOf).join(", ") +
            (check.invalid.length === 1 ? " needs" : " need") +
            " a first and a last number, with the first not above the last. No label is made until then.",
      }));
    }
    check.overlaps.forEach(function (o) {
      lines.push(el("p", {
        text: "Rows " + rowOf(o.a) + " and " + rowOf(o.b) + " both contain " +
            (o.from === o.to ? "number " + o.from : "numbers " + o.from + " to " + o.to) + ".",
      }));
    });
    if (check.uncovered.length) {
      var maxEnd = 0;
      state.folders.forEach(function (f) { if (isValid(f) && f.end > maxEnd) maxEnd = f.end; });
      var fresh = check.uncovered.filter(function (n) { return n > maxEnd; });
      lines.push(el("p", {
        text: plural(check.uncovered.length, "DVD is", "DVDs are") + " in no folder: " +
            listNumbers(check.uncovered, 12) + ".",
      }));
      if (fresh.length) {
        lines.push(el("p", {}, [
          el("button", {
            type: "button", id: "place-new",
            text: fresh.length === check.uncovered.length
              ? "Put " + (fresh.length === 1 ? "it" : "them") + " into folders"
              : "Put the " + fresh.length + " above " + maxEnd + " into folders",
            title: "Fills the last folder first, then adds new folders",
          }),
        ]));
      }
    }
    crowded.forEach(function (f) {
      lines.push(el("p", {
        text: "The label for " + f.start + " to " + f.end + " has too many titles to print legibly (" +
            titlesIn(f).length + "). Split that folder.",
      }));
    });

    box.replaceChildren.apply(box, lines);
    box.hidden = lines.length === 0;
  }

  /** Updates everything that depends on the folders, without rebuilding the inputs. */
  function refresh() {
    var check = checkFolders(state.folders, numbers);
    var crowded = renderLabels();
    var problem = {};
    check.invalid.forEach(function (i) { problem[i] = true; });
    check.overlaps.forEach(function (o) { problem[o.a] = problem[o.b] = true; });

    Array.prototype.forEach.call($("folder-rows").children, function (row, i) {
      var folder = state.folders[i];
      row.classList.toggle("problem", !!problem[i]);
      row.classList.toggle("unticked", !folder.print);
      row.querySelector(".f-count").textContent = isValid(folder) ? String(titlesIn(folder).length) : "";
      row.querySelector(".f-continue").disabled = !isValid(folder);
    });
    renderWarnings(check, crowded);

    var count = state.folders.filter(function (f) { return f.print && isValid(f); }).length;
    $("summary").textContent = count
      ? plural(count, "label", "labels") + " on " +
        plural(Math.ceil(count / LABELS_PER_SHEET), "sheet", "sheets") +
        " (" + LABELS_PER_SHEET + " fit on A4 or Letter)."
      : "No labels are ticked.";
    $("print").disabled = count === 0;
    save();
  }

  function replaceFolders(folders) {
    state.folders = folders;
    renderRows();
    refresh();
  }

  function bind() {
    $("size").addEventListener("input", function (e) {
      var size = toInt(e.target.value);
      if (size) {
        state.size = size;
        save();
      }
    });
    $("mode").addEventListener("change", function (e) {
      state.mode = e.target.value;
      save();
    });
    $("rebuild").addEventListener("click", function () {
      if (state.folders.length && !root.confirm(
          "This replaces every folder in the list, including the ones you changed by hand.")) {
        return;
      }
      replaceFolders(buildFolders(numbers, state.size, state.mode));
    });

    var rows = $("folder-rows");
    rows.addEventListener("input", function (e) {
      var row = e.target.closest("tr");
      if (!row) return;
      var folder = state.folders[Number(row.getAttribute("data-index"))];
      if (e.target.classList.contains("f-start")) folder.start = toInt(e.target.value);
      else if (e.target.classList.contains("f-end")) folder.end = toInt(e.target.value);
      else if (e.target.classList.contains("f-print")) folder.print = e.target.checked;
      refresh();
    });
    rows.addEventListener("click", function (e) {
      var row = e.target.closest("tr");
      if (!row) return;
      var index = Number(row.getAttribute("data-index"));
      if (e.target.classList.contains("f-remove")) {
        state.folders.splice(index, 1);
        replaceFolders(state.folders);
      } else if (e.target.classList.contains("f-continue")) {
        var below = state.folders.length - index - 1;
        if (below && !root.confirm("This replaces the " + plural(below, "folder", "folders") +
            " below this one.")) {
          return;
        }
        replaceFolders(continueFrom(state.folders, index, numbers, state.size, state.mode));
      }
    });

    $("add").addEventListener("click", function () {
      var maxEnd = 0;
      state.folders.forEach(function (f) { if (isValid(f) && f.end > maxEnd) maxEnd = f.end; });
      state.folders.push({ start: maxEnd + 1, end: maxEnd + state.size, print: true });
      replaceFolders(state.folders);
      var inputs = rows.querySelectorAll(".f-start");
      inputs[inputs.length - 1].focus();
    });
    var tickAll = function (value) {
      state.folders.forEach(function (f) { f.print = value; });
      replaceFolders(state.folders);
    };
    $("print-all").addEventListener("click", function () { tickAll(true); });
    $("print-none").addEventListener("click", function () { tickAll(false); });
    $("print").addEventListener("click", function () { root.print(); });

    $("warnings").addEventListener("click", function (e) {
      if (e.target.id === "place-new") {
        replaceFolders(placeNew(state.folders, numbers, state.size, state.mode));
      }
    });
  }

  // ----- loading -----

  function setStatus(text) {
    $("status").textContent = text || "";
    $("status").hidden = !text;
  }

  function fetchText(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.text();
    });
  }

  /** Reads the collection: the Sheet, else the copy saved by the browse page, else the snapshot. */
  function loadMovies() {
    return fetchText(CONFIG.sheetCsvUrl)
      .then(function (csv) { return { movies: DVD.buildMovies(csv), note: "" }; })
      .catch(function () {
        var cached = null;
        try { cached = root.localStorage.getItem(DVD.CACHE_KEY); } catch (e) { /* ignore */ }
        if (cached) {
          try {
            return {
              movies: DVD.buildMovies(cached),
              note: "Couldn't reach the Sheet. Using the copy saved on this computer; recent changes may be missing.",
            };
          } catch (e) { /* damaged copy: try the snapshot */ }
        }
        return fetchText("data/snapshot.csv").then(function (csv) {
          return {
            movies: DVD.buildMovies(csv),
            note: "Couldn't reach the Sheet. Using the last snapshot stored with the site; recent changes may be missing.",
          };
        });
      });
  }

  function init() {
    bind();
    setStatus("Loading…");
    loadMovies().then(function (result) {
      movies = result.movies.slice().sort(function (a, b) { return a.number - b.number; });
      numbers = sortedUnique(movies.map(function (m) { return m.number; }));
      if (!restore()) state.folders = buildFolders(numbers, state.size, state.mode);
      $("size").value = String(state.size);
      $("mode").value = state.mode;
      setStatus(result.note);
      renderRows();
      refresh();
      // Text is measured to make it fit; measure again once the fonts are in.
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(refresh);
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
