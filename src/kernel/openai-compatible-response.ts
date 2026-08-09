import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { redactForReport } from "./safety.js";

export type OpenAICompatibleResponseFailureKind = "parse_failure" | "transport_failure";

export type OpenAICompatibleRequestStage =
  | "extractor"
  | "session_distiller"
  | "consolidator"
  | "embedding_bulk"
  | "embedding_query"
  | "query_planner"
  | "reranker"
  | "procedure_distiller"
  | "dossier_synthesizer"
  | "answerer"
  | "judge";

export interface OpenAICompatibleTerminalFailure {
  stage: OpenAICompatibleRequestStage;
  failureKind: OpenAICompatibleResponseFailureKind;
  status?: number | undefined;
  retryAfterMs?: number | undefined;
  retryCount: number;
}

export interface OpenAICompatibleRequestObserver {
  beforeAttempt(stage: OpenAICompatibleRequestStage): void;
  terminalFailure(failure: OpenAICompatibleTerminalFailure): void;
  succeeded(stage: OpenAICompatibleRequestStage): void;
  maxRetryDelayMs?: number | undefined;
}

const REQUEST_OBSERVER = new AsyncLocalStorage<OpenAICompatibleRequestObserver>();
const REQUEST_LIFECYCLE_OWNERS = new WeakSet<object>();

export function markOpenAICompatibleRequestLifecycleOwner<T extends object>(value: T): T {
  REQUEST_LIFECYCLE_OWNERS.add(value);
  return value;
}

export function ownsOpenAICompatibleRequestLifecycle(value: unknown): boolean {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? REQUEST_LIFECYCLE_OWNERS.has(value)
    : false;
}

export function withOpenAICompatibleRequestObserver<T>(
  observer: OpenAICompatibleRequestObserver,
  operation: () => T,
): T {
  return REQUEST_OBSERVER.run(observer, operation);
}

const RETRY_COUNT = Symbol.for("@ghast/memory.openaiCompatibleRetryCount");

export class OpenAICompatibleResponseError extends Error {
  readonly failureKind: OpenAICompatibleResponseFailureKind;
  readonly retryable: boolean;
  readonly retryAfterMs?: number | undefined;
  readonly status?: number | undefined;

  constructor(
    message: string,
    failureKind: OpenAICompatibleResponseFailureKind,
    details: {
      retryable?: boolean | undefined;
      retryAfterMs?: number | undefined;
      status?: number | undefined;
    } = {},
  ) {
    super(message);
    this.name = "OpenAICompatibleResponseError";
    this.failureKind = failureKind;
    this.retryable = details.retryable ?? failureKind === "transport_failure";
    this.retryAfterMs = details.retryAfterMs;
    this.status = details.status;
  }
}

export function openAICompatibleFailureKind(error: unknown): OpenAICompatibleResponseFailureKind {
  return error instanceof OpenAICompatibleResponseError
    ? error.failureKind
    : "transport_failure";
}

export function openAICompatibleOutcomeForError(error: unknown): "parse_failure" | "transport_failure" {
  return openAICompatibleFailureKind(error);
}

export interface OpenAICompatibleRetryOptions {
  timeoutMs?: number | undefined;
  retries?: number | undefined;
  maxRetries?: number | undefined;
  backoffMs?: number | undefined;
  maxRetryDelayMs?: number | undefined;
  stage?: OpenAICompatibleRequestStage | undefined;
}

export interface OpenAICompatibleRetryResult<T> {
  value: T;
  retryCount: number;
}

function boundedInteger(input: number | undefined, fallback: number, min: number, max: number): number {
  if (input === undefined || !Number.isFinite(input)) return fallback;
  return Math.max(min, Math.min(Math.trunc(input), max));
}

export function openAICompatibleRetryCount(value: unknown): number {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return 0;
  const retryCount = (value as { [RETRY_COUNT]?: unknown })[RETRY_COUNT];
  return typeof retryCount === "number" && Number.isInteger(retryCount) && retryCount > 0
    ? retryCount
    : 0;
}

