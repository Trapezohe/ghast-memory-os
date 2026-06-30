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
  ReconstructionIntentHint,
  Sensitivity,
  TurnMessage,
} from "../kernel/types.js";
import { readGmosPackageInfo, readGmosPackageRoot } from "../kernel/package-info.js";
import { eligibleForLongTermMemory } from "../kernel/safety.js";
import { createMemoryOS } from "../runtime/create-memory-os.js";
import { createSqliteMemoryStore } from "../store/sqlite/index.js";

export type ExternalMemoryBenchmarkMode = "prepare" | "reconstruct";
export type ExternalMemoryBenchmarkTemporalMode = "auto" | "current" | "history";
export type ExternalMemoryBenchmarkDiagnosticsLevel = "off" | "basic" | "full";
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

export interface ExternalMemoryBenchmarkForgetEvent {
  type: "forget";
  query: string;
  targetTerms?: string[] | undefined;
  reason?: string | undefined;
}

export interface ExternalMemoryBenchmarkMemoryEvent {
  type: "memory";
  kind: MemoryKind;
  content: string;
  confidence?: number | undefined;
  sensitivity?: Sensitivity | undefined;
  createdAt?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export type ExternalMemoryBenchmarkEvent =
  | ExternalMemoryBenchmarkMessageEvent
  | ExternalMemoryBenchmarkMemoryEvent
  | ExternalMemoryBenchmarkTaskEvent
  | ExternalMemoryBenchmarkForgetEvent;

export interface ExternalMemoryBenchmarkCase {
  id?: string | undefined;
  profileId?: string | undefined;
  mode?: ExternalMemoryBenchmarkMode | undefined;
  slices?: string[] | undefined;
  events: ExternalMemoryBenchmarkEvent[];
  question: string;
  temporalMode?: ExternalMemoryBenchmarkTemporalMode | undefined;
  reconstructionIntent?: ReconstructionIntentHint | undefined;
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
  | "answer_normalization_mismatch"
  | "source_event_filtered"
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

export type ExternalMemoryBenchmarkScoreAttributionArea =
  | "adapter_or_source_answer_alignment"
  | "scorer_normalization"
  | "safety_or_privacy"
  | "extraction_or_memory_update"
  | "temporal_or_policy_filter"
  | "retrieval_or_reconstruction"
  | "context_composer_or_budget"
  | "reconstruction_convergence";

export interface ExternalMemoryBenchmarkCaseResult {
  id: string;
  pass: boolean;
  strictPass: boolean;
  normalizedEvidencePass: boolean;
  mode: ExternalMemoryBenchmarkMode;
  temporalMode: ExternalMemoryBenchmarkTemporalMode | null;
  slices?: string[] | undefined;
  requireConvergence: boolean;
  expectedAnyMatched: string[];
  expectedAnyNormalizedMatched: string[];
  expectedAnyMissing: string[];
  expectedAnyNormalizedMissing: string[];
  expectedAllMissing: string[];
  expectedAllNormalizedMissing: string[];
  forbiddenMatches: string[];
  failureReasons: string[];
  failureTaxonomy?: ExternalMemoryBenchmarkFailureTaxonomyEntry[] | undefined;
  warnings: string[];
  diagnostics: ExternalMemoryBenchmarkCaseDiagnostics;
  promptTokenEstimate: number;
  retrievedMemoryCount: number;
  reconstructedPathCount: number;
  durationMs: number;
  scoringRuntimeMs: number;
  taxonomyRuntimeMs: number;
  wideBudgetDiagnosticRuntimeMs: number;
}

export interface ExternalMemoryBenchmarkCaseTiming {
  id: string;
  pass: boolean;
  mode: ExternalMemoryBenchmarkMode;
  temporalMode: ExternalMemoryBenchmarkTemporalMode | null;
  durationMs: number;
  scoringRuntimeMs: number;
  taxonomyRuntimeMs: number;
  wideBudgetDiagnosticRuntimeMs: number;
  promptTokenEstimate: number;
  retrievedMemoryCount: number;
  reconstructedPathCount: number;
}

export interface ExternalMemoryBenchmarkGroupTiming {
  groupKey: string;
  caseCount: number;
  eventCount: number;
  caseIds: string[];
  durationMs: number;
  setupDurationMs: number;
  scoringDurationMs: number;
  setupRuntimeMs: number;
  scoringRuntimeMs: number;
  taxonomyRuntimeMs: number;
  wideBudgetDiagnosticRuntimeMs: number;
  passedCount: number;
  failedCount: number;
}

export interface ExternalMemoryBenchmarkCounter {
  name: string;
  count: number;
}

export interface ExternalMemoryBenchmarkSliceScore {
  name: string;
  caseCount: number;
  passedCount: number;
  failedCount: number;
  score: number;
}

export interface ExternalMemoryBenchmarkFailureSample {
  id: string;
  mode: ExternalMemoryBenchmarkMode;
  temporalMode: ExternalMemoryBenchmarkTemporalMode | null;
  slices?: string[] | undefined;
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
  durationMs: number;
  scoringRuntimeMs: number;
  taxonomyRuntimeMs: number;
  wideBudgetDiagnosticRuntimeMs: number;
}

export interface ExternalMemoryBenchmarkSummary {
  failureReasons: ExternalMemoryBenchmarkCounter[];
  failureStages?: ExternalMemoryBenchmarkCounter[] | undefined;
  scoreAttribution: ExternalMemoryBenchmarkCounter[];
  sliceScores?: ExternalMemoryBenchmarkSliceScore[] | undefined;
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
  runtime: {
    totalRuntimeMs: number;
    setupRuntimeMs: number;
    scoringRuntimeMs: number;
    taxonomyRuntimeMs: number;
    wideBudgetDiagnosticRuntimeMs: number;
    diagnosticRuntimeMs: number;
  };
  slowestCases: ExternalMemoryBenchmarkCaseTiming[];
  slowestCaseGroups: ExternalMemoryBenchmarkGroupTiming[];
  failureSampleLimit: number;
  failureSamples: ExternalMemoryBenchmarkFailureSample[];
}

export interface ExternalMemoryBenchmarkScoreSemantics {
  scoreKind: "deterministic_adapter_context";
  primaryScore: "strictScore";
  deterministicAdapterScoreField: "score";
  strictScoreField: "strictScore";
  normalizedEvidenceScoreField: "normalizedEvidenceScore";
  normalizedEvidenceScorePurpose: "diagnostic_only";
  officialProtocol: "not_run";
  officialScore: null;
  comparableToOfficialScore: false;
}

export const EXTERNAL_MEMORY_BENCHMARK_SCORE_SEMANTICS: ExternalMemoryBenchmarkScoreSemantics = {
  scoreKind: "deterministic_adapter_context",
  primaryScore: "strictScore",
  deterministicAdapterScoreField: "score",
  strictScoreField: "strictScore",
  normalizedEvidenceScoreField: "normalizedEvidenceScore",
  normalizedEvidenceScorePurpose: "diagnostic_only",
  officialProtocol: "not_run",
  officialScore: null,
  comparableToOfficialScore: false,
};

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
    temporalMode: ExternalMemoryBenchmarkTemporalMode | null;
    includeSensitive: boolean;
    includeTemporalMetadata: boolean;
    requireConvergence: boolean;
    concurrency: number;
    reuseProfiles: boolean;
    failureSampleLimit: number;
    diagnosticsLevel: ExternalMemoryBenchmarkDiagnosticsLevel;
  };
  scoreSemantics: ExternalMemoryBenchmarkScoreSemantics;
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
  strictScore: number;
  normalizedEvidenceScore: number;
  normalizedEvidencePassedCount: number;
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
  temporalMode?: ExternalMemoryBenchmarkTemporalMode | undefined;
  includeSensitive?: boolean | undefined;
  includeTemporalMetadata?: boolean | undefined;
  requireConvergence?: boolean | undefined;
  concurrency?: number | undefined;
  reuseProfiles?: boolean | undefined;
  failureSampleLimit?: number | undefined;
  diagnosticsLevel?: ExternalMemoryBenchmarkDiagnosticsLevel | undefined;
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
  durationMs: number;
}

