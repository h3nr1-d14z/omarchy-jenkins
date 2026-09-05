#!/usr/bin/env python3
"""Mock Jenkins server for the jenkins-health benchmark harness.

Stdlib only. Serves the fixture set for one scenario (healthy | degraded |
outage) on a fixed local address so integration tests can exercise real curl
round-trips offline.

  GET /api/json                  -> api.json        + X-Jenkins header
  GET /computer/api/json         -> computer.json   (query params ignored)
  GET /queue/api/json            -> queue.json
  GET /pluginManager/api/json    -> pluginManager.json
  GET /updateCenter/api/json     -> updateCenter.json
  GET /crumbIssuer/api/json      -> synthetic crumb document
  anything else                  -> 404
  outage scenario                -> 502 for every request, no JSON

Usage: mock_jenkins.py <scenario> [port]
Prints "Mock Jenkins listening on 127.0.0.1:<port> (scenario: <name>)" once
the socket is bound, then logs one line per request. Runs until SIGTERM.
"""

import json
import signal
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

FIXTURES_ROOT = Path(__file__).resolve().parent / "fixtures" / "jenkins"
SCENARIOS = ("healthy", "degraded", "outage")
DEFAULT_PORT = 28888

ROUTE_TABLE = {
    "/api/json": "api.json",
    "/computer/api/json": "computer.json",
    "/queue/api/json": "queue.json",
    "/pluginManager/api/json": "pluginManager.json",
    "/updateCenter/api/json": "updateCenter.json",
}

CRUMB_DOCUMENT = {
    "_class": "hudson.security.csrf.DefaultCrumbIssuer",
    "crumb": "mock-crumb-abc123",
    "crumbRequestField": "Jenkins-Crumb",
}

SCENARIO = None


class MockJenkinsHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        path = self.path.split("?", 1)[0]

        if SCENARIO == "outage":
            self._reply(502, b"Bad Gateway\n", "text/plain")
            print(f"{self.address_string()} GET {path} -> 502", flush=True)
            return

        if path == "/crumbIssuer/api/json":
            body = json.dumps(CRUMB_DOCUMENT).encode()
            self._reply(200, body, "application/json")
            print(f"{self.address_string()} GET {path} -> 200 (crumb)", flush=True)
            return

        # The plugin's controller fetch uses a tree query (nested jobs with
        # colors). Serve the nested-shaped fixture of the same world when
        # asked; plain /api/json keeps the flat fixture.
        if (
            path == "/api/json"
            and "tree=" in self.path
            and (FIXTURES_ROOT / SCENARIO / "api-tree.json").exists()
        ):
            fixture = "api-tree.json"
        else:
            fixture = ROUTE_TABLE.get(path)
        if fixture is None:
            self._reply(404, b"Not Found\n", "text/plain")
            print(f"{self.address_string()} GET {path} -> 404", flush=True)
            return

        fixture_path = FIXTURES_ROOT / SCENARIO / fixture
        try:
            body = fixture_path.read_bytes()
        except OSError as exc:
            self._reply(500, f"fixture read error: {exc}".encode(), "text/plain")
            print(f"{self.address_string()} GET {path} -> 500", flush=True)
            return

        try:
            jenkins_header = (
                FIXTURES_ROOT / SCENARIO / "x-jenkins-header.txt"
            ).read_text().strip()
        except OSError:
            jenkins_header = ""

        headers = {"X-Jenkins": jenkins_header} if jenkins_header else {}
        self._reply(200, body, "application/json", headers)
        print(f"{self.address_string()} GET {path} -> 200", flush=True)

    def _reply(self, code, body, content_type, extra_headers=None):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # noqa: N802 - stdlib signature
        pass


def main():
    global SCENARIO

    if len(sys.argv) < 2 or sys.argv[1] not in SCENARIOS:
        print(
            f"usage: {sys.argv[0]} <{'|'.join(SCENARIOS)}> [port]",
            file=sys.stderr,
        )
        return 2

    SCENARIO = sys.argv[1]
    port = int(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_PORT

    if SCENARIO != "outage":
        for name in ROUTE_TABLE.values():
            path = FIXTURES_ROOT / SCENARIO / name
            if not path.is_file() or path.stat().st_size == 0:
                print(f"error: fixture missing or empty: {path}", file=sys.stderr)
                return 2

    server = ThreadingHTTPServer(("127.0.0.1", port), MockJenkinsHandler)
    print(f"Mock Jenkins listening on 127.0.0.1:{port} (scenario: {SCENARIO})", flush=True)

    def shutdown(signum, frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    try:
        server.serve_forever()
    except (SystemExit, KeyboardInterrupt):
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
