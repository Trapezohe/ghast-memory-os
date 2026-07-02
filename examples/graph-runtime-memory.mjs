import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMemoryOS } from "@ghast/memory";
import { createMemoryHttpServer } from "@ghast/memory/http";
import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

const tmp = mkdtempSync(path.join(os.tmpdir(), "gmos-graph-runtime-memory-"));
const profileId = "graph-runtime-example";
const authToken = "graph-runtime-local-token";
const dbPath = path.join(tmp, "graph-runtime-memory.db");
const store = createSqliteMemoryStore({ path: dbPath });
const memory = createMemoryOS({ profileId, store });
const server = createMemoryHttpServer({
  memory,
  store,
  profileId,
  host: "ghast",
  authToken,
});
let address;

async function postJson(pathname, body) {
  if (!address) throw new Error("graph runtime HTTP server is not listening");
  const response = await fetch(`${address.url}${pathname}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}

async function preModelNode(state) {
  const response = await postJson("/prepare", {
    profileId,
    text: state.userText,
    includeEvidence: true,
  });
  return {
    ...state,
    prepared: response.prepared,
    usedMemoryIds: response.prepared.memories.map((memoryRecord) => memoryRecord.id),
  };
}

function modelNode(state) {
  const hasMemory = state.prepared.contextBlock.includes("risks first");
  return {
    ...state,
    assistantText: hasMemory
      ? "Risks first, then choose the narrowest owner-approved step."
      : "Use the default planning format.",
  };
}

async function postModelNode(state) {
  await postJson("/observe", {
    profileId,
    role: "assistant",
    content: state.assistantText,
    createdAt: state.createdAt,
  });
  await postJson("/commit-outcome", {
    profileId,
    taskId: state.taskId,
    objective: "Answer graph runtime planning turn",
    status: "completed",
    summary: state.assistantText,
    usedMemoryIds: state.usedMemoryIds,
  });
  return state;
}

async function runGraph(input) {
  const afterPre = await preModelNode(input);
  const afterModel = modelNode(afterPre);
  return postModelNode(afterModel);
}

try {
  address = await server.listen({ port: 0, hostname: "127.0.0.1" });
  const seeded = await memory.add({
    profileId,
    kind: "preference",
    content: "Graph runtime planning style: risks first, then the narrowest next step.",
    confidence: 0.9,
    createdAt: "2026-06-25T00:00:00.000Z",
  });

  const first = await runGraph({
    taskId: "graph-run-1",
    userText: "Plan the graph runtime rollout.",
    createdAt: "2026-06-25T00:01:00.000Z",
  });
  const second = await runGraph({
    taskId: "graph-run-2",
    userText: "Plan another graph runtime rollout.",
    createdAt: "2026-06-25T00:02:00.000Z",
  });

  assert.equal(first.usedMemoryIds.includes(seeded.id), true);
  assert.equal(second.usedMemoryIds.includes(seeded.id), true);
  assert.match(first.assistantText, /Risks first/);
  assert.match(second.assistantText, /Risks first/);

  const advanced = await memory.get({ profileId, id: seeded.id });
  assert.equal(advanced?.recallCount, 2);
  assert.equal((advanced?.reinforcement ?? 0) >= 0.2, true);

  console.log(JSON.stringify({
    ok: true,
    url: "[local ephemeral http]",
    dbPath: "[temporary plaintext sqlite]",
    firstUsedMemoryCount: first.usedMemoryIds.length,
    secondUsedMemoryCount: second.usedMemoryIds.length,
    recallCount: advanced?.recallCount,
    reinforcement: advanced?.reinforcement,
  }, null, 2));
} finally {
  await server.close().catch(() => undefined);
  await memory.close().catch(() => undefined);
  rmSync(tmp, { recursive: true, force: true });
}
