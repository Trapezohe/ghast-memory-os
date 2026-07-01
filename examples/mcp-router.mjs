import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMemoryOS } from "@ghast/memory";
import { createMemoryMcpServer } from "@ghast/memory/mcp";
import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

const tmp = mkdtempSync(path.join(os.tmpdir(), "gmos-mcp-router-"));
const profileId = "mcp-example";
const dbPath = path.join(tmp, "mcp-example.gmos.db");
const store = createSqliteMemoryStore({ path: dbPath });
const memory = createMemoryOS({ profileId, store });
const server = createMemoryMcpServer(memory);

try {
  const tools = server.listTools();
  assert.equal(tools.some((tool) => tool.name === "memory.runtime_info"), true);
  assert.equal(tools.some((tool) => tool.name === "memory.prepare_context"), true);

  const runtimeInfo = await server.callTool("memory.runtime_info");
  assert.equal(runtimeInfo.isError, undefined);
  assert.equal(runtimeInfo.structuredContent.runtimeInfo.schema, "gmos.runtime_info.v1");

  const observed = await server.callTool("memory.observe", {
    profileId,
    role: "user",
    content: "User opened the MCP host integration smoke test.",
    createdAt: "2026-06-25T00:00:00.000Z",
  });
  assert.equal(observed.isError, undefined);

  await memory.add({
    profileId,
    kind: "preference",
    content: "MCP host integration style: include evidence-backed context.",
    createdAt: "2026-06-25T00:00:00.000Z",
  });

  const prepared = await server.callTool("memory.prepare_context", {
    profileId,
    text: "How should MCP host integrations prepare context for me?",
    includeEvidence: true,
  });
  assert.equal(prepared.isError, undefined);
  const preparedText = JSON.stringify(prepared.structuredContent);
  assert.match(preparedText, /evidence-backed context/);

  const sensitiveOverride = await server.callTool("memory.prepare_context", {
    profileId,
    text: "How should MCP host integrations prepare context for me?",
    includeSensitive: true,
  });
  assert.equal(sensitiveOverride.isError, true);

  const evidencePath = await server.callTool("memory.explain_evidence_path", {
    profileId,
    text: "How should MCP host integrations prepare context for me?",
    includePlannerTrace: true,
  });
  assert.equal(evidencePath.isError, undefined);
  assert.equal(
    evidencePath.structuredContent.explanation.schema,
    "gmos.evidence_path_explanation.v1",
  );
  assert.equal(JSON.stringify(evidencePath.structuredContent).includes("contextBlock"), false);

  console.log(
    JSON.stringify(
      {
        ok: true,
        dbPath: "[temporary plaintext sqlite]",
        runtimeInfoSchema: runtimeInfo.structuredContent.runtimeInfo.schema,
        toolCount: tools.length,
        hasRuntimeInfoTool: true,
        preparedHasPreference: preparedText.includes("evidence-backed context"),
        sensitiveOverrideRejected: sensitiveOverride.isError === true,
        evidencePathSchema: evidencePath.structuredContent.explanation.schema,
      },
      null,
      2,
    ),
  );
} finally {
  await memory.close();
  rmSync(tmp, { recursive: true, force: true });
}
