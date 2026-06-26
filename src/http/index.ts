import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  createMemoryStatusReport,
  type DiagnosticsStore,
  type MemoryStatusReportInput,
} from "../diagnostics/index.js";
import type { MemoryOS } from "../kernel/types.js";
import { createMemoryMcpServer } from "../mcp/index.js";

export interface MemoryHttpServerOptions {
  memory: MemoryOS;
  store?: DiagnosticsStore | undefined;
  profileId?: string | undefined;
  host?: MemoryStatusReportInput["host"] | undefined;
  maxBodyBytes?: number | undefined;
  authToken?: string | undefined;
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

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

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

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
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

function routeToTool(pathname: string): string | null {
  if (pathname === "/add") return "memory.add";
  if (pathname === "/search") return "memory.search";
  if (pathname === "/observe") return "memory.observe";
  if (pathname === "/prepare") return "memory.prepare_context";
  if (pathname === "/commit-outcome") return "memory.commit_outcome";
  if (pathname === "/feedback") return "memory.record_feedback";
  if (pathname === "/forget") return "memory.forget";
  if (pathname === "/explain") return "memory.explain_belief";
  return null;
}

export function createMemoryHttpServer(
  options: MemoryHttpServerOptions,
): MemoryHttpServerHandle {
  const mcp = createMemoryMcpServer(options.memory);
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const authToken = normalizeAuthToken(options.authToken);

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      let url: URL;
      try {
        url = new URL(request.url ?? "/", "http://127.0.0.1");
      } catch {
        throw new HttpError(400, "invalid_url", "request url is invalid");
      }
      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, {
          ok: true,
          framework: "ghast-memory-os",
          status: "ready",
          authRequired: authToken !== undefined,
        });
        return;
      }

      assertAuthorized(request, authToken);

      if (request.method === "GET" && url.pathname === "/tools") {
        writeJson(response, 200, ok({ ok: true, tools: mcp.listTools() }));
        return;
      }

      if (request.method === "GET" && url.pathname === "/status") {
        if (!options.store) {
          throw new HttpError(503, "diagnostics_store_unavailable", "status requires a store");
        }
        const report = await createMemoryStatusReport({
          store: options.store,
          profileId: optionalString(url.searchParams, "profileId") ?? options.profileId,
          host: options.host,
        });
        writeJson(response, 200, ok({ ok: true, report }));
        return;
      }

      const tool = routeToTool(url.pathname);
      const isKnownPostRoute = url.pathname === "/mcp/call" || tool !== null;
      if (request.method !== "POST") {
        throw isKnownPostRoute
          ? new HttpError(405, "method_not_allowed", "method is not allowed")
          : new HttpError(404, "not_found", "route not found");
      }

      if (url.pathname === "/mcp/call") {
        const body = assertObjectBody(await readJsonBody(request, maxBodyBytes));
        const tool = body.tool;
        if (typeof tool !== "string" || tool.trim().length === 0) {
          throw new HttpError(400, "invalid_tool", "tool must be a non-empty string");
        }
        const result = await mcp.callTool(tool, body.args ?? {});
        writeJson(response, result.isError ? 400 : 200, result.structuredContent);
        return;
      }

      if (!tool) {
        throw new HttpError(404, "not_found", "route not found");
      }
      const result = await mcp.callTool(tool, assertObjectBody(await readJsonBody(request, maxBodyBytes)));
      writeJson(response, result.isError ? 400 : 200, result.structuredContent);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      writeJson(
        response,
        status,
        errorPayload(error),
        status === 401 ? { "www-authenticate": 'Bearer realm="gmos-http"' } : {},
      );
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
