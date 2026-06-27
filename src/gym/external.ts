import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  MemoryKind,
  MemoryRecord,
  MemoryOS,
  PrivacyMode,
  ReconstructedContext,
  Sensitivity,
  TurnMessage,
} from "../kernel/types.js";
import { readGmosPackageInfo } from "../kernel/package-info.js";
import { createMemoryOS } from "../runtime/create-memory-os.js";
import { createSqliteMemoryStore } from "../store/sqlite/index.js";

export type ExternalMemoryBenchmarkMode = "prepare" | "reconstruct";
export type ExternalMemoryBenchmarkDatasetFormat =
  | "gmos.external_long_memory_qa.jsonl"
  | "longmemeval.json"
  | "locomo.json";

export interface ExternalMemoryBenchmarkMessageEvent {
  type?: "message" | undefined;
  role?: TurnMessage["role"] | undefined;
  content: string;
  createdAt?: string | undefined;
  privacyMode?: PrivacyMode | undefined;
  metadata?: Record<string, unknown> | undefined;
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

export type ExternalMemoryBenchmarkFailureStage =
  | "answer_not_in_input"
  | "not_extracted_or_filtered"
  | "retrieval_policy_filtered"
  | "retrieval_or_reconstruction_miss"
  | "context_composer_or_budget_drop"
  | "forbidden_context_inclusion"
  | "reconstruction_convergence_failure";

export interface ExternalMemoryBenchmarkFailureTaxonomyEntry {
  stage: ExternalMemoryBenchmarkFailureStage;
  terms: string[];
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
  failureTaxonomy?: ExternalMemoryBenchmarkFailureTaxonomyEntry[] | undefined;
  warnings: string[];
  diagnostics: ExternalMemoryBenchmarkCaseDiagnostics;
  promptTokenEstimate: number;
  retrievedMemoryCount: number;
  reconstructedPathCount: number;
}

export interface ExternalMemoryBenchmarkCounter {
  name: string;
  count: number;
}

export interface ExternalMemoryBenchmarkFailureSample {
  id: string;
  mode: ExternalMemoryBenchmarkMode;
  failureReasons: string[];
  failureTaxonomy?: ExternalMemoryBenchmarkFailureTaxonomyEntry[] | undefined;
  warnings: string[];
  expectedAnyMissing: string[];
  expectedAllMissing: string[];
  forbiddenMatches: string[];
  missingRequiredIntentGroups: string[];
  evidenceConvergenceScore: number | null;
  evidenceConvergenceReached: boolean | null;
  uncertaintyLevel: "low" | "medium" | "high" | null;
  promptTokenEstimate: number;
  retrievedMemoryCount: number;
  reconstructedPathCount: number;
}

export interface ExternalMemoryBenchmarkSummary {
  failureReasons: ExternalMemoryBenchmarkCounter[];
  failureStages?: ExternalMemoryBenchmarkCounter[] | undefined;
  warnings: ExternalMemoryBenchmarkCounter[];
  uncertaintyLevels: {
    low: number;
    medium: number;
    high: number;
    unknown: number;
  };
  evidenceConvergence: {
    reached: number;
    notReached: number;
    unknown: number;
  };
  failureSampleLimit: number;
  failureSamples: ExternalMemoryBenchmarkFailureSample[];
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
    format: ExternalMemoryBenchmarkDatasetFormat;
    caseCount: number;
    hash: string | null;
    id: string | null;
    warnings: string[];
  };
  execution: {
    caseGroupCount: number;
    reusedProfileCaseCount: number;
  };
  options: {
    mode: ExternalMemoryBenchmarkMode | null;
    maxSteps: number | null;
    maxBranch: number | null;
    maxMemories: number | null;
    contextBudgetTokens: number | null;
    requireConvergence: boolean;
    concurrency: number;
    reuseProfiles: boolean;
    failureSampleLimit: number;
  };
  deterministicOnly: true;
}

