import { createHostAdapter } from "../host/index.js";
import { createMemoryMcpServer } from "../mcp/index.js";
import { createMemoryOS } from "../runtime/create-memory-os.js";
import { createSqliteMemoryStore } from "../store/sqlite/index.js";
import { coverageMatrix, memoryStackCoverage, roadmap } from "./coverage.js";
export { renderMemoryGymMarkdown, renderMemoryScaleMarkdown } from "./report.js";
export { runMemoryScaleBenchmark } from "./scale.js";
export type { MemoryScaleBenchmarkResult } from "./scale.js";
export type * from "./types.js";
import type { MemoryGymGateResult, MemoryGymResult, MemoryGymScenarioResult } from "./types.js";

interface MutableGymResult extends MemoryGymResult {
  hardGates: Record<string, boolean>;
  gateResults: MemoryGymGateResult[];
  details: string[];
  scenarios: MemoryGymScenarioResult[];
}

interface NormalizedRunMemoryGymOptions {
  dbPath: string;
  generatedSeeds: string[];
}

function createEmptyResult(options: NormalizedRunMemoryGymOptions): MutableGymResult {
  return {
    pass: false,
    score: 0,
    framework: "complete memory system benchmark framework",
    deterministicArchitectureResult: {
      status: "not_run",
      score: null,
      gate: "ci_pr",
    },
    agentMemoryUseResult: {
      status: "not_run",
      score: null,
      gate: "nightly_release_signal",
    },
    generalizationResult: {
      status: "not_run",
      devScore: 0,
      holdoutScore: 0,
      generatedMean: 0,
      generatedStd: 0,
      generatedSeedCount: options.generatedSeeds.length,
      adversarialScore: 0,
      generalizationGap: 0,
    },
    roadmapResult: {
      status: "clear",
      suggestions: [],
    },
    stage5ReadinessView: 0,
    releaseConfidence: "action_required",
    hardGates: {},
    gateResults: [],
    details: [],
    scenarios: [],
    coverageMatrix: [],
    memoryStackCoverage: [],
    runManifest: {
      framework: "gmos-memory-gym",
      startedAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      dbPathMode: options.dbPath === ":memory:" ? "memory" : "file",
      generatedSeeds: options.generatedSeeds,
      deterministicOnly: true,
    },
  };
}

function scoreBooleans(values: boolean[]): number {
  if (values.length === 0) return 0;
  return values.filter(Boolean).length / values.length;
}

function scoreScenarios(
  scenarios: MemoryGymScenarioResult[],
  group: MemoryGymScenarioResult["group"],
): number {
  return scoreBooleans(scenarios.filter((scenario) => scenario.group === group).map((scenario) => scenario.pass));
}