export function attachOpenAICompatibleRetryCount<T extends object>(
  value: T,
  retryCount: number,
): T {
  Object.defineProperty(value, RETRY_COUNT, {
    value: Math.max(0, Math.trunc(retryCount)),
    enumerable: false,
    configurable: true,
  });
  return value;
}

export function openAICompatibleRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.trunc(seconds * 1000);
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - Date.now());
}

function retryableTransportError(error: unknown): boolean {
  if (error instanceof OpenAICompatibleResponseError) {
    return error.retryable;
  }
  return true;
}

function retryDelayMs(error: unknown, attempt: number, backoffMs: number): number {
  if (
    error instanceof OpenAICompatibleResponseError &&
    error.retryAfterMs !== undefined
  ) {
    return error.retryAfterMs;
  }
  const base = Math.min(backoffMs * 2 ** attempt, 5000);
  return Math.trunc(base + Math.random() * Math.max(1, Math.ceil(base * 0.25)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runOpenAICompatibleRetry<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: OpenAICompatibleRetryOptions | undefined,
): Promise<OpenAICompatibleRetryResult<T>> {
  const timeoutMs = boundedInteger(options?.timeoutMs, 20_000, 1000, 120_000);
  const retries = boundedInteger(options?.retries ?? options?.maxRetries, 2, 0, 5);
  const backoffMs = boundedInteger(options?.backoffMs, 250, 0, 30_000);
  const stage = options?.stage;
  const observer = stage ? REQUEST_OBSERVER.getStore() : undefined;
  // Uncapped server retry-after values have stalled ingest for over an hour;
  // beyond the cap the failure is terminal so circuit/replay handling stays honest.
  const maxRetryDelayMs = options?.maxRetryDelayMs ?? observer?.maxRetryDelayMs ?? 60_000;
  let retryCount = 0;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (stage) observer?.beforeAttempt(stage);
      const value = await operation(controller.signal);
      if (stage) observer?.succeeded(stage);
      return { value, retryCount };
    } catch (error) {
      lastError = error;
      if (!retryableTransportError(error) || attempt >= retries) break;
      const delayMs = retryDelayMs(error, attempt, backoffMs);
      if (maxRetryDelayMs !== undefined && delayMs > Math.max(0, maxRetryDelayMs)) break;
      retryCount += 1;
      await sleep(delayMs);
    } finally {
      clearTimeout(timer);
    }
  }
  const error = lastError instanceof Error
    ? lastError
    : new OpenAICompatibleResponseError("OpenAI-compatible request timed out", "transport_failure");
  attachOpenAICompatibleRetryCount(error, retryCount);
  if (stage) {
    observer?.terminalFailure({
      stage,
      failureKind: openAICompatibleFailureKind(error),
      ...(error instanceof OpenAICompatibleResponseError && error.status !== undefined
        ? { status: error.status }
        : {}),
      ...(error instanceof OpenAICompatibleResponseError && error.retryAfterMs !== undefined
        ? { retryAfterMs: error.retryAfterMs }
        : {}),
      retryCount,
    });
  }
  throw error;
}

export function textFromOpenAICompatibleContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(textFromOpenAICompatibleContent).filter(Boolean).join("\n");
  }
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.output_text === "string") return record.output_text;
  if (record.content !== undefined) return textFromOpenAICompatibleContent(record.content);
  return "";
}

export function openAICompatibleTruncatedFinishReasons(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const reasons = Array.isArray(record.choices)
    ? record.choices.flatMap((choice) => {
        if (!choice || typeof choice !== "object") return [];
        const reason = (choice as Record<string, unknown>).finish_reason;
        return typeof reason === "string" ? [reason] : [];
      })
    : [];
  if (record.status === "incomplete" && record.incomplete_details &&
      typeof record.incomplete_details === "object") {
    const reason = (record.incomplete_details as Record<string, unknown>).reason;
    if (typeof reason === "string") reasons.push(reason);
  }
  return reasons.filter((reason) =>
    reason === "length" || reason === "max_tokens" || reason === "max_output_tokens"
  );
}

