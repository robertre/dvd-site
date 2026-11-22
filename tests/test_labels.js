// Tests for the folder logic in labels.js. Run: node --test tests/test_labels.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SITE = path.join(__dirname, '..');
const app = require(path.join(SITE, 'app.js'));
const labels = require(path.join(SITE, 'labels.js'));

// The Sheet as it was on 2026-11-21.
const MOVIES = app.buildMovies(fs.readFileSync(path.join(__dirname, 'fixtures', 'sheet.csv'), 'utf8'));
const NUMBERS = labels.sortedUnique(MOVIES.map((m) => m.number));

const range = (a, b) => Array.from({length: b - a + 1}, (_, i) => a + i);
const spans = (folders) => folders.map((f) => `${f.start}-${f.end}`);
const folder = (start, end, print = true) => ({start, end, print});

test('sortedUnique', () => {
  assert.deepEqual(labels.sortedUnique([5, 1, 5, 12, 1]), [1, 5, 12]);
  assert.deepEqual(labels.sortedUnique([]), []);
});

test('split by DVDs: unused numbers do not take up space', () => {
  // 1-8, 11-15, 20-26, 31-33: the start of the real collection.
  const numbers = [...range(1, 8), ...range(11, 15), ...range(20, 26), ...range(31, 33)];
  assert.deepEqual(spans(labels.buildFolders(numbers, 16, 'titles')), ['1-22', '23-33']);
  assert.deepEqual(spans(labels.buildFolders(numbers, 5, 'titles')), ['1-5', '6-12', '13-21', '22-26', '31-33']);
  assert.deepEqual(spans(labels.buildFolders([7], 16, 'titles')), ['7-7']);
  assert.deepEqual(labels.buildFolders([], 16, 'titles'), []);
  assert.ok(labels.buildFolders(numbers, 16, 'titles').every((f) => f.print === true));
});

test('split by numbers: fixed blocks, empty blocks get no folder', () => {
  const numbers = [...range(1, 8), ...range(11, 15), ...range(20, 26), ...range(31, 33)];
  assert.deepEqual(spans(labels.buildFolders(numbers, 16, 'numbers')), ['1-16', '17-32', '33-48']);
  assert.deepEqual(spans(labels.buildFolders([1, 100], 16, 'numbers')), ['1-16', '97-112']);
  assert.deepEqual(spans(labels.buildFolders([16, 17], 16, 'numbers')), ['1-16', '17-32']);
  // Counting can start somewhere else than 1.
  assert.deepEqual(spans(labels.buildFolders([51, 52, 70], 16, 'numbers', 51)), ['51-66', '67-82']);
  assert.deepEqual(labels.buildFolders([], 16, 'numbers'), []);
});

test('a nonsense size is treated as 1', () => {
  assert.deepEqual(spans(labels.buildFolders([3, 4], 0, 'titles')), ['3-3', '4-4']);
  assert.deepEqual(spans(labels.buildFolders([3, 4], NaN, 'numbers')), ['3-3', '4-4']);
});

test('whole collection: 16 per folder puts every DVD in exactly one folder', () => {
  const folders = labels.buildFolders(NUMBERS, 16, 'titles');
  assert.equal(NUMBERS.length, 367);
  assert.equal(folders.length, 23);
  assert.deepEqual(spans(folders).slice(0, 3), ['1-22', '23-75', '76-91']);
  assert.equal(folders.at(-1).end, 435);
  const counts = folders.map((f) => NUMBERS.filter((n) => n >= f.start && n <= f.end).length);
  assert.deepEqual(counts, [...Array(22).fill(16), 15]);
  assert.deepEqual(labels.checkFolders(folders, NUMBERS), {invalid: [], overlaps: [], uncovered: []});

  const blocks = labels.buildFolders(NUMBERS, 16, 'numbers');
  assert.deepEqual(spans(blocks).slice(0, 4), ['1-16', '17-32', '33-48', '49-64']);
  assert.ok(blocks.every((f) => f.end - f.start === 15));
  assert.deepEqual(labels.checkFolders(blocks, NUMBERS), {invalid: [], overlaps: [], uncovered: []});
});

