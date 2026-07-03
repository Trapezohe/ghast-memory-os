export const PUBLIC_MEMORY_MCP_TOOL_NAMES = [
  "memory.add",
  "memory.search",
  "memory.observe",
  "memory.prepare_context",
  "memory.explain_turn",
  "memory.reconstruct_context",
  "memory.explain_evidence_path",
  "memory.commit_outcome",
  "memory.record_feedback",
  "memory.maintain",
  "memory.forget",
  "memory.explain_belief",
  "memory.runtime_info",
] as const;

export const PUBLIC_MEMORY_HTTP_ROUTE_REGISTRY = [
  { method: "GET", pathname: "/health", route: "GET /health", scope: "open" },
  { method: "GET", pathname: "/healthz", route: "GET /healthz", scope: "open" },
  { method: "GET", pathname: "/runtime-info", route: "GET /runtime-info", scope: "read" },
  { method: "GET", pathname: "/tools", route: "GET /tools", scope: "read" },
  { method: "GET", pathname: "/status", route: "GET /status", scope: "read" },
  { method: "GET", pathname: "/openapi.json", route: "GET /openapi.json", scope: "read" },
  { method: "GET", pathname: "/profiles", route: "GET /profiles", scope: "admin" },
  { method: "POST", pathname: "/profiles", route: "POST /profiles", scope: "admin" },
  { method: "GET", pathname: "/keys", route: "GET /keys", scope: "admin" },
  {
    method: "POST",
    pathname: "/add",
    route: "POST /add",
    toolName: "memory.add",
    scope: "readwrite",
  },
  {
    method: "POST",
    pathname: "/search",
    route: "POST /search",
    toolName: "memory.search",
    scope: "read",
  },
  {
    method: "POST",
    pathname: "/observe",
    route: "POST /observe",
    toolName: "memory.observe",
    scope: "readwrite",
  },
  {
    method: "POST",
    pathname: "/prepare",
    route: "POST /prepare",
    toolName: "memory.prepare_context",
    scope: "read",
  },
  {
    method: "POST",
    pathname: "/explain-turn",
    route: "POST /explain-turn",
    toolName: "memory.explain_turn",
    scope: "read",
  },
  {
    method: "POST",
    pathname: "/reconstruct",
    route: "POST /reconstruct",
    toolName: "memory.reconstruct_context",
    scope: "read",
  },
  {
    method: "POST",
    pathname: "/explain-path",
    route: "POST /explain-path",
    toolName: "memory.explain_evidence_path",
    scope: "read",
  },
  {
    method: "POST",
    pathname: "/commit-outcome",
    route: "POST /commit-outcome",
    toolName: "memory.commit_outcome",
    scope: "readwrite",
  },
  {
    method: "POST",
    pathname: "/feedback",
    route: "POST /feedback",
    toolName: "memory.record_feedback",
    scope: "readwrite",
  },
  {
    method: "POST",
    pathname: "/maintain",
    route: "POST /maintain",
    toolName: "memory.maintain",
    scope: "readwrite",
  },
  {
    method: "POST",
    pathname: "/forget",
    route: "POST /forget",
    toolName: "memory.forget",
    scope: "readwrite",
  },
  {
    method: "POST",
    pathname: "/explain",
    route: "POST /explain",
    toolName: "memory.explain_belief",
    scope: "read",
  },
  { method: "POST", pathname: "/mcp/call", route: "POST /mcp/call", scope: "read" },
] as const;

export const PUBLIC_MEMORY_HTTP_ROUTES = PUBLIC_MEMORY_HTTP_ROUTE_REGISTRY.map(
  (route) => route.route,
);

export type PublicMemoryMcpToolName = (typeof PUBLIC_MEMORY_MCP_TOOL_NAMES)[number];
export type PublicMemoryHttpRoute = (typeof PUBLIC_MEMORY_HTTP_ROUTE_REGISTRY)[number]["route"];
export type PublicMemoryHttpRouteEntry = (typeof PUBLIC_MEMORY_HTTP_ROUTE_REGISTRY)[number];