export function openAICompatibleDisableThinkingFields(
  disableThinking: boolean | undefined,
): Record<string, unknown> {
  return disableThinking
    ? { enable_thinking: false, reasoning_effort: "none" }
    : {};
}

function reasoningTextFromRecord(record: Record<string, unknown>): string {
  return [
    record.reasoning_content,
    record.reasoning,
    record.reasoningText,
  ]
    .map(textFromOpenAICompatibleContent)
    .filter(Boolean)
    .join("\n");
}

function completionTextCandidates(payload: unknown): Array<{ source: "content" | "reasoning"; text: string }> {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const candidates: Array<{ source: "content" | "reasoning"; text: string }> = [];
  if (typeof record.output_text === "string") {
    candidates.push({ source: "content", text: record.output_text });
  }
  if (Array.isArray(record.output)) {
    const text = textFromOpenAICompatibleContent(record.output);
    if (text) candidates.push({ source: "content", text });
    const reasoning = record.output
      .map((entry) =>
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? reasoningTextFromRecord(entry as Record<string, unknown>)
          : "",
      )
      .filter(Boolean)
      .join("\n");
    if (reasoning) candidates.push({ source: "reasoning", text: reasoning });
  }
  const choices = record.choices;
  if (Array.isArray(choices)) {
    const first = choices[0] as {
      message?: Record<string, unknown>;
      text?: unknown;
      reasoning?: unknown;
      reasoning_content?: unknown;
    } | undefined;
    const message = first?.message;
    const content = textFromOpenAICompatibleContent(message?.content ?? first?.text);
    if (content) candidates.push({ source: "content", text: content });
    const reasoning = [
      message ? reasoningTextFromRecord(message) : "",
      textFromOpenAICompatibleContent(first?.reasoning_content),
      textFromOpenAICompatibleContent(first?.reasoning),
    ].filter(Boolean).join("\n");
    if (reasoning) candidates.push({ source: "reasoning", text: reasoning });
  }
  return candidates;
}

