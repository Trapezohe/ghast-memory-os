import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMemoryOS } from "@ghast/memory";
import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

const tmp = mkdtempSync(path.join(os.tmpdir(), "gmos-memory-inspector-"));
const dbPath = path.join(tmp, "memory-inspector.db");

try {
  const memory = createMemoryOS({
    profileId: "inspector-user",
    store: createSqliteMemoryStore({ path: dbPath }),
  });

  const activeProject = await memory.add({
    profileId: "inspector-user",
    kind: "project",
    content: "project:citadel current owner is Rowan and review is pending.",
    confidence: 0.88,
    metadata: {
      subject: "project:citadel",
      predicate: "project.owner",
      object: "Rowan",
    },
    createdAt: "2026-06-25T00:00:00.000Z",
  });

  const archivedProject = await memory.add({
    profileId: "inspector-user",
    kind: "project",
    content: "project:citadel obsolete owner was North Desk.",
    confidence: 0.7,
    createdAt: "2026-06-24T00:00:00.000Z",
  });

  await memory.archive({
    profileId: "inspector-user",
    id: archivedProject.id,
    reason: "example obsolete owner cleanup",
  });

  await memory.add({
    profileId: "inspector-user",
    kind: "boundary",
    content: "project:citadel review notes should not be sent before owner approval.",
    confidence: 0.94,
    createdAt: "2026-06-25T00:02:00.000Z",
  });

  const evidence = await memory.listEvidence({
    profileId: "inspector-user",
    limit: 10,
  });
  const activeMemories = await memory.list({
    profileId: "inspector-user",
    status: "active",
  });
  const archivedMemories = await memory.list({
    profileId: "inspector-user",
    status: "archived",
    includeArchived: true,
  });
  const managedRead = await memory.get({
    profileId: "inspector-user",
    id: archivedProject.id,
    includeArchived: true,
  });
  const reconstructed = await memory.reconstructContext({
    profileId: "inspector-user",
    query: "What should I inspect before sending project Citadel review notes?",
    reconstructionIntent: {
      queryCues: ["project:citadel", "review notes"],
      requiredTagGroups: [
        {
          name: "project_or_boundary",
          tags: ["project", "boundary", "world_belief"],
        },
      ],
    },
    maxSteps: 2,
    maxBranch: 4,
    includeEvidence: true,
  });

  assert.equal(evidence.length >= 3, true);
  assert.equal(activeMemories.some((memoryRecord) => memoryRecord.id === activeProject.id), true);
  assert.equal(archivedMemories.some((memoryRecord) => memoryRecord.id === archivedProject.id), true);
  assert.equal(managedRead?.status, "archived");
  assert.match(reconstructed.contextBlock, /Rowan|owner approval|review notes/iu);
  assert.equal(reconstructed.paths.length > 0, true);

  const summary = {
    ok: true,
    dbPath: "[temporary plaintext sqlite]",
    evidenceCount: evidence.length,
    activeMemoryCount: activeMemories.length,
    archivedMemoryCount: archivedMemories.length,
    reconstructedPathCount: reconstructed.paths.length,
    uncertaintyLevel: reconstructed.stats.uncertainty?.level ?? "unknown",
    coverageRate: reconstructed.stats.evidenceCoverage?.coverageRate ?? null,
  };

  await memory.close();
  console.log(JSON.stringify(summary, null, 2));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
