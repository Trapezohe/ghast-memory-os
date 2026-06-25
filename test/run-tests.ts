import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";

import { createMemoryOS } from "../src/index.js";
import {
  renderHostCompatibilityGymMarkdown,
  renderMemoryGymMarkdown,
  renderMemoryScaleMarkdown,
  runHostCompatibilityGym,
  runMemoryGym,
  runMemoryScaleBenchmark,
} from "../src/gym/index.js";
import { createSqliteMemoryStore } from "../src/store/sqlite/index.js";
import {
  classifyHostCompatibility,
  createPresetHostAdapter,
  loadHostMemorySnapshotsIntoStore,
  normalizeHostMemoryKind,
  normalizeHostMemorySensitivity,
  syncHostMemorySnapshotsIntoStore,
} from "../src/host/index.js";
import {
  createMemoryMcpServer,
  createMemoryMcpStdioServer,
  listMemoryMcpTools,
} from "../src/mcp/index.js";
import { createEvolutionControlPlane } from "../src/evolution/index.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "gmos-sdk-test-"));
const dbPath = path.join(tmp, "test.db");
const store = createSqliteMemoryStore({ path: dbPath });
const memory = createMemoryOS({ profileId: "test", store });
assert.equal(await store.schemaVersion(), 1);

const legacyDbPath = path.join(tmp, "legacy-no-ledger.db");
const legacyHandle = new Database(legacyDbPath);
legacyHandle.exec(`
  CREATE TABLE legacy_marker(id TEXT PRIMARY KEY);
  INSERT INTO legacy_marker(id) VALUES ('preserved');
  CREATE TABLE gmos_memories (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'global',
    content TEXT NOT NULL,
    sensitivity TEXT NOT NULL DEFAULT 'normal',
    status TEXT NOT NULL DEFAULT 'active',
    confidence REAL NOT NULL DEFAULT 0.5,
    source_event_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO gmos_memories (
    id, profile_id, kind, scope, content, sensitivity, status, confidence,
    source_event_id, metadata_json, created_at, updated_at
  ) VALUES (
    'legacy_memory_1', 'legacy_profile', 'preference', 'global',
    'legacy preference row', 'normal', 'active', 0.8,
    NULL, '{}', '2026-06-25T00:00:00.000Z', '2026-06-25T00:00:00.000Z'
  );
`);
const legacyStore = createSqliteMemoryStore({ path: legacyDbPath, handle: legacyHandle });
await legacyStore.initialize();
assert.equal(await legacyStore.schemaVersion(), 1);
assert.equal(
  (
    legacyHandle
      .prepare("SELECT COUNT(*) AS count FROM gmos_schema_migrations WHERE version = 1")
      .get() as { count: number }
  ).count,
  1,
);
assert.equal(
  (
    legacyHandle.prepare("SELECT id FROM legacy_marker").get() as { id: string }
  ).id,
  "preserved",
);
assert.equal(
  (
    legacyHandle
      .prepare("SELECT content FROM gmos_memories WHERE id = 'legacy_memory_1'")
      .get() as { content: string }
  ).content,
  "legacy preference row",
);
legacyHandle.close();

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
const sourceMemoryId = prepared.actionPolicies[0]?.sourceMemoryId;
assert.equal(typeof sourceMemoryId, "string");
const explanation = await memory.explain(sourceMemoryId!, "test");
assert.equal(explanation?.kind, "memory");
assert.match(explanation?.text ?? "", /简洁的中文回答/);
assert.equal(explanation?.evidence.length, 1);

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
  capabilities: createPresetHostAdapter("ghast").capabilities,
});
assert.equal(compat.level, "L4");
assert.equal(compat.hardGateCoverage.forgetCompliance, true);
assert.equal(compat.hardGateCoverage.doNotPushPriority, true);
assert.deepEqual(compat.gaps, []);
const mockL3 = createPresetHostAdapter("mock_l3").compatibility;
assert.equal(mockL3.level, "L3");
assert.ok(mockL3.gaps.includes("tool observation"));
const mcp = createPresetHostAdapter("mcp").compatibility;
assert.equal(mcp.level, "L2");
assert.equal(mcp.hardGateCoverage.doNotPushPriority, false);
const searchOnly = createPresetHostAdapter("search_only").compatibility;
assert.equal(searchOnly.level, "L1");
assert.ok(searchOnly.gaps.includes("forget/delete"));
assert.deepEqual(createEvolutionControlPlane(), {
  mode: "report_only",
  autoApply: false,
  autoRollout: false,
});
assert.equal(normalizeHostMemoryKind({ content: "PERSON: Alice: likes pizza" }), "person");
assert.equal(
  normalizeHostMemoryKind({ content: "PERSON: Alice: likes pizza", kind: "fact" }),
  "person",
);
assert.equal(
  normalizeHostMemorySensitivity({ content: "api key: sk-hostimportsecret1234567890" }),
  "secret_like",
);
assert.equal(
  normalizeHostMemorySensitivity({
    content: "api key: sk-mislabeledsecret1234567890",
    sensitivity: "normal",
  }),
  "secret_like",
);
const hostImportReport = await loadHostMemorySnapshotsIntoStore({
  store,
  profileId: "host_import",
  sourceType: "ghast.memory",
  sourceUriPrefix: "ghast://memory",
  nowIso: "2026-06-25T00:03:00.000Z",
  memories: [
    {
      id: "host_pref",
      content: "我喜欢先讲风险的方案。",
      kind: "preference",
      confidence: 0.9,
      metadata: { origin: "fixture", secret: "sk-metadata-shouldnotleak123456" },
    },
    {
      id: "host_boundary",
      content: "以后不要再提醒我 Beta 项目延期。",
      kind: "boundary",
    },
    {
      id: "host_secret",
      content: "api key: sk-hostimportsecret1234567890",
      kind: "fact",
    },
    {
      id: "host_mislabeled_secret",
      content: "api key: sk-mislabeledsecret1234567890",
      kind: "fact",
      sensitivity: "normal",
    },
    {
      id: "host_person",
      content: "PERSON: Alice: Alice 喜欢披萨。",
      kind: "fact",
    },
  ],
});
assert.equal(hostImportReport.inputCount, 5);
assert.equal(hostImportReport.loadedCount, 2);
assert.equal(hostImportReport.reusedCount, 0);
assert.equal(hostImportReport.skippedCount, 3);
assert.equal(
  hostImportReport.skipped.filter((entry) => entry.reason === "secret_like").length,
  2,
);
assert.ok(hostImportReport.skipped.some((entry) => entry.reason === "person_memory"));
assert.equal(JSON.stringify(hostImportReport).includes("sk-hostimportsecret"), false);
assert.equal(JSON.stringify(hostImportReport).includes("sk-mislabeledsecret"), false);
const afterFirstHostImportCounts = await store.rowCounts();
const repeatedHostImportReport = await loadHostMemorySnapshotsIntoStore({
  store,
  profileId: "host_import",
  sourceType: "ghast.memory",
  sourceUriPrefix: "ghast://memory",
  nowIso: "2026-06-25T00:03:00.000Z",
  memories: [
    {
      id: "host_pref",
      content: "我喜欢先讲风险的方案。",
      kind: "preference",
      confidence: 0.9,
      metadata: { secret: "sk-metadata-shouldnotleak123456" },
    },
  ],
});
assert.equal(repeatedHostImportReport.loadedCount, 1);
assert.equal(repeatedHostImportReport.reusedCount, 1);
assert.deepEqual(await store.rowCounts(), afterFirstHostImportCounts);
const crossProfileReport = await loadHostMemorySnapshotsIntoStore({
  store,
  profileId: "host_import_other",
  sourceType: "ghast.memory",
  sourceUriPrefix: "ghast://memory",
  memories: [
    {
      id: "host_pref",
      content: "I prefer isolated profile evidence.",
      kind: "preference",
    },
  ],
});
assert.equal(crossProfileReport.loadedCount, 1);
assert.equal(crossProfileReport.reusedCount, 0);
const hostPrepared = await memory.prepareTurn({
  profileId: "host_import",
  messages: [{ role: "user", content: "先讲风险 Beta" }],
  includeEvidence: true,
});
assert.match(hostPrepared.contextBlock, /先讲风险/);
assert.equal(hostPrepared.contextBlock.includes("sk-hostimportsecret"), false);
assert.equal(hostPrepared.contextBlock.includes("sk-mislabeledsecret"), false);
assert.equal(hostPrepared.contextBlock.includes("披萨"), false);
assert.ok(hostPrepared.evidence.some((entry) => entry.sourceType === "ghast.memory"));
assert.equal(JSON.stringify(hostPrepared.evidence).includes("sk-metadata-shouldnotleak"), false);
const crossProfilePrepared = await memory.prepareTurn({
  profileId: "host_import_other",
  messages: [{ role: "user", content: "isolated profile evidence" }],
  includeEvidence: true,
});
assert.match(crossProfilePrepared.contextBlock, /isolated profile evidence/);
assert.ok(crossProfilePrepared.evidence.every((entry) => entry.profileId === "host_import_other"));

