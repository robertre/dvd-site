#!/usr/bin/env python3
"""Copies cover images into this repo so the page doesn't depend on poster links.

What it does, each time you run it:
  1. Downloads the published Sheet and saves it as data/snapshot.csv
     (the page's fallback copy, and a versioned backup of your data).
  2. For every row that has a poster link but no local cover yet, downloads
     the poster to covers/<number>.jpg.
  3. Rewrites covers/index.json, the list of covers the page may use.
  4. Commits and pushes the changes (skip with --no-push).

Needs only Python 3 and git. Run it from anywhere:

    python3 tools/sync_covers.py

To use your own image for a title, save it as covers/<number>.jpg (or .png,
.webp) and run this script; it never overwrites a cover that is already there
unless you pass --force.
"""

import argparse
import csv
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COVERS_DIR = os.path.join(REPO, "covers")
LEGACY_DIR = os.path.join(COVERS_DIR, "legacy")
MANIFEST = os.path.join(COVERS_DIR, "index.json")
SNAPSHOT = os.path.join(REPO, "data", "snapshot.csv")
CONFIG = os.path.join(REPO, "config.js")

IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp")
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MIN_IMAGE_BYTES = 500
USER_AGENT = "dvd-collection-sync/1.0"


def log(message):
    print(message, flush=True)


def read_sheet_url():
    """Reads the Sheet link from config.js so it is configured in one place."""
    with open(CONFIG, encoding="utf-8") as f:
        match = re.search(r'sheetCsvUrl\s*:\s*"([^"]+)"', f.read())
    if not match:
        sys.exit(f"Couldn't find sheetCsvUrl in {CONFIG}.")
    return match.group(1)


