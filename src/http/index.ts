import { timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createMemoryStatusReport,
  type DiagnosticsStore,
  type MemoryStatusReportInput,
} from "../diagnostics/index.js";
import { createEvolutionControlPlane, type FailureReviewStore } from "../evolution/index.js";
import { readGmosPackageInfo } from "../kernel/package-info.js";
import type { FailureKind, MemoryOS } from "../kernel/types.js";
import {
  createMemoryMcpServer,
  PUBLIC_MEMORY_HTTP_ROUTE_REGISTRY,
  PUBLIC_MEMORY_HTTP_ROUTES,
  type PublicMemoryMcpToolName,
} from "../mcp/index.js";
import { getGmosRuntimeInfo } from "../runtime-info.js";
import { createMemoryHttpOpenApiDocument } from "./openapi.js";
import type {
  ListSqliteServiceAuditInput,
  SqliteServiceApiKey,
  SqliteServiceApiKeyProfiles,
  SqliteServiceAuditInput,
  SqliteServiceAuditRow,
  SqliteServiceProfileSummary,
} from "../store/sqlite/index.js";

export { PUBLIC_MEMORY_HTTP_ROUTE_REGISTRY, PUBLIC_MEMORY_HTTP_ROUTES };
export { createMemoryHttpOpenApiDocument };

export interface MemoryHttpServerOptions {
  memory: MemoryOS;
  store?: MemoryHttpServiceStore | undefined;
  profileId?: string | undefined;
  host?: MemoryStatusReportInput["host"] | undefined;
  maxBodyBytes?: number | undefined;
  authToken?: string | undefined;
  scopedKeys?: boolean | undefined;
  corsOrigins?: string[] | undefined;
  rateLimitRequestsPerMinute?: number | undefined;
  auditRetentionDays?: number | undefined;
  console?: boolean | undefined;
}

export interface MemoryHttpListenOptions {
  port?: number | undefined;
  hostname?: string | undefined;
}

export interface MemoryHttpListenResult {
  hostname: string;
  port: number;
  url: string;
}

export interface MemoryHttpServerHandle {
  server: Server;
  listen(options?: MemoryHttpListenOptions): Promise<MemoryHttpListenResult>;
  close(): Promise<void>;
}

export interface MemoryHttpServiceStore extends DiagnosticsStore {
  authenticateServiceApiKey?(secret: string): SqliteServiceApiKey | null;
  serviceApiKeyCount?(): number;
  recordServiceAudit?(input: SqliteServiceAuditInput): void;
  listServiceAuditRows?(input?: ListSqliteServiceAuditInput): SqliteServiceAuditRow[];
  pruneServiceAuditRows?(retentionDays: number): number;
  listServiceProfiles?(): SqliteServiceProfileSummary[];
  ensureServiceProfile?(profileId: string): SqliteServiceProfileSummary;
  listServiceApiKeys?(): SqliteServiceApiKey[];
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_RATE_LIMIT_REQUESTS_PER_MINUTE = 600;
const STATUS_QUERY_PARAMS = new Set(["profileId"]);
const PROFILE_QUERY_PARAMS = new Set<string>();
const EVOLUTION_REVIEW_QUERY_PARAMS = new Set(["profileId", "failureKind", "limit"]);
const FAILURE_KINDS = new Set<FailureKind>([
  "missed_recall",
  "wrong_recall",
  "privacy_leak",
  "forget_failure",
  "controller_route_error",
  "action_policy_missing",
  "task_failure",
]);
const CONSOLE_ROOT_PATH = "/console";
const CONSOLE_DIRECTORY = fileURLToPath(new URL("../../console/", import.meta.url));
const CONSOLE_SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};
const CONSOLE_CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};
const TOOL_SCOPES: Record<PublicMemoryMcpToolName, "read" | "readwrite" | "admin"> = {
  "memory.runtime_info": "read",
  "memory.add": "readwrite",
  "memory.search": "read",
  "memory.observe": "readwrite",
  "memory.prepare_context": "read",
  "memory.explain_turn": "read",
  "memory.reconstruct_context": "read",
  "memory.explain_evidence_path": "read",
  "memory.commit_outcome": "readwrite",
  "memory.record_feedback": "readwrite",
  "memory.maintain": "readwrite",
  "memory.forget": "readwrite",
  "memory.explain_belief": "read",
};

type HttpScope = "read" | "readwrite" | "admin";

