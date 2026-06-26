import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  MemoryKind,
  PrivacyMode,
  ReconstructedContext,
  Sensitivity,
  TurnMessage,
} from "../kernel/types.js";
import { readGmosPackageInfo } from "../kernel/package-info.js";
import { createMemoryOS } from "../runtime/create-memory-os.js";
import { createSqliteMemoryStore } from "../store/sqlite/index.js";

export type ExternalMemoryBenchmarkMode = "prepare" | "reconstruct";

export interface ExternalMemoryBenchmarkMessageEvent {
  type?: "message" | undefined;
  role?: TurnMessage["role"] | undefined;
  content: string;
  createdAt?: string | undefined;
  privacyMode?: PrivacyMode | undefined;
}

export interface ExternalMemoryBenchmarkTaskEvent {
  type: "task";
  taskId?: string | undefined;
  objective: string;
  status: "completed" | "failed";
  summary?: string | undefined;
  createdAt?: string | undefined;
}

export interface ExternalMemoryBenchmarkMemoryEvent {
  type: "memory";
  kind: MemoryKind;
  content: string;
  confidence?: number | undefined;
  sensitivity?: Sensitivity | undefined;
  createdAt?: string | undefined;
}

export type ExternalMemoryBenchmarkEvent =
  | ExternalMemoryBenchmarkMessageEvent
  | ExternalMemoryBenchmarkMemoryEvent
  | ExternalMemoryBenchmarkTaskEvent;

export interface ExternalMemoryBenchmarkCase {
  id?: string | undefined;
  profileId?: string | undefined;
  mode?: ExternalMemoryBenchmarkMode | undefined;
  events: ExternalMemoryBenchmarkEvent[];
  question: string;
  expectedAny?: string[] | undefined;
  expectedAll?: string[] | undefined;
  forbiddenAny?: string[] | undefined;
  requireConvergence?: boolean | undefined;
}

export interface ExternalMemoryBenchmarkCaseDiagnostics {
  evidenceCoverageRate: number | null;
  evidenceConvergenceScore: number | null;
  evidenceConvergenceReached: boolean | null;
  missingRequiredIntentGroups: string[];
  uncertaintyLevel: "low" | "medium" | "high" | null;
  uncertaintyReasons: string[];
}

export interface ExternalMemoryBenchmarkCaseResult {
  id: string;
  pass: boolean;
  mode: ExternalMemoryBenchmarkMode;
  requireConvergence: boolean;
  expectedAnyMatched: string[];
  expectedAnyMissing: string[];
  expectedAllMissing: string[];
  forbiddenMatches: string[];
  failureReasons: string[];
  warnings: string[];
  diagnostics: ExternalMemoryBenchmarkCaseDiagnostics;
  promptTokenEstimate: number;
  retrievedMemoryCount: number;
  reconstructedPathCount: number;
}

export interface ExternalMemoryBenchmarkRunManifest {
  framework: "gmos-external-long-memory-qa";
  startedAt: string;
  finishedAt: string;
  node: string;
  platform: string;
  package: {
    name: string | null;
    version: string | null;
  };
  git: {
    branch: string | null;
    sha: string | null;
    dirty: boolean | null;
  };
  dataset: {
    format: "gmos.external_long_memory_qa.jsonl";
    caseCount: number;
    hash: string | null;
    id: string | null;
  };
  options: {
    mode: ExternalMemoryBenchmarkMode | null;
    maxSteps: number | null;
    maxBranch: number | null;
    maxMemories: number | null;
    contextBudgetTokens: number | null;
    requireConvergence: boolean;
  };
  deterministicOnly: true;
}

export interface ExternalMemoryBenchmarkResult {
  schema: "gmos.external_long_memory_qa.v1";
  pass: boolean;
  datasetFormat: "gmos.external_long_memory_qa.jsonl";
  caseCount: number;
  passedCount: number;
  failedCount: number;
  score: number;
  runManifest: ExternalMemoryBenchmarkRunManifest;
  cases: ExternalMemoryBenchmarkCaseResult[];
}