const firstHostSync = await syncHostMemorySnapshotsIntoStore({
  store,
  profileId: "host_sync",
  sourceType: "ghast.memory",
  sourceUriPrefix: "ghast://memory",
  nowIso: "2026-06-25T00:04:00.000Z",
  memories: [
    {
      id: "sync_pref",
      content: "我喜欢先讲风险。",
      kind: "preference",
      updatedAt: "2026-06-25T00:04:00.000Z",
    },
    {
      id: "sync_boundary",
      content: "以后不要提醒我 Moonbase 项目延期。",
      kind: "boundary",
      updatedAt: "2026-06-25T00:04:00.000Z",
    },
  ],
});
assert.equal(firstHostSync.loadedCount, 2);
assert.equal(firstHostSync.reusedCount, 0);
assert.equal(firstHostSync.archivedCount, 0);
const firstHostSyncCounts = await store.rowCounts();
const changedHostSync = await syncHostMemorySnapshotsIntoStore({
  store,
  profileId: "host_sync",
  sourceType: "ghast.memory",
  sourceUriPrefix: "ghast://memory",
  nowIso: "2026-06-25T00:05:00.000Z",
  memories: [
    {
      id: "sync_pref",
      content: "我现在喜欢先讲结论。",
      kind: "preference",
      updatedAt: "2026-06-25T00:05:00.000Z",
    },
    {
      id: "sync_secret",
      content: "api key: sk-syncsecret1234567890",
      kind: "fact",
      updatedAt: "2026-06-25T00:05:00.000Z",
    },
  ],
});
assert.equal(changedHostSync.loadedCount, 1);
assert.equal(changedHostSync.reusedCount, 0);
assert.equal(changedHostSync.skippedCount, 1);
assert.equal(changedHostSync.archivedCount, 2);
assert.equal(changedHostSync.archivedMemoryIds.length, 2);
const afterChangedHostSync = await memory.prepareTurn({
  profileId: "host_sync",
  messages: [{ role: "user", content: "风险 结论 Moonbase" }],
  includeEvidence: true,
});
assert.match(afterChangedHostSync.contextBlock, /先讲结论/);
assert.equal(afterChangedHostSync.contextBlock.includes("先讲风险"), false);
assert.equal(afterChangedHostSync.contextBlock.includes("Moonbase"), false);
assert.equal(afterChangedHostSync.contextBlock.includes("sk-syncsecret"), false);
const repeatedHostSync = await syncHostMemorySnapshotsIntoStore({
  store,
  profileId: "host_sync",
  sourceType: "ghast.memory",
  sourceUriPrefix: "ghast://memory",
  nowIso: "2026-06-25T00:05:00.000Z",
  memories: [
    {
      id: "sync_pref",
      content: "我现在喜欢先讲结论。",
      kind: "preference",
      updatedAt: "2026-06-25T00:05:00.000Z",
    },
  ],
});
assert.equal(repeatedHostSync.loadedCount, 1);
assert.equal(repeatedHostSync.reusedCount, 1);
assert.equal(repeatedHostSync.archivedCount, 0);
assert.equal((await store.rowCounts()).gmos_memories, firstHostSyncCounts.gmos_memories + 1);
const hashFallbackSyncA = await syncHostMemorySnapshotsIntoStore({
  store,
  profileId: "host_sync_hash",
  sourceType: "ghast.memory",
  sourceUriPrefix: "ghast://memory",
  nowIso: "2026-06-25T00:06:00.000Z",
  memories: [
    {
      id: "sync_without_updated_at",
      content: "old host snapshot content",
      kind: "preference",
    },
  ],
});
assert.equal(hashFallbackSyncA.loadedCount, 1);
assert.equal(hashFallbackSyncA.archivedCount, 0);
const hashFallbackSyncB = await syncHostMemorySnapshotsIntoStore({
  store,
  profileId: "host_sync_hash",
  sourceType: "ghast.memory",
  sourceUriPrefix: "ghast://memory",
  nowIso: "2026-06-25T00:07:00.000Z",
  memories: [
    {
      id: "sync_without_updated_at",
      content: "new host snapshot content",
      kind: "preference",
    },
  ],
});
assert.equal(hashFallbackSyncB.loadedCount, 1);
assert.equal(hashFallbackSyncB.reusedCount, 0);
assert.equal(hashFallbackSyncB.archivedCount, 1);
const hashFallbackPrepared = await memory.prepareTurn({
  profileId: "host_sync_hash",
  messages: [{ role: "user", content: "host snapshot content" }],
});
assert.match(hashFallbackPrepared.contextBlock, /new host snapshot content/);
assert.equal(hashFallbackPrepared.contextBlock.includes("old host snapshot content"), false);
const wildcardSourceA = await syncHostMemorySnapshotsIntoStore({
  store,
  profileId: "host_sync_source_type",
  sourceType: "fooXbar",
  sourceUriPrefix: "host://fooXbar",
  nowIso: "2026-06-25T00:08:00.000Z",
  memories: [
    {
      id: "source_type_guard",
      content: "wildcard source should remain active",
      kind: "preference",
    },
  ],
});
assert.equal(wildcardSourceA.loadedCount, 1);
const wildcardSourceB = await syncHostMemorySnapshotsIntoStore({
  store,
  profileId: "host_sync_source_type",
  sourceType: "foo_bar",
  sourceUriPrefix: "host://foo_bar",
  nowIso: "2026-06-25T00:09:00.000Z",
  memories: [],
});
assert.equal(wildcardSourceB.archivedCount, 0);
const wildcardPrepared = await memory.prepareTurn({
  profileId: "host_sync_source_type",
  messages: [{ role: "user", content: "wildcard source active" }],
});
assert.match(wildcardPrepared.contextBlock, /wildcard source should remain active/);

