/**
 * DVD collection: adds a "DVD" menu to this Sheet.
 *
 *   Add DVD...                  New row with the next free number; an IMDb ID
 *                               prefills the details.
 *   Fill in details (new rows)  Fetches details for rows that have an IMDb ID
 *                               but no IMDb title yet.
 *   Refresh selected rows       Fetches details again for the selected rows.
 *   Refresh ratings (all rows)  Fetches details again for every row.
 *   Set up sheet                Adds missing columns, checkboxes, and the
 *                               highlight for duplicate numbers.
 *   Set OMDb key...             Stores the key for the movie data service.
 *
 * Columns are found by the header name in row 1, so their order is free, but
 * the header names must stay as they are.
 *
 * The script only ever fills empty cells in your own columns (title,
 * length_min). The columns listed in SCRIPT_COLUMNS belong to the script and
 * are overwritten whenever details are fetched.
 *
 * @OnlyCurrentDoc
 */

var OMDB_URL = 'https://www.omdbapi.com/';
var KEY_PROPERTY = 'OMDB_API_KEY';
var BATCH_SIZE = 10;
// Apps Script stops a run after 6 minutes. Stop earlier and ask to run again.
var TIME_BUDGET_MS = 4.5 * 60 * 1000;

var SCRIPT_COLUMNS = [
  'imdb_url', 'imdb_title', 'year', 'imdb_runtime', 'imdb_rating', 'metascore',
  'genre', 'director', 'actors', 'plot', 'poster_url', 'fetched_on',
];
// Your own columns. The script needs them and will not invent them.
var OWN_COLUMNS = ['number', 'title', 'length_min', 'imdb_id'];
// Columns the script adds at the end of the sheet if they are missing.
var ADDED_COLUMNS = ['seen', 'liked'].concat(SCRIPT_COLUMNS);

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi()
      .createMenu('DVD')
      .addItem('Add DVD…', 'showAddDialog')
      .addItem('Fill in details (new rows)', 'fillInDetails')
      .addItem('Refresh selected rows', 'refreshSelected')
      .addItem('Refresh ratings (all rows)', 'refreshAll')
      .addSeparator()
      .addItem('Set up sheet', 'setUpSheet')
      .addItem('Set OMDb key…', 'setApiKey')
      .addToUi();
}

// ---------------------------------------------------------------------------
// Menu actions
// ---------------------------------------------------------------------------

function showAddDialog() {
  var sheet = getSheet_();
  var cols = columns_(sheet);
  var next = nextNumber_(numberValues_(sheet, cols));
  var html = HtmlService.createHtmlOutput(addDialogHtml_(next)).setWidth(380).setHeight(270);
  SpreadsheetApp.getUi().showModalDialog(html, 'Add DVD');
}

/**
 * Called by the Add dialog. Returns '' on success, or a note to show the user
 * when the row was added but could not be filled in. Throws if nothing was added.
 */
function addDvd(form) {
  var sheet = getSheet_();
  var cols = columns_(sheet);
  var numbers = numberValues_(sheet, cols);

  var number;
  var rawNumber = String(form.number == null ? '' : form.number).trim();
  if (rawNumber === '') {
    number = nextNumber_(numbers);
  } else if (/^\d+$/.test(rawNumber) && parseInt(rawNumber, 10) >= 1) {
    number = parseInt(rawNumber, 10);
  } else {
    throw new Error('The number must be a whole number, 1 or higher.');
  }
  for (var i = 0; i < numbers.length; i++) {
    if (numbers[i] !== '' && Number(numbers[i]) === number) {
      var usedBy = sheet.getRange(i + 2, cols.title).getValue();
      throw new Error('Number ' + number + ' is already used by "' + usedBy +
          '" (row ' + (i + 2) + ').');
    }
  }

  var rawImdb = String(form.imdb || '').trim();
  var imdbId = '';
  if (rawImdb) {
    imdbId = parseImdbId_(rawImdb);
    if (!imdbId) {
      throw new Error('That is not an IMDb ID or link. It should contain ' +
          'something like tt0133093.');
    }
  }

  var row = numbers.length + 2;
  if (row > sheet.getMaxRows()) sheet.insertRowAfter(sheet.getMaxRows());
  sheet.getRange(row, cols.number).setValue(number);
  sheet.getRange(row, cols.seen).insertCheckboxes();
  sheet.getRange(row, cols.liked).insertCheckboxes();

  var note = '';
  if (imdbId) {
    sheet.getRange(row, cols.imdb_id).setValue(imdbId);
    sheet.getRange(row, cols.imdb_url).setValue(imdbUrl_(imdbId));
    var key = getKey_();
    if (!key) {
      note = 'Row ' + row + ' was added, but nothing was filled in because no ' +
          'OMDb key is set. Use DVD > Set OMDb key, then DVD > Fill in details.';
    } else {
      var result = fetchDetails_(sheet, cols, [row], key);
      if (result.fatal) {
        note = 'Row ' + row + ' was added, but the details could not be fetched. ' +
            result.fatal;
      } else if (result.failed.length) {
        note = 'Row ' + row + ' was added, but the details could not be fetched: ' +
            result.failed[0].reason;
      }
    }
  }
  sheet.getRange(row, cols.title).activate();
  return note;
}