export interface ExternalMemoryBenchmarkResult {
  schema: "gmos.external_long_memory_qa.v1";
  pass: boolean;
  datasetFormat: ExternalMemoryBenchmarkDatasetFormat;
  caseCount: number;
  passedCount: number;
  failedCount: number;
  score: number;
  summary: ExternalMemoryBenchmarkSummary;
  runManifest: ExternalMemoryBenchmarkRunManifest;
  cases: ExternalMemoryBenchmarkCaseResult[];
}

export interface RunExternalMemoryBenchmarkOptions {
  cases: ExternalMemoryBenchmarkCase[];
  datasetFormat?: ExternalMemoryBenchmarkDatasetFormat | undefined;
  datasetHash?: string | undefined;
  datasetId?: string | undefined;
  datasetWarnings?: string[] | undefined;
  mode?: ExternalMemoryBenchmarkMode | undefined;
  maxSteps?: number | undefined;
  maxBranch?: number | undefined;
  maxMemories?: number | undefined;
  contextBudgetTokens?: number | undefined;
  requireConvergence?: boolean | undefined;
  concurrency?: number | undefined;
  reuseProfiles?: boolean | undefined;
  failureSampleLimit?: number | undefined;
  onCaseResult?: ((progress: ExternalMemoryBenchmarkProgress) => void) | undefined;
}

export interface ExternalMemoryBenchmarkProgress {
  completedCount: number;
  totalCount: number;
  passedCount: number;
  failedCount: number;
  caseId: string;
  caseIndex: number;
  pass: boolean;
}

interface NormalizedCaseInput {
  benchmarkCase: ExternalMemoryBenchmarkCase;
  index: number;
}

interface CaseGroup {
  key: string;
  profileId: string;
  events: ExternalMemoryBenchmarkEvent[];
  items: NormalizedCaseInput[];
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

function optionalMetadata(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`External benchmark ${field} must be an object`);
  }
  return value as Record<string, unknown>;
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
    ...(event.metadata !== undefined ? { metadata: optionalMetadata(event.metadata, `${caseId}.event.metadata`) } : {}),
  };
}

function normalizeCase(
  value: unknown,
  index: number,
  eventCache?: WeakMap<object, ExternalMemoryBenchmarkEvent[]>,
): ExternalMemoryBenchmarkCase {
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
  let events = eventCache?.get(row.events);
  if (!events) {
    events = row.events.map((event) => parseEvent(event, id));
    eventCache?.set(row.events, events);
  }
  return {
    id,
    ...(typeof row.profileId === "string" && row.profileId.trim() ? { profileId: row.profileId.trim() } : {}),
    ...(mode ? { mode } : {}),
    events,
    question: row.question,
    ...(expectedAny ? { expectedAny } : {}),
    ...(expectedAll ? { expectedAll } : {}),
    ...(forbiddenAny ? { forbiddenAny } : {}),
    ...(requireConvergence !== undefined ? { requireConvergence } : {}),
  };
}

export function parseExternalMemoryBenchmarkJsonl(input: string): ExternalMemoryBenchmarkCase[] {
  const cases: ExternalMemoryBenchmarkCase[] = [];
  const eventCache = new WeakMap<object, ExternalMemoryBenchmarkEvent[]>();
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
    cases.push(normalizeCase(parsed, cases.length, eventCache));
  }
  if (cases.length === 0) {
    throw new Error("External benchmark JSONL requires at least one case");
  }
  return cases;
}

function includesTerm(haystack: string, term: string): boolean {
  return haystack.toLowerCase().includes(term.toLowerCase());
}

function uniqueTerms(values: string[]): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    terms.push(normalized);
  }
  return terms;
}

function eventContent(event: ExternalMemoryBenchmarkEvent): string {
  if (event.type === "task") {
    return [event.objective, event.summary ?? ""].filter(Boolean).join("\n");
  }
  return event.content;
}