export interface RunExternalMemoryBenchmarkOptions {
  cases: ExternalMemoryBenchmarkCase[];
  datasetHash?: string | undefined;
  datasetId?: string | undefined;
  mode?: ExternalMemoryBenchmarkMode | undefined;
  maxSteps?: number | undefined;
  maxBranch?: number | undefined;
  maxMemories?: number | undefined;
  contextBudgetTokens?: number | undefined;
  requireConvergence?: boolean | undefined;
}

export function hashExternalMemoryBenchmarkInput(input: string): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

function stringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`External benchmark ${field} must be an array of strings`);
  }
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function normalizeMode(value: unknown): ExternalMemoryBenchmarkMode | undefined {
  if (value === undefined) return undefined;
  if (value !== "prepare" && value !== "reconstruct") {
    throw new Error("External benchmark mode must be prepare or reconstruct");
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`External benchmark ${field} must be a boolean`);
  return value;
}

function parseEvent(value: unknown, caseId: string): ExternalMemoryBenchmarkEvent {
  if (typeof value !== "object" || value === null) {
    throw new Error(`External benchmark case ${caseId} events must be objects`);
  }
  const event = value as Record<string, unknown>;
  if (event.type === "memory") {
    if (
      event.kind !== "fact" &&
      event.kind !== "preference" &&
      event.kind !== "boundary" &&
      event.kind !== "procedure" &&
      event.kind !== "project" &&
      event.kind !== "task_trajectory"
    ) {
      throw new Error(`External benchmark case ${caseId} memory event kind is invalid`);
    }
    if (typeof event.content !== "string" || event.content.trim().length === 0) {
      throw new Error(`External benchmark case ${caseId} memory event requires content`);
    }
    const sensitivity = event.sensitivity;
    if (
      sensitivity !== undefined &&
      sensitivity !== "normal" &&
      sensitivity !== "sensitive" &&
      sensitivity !== "secret_like"
    ) {
      throw new Error(`External benchmark case ${caseId} memory event sensitivity is invalid`);
    }
    const confidence = event.confidence;
    if (confidence !== undefined && (typeof confidence !== "number" || !Number.isFinite(confidence))) {
      throw new Error(`External benchmark case ${caseId} memory event confidence must be finite`);
    }
    const memorySensitivity = sensitivity as Sensitivity | undefined;
    return {
      type: "memory",
      kind: event.kind,
      content: event.content,
      ...(typeof confidence === "number" ? { confidence } : {}),
      ...(memorySensitivity !== undefined ? { sensitivity: memorySensitivity } : {}),
      ...(typeof event.createdAt === "string" ? { createdAt: event.createdAt } : {}),
    };
  }
  if (event.type === "task") {
    if (typeof event.objective !== "string" || event.objective.trim().length === 0) {
      throw new Error(`External benchmark case ${caseId} task event requires objective`);
    }
    if (event.status !== "completed" && event.status !== "failed") {
      throw new Error(`External benchmark case ${caseId} task event status must be completed or failed`);
    }
    return {
      type: "task",
      objective: event.objective,
      status: event.status,
      ...(typeof event.taskId === "string" ? { taskId: event.taskId } : {}),
      ...(typeof event.summary === "string" ? { summary: event.summary } : {}),
      ...(typeof event.createdAt === "string" ? { createdAt: event.createdAt } : {}),
    };
  }
  if (event.type !== undefined && event.type !== "message") {
    throw new Error(`External benchmark case ${caseId} event type must be message, memory, or task`);
  }
  if (typeof event.content !== "string" || event.content.trim().length === 0) {
    throw new Error(`External benchmark case ${caseId} message event requires content`);
  }
  const role = event.role ?? "user";
  if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
    throw new Error(`External benchmark case ${caseId} message event role is invalid`);
  }
  const privacyMode = event.privacyMode;
  if (privacyMode !== undefined && privacyMode !== "normal" && privacyMode !== "incognito") {
    throw new Error(`External benchmark case ${caseId} message event privacyMode is invalid`);
  }
  return {
    type: "message",
    role,
    content: event.content,
    ...(typeof event.createdAt === "string" ? { createdAt: event.createdAt } : {}),
    ...(privacyMode !== undefined ? { privacyMode } : {}),
  };
}

