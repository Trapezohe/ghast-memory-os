import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMemoryOS } from "@ghast/memory";
import {
  classifyHostCompatibility,
  syncHostMemorySnapshotsIntoStore,
} from "@ghast/memory/host";
import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

const tmp = mkdtempSync(path.join(os.tmpdir(), "gmos-host-adapter-"));
const profileId = "host-example";
const dbPath = path.join(tmp, "host-example.gmos.db");
const store = createSqliteMemoryStore({ path: dbPath });
const memory = createMemoryOS({ profileId, store });
const nowIso = "2026-06-25T00:00:00.000Z";

const hostMemories = [
  {
    id: "host_pref_1",
    kind: "preference",
    content: "User prefers concise engineering answers.",
    confidence: 0.91,
    updatedAt: nowIso,
  },
  {
    id: "host_boundary_1",
    kind: "boundary",
    content: "Do not proactively push delay reminders for Project Atlas.",
    confidence: 0.94,
    updatedAt: nowIso,
  },
  {
    id: "host_secret_1",
    kind: "fact",
    content: "User API key is sk-hostadaptersecret1234567890.",
    updatedAt: nowIso,
  },
  {
    id: "host_person_1",
    kind: "person",
    content: "PERSON: Alice: Alice prefers TypeScript.",
    updatedAt: nowIso,
  },
];

try {
  const compatibility = classifyHostCompatibility({
    hostId: "example-host",
    capabilities: {
      canObserveConversation: true,
      canInjectSystemContext: true,
      canEnforceHardDirectives: true,
      canForget: true,
      supportsPrivateMode: true,
      supportsActionPolicies: true,
      supportsEvidenceInContext: true,
    },
  });
  assert.equal(compatibility.level, "L3");

  const firstSync = await syncHostMemorySnapshotsIntoStore({
    store,
    profileId,
    memories: hostMemories,
    sourceType: "example.host.memory",
    sourceUriPrefix: "example://memory",
    nowIso,
  });
  assert.equal(firstSync.inputCount, 4);
  assert.equal(firstSync.loadedCount, 2);
  assert.equal(firstSync.skippedCount, 2);
  assert.deepEqual(
    firstSync.skipped.map((item) => item.reason).sort(),
    ["person_memory", "secret_like"],
  );

  const prepared = await memory.prepareTurn({
    profileId,
    messages: [
      {
        role: "user",
        content: "How should you answer Project Atlas planning questions?",
      },
    ],
    includeEvidence: true,
  });
  assert.match(prepared.contextBlock, /concise engineering answers/);
  assert.match(prepared.contextBlock, /Do not proactively push delay reminders/);
  assert.equal(prepared.contextBlock.includes("sk-hostadaptersecret"), false);
  assert.equal(prepared.contextBlock.includes("PERSON: Alice"), false);
  assert.ok(prepared.actionPolicies.some((policy) => policy.kind === "do_not_push"));
  assert.ok(prepared.evidence.length >= 1);

  const secondSync = await syncHostMemorySnapshotsIntoStore({
    store,
    profileId,
    memories: hostMemories.filter((memoryRecord) => memoryRecord.id !== "host_pref_1"),
    sourceType: "example.host.memory",
    sourceUriPrefix: "example://memory",
    nowIso: "2026-06-25T01:00:00.000Z",
  });
  assert.equal(secondSync.archivedCount, 1);

  const afterArchive = await memory.prepareTurn({
    profileId,
    messages: [{ role: "user", content: "concise engineering answers" }],
  });
  assert.equal(afterArchive.contextBlock.includes("concise engineering answers"), false);

  console.log(
    JSON.stringify(
      {
        ok: true,
        dbPath: "[temporary plaintext sqlite]",
        compatibilityLevel: compatibility.level,
        firstSync: {
          inputCount: firstSync.inputCount,
          loadedCount: firstSync.loadedCount,
          skippedCount: firstSync.skippedCount,
          skippedReasons: firstSync.skipped.map((item) => item.reason),
        },
        prepared: {
          memoryCount: prepared.memories.length,
          actionPolicyCount: prepared.actionPolicies.length,
          evidenceCount: prepared.evidence.length,
          contextHasBoundary: prepared.contextBlock.includes("Do not proactively push"),
        },
        secondSync: {
          archivedCount: secondSync.archivedCount,
        },
      },
      null,
      2,
    ),
  );
} finally {
  await memory.close();
  rmSync(tmp, { recursive: true, force: true });
}