function eventsContainTerm(events: ExternalMemoryBenchmarkEvent[], term: string): boolean {
  return events.some((event) => includesTerm(eventContent(event), term));
}

function memoriesContainTerm(memories: MemoryRecord[], term: string): boolean {
  return memories.some((memory) => includesTerm(memory.content, term));
}

function reconstructedPathsContainTerm(reconstructed: ReconstructedContext | null, term: string): boolean {
  return reconstructed?.paths.some((pathEntry) => includesTerm(pathEntry.targetSummary, term)) ?? false;
}

function addTaxonomyEntry(
  entries: ExternalMemoryBenchmarkFailureTaxonomyEntry[],
  stage: ExternalMemoryBenchmarkFailureStage,
  terms: string[],
): void {
  const normalizedTerms = uniqueTerms(terms);
  if (normalizedTerms.length === 0) return;
  const existing = entries.find((entry) => entry.stage === stage);
  if (existing) {
    existing.terms = uniqueTerms(existing.terms.concat(normalizedTerms));
  } else {
    entries.push({ stage, terms: normalizedTerms });
  }
}

function diagnosticContextBudgetTokens(value: number | undefined): number {
  return Math.max(20_000, (value ?? 1800) * 10);
}

function reconstructedContainsTerm(reconstructed: ReconstructedContext | null, term: string): boolean {
  if (!reconstructed) return false;
  return (
    includesTerm(reconstructed.contextBlock, term) ||
    memoriesContainTerm(reconstructed.memories, term) ||
    reconstructedPathsContainTerm(reconstructed, term)
  );
}

