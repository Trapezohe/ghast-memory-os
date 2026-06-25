import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMemoryOS } from "@ghast/memory";
import { createMemoryStatusReport } from "@ghast/memory/diagnostics";
import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

const tmp = mkdtempSync(path.join(os.tmpdir(), "gmos-quickstart-"));
const dbPath = path.join(tmp, "quickstart.gmos.db");
const store = createSqliteMemoryStore({ path: dbPath });
const memory = createMemoryOS({ profileId: "quickstart", store });

try {
  await memory.observe({
    type: "conversation.message",
    profileId: "quickstart",
    role: "user",
    content: "我喜欢先讲风险，再给方案。",
    createdAt: "2026-06-25T00:00:00.000Z",
  });

  const prepared = await memory.prepareTurn({
    profileId: "quickstart",
    messages: [{ role: "user", content: "之后回答方案时应该注意什么？" }],
    includeEvidence: true,
  });

  const imported = await memory.add({
    profileId: "quickstart",
    kind: "project",
    content: "Quickstart project is validating gmOS SDK integration.",
  });

  const importedMatches = await memory.search({
    profileId: "quickstart",
    query: "Quickstart project",
  });

  const status = await createMemoryStatusReport({
    store,
    profileId: "quickstart",
    host: "ghast",
  });

  const output = {
    ok: true,
    contextHasPreference: prepared.contextBlock.includes("先讲风险"),
    evidenceCount: prepared.evidence.length,
    importedMemoryId: imported.id,
    importedSearchHit: importedMatches.some((memoryRecord) => memoryRecord.id === imported.id),
    schemaVersion: status.storage.schemaVersion,
    memoryRows: status.storage.rowCounts.gmos_memories,
    hostLevel: status.hostCompatibility?.level,
  };

  console.log(JSON.stringify(output, null, 2));
} finally {
  await memory.close();
  rmSync(tmp, { recursive: true, force: true });
}
