from __future__ import annotations

import json
from pathlib import Path
import sys
import unittest
from urllib.parse import parse_qs, urlparse


PYTHON_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PYTHON_ROOT.parent
sys.path.insert(0, str(PYTHON_ROOT))

from gmos_client import CLIENT_METHOD_ROUTES, GmosClient, GmosClientError  # noqa: E402


class FakeResponse:
    def __init__(self, payload, *, status=200, headers=None):
        self.payload = payload
        self.status = status
        self.headers = headers or {}

    def getcode(self):
        return self.status

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class QueueTransport:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def __call__(self, request, timeout):
        self.requests.append((request, timeout))
        if not self.responses:
            raise AssertionError("missing fake response")
        return self.responses.pop(0)


def openapi_routes():
    snapshot = json.loads((REPO_ROOT / "docs" / "openapi.json").read_text())
    routes = []
    for pathname, methods in snapshot["paths"].items():
        for method in methods:
            routes.append(f"{method.upper()} {pathname}")
    return sorted(routes)


class GmosClientTests(unittest.TestCase):
    def test_contract_matches_openapi_snapshot(self):
        self.assertEqual(sorted(CLIENT_METHOD_ROUTES.values()), openapi_routes())
        self.assertNotIn("POST /backup", CLIENT_METHOD_ROUTES.values())
        self.assertNotIn("POST /restore", CLIENT_METHOD_ROUTES.values())

    def test_request_shape_for_every_route(self):
        transport = QueueTransport([FakeResponse({"ok": True}) for _ in CLIENT_METHOD_ROUTES])
        client = GmosClient("http://gmos.test/", "client-key", transport=transport)
        cases = [
            ("health", lambda: client.health(), None, {}),
            ("healthz", lambda: client.healthz(), None, {}),
            ("runtime_info", lambda: client.runtime_info(), None, {}),
            ("tools", lambda: client.tools(), None, {}),
            ("status", lambda: client.status(profile_id="client"), None, {"profileId": ["client"]}),
            ("openapi", lambda: client.openapi(), None, {}),
            ("profiles_list", lambda: client.profiles_list(), None, {}),
            ("profiles_create", lambda: client.profiles_create("client"), {"profileId": "client"}, {}),
            ("keys_list", lambda: client.keys_list(), None, {}),
            (
                "add",
                lambda: client.add({"profileId": "client", "kind": "fact", "content": "Client route contract."}),
                {"profileId": "client", "kind": "fact", "content": "Client route contract."},
                {},
            ),
            ("search", lambda: client.search({"profileId": "client", "query": "contract"}), {"profileId": "client", "query": "contract"}, {}),
            ("observe", lambda: client.observe({"profileId": "client", "content": "observed"}), {"profileId": "client", "content": "observed"}, {}),
            ("prepare_turn", lambda: client.prepare_turn({"profileId": "client", "text": "contract"}), {"profileId": "client", "text": "contract"}, {}),
            ("explain_turn", lambda: client.explain_turn({"profileId": "client", "text": "contract"}), {"profileId": "client", "text": "contract"}, {}),
            (
                "reconstruct_context",
                lambda: client.reconstruct_context({"profileId": "client", "text": "contract"}),
                {"profileId": "client", "text": "contract"},
                {},
            ),
            ("explain_path", lambda: client.explain_path({"profileId": "client", "text": "contract"}), {"profileId": "client", "text": "contract"}, {}),
            (
                "commit_outcome",
                lambda: client.commit_outcome({"profileId": "client", "objective": "ship", "status": "completed"}),
                {"profileId": "client", "objective": "ship", "status": "completed"},
                {},
            ),
            ("record_feedback", lambda: client.record_feedback({"profileId": "client", "content": "good"}), {"profileId": "client", "content": "good"}, {}),
            ("maintain", lambda: client.maintain({"profileId": "client", "dryRun": True}), {"profileId": "client", "dryRun": True}, {}),
            ("forget", lambda: client.forget({"profileId": "client", "query": "contract"}), {"profileId": "client", "query": "contract"}, {}),
            ("explain", lambda: client.explain({"profileId": "client", "id": "memory_1"}), {"profileId": "client", "id": "memory_1"}, {}),
            ("mcp_call", lambda: client.mcp_call("memory.runtime_info", {}), {"tool": "memory.runtime_info", "args": {}}, {}),
        ]
        for name, call, body, query in cases:
            with self.subTest(name=name):
                call()
                request, timeout = transport.requests[-1]
                method, pathname = CLIENT_METHOD_ROUTES[name].split(" ")
                parsed = urlparse(request.full_url)
                self.assertEqual(request.get_method(), method)
                self.assertEqual(parsed.path, pathname)
                self.assertEqual(parse_qs(parsed.query), query)
                headers = {key.lower(): value for key, value in request.header_items()}
                self.assertEqual(headers["authorization"], "Bearer client-key")
                self.assertEqual(timeout, 10.0)
                if body is None:
                    self.assertIsNone(request.data)
                else:
                    self.assertEqual(json.loads(request.data.decode("utf-8")), body)
                    self.assertEqual(headers["content-type"], "application/json")

    def test_429_retries_once_with_bounded_retry_after(self):
        sleeps = []
        transport = QueueTransport([
            FakeResponse({"ok": False}, status=429, headers={"Retry-After": "10"}),
            FakeResponse({"ok": True}),
        ])
        client = GmosClient(
            "http://gmos.test",
            "client-key",
            transport=transport,
            max_retry_after=0.05,
            sleep=sleeps.append,
        )
        self.assertEqual(client.runtime_info(), {"ok": True})
        self.assertEqual(len(transport.requests), 2)
        self.assertEqual(sleeps, [0.05])

    def test_error_mapping(self):
        transport = QueueTransport([
            FakeResponse(
                {"ok": False, "error": {"code": "forbidden", "message": "readwrite scope required"}},
                status=403,
            )
        ])
        client = GmosClient("http://gmos.test", "client-key", transport=transport)
        with self.assertRaises(GmosClientError) as raised:
            client.observe({"profileId": "client", "content": "blocked"})
        self.assertEqual(raised.exception.status, 403)
        self.assertEqual(raised.exception.code, "forbidden")
        self.assertEqual(str(raised.exception), "readwrite scope required")


if __name__ == "__main__":
    unittest.main()