async function wideBudgetRunContainsTerm(input: {
  memory: MemoryOS;
  profileId: string;
  benchmarkCase: ExternalMemoryBenchmarkCase;
  mode: ExternalMemoryBenchmarkMode;
  options: RunExternalMemoryBenchmarkOptions;
  term: string;
}): Promise<boolean> {
  const contextBudgetTokens = diagnosticContextBudgetTokens(input.options.contextBudgetTokens);
  if (input.mode === "prepare") {
    const prepared = await input.memory.prepareTurn({
      profileId: input.profileId,
      messages: [{ role: "user", content: input.benchmarkCase.question }],
      contextBudgetTokens,
    });
    return includesTerm(prepared.contextBlock, input.term) || memoriesContainTerm(prepared.memories, input.term);
  }
  const reconstructed = await input.memory.reconstructContext({
    profileId: input.profileId,
    query: input.benchmarkCase.question,
    maxSteps: input.options.maxSteps,
    maxBranch: input.options.maxBranch,
    maxMemories: input.options.maxMemories,
    contextBudgetTokens,
  });
  return reconstructedContainsTerm(reconstructed, input.term);
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

async function failureTaxonomyForCase(input: {
  memory: MemoryOS;
  profileId: string;
  benchmarkCase: ExternalMemoryBenchmarkCase;
  missingExpectedTerms: string[];
  forbiddenMatches: string[];
  requireConvergence: boolean;
  mode: ExternalMemoryBenchmarkMode;
  options: RunExternalMemoryBenchmarkOptions;
  diagnostics: ExternalMemoryBenchmarkCaseDiagnostics;
  prepared: Awaited<ReturnType<MemoryOS["prepareTurn"]>> | null;
  reconstructed: ReconstructedContext | null;
}): Promise<ExternalMemoryBenchmarkFailureTaxonomyEntry[]> {
  const entries: ExternalMemoryBenchmarkFailureTaxonomyEntry[] = [];
  for (const term of uniqueTerms(input.missingExpectedTerms)) {
    if (!eventsContainTerm(input.benchmarkCase.events, term)) {
      addTaxonomyEntry(entries, "answer_not_in_input", [term]);
      continue;
    }
    const historyHits = await input.memory.search({
      profileId: input.profileId,
      query: term,
      limit: 10,
      purpose: "history",
    });
    if (!memoriesContainTerm(historyHits, term)) {
      addTaxonomyEntry(entries, "not_extracted_or_filtered", [term]);
      continue;
    }
    const contextHits = await input.memory.search({
      profileId: input.profileId,
      query: term,
      limit: 10,
      purpose: "context",
    });
    if (!memoriesContainTerm(contextHits, term)) {
      addTaxonomyEntry(entries, "retrieval_policy_filtered", [term]);
      continue;
    }
    const retrievedTermPresent =
      includesTerm(input.prepared?.contextBlock ?? "", term) ||
      reconstructedContainsTerm(input.reconstructed, term) ||
      memoriesContainTerm(input.prepared?.memories ?? [], term) ||
      memoriesContainTerm(input.reconstructed?.memories ?? [], term);
    if (retrievedTermPresent) {
      addTaxonomyEntry(entries, "context_composer_or_budget_drop", [term]);
      continue;
    }
    const wideBudgetCanRecover = await wideBudgetRunContainsTerm({
      memory: input.memory,
      profileId: input.profileId,
      benchmarkCase: input.benchmarkCase,
      mode: input.mode,
      options: input.options,
      term,
    });
    addTaxonomyEntry(
      entries,
      wideBudgetCanRecover ? "context_composer_or_budget_drop" : "retrieval_or_reconstruction_miss",
      [term],
    );
  }
  addTaxonomyEntry(entries, "forbidden_context_inclusion", input.forbiddenMatches);
  if (input.mode === "reconstruct" && input.requireConvergence && input.diagnostics.evidenceConvergenceReached !== true) {
    addTaxonomyEntry(entries, "reconstruction_convergence_failure", ["evidence_convergence"]);
  }
  return entries;
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
  caseGroupCount: number;
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
      format: input.options.datasetFormat ?? "gmos.external_long_memory_qa.jsonl",
      caseCount: input.caseCount,
      hash: input.options.datasetHash ?? null,
      id: input.options.datasetId ?? null,
      warnings: input.options.datasetWarnings ?? [],
    },
    execution: {
      caseGroupCount: input.caseGroupCount,
      reusedProfileCaseCount: Math.max(0, input.caseCount - input.caseGroupCount),
    },
    options: {
      mode: input.options.mode ?? null,
      maxSteps: input.options.maxSteps ?? null,
      maxBranch: input.options.maxBranch ?? null,
      maxMemories: input.options.maxMemories ?? null,
      contextBudgetTokens: input.options.contextBudgetTokens ?? null,
      requireConvergence: input.options.requireConvergence ?? false,
      concurrency: normalizedConcurrency(input.options.concurrency),
      reuseProfiles: input.options.reuseProfiles ?? true,
      failureSampleLimit: normalizedFailureSampleLimit(input.options.failureSampleLimit),
    },
    deterministicOnly: true,
  };
}

function normalizedConcurrency(value: number | undefined): number {
  if (value === undefined) return Math.max(1, Math.min(os.cpus().length || 1, 4));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("External benchmark concurrency must be a positive integer");
  }
  return value;
}

function normalizedFailureSampleLimit(value: number | undefined): number {
  if (value === undefined) return 20;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("External benchmark failure sample limit must be a non-negative integer");
  }
  return value;
}

function incrementCounter(map: Map<string, number>, name: string): void {
  map.set(name, (map.get(name) ?? 0) + 1);
}

