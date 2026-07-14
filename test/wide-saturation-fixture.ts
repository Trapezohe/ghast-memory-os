import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMemoryOS } from "../src/runtime/create-memory-os.js";
import { createSqliteMemoryStore } from "../src/store/sqlite/index.js";
import type { EmbeddingProvider, MemoryRecord, ReconstructedContext } from "../src/kernel/types.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "gmos-wide-saturation-"));
const dimensions = 4096;
const totalRows = 500;
const directRows = 32;

function vector(first: number, second: number): number[] {
  const output = new Array<number>(dimensions).fill(0);
  output[0] = first;
  output[1] = second;
  return output;
}

function fixtureProvider(): EmbeddingProvider {
  return {
    name: "wide-saturation-real-shape-provider",
    dimensions,
    async embed(texts: string[]) {
      return texts.map((text) =>
        /^What did Avery/iu.test(text) || /NeedleMarker/iu.test(text) ? vector(1, 0) : vector(0, 1)
      );
    },
  };
}

function rowContent(index: number): string {
  if (index < 10) {
    return `NeedleMarker EnumerationSupplyKey dated instance ${index} occurred on 2026-06-${String(index + 1).padStart(2, "0")}.`;
  }
  return index < directRows
    ? `NeedleMarker vector-only direct memory ${index}.`
    : `launch recall broad eligible benchmark-shaped memory ${index}.`;
}

function rowMetadata(index: number, sourceScoped: boolean): Record<string, unknown> {
  const eventTime = `2026-07-06T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`;
  if (!sourceScoped || index >= directRows) return { eventTime };
  return {
    speaker: "Avery",
    speakerKind: "person",
    participants: ["Avery", "Morgan"],
    eventTime,
  };
}