function normalizeCase(value: unknown, index: number): ExternalMemoryBenchmarkCase {
  if (typeof value !== "object" || value === null) {
    throw new Error(`External benchmark case ${index + 1} must be an object`);
  }
  const row = value as Record<string, unknown>;
  const id = typeof row.id === "string" && row.id.trim() ? row.id.trim() : `case-${index + 1}`;
  if (!Array.isArray(row.events) || row.events.length === 0) {
    throw new Error(`External benchmark case ${id} requires non-empty events`);
  }
  if (typeof row.question !== "string" || row.question.trim().length === 0) {
    throw new Error(`External benchmark case ${id} requires question`);
  }
  if (row.profileId !== undefined && (typeof row.profileId !== "string" || !row.profileId.trim())) {
    throw new Error(`External benchmark case ${id} profileId must be a non-empty string`);
  }
  const mode = normalizeMode(row.mode);
  const expectedAny = stringArray(row.expectedAny, `${id}.expectedAny`);
  const expectedAll = stringArray(row.expectedAll, `${id}.expectedAll`);
  const forbiddenAny = stringArray(row.forbiddenAny, `${id}.forbiddenAny`);
  const requireConvergence = optionalBoolean(row.requireConvergence, `${id}.requireConvergence`);
  if (
    (expectedAny?.length ?? 0) === 0 &&
    (expectedAll?.length ?? 0) === 0 &&
    (forbiddenAny?.length ?? 0) === 0
  ) {
    throw new Error(`External benchmark case ${id} requires at least one expected or forbidden assertion`);
  }
  return {
    id,
    ...(typeof row.profileId === "string" && row.profileId.trim() ? { profileId: row.profileId.trim() } : {}),
    ...(mode ? { mode } : {}),
    events: row.events.map((event) => parseEvent(event, id)),
    question: row.question,
    ...(expectedAny ? { expectedAny } : {}),
    ...(expectedAll ? { expectedAll } : {}),
    ...(forbiddenAny ? { forbiddenAny } : {}),
    ...(requireConvergence !== undefined ? { requireConvergence } : {}),
  };
}

export function parseExternalMemoryBenchmarkJsonl(input: string): ExternalMemoryBenchmarkCase[] {
  const cases: ExternalMemoryBenchmarkCase[] = [];
  for (const [index, rawLine] of input.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`External benchmark JSONL line ${index + 1} is invalid JSON: ${(error as Error).message}`);
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`External benchmark JSONL line ${index + 1} must be an object`);
    }
    cases.push(normalizeCase(parsed, cases.length));
  }
  if (cases.length === 0) {
    throw new Error("External benchmark JSONL requires at least one case");
  }
  return cases;
}

function includesTerm(haystack: string, term: string): boolean {
  return haystack.toLowerCase().includes(term.toLowerCase());
}

function reconstructionDiagnostics(
  reconstructed: ReconstructedContext | null,
): ExternalMemoryBenchmarkCaseDiagnostics {
  return {
    evidenceCoverageRate: reconstructed?.stats.evidenceCoverage?.coverageRate ?? null,
    evidenceConvergenceScore: reconstructed?.stats.evidenceConvergence?.score ?? null,
    evidenceConvergenceReached: reconstructed?.stats.evidenceConvergence?.reached ?? null,
    missingRequiredIntentGroups:
      reconstructed?.stats.evidenceConvergence?.missingRequiredIntentGroups ?? [],
    uncertaintyLevel: reconstructed?.stats.uncertainty?.level ?? null,
    uncertaintyReasons: reconstructed?.stats.uncertainty?.reasons ?? [],
  };
}

