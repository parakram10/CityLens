#!/usr/bin/env python3
"""Range-capable static dev server for the CityLens dashboard.

Python's stock ``http.server`` has no HTTP Range support, so large per-run
``runs/<id>/annotated.mp4`` clips (hundreds of MB) won't stream or seek in a
<video> element — the browser aborts with a BrokenPipe. This handler adds
``Range`` / ``206 Partial Content`` so the annotated dashcam clips play back.

Serves the repo root (one level up from backend/).

Usage:  python3 backend/serve.py [port]      # default 5174
"""
import http.server
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # repo root
BUFSIZE = 256 * 1024


class RangeHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # Advertise range support + keep the dev loop honest (no stale JS).
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_head(self):
        self._range_remaining = None
        path = self.translate_path(self.path)
        rng = self.headers.get("Range")
        if not rng or os.path.isdir(path):
            return super().send_head()

        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None

        size = os.fstat(f.fileno()).st_size
        m = re.match(r"bytes=(\d*)-(\d*)\s*$", rng)
        if not m or (m.group(1) == "" and m.group(2) == ""):
            f.close()
            self.send_error(400, "Invalid Range")
            return None

        start_s, end_s = m.group(1), m.group(2)
        if start_s == "":  # suffix: last N bytes
            length = int(end_s)
            start = max(0, size - length)
            end = size - 1
        else:
            start = int(start_s)
            end = int(end_s) if end_s else size - 1

        if start >= size:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            f.close()
            return None

        end = min(end, size - 1)
        self._range_remaining = end - start + 1

        self.send_response(206, "Partial Content")
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(self._range_remaining))
        self.send_header("Last-Modified", self.date_time_string(os.fstat(f.fileno()).st_mtime))
        self.end_headers()
        f.seek(start)
        return f

    def copyfile(self, source, outputfile):
        remaining = self._range_remaining
        try:
            if remaining is None:
                super().copyfile(source, outputfile)
                return
            while remaining > 0:
                chunk = source.read(min(BUFSIZE, remaining))
                if not chunk:
                    break
                outputfile.write(chunk)
                remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # browser seeked/closed mid-stream — normal for <video>


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5174
    httpd = http.server.ThreadingHTTPServer(("", port), RangeHandler)
    print(f"Range-capable server serving {ROOT} at http://localhost:{port}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