function sortedCounters(map: Map<string, number>): ExternalMemoryBenchmarkCounter[] {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function failureSampleForCase(
  entry: ExternalMemoryBenchmarkCaseResult,
): ExternalMemoryBenchmarkFailureSample {
  return {
    id: entry.id,
    mode: entry.mode,
    failureReasons: entry.failureReasons,
    failureTaxonomy: entry.failureTaxonomy,
    warnings: entry.warnings,
    expectedAnyMissing: entry.expectedAnyMissing,
    expectedAllMissing: entry.expectedAllMissing,
    forbiddenMatches: entry.forbiddenMatches,
    missingRequiredIntentGroups: entry.diagnostics.missingRequiredIntentGroups,
    evidenceConvergenceScore: entry.diagnostics.evidenceConvergenceScore,
    evidenceConvergenceReached: entry.diagnostics.evidenceConvergenceReached,
    uncertaintyLevel: entry.diagnostics.uncertaintyLevel,
    promptTokenEstimate: entry.promptTokenEstimate,
    retrievedMemoryCount: entry.retrievedMemoryCount,
    reconstructedPathCount: entry.reconstructedPathCount,
  };
}

function buildExternalMemoryBenchmarkSummary(
  cases: ExternalMemoryBenchmarkCaseResult[],
  failureSampleLimit: number,
): ExternalMemoryBenchmarkSummary {
  const failureReasonCounts = new Map<string, number>();
  const failureStageCounts = new Map<string, number>();
  const warningCounts = new Map<string, number>();
  const uncertaintyLevels = {
    low: 0,
    medium: 0,
    high: 0,
    unknown: 0,
  };
  const evidenceConvergence = {
    reached: 0,
    notReached: 0,
    unknown: 0,
  };
  const failureSamples: ExternalMemoryBenchmarkFailureSample[] = [];
  for (const entry of cases) {
    for (const reason of entry.failureReasons) incrementCounter(failureReasonCounts, reason);
    for (const taxonomyEntry of entry.failureTaxonomy ?? []) {
      incrementCounter(failureStageCounts, taxonomyEntry.stage);
    }
    for (const warning of entry.warnings) incrementCounter(warningCounts, warning);
    if (entry.diagnostics.uncertaintyLevel === "low") {
      uncertaintyLevels.low += 1;
    } else if (entry.diagnostics.uncertaintyLevel === "medium") {
      uncertaintyLevels.medium += 1;
    } else if (entry.diagnostics.uncertaintyLevel === "high") {
      uncertaintyLevels.high += 1;
    } else {
      uncertaintyLevels.unknown += 1;
    }
    if (entry.diagnostics.evidenceConvergenceReached === true) {
      evidenceConvergence.reached += 1;
    } else if (entry.diagnostics.evidenceConvergenceReached === false) {
      evidenceConvergence.notReached += 1;
    } else {
      evidenceConvergence.unknown += 1;
    }
    if (!entry.pass && failureSamples.length < failureSampleLimit) {
      failureSamples.push(failureSampleForCase(entry));
    }
  }
  return {
    failureReasons: sortedCounters(failureReasonCounts),
    failureStages: sortedCounters(failureStageCounts),
    warnings: sortedCounters(warningCounts),
    uncertaintyLevels,
    evidenceConvergence,
    failureSampleLimit,
    failureSamples,
  };
}

function profileIdForCase(benchmarkCase: ExternalMemoryBenchmarkCase): string {
  const id = benchmarkCase.id ?? "case";
  return benchmarkCase.profileId ?? `external_${id}`;
}

function eventHash(
  events: ExternalMemoryBenchmarkEvent[],
  cache: WeakMap<ExternalMemoryBenchmarkEvent[], string>,
): string {
  const cached = cache.get(events);
  if (cached) return cached;
  const hash = createHash("sha256").update(JSON.stringify(events)).digest("hex");
  cache.set(events, hash);
  return hash;
}

function groupCases(
  cases: ExternalMemoryBenchmarkCase[],
  options: RunExternalMemoryBenchmarkOptions,
): CaseGroup[] {
  if (options.reuseProfiles === false) {
    return cases.map((benchmarkCase, index) => ({
      key: `case:${index}`,
      profileId: profileIdForCase(benchmarkCase),
      events: benchmarkCase.events,
      items: [{ benchmarkCase, index }],
    }));
  }
  const profileCounts = new Map<string, number>();
  for (const benchmarkCase of cases) {
    const profileId = profileIdForCase(benchmarkCase);
    profileCounts.set(profileId, (profileCounts.get(profileId) ?? 0) + 1);
  }
  const groupsByKey = new Map<string, CaseGroup>();
  const hashCache = new WeakMap<ExternalMemoryBenchmarkEvent[], string>();
  for (const [index, benchmarkCase] of cases.entries()) {
    const profileId = profileIdForCase(benchmarkCase);
    const key =
      (profileCounts.get(profileId) ?? 0) > 1
        ? `profile:${profileId}:events:${eventHash(benchmarkCase.events, hashCache)}`
        : `case:${index}`;
    const existing = groupsByKey.get(key);
    if (existing) {
      existing.items.push({ benchmarkCase, index });
    } else {
      groupsByKey.set(key, {
        key,
        profileId,
        events: benchmarkCase.events,
        items: [{ benchmarkCase, index }],
      });
    }
  }
  return [...groupsByKey.values()];
}

async function applyBenchmarkEvent(
  memory: MemoryOS,
  profileId: string,
  event: ExternalMemoryBenchmarkEvent,
): Promise<void> {
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
      metadata: event.metadata,
      createdAt: event.createdAt,
    });
  }
}