function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
  return match ? match[1]!.trim() : trimmed;
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function balancedJsonSubstrings(text: string): string[] {
  const substrings: string[] = [];
  for (let start = 0; start < text.length; start += 1) {
    const first = text[start];
    if (first !== "{" && first !== "[") continue;
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index]!;
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }
      if (char === "\"") {
        inString = true;
      } else if (char === "{" || char === "[") {
        stack.push(char === "{" ? "}" : "]");
      } else if (char === "}" || char === "]") {
        const expected = stack.pop();
        if (expected !== char) break;
        if (stack.length === 0) {
          substrings.push(text.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return substrings;
}

export function parseOpenAICompatibleJsonText(text: string, label: string): unknown {
  const trimmed = stripMarkdownFence(text);
  if (!trimmed) {
    throw new OpenAICompatibleResponseError(
      `${label} returned empty completion content`,
      "parse_failure",
    );
  }
  try {
    return parseJson(trimmed);
  } catch {
    // Try balanced JSON below.
  }
  const candidates = balancedJsonSubstrings(trimmed);
  for (const candidate of candidates) {
    try {
      return parseJson(candidate);
    } catch {
      // Keep scanning; prose can contain non-JSON bracketed text before the contract.
    }
  }
  throw new OpenAICompatibleResponseError(
    candidates.length > 0
      ? `${label} returned malformed JSON content`
      : `${label} returned completion content without JSON`,
    "parse_failure",
  );
}

export function parseOpenAICompatibleCompletionJson(payload: unknown, label: string): {
  parsed: unknown;
  text: string;
  source: "content" | "reasoning";
} {
  const candidates = completionTextCandidates(payload);
  const contentCandidates = candidates.filter((candidate) => candidate.source === "content");
  const reasoningCandidates = candidates.filter((candidate) => candidate.source === "reasoning");
  const ordered = [...contentCandidates, ...reasoningCandidates];
  if (ordered.length === 0) {
    throw new OpenAICompatibleResponseError(
      `${label} returned empty completion content`,
      "parse_failure",
    );
  }
  let lastError: OpenAICompatibleResponseError | null = null;
  for (const candidate of ordered) {
    try {
      return {
        parsed: parseOpenAICompatibleJsonText(candidate.text, label),
        text: candidate.text,
        source: candidate.source,
      };
    } catch (error) {
      if (error instanceof OpenAICompatibleResponseError) lastError = error;
      else throw error;
    }
  }
  const onlyReasoning = contentCandidates.length === 0 && reasoningCandidates.length > 0;
  throw new OpenAICompatibleResponseError(
    onlyReasoning
      ? `${label} returned reasoning-only completion without JSON; consider disabling thinking`
      : lastError?.message ?? `${label} returned completion content without JSON`,
    "parse_failure",
  );
}

export interface OpenAICompatibleDebugOptions {
  dir?: string | undefined;
  firstCalls?: number | undefined;
  emptyCalls?: number | undefined;
  maxFiles?: number | undefined;
  maxChars?: number | undefined;
}

export interface OpenAICompatibleDebugSample {
  hook: string;
  requestPrompt: string;
  rawResponseText: string;
  completionText?: string | undefined;
  outcome: string;
  retryCount?: number | undefined;
  error?: string | undefined;
}

let debugSessionCounter = 0;

function boundedDebugText(value: string, maxChars: number): string {
  const redacted = redactForReport(value);
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}...` : redacted;
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-z0-9_-]+/giu, "_").slice(0, 48) || "sample";
}

export function createOpenAICompatibleDebugCapture(
  options: OpenAICompatibleDebugOptions | undefined,
): ((sample: OpenAICompatibleDebugSample) => void) | undefined {
  if (!options?.dir) return undefined;
  const dir = options.dir;
  const firstCalls = boundedInteger(options.firstCalls, 5, 0, 100);
  const emptyCalls = boundedInteger(options.emptyCalls, 5, 0, 100);
  const maxFiles = boundedInteger(options.maxFiles, 50, 1, 1000);
  const maxChars = boundedInteger(options.maxChars, 8000, 256, 200000);
  const sessionId = `${process.pid}-${Date.now()}-${++debugSessionCounter}`;
  let callCount = 0;
  let emptyWritten = 0;
  let written = 0;
  return (sample) => {
    callCount += 1;
    const failure = sample.outcome === "parse_failure" || sample.outcome === "transport_failure";
    const emptySample = sample.outcome === "ok_empty";
    if (emptySample) emptyWritten += 1;
    const keepEmpty = emptySample && emptyWritten <= emptyCalls;
    if ((!failure && !keepEmpty && callCount > firstCalls) || written >= maxFiles) return;
    mkdirSync(dir, { recursive: true });
    written += 1;
    const fileName = [
      "openai-compatible",
      sessionId,
      String(callCount).padStart(6, "0"),
      safeFilePart(sample.outcome),
    ].join("-") + ".json";
    writeFileSync(
      path.join(dir, fileName),
      `${JSON.stringify({
        hook: sample.hook,
        callIndex: callCount,
        outcome: sample.outcome,
        requestPrompt: boundedDebugText(sample.requestPrompt, maxChars),
        rawResponseText: boundedDebugText(sample.rawResponseText, maxChars),
        ...(sample.completionText !== undefined
          ? { completionText: boundedDebugText(sample.completionText, maxChars) }
          : {}),
        ...(sample.retryCount !== undefined ? { retryCount: sample.retryCount } : {}),
        ...(sample.error ? { error: boundedDebugText(sample.error, maxChars) } : {}),
      }, null, 2)}\n`,
    );
  };
}