interface AuthContext {
  keyId?: string | undefined;
  scope: HttpScope;
  profiles: SqliteServiceApiKeyProfiles;
  mode: "none" | "legacy" | "scoped";
}

interface RateBucket {
  windowStartedAt: number;
  count: number;
}

function writeJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(`${body}\n`);
}

function readJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.byteLength;
      if (bytes > maxBodyBytes) {
        fail(new HttpError(413, "request_body_too_large", "request body is too large"));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", fail);
    request.on("end", () => {
      if (settled) return;
      settled = true;
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "invalid_json", "request body must be valid JSON"));
      }
    });
  });
}

function assertObjectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "invalid_body", "request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function optionalString(searchParams: URLSearchParams, key: string): string | undefined {
  const raw = searchParams.get(key);
  if (raw === null || raw.trim().length === 0) return undefined;
  return raw;
}

function optionalPositiveInteger(searchParams: URLSearchParams, key: string): number | undefined {
  const raw = optionalString(searchParams, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new HttpError(400, "invalid_query", `${key} must be a positive integer`);
  }
  return value;
}

function optionalFailureKind(searchParams: URLSearchParams): FailureKind | undefined {
  const raw = optionalString(searchParams, "failureKind");
  if (raw === undefined) return undefined;
  if (!FAILURE_KINDS.has(raw as FailureKind)) {
    throw new HttpError(400, "invalid_query", "failureKind is not supported");
  }
  return raw as FailureKind;
}

function assertAllowedSearchParams(
  searchParams: URLSearchParams,
  allowed: ReadonlySet<string>,
  route: string,
): void {
  const unsupported = [...new Set([...searchParams.keys()].filter((key) => !allowed.has(key)))];
  if (unsupported.length > 0) {
    throw new HttpError(
      400,
      "unsupported_query",
      `${route} contains unsupported query parameters: ${unsupported.join(", ")}`,
    );
  }
}

function ok(payload: Record<string, unknown> = { ok: true }): Record<string, unknown> {
  return payload;
}

function normalizeAuthToken(authToken: string | undefined): string | undefined {
  if (authToken === undefined) return undefined;
  if (authToken.trim().length === 0) {
    throw new Error("gmOS HTTP authToken must not be empty");
  }
  return authToken;
}

function bearerTokenMatches(headerValue: string | undefined, expectedToken: string): boolean {
  if (!headerValue?.startsWith("Bearer ")) return false;
  const actualToken = headerValue.slice("Bearer ".length);
  const actual = Buffer.from(actualToken, "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  if (actual.byteLength !== expected.byteLength) return false;
  return timingSafeEqual(actual, expected);
}

function assertAuthorized(request: IncomingMessage, authToken: string | undefined): void {
  if (!authToken) return;
  const authorization = request.headers.authorization;
  if (!bearerTokenMatches(
    Array.isArray(authorization) ? authorization[0] : authorization,
    authToken,
  )) {
    throw new HttpError(401, "unauthorized", "valid bearer token required");
  }
}

function bearerTokenFromRequest(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length);
  return token.length > 0 ? token : null;
}

function scopeRank(scope: HttpScope): number {
  if (scope === "admin") return 3;
  if (scope === "readwrite") return 2;
  return 1;
}

function assertScope(auth: AuthContext, required: HttpScope): void {
  if (scopeRank(auth.scope) < scopeRank(required)) {
    throw new HttpError(403, "forbidden", `${required} scope required`);
  }
}

function profilesInclude(profiles: SqliteServiceApiKeyProfiles, profileId: string): boolean {
  return profiles === "*" || profiles.includes(profileId);
}

function assertProfileAllowed(auth: AuthContext, profileId: string | undefined): void {
  if (auth.mode !== "scoped") return;
  if (auth.profiles === "*") return;
  if (!profileId) throw new HttpError(400, "profile_required", "profileId is required");
  if (!profilesInclude(auth.profiles, profileId)) {
    throw new HttpError(403, "profile_forbidden", "profile is not allowed for this key");
  }
}

function profileIdFromRecord(
  body: Record<string, unknown>,
  fallback: string | undefined,
): string | undefined {
  const value = body.profileId;
  if (value === undefined) return fallback;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function profileIdFromMcpCall(
  body: Record<string, unknown>,
  fallback: string | undefined,
): string | undefined {
  const args = body.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) return fallback;
  return profileIdFromRecord(args as Record<string, unknown>, fallback);
}