function std(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function gate(
  result: MutableGymResult,
  name: string,
  passed: boolean,
  detail: string,
  layer: string,
): void {
  result.hardGates[name] = passed;
  result.gateResults.push({ name, passed, detail, layer });
  result.details.push(`${passed ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

function scenario(
  result: MutableGymResult,
  name: string,
  group: MemoryGymScenarioResult["group"],
  gates: string[],
): void {
  result.scenarios.push({
    name,
    group,
    gates,
    pass: gates.every((gateName) => result.hardGates[gateName] === true),
  });
}

function generatedSeedNames(raw: number | string[] | undefined): string[] {
  if (Array.isArray(raw)) {
    if (raw.length === 0 || raw.some((seed) => seed.trim().length === 0)) {
      throw new Error("generatedSeeds must be a positive integer or non-empty string array");
    }
    return raw;
  }
  const count = raw ?? 3;
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error("generatedSeeds must be a positive integer or non-empty string array");
  }
  return Array.from({ length: count }, (_, index) => `generated-${index + 1}`);
}

export interface RunMemoryGymOptions {
  dbPath?: string | undefined;
  generatedSeeds?: number | string[] | undefined;
}

export async function runMemoryGym(options: RunMemoryGymOptions = {}): Promise<MemoryGymResult> {
  const normalized: NormalizedRunMemoryGymOptions = {
    dbPath: options.dbPath ?? ":memory:",
    generatedSeeds: generatedSeedNames(options.generatedSeeds),
  };
  const store = createSqliteMemoryStore({ path: normalized.dbPath });
  const memory = createMemoryOS({ profileId: "gym", store });
  const result = createEmptyResult(normalized);

  try {
  await memory.observe({
    type: "conversation.message",
    profileId: "gym",
    role: "user",
    content: "我喜欢简洁的中文回答。",
    createdAt: "2026-06-25T00:00:00.000Z",
  });
  const preference = await memory.prepareTurn({
    profileId: "gym",
    messages: [{ role: "user", content: "你之后怎么回答我？" }],
  });
  gate(
    result,
    "preference_recall",
    preference.contextBlock.includes("简洁的中文回答"),
    "preference memory should enter ordinary context",
    "runtime",
  );
  scenario(result, "preference_recall", "dev", ["preference_recall"]);

  await memory.observe({
    type: "conversation.message",
    profileId: "gym",
    role: "user",
    content: "以后不要再提醒我 Alpha 项目延期了。",
    createdAt: "2026-06-25T00:01:00.000Z",
  });
  const boundary = await memory.prepareTurn({
    profileId: "gym",
    messages: [{ role: "user", content: "Alpha 项目怎么样？" }],
  });
  gate(
    result,
    "do_not_push_policy",
    boundary.directives.some((directive) => directive.includes("Alpha 项目延期")),
    "boundary should become an action directive",
    "context_action",
  );
  scenario(result, "do_not_push_policy", "dev", ["do_not_push_policy"]);

  await memory.observe({
    type: "conversation.message",
    profileId: "gym",
    role: "user",
    content: "我的 API key 是 sk-test1234567890abcdefg，请记住。",
    createdAt: "2026-06-25T00:02:00.000Z",
  });
  const secret = await memory.prepareTurn({
    profileId: "gym",
    messages: [{ role: "user", content: "API key 是什么？" }],
    includeSensitive: true,
    includeEvidence: true,
  });
  gate(
    result,
    "secret_like_persistence",
    !secret.contextBlock.includes("sk-test"),
    "secret-like content must not be persisted or injected",
    "safety",
  );

  await memory.observe({
    type: "conversation.message",
    profileId: "gym",
    role: "user",
    content: "我的 SSN 是 123-45-6789，不要再提醒我。",
    createdAt: "2026-06-25T00:02:30.000Z",
  });
  const sensitivePolicy = await memory.prepareTurn({
    profileId: "gym",
    messages: [{ role: "user", content: "SSN 提醒策略是什么？" }],
  });
  gate(
    result,
    "sensitive_action_policy_exposure",
    !sensitivePolicy.contextBlock.includes("123-45-6789"),
    "sensitive boundary/action policy should not enter ordinary context",
    "safety",
  );

  await memory.observe({
    type: "conversation.message",
    profileId: "gym",
    role: "user",
    content: "我住在一个临时地址，不要长期记。",
    privacyMode: "incognito",
    createdAt: "2026-06-25T00:03:00.000Z",
  });
  const incognito = await memory.prepareTurn({
    profileId: "gym",
    messages: [{ role: "user", content: "临时地址是什么？" }],
  });
  gate(
    result,
    "incognito_leakage",
    !incognito.contextBlock.includes("临时地址"),
    "incognito events should not become long-term memory",
    "safety",
  );
  scenario(result, "privacy_safety", "adversarial", [
    "secret_like_persistence",
    "sensitive_action_policy_exposure",
    "incognito_leakage",
  ]);

  const mcp = createMemoryMcpServer(memory);
  const mcpTool = mcp.listTools().find((tool) => tool.name === "memory.prepare_context");
  const mcpSensitive = await mcp.callTool("memory.prepare_context", {
    profileId: "gym",
    text: "SSN 提醒策略",
    includeSensitive: true,
  });
  gate(
    result,
    "mcp_public_sensitive_rejection",
    !Object.hasOwn(mcpTool?.inputSchema.properties ?? {}, "includeSensitive") &&
      mcpSensitive.isError === true &&
      !JSON.stringify(mcpSensitive.structuredContent).includes("123-45-6789"),
    "public MCP prepare_context must not expose sensitive override",
    "mcp_host",
  );
  scenario(result, "mcp_public_boundary", "adversarial", ["mcp_public_sensitive_rejection"]);

  await memory.observe({
    type: "conversation.message",
    profileId: "gym",
    role: "user",
    content: "我在 Moonbase 项目做发布管理。",
    createdAt: "2026-06-25T00:04:00.000Z",
  });
  const forgot = await memory.forget({ profileId: "gym", query: "Moonbase" });
  const afterForget = await memory.prepareTurn({
    profileId: "gym",
    messages: [{ role: "user", content: "Moonbase 项目我做什么？" }],
  });
  gate(
    result,
    "forget_compliance",
    forgot.archivedMemoryIds.length > 0 && !afterForget.contextBlock.includes("Moonbase"),
    "forget should archive matching memory and remove it from context",
    "safety",
  );
  scenario(result, "forget_compliance", "dev", ["forget_compliance"]);

  await store.recordEvidence({
    profileId: "gym",
    eventKey: "idempotent:evidence",
    sourceType: "test",
    content: "idempotent evidence event",
    sensitivity: "normal",
    eligibleForLongTermMemory: true,
  });
  const beforeEvidenceReplay = await store.rowCounts();
  await store.recordEvidence({
    profileId: "gym",
    eventKey: "idempotent:evidence",
    sourceType: "test",
    content: "idempotent evidence event replay",
    sensitivity: "normal",
    eligibleForLongTermMemory: true,
  });
  const afterEvidenceReplay = await store.rowCounts();
  gate(
    result,
    "evidence_idempotency",
    beforeEvidenceReplay.gmos_evidence_events === afterEvidenceReplay.gmos_evidence_events,
    "replaying the same evidence event key must not duplicate evidence rows",
    "architecture",
  );

  const before = await store.rowCounts();
  await memory.prepareTurn({
    profileId: "gym",
    messages: [{ role: "user", content: "只读检查" }],
  });
  const after = await store.rowCounts();
  gate(
    result,
    "read_path_side_effects",
    JSON.stringify(before) === JSON.stringify(after),
    "prepareTurn must not write",
    "architecture",
  );
  scenario(result, "architecture_invariants", "dev", [
    "evidence_idempotency",
    "read_path_side_effects",
  ]);

  await memory.recordFeedback({
    profileId: "gym",
    content: "刚才召回了错误记忆。",
    failureKind: "wrong_recall",
  });
  const counts = await store.rowCounts();
  gate(
    result,
    "feedback_failure_log",
    counts.gmos_failure_events === 1,
    "feedback should enter failure log",
    "feedback",
  );
  scenario(result, "feedback_failure_log", "dev", ["feedback_failure_log"]);

  await memory.observe({
    type: "conversation.message",
    profileId: "holdout",
    role: "user",
    content: "I prefer risk-first release notes.",
    createdAt: "2026-06-25T00:05:00.000Z",
  });
  const holdout = await memory.prepareTurn({
    profileId: "holdout",
    messages: [{ role: "user", content: "risk-first release notes" }],
  });
  gate(
    result,
    "holdout_preference_recall",
    holdout.contextBlock.includes("risk-first release notes"),
    "holdout preference should be retrievable without fixture-specific code",
    "generalization",
  );
  scenario(result, "holdout_preference_recall", "holdout", ["holdout_preference_recall"]);

  const generatedScores: number[] = [];
  for (const seed of normalized.generatedSeeds) {
    const profileId = `gym_${seed}`;
    const content = `I prefer ${seed} risk-first project notes.`;
    await memory.observe({
      type: "conversation.message",
      profileId,
      role: "user",
      content,
    });
    const generated = await memory.prepareTurn({
      profileId,
      messages: [{ role: "user", content: `${seed} risk-first` }],
    });
    const gateName = `generated_recall_${seed}`;
    const passed = generated.contextBlock.includes(content);
    gate(
      result,
      gateName,
      passed,
      `${seed} generated preference should be retrievable`,
      "generalization",
    );
    generatedScores.push(passed ? 1 : 0);
    scenario(result, gateName, "generated", [gateName]);
  }

  const hostCompatibility = createHostAdapter({
    hostId: "sdk-memory-gym",
    capabilities: {
      canObserveConversation: true,
      canInjectSystemContext: true,
      canCommitTaskOutcomes: true,
      canRecordUserFeedback: true,
      canForget: true,
      supportsEvidenceInContext: true,
      supportsActionPolicies: false,
      canEnforceHardDirectives: false,
      canObserveToolCalls: false,
    },
  }).compatibility;
  gate(
    result,
    "host_adapter_contract",
    hostCompatibility.level === "L2" && hostCompatibility.hardGateCoverage.forgetCompliance === true,
    "MCP-style host compatibility should be explicit and bounded",
    "mcp_host",
  );

  const gateValues = Object.values(result.hardGates);
  result.score = scoreBooleans(gateValues);
  result.pass = result.score === 1;
  result.stage5ReadinessView = result.score;
  result.deterministicArchitectureResult = {
    status: result.pass ? "pass" : "fail",
    score: result.score,
    gate: "ci_pr",
  };
  result.generalizationResult = {
    status: result.scenarios.every(
      (entry) =>
        (entry.group !== "holdout" && entry.group !== "generated" && entry.group !== "adversarial") ||
        entry.pass,
    )
      ? "pass"
      : "fail",
    devScore: scoreScenarios(result.scenarios, "dev"),
    holdoutScore: scoreScenarios(result.scenarios, "holdout"),
    generatedMean: generatedScores.length === 0 ? 0 : generatedScores.reduce((sum, value) => sum + value, 0) / generatedScores.length,
    generatedStd: std(generatedScores),
    generatedSeedCount: generatedScores.length,
    adversarialScore: scoreScenarios(result.scenarios, "adversarial"),
    generalizationGap: 0,
  };
  result.generalizationResult.generalizationGap = Math.max(
    0,
    result.generalizationResult.devScore -
      Math.min(
        result.generalizationResult.holdoutScore,
        result.generalizationResult.generatedMean,
        result.generalizationResult.adversarialScore,
      ),
  );
  result.roadmapResult = roadmap(result);
  result.releaseConfidence = result.pass ? "deterministic_internal_gate_only" : "action_required";
  result.coverageMatrix = coverageMatrix(result);
  result.memoryStackCoverage = memoryStackCoverage(result);
  return result;
  } finally {
    await memory.close();
  }
}