const mcpServer = createMemoryMcpServer(memory);
assert.equal(mcpServer.status, "ready");
assert.deepEqual(
  mcpServer.listTools().map((tool) => tool.name),
  listMemoryMcpTools().map((tool) => tool.name),
);
assert.ok(mcpServer.listTools().every((tool) => tool.inputSchema.type === "object"));
const mcpInvalidBefore = await store.rowCounts();
const invalidMcpObserve = await mcpServer.callTool("memory.observe", { content: 42 });
assert.equal(invalidMcpObserve.isError, true);
assert.deepEqual(await store.rowCounts(), mcpInvalidBefore);
const mcpObserve = await mcpServer.callTool("memory.observe", {
  profileId: "mcp",
  conversationId: "conv_mcp",
  messageId: "msg_mcp_1",
  role: "user",
  content: "我的代码方案沟通偏好是先讲风险。",
  createdAt: "2026-06-25T00:03:00.000Z",
});
assert.equal((mcpObserve.structuredContent as { ok?: boolean }).ok, true);
const mcpPrepared = await mcpServer.callTool("memory.prepare_context", {
  profileId: "mcp",
  text: "代码方案沟通偏好",
  includeEvidence: true,
});
const mcpPreparedPayload = mcpPrepared.structuredContent as {
  ok?: boolean;
  prepared?: {
    contextBlock: string;
    evidence: unknown[];
    memories: Array<{ id: string }>;
  };
};
assert.equal(mcpPreparedPayload.ok, true);
assert.match(mcpPreparedPayload.prepared?.contextBlock ?? "", /先讲风险/);
assert.equal(mcpPreparedPayload.prepared?.evidence.length, 1);
const mcpMemoryId = mcpPreparedPayload.prepared?.memories[0]?.id;
assert.equal(typeof mcpMemoryId, "string");
const mcpExplanation = await mcpServer.callTool("memory.explain_belief", {
  profileId: "mcp",
  id: mcpMemoryId,
});
assert.match(JSON.stringify(mcpExplanation.structuredContent), /先讲风险/);
const mcpNestedOverride = await mcpServer.callTool("memory.prepare_context", {
  profileId: "mcp",
  messages: [
    {
      role: "user",
      content: "嵌套参数也不能携带隐藏 override",
      includeSensitive: true,
    },
  ],
});
assert.equal(mcpNestedOverride.isError, true);
const mcpTextAndNestedOverride = await mcpServer.callTool("memory.prepare_context", {
  profileId: "mcp",
  text: "即使 text 存在也不能忽略坏 messages",
  messages: [
    {
      role: "user",
      content: "嵌套参数也不能被静默忽略",
      includeSensitive: true,
    },
  ],
});
assert.equal(mcpTextAndNestedOverride.isError, true);
const metadataSecret = "sk-metadata1234567890abcdef";
const metadataAuthSecret = "Bearer ghast-auth-secret-value";
await mcpServer.callTool("memory.observe", {
  profileId: "mcp",
  role: "user",
  content: "我的 metadata 偏好是先写测试。",
  metadata: {
    token: metadataSecret,
    auth: metadataAuthSecret,
    nested: {
      apiKey: metadataSecret,
      debug: metadataAuthSecret,
      note: "safe metadata note",
    },
  },
});
const mcpMetadataPrepared = await mcpServer.callTool("memory.prepare_context", {
  profileId: "mcp",
  text: "metadata 偏好",
  includeEvidence: true,
});
assert.equal(mcpMetadataPrepared.isError, undefined);
assert.equal(JSON.stringify(mcpMetadataPrepared.structuredContent).includes(metadataSecret), false);
assert.equal(
  JSON.stringify(mcpMetadataPrepared.structuredContent).includes(metadataAuthSecret),
  false,
);
const mcpMetadataPreparedPayload = mcpMetadataPrepared.structuredContent as {
  prepared?: { memories: Array<{ id: string; content: string }> };
};
const metadataMemoryId = mcpMetadataPreparedPayload.prepared?.memories.find((entry) =>
  entry.content.includes("metadata 偏好"),
)?.id;
assert.equal(typeof metadataMemoryId, "string");
const mcpMetadataExplanation = await mcpServer.callTool("memory.explain_belief", {
  profileId: "mcp",
  id: metadataMemoryId,
});
assert.equal(mcpMetadataExplanation.isError, undefined);
assert.equal(JSON.stringify(mcpMetadataExplanation.structuredContent).includes(metadataSecret), false);
assert.equal(
  JSON.stringify(mcpMetadataExplanation.structuredContent).includes(metadataAuthSecret),
  false,
);
await mcpServer.callTool("memory.observe", {
  profileId: "mcp",
  role: "user",
  content: "secret key: sk-mcp-secret-1234567890 不要泄漏",
});
const mcpSecretPrepared = await mcpServer.callTool("memory.prepare_context", {
  profileId: "mcp",
  text: "secret key 是什么？",
  includeEvidence: true,
});
assert.equal(JSON.stringify(mcpSecretPrepared.structuredContent).includes("sk-mcp-secret"), false);
await mcpServer.callTool("memory.observe", {
  profileId: "mcp",
  role: "user",
  content: "我的 SSN 是 123-45-6789，不要再提醒。",
});
const mcpSensitivePrepared = await mcpServer.callTool("memory.prepare_context", {
  profileId: "mcp",
  text: "SSN 提醒",
  includeEvidence: true,
});
assert.equal(JSON.stringify(mcpSensitivePrepared.structuredContent).includes("123-45-6789"), false);
const mcpSensitiveOverride = await mcpServer.callTool("memory.prepare_context", {
  profileId: "mcp",
  text: "SSN 提醒",
  includeSensitive: true,
});
assert.equal(mcpSensitiveOverride.isError, true);
assert.equal(JSON.stringify(mcpSensitiveOverride.structuredContent).includes("123-45-6789"), false);
const sensitiveMcpMemories = await store.searchMemories({
  profileId: "mcp",
  query: "123-45-6789",
  purpose: "manage",
  includeSensitive: true,
});
const sensitiveMcpMemoryId = sensitiveMcpMemories[0]?.id;
assert.equal(typeof sensitiveMcpMemoryId, "string");
const mcpSensitiveExplanation = await mcpServer.callTool("memory.explain_belief", {
  profileId: "mcp",
  id: sensitiveMcpMemoryId,
});
assert.equal(mcpSensitiveExplanation.isError, true);
assert.equal(
  JSON.stringify(mcpSensitiveExplanation.structuredContent).includes("123-45-6789"),
  false,
);
const metadataSensitiveMemory = await store.addMemory({
  profileId: "mcp",
  kind: "fact",
  content: "metadata-only sensitive payload",
  sensitivity: "sensitive",
  confidence: 0.9,
});
const mcpMetadataSensitiveExplanation = await mcpServer.callTool("memory.explain_belief", {
  profileId: "mcp",
  id: metadataSensitiveMemory.id,
});
assert.equal(mcpMetadataSensitiveExplanation.isError, true);
assert.equal(
  JSON.stringify(mcpMetadataSensitiveExplanation.structuredContent).includes(
    "metadata-only sensitive payload",
  ),
  false,
);
const metadataPersonMemory = await store.addMemory({
  profileId: "mcp",
  kind: "person",
  content: "Alice prefers tea",
  sensitivity: "normal",
  confidence: 0.9,
});
const mcpPersonExplanation = await mcpServer.callTool("memory.explain_belief", {
  profileId: "mcp",
  id: metadataPersonMemory.id,
});
assert.equal(mcpPersonExplanation.isError, true);
assert.equal(JSON.stringify(mcpPersonExplanation.structuredContent).includes("Alice prefers tea"), false);
const mcpForget = await mcpServer.callTool("memory.forget", {
  profileId: "mcp",
  query: "先讲风险",
  reason: "test cleanup",
});
assert.match(JSON.stringify(mcpForget.structuredContent), /archivedMemoryIds/);
const mcpAfterForget = await mcpServer.callTool("memory.prepare_context", {
  profileId: "mcp",
  text: "代码方案沟通偏好",
});
assert.equal(JSON.stringify(mcpAfterForget.structuredContent).includes("先讲风险"), false);
await mcpServer.callTool("memory.record_feedback", {
  profileId: "mcp",
  content: "刚才错误召回了已删除偏好",
  failureKind: "wrong_recall",
});
await mcpServer.callTool("memory.commit_outcome", {
  profileId: "mcp",
  objective: "verify mcp server",
  status: "failed",
  summary: "mcp fixture failure",
});
const mcpCounts = await store.rowCounts();
assert.ok(mcpCounts.gmos_failure_events >= 3);