function requireServiceStore(
  store: MemoryHttpServiceStore | undefined,
  method: keyof MemoryHttpServiceStore,
): MemoryHttpServiceStore {
  if (!store || typeof store[method] !== "function") {
    throw new HttpError(500, "service_store_unavailable", "service store is unavailable");
  }
  return store;
}

function authenticateScopedKey(
  request: IncomingMessage,
  store: MemoryHttpServiceStore | undefined,
): AuthContext {
  const serviceStore = requireServiceStore(store, "authenticateServiceApiKey");
  const token = bearerTokenFromRequest(request);
  if (!token) throw new HttpError(401, "unauthorized", "valid bearer token required");
  const key = serviceStore.authenticateServiceApiKey!(token);
  if (!key) throw new HttpError(401, "unauthorized", "valid bearer token required");
  return {
    keyId: key.keyId,
    scope: key.scope,
    profiles: key.profiles,
    mode: "scoped",
  };
}

function authenticateRequest(
  request: IncomingMessage,
  options: MemoryHttpServerOptions,
  authToken: string | undefined,
): AuthContext {
  if (options.scopedKeys) return authenticateScopedKey(request, options.store);
  assertAuthorized(request, authToken);
  return {
    keyId: authToken ? "legacy" : undefined,
    scope: "readwrite",
    profiles: "*",
    mode: authToken ? "legacy" : "none",
  };
}

function routeRequiredScope(
  route: (typeof PUBLIC_MEMORY_HTTP_ROUTE_REGISTRY)[number],
): HttpScope | null {
  return route.scope === "open" ? null : route.scope;
}

function toolScope(tool: unknown): HttpScope {
  if (typeof tool !== "string") return "read";
  return TOOL_SCOPES[tool as PublicMemoryMcpToolName] ?? "read";
}

function allowedCorsOrigins(input: string[] | undefined): Set<string> {
  const origins = new Set<string>();
  for (const origin of input ?? []) {
    const normalized = origin.trim();
    if (!normalized) continue;
    if (normalized === "*") throw new Error("gmOS CORS origin must not be '*'");
    origins.add(normalized);
  }
  return origins;
}

function requestOrigin(request: IncomingMessage): string | undefined {
  const origin = request.headers.origin;
  return Array.isArray(origin) ? origin[0] : origin;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "MemoryHttpError";
  }
}

function errorPayload(error: unknown): { ok: false; error: { code: string; message: string } } {
  if (error instanceof HttpError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
      },
    };
  }
  return {
    ok: false,
    error: {
      code: "internal_server_error",
      message: "gmOS HTTP request failed",
    },
  };
}

function routeFor(
  method: string | undefined,
  pathname: string,
): (typeof PUBLIC_MEMORY_HTTP_ROUTE_REGISTRY)[number] | null {
  return (
    PUBLIC_MEMORY_HTTP_ROUTE_REGISTRY.find(
      (route) => route.method === method && route.pathname === pathname,
    ) ?? null
  );
}

function pathExists(pathname: string): boolean {
  return PUBLIC_MEMORY_HTTP_ROUTE_REGISTRY.some((route) => route.pathname === pathname);
}

function rawRequestPathname(rawUrl: string | undefined): string {
  const value = rawUrl ?? "/";
  const pathOnly = value.split("#", 1)[0]!.split("?", 1)[0]!;
  if (/^https?:\/\//iu.test(pathOnly)) {
    try {
      return new URL(pathOnly).pathname;
    } catch {
      return pathOnly;
    }
  }
  return pathOnly;
}

function isConsolePath(rawPathname: string): boolean {
  return rawPathname === CONSOLE_ROOT_PATH || rawPathname.startsWith(`${CONSOLE_ROOT_PATH}/`);
}

function consoleRelativePath(rawPathname: string): string {
  const rawRelative =
    rawPathname === CONSOLE_ROOT_PATH ? "/" : rawPathname.slice(CONSOLE_ROOT_PATH.length);
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawRelative);
  } catch {
    throw new HttpError(400, "invalid_url", "console path is invalid");
  }
  if (
    decoded.includes("\0") ||
    decoded.includes("\\") ||
    decoded.split("/").some((part) => part === "..")
  ) {
    throw new HttpError(404, "not_found", "console asset not found");
  }
  const relative = decoded === "/" || decoded === "" ? "index.html" : decoded.replace(/^\/+/u, "");
  return relative.endsWith("/") ? `${relative}index.html` : relative;
}

