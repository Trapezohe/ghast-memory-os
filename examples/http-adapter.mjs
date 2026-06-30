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

  const observed = await jsonRequest("/observe", {
    method: "POST",
    body: {
      profileId,
      role: "user",
      content: "I prefer HTTP host integrations to include evidence-backed context.",
      createdAt: "2026-06-25T00:00:00.000Z",
    },
  });
  assert.equal(observed.response.status, 200);

  await memory.add({
    profileId,
    kind: "preference",
    content: "I prefer HTTP host integrations to include evidence-backed context.",
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

  const status = await jsonRequest(`/status?profileId=${encodeURIComponent(profileId)}`);
  assert.equal(status.response.status, 200);
  assert.equal(status.body.report.storage.schemaVersion, 7);
  assert.equal(status.body.report.hostCompatibility.level, "L4");

  console.log(
    JSON.stringify(
      {
        ok: true,
        url: "[local ephemeral http]",
        dbPath: "[temporary plaintext sqlite]",
        authRequired: healthBody.authRequired,
        unauthenticatedRuntimeInfoStatus: unauthenticatedRuntimeInfo.status,
        runtimeInfoSchema: runtimeInfo.body.runtimeInfo.schema,
        preparedHasPreference: preparedText.includes("evidence-backed context"),
        statusSchemaVersion: status.body.report.storage.schemaVersion,
        hostLevel: status.body.report.hostCompatibility.level,
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