function failureReasonsForCase(input: {
  expectedAnyMissing: string[];
  expectedAllMissing: string[];
  forbiddenMatches: string[];
  requireConvergence: boolean;
  diagnostics: ExternalMemoryBenchmarkCaseDiagnostics;
}): string[] {
  const reasons: string[] = [];
  if (input.expectedAnyMissing.length > 0) reasons.push("expected_any_missing");
  if (input.expectedAllMissing.length > 0) reasons.push("expected_all_missing");
  if (input.forbiddenMatches.length > 0) reasons.push("forbidden_match");
  if (input.requireConvergence && input.diagnostics.evidenceConvergenceReached !== true) {
    reasons.push("convergence_not_reached");
  }
  return reasons;
}

function warningsForCase(input: {
  mode: ExternalMemoryBenchmarkMode;
  diagnostics: ExternalMemoryBenchmarkCaseDiagnostics;
}): string[] {
  if (input.mode !== "reconstruct") return [];
  const warnings: string[] = [];
  if (input.diagnostics.evidenceConvergenceReached === false) {
    warnings.push("convergence_not_reached");
  }
  if (input.diagnostics.uncertaintyLevel === "high") {
    warnings.push("high_uncertainty");
  } else if (input.diagnostics.uncertaintyLevel === "medium") {
    warnings.push("medium_uncertainty");
  }
  if (input.diagnostics.missingRequiredIntentGroups.length > 0) {
    warnings.push("missing_intent_groups");
  }
  return warnings;
}