function fillInDetails() {
  var sheet = getSheet_();
  var cols = columns_(sheet);
  var key = requireKey_();
  if (!key) return;
  var table = readTable_(sheet, cols);
  var rows = [];
  table.forEach(function(values, i) {
    var hasId = String(values[cols.imdb_id - 1]).trim() !== '';
    var hasTitle = String(values[cols.imdb_title - 1]).trim() !== '';
    if (hasId && !hasTitle) rows.push(i + 2);
  });
  if (!rows.length) {
    SpreadsheetApp.getUi().alert('Nothing to fill in',
        'Every row with an IMDb ID already has its details.',
        SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }
  report_('Fill in details', fetchDetails_(sheet, cols, rows, key));
}

function refreshSelected() {
  var sheet = getSheet_();
  var cols = columns_(sheet);
  var ui = SpreadsheetApp.getUi();
  var selection = sheet.getActiveRangeList();
  var active = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  if (!selection || active.getSheetId() !== sheet.getSheetId()) {
    ui.alert('Refresh selected rows', 'Select one or more rows on the DVD tab first.',
        ui.ButtonSet.OK);
    return;
  }
  var key = requireKey_();
  if (!key) return;
  var table = readTable_(sheet, cols);
  var wanted = {};
  selection.getRanges().forEach(function(range) {
    for (var r = range.getRow(); r < range.getRow() + range.getNumRows(); r++) wanted[r] = true;
  });
  var rows = [];
  table.forEach(function(values, i) {
    if (wanted[i + 2] && String(values[cols.imdb_id - 1]).trim() !== '') rows.push(i + 2);
  });
  if (!rows.length) {
    ui.alert('Refresh selected rows', 'None of the selected rows has an IMDb ID.',
        ui.ButtonSet.OK);
    return;
  }
  report_('Refresh selected rows', fetchDetails_(sheet, cols, rows, key));
}

function refreshAll() {
  var sheet = getSheet_();
  var cols = columns_(sheet);
  var key = requireKey_();
  if (!key) return;
  var table = readTable_(sheet, cols);
  var rows = [];
  table.forEach(function(values, i) {
    if (String(values[cols.imdb_id - 1]).trim() !== '') {
      rows.push({row: i + 2, fetched: timestamp_(values[cols.fetched_on - 1])});
    }
  });
  // Oldest first, so that running it again continues where it stopped.
  rows.sort(function(a, b) { return a.fetched - b.fetched || a.row - b.row; });

  var ui = SpreadsheetApp.getUi();
  var answer = ui.alert('Refresh ratings',
      'Fetch the IMDb details again for ' + rows.length + ' rows? ' +
      'This uses ' + rows.length + ' of the 1,000 OMDb requests allowed per day. ' +
      'Your own titles and lengths are not changed.',
      ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;
  report_('Refresh ratings',
      fetchDetails_(sheet, cols, rows.map(function(r) { return r.row; }), key));
}

function setUpSheet() {
  var sheet = getSheet_();
  var before = readHeader_(sheet);
  var cols = columns_(sheet);
  var added = ADDED_COLUMNS.filter(function(name) { return before.indexOf(name) < 0; });

  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, sheet.getLastColumn()).setFontWeight('bold');

  var count = numberValues_(sheet, cols).length;
  if (count > 0) {
    ['seen', 'liked'].forEach(function(name) {
      var range = sheet.getRange(2, cols[name], count, 1);
      var ticks = range.getValues().map(function(r) { return [isTicked_(r[0])]; });
      range.insertCheckboxes();
      range.setValues(ticks);
    });
  }

  var letter = columnLetter_(cols.number);
  var formula = '=COUNTIF($' + letter + '$2:$' + letter + ',$' + letter + '2)>1';
  var rules = sheet.getConditionalFormatRules();
  var hasRule = rules.some(function(rule) {
    var condition = rule.getBooleanCondition();
    return condition && condition.getCriteriaValues()[0] === formula;
  });
  if (!hasRule) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied(formula)
        .setBackground('#f4c7c3')
        .setRanges([sheet.getRange(2, cols.number, sheet.getMaxRows() - 1, 1)])
        .build());
    sheet.setConditionalFormatRules(rules);
  }

  var ui = SpreadsheetApp.getUi();
  ui.alert('Set up sheet',
      (added.length ? 'Added columns: ' + added.join(', ') + '.\n' : '') +
      'Checkboxes are in place for ' + count + ' rows, and duplicate numbers ' +
      'are highlighted in red.',
      ui.ButtonSet.OK);
}

