import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMemoryOS } from "@ghast/memory";
import { createMemoryHttpServer } from "@ghast/memory/http";
import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

const tmp = mkdtempSync(path.join(os.tmpdir(), "gmos-http-adapter-"));
const profileId = "http-example";
const authToken = "local-example-token";
const dbPath = path.join(tmp, "http-example.gmos.db");
const store = createSqliteMemoryStore({ path: dbPath });
const memory = createMemoryOS({ profileId, store });
const server = createMemoryHttpServer({
  memory,
  store,
  profileId,
  host: "ghast",
  authToken,
});

function authHeaders() {
  return { authorization: `Bearer ${authToken}` };
}

async function jsonRequest(pathname, options = {}) {
  const response = await fetch(`${address.url}${pathname}`, {
    method: options.method ?? "GET",
    headers: {
      ...authHeaders(),
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json();
  return { response, body };
}

const address = await server.listen({ port: 0, hostname: "127.0.0.1" });

try {
  const health = await fetch(`${address.url}/health`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.authRequired, true);

  const unauthenticatedRuntimeInfo = await fetch(`${address.url}/runtime-info`);
  assert.equal(unauthenticatedRuntimeInfo.status, 401);

  const runtimeInfo = await jsonRequest("/runtime-info");
  assert.equal(runtimeInfo.response.status, 200);
  assert.equal(runtimeInfo.body.runtimeInfo.schema, "gmos.runtime_info.v1");

  const mcpRuntimeInfo = await jsonRequest("/mcp/call", {
    method: "POST",
    body: {
      tool: "memory.runtime_info",
      args: {},
    },
  });
  assert.equal(mcpRuntimeInfo.response.status, 200);
  assert.equal(mcpRuntimeInfo.body.runtimeInfo.schema, "gmos.runtime_info.v1");

  const observed = await jsonRequest("/observe", {
    method: "POST",
    body: {
      profileId,
      role: "user",
      content: "User opened the HTTP host integration smoke test.",
      createdAt: "2026-06-25T00:00:00.000Z",
    },
  });
  assert.equal(observed.response.status, 200);

  await memory.add({
    profileId,
    kind: "preference",
    content: "HTTP host integration style: include evidence-backed context.",
    createdAt: "2026-06-25T00:00:00.000Z",
  });

  const prepared = await jsonRequest("/prepare", {
    method: "POST",
    body: {
      profileId,
      text: "How should HTTP host integrations prepare context for me?",
      includeEvidence: true,
    },
  });
  assert.equal(prepared.response.status, 200);
  const preparedText = JSON.stringify(prepared.body);
  assert.match(preparedText, /evidence-backed context/);
  assert.equal(preparedText.includes("local-example-token"), false);

  const reconstructed = await jsonRequest("/reconstruct", {
    method: "POST",
    body: {
      profileId,
      text: "How should HTTP host integrations prepare context for me?",
      temporalMode: "current",
    },
  });
  assert.equal(reconstructed.response.status, 200);
  assert.ok(reconstructed.body.reconstructed.paths.length > 0);
  assert.equal(JSON.stringify(reconstructed.body).includes("local-example-token"), false);

  const failedOutcome = await jsonRequest("/commit-outcome", {
    method: "POST",
    body: {
      profileId,
      taskId: "http-example-task",
      objective: "Prepare HTTP integration context",
      status: "failed",
      summary: "HTTP adapter missed the evidence route during integration.",
      failureKind: "controller_route_error",
    },
  });
  assert.equal(failedOutcome.response.status, 200);

  const feedback = await jsonRequest("/feedback", {
    method: "POST",
    body: {
      profileId,
      content: "HTTP adapter should preserve feedback events for release checks.",
      failureKind: "wrong_recall",
    },
  });
  assert.equal(feedback.response.status, 200);

  const status = await jsonRequest(`/status?profileId=${encodeURIComponent(profileId)}`);
  assert.equal(status.response.status, 200);
  assert.equal(status.body.report.storage.schemaVersion, 7);
  assert.equal(status.body.report.hostCompatibility.level, "L4");
  assert.equal(status.body.report.failureSummary.inspectedFailureCount >= 2, true);

  console.log(
    JSON.stringify(
      {
        ok: true,
        url: "[local ephemeral http]",
        dbPath: "[temporary plaintext sqlite]",
        authRequired: healthBody.authRequired,
        unauthenticatedRuntimeInfoStatus: unauthenticatedRuntimeInfo.status,
        runtimeInfoSchema: runtimeInfo.body.runtimeInfo.schema,
        mcpCallRuntimeInfoSchema: mcpRuntimeInfo.body.runtimeInfo.schema,
        preparedHasPreference: preparedText.includes("evidence-backed context"),
        reconstructedPathCount: reconstructed.body.reconstructed.paths.length,
        statusSchemaVersion: status.body.report.storage.schemaVersion,
        hostLevel: status.body.report.hostCompatibility.level,
        failureEvents: status.body.report.failureSummary.inspectedFailureCount,
      },
      null,
      2,
    ),
  );
} finally {
  await server.close();
  await memory.close();
  rmSync(tmp, { recursive: true, force: true });
}