interface FailureTaxonomyResult {
  entries: ExternalMemoryBenchmarkFailureTaxonomyEntry[];
  runtimeMs: number;
  wideBudgetDiagnosticRuntimeMs: number;
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
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    const normalized = entry.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function normalizeMode(value: unknown): ExternalMemoryBenchmarkMode | undefined {
  if (value === undefined) return undefined;
  if (value !== "prepare" && value !== "reconstruct") {
    throw new Error("External benchmark mode must be prepare or reconstruct");
  }
  return value;
}

function normalizeTemporalMode(value: unknown, field: string): ExternalMemoryBenchmarkTemporalMode | undefined {
  if (value === undefined) return undefined;
  if (value !== "auto" && value !== "current" && value !== "history") {
    throw new Error(`External benchmark ${field} must be auto, current, or history`);
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

function optionalReconstructionIntent(value: unknown, field: string): ReconstructionIntentHint | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`External benchmark ${field} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const expectedTags = stringArray(record.expectedTags, `${field}.expectedTags`);
  const queryCues = stringArray(record.queryCues, `${field}.queryCues`);
  let requiredTagGroups: ReconstructionIntentHint["requiredTagGroups"] | undefined;
  if (record.requiredTagGroups !== undefined) {
    if (!Array.isArray(record.requiredTagGroups)) {
      throw new Error(`External benchmark ${field}.requiredTagGroups must be an array`);
    }
    requiredTagGroups = record.requiredTagGroups.map((group, index) => {
      if (typeof group !== "object" || group === null || Array.isArray(group)) {
        throw new Error(`External benchmark ${field}.requiredTagGroups[${index}] must be an object`);
      }
      const groupRecord = group as Record<string, unknown>;
      const tags = stringArray(groupRecord.tags, `${field}.requiredTagGroups[${index}].tags`);
      if (!tags || tags.length === 0) {
        throw new Error(`External benchmark ${field}.requiredTagGroups[${index}].tags is required`);
      }
      const name = groupRecord.name;
      if (name !== undefined && typeof name !== "string") {
        throw new Error(`External benchmark ${field}.requiredTagGroups[${index}].name must be a string`);
      }
      return {
        ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}),
        tags,
      };
    });
  }
  if (!expectedTags && !queryCues && !requiredTagGroups) return undefined;
  return {
    ...(expectedTags ? { expectedTags } : {}),
    ...(queryCues ? { queryCues } : {}),
    ...(requiredTagGroups ? { requiredTagGroups } : {}),
  };
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
      ...(event.metadata !== undefined ? { metadata: optionalMetadata(event.metadata, `${caseId}.event.metadata`) } : {}),
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
  if (event.type === "forget") {
    if (typeof event.query !== "string" || event.query.trim().length === 0) {
      throw new Error(`External benchmark case ${caseId} forget event requires query`);
    }
    const targetTerms = stringArray(event.targetTerms, `${caseId}.event.targetTerms`);
    return {
      type: "forget",
      query: event.query.trim(),
      ...(targetTerms ? { targetTerms } : {}),
      ...(typeof event.reason === "string" && event.reason.trim() ? { reason: event.reason.trim() } : {}),
    };
  }
  if (event.type !== undefined && event.type !== "message") {
    throw new Error(`External benchmark case ${caseId} event type must be message, memory, task, or forget`);
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
  const slices = stringArray(row.slices, `${id}.slices`);
  const temporalMode = normalizeTemporalMode(row.temporalMode, `${id}.temporalMode`);
  const reconstructionIntent = optionalReconstructionIntent(
    row.reconstructionIntent,
    `${id}.reconstructionIntent`,
  );
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
    ...(slices && slices.length > 0 ? { slices } : {}),
    events,
    question: row.question,
    ...(temporalMode ? { temporalMode } : {}),
    ...(reconstructionIntent ? { reconstructionIntent } : {}),
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
  if (/\p{Script=Han}/u.test(term)) {
    return haystack.toLowerCase().includes(term.toLowerCase());
  }
  if (/[^\p{Letter}\p{Number}\s]/u.test(term)) {
    return haystack.toLowerCase().includes(term.toLowerCase());
  }
  const normalizedTerm = term.trim().replace(/\s+/gu, " ");
  if (!normalizedTerm) return false;
  const pattern = normalizedTerm
    .split(" ")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("\\s+");
  return new RegExp(
    `(^|[^\\p{Letter}\\p{Number}])${pattern}($|[^\\p{Letter}\\p{Number}])`,
    "iu",
  ).test(haystack);
}

function normalizeForAnswerComparison(value: string): string {
  return value
    .replace(/\b\d{1,3}(?:,\d{3})+\b/gu, (match, offset: number, full: string) =>
      /[$€£¥]\s*$/u.test(full.slice(Math.max(0, offset - 2), offset))
        ? match
        : match.replace(/,/gu, ""),
    )
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

const ANSWER_MONTHS: Record<string, string> = {
  jan: "01",
  january: "01",
  feb: "02",
  february: "02",
  mar: "03",
  march: "03",
  apr: "04",
  april: "04",
  may: "05",
  jun: "06",
  june: "06",
  jul: "07",
  july: "07",
  aug: "08",
  august: "08",
  sep: "09",
  sept: "09",
  september: "09",
  oct: "10",
  october: "10",
  nov: "11",
  november: "11",
  dec: "12",
  december: "12",
};

function ordinalSuffixMatchesDay(day: string, suffix: string): boolean {
  const dayNumber = Number(day);
  const teen = dayNumber % 100;
  const expected =
    teen >= 11 && teen <= 13
      ? "th"
      : dayNumber % 10 === 1
        ? "st"
        : dayNumber % 10 === 2
          ? "nd"
          : dayNumber % 10 === 3
            ? "rd"
            : "th";
  return suffix.toLowerCase() === expected;
}

function calendarDateKey(year: string, month: string, day: string): string | null {
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const parsed = new Date(Date.UTC(yearNumber, monthNumber - 1, dayNumber));
  if (
    parsed.getUTCFullYear() !== yearNumber ||
    parsed.getUTCMonth() !== monthNumber - 1 ||
    parsed.getUTCDate() !== dayNumber
  ) {
    return null;
  }
  return `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function monthDayDateKey(month: string, day: string): string | null {
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const parsed = new Date(Date.UTC(2000, monthNumber - 1, dayNumber));
  if (parsed.getUTCMonth() !== monthNumber - 1 || parsed.getUTCDate() !== dayNumber) {
    return null;
  }
  return `month-day:${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

type DateAnswerMatch = {
  key: string;
  start: number;
  end: number;
};

function dateAnswerMatches(value: string): DateAnswerMatch[] {
  const matches: DateAnswerMatch[] = [];
  for (const match of value.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/gu)) {
    const key = calendarDateKey(match[1]!, match[2]!, match[3]!);
    if (key && match.index !== undefined) {
      matches.push({ key, start: match.index, end: match.index + match[0].length });
    }
  }
  for (const match of value.matchAll(/\b(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})\b/gu)) {
    const month = ANSWER_MONTHS[match[2]!.toLowerCase()];
    const key = month ? calendarDateKey(match[3]!, month, match[1]!) : null;
    if (key && match.index !== undefined) {
      matches.push({ key, start: match.index, end: match.index + match[0].length });
    }
  }
  for (const match of value.matchAll(/\b([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\b/gu)) {
    const month = ANSWER_MONTHS[match[1]!.toLowerCase()];
    const key = month ? calendarDateKey(match[3]!, month, match[2]!) : null;
    if (key && match.index !== undefined) {
      matches.push({ key, start: match.index, end: match.index + match[0].length });
    }
  }
  for (const match of value.matchAll(/\b(\d{1,2})(st|nd|rd|th)\s+([A-Za-z]+),?\s+(\d{4})\b/giu)) {
    const month = ANSWER_MONTHS[match[3]!.toLowerCase()];
    const key =
      month && ordinalSuffixMatchesDay(match[1]!, match[2]!)
        ? calendarDateKey(match[4]!, month, match[1]!)
        : null;
    if (key && match.index !== undefined) {
      matches.push({ key, start: match.index, end: match.index + match[0].length });
    }
  }
  for (const match of value.matchAll(/\b([A-Za-z]+)\s+(\d{1,2})(st|nd|rd|th),?\s+(\d{4})\b/giu)) {
    const month = ANSWER_MONTHS[match[1]!.toLowerCase()];
    const key =
      month && ordinalSuffixMatchesDay(match[2]!, match[3]!)
        ? calendarDateKey(match[4]!, month, match[2]!)
        : null;
    if (key && match.index !== undefined) {
      matches.push({ key, start: match.index, end: match.index + match[0].length });
    }
  }
  for (const match of value.matchAll(/\b(\d{1,2})\s+([A-Za-z]+)\b/gu)) {
    const month = ANSWER_MONTHS[match[2]!.toLowerCase()];
    const key = month ? monthDayDateKey(month, match[1]!) : null;
    if (key && match.index !== undefined) {
      matches.push({ key, start: match.index, end: match.index + match[0].length });
    }
  }
  for (const match of value.matchAll(/\b([A-Za-z]+)\s+(\d{1,2})\b/gu)) {
    const month = ANSWER_MONTHS[match[1]!.toLowerCase()];
    const key = month ? monthDayDateKey(month, match[2]!) : null;
    if (key && match.index !== undefined) {
      matches.push({ key, start: match.index, end: match.index + match[0].length });
    }
  }
  for (const match of value.matchAll(/\b(\d{1,2})(st|nd|rd|th)\s+([A-Za-z]+)\b/giu)) {
    const month = ANSWER_MONTHS[match[3]!.toLowerCase()];
    const key =
      month && ordinalSuffixMatchesDay(match[1]!, match[2]!)
        ? monthDayDateKey(month, match[1]!)
        : null;
    if (key && match.index !== undefined) {
      matches.push({ key, start: match.index, end: match.index + match[0].length });
    }
  }
  for (const match of value.matchAll(/\b([A-Za-z]+)\s+(\d{1,2})(st|nd|rd|th)\b/giu)) {
    const month = ANSWER_MONTHS[match[1]!.toLowerCase()];
    const key =
      month && ordinalSuffixMatchesDay(match[2]!, match[3]!)
        ? monthDayDateKey(month, match[2]!)
        : null;
    if (key && match.index !== undefined) {
      matches.push({ key, start: match.index, end: match.index + match[0].length });
    }
  }
  return matches;
}

function dateAnswerKeys(value: string): string[] {
  return [...new Set(dateAnswerMatches(value).map((match) => match.key))];
}

function normalizedAnswerTokens(value: string): string[] {
  const normalized = normalizeForAnswerComparison(value);
  return normalized ? normalized.split(" ") : [];
}

const ANSWER_DATE_REMAINDER_STOPWORDS = new Set(["a", "an", "the", "on", "at", "in", "of"]);

function nonDateAnswerTokens(value: string, matches: DateAnswerMatch[]): string[] {
  let withoutDates = value;
  for (const match of [...matches].sort((left, right) => right.start - left.start)) {
    withoutDates =
      withoutDates.slice(0, match.start) +
      " ".repeat(match.end - match.start) +
      withoutDates.slice(match.end);
  }
  return normalizedAnswerTokens(withoutDates).filter(
    (token) => !ANSWER_DATE_REMAINDER_STOPWORDS.has(token),
  );
}

function includesNormalizedAnswer(haystack: string, term: string): boolean {
  const termSymbols = term.replace(/[\p{Letter}\p{Number}\s._:;,\-–—/()]/gu, "");
  if (termSymbols) return false;
  const termDateMatches = dateAnswerMatches(term);
  if (termDateMatches.length > 0) {
    const termDateKeys = [...new Set(termDateMatches.map((match) => match.key))];
    const haystackDateKeys = new Set(dateAnswerKeys(haystack));
    if (termDateKeys.every((key) => haystackDateKeys.has(key))) {
      const haystackTokens = new Set(normalizedAnswerTokens(haystack));
      const requiredTokens = nonDateAnswerTokens(term, termDateMatches);
      if (requiredTokens.every((token) => haystackTokens.has(token))) return true;
    }
  }
  const needle = normalizedAnswerTokens(term);
  if (needle.join("").length < 3) return false;
  const haystackTokens = normalizedAnswerTokens(haystack);
  for (let index = 0; index <= haystackTokens.length - needle.length; index += 1) {
    if (needle.every((token, offset) => haystackTokens[index + offset] === token)) return true;
  }
  return false;
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
  if (event.type === "forget") {
    return [event.query, event.reason ?? ""].filter(Boolean).join("\n");
  }
  return event.content;
}

function eventsContainTerm(events: ExternalMemoryBenchmarkEvent[], term: string): boolean {
  return events.some((event) => includesTerm(eventContent(event), term));
}

function eventsContainNormalizedAnswer(events: ExternalMemoryBenchmarkEvent[], term: string): boolean {
  return events.some((event) => includesNormalizedAnswer(eventContent(event), term));
}

function eventEligibleForLongTermMemory(event: ExternalMemoryBenchmarkEvent): boolean {
  if (event.type === "message" || event.type === undefined) {
    return eligibleForLongTermMemory({ content: event.content, privacyMode: event.privacyMode });
  }
  if (event.type === "memory") {
    return event.sensitivity !== "secret_like" && eligibleForLongTermMemory({ content: event.content });
  }
  return true;
}

function sourceEventsFilterTerm(events: ExternalMemoryBenchmarkEvent[], term: string): boolean {
  const containingEvents = events.filter((event) => includesTerm(eventContent(event), term));
  return containingEvents.length > 0 && containingEvents.every((event) => !eventEligibleForLongTermMemory(event));
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

function contextContainsTermOrNormalizedAnswer(context: string, term: string): boolean {
  return includesTerm(context, term) || includesNormalizedAnswer(context, term);
}

function effectiveTemporalMode(input: {
  benchmarkCase: ExternalMemoryBenchmarkCase;
  mode: ExternalMemoryBenchmarkMode;
  options: RunExternalMemoryBenchmarkOptions;
}): ExternalMemoryBenchmarkTemporalMode | null {
  return input.mode === "reconstruct"
    ? input.benchmarkCase.temporalMode ?? input.options.temporalMode ?? "auto"
    : null;
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
      ...(input.options.includeSensitive === true ? { includeSensitive: true } : {}),
    });
    return includesTerm(prepared.contextBlock, input.term) || memoriesContainTerm(prepared.memories, input.term);
  }
  const temporalMode = effectiveTemporalMode(input);
  const reconstructed = await input.memory.reconstructContext({
    profileId: input.profileId,
    query: input.benchmarkCase.question,
    reconstructionIntent: input.benchmarkCase.reconstructionIntent,
    maxSteps: input.options.maxSteps,
    maxBranch: input.options.maxBranch,
    maxMemories: input.options.maxMemories,
    contextBudgetTokens,
    ...(temporalMode !== null ? { temporalMode } : {}),
    includeTemporalMetadata: input.options.includeTemporalMetadata ?? false,
    ...(input.options.includeSensitive === true ? { includeSensitive: true } : {}),
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
  diagnosticsLevel: ExternalMemoryBenchmarkDiagnosticsLevel;
}): Promise<FailureTaxonomyResult> {
  const startedMs = Date.now();
  let wideBudgetDiagnosticRuntimeMs = 0;
  const entries: ExternalMemoryBenchmarkFailureTaxonomyEntry[] = [];
  if (input.diagnosticsLevel === "off") {
    return { entries, runtimeMs: 0, wideBudgetDiagnosticRuntimeMs };
  }
  for (const term of uniqueTerms(input.missingExpectedTerms)) {
    if (!eventsContainTerm(input.benchmarkCase.events, term)) {
      addTaxonomyEntry(
        entries,
        eventsContainNormalizedAnswer(input.benchmarkCase.events, term)
          ? "answer_normalization_mismatch"
          : "answer_not_in_input",
        [term],
      );
      continue;
    }
    const historyHits = await input.memory.search({
      profileId: input.profileId,
      query: term,
      limit: 10,
      purpose: "history",
    });
    if (!memoriesContainTerm(historyHits, term)) {
      addTaxonomyEntry(
        entries,
        sourceEventsFilterTerm(input.benchmarkCase.events, term)
          ? "source_event_filtered"
          : "not_extracted_or_filtered",
        [term],
      );
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
    let wideBudgetCanRecover = false;
    if (input.diagnosticsLevel === "full") {
      const wideStartedMs = Date.now();
      wideBudgetCanRecover = await wideBudgetRunContainsTerm({
        memory: input.memory,
        profileId: input.profileId,
        benchmarkCase: input.benchmarkCase,
        mode: input.mode,
        options: input.options,
        term,
      });
      wideBudgetDiagnosticRuntimeMs += Math.max(0, Date.now() - wideStartedMs);
    }
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
  return {
    entries,
    runtimeMs: Math.max(0, Date.now() - startedMs),
    wideBudgetDiagnosticRuntimeMs,
  };
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

function gitText(args: string[], packageRoot: string): string | null {
  const ceiling = path.dirname(packageRoot);
  const existingCeiling = process.env.GIT_CEILING_DIRECTORIES;
  const result = spawnSync("git", args, {
    cwd: packageRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CEILING_DIRECTORIES: existingCeiling
        ? `${ceiling}${path.delimiter}${existingCeiling}`
        : ceiling,
    },
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function externalBenchmarkGitInfoForPackageRoot(
  packageRoot: string | null = readGmosPackageRoot(),
): ExternalMemoryBenchmarkRunManifest["git"] {
  if (!packageRoot) return { branch: null, sha: null, dirty: null };
  const status = gitText(["status", "--porcelain"], packageRoot);
  return {
    branch: gitText(["rev-parse", "--abbrev-ref", "HEAD"], packageRoot),
    sha: gitText(["rev-parse", "HEAD"], packageRoot),
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
    git: externalBenchmarkGitInfoForPackageRoot(),
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
      temporalMode: input.options.temporalMode ?? null,
      includeSensitive: input.options.includeSensitive ?? false,
      includeTemporalMetadata: input.options.includeTemporalMetadata ?? false,
      requireConvergence: input.options.requireConvergence ?? false,
      concurrency: normalizedConcurrency(input.options.concurrency),
      reuseProfiles: input.options.reuseProfiles ?? true,
      failureSampleLimit: normalizedFailureSampleLimit(input.options.failureSampleLimit),
      diagnosticsLevel: normalizedDiagnosticsLevel(input.options.diagnosticsLevel),
    },
    scoreSemantics: { ...EXTERNAL_MEMORY_BENCHMARK_SCORE_SEMANTICS },
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

function normalizedDiagnosticsLevel(
  value: ExternalMemoryBenchmarkDiagnosticsLevel | undefined,
): ExternalMemoryBenchmarkDiagnosticsLevel {
  if (value === undefined) return "full";
  if (value === "off" || value === "basic" || value === "full") return value;
  throw new Error("External benchmark diagnostics level must be off, basic, or full");
}

function incrementCounter(map: Map<string, number>, name: string): void {
  map.set(name, (map.get(name) ?? 0) + 1);
}

function scoreAttributionAreaForFailureStage(
  stage: ExternalMemoryBenchmarkFailureStage,
): ExternalMemoryBenchmarkScoreAttributionArea {
  switch (stage) {
    case "answer_not_in_input":
      return "adapter_or_source_answer_alignment";
    case "answer_normalization_mismatch":
      return "scorer_normalization";
    case "source_event_filtered":
    case "forbidden_context_inclusion":
      return "safety_or_privacy";
    case "not_extracted_or_filtered":
      return "extraction_or_memory_update";
    case "retrieval_policy_filtered":
      return "temporal_or_policy_filter";
    case "retrieval_or_reconstruction_miss":
      return "retrieval_or_reconstruction";
    case "context_composer_or_budget_drop":
      return "context_composer_or_budget";
    case "reconstruction_convergence_failure":
      return "reconstruction_convergence";
  }
}

function sortedCounters(map: Map<string, number>): ExternalMemoryBenchmarkCounter[] {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function sortedSliceScores(
  map: Map<string, { caseCount: number; passedCount: number }>,
): ExternalMemoryBenchmarkSliceScore[] {
  return [...map.entries()]
    .map(([name, stats]) => ({
      name,
      caseCount: stats.caseCount,
      passedCount: stats.passedCount,
      failedCount: stats.caseCount - stats.passedCount,
      score: stats.caseCount ? stats.passedCount / stats.caseCount : 0,
    }))
    .sort((left, right) => right.caseCount - left.caseCount || left.name.localeCompare(right.name));
}

function failureSampleForCase(
  entry: ExternalMemoryBenchmarkCaseResult,
): ExternalMemoryBenchmarkFailureSample {
  return {
    id: entry.id,
    mode: entry.mode,
    temporalMode: entry.temporalMode,
    ...(entry.slices !== undefined ? { slices: entry.slices } : {}),
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
    durationMs: entry.durationMs,
    scoringRuntimeMs: entry.scoringRuntimeMs,
    taxonomyRuntimeMs: entry.taxonomyRuntimeMs,
    wideBudgetDiagnosticRuntimeMs: entry.wideBudgetDiagnosticRuntimeMs,
  };
}

function caseTiming(entry: ExternalMemoryBenchmarkCaseResult): ExternalMemoryBenchmarkCaseTiming {
  return {
    id: entry.id,
    pass: entry.pass,
    mode: entry.mode,
    temporalMode: entry.temporalMode,
    durationMs: entry.durationMs,
    scoringRuntimeMs: entry.scoringRuntimeMs,
    taxonomyRuntimeMs: entry.taxonomyRuntimeMs,
    wideBudgetDiagnosticRuntimeMs: entry.wideBudgetDiagnosticRuntimeMs,
    promptTokenEstimate: entry.promptTokenEstimate,
    retrievedMemoryCount: entry.retrievedMemoryCount,
    reconstructedPathCount: entry.reconstructedPathCount,
  };
}

function summaryRuntime(
  cases: ExternalMemoryBenchmarkCaseResult[],
  groupTimings: ExternalMemoryBenchmarkGroupTiming[],
): ExternalMemoryBenchmarkSummary["runtime"] {
  const setupRuntimeMs = groupTimings.reduce((sum, entry) => sum + entry.setupRuntimeMs, 0);
  const scoringRuntimeMs = cases.reduce((sum, entry) => sum + entry.scoringRuntimeMs, 0);
  const taxonomyRuntimeMs = cases.reduce((sum, entry) => sum + entry.taxonomyRuntimeMs, 0);
  const wideBudgetDiagnosticRuntimeMs = cases.reduce(
    (sum, entry) => sum + entry.wideBudgetDiagnosticRuntimeMs,
    0,
  );
  return {
    totalRuntimeMs: setupRuntimeMs + scoringRuntimeMs + taxonomyRuntimeMs,
    setupRuntimeMs,
    scoringRuntimeMs,
    taxonomyRuntimeMs,
    wideBudgetDiagnosticRuntimeMs,
    diagnosticRuntimeMs: taxonomyRuntimeMs,
  };
}

function buildExternalMemoryBenchmarkSummary(
  cases: ExternalMemoryBenchmarkCaseResult[],
  failureSampleLimit: number,
  groupTimings: ExternalMemoryBenchmarkGroupTiming[] = [],
): ExternalMemoryBenchmarkSummary {
  const failureReasonCounts = new Map<string, number>();
  const failureStageCounts = new Map<string, number>();
  const scoreAttributionCounts = new Map<string, number>();
  const sliceScoreCounts = new Map<string, { caseCount: number; passedCount: number }>();
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
      incrementCounter(
        scoreAttributionCounts,
        scoreAttributionAreaForFailureStage(taxonomyEntry.stage),
      );
    }
    for (const slice of entry.slices ?? []) {
      const stats = sliceScoreCounts.get(slice) ?? { caseCount: 0, passedCount: 0 };
      stats.caseCount += 1;
      if (entry.pass) stats.passedCount += 1;
      sliceScoreCounts.set(slice, stats);
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
    scoreAttribution: sortedCounters(scoreAttributionCounts),
    sliceScores: sortedSliceScores(sliceScoreCounts),
    warnings: sortedCounters(warningCounts),
    uncertaintyLevels,
    evidenceConvergence,
    runtime: summaryRuntime(cases, groupTimings),
    slowestCases: [...cases]
      .sort((left, right) => right.durationMs - left.durationMs || left.id.localeCompare(right.id))
      .slice(0, 20)
      .map(caseTiming),
    slowestCaseGroups: [...groupTimings]
      .sort((left, right) => right.durationMs - left.durationMs || left.groupKey.localeCompare(right.groupKey))
      .slice(0, 20),
    failureSampleLimit,
    failureSamples,
  };
}

function profileIdForCase(benchmarkCase: ExternalMemoryBenchmarkCase, index: number): string {
  return benchmarkCase.profileId ?? `external_profile_${index + 1}`;
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
      profileId: profileIdForCase(benchmarkCase, index),
      events: benchmarkCase.events,
      items: [{ benchmarkCase, index }],
    }));
  }
  const profileCounts = new Map<string, number>();
  for (const [index, benchmarkCase] of cases.entries()) {
    const profileId = profileIdForCase(benchmarkCase, index);
    profileCounts.set(profileId, (profileCounts.get(profileId) ?? 0) + 1);
  }
  const groupsByKey = new Map<string, CaseGroup>();
  const hashCache = new WeakMap<ExternalMemoryBenchmarkEvent[], string>();
  for (const [index, benchmarkCase] of cases.entries()) {
    const profileId = profileIdForCase(benchmarkCase, index);
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
  } else if (event.type === "forget") {
    await memory.forget({
      profileId,
      query: event.query,
      targetTerms: event.targetTerms,
      reason: event.reason,
    });
  } else if (event.type === "memory") {
    await memory.add({
      profileId,
      kind: event.kind,
      content: event.content,
      confidence: event.confidence,
      sensitivity: event.sensitivity,
      createdAt: event.createdAt,
      ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
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
  const startedMs = Date.now();
  const coreScoringStartedMs = Date.now();
  const id = input.benchmarkCase.id ?? `case-${input.index + 1}`;
  const profileId = input.profileId;
  const mode = input.benchmarkCase.mode ?? input.options.mode ?? "reconstruct";
  const diagnosticsLevel = normalizedDiagnosticsLevel(input.options.diagnosticsLevel);
  const temporalMode = effectiveTemporalMode({
    benchmarkCase: input.benchmarkCase,
    mode,
    options: input.options,
  });
  const requireConvergence =
    input.benchmarkCase.requireConvergence ?? input.options.requireConvergence ?? false;
  const prepared =
    mode === "prepare"
      ? await input.memory.prepareTurn({
          profileId,
          messages: [{ role: "user", content: input.benchmarkCase.question }],
          contextBudgetTokens: input.options.contextBudgetTokens,
          ...(input.options.includeSensitive === true ? { includeSensitive: true } : {}),
        })
      : null;
  const reconstructed =
    mode === "reconstruct"
      ? await input.memory.reconstructContext({
          profileId,
          query: input.benchmarkCase.question,
          reconstructionIntent: input.benchmarkCase.reconstructionIntent,
          maxSteps: input.options.maxSteps,
          maxBranch: input.options.maxBranch,
          maxMemories: input.options.maxMemories,
          contextBudgetTokens: input.options.contextBudgetTokens,
          ...(temporalMode !== null ? { temporalMode } : {}),
          includeTemporalMetadata: input.options.includeTemporalMetadata ?? false,
          ...(input.options.includeSensitive === true ? { includeSensitive: true } : {}),
        })
      : null;
  const context = prepared?.contextBlock ?? reconstructed?.contextBlock ?? "";
  const expectedAny = input.benchmarkCase.expectedAny ?? [];
  const expectedAll = input.benchmarkCase.expectedAll ?? [];
  const forbiddenAny = input.benchmarkCase.forbiddenAny ?? [];
  const expectedAnyMatched = expectedAny.filter((term) => includesTerm(context, term));
  const expectedAnyNormalizedMatched = expectedAny.filter((term) =>
    contextContainsTermOrNormalizedAnswer(context, term),
  );
  const expectedAllMissing = expectedAll.filter((term) => !includesTerm(context, term));
  const expectedAllNormalizedMissing = expectedAll.filter(
    (term) => !contextContainsTermOrNormalizedAnswer(context, term),
  );
  const forbiddenMatches = forbiddenAny.filter((term) => includesTerm(context, term));
  const expectedAnyMissing =
    expectedAny.length > 0 && expectedAnyMatched.length === 0 ? expectedAny : [];
  const expectedAnyNormalizedMissing =
    expectedAny.length > 0 && expectedAnyNormalizedMatched.length === 0 ? expectedAny : [];
  const diagnostics = reconstructionDiagnostics(reconstructed);
  const requireConvergenceForCase = mode === "reconstruct" && requireConvergence;
  const failureReasons = failureReasonsForCase({
    expectedAnyMissing,
    expectedAllMissing,
    forbiddenMatches,
    requireConvergence: requireConvergenceForCase,
    diagnostics,
  });
  const normalizedFailureReasons = failureReasonsForCase({
    expectedAnyMissing: expectedAnyNormalizedMissing,
    expectedAllMissing: expectedAllNormalizedMissing,
    forbiddenMatches,
    requireConvergence: requireConvergenceForCase,
    diagnostics,
  });
  const scoringRuntimeMs = Math.max(0, Date.now() - coreScoringStartedMs);
  const taxonomyResult = failureReasons.length
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
        diagnosticsLevel,
      })
    : { entries: [], runtimeMs: 0, wideBudgetDiagnosticRuntimeMs: 0 };
  const warnings = diagnosticsLevel === "off" ? [] : warningsForCase({ mode, diagnostics });
  const strictPass = failureReasons.length === 0;
  const normalizedEvidencePass = normalizedFailureReasons.length === 0;
  return {
    id,
    pass: strictPass,
    strictPass,
    normalizedEvidencePass,
    mode,
    temporalMode,
    slices: input.benchmarkCase.slices ?? [],
    requireConvergence: requireConvergenceForCase,
    expectedAnyMatched,
    expectedAnyNormalizedMatched,
    expectedAnyMissing,
    expectedAnyNormalizedMissing,
    expectedAllMissing,
    expectedAllNormalizedMissing,
    forbiddenMatches,
    failureReasons,
    failureTaxonomy: taxonomyResult.entries,
    warnings,
    diagnostics,
    promptTokenEstimate:
      prepared?.stats.promptTokenEstimate ?? reconstructed?.stats.promptTokenEstimate ?? 0,
    retrievedMemoryCount:
      prepared?.stats.retrievedMemoryCount ?? reconstructed?.stats.retrievedMemoryCount ?? 0,
    reconstructedPathCount: reconstructed?.paths.length ?? 0,
    durationMs: Math.max(0, Date.now() - startedMs),
    scoringRuntimeMs,
    taxonomyRuntimeMs: taxonomyResult.runtimeMs,
    wideBudgetDiagnosticRuntimeMs: taxonomyResult.wideBudgetDiagnosticRuntimeMs,
  };
}

async function runCaseGroup(input: {
  group: CaseGroup;
  options: RunExternalMemoryBenchmarkOptions;
  recordResult: (index: number, result: ExternalMemoryBenchmarkCaseResult) => void;
}): Promise<ExternalMemoryBenchmarkGroupTiming> {
  const groupStartedMs = Date.now();
  const tmp = mkdtempSync(path.join(os.tmpdir(), "gmos-external-benchmark-"));
  const store = createSqliteMemoryStore({ path: path.join(tmp, "group.db") });
  const memory = createMemoryOS({ profileId: "external", store });
  const results: ExternalMemoryBenchmarkCaseResult[] = [];
  let setupDurationMs = 0;
  try {
    await store.initialize();
    for (const event of input.group.events) {
      await applyBenchmarkEvent(memory, input.group.profileId, event);
    }
    setupDurationMs = Math.max(0, Date.now() - groupStartedMs);
    for (const item of input.group.items) {
      const result = await scoreCase({
        memory,
        profileId: input.group.profileId,
        benchmarkCase: item.benchmarkCase,
        index: item.index,
        options: input.options,
      });
      results.push(result);
      input.recordResult(item.index, result);
    }
    const durationMs = Math.max(0, Date.now() - groupStartedMs);
    const scoringRuntimeMs = results.reduce((sum, result) => sum + result.scoringRuntimeMs, 0);
    const taxonomyRuntimeMs = results.reduce((sum, result) => sum + result.taxonomyRuntimeMs, 0);
    const wideBudgetDiagnosticRuntimeMs = results.reduce(
      (sum, result) => sum + result.wideBudgetDiagnosticRuntimeMs,
      0,
    );
    return {
      groupKey: input.group.key,
      caseCount: input.group.items.length,
      eventCount: input.group.events.length,
      caseIds: input.group.items
        .slice(0, 5)
        .map((item) => item.benchmarkCase.id ?? `case-${item.index + 1}`),
      durationMs,
      setupDurationMs,
      scoringDurationMs: Math.max(0, durationMs - setupDurationMs),
      setupRuntimeMs: setupDurationMs,
      scoringRuntimeMs,
      taxonomyRuntimeMs,
      wideBudgetDiagnosticRuntimeMs,
      passedCount: results.filter((result) => result.pass).length,
      failedCount: results.filter((result) => !result.pass).length,
    };
  } finally {
    await memory.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function runGroupsWithConcurrency(
  groups: CaseGroup[],
  concurrency: number,
  worker: (group: CaseGroup) => Promise<ExternalMemoryBenchmarkGroupTiming>,
): Promise<ExternalMemoryBenchmarkGroupTiming[]> {
  let next = 0;
  const results: ExternalMemoryBenchmarkGroupTiming[] = [];
  const workerCount = Math.min(concurrency, groups.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (next < groups.length) {
        const group = groups[next];
        next += 1;
        if (group) results.push(await worker(group));
      }
    }),
  );
  return results;
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
  const diagnosticsLevel = normalizedDiagnosticsLevel(options.diagnosticsLevel);
  const normalizedOptions: RunExternalMemoryBenchmarkOptions = {
    ...options,
    cases: normalizedCases,
    ...(defaultMode ? { mode: defaultMode } : {}),
    concurrency,
    reuseProfiles: options.reuseProfiles ?? true,
    failureSampleLimit,
    diagnosticsLevel,
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
      durationMs: result.durationMs,
    });
  };
  const groupTimings = await runGroupsWithConcurrency(groups, concurrency, (group) =>
    runCaseGroup({ group, options: normalizedOptions, recordResult }),
  );
  const completedCases = cases.map((entry, index) => {
    if (!entry) throw new Error(`External benchmark case ${index + 1} did not produce a result`);
    return entry;
  });
  const finalPassedCount = completedCases.filter((entry) => entry.pass).length;
  const normalizedEvidencePassedCount = completedCases.filter(
    (entry) => entry.normalizedEvidencePass,
  ).length;
  const finishedAt = new Date().toISOString();
  const summary = buildExternalMemoryBenchmarkSummary(completedCases, failureSampleLimit, groupTimings);
  const strictScore = completedCases.length === 0 ? 0 : finalPassedCount / completedCases.length;
  const normalizedEvidenceScore =
    completedCases.length === 0 ? 0 : normalizedEvidencePassedCount / completedCases.length;
  return {
    schema: "gmos.external_long_memory_qa.v1",
    pass: finalPassedCount === completedCases.length,
    datasetFormat: normalizedOptions.datasetFormat ?? "gmos.external_long_memory_qa.jsonl",
    caseCount: completedCases.length,
    passedCount: finalPassedCount,
    failedCount: completedCases.length - finalPassedCount,
    score: strictScore,
    strictScore,
    normalizedEvidenceScore,
    normalizedEvidencePassedCount,
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
