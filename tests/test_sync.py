#!/usr/bin/env python3
"""End-to-end test of tools/sync_covers.py against a local web server and a local git remote."""

import functools
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)

JPEG = b"\xff\xd8\xff\xe0" + b"j" * 2000
JPEG_WIDE = b"\xff\xd8\xff\xe0" + b"w" * 6000
PNG = b"\x89PNG\r\n\x1a\n" + b"p" * 2000


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class SyncTest(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="synctest-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

        # Web server with a fake sheet and fake posters.
        self.web = os.path.join(self.tmp, "web")
        os.makedirs(self.web)
        handler = functools.partial(QuietHandler, directory=self.web)
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.shutdown)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

        self.put("ok.jpg", JPEG)
        self.put("page.jpg", b"<html>not an image</html>" * 40)
        self.put("a_V1_SX300.jpg", JPEG)
        self.put("a_V1_SX600.jpg", JPEG_WIDE)
        self.put("b_V1_SX300.jpg", JPEG)  # no SX600 version on the server
        self.write_sheet([
            ("1", "Good", f"{self.base}/ok.jpg"),
            ("2", "Dead link", f"{self.base}/missing.jpg"),
            ("3", "Not an image", f"{self.base}/page.jpg"),
            ("4", "No link", ""),
            ("5", "Wide available", f"{self.base}/a_V1_SX300.jpg"),
            ("6", "Wide missing", f"{self.base}/b_V1_SX300.jpg"),
            ("", "Row without number", f"{self.base}/ok.jpg"),
        ])

        # A copy of the repo with a local bare remote to push to.
        self.repo = os.path.join(self.tmp, "repo")
        os.makedirs(os.path.join(self.repo, "tools"))
        shutil.copy(os.path.join(SITE, "tools", "sync_covers.py"), os.path.join(self.repo, "tools"))
        shutil.copy(os.path.join(SITE, "config.js"), self.repo)
        os.makedirs(os.path.join(self.repo, "covers", "legacy"))
        for n in (1, 4, 9):
            with open(os.path.join(self.repo, "covers", "legacy", f"{n}.jpg"), "wb") as f:
                f.write(JPEG)
        self.remote = os.path.join(self.tmp, "remote.git")
        self.git_any("init", "--quiet", "--bare", "-b", "main", self.remote)
        self.git("init", "--quiet", "-b", "main")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Test")
        self.git("remote", "add", "origin", self.remote)
        self.git("add", ".")
        self.git("commit", "--quiet", "-m", "initial")
        self.git("push", "--quiet", "-u", "origin", "main")

    def put(self, name, data):
        with open(os.path.join(self.web, name), "wb") as f:
            f.write(data)

    def write_sheet(self, rows):
        lines = ["number,title,poster_url"] + [",".join(r) for r in rows]
        self.put("sheet.csv", ("\r\n".join(lines) + "\r\n").encode("utf-8"))

    def git_any(self, *args):
        return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout

    def git(self, *args):
        return self.git_any("-C", self.repo, *args)

    def sync(self, *args):
        # The fake sheet is served from this machine; don't send that through a proxy.
        env = dict(os.environ, NO_PROXY="127.0.0.1", no_proxy="127.0.0.1")
        return subprocess.run(
            [sys.executable, os.path.join(self.repo, "tools", "sync_covers.py"),
             "--sheet-url", f"{self.base}/sheet.csv", *args],
            capture_output=True, text=True, env=env)

    def cover(self, name):
        with open(os.path.join(self.repo, "covers", name), "rb") as f:
            return f.read()

    def manifest(self):
        with open(os.path.join(self.repo, "covers", "index.json"), encoding="utf-8") as f:
            return json.load(f)

    def remote_files(self):
        return set(self.git_any("--git-dir", self.remote, "ls-tree", "-r", "--name-only", "main").split())

    def test_full_run(self):
        result = self.sync()
        out = result.stdout
        self.assertEqual(result.returncode, 1, out + result.stderr)  # two rows failed
        self.assertIn("6 titles", out)
        self.assertIn("Downloaded 3 cover(s); 2 failed.", out)
        self.assertIn("Failed numbers: 2, 3", out)
        self.assertNotIn("No cover of any kind", out)  # 4 has a legacy thumbnail

        self.assertEqual(self.cover("1.jpg"), JPEG)
        self.assertEqual(self.cover("5.jpg"), JPEG)  # no --poster-width: link as it is
        self.assertEqual(self.cover("6.jpg"), JPEG)
        self.assertFalse(os.path.exists(os.path.join(self.repo, "covers", "2.jpg")))
        self.assertFalse(os.path.exists(os.path.join(self.repo, "covers", "3.jpg")))
        self.assertEqual(self.manifest(), {
            "covers": {"1": "1.jpg", "5": "5.jpg", "6": "6.jpg"},
            "legacy": [1, 4, 9],
        })
        with open(os.path.join(self.repo, "data", "snapshot.csv"), "rb") as f:
            self.assertTrue(f.read().startswith(b"number,title,poster_url"))

        # Everything was pushed to the remote.
        self.assertIn("Committed and pushed.", out)
        self.assertLessEqual(
            {"covers/1.jpg", "covers/5.jpg", "covers/6.jpg", "covers/index.json", "data/snapshot.csv"},
            self.remote_files())
        self.assertEqual(self.git("status", "--porcelain").strip(), "")

    def test_second_run_only_retries_failures(self):
        self.sync()
        self.put("missing.jpg", PNG)  # the dead link comes back, as a PNG
        result = self.sync()
        self.assertIn("[1/2] 2 Dead link: saved 2.png", result.stdout)
        self.assertIn("Downloaded 1 cover(s); 1 failed.", result.stdout)
        self.assertEqual(self.manifest()["covers"]["2"], "2.png")
        self.assertIn("covers/2.png", self.remote_files())

    def test_nothing_new(self):
        self.write_sheet([("1", "Good", f"{self.base}/ok.jpg")])
        self.sync()
        result = self.sync()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Downloaded 0 cover(s); 0 failed.", result.stdout)
        self.assertIn("Nothing new to commit.", result.stdout)

    def test_poster_width_with_fallback(self):
        result = self.sync("--poster-width", "600", "--no-push")
        self.assertEqual(self.cover("5.jpg"), JPEG_WIDE)  # wider version existed
        self.assertEqual(self.cover("6.jpg"), JPEG)       # fell back to the link as it is
        self.assertEqual(self.cover("1.jpg"), JPEG)       # link has no size in it
        self.assertNotIn("Committed", result.stdout)
        self.assertNotEqual(self.git("status", "--porcelain").strip(), "")  # left uncommitted

    def test_own_cover_is_kept_and_listed(self):
        with open(os.path.join(self.repo, "covers", "1.png"), "wb") as f:
            f.write(PNG)
        with open(os.path.join(self.repo, "covers", "4.webp"), "wb") as f:
            f.write(b"RIFF\x00\x00\x00\x00WEBP" + b"x" * 600)
        self.sync("--no-push")
        self.assertFalse(os.path.exists(os.path.join(self.repo, "covers", "1.jpg")))
        self.assertEqual(self.cover("1.png"), PNG)
        covers = self.manifest()["covers"]
        self.assertEqual(covers["1"], "1.png")
        self.assertEqual(covers["4"], "4.webp")

    def test_force_replaces_cover(self):
        with open(os.path.join(self.repo, "covers", "1.png"), "wb") as f:
            f.write(PNG)
        self.sync("--no-push", "--force")
        self.assertEqual(self.cover("1.jpg"), JPEG)
        self.assertFalse(os.path.exists(os.path.join(self.repo, "covers", "1.png")))
        self.assertEqual(self.manifest()["covers"]["1"], "1.jpg")

    def test_bad_sheet_changes_nothing(self):
        self.put("sheet.csv", b"<html>Sign in</html>")
        result = self.sync()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Couldn't read the Sheet", result.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.repo, "data", "snapshot.csv")))
        self.assertFalse(os.path.exists(os.path.join(self.repo, "covers", "index.json")))

    def test_unreachable_sheet(self):
        os.remove(os.path.join(self.web, "sheet.csv"))
        result = self.sync()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Couldn't read the Sheet", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
