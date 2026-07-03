from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import json
import time
from typing import Any, Callable, Mapping, Optional, TypedDict
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


JsonObject = dict[str, Any]
Transport = Callable[[Request, float], Any]
Sleep = Callable[[float], None]


class GmosResponse(TypedDict, total=False):
    ok: bool


@dataclass
class GmosClientError(Exception):
    status: int
    code: Optional[str]
    message: str
    body: Any

    def __str__(self) -> str:
        return self.message


CLIENT_METHOD_ROUTES: Mapping[str, str] = {
    "health": "GET /health",
    "healthz": "GET /healthz",
    "runtime_info": "GET /runtime-info",
    "tools": "GET /tools",
    "status": "GET /status",
    "openapi": "GET /openapi.json",
    "profiles_list": "GET /profiles",
    "profiles_create": "POST /profiles",
    "keys_list": "GET /keys",
    "evolution_review": "GET /evolution/review",
    "add": "POST /add",
    "search": "POST /search",
    "observe": "POST /observe",
    "prepare_turn": "POST /prepare",
    "explain_turn": "POST /explain-turn",
    "reconstruct_context": "POST /reconstruct",
    "explain_path": "POST /explain-path",
    "commit_outcome": "POST /commit-outcome",
    "record_feedback": "POST /feedback",
    "maintain": "POST /maintain",
    "forget": "POST /forget",
    "explain": "POST /explain",
    "mcp_call": "POST /mcp/call",
}


def _default_transport(request: Request, timeout: float) -> Any:
    return urlopen(request, timeout=timeout)


def _decode_json(raw: bytes) -> Any:
    if not raw:
        return {}
    return json.loads(raw.decode("utf-8"))


def _headers_get(headers: Any, name: str) -> Optional[str]:
    value = headers.get(name)
    return str(value) if value is not None else None