function serveConsoleAsset(
  request: IncomingMessage,
  response: ServerResponse,
  rawPathname: string,
): number {
  if (request.method !== "GET") {
    throw new HttpError(405, "method_not_allowed", "method is not allowed");
  }
  const root = path.resolve(CONSOLE_DIRECTORY);
  const candidate = path.resolve(root, consoleRelativePath(rawPathname));
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new HttpError(404, "not_found", "console asset not found");
  }
  let status;
  try {
    status = statSync(candidate);
  } catch {
    throw new HttpError(404, "not_found", "console asset not found");
  }
  if (!status.isFile()) {
    throw new HttpError(404, "not_found", "console asset not found");
  }
  response.writeHead(200, {
    ...CONSOLE_SECURITY_HEADERS,
    "content-type": CONSOLE_CONTENT_TYPES[path.extname(candidate)] ?? "application/octet-stream",
  });
  response.end(readFileSync(candidate));
  return 200;
}

export function createMemoryHttpServer(
  options: MemoryHttpServerOptions,
): MemoryHttpServerHandle {
  const mcp = createMemoryMcpServer(options.memory);
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const authToken = normalizeAuthToken(options.authToken);
  const corsOrigins = allowedCorsOrigins(options.corsOrigins);
  const rateLimit = options.rateLimitRequestsPerMinute ?? DEFAULT_RATE_LIMIT_REQUESTS_PER_MINUTE;
  const rateBuckets = new Map<string, RateBucket>();
  if (options.auditRetentionDays !== undefined) {
    requireServiceStore(options.store, "pruneServiceAuditRows")
      .pruneServiceAuditRows!(options.auditRetentionDays);
  }

  function corsHeaders(request: IncomingMessage): Record<string, string> {
    const origin = requestOrigin(request);
    if (!origin || !corsOrigins.has(origin)) return {};
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      vary: "Origin",
    };
  }

  function sendJson(
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    payload: unknown,
    headers: Record<string, string> = {},
  ): void {
    writeJson(response, status, payload, { ...corsHeaders(request), ...headers });
  }

  function applyRateLimit(auth: AuthContext): void {
    if (!auth.keyId || rateLimit <= 0) return;
    const now = Date.now();
    const bucket = rateBuckets.get(auth.keyId);
    if (!bucket || now - bucket.windowStartedAt >= 60_000) {
      rateBuckets.set(auth.keyId, { windowStartedAt: now, count: 1 });
      return;
    }
    bucket.count += 1;
    if (bucket.count > rateLimit) {
      const retryAfter = Math.max(1, Math.ceil((60_000 - (now - bucket.windowStartedAt)) / 1000));
      throw new HttpError(
        429,
        "rate_limited",
        "rate limit exceeded",
        { "retry-after": String(retryAfter) },
      );
    }
  }

  function audit(input: {
    auth: AuthContext | null;
    route: string;
    method: string;
    profileId: string | undefined;
    statusCode: number;
    startedAt: number;
  }): void {
    if (!input.auth?.keyId || !options.store?.recordServiceAudit) return;
    options.store.recordServiceAudit({
      keyId: input.auth.keyId,
      route: input.route,
      method: input.method,
      profileId: input.profileId ?? "service",
      statusCode: input.statusCode,
      timestamp: new Date(input.startedAt).toISOString(),
      durationMs: Math.max(0, Date.now() - input.startedAt),
    });
  }

  function logRequest(input: {
    auth: AuthContext | null;
    route: string;
    method: string;
    profileId: string | undefined;
    statusCode: number;
    startedAt: number;
  }): void {
    console.error(
      JSON.stringify({
        service: "gmos-http",
        method: input.method,
        route: input.route,
        profileId: input.profileId ?? "service",
        keyId: input.auth?.keyId ?? "anonymous",
        statusCode: input.statusCode,
        durationMs: Math.max(0, Date.now() - input.startedAt),
      }),
    );
  }

  function filteredProfiles(auth: AuthContext): SqliteServiceProfileSummary[] {
    const profiles = requireServiceStore(options.store, "listServiceProfiles")
      .listServiceProfiles!();
    if (auth.mode !== "scoped" || auth.profiles === "*") return profiles;
    return profiles.filter((profile) => auth.profiles.includes(profile.profileId));
  }

  function filteredKeys(auth: AuthContext): SqliteServiceApiKey[] {
    const keys = requireServiceStore(options.store, "listServiceApiKeys")
      .listServiceApiKeys!();
    if (auth.mode !== "scoped" || auth.profiles === "*") return keys;
    return keys.filter((key) => {
      if (key.profiles === "*") return true;
      return key.profiles.some((profileId) => auth.profiles.includes(profileId));
    });
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const startedAt = Date.now();
    let auth: AuthContext | null = null;
    let auditRoute = `${request.method ?? "UNKNOWN"} ${request.url ?? "/"}`;
    let auditProfileId = options.profileId;
    let statusCode = 500;
    let consoleRequest = false;
    try {
      let url: URL;
      try {
        url = new URL(request.url ?? "/", "http://127.0.0.1");
      } catch {
        throw new HttpError(400, "invalid_url", "request url is invalid");
      }
      const rawPathname = rawRequestPathname(request.url);
      if (isConsolePath(rawPathname)) {
        consoleRequest = true;
        auditRoute = `${request.method ?? "UNKNOWN"} /console/*`;
        if (options.console !== true) {
          throw new HttpError(404, "not_found", "console is not enabled");
        }
        statusCode = serveConsoleAsset(request, response, rawPathname);
        return;
      }
      const route = routeFor(request.method, url.pathname);
      auditRoute = route?.route ?? `${request.method ?? "UNKNOWN"} ${url.pathname}`;

      if (request.method === "OPTIONS") {
        response.writeHead(204, corsHeaders(request));
        response.end();
        statusCode = 204;
        return;
      }

      if (route?.route === "GET /health") {
        statusCode = 200;
        sendJson(request, response, 200, {
          ok: true,
          framework: "ghast-memory-os",
          status: "ready",
          authRequired: options.scopedKeys === true || authToken !== undefined,
        });
        return;
      }

      if (route?.route === "GET /healthz") {
        statusCode = 200;
        sendJson(request, response, 200, {
          ok: true,
          version: readGmosPackageInfo().version,
        });
        return;
      }

      auth = authenticateRequest(request, options, authToken);
      applyRateLimit(auth);

      if (!route) {
        throw pathExists(url.pathname)
          ? new HttpError(405, "method_not_allowed", "method is not allowed")
          : new HttpError(404, "not_found", "route not found");
      }

      const requiredScope = routeRequiredScope(route);
      if (requiredScope) assertScope(auth, requiredScope);

      if (route.route === "GET /tools") {
        assertProfileAllowed(auth, options.profileId);
        statusCode = 200;
        sendJson(request, response, 200, ok({ ok: true, tools: mcp.listTools() }));
        return;
      }

      if (route.route === "GET /runtime-info") {
        assertProfileAllowed(auth, options.profileId);
        statusCode = 200;
        sendJson(request, response, 200, ok({ ok: true, runtimeInfo: getGmosRuntimeInfo() }));
        return;
      }

      if (route.route === "GET /openapi.json") {
        assertProfileAllowed(auth, options.profileId);
        statusCode = 200;
        sendJson(request, response, 200, createMemoryHttpOpenApiDocument());
        return;
      }

      if (route.route === "GET /status") {
        assertAllowedSearchParams(url.searchParams, STATUS_QUERY_PARAMS, "GET /status");
        auditProfileId = optionalString(url.searchParams, "profileId") ?? options.profileId;
        assertProfileAllowed(auth, auditProfileId);
        if (!options.store) {
          throw new HttpError(503, "diagnostics_store_unavailable", "status requires a store");
        }
        const report = await createMemoryStatusReport({
          store: options.store,
          profileId: auditProfileId,
          host: options.host,
        });
        statusCode = 200;
        sendJson(request, response, 200, ok({ ok: true, report }));
        return;
      }

      if (route.route === "GET /profiles") {
        assertAllowedSearchParams(url.searchParams, PROFILE_QUERY_PARAMS, "GET /profiles");
        statusCode = 200;
        sendJson(request, response, 200, ok({ ok: true, profiles: filteredProfiles(auth) }));
        return;
      }

      if (route.route === "POST /profiles") {
        const body = assertObjectBody(await readJsonBody(request, maxBodyBytes));
        const unsupported = Object.keys(body).filter((key) => key !== "profileId");
        if (unsupported.length > 0) {
          throw new HttpError(
            400,
            "unsupported_fields",
            `POST /profiles contains unsupported fields: ${unsupported.join(", ")}`,
          );
        }
        const profileId = profileIdFromRecord(body, undefined);
        if (!profileId) throw new HttpError(400, "invalid_profile", "profileId must be a non-empty string");
        auditProfileId = profileId;
        assertProfileAllowed(auth, profileId);
        const profile = requireServiceStore(options.store, "ensureServiceProfile")
          .ensureServiceProfile!(profileId);
        statusCode = 200;
        sendJson(request, response, 200, ok({ ok: true, profile }));
        return;
      }

      if (route.route === "GET /keys") {
        assertAllowedSearchParams(url.searchParams, PROFILE_QUERY_PARAMS, "GET /keys");
        statusCode = 200;
        sendJson(request, response, 200, ok({ ok: true, keys: filteredKeys(auth) }));
        return;
      }

      if (route.route === "GET /evolution/review") {
        assertAllowedSearchParams(
          url.searchParams,
          EVOLUTION_REVIEW_QUERY_PARAMS,
          "GET /evolution/review",
        );
        auditProfileId = optionalString(url.searchParams, "profileId") ?? options.profileId;
        assertProfileAllowed(auth, auditProfileId);
        const evolutionStore = requireServiceStore(options.store, "listFailures") as FailureReviewStore;
        const report = await createEvolutionControlPlane({
          store: evolutionStore,
          profileId: auditProfileId,
        }).reviewFailures({
          profileId: auditProfileId,
          failureKind: optionalFailureKind(url.searchParams),
          limit: optionalPositiveInteger(url.searchParams, "limit"),
        });
        statusCode = 200;
        sendJson(request, response, 200, ok({ ok: true, report }));
        return;
      }

      if (route.route === "POST /mcp/call") {
        const body = assertObjectBody(await readJsonBody(request, maxBodyBytes));
        const unsupported = Object.keys(body).filter((key) => key !== "tool" && key !== "args");
        if (unsupported.length > 0) {
          throw new HttpError(
            400,
            "unsupported_fields",
            `POST /mcp/call contains unsupported fields: ${unsupported.join(", ")}`,
          );
        }
        const tool = body.tool;
        if (typeof tool !== "string" || tool.trim().length === 0) {
          throw new HttpError(400, "invalid_tool", "tool must be a non-empty string");
        }
        assertScope(auth, toolScope(tool));
        auditProfileId = profileIdFromMcpCall(body, options.profileId);
        assertProfileAllowed(auth, auditProfileId);
        const result = await mcp.callTool(tool, body.args ?? {});
        statusCode = result.isError ? 400 : 200;
        sendJson(request, response, statusCode, result.structuredContent);
        return;
      }

      if (!("toolName" in route)) {
        throw new HttpError(500, "route_not_implemented", "route has no implementation");
      }
      const body = assertObjectBody(await readJsonBody(request, maxBodyBytes));
      auditProfileId = profileIdFromRecord(body, options.profileId);
      assertProfileAllowed(auth, auditProfileId);
      const result = await mcp.callTool(
        route.toolName,
        body,
      );
      statusCode = result.isError ? 400 : 200;
      sendJson(request, response, statusCode, result.structuredContent);
    } catch (error) {
      statusCode = error instanceof HttpError ? error.status : 500;
      sendJson(
        request,
        response,
        statusCode,
        errorPayload(error),
        {
          ...(consoleRequest ? CONSOLE_SECURITY_HEADERS : {}),
          ...(statusCode === 401 ? { "www-authenticate": 'Bearer realm="gmos-http"' } : {}),
          ...(error instanceof HttpError ? error.headers : {}),
        },
      );
    } finally {
      audit({
        auth,
        route: auditRoute,
        method: request.method ?? "UNKNOWN",
        profileId: auditProfileId,
        statusCode,
        startedAt,
      });
      logRequest({
        auth,
        route: auditRoute,
        method: request.method ?? "UNKNOWN",
        profileId: auditProfileId,
        statusCode,
        startedAt,
      });
    }
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) {
        writeJson(response, 500, errorPayload(new Error("unhandled http failure")));
      } else {
        response.end();
      }
    });
  });

  return {
    server,
    listen(input: MemoryHttpListenOptions = {}) {
      const port = input.port ?? 0;
      const hostname = input.hostname ?? "127.0.0.1";
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, hostname, () => {
          server.off("error", reject);
          const address = server.address() as AddressInfo;
          resolve({
            hostname,
            port: address.port,
            url: `http://${hostname}:${address.port}`,
          });
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

export async function serveMemoryHttp(
  options: MemoryHttpServerOptions & MemoryHttpListenOptions,
): Promise<MemoryHttpServerHandle & { address: MemoryHttpListenResult }> {
  const handle = createMemoryHttpServer(options);
  const address = await handle.listen({
    port: options.port,
    hostname: options.hostname,
  });
  return {
    ...handle,
    address,
  };
}
