import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMemoryOS } from "@ghast/memory";
import { createMemoryMcpServer, listMemoryMcpTools } from "@ghast/memory/mcp";
import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

const tmp = mkdtempSync(path.join(os.tmpdir(), "gmos-openai-agent-memory-"));
const profileId = "openai-agent-example";
const dbPath = path.join(tmp, "openai-agent-memory.db");
const memoryToolNames = [
  "memory.prepare_context",
  "memory.observe",
  "memory.commit_outcome",
  "memory.record_feedback",
  "memory.explain_turn",
];

function functionToolsFromMcpContract() {
  return listMemoryMcpTools()
    .filter((tool) => memoryToolNames.includes(tool.name))
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
}

function scriptedExtractor(input) {
  if (!/risk-first atlas planning/iu.test(input.event.content)) return [];
  return [
    {
      kind: "preference",
      content: "Atlas planning style: answer with risks first, then the smallest next steps.",
      confidence: 0.9,
      predicate: "user.preference",
      subject: "user",
      object: "risks first, then smallest next steps",
      actionPolicyKind: "prefer",
    },
  ];
}

function scriptedAgent(input) {
  assert.ok(input.tools.some((tool) => tool.function.name === "memory.prepare_context"));
  const context = input.prepared.contextBlock;
  return context.includes("risks first")
    ? "Risks first: confirm owner approval. Next steps: keep the plan narrow."
    : "No memory context was provided.";
}

try {
  const store = createSqliteMemoryStore({ path: dbPath });
  const memory = createMemoryOS({
    profileId,
    store,
    extractor: {
      name: "openai-agent-example-extractor",
      extract: scriptedExtractor,
    },
  });
  const mcp = createMemoryMcpServer(memory);
  const tools = functionToolsFromMcpContract();
  assert.deepEqual(
    tools.map((tool) => tool.function.name).sort(),
    [...memoryToolNames].sort(),
  );

  async function callMemoryTool(name, args) {
    const result = await mcp.callTool(name, args);
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
    return result.structuredContent;
  }

  await callMemoryTool("memory.observe", {
    profileId,
    role: "user",
    content: "risk-first atlas planning is the format for release notes.",
    createdAt: "2026-06-25T00:00:00.000Z",
  });

  const preparedResult = await callMemoryTool("memory.prepare_context", {
    profileId,
    text: "How should the Atlas release note be drafted?",
    includeEvidence: true,
  });
  const prepared = preparedResult.prepared;
  assert.match(prepared.contextBlock, /risks first|smallest next steps/iu);
  assert.equal(prepared.memories.length > 0, true);

  const assistantText = scriptedAgent({
    tools,
    prepared,
    userText: "How should the Atlas release note be drafted?",
  });
  assert.match(assistantText, /Risks first/);

  const usedMemoryIds = prepared.memories.map((memoryRecord) => memoryRecord.id);
  await callMemoryTool("memory.commit_outcome", {
    profileId,
    taskId: "openai-agent-example-turn",
    objective: "Draft Atlas release note guidance",
    status: "completed",
    summary: assistantText,
    usedMemoryIds,
  });
  await callMemoryTool("memory.record_feedback", {
    profileId,
    content: "The risk-first Atlas answer matched the requested format.",
    relatedMemoryIds: usedMemoryIds,
    signal: "positive",
  });

  const explanationResult = await callMemoryTool("memory.explain_turn", {
    profileId,
    text: "How should the Atlas release note be drafted?",
    includeEvidence: true,
    maxExcluded: 3,
  });
  assert.equal(explanationResult.explanation.included.length > 0, true);
  assert.equal(JSON.stringify(explanationResult).includes("contextBlock"), false);

  const reinforced = await memory.get({
    profileId,
    id: usedMemoryIds[0],
  });
  assert.equal(reinforced?.recallCount, 1);
  assert.equal((reinforced?.reinforcement ?? 0) > 0, true);

  await memory.close();

  console.log(JSON.stringify({
    ok: true,
    dbPath: "[temporary plaintext sqlite]",
    functionToolCount: tools.length,
    preparedMemoryCount: prepared.memories.length,
    usedMemoryCount: usedMemoryIds.length,
    explanationIncludedCount: explanationResult.explanation.included.length,
    recallCount: reinforced?.recallCount,
    reinforcement: reinforced?.reinforcement,
  }, null, 2));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