async function scoreCase(input: {
  memory: MemoryOS;
  profileId: string;
  benchmarkCase: ExternalMemoryBenchmarkCase;
  index: number;
  options: RunExternalMemoryBenchmarkOptions;
}): Promise<ExternalMemoryBenchmarkCaseResult> {
  const id = input.benchmarkCase.id ?? `case-${input.index + 1}`;
  const profileId = input.profileId;
  const mode = input.benchmarkCase.mode ?? input.options.mode ?? "reconstruct";
  const requireConvergence =
    input.benchmarkCase.requireConvergence ?? input.options.requireConvergence ?? false;
  const prepared =
    mode === "prepare"
      ? await input.memory.prepareTurn({
          profileId,
          messages: [{ role: "user", content: input.benchmarkCase.question }],
          contextBudgetTokens: input.options.contextBudgetTokens,
        })
      : null;
  const reconstructed =
    mode === "reconstruct"
      ? await input.memory.reconstructContext({
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
  const requireConvergenceForCase = mode === "reconstruct" && requireConvergence;
  const failureReasons = failureReasonsForCase({
    expectedAnyMissing,
    expectedAllMissing,
    forbiddenMatches,
    requireConvergence: requireConvergenceForCase,
    diagnostics,
  });
  const failureTaxonomy = failureReasons.length
    ? await failureTaxonomyForCase({
        memory: input.memory,
        profileId,
        benchmarkCase: input.benchmarkCase,
        missingExpectedTerms: expectedAnyMissing.concat(expectedAllMissing),
        forbiddenMatches,
        requireConvergence: requireConvergenceForCase,
        mode,
        options: input.options,
        diagnostics,
        prepared,
        reconstructed,
      })
    : [];
  const warnings = warningsForCase({ mode, diagnostics });
  return {
    id,
    pass: failureReasons.length === 0,
    mode,
    requireConvergence: requireConvergenceForCase,
    expectedAnyMatched,
    expectedAnyMissing,
    expectedAllMissing,
    forbiddenMatches,
    failureReasons,
    failureTaxonomy,
    warnings,
    diagnostics,
    promptTokenEstimate:
      prepared?.stats.promptTokenEstimate ?? reconstructed?.stats.promptTokenEstimate ?? 0,
    retrievedMemoryCount:
      prepared?.stats.retrievedMemoryCount ?? reconstructed?.stats.retrievedMemoryCount ?? 0,
    reconstructedPathCount: reconstructed?.paths.length ?? 0,
  };
}

async function runCaseGroup(input: {
  group: CaseGroup;
  options: RunExternalMemoryBenchmarkOptions;
  recordResult: (index: number, result: ExternalMemoryBenchmarkCaseResult) => void;
}): Promise<void> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "gmos-external-benchmark-"));
  const store = createSqliteMemoryStore({ path: path.join(tmp, "group.db") });
  const memory = createMemoryOS({ profileId: "external", store });
  try {
    await store.initialize();
    for (const event of input.group.events) {
      await applyBenchmarkEvent(memory, input.group.profileId, event);
    }
    for (const item of input.group.items) {
      const result = await scoreCase({
        memory,
        profileId: input.group.profileId,
        benchmarkCase: item.benchmarkCase,
        index: item.index,
        options: input.options,
      });
      input.recordResult(item.index, result);
    }
  } finally {
    await memory.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function runGroupsWithConcurrency(
  groups: CaseGroup[],
  concurrency: number,
  worker: (group: CaseGroup) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workerCount = Math.min(concurrency, groups.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (next < groups.length) {
        const group = groups[next];
        next += 1;
        if (group) await worker(group);
      }
    }),
  );
}