await memory.close();
const gym = await runMemoryGym();
assert.equal(gym.pass, true, gym.details.join("\n"));
assert.equal(gym.framework, "complete memory system benchmark framework");
assert.equal(gym.deterministicArchitectureResult.status, "pass");
assert.equal(gym.agentMemoryUseResult.status, "not_run");
assert.equal(gym.generalizationResult.status, "pass");
assert.equal(gym.generalizationResult.generatedSeedCount, 3);
assert.equal(gym.roadmapResult.status, "clear");
assert.equal(gym.runManifest.dbPathMode, "memory");
assert.equal(gym.hardGates.mcp_public_sensitive_rejection, true);
assert.equal(gym.hardGates.host_adapter_contract, true);
assert.ok(gym.coverageMatrix.some((row) => row.layer === "Layer 2: MCP / Host Boundary"));
assert.ok(gym.memoryStackCoverage.some((row) => row.layer === "Safety / Privacy"));
const renderedGym = renderMemoryGymMarkdown(gym);
assert.match(renderedGym, /gmOS Memory Gym Report/);
assert.match(renderedGym, /Coverage Matrix/);
assert.match(renderedGym, /Run Manifest/);
const generatedGym = await runMemoryGym({ generatedSeeds: 2 });
assert.equal(generatedGym.pass, true, generatedGym.details.join("\n"));
assert.equal(generatedGym.generalizationResult.generatedSeedCount, 2);
assert.equal(generatedGym.runManifest.generatedSeeds.length, 2);
await assert.rejects(
  () => runMemoryGym({ generatedSeeds: 0 }),
  /generatedSeeds must be a positive integer/,
);
await assert.rejects(
  () => runMemoryGym({ generatedSeeds: [] }),
  /generatedSeeds must be a positive integer/,
);
const scale = await runMemoryScaleBenchmark({ sizes: [10, 50], iterations: 3 });
assert.equal(scale.pass, true);
assert.match(renderMemoryScaleMarkdown(scale), /gmOS Memory Scale Benchmark/);
await assert.rejects(
  () => runMemoryScaleBenchmark({ sizes: [], iterations: 3 }),
  /positive integer size/,
);
await assert.rejects(
  () => runMemoryScaleBenchmark({ sizes: [10], iterations: 0 }),
  /positive integer/,
);
for (const [host, expectedLevel] of [
  ["ghast", "L4"],
  ["mock_l3", "L3"],
  ["mcp", "L2"],
  ["search_only", "L1"],
] as const) {
  const doctor = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/cli/gmos.ts",
      "doctor",
      "--db",
      path.join(tmp, `doctor-${host}.db`),
      "--host",
      host,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(doctor.status, 0, doctor.stderr);
  const doctorJson = JSON.parse(doctor.stdout) as {
    encrypted: boolean;
    schema?: { dialect?: string; version?: number };
    hostCompatibility?: { level?: string; gaps?: string[] };
  };
  assert.equal(doctorJson.encrypted, false);
  assert.equal(doctorJson.schema?.dialect, "sqlite");
  assert.equal(doctorJson.schema?.version, 1);
  assert.equal(doctorJson.hostCompatibility?.level, expectedLevel);
  if (host === "ghast") assert.deepEqual(doctorJson.hostCompatibility?.gaps, []);
}
const cliGymInvalidSeeds = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "gym",
    "run",
    "--db",
    ":memory:",
    "--generated-seeds",
    "0",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.notEqual(cliGymInvalidSeeds.status, 0);
