# DVD collection

A small website for browsing a DVD collection by cover, title, or folder number.

- The **Google Sheet** is the database and the only place data is edited.
- The **page** (`index.html`) is read-only. It shows what is in the Sheet.
- The **Sheet script** (`apps-script/Code.gs`) adds a "DVD" menu to the Sheet for adding titles and fetching IMDb details.
- The **sync script** (`tools/sync_covers.py`) copies cover images into this repo, so the page does not depend on image links elsewhere.
- The **labels page** (`labels.html`) prints a label for each folder.

Everything is free, and nothing runs on a schedule.

## One-time setup

### 1. Publish the page on GitHub Pages

Create an empty public repository on GitHub (the examples use the name `dvd`), then in this folder:

```
git init -b main
git add .
git commit -m "DVD collection"
git remote add origin git@github.com:YOUR_NAME/dvd.git
git push -u origin main
```

On GitHub, open the repository's **Settings > Pages**, choose **Deploy from a branch**, pick branch `main` and folder `/ (root)`, and save. After a minute the page is at `https://YOUR_NAME.github.io/dvd/`.

### 2. Add the menu to the Sheet

1. In the Sheet, open **Extensions > Apps Script**.
2. Replace everything in `Code.gs` with the contents of `apps-script/Code.gs` and save.
3. Reload the Sheet. A **DVD** menu appears next to Help.

The first time you use the menu, Google asks you to authorize the script. Because it is your own unpublished script, Google shows an "unverified app" warning; choose **Advanced** and continue.

### 3. Get a key for the movie data

1. Request a free key at <https://www.omdbapi.com/apikey.aspx> and activate it from the email.
2. In the Sheet: **DVD > Set OMDb key…** and paste it. The menu tells you whether the key works.

The key is stored with the script, not in a cell and not in this repo. The free key allows 1,000 requests per day.

### 4. Prepare the Sheet and fetch current data

1. **DVD > Set up sheet**: adds the `poster_url` and `fetched_on` columns, turns `seen` and `liked` into checkboxes, and highlights duplicate numbers in red.
2. **DVD > Refresh ratings (all rows)**: fetches current IMDb details and poster links for every title. If it reports rows left over, run it again.

### 5. Copy the covers into the repo

```
python3 tools/sync_covers.py
```

This downloads a poster for every title that has a poster link, then commits and pushes. Needs Python 3 and git (`sudo apt install python3 git`).

Posters from OMDb are about 300 pixels wide. `python3 tools/sync_covers.py --force --poster-width 600` asks the image host for wider ones and falls back to the normal size where that fails.

## Everyday use

### Add a DVD

**DVD > Add DVD…** in the Sheet.

- Paste the IMDb ID or the IMDb link to prefill title, year, length, rating, and poster. Leave it empty to type everything yourself.
- The folder number is prefilled with the highest number plus one. Change it if you want a different one.
- Languages and subtitles are always yours to fill in, or leave empty.

You can also type rows directly. **DVD > Fill in details (new rows)** then fetches details for every row that has an IMDb ID but no IMDb title yet.

The new title shows on the page within about five minutes. Its cover comes from the poster link until the next run of the sync script.

### Mark as seen or liked

Tick the `seen` and `liked` checkboxes in the Sheet (the Sheets phone app works too).

### Use your own cover image

Save the image as `covers/<number>.jpg` (`.png` and `.webp` also work) and run `python3 tools/sync_covers.py`. The sync script never replaces a cover that is already there unless you pass `--force`.

### Print folder labels

Open `labels.html` on the computer (`https://YOUR_NAME.github.io/dvd/labels.html`). Each label is 4.6 cm wide and 11.8 cm tall and shows the first and last number of the folder in large digits, with the titles inside listed below. Eight labels fit on a sheet of A4 or Letter, and neighbouring labels share one cutting line.

- The page starts by putting 16 DVDs in each folder, in number order. Unused numbers do not take up space, so the first folder is 1 to 22.
- If a folder really starts or ends somewhere else, change its **From** or **To**. **Split the rest again** then redoes all folders below that one.
- If your folders hold fixed blocks of numbers instead (1–16, 17–32, …), set **Count** to "Numbers" and press **Split all again**.
- After adding DVDs to the Sheet, the page says which ones are in no folder yet and offers to put them into the last folder or new ones.
- To reprint one label, press **Untick all** and tick only that row.
- In the print dialog, keep the scale at 100%. "Fit to page" would shrink the labels.

The list of folders is remembered by the browser on that computer only. It is not stored in the Sheet, so another browser, or the same one after its site data is cleared, starts again from the default split.

### Refresh ratings

**DVD > Refresh ratings (all rows)**, or select some rows and use **DVD > Refresh selected rows**.

## The Sheet's columns

Columns are found by the name in row 1. You can reorder columns, but do not rename them: the menu stops with a message if `number`, `title`, `length_min`, or `imdb_id` is missing. The page reads the first tab.

| Column | Who fills it | Notes |
|---|---|---|
| `number` | You | Folder number. Must be unique. |
| `title` | You | Prefilled from IMDb only when empty. |
| `length_min` | You | Minutes. Prefilled from IMDb only when empty. |
| `series` | You | Free text, for example `James Bond`. |
| `audio`, `subtitles` | You | Codes separated by spaces or commas: `ENG FR DE RU JP`. Empty means unknown. |
| `dvd_zone` | You | Optional. |
| `seen`, `liked` | You | Checkboxes. |
| `imdb_id` | You | For example `tt0133093`. May be empty. |
| `imdb_url`, `imdb_title`, `year`, `imdb_runtime`, `imdb_rating`, `metascore`, `genre`, `director`, `actors`, `plot`, `poster_url`, `fetched_on` | Script | Overwritten whenever details are fetched. |
| `cover_file` | Nobody | Left over from the import. No longer used; you can delete the column. |

The script never changes a value you typed in your own columns.

## Where a cover comes from

For each title the page uses the first of these that exists:

1. `covers/<number>.jpg` in this repo (listed in `covers/index.json`, which the sync script writes).
2. The poster link in the Sheet.
3. The old small thumbnail in `covers/legacy/`.
4. A plain tile showing the title.

## When the Sheet can't be reached

The page shows the copy it saved on that device during the last visit. On a first visit it shows `data/snapshot.csv`, which the sync script updates on every run. In both cases a line at the top says so.

## Changing the Sheet link or the page title

Edit `config.js`. The link must be the Sheet's **File > Share > Publish to web** link in CSV format.

## Tests

```
node --test tests/test_app.js tests/test_labels.js tests/test_appsscript.js
python3 tests/test_sync.py
node --test tests/browser_test.js           # needs Google Chrome
LIVE=1 node --test tests/browser_test.js    # also reads the real published Sheet
```

The browser tests print the labels to PDF and measure them; that part needs `pdftoppm`, `pdfinfo`, and `pdftotext` (`sudo apt install poppler-utils`) and is skipped without them.

The tests use a copy of the Sheet from 2026-11-21 (`tests/fixtures/sheet.csv`), so they keep passing as the collection changes.

`test_appsscript.js` runs the Sheet script against a stand-in for Google's services, so it checks the script's logic but not Google's side.