function setApiKey() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.prompt('OMDb key',
      'Paste the key from the OMDb email. It is stored with this Sheet\'s ' +
      'script, not in a cell.',
      ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return;
  var key = response.getResponseText().trim();
  if (!key) return;
  PropertiesService.getScriptProperties().setProperty(KEY_PROPERTY, key);

  // Try the key right away on a known title.
  var problem = '';
  try {
    var reply = UrlFetchApp.fetch(omdbRequestUrl_('tt0133093', key), {muteHttpExceptions: true});
    var data = parseJson_(reply.getContentText());
    if (!data) problem = 'OMDb answered with HTTP ' + reply.getResponseCode() + '.';
    else if (data.Response === 'False') problem = 'OMDb says: ' + (data.Error || 'unknown error');
  } catch (e) {
    problem = 'OMDb could not be reached: ' + e.message;
  }
  ui.alert('OMDb key',
      problem ? 'The key was saved, but the test request failed. ' + problem
              : 'The key was saved and works.',
      ui.ButtonSet.OK);
}

// ---------------------------------------------------------------------------
// Fetching details
// ---------------------------------------------------------------------------

/**
 * Fetches OMDb details for the given sheet rows and writes them to the sheet.
 * Returns {updated, failed: [{row, reason}], remaining, fatal}.
 */
function fetchDetails_(sheet, cols, rows, key) {
  var started = Date.now();
  var table = readTable_(sheet, cols);
  var today = Utilities.formatDate(new Date(),
      SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  var result = {updated: 0, failed: [], remaining: 0, fatal: ''};
  var changedColumns = {};
  var prefills = [];

  for (var start = 0; start < rows.length && !result.fatal; start += BATCH_SIZE) {
    if (Date.now() - started > TIME_BUDGET_MS) break;

    var batch = [];
    rows.slice(start, start + BATCH_SIZE).forEach(function(row) {
      var id = parseImdbId_(table[row - 2][cols.imdb_id - 1]);
      if (id) {
        batch.push({row: row, id: id});
      } else {
        result.failed.push({row: row, reason: 'the imdb_id cell is not an IMDb ID'});
      }
    });
    if (!batch.length) continue;

    var replies;
    try {
      replies = UrlFetchApp.fetchAll(batch.map(function(item) {
        return {url: omdbRequestUrl_(item.id, key), muteHttpExceptions: true};
      }));
    } catch (e) {
      result.fatal = 'OMDb could not be reached: ' + e.message;
      break;
    }

    for (var i = 0; i < batch.length; i++) {
      var item = batch[i];
      var data = parseJson_(replies[i].getContentText());
      if (!data) {
        result.failed.push({row: item.row,
          reason: 'OMDb answered with HTTP ' + replies[i].getResponseCode()});
        continue;
      }
      if (data.Response === 'False') {
        var error = data.Error || 'unknown error';
        if (/api key|limit/i.test(error)) {
          result.fatal = 'OMDb says: ' + error;
          break;
        }
        result.failed.push({row: item.row, reason: 'OMDb says: ' + error});
        continue;
      }

      var values = table[item.row - 2];
      var cells = omdbToCells_(data, item.id, today);
      Object.keys(cells).forEach(function(name) {
        if (cells[name] === null) return; // OMDb has no value: keep what is there
        values[cols[name] - 1] = cells[name];
        changedColumns[name] = true;
      });
      if (String(values[cols.title - 1]).trim() === '' && cells.imdb_title) {
        prefills.push([item.row, cols.title, cells.imdb_title]);
      }
      var minutes = parseMinutes_(data.Runtime);
      if (String(values[cols.length_min - 1]).trim() === '' && minutes !== null) {
        prefills.push([item.row, cols.length_min, minutes]);
      }
      result.updated++;
    }
  }

  // One write per changed column, instead of one per cell.
  Object.keys(changedColumns).forEach(function(name) {
    var column = table.map(function(values) { return [literal_(values[cols[name] - 1])]; });
    sheet.getRange(2, cols[name], column.length, 1).setValues(column);
  });
  prefills.forEach(function(p) { sheet.getRange(p[0], p[1]).setValue(literal_(p[2])); });

  result.remaining = rows.length - result.updated - result.failed.length;
  return result;
}

/** Maps an OMDb reply to script-owned cells. null means "leave the cell alone". */
function omdbToCells_(data, imdbId, today) {
  function text(value) {
    var s = value == null ? '' : String(value).trim();
    return s === '' || s === 'N/A' ? null : s;
  }
  function number(value) {
    var s = value == null ? '' : String(value).trim();
    return /^\d+(\.\d+)?$/.test(s) ? parseFloat(s) : null;
  }
  var poster = data.Poster == null ? '' : String(data.Poster).trim();
  return {
    imdb_url: imdbUrl_(imdbId),
    imdb_title: text(data.Title),
    year: text(data.Year),
    imdb_runtime: text(data.Runtime),
    imdb_rating: number(data.imdbRating),
    metascore: number(data.Metascore),
    genre: text(data.Genre),
    director: text(data.Director),
    actors: text(data.Actors),
    plot: text(data.Plot),
    poster_url: /^https?:\/\//i.test(poster) ? poster : null,
    fetched_on: today,
  };
}

function report_(title, result) {
  var lines = ['Updated ' + result.updated + ' row' + (result.updated === 1 ? '' : 's') + '.'];
  if (result.failed.length) {
    lines.push('');
    lines.push(result.failed.length + ' could not be updated:');
    result.failed.slice(0, 10).forEach(function(f) {
      lines.push('  row ' + f.row + ': ' + f.reason);
    });
    if (result.failed.length > 10) lines.push('  and ' + (result.failed.length - 10) + ' more');
  }
  if (result.fatal) {
    lines.push('');
    lines.push('Stopped early. ' + result.fatal);
  }
  if (result.remaining > 0) {
    lines.push('');
    lines.push(result.remaining + ' rows are left. Run the same menu item again to continue.');
  }
  var ui = SpreadsheetApp.getUi();
  ui.alert(title, lines.join('\n'), ui.ButtonSet.OK);
}

// ---------------------------------------------------------------------------
// Sheet helpers
// ---------------------------------------------------------------------------

/** The tab that holds the DVDs: the first one with a "number" header. */
function getSheet_() {
  var sheets = SpreadsheetApp.getActiveSpreadsheet().getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getLastColumn() > 0 && readHeader_(sheets[i]).indexOf('number') >= 0) {
      return sheets[i];
    }
  }
  throw new Error('No tab has a "number" column in row 1.');
}