assert.match(cliGymInvalidSeeds.stderr, /--generated-seeds must be a positive integer/);
const cliScaleFail = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "gym",
    "scale",
    "--sizes",
    "1",
    "--threshold-p95-ms",
    "0",
    "--format",
    "markdown",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.notEqual(cliScaleFail.status, 0);
assert.match(cliScaleFail.stdout, /Status: FAIL/);
const hostGym = await runHostCompatibilityGym();
assert.equal(hostGym.pass, true, hostGym.failures.join("\n"));
assert.equal(hostGym.hostCount, 4);
assert.equal(hostGym.hosts.find((host) => host.hostId === "ghast")?.level, "L4");
assert.equal(hostGym.hosts.find((host) => host.hostId === "ghast")?.memoryToAction, "pass");
assert.equal(hostGym.hosts.find((host) => host.hostId === "mcp")?.level, "L2");
assert.equal(
  hostGym.hosts.find((host) => host.hostId === "mcp")?.memoryToAction,
  "not_run",
);
assert.equal(
  hostGym.hosts.find((host) => host.hostId === "search_only")?.agentMemoryUse,
  "not_run",
);
assert.match(renderHostCompatibilityGymMarkdown(hostGym), /gmOS Host Compatibility Gym/);
const cliHostGym = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "gym",
    "host",
    "--hosts",
    "ghast,mcp",
    "--format",
    "markdown",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliHostGym.status, 0, cliHostGym.stderr);
