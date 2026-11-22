// Tests for the data logic in dvd-site/app.js. Run: node --test tests/test_app.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SITE = path.join(__dirname, '..');
const app = require(path.join(SITE, 'app.js'));
// A copy of the Sheet as it was on 2026-11-21, so the expected numbers stay valid.
const SNAPSHOT = fs.readFileSync(path.join(__dirname, 'fixtures', 'sheet.csv'), 'utf8');

const state = (overrides) => Object.assign({}, app.DEFAULT_STATE, overrides);
const numbers = (list) => list.map((m) => m.number);

test('parseCsv handles quotes, commas, line breaks, BOM', () => {
  assert.deepEqual(app.parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(app.parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(app.parseCsv('\ufeffa\n"x, ""y""\nz",\n'), [['a'], ['x, "y"\nz', '']]);
  assert.deepEqual(app.parseCsv('a,,c\n'), [['a', '', 'c']]);
  assert.deepEqual(app.parseCsv(''), []);
});

test('buildMovies rejects things that are not the sheet', () => {
  assert.throws(() => app.buildMovies('<html><body>Sign in</body></html>'), /number/);
  assert.throws(() => app.buildMovies('number,title\n,\n'), /no rows/);
  assert.throws(() => app.buildMovies(''), /number/);
});

test('the sheet as imported loads completely', () => {
  const movies = app.buildMovies(SNAPSHOT);
  assert.equal(movies.length, 367);
  assert.equal(new Set(numbers(movies)).size, 367);
  assert.ok(movies.every((m) => !m.duplicate));

  const vadrouille = movies.find((m) => m.number === 135);
  assert.equal(vadrouille.title, 'La Grande Vadrouille');
  assert.equal(vadrouille.imdbTitle, 'The Big Runaround');
  assert.equal(vadrouille.length, 120);
  assert.equal(vadrouille.imdbRuntime, 132);
  assert.equal(vadrouille.imdbId, 'tt0060474');
  assert.equal(vadrouille.series, 'Louis de Funès');

  const potter = movies.find((m) => m.number === 1);
  assert.deepEqual(potter.audio, ['ENG', 'FR']);
  assert.equal(potter.rating, 7.4);
  assert.equal(potter.metascore, 64);
  assert.deepEqual(potter.genres, ['Adventure', 'Family', 'Fantasy']);
  assert.equal(potter.seen, false);

  const hobbit = movies.find((m) => m.number === 15);
  assert.equal(hobbit.rating, null);
  assert.equal(hobbit.imdbTitle, '');
  assert.equal(hobbit.length, 155);

  // "8" in the sheet (was 8.0) still reads as a rating.
  assert.equal(movies.find((m) => m.number === 435).rating, 8.8);
  assert.equal(movies.filter((m) => m.rating === null).length, 1);
  assert.equal(movies.filter((m) => m.metascore === null).length, 150);
  assert.equal(movies.filter((m) => m.length === null).length, 0);
});

test('rows are read leniently and unsafe values are dropped', () => {
  const csv = [
    'Number,Title,length_min,imdb_runtime,imdb_rating,imdb_id,imdb_url,poster_url,seen,liked,audio,metascore',
    '7,  Padded  ,,95 min,"7,4",,https://www.imdb.com/title/tt0133093/?x=1,http://insecure.example/p.jpg,TRUE,FALSE,"ENG, de",N/A',
    '8,,,,,tt0000001,,javascript:alert(1),x,yes,,',
    'abc,Not a row,,,,,,,,,,',
    ',No number,,,,,,,,,,',
    '7,Same number again,,,,,,https://ok.example/p.jpg,,,,',
  ].join('\n');
  const [a, b, c] = app.buildMovies(csv);
  assert.equal(a.title, 'Padded');
  assert.equal(a.length, 95, 'falls back to the IMDb runtime');
  assert.equal(a.rating, 7.4, 'decimal comma');
  assert.equal(a.imdbId, 'tt0133093', 'taken from the link');
  assert.equal(a.posterUrl, '', 'http poster is not used on an https page');
  assert.equal(a.seen, true);
  assert.equal(a.liked, false);
  assert.deepEqual(a.audio, ['ENG', 'DE']);
  assert.equal(a.metascore, null);
  assert.equal(b.title, '(no title)');
  assert.equal(b.posterUrl, '');
  assert.equal(b.seen, true);
  assert.equal(b.liked, true);
  assert.equal(c.number, 7);
  assert.equal(c.duplicate, true);
  assert.equal(c.posterUrl, 'https://ok.example/p.jpg');
});

test('search: both titles, accents, exact number', () => {
  const movies = app.buildMovies(SNAPSHOT);
  const find = (q) => numbers(movies.filter((m) => app.matches(m, state({q}))));

  assert.deepEqual(find('matrix').sort((x, y) => x - y), [31, 32, 33]);
  assert.deepEqual(find('big runaround'), [135], 'IMDb title');
  assert.deepEqual(find('GRANDE vadrouille'), [135], 'own title, any case, any word order');
  assert.deepEqual(find('cleopatre'), [131], 'finds "Cléopâtre" without the accents');
  assert.ok(find('funes').includes(135), 'series name, without the accent');
  assert.ok(find('135').includes(135));
  assert.ok(!find('13').includes(135), 'a number must match exactly');
  assert.deepEqual(find('zzzz'), []);
  assert.equal(find('   ').length, 367);
});

test('filters', () => {
  const movies = app.buildMovies(SNAPSHOT);
  const count = (overrides) => movies.filter((m) => app.matches(m, state(overrides))).length;
  // Expected values counted straight from the CSV, without the page's code.
  const rows = SNAPSHOT.split('\n').length; // sanity only
  assert.ok(rows > 367);
  assert.equal(count({audio: 'RU'}), 48);
  assert.equal(count({audio: 'JP'}), 9);
  assert.equal(count({subs: 'RU'}), 19);
  assert.equal(count({seen: 'unseen'}), 367);
  assert.equal(count({seen: 'seen'}), 0);
  assert.equal(count({seen: 'liked'}), 0);
  assert.equal(count({genre: 'Western'}), 8);
  assert.equal(count({genre: 'Animation'}), 35);
  assert.equal(count({series: 'Matrix'}), 3);
  assert.equal(count({maxLen: 90}), movies.filter((m) => m.length <= 90).length);
  assert.ok(count({maxLen: 90}) > 0 && count({maxLen: 90}) < 367);
  assert.equal(count({minRating: 8}), movies.filter((m) => m.rating !== null && m.rating >= 8).length);
  // Unknown rating is excluded once a minimum is set.
  assert.ok(!movies.filter((m) => app.matches(m, state({minRating: 6}))).some((m) => m.number === 15));
  // Filters combine.
  assert.equal(count({series: 'Matrix', q: 'reloaded'}), 1);
  assert.equal(count({series: 'Matrix', audio: 'JP'}), 0);
});

test('seen and liked filters', () => {
  const csv = 'number,title,seen,liked\n1,A,TRUE,TRUE\n2,B,TRUE,FALSE\n3,C,FALSE,FALSE\n';
  const movies = app.buildMovies(csv);
  const pick = (seen) => numbers(movies.filter((m) => app.matches(m, state({seen}))));
  assert.deepEqual(pick('all'), [1, 2, 3]);
  assert.deepEqual(pick('unseen'), [3]);
  assert.deepEqual(pick('seen'), [1, 2]);
  assert.deepEqual(pick('liked'), [1]);
});

test('sorting puts missing values last in both directions', () => {
  const csv = 'number,title,imdb_rating,year,length_min\n' +
      '3,Bravo,7.0,1999,100\n1,alpha,,2005,90\n2,Écharpe,9.1,1950,\n10,Delta,7.0,,120\n';
  const movies = app.buildMovies(csv);
  const order = (key, dir) => numbers(app.sortMovies(movies, key, dir));
  assert.deepEqual(order('title', 1), [1, 3, 10, 2]);
  assert.deepEqual(order('number', 1), [1, 2, 3, 10]);
  assert.deepEqual(order('number', -1), [10, 3, 2, 1]);
  assert.deepEqual(order('rating', -1), [2, 3, 10, 1]);
  assert.deepEqual(order('rating', 1), [3, 10, 2, 1]);
  assert.deepEqual(order('year', -1), [1, 3, 2, 10]);
  assert.deepEqual(order('length', 1), [1, 3, 10, 2]);
  assert.deepEqual(numbers(movies), [3, 1, 2, 10], 'the input list is not reordered');
});

test('cover order: repo file, then poster link, then old thumbnail', () => {
  const [movie] = app.buildMovies('number,title,poster_url\n12,T,https://img.example/p.jpg\n');
  const manifest = {covers: {12: '12.png'}, legacy: [12, 13]};
  assert.deepEqual(app.coverCandidates(movie, manifest),
      ['covers/12.png', 'https://img.example/p.jpg', 'covers/legacy/12.jpg']);
  assert.deepEqual(app.coverCandidates(movie, {covers: {}, legacy: []}), ['https://img.example/p.jpg']);
  const [bare] = app.buildMovies('number,title\n99,T\n');
  assert.deepEqual(app.coverCandidates(bare, manifest), []);
  assert.deepEqual(app.coverCandidates(bare, {}), []);
});

test('lengths and filter options', () => {
  assert.equal(app.formatLength(126), '2h 06');
  assert.equal(app.formatLength(120), '2h 00');
  assert.equal(app.formatLength(45), '45 min');
  assert.equal(app.formatLength(null), '');
  const options = app.collectOptions(app.buildMovies(SNAPSHOT));
  assert.deepEqual(options.audio, ['DE', 'ENG', 'FR', 'JP', 'RU']);
  assert.equal(options.series.length, 41);
  assert.equal(options.genre.length, 22);
  assert.ok(options.series.includes('James Bond'));
});