export async function runExternalMemoryBenchmark(
  options: RunExternalMemoryBenchmarkOptions,
): Promise<ExternalMemoryBenchmarkResult> {
  const startedAt = new Date().toISOString();
  if (!Array.isArray(options.cases) || options.cases.length === 0) {
    throw new Error("External benchmark requires at least one case");
  }
  const defaultMode = normalizeMode(options.mode);
  const eventCache = new WeakMap<object, ExternalMemoryBenchmarkEvent[]>();
  const normalizedCases = options.cases.map((benchmarkCase, index) =>
    normalizeCase(benchmarkCase, index, eventCache),
  );
  const concurrency = normalizedConcurrency(options.concurrency);
  const failureSampleLimit = normalizedFailureSampleLimit(options.failureSampleLimit);
  const normalizedOptions: RunExternalMemoryBenchmarkOptions = {
    ...options,
    cases: normalizedCases,
    ...(defaultMode ? { mode: defaultMode } : {}),
    concurrency,
    reuseProfiles: options.reuseProfiles ?? true,
    failureSampleLimit,
  };
  const groups = groupCases(normalizedCases, normalizedOptions);
  const cases: Array<ExternalMemoryBenchmarkCaseResult | undefined> = new Array(
    normalizedCases.length,
  );
  let completedCount = 0;
  let passedCount = 0;
  const recordResult = (index: number, result: ExternalMemoryBenchmarkCaseResult): void => {
    cases[index] = result;
    completedCount += 1;
    if (result.pass) passedCount += 1;
    normalizedOptions.onCaseResult?.({
      completedCount,
      totalCount: normalizedCases.length,
      passedCount,
      failedCount: completedCount - passedCount,
      caseId: result.id,
      caseIndex: index,
      pass: result.pass,
    });
  };
  await runGroupsWithConcurrency(groups, concurrency, (group) =>
    runCaseGroup({ group, options: normalizedOptions, recordResult }),
  );
  const completedCases = cases.map((entry, index) => {
    if (!entry) throw new Error(`External benchmark case ${index + 1} did not produce a result`);
    return entry;
  });
  const finalPassedCount = completedCases.filter((entry) => entry.pass).length;
  const finishedAt = new Date().toISOString();
  const summary = buildExternalMemoryBenchmarkSummary(completedCases, failureSampleLimit);
  return {
    schema: "gmos.external_long_memory_qa.v1",
    pass: finalPassedCount === completedCases.length,
    datasetFormat: normalizedOptions.datasetFormat ?? "gmos.external_long_memory_qa.jsonl",
    caseCount: completedCases.length,
    passedCount: finalPassedCount,
    failedCount: completedCases.length - finalPassedCount,
    score: completedCases.length === 0 ? 0 : finalPassedCount / completedCases.length,
    summary,
    runManifest: createRunManifest({
      startedAt,
      finishedAt,
      caseCount: completedCases.length,
      caseGroupCount: groups.length,
      options: normalizedOptions,
    }),
    cases: completedCases,
  };
}