assert.match(cliHostGym.stdout, /gmOS Host Compatibility Gym/);
assert.match(cliHostGym.stdout, /ghast/);
assert.match(cliHostGym.stdout, /mcp/);
const cliHostGymInvalid = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "gym",
    "host",
    "--hosts",
    "unknown",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.notEqual(cliHostGymInvalid.status, 0);
assert.match(cliHostGymInvalid.stderr, /--hosts must contain only/);
const cliMcpTools = spawnSync(
  process.execPath,
  ["--import", "tsx", "src/cli/gmos.ts", "mcp", "tools"],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliMcpTools.status, 0, cliMcpTools.stderr);
assert.ok(
  (JSON.parse(cliMcpTools.stdout) as { tools: Array<{ name: string }> }).tools.some(
    (tool) => tool.name === "memory.prepare_context",
  ),
);
const mcpCliDb = path.join(tmp, "mcp-cli.db");
const cliMcpObserve = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "mcp",
    "call",
    "--db",
    mcpCliDb,
    "--profile",
    "cli_mcp",
    "--tool",
    "memory.observe",
    "--input",
    JSON.stringify({ content: "我偏好提交前先跑完整测试。", role: "user" }),
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliMcpObserve.status, 0, cliMcpObserve.stderr);
const cliMcpPrepare = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "mcp",
    "call",
    "--db",
    mcpCliDb,
    "--profile",
    "cli_mcp",
    "--tool",
    "memory.prepare_context",
    "--input",
    JSON.stringify({ text: "提交前应该注意什么？" }),
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliMcpPrepare.status, 0, cliMcpPrepare.stderr);
assert.match(cliMcpPrepare.stdout, /完整测试/);
const cliMcpInvalid = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "mcp",
    "call",
    "--db",
    mcpCliDb,
    "--profile",
    "cli_mcp",
    "--tool",
    "memory.observe",
    "--input",
    "{bad-json",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.notEqual(cliMcpInvalid.status, 0);