function readHeader_(sheet) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function(h) {
    return String(h).trim().toLowerCase().replace(/\s+/g, '_');
  });
}

/**
 * Maps header name to column position (1 = A). Adds the script's own columns
 * at the end if they are missing; refuses to run if one of yours is missing.
 */
function columns_(sheet) {
  var header = readHeader_(sheet);
  OWN_COLUMNS.forEach(function(name) {
    if (header.indexOf(name) < 0) {
      throw new Error('Row 1 has no "' + name + '" column. Was it renamed or deleted?');
    }
  });
  ADDED_COLUMNS.forEach(function(name) {
    if (header.indexOf(name) >= 0) return;
    var position = header.length + 1;
    if (position > sheet.getMaxColumns()) sheet.insertColumnAfter(sheet.getMaxColumns());
    sheet.getRange(1, position).setValue(name);
    header.push(name);
  });
  var cols = {};
  header.forEach(function(name, i) {
    if (name && !(name in cols)) cols[name] = i + 1;
  });
  return cols;
}

/**
 * Values of the number column from row 2 down to the last row that has a
 * number. (Not getLastRow(): checkbox cells below the data count as content.)
 */
function numberValues_(sheet, cols) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, cols.number, lastRow - 1, 1).getValues()
      .map(function(r) { return r[0]; });
  var end = values.length;
  while (end > 0 && String(values[end - 1]).trim() === '') end--;
  return values.slice(0, end);
}

/** All cells from row 2 down to the last row that has a number. */
function readTable_(sheet, cols) {
  var count = numberValues_(sheet, cols).length;
  if (!count) return [];
  return sheet.getRange(2, 1, count, sheet.getLastColumn()).getValues();
}

function nextNumber_(numbers) {
  var max = 0;
  numbers.forEach(function(value) {
    var n = Number(value);
    if (value !== '' && isFinite(n) && n > max) max = Math.floor(n);
  });
  return max + 1;
}