function gitText(args: string[]): string | null {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function gitInfo(): ExternalMemoryBenchmarkRunManifest["git"] {
  const status = gitText(["status", "--porcelain"]);
  return {
    branch: gitText(["rev-parse", "--abbrev-ref", "HEAD"]),
    sha: gitText(["rev-parse", "HEAD"]),
    dirty: status === null ? null : status.length > 0,
  };
}

function createRunManifest(input: {
  startedAt: string;
  finishedAt: string;
  caseCount: number;
  options: RunExternalMemoryBenchmarkOptions;
}): ExternalMemoryBenchmarkRunManifest {
  const packageInfo = readGmosPackageInfo();
  return {
    framework: "gmos-external-long-memory-qa",
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    package: {
      name: packageInfo.name,
      version: packageInfo.version,
    },
    git: gitInfo(),
    dataset: {
      format: "gmos.external_long_memory_qa.jsonl",
      caseCount: input.caseCount,
      hash: input.options.datasetHash ?? null,
      id: input.options.datasetId ?? null,
    },
    options: {
      mode: input.options.mode ?? null,
      maxSteps: input.options.maxSteps ?? null,
      maxBranch: input.options.maxBranch ?? null,
      maxMemories: input.options.maxMemories ?? null,
      contextBudgetTokens: input.options.contextBudgetTokens ?? null,
      requireConvergence: input.options.requireConvergence ?? false,
    },
    deterministicOnly: true,
  };
}

async function runCase(input: {
  benchmarkCase: ExternalMemoryBenchmarkCase;
  index: number;
  options: RunExternalMemoryBenchmarkOptions;
}): Promise<ExternalMemoryBenchmarkCaseResult> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "gmos-external-benchmark-"));
  const store = createSqliteMemoryStore({ path: path.join(tmp, "case.db") });
  const memory = createMemoryOS({ profileId: "external", store });
  const id = input.benchmarkCase.id ?? `case-${input.index + 1}`;
  const profileId = input.benchmarkCase.profileId ?? `external_${id}`;
  const mode = input.benchmarkCase.mode ?? input.options.mode ?? "reconstruct";
  const requireConvergence =
    input.benchmarkCase.requireConvergence ?? input.options.requireConvergence ?? false;
  try {
    await store.initialize();
    for (const event of input.benchmarkCase.events) {
      if (event.type === "task") {
        await memory.commitOutcome({
          profileId,
          taskId: event.taskId,
          objective: event.objective,
          status: event.status,
          summary: event.summary,
          createdAt: event.createdAt,
        });
      } else if (event.type === "memory") {
        await memory.add({
          profileId,
          kind: event.kind,
          content: event.content,
          confidence: event.confidence,
          sensitivity: event.sensitivity,
          createdAt: event.createdAt,
        });
      } else {
        await memory.observe({
          type: "conversation.message",
          profileId,
          role: event.role ?? "user",
          content: event.content,
          privacyMode: event.privacyMode,
          createdAt: event.createdAt,
        });
      }
    }
    const prepared =
      mode === "prepare"
        ? await memory.prepareTurn({
            profileId,
            messages: [{ role: "user", content: input.benchmarkCase.question }],
            contextBudgetTokens: input.options.contextBudgetTokens,
          })
        : null;
    const reconstructed =
      mode === "reconstruct"
        ? await memory.reconstructContext({
            profileId,
            query: input.benchmarkCase.question,
            maxSteps: input.options.maxSteps,
            maxBranch: input.options.maxBranch,
            maxMemories: input.options.maxMemories,
            contextBudgetTokens: input.options.contextBudgetTokens,
          })
        : null;
    const context = prepared?.contextBlock ?? reconstructed?.contextBlock ?? "";
    const expectedAny = input.benchmarkCase.expectedAny ?? [];
    const expectedAll = input.benchmarkCase.expectedAll ?? [];
    const forbiddenAny = input.benchmarkCase.forbiddenAny ?? [];
    const expectedAnyMatched = expectedAny.filter((term) => includesTerm(context, term));
    const expectedAllMissing = expectedAll.filter((term) => !includesTerm(context, term));
    const forbiddenMatches = forbiddenAny.filter((term) => includesTerm(context, term));
    const expectedAnyMissing =
      expectedAny.length > 0 && expectedAnyMatched.length === 0 ? expectedAny : [];
    const diagnostics = reconstructionDiagnostics(reconstructed);
    const failureReasons = failureReasonsForCase({
      expectedAnyMissing,
      expectedAllMissing,
      forbiddenMatches,
      requireConvergence: mode === "reconstruct" && requireConvergence,
      diagnostics,
    });
    const warnings = warningsForCase({ mode, diagnostics });
    return {
      id,
      pass: failureReasons.length === 0,
      mode,
      requireConvergence: mode === "reconstruct" && requireConvergence,
      expectedAnyMatched,
      expectedAnyMissing,
      expectedAllMissing,
      forbiddenMatches,
      failureReasons,
      warnings,
      diagnostics,
      promptTokenEstimate:
        prepared?.stats.promptTokenEstimate ?? reconstructed?.stats.promptTokenEstimate ?? 0,
      retrievedMemoryCount:
        prepared?.stats.retrievedMemoryCount ?? reconstructed?.stats.retrievedMemoryCount ?? 0,
      reconstructedPathCount: reconstructed?.paths.length ?? 0,
    };
  } finally {
    await memory.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function runExternalMemoryBenchmark(
  options: RunExternalMemoryBenchmarkOptions,
): Promise<ExternalMemoryBenchmarkResult> {
  const startedAt = new Date().toISOString();
  if (!Array.isArray(options.cases) || options.cases.length === 0) {
    throw new Error("External benchmark requires at least one case");
  }
  const defaultMode = normalizeMode(options.mode);
  const normalizedCases = options.cases.map((benchmarkCase, index) =>
    normalizeCase(benchmarkCase, index),
  );
  const normalizedOptions: RunExternalMemoryBenchmarkOptions = {
    ...options,
    cases: normalizedCases,
    ...(defaultMode ? { mode: defaultMode } : {}),
  };
  const cases = await Promise.all(
    normalizedCases.map((benchmarkCase, index) =>
      runCase({ benchmarkCase, index, options: normalizedOptions }),
    ),
  );
  const passedCount = cases.filter((entry) => entry.pass).length;
  const finishedAt = new Date().toISOString();
  return {
    schema: "gmos.external_long_memory_qa.v1",
    pass: passedCount === cases.length,
    datasetFormat: "gmos.external_long_memory_qa.jsonl",
    caseCount: cases.length,
    passedCount,
    failedCount: cases.length - passedCount,
    score: cases.length === 0 ? 0 : passedCount / cases.length,
    runManifest: createRunManifest({
      startedAt,
      finishedAt,
      caseCount: cases.length,
      options: normalizedOptions,
    }),
    cases,
  };
}