async function runScenario(input: {
  profileId: string;
  withEmbedding: boolean;
  sourceScoped: boolean;
  episodeExpansion: "off" | "adjacent";
}): Promise<{
  context: ReconstructedContext;
  enumerationContext: ReconstructedContext;
  directCount: number;
  broadCount: number;
}> {
  const store = createSqliteMemoryStore({ path: path.join(tmp, `${input.profileId}.db`) });
  const memory = createMemoryOS({
    profileId: input.profileId,
    store,
    extractor: () => [],
    sessionDistiller: (distillation) => ({
      narrative: {
        content: `NeedleMarker distilled session summary at ${distillation.eventTime}.`,
      },
      events: [],
    }),
    ...(input.withEmbedding ? { embeddingProvider: fixtureProvider() } : {}),
  });
  await memory.addMany(
    Array.from({ length: totalRows }, (_entry, index) => ({
      profileId: input.profileId,
      kind: "fact" as const,
      content: rowContent(index),
      confidence: 0.9,
      createdAt: `2026-07-06T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      metadata: rowMetadata(index, input.sourceScoped),
    })),
  );
  for (let index = 0; index < 3; index += 1) {
    await memory.ingestConversation({
      profileId: input.profileId,
      messages: [{
        role: "user",
        content: `NeedleMarker dense session ${index}.`,
        createdAt: `2026-07-07T0${index}:00:00.000Z`,
        metadata: { sessionId: `dense-session-${index}` },
      }],
      extraction: { extractFromRoles: [] },
      sessionDistillation: true,
    });
  }
  await store.rebuildAssociations({ profileId: input.profileId });
  const request = {
    profileId: input.profileId,
    query: "What did Avery say about the launch recall NeedleMarker?",
    maxMemories: 200,
    maxSteps: 8,
    maxBranch: 10,
    contextBudgetTokens: 16000,
    maxCharsPerMemory: 80,
    episodeExpansion: input.episodeExpansion,
    layerPolicy: { summaryMinShare: 0.3, turnMaxShare: 0.4 },
    stopWhenEvidenceEnough: true,
    retrieval: { embedQuery: input.withEmbedding },
  } as const;
  const context = await memory.reconstructContext(request);
  const enumerationContext = await memory.reconstructContext({
    ...request,
    query: "List all EnumerationSupplyKey dated instances.",
  });
  await memory.close();
  const directCount = countMemories(context.memories, /NeedleMarker/u);
  const broadCount = countMemories(context.memories, /broad eligible/iu);
  return { context, enumerationContext, directCount, broadCount };
}

function countMemories(memories: MemoryRecord[], pattern: RegExp): number {
  return memories.filter((memory) => pattern.test(memory.content)).length;
}

const lexicalBaseline = await runScenario({
  profileId: "wide-saturation-lexical-baseline-real-shape",
  withEmbedding: false,
  sourceScoped: false,
  episodeExpansion: "off",
});
const sourceLexical = await runScenario({
  profileId: "wide-saturation-source-lexical-real-shape",
  withEmbedding: false,
  sourceScoped: true,
  episodeExpansion: "adjacent",
});
const embedding = await runScenario({
  profileId: "wide-saturation-embedding-real-shape",
  withEmbedding: true,
  sourceScoped: true,
  episodeExpansion: "adjacent",
});

const result = {
  lexicalBaseline: {
    retrieved: lexicalBaseline.context.memories.length,
    direct: lexicalBaseline.directCount,
    broad: lexicalBaseline.broadCount,
    promptTokens: lexicalBaseline.context.stats.promptTokenEstimate,
  },
  sourceLexical: {
    retrieved: sourceLexical.context.memories.length,
    direct: sourceLexical.directCount,
    broad: sourceLexical.broadCount,
    promptTokens: sourceLexical.context.stats.promptTokenEstimate,
  },
  embedding: {
    retrieved: embedding.context.memories.length,
    direct: embedding.directCount,
    broad: embedding.broadCount,
    promptTokens: embedding.context.stats.promptTokenEstimate,
  },
  maxBranch: embedding.context.plannerTrace?.maxBranch ?? null,
  embeddingSelectedBranches:
    embedding.context.plannerTrace?.steps.map((step) => ({
      cueReason: step.cueReason,
      selectedBranchCount: step.selectedBranchCount,
      hybridCandidateCount: step.hybridCandidateCount ?? null,
    })) ?? [],
};
if (["wide-saturation-fixture.ts", "wide-saturation-fixture.js"].includes(path.basename(process.argv[1] ?? ""))) {
  console.log(JSON.stringify(result, null, 2));
}

assert.equal(lexicalBaseline.context.memories.length >= 150, true);
assert.equal(sourceLexical.context.memories.length, lexicalBaseline.context.memories.length);
assert.equal(embedding.context.memories.length, lexicalBaseline.context.memories.length);
assert.equal(embedding.broadCount > (embedding.context.plannerTrace?.maxBranch ?? 10), true);
for (const context of [lexicalBaseline.context, sourceLexical.context, embedding.context]) {
  const memoryIndex = context.contextBlock.indexOf("Memory content:");
  const pathIndex = context.contextBlock.indexOf("Reconstructed evidence paths:");
  assert.equal(memoryIndex >= 0 && memoryIndex < pathIndex, true);
  assert.equal(context.contextBlock.slice(0, 4000).includes("Memory content:"), true);
  assert.equal((context.stats.layers?.included.summary ?? 0) > 0, true);
  assert.equal(context.stats.evidenceConvergence.reached, true);
  assert.equal(context.stats.exploredCueCount < 8, true);
  assert.equal(context.contextBlock.length > 10_000, true);
  assert.equal(context.stats.promptTokenEstimate <= 16000, true);
  assert.equal(
    context.contextBlock.slice(0, 100_000).includes("NeedleMarker distilled session summary"),
    true,
  );
}
for (const { enumerationContext } of [lexicalBaseline, sourceLexical, embedding]) {
  assert.equal(enumerationContext.memories.length >= 100, true);
  for (let index = 0; index < 10; index += 1) {
    assert.match(
      enumerationContext.contextBlock,
      new RegExp(`EnumerationSupplyKey dated instance ${index} `, "u"),
    );
  }
}
rmSync(tmp, { recursive: true, force: true });