function getKey_() {
  return (PropertiesService.getScriptProperties().getProperty(KEY_PROPERTY) || '').trim();
}

function requireKey_() {
  var key = getKey_();
  if (!key) {
    var ui = SpreadsheetApp.getUi();
    ui.alert('OMDb key needed',
        'Set the key first with DVD > Set OMDb key. A free key is available at ' +
        'omdbapi.com/apikey.aspx.',
        ui.ButtonSet.OK);
  }
  return key;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Finds "tt0133093" in an ID, a link, or anything else. Returns '' if absent. */
function parseImdbId_(value) {
  var match = /tt\d{5,}/i.exec(String(value == null ? '' : value));
  return match ? match[0].toLowerCase() : '';
}

function imdbUrl_(imdbId) {
  return 'https://www.imdb.com/title/' + imdbId + '/';
}

function omdbRequestUrl_(imdbId, key) {
  return OMDB_URL + '?apikey=' + encodeURIComponent(key) +
      '&i=' + encodeURIComponent(imdbId) + '&plot=short';
}

/** Reads minutes from "126 min". Returns null if there are none. */
function parseMinutes_(value) {
  var match = /^(\d+)\s*min/i.exec(String(value == null ? '' : value).trim());
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Makes Sheets store a text exactly as it is. Without the ' in front, Sheets
 * reads a leading = as a formula, + or - as a number, and drops a leading '
 * (think of the titles "+1" and "'71").
 */
function literal_(value) {
  return typeof value === 'string' && /^[=+\-']/.test(value) ? "'" + value : value;
}

function parseJson_(text) {
  try {
    var data = JSON.parse(text);
    return data && typeof data === 'object' ? data : null;
  } catch (e) {
    return null;
  }
}

function isTicked_(value) {
  return value === true || /^(true|yes|y|x|1)$/i.test(String(value).trim());
}

/** Sortable time for a fetched_on cell; 0 when empty or unreadable. */
function timestamp_(value) {
  if (value instanceof Date) return value.getTime();
  var parsed = Date.parse(String(value == null ? '' : value));
  return isNaN(parsed) ? 0 : parsed;
}

function columnLetter_(position) {
  var letters = '';
  while (position > 0) {
    var rest = (position - 1) % 26;
    letters = String.fromCharCode(65 + rest) + letters;
    position = Math.floor((position - 1) / 26);
  }
  return letters;
}

function addDialogHtml_(nextNumber) {
  return [
    '<style>',
    'body{font:14px Arial,sans-serif;margin:0;padding:2px}',
    'label{display:block;margin:12px 0 4px;font-weight:bold}',
    'input{width:100%;box-sizing:border-box;padding:6px;font:inherit}',
    '.hint{color:#666;font-size:12px;margin-top:3px}',
    '#msg{margin-top:12px;min-height:2.6em;color:#444}',
    '.buttons{text-align:right}',
    'button{font:inherit;padding:6px 16px;margin-left:6px}',
    '</style>',
    '<form id="form">',
    '<label for="imdb">IMDb ID or link (optional)</label>',
    '<input id="imdb" placeholder="tt0133093" autofocus>',
    '<div class="hint">Leave empty to fill in everything by hand.</div>',
    '<label for="number">Folder number</label>',
    '<input id="number" type="number" min="1" step="1" value="' + Number(nextNumber) + '">',
    '<div id="msg"></div>',
    '<div class="buttons">',
    '<button type="button" id="cancel">Cancel</button>',
    '<button type="submit" id="add">Add</button>',
    '</div>',
    '</form>',
    '<script>',
    'var msg = document.getElementById("msg");',
    'var add = document.getElementById("add");',
    'var cancel = document.getElementById("cancel");',
    'cancel.onclick = function() { google.script.host.close(); };',
    'document.getElementById("form").onsubmit = function(e) {',
    '  e.preventDefault();',
    '  add.disabled = true;',
    '  msg.style.color = "#444";',
    '  msg.textContent = "Adding…";',
    '  google.script.run',
    '    .withSuccessHandler(function(note) {',
    '      if (!note) { google.script.host.close(); return; }',
    '      msg.textContent = note;',
    '      add.style.display = "none";',
    '      cancel.textContent = "Close";',
    '    })',
    '    .withFailureHandler(function(err) {',
    '      msg.style.color = "#b00020";',
    '      msg.textContent = err.message;',
    '      add.disabled = false;',
    '    })',
    '    .addDvd({',
    '      imdb: document.getElementById("imdb").value,',
    '      number: document.getElementById("number").value',
    '    });',
    '};',
    '</script>',
  ].join('\n');
}