assert.match(cliMcpInvalid.stderr, /--input must be valid JSON/);
const cliMcpUnknownTool = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "mcp",
    "call",
    "--db",
    mcpCliDb,
    "--profile",
    "cli_mcp",
    "--tool",
    "memory.unknown",
    "--input",
    "{}",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.notEqual(cliMcpUnknownTool.status, 0);
assert.match(cliMcpUnknownTool.stdout, /Unknown gmOS MCP tool/);

const directStdioServer = createMemoryMcpStdioServer(memory);
assert.equal(directStdioServer.isConnected(), false);
const stdioMcpDb = path.join(tmp, "stdio-mcp.db");
const stdioTransport = new StdioClientTransport({
  command: process.execPath,
  args: [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "mcp",
    "serve",
    "--db",
    stdioMcpDb,
    "--profile",
    "stdio_mcp",
  ],
  cwd: process.cwd(),
  stderr: "pipe",
});
const stdioClient = new Client({
  name: "gmos-sdk-test-client",
  version: "0.0.0",
});
try {
  await stdioClient.connect(stdioTransport);
  const stdioTools = await stdioClient.listTools();
  assert.ok(stdioTools.tools.some((tool) => tool.name === "memory.prepare_context"));
  await stdioClient.callTool({
    name: "memory.observe",
    arguments: {
      content: "我在 MCP stdio 模式下也偏好先讲风险。",
      role: "user",
      profileId: "stdio_mcp",
    },
  });
  const stdioPrepared = await stdioClient.callTool({
    name: "memory.prepare_context",
    arguments: {
      profileId: "stdio_mcp",
      text: "stdio 模式下应该怎么回答？",
      includeEvidence: true,
    },
  });
  assert.equal(stdioPrepared.isError, undefined);
  assert.match(JSON.stringify(stdioPrepared.structuredContent), /先讲风险/);
  const stdioNestedSensitive = await stdioClient.callTool({
    name: "memory.prepare_context",
    arguments: {
      profileId: "stdio_mcp",
      messages: [
        {
          role: "user",
          content: "嵌套参数不应携带隐藏 override",
          includeSensitive: true,
        },
      ],
    },
  });
  assert.equal(stdioNestedSensitive.isError, true);
  assert.equal(JSON.stringify(stdioNestedSensitive).includes("123-45-6789"), false);
  const stdioSensitive = await stdioClient.callTool({
    name: "memory.prepare_context",
    arguments: {
      profileId: "stdio_mcp",
      text: "stdio 敏感 override",
      includeSensitive: true,
    },
  });
  assert.equal(stdioSensitive.isError, true);
} finally {
  await stdioClient.close();
}