def _retry_after_seconds(value: Optional[str], limit: float) -> float:
    if not value:
        return 0.0
    try:
        return min(limit, max(0.0, float(value)))
    except ValueError:
        pass
    try:
        parsed = parsedate_to_datetime(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return min(limit, max(0.0, (parsed - datetime.now(timezone.utc)).total_seconds()))
    except (TypeError, ValueError, IndexError, OverflowError):
        return 0.0


def _error_code(payload: Any) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    error = payload.get("error")
    if not isinstance(error, dict):
        return None
    code = error.get("code")
    return code if isinstance(code, str) else None


def _error_message(payload: Any, fallback: str) -> str:
    if not isinstance(payload, dict):
        return fallback
    error = payload.get("error")
    if not isinstance(error, dict):
        return fallback
    message = error.get("message")
    return message if isinstance(message, str) else fallback


class GmosClient:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        timeout: float = 10.0,
        transport: Optional[Transport] = None,
        max_429_retries: int = 1,
        max_retry_after: float = 5.0,
        sleep: Sleep = time.sleep,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        if not self.base_url:
            raise ValueError("base_url is required")
        if not api_key:
            raise ValueError("api_key is required")
        self.api_key = api_key
        self.timeout = timeout
        self.transport = transport or _default_transport
        self.max_429_retries = max_429_retries
        self.max_retry_after = max_retry_after
        self.sleep = sleep

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: Optional[Mapping[str, Any]] = None,
        query: Optional[Mapping[str, Optional[str]]] = None,
    ) -> JsonObject:
        params = {key: value for key, value in (query or {}).items() if value is not None}
        url = f"{self.base_url}{path}"
        if params:
            url = f"{url}?{urlencode(params)}"
        data = None
        headers = {"Authorization": f"Bearer {self.api_key}"}
        if method == "POST":
            headers["Content-Type"] = "application/json"
            data = json.dumps(dict(body or {})).encode("utf-8")
        request = Request(url, data=data, headers=headers, method=method)
        for attempt in range(self.max_429_retries + 1):
            try:
                response = self.transport(request, self.timeout)
                status = int(getattr(response, "status", response.getcode()))
                response_headers = getattr(response, "headers", {})
                payload = _decode_json(response.read())
            except HTTPError as error:
                status = int(error.code)
                response_headers = error.headers
                payload = _decode_json(error.read())
            if status == 429 and attempt < self.max_429_retries:
                self.sleep(_retry_after_seconds(_headers_get(response_headers, "Retry-After"), self.max_retry_after))
                continue
            if status < 200 or status >= 300:
                raise GmosClientError(
                    status=status,
                    code=_error_code(payload),
                    message=_error_message(payload, f"gmOS request failed with status {status}"),
                    body=payload,
                )
            if not isinstance(payload, dict):
                raise GmosClientError(
                    status=status,
                    code="invalid_response",
                    message="gmOS response must be a JSON object",
                    body=payload,
                )
            return payload
        raise AssertionError("unreachable")

    def health(self) -> JsonObject:
        return self._request("GET", "/health")

    def healthz(self) -> JsonObject:
        return self._request("GET", "/healthz")

    def runtime_info(self) -> JsonObject:
        return self._request("GET", "/runtime-info")

    def tools(self) -> JsonObject:
        return self._request("GET", "/tools")

    def status(self, *, profile_id: Optional[str] = None) -> JsonObject:
        return self._request("GET", "/status", query={"profileId": profile_id})

    def openapi(self) -> JsonObject:
        return self._request("GET", "/openapi.json")

    def profiles_list(self) -> JsonObject:
        return self._request("GET", "/profiles")

    def profiles_create(self, profile_id: str) -> JsonObject:
        return self._request("POST", "/profiles", body={"profileId": profile_id})

    def keys_list(self) -> JsonObject:
        return self._request("GET", "/keys")

    def evolution_review(
        self,
        *,
        profile_id: Optional[str] = None,
        failure_kind: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> JsonObject:
        return self._request(
            "GET",
            "/evolution/review",
            query={
                "profileId": profile_id,
                "failureKind": failure_kind,
                "limit": None if limit is None else str(limit),
            },
        )

    def add(self, payload: Mapping[str, Any]) -> JsonObject:
        return self._request("POST", "/add", body=payload)

    def search(self, payload: Mapping[str, Any]) -> JsonObject:
        return self._request("POST", "/search", body=payload)

    def observe(self, payload: Mapping[str, Any]) -> JsonObject:
        return self._request("POST", "/observe", body=payload)

    def prepare_turn(self, payload: Mapping[str, Any]) -> JsonObject:
        return self._request("POST", "/prepare", body=payload)

    def explain_turn(self, payload: Mapping[str, Any]) -> JsonObject:
        return self._request("POST", "/explain-turn", body=payload)

    def reconstruct_context(self, payload: Mapping[str, Any]) -> JsonObject:
        return self._request("POST", "/reconstruct", body=payload)

    def explain_path(self, payload: Mapping[str, Any]) -> JsonObject:
        return self._request("POST", "/explain-path", body=payload)

    def commit_outcome(self, payload: Mapping[str, Any]) -> JsonObject:
        return self._request("POST", "/commit-outcome", body=payload)

    def record_feedback(self, payload: Mapping[str, Any]) -> JsonObject:
        return self._request("POST", "/feedback", body=payload)

    def maintain(self, payload: Mapping[str, Any]) -> JsonObject:
        return self._request("POST", "/maintain", body=payload)

    def forget(self, payload: Mapping[str, Any]) -> JsonObject:
        return self._request("POST", "/forget", body=payload)

    def explain(self, payload: Mapping[str, Any]) -> JsonObject:
        return self._request("POST", "/explain", body=payload)

    def mcp_call(self, tool: str, args: Optional[Mapping[str, Any]] = None) -> JsonObject:
        return self._request("POST", "/mcp/call", body={"tool": tool, "args": dict(args or {})})


__all__ = [
    "CLIENT_METHOD_ROUTES",
    "GmosClient",
    "GmosClientError",
    "GmosResponse",
]
