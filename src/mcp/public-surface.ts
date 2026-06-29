export const PUBLIC_MEMORY_MCP_TOOL_NAMES = [
  "memory.add",
  "memory.search",
  "memory.observe",
  "memory.prepare_context",
  "memory.reconstruct_context",
  "memory.explain_evidence_path",
  "memory.commit_outcome",
  "memory.record_feedback",
  "memory.forget",
  "memory.explain_belief",
  "memory.runtime_info",
] as const;

export const PUBLIC_MEMORY_HTTP_ROUTE_REGISTRY = [
  { method: "GET", pathname: "/health", route: "GET /health" },
  { method: "GET", pathname: "/runtime-info", route: "GET /runtime-info" },
  { method: "GET", pathname: "/tools", route: "GET /tools" },
  { method: "GET", pathname: "/status", route: "GET /status" },
  { method: "POST", pathname: "/add", route: "POST /add", toolName: "memory.add" },
  { method: "POST", pathname: "/search", route: "POST /search", toolName: "memory.search" },
  { method: "POST", pathname: "/observe", route: "POST /observe", toolName: "memory.observe" },
  {
    method: "POST",
    pathname: "/prepare",
    route: "POST /prepare",
    toolName: "memory.prepare_context",
  },
  {
    method: "POST",
    pathname: "/reconstruct",
    route: "POST /reconstruct",
    toolName: "memory.reconstruct_context",
  },
  {
    method: "POST",
    pathname: "/explain-path",
    route: "POST /explain-path",
    toolName: "memory.explain_evidence_path",
  },
  {
    method: "POST",
    pathname: "/commit-outcome",
    route: "POST /commit-outcome",
    toolName: "memory.commit_outcome",
  },
  {
    method: "POST",
    pathname: "/feedback",
    route: "POST /feedback",
    toolName: "memory.record_feedback",
  },
  { method: "POST", pathname: "/forget", route: "POST /forget", toolName: "memory.forget" },
  {
    method: "POST",
    pathname: "/explain",
    route: "POST /explain",
    toolName: "memory.explain_belief",
  },
  { method: "POST", pathname: "/mcp/call", route: "POST /mcp/call" },
] as const;

export const PUBLIC_MEMORY_HTTP_ROUTES = PUBLIC_MEMORY_HTTP_ROUTE_REGISTRY.map(
  (route) => route.route,
);

export type PublicMemoryMcpToolName = (typeof PUBLIC_MEMORY_MCP_TOOL_NAMES)[number];
export type PublicMemoryHttpRoute = (typeof PUBLIC_MEMORY_HTTP_ROUTE_REGISTRY)[number]["route"];
export type PublicMemoryHttpRouteEntry = (typeof PUBLIC_MEMORY_HTTP_ROUTE_REGISTRY)[number];