def fetch(url, timeout=30):
    """Returns the bytes at `url`. Raises OSError on any download problem."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = response.read(MAX_IMAGE_BYTES + 1)
    if len(data) > MAX_IMAGE_BYTES:
        raise OSError("file is larger than 8 MB")
    return data


def image_extension(data):
    """Returns the file extension for image bytes, or None if not an image."""
    if data[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return None


def write_if_changed(path, data):
    """Writes bytes to `path` via a temp file. Returns True if the file changed."""
    try:
        with open(path, "rb") as f:
            if f.read() == data:
                return False
    except FileNotFoundError:
        pass
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)
    return True


def parse_sheet(data):
    """Returns the Sheet rows as dicts keyed by lower-case header name."""
    text = data.decode("utf-8-sig")
    rows = list(csv.reader(io.StringIO(text, newline="")))
    if not rows:
        raise ValueError("the sheet is empty")
    header = [re.sub(r"\s+", "_", h.strip().lower()) for h in rows[0]]
    if "number" not in header:
        raise ValueError("the sheet has no 'number' column (got an error page?)")
    records = []
    for cells in rows[1:]:
        record = {
            name: (cells[i].strip() if i < len(cells) else "")
            for i, name in enumerate(header) if name
        }
        if re.fullmatch(r"\d+", record.get("number", "")) and int(record["number"]) > 0:
            record["number"] = int(record["number"])
            records.append(record)
    if not records:
        raise ValueError("the sheet has no rows with a number")
    return records


def local_covers():
    """Maps number -> file name for covers/<number>.<ext> (newest file wins)."""
    found = {}
    if not os.path.isdir(COVERS_DIR):
        return found
    for name in os.listdir(COVERS_DIR):
        stem, ext = os.path.splitext(name)
        if ext.lower() not in IMAGE_EXTENSIONS or not stem.isdigit():
            continue
        number = int(stem)
        path = os.path.join(COVERS_DIR, name)
        if number not in found or os.path.getmtime(path) > os.path.getmtime(
                os.path.join(COVERS_DIR, found[number])):
            found[number] = name
    return found


def legacy_covers():
    """Numbers that have an old thumbnail in covers/legacy/<number>.jpg."""
    if not os.path.isdir(LEGACY_DIR):
        return []
    numbers = []
    for name in os.listdir(LEGACY_DIR):
        stem, ext = os.path.splitext(name)
        if ext == ".jpg" and stem.isdigit():
            numbers.append(int(stem))
    return sorted(numbers)


def wider_poster_url(url, width):
    """Asks the poster host for a wider image by rewriting the size in the link.

    Only applies to links that end in "_SX300.jpg" (the form OMDb hands out).
    This is a convention of the image host, not a documented feature, so the
    caller falls back to the original link if the rewritten one fails.
    """
    if not width:
        return None
    rewritten = re.sub(r"_SX\d+(\.\w+)$", rf"_SX{int(width)}\1", url)
    return rewritten if rewritten != url else None


def download_cover(record, width):
    """Downloads the poster for one row. Returns (file name, None) or (None, error)."""
    url = record.get("poster_url", "")
    attempts = [u for u in (wider_poster_url(url, width), url) if u]
    error = "no poster link"
    for attempt in attempts:
        try:
            data = fetch(attempt)
        except (OSError, ValueError) as e:
            error = str(e)
            continue
        ext = image_extension(data)
        if ext is None or len(data) < MIN_IMAGE_BYTES:
            error = "the link did not return an image"
            continue
        name = f"{record['number']}{ext}"
        # Remove an older cover with a different extension, e.g. 12.png.
        for other in IMAGE_EXTENSIONS:
            stale = os.path.join(COVERS_DIR, f"{record['number']}{other}")
            if other != ext and os.path.exists(stale):
                os.remove(stale)
        write_if_changed(os.path.join(COVERS_DIR, name), data)
        return name, None
    return None, error


def write_manifest():
    covers = local_covers()
    manifest = {
        "covers": {str(n): covers[n] for n in sorted(covers)},
        "legacy": legacy_covers(),
    }
    data = (json.dumps(manifest, indent=0, separators=(",", ":")) + "\n").encode("utf-8")
    write_if_changed(MANIFEST, data)
    return manifest


def git(*args, check=True):
    return subprocess.run(["git", "-C", REPO, *args], check=check)


def commit_and_push():
    """Commits covers/ and data/ if they changed, then pushes. Returns exit code."""
    if not os.path.exists(os.path.join(REPO, ".git")):
        log("Not a git repository, so nothing was committed or pushed.")
        return 0
    try:
        git("add", "--", "covers", "data")
        if git("diff", "--cached", "--quiet", "--", "covers", "data", check=False).returncode == 0:
            log("Nothing new to commit.")
            return 0
        git("commit", "--quiet", "-m", "Sync covers and data snapshot", "--", "covers", "data")
        git("push", "--quiet")
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        log(f"git failed: {e}")
        log("The files are updated on disk. Fix the git problem and push by hand.")
        return 1
    log("Committed and pushed.")
    return 0


def format_numbers(numbers, limit=30):
    numbers = sorted(numbers)
    text = ", ".join(str(n) for n in numbers[:limit])
    if len(numbers) > limit:
        text += f", and {len(numbers) - limit} more"
    return text


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--no-push", action="store_true",
                        help="update the files but don't commit or push")
    parser.add_argument("--force", action="store_true",
                        help="download posters again even where a cover exists")
    parser.add_argument("--poster-width", type=int, default=0, metavar="PIXELS",
                        help="try to get posters this wide (e.g. 600) instead of the "
                             "size in the link; falls back to the link as it is")
    parser.add_argument("--sheet-url", default=None,
                        help="read this CSV link instead of the one in config.js")
    args = parser.parse_args()

    sheet_url = args.sheet_url or read_sheet_url()
    log("Reading the Sheet...")
    try:
        sheet_bytes = fetch(sheet_url)
        records = parse_sheet(sheet_bytes)
    except (OSError, ValueError) as e:
        sys.exit(f"Couldn't read the Sheet: {e}")
    log(f"  {len(records)} titles.")
    write_if_changed(SNAPSHOT, sheet_bytes)

    os.makedirs(COVERS_DIR, exist_ok=True)
    have = local_covers()
    todo = [r for r in records
            if r.get("poster_url", "").lower().startswith(("http://", "https://"))
            and (args.force or r["number"] not in have)]

    downloaded = 0
    failed = {}
    for i, record in enumerate(todo, 1):
        name, error = download_cover(record, args.poster_width)
        label = f"{record['number']} {record.get('title', '')}".strip()
        if name:
            downloaded += 1
            log(f"  [{i}/{len(todo)}] {label}: saved {name}")
        else:
            failed[record["number"]] = error
            log(f"  [{i}/{len(todo)}] {label}: FAILED ({error})")
        time.sleep(0.2)

    manifest = write_manifest()
    numbers = {r["number"] for r in records}
    with_local = {int(n) for n in manifest["covers"]}
    with_legacy = set(manifest["legacy"])
    with_link = {r["number"] for r in records if r.get("poster_url")}
    none_at_all = numbers - with_local - with_legacy - with_link

    log("")
    log(f"Downloaded {downloaded} cover(s); {len(failed)} failed.")
    log(f"Covers in the repo: {len(with_local & numbers)} of {len(numbers)} titles "
        f"({len((with_legacy - with_local) & numbers)} more use an old thumbnail).")
    if failed:
        log(f"Failed numbers: {format_numbers(failed)}")
    if none_at_all:
        log(f"No cover of any kind: {format_numbers(none_at_all)}")

    status = 0 if args.no_push else commit_and_push()
    return 1 if failed else status


if __name__ == "__main__":
    sys.exit(main())