test('checkFolders reports unusable rows, overlaps, and DVDs in no folder', () => {
  const numbers = range(1, 40);
  const folders = [folder(1, 16), folder(15, 20), folder(null, 30), folder(30, 25), folder(20, 22), folder(0, 3)];
  const check = labels.checkFolders(folders, numbers);
  assert.deepEqual(check.invalid, [2, 3, 5]);
  assert.deepEqual(check.overlaps, [
    {a: 0, b: 1, from: 15, to: 16},
    {a: 1, b: 4, from: 20, to: 20},
  ]);
  assert.deepEqual(check.uncovered, range(23, 40));
  assert.equal(labels.isValid(folder(5, 5)), true);
  assert.equal(labels.isValid(folder(1.5, 5)), false);
  assert.equal(labels.isValid(folder('1', 5)), false);
});

test('continueFrom keeps the folders above and splits the rest again', () => {
  const numbers = range(1, 60);
  const start = labels.buildFolders(numbers, 16, 'titles'); // 1-16, 17-32, 33-48, 49-60
  start[0].print = false;
  start[1].end = 35; // one folder holds 19
  const next = labels.continueFrom(start, 1, numbers, 16, 'titles');
  assert.deepEqual(spans(next), ['1-16', '17-35', '36-51', '52-60']);
  assert.equal(next[0].print, false, 'folders above keep their tick');
  assert.equal(start.length, 4, 'the input list is not changed');

  const blocks = labels.continueFrom([folder(1, 20)], 0, numbers, 16, 'numbers');
  assert.deepEqual(spans(blocks), ['1-20', '21-36', '37-52', '53-68']);
  // Nothing after the anchor: nothing is added.
  assert.deepEqual(spans(labels.continueFrom([folder(1, 99)], 0, numbers, 16, 'titles')), ['1-99']);
});

test('placeNew fills the last folder first, then opens new ones', () => {
  // Last folder 33-47 holds 15 of 16.
  const before = [folder(1, 16), folder(17, 32, false), folder(33, 47)];
  const numbers = [...range(1, 47), 48, 49, 50];
  const after = labels.placeNew(before, numbers, 16, 'titles');
  assert.deepEqual(spans(after), ['1-16', '17-32', '33-48', '49-50']);
  assert.equal(after[1].print, false);
  assert.deepEqual(spans(before), ['1-16', '17-32', '33-47'], 'the input list is not changed');

  // A last folder you made larger than usual is left alone.
  assert.deepEqual(spans(labels.placeNew([folder(1, 20)], range(1, 22), 16, 'titles')), ['1-20', '21-22']);
  // The folder with the highest numbers counts as last, wherever it is in the list.
  assert.deepEqual(spans(labels.placeNew([folder(17, 30), folder(1, 16)], range(1, 34), 16, 'titles')),
      ['17-32', '1-16', '33-34']);
  // DVDs in a gap between folders are not moved anywhere.
  const gap = labels.placeNew([folder(1, 10), folder(20, 35)], [...range(1, 10), 15, ...range(20, 35), 36], 16, 'titles');
  assert.deepEqual(spans(gap), ['1-10', '20-35', '36-36']);
  assert.deepEqual(labels.checkFolders(gap, [15]).uncovered, [15]);
  // Nothing new: nothing changes.
  assert.deepEqual(spans(labels.placeNew(before, range(1, 47), 16, 'titles')), ['1-16', '17-32', '33-47']);
  // No usable folder yet: start from scratch.
  assert.deepEqual(spans(labels.placeNew([folder(null, null)], range(1, 20), 16, 'titles')),
      ['null-null', '1-16', '17-20']);
});

test('placeNew with fixed blocks of numbers', () => {
  // The last block was shortened by hand to 33-40; number 41 still belongs to it.
  assert.deepEqual(spans(labels.placeNew([folder(1, 16), folder(33, 40)], [1, 34, 41, 50], 16, 'numbers')),
      ['1-16', '33-48', '49-64']);
  assert.deepEqual(spans(labels.placeNew([folder(1, 16)], [1, 17, 40], 16, 'numbers')),
      ['1-16', '17-32', '33-48']);
});
