import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMemoryOS } from "../src/index.js";
import { runMemoryGym } from "../src/gym/index.js";
import { createSqliteMemoryStore } from "../src/store/sqlite/index.js";
import { classifyHostCompatibility } from "../src/host/index.js";
import { createEvolutionControlPlane } from "../src/evolution/index.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "gmos-sdk-test-"));
const dbPath = path.join(tmp, "test.db");
const store = createSqliteMemoryStore({ path: dbPath });
const memory = createMemoryOS({ profileId: "test", store });

await memory.observe({
  type: "conversation.message",
  profileId: "test",
  role: "user",
  content: "我喜欢直接、简洁的中文回答。",
  createdAt: "2026-06-25T00:00:00.000Z",
});

const prepared = await memory.prepareTurn({
  profileId: "test",
  messages: [{ role: "user", content: "你应该怎么回答我？" }],
  includeEvidence: true,
});
assert.match(prepared.contextBlock, /简洁的中文回答/);
assert.equal(prepared.evidence.length, 1);

await memory.observe({
  type: "conversation.message",
  profileId: "test",
  role: "user",
  content: "PERSON: Alice: Alice 喜欢披萨。",
  createdAt: "2026-06-25T00:01:00.000Z",
});
const personLeak = await memory.prepareTurn({
  profileId: "test",
  messages: [{ role: "user", content: "Alice 喜欢什么？" }],
});
assert.equal(personLeak.contextBlock.includes("披萨"), false);

await memory.observe({
  type: "conversation.message",
  profileId: "test",
  role: "user",
  content: "token: sk-test1234567890abcdef 不要泄漏",
  createdAt: "2026-06-25T00:02:00.000Z",
});
const secret = await memory.prepareTurn({
  profileId: "test",
  messages: [{ role: "user", content: "token 是什么？" }],
  includeSensitive: true,
  includeEvidence: true,
});
assert.equal(secret.contextBlock.includes("sk-test"), false);

await memory.observe({
  type: "conversation.message",
  profileId: "test",
  role: "user",
  content: "我的 SSN 是 123-45-6789，不要再提醒我。",
  createdAt: "2026-06-25T00:02:30.000Z",
});
const sensitivePolicy = await memory.prepareTurn({
  profileId: "test",
  messages: [{ role: "user", content: "SSN 提醒策略是什么？" }],
});
assert.equal(sensitivePolicy.contextBlock.includes("123-45-6789"), false);
assert.equal(
  sensitivePolicy.directives.some((directive) => directive.includes("123-45-6789")),
  false,
);

await memory.commitOutcome({
  profileId: "test",
  objective: "verify sdk",
  status: "failed",
  summary: "fixture failure",
});
assert.equal((await store.rowCounts()).gmos_failure_events, 1);

const compat = classifyHostCompatibility({
  hostId: "ghast",
  canObserve: true,
  canInjectContext: true,
  canCommitOutcome: true,
  canRecordFeedback: true,
  canEnforceDirectives: true,
});
assert.equal(compat.level, "L4");
assert.deepEqual(createEvolutionControlPlane(), {
  mode: "report_only",
  autoApply: false,
  autoRollout: false,
});

await memory.close();
const gym = await runMemoryGym();
assert.equal(gym.pass, true, gym.details.join("\n"));
rmSync(tmp, { recursive: true, force: true });
console.log("[gmos-sdk] tests passed");