const termMcp = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "mcp",
    "serve",
    "--db",
    path.join(tmp, "term-mcp.db"),
    "--profile",
    "term_mcp",
  ],
  { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
);
await new Promise((resolve) => setTimeout(resolve, 500));
termMcp.kill("SIGTERM");
const termExit = await Promise.race([
  new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    termMcp.once("exit", (code, signal) => resolve({ code, signal }));
  }),
  new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
]);
if (!termExit) {
  termMcp.kill("SIGKILL");
  assert.fail("gmos mcp serve did not exit after SIGTERM");
}
assert.ok(termExit.code === 0 || termExit.signal === "SIGTERM");

const stdinEndMcp = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "mcp",
    "serve",
    "--db",
    path.join(tmp, "stdin-end-mcp.db"),
    "--profile",
    "stdin_end_mcp",
  ],
  { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
);
await new Promise((resolve) => setTimeout(resolve, 500));
stdinEndMcp.stdin.end();
const stdinEndExit = await Promise.race([
  new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    stdinEndMcp.once("exit", (code, signal) => resolve({ code, signal }));
  }),
  new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
]);
if (!stdinEndExit) {
  stdinEndMcp.kill("SIGKILL");
  assert.fail("gmos mcp serve did not exit after stdin end");
}
assert.equal(stdinEndExit.code, 0);

const invalidHostDb = path.join(tmp, "doctor-invalid.db");
const invalidHost = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "doctor",
    "--db",
    invalidHostDb,
    "--host",
    "unknown",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.notEqual(invalidHost.status, 0);
assert.match(invalidHost.stderr, /--host must be one of/);
assert.equal(existsSync(invalidHostDb), false);
rmSync(tmp, { recursive: true, force: true });
console.log("[gmos-sdk] tests passed");
