import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { redactForReport } from "./safety.js";

export type OpenAICompatibleResponseFailureKind = "parse_failure" | "transport_failure";

export class OpenAICompatibleResponseError extends Error {
  readonly failureKind: OpenAICompatibleResponseFailureKind;

  constructor(message: string, failureKind: OpenAICompatibleResponseFailureKind) {
    super(message);
    this.name = "OpenAICompatibleResponseError";
    this.failureKind = failureKind;
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
  maxFiles?: number | undefined;
  maxChars?: number | undefined;
}

export interface OpenAICompatibleDebugSample {
  hook: string;
  requestPrompt: string;
  rawResponseText: string;
  completionText?: string | undefined;
  outcome: string;
  error?: string | undefined;
}

let debugSessionCounter = 0;

function boundedInteger(input: number | undefined, fallback: number, min: number, max: number): number {
  if (input === undefined || !Number.isFinite(input)) return fallback;
  return Math.max(min, Math.min(Math.trunc(input), max));
}

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
  const maxFiles = boundedInteger(options.maxFiles, 50, 1, 1000);
  const maxChars = boundedInteger(options.maxChars, 8000, 256, 200000);
  const sessionId = `${process.pid}-${Date.now()}-${++debugSessionCounter}`;
  let callCount = 0;
  let written = 0;
  return (sample) => {
    callCount += 1;
    const failure = sample.outcome === "parse_failure" || sample.outcome === "transport_failure";
    if ((!failure && callCount > firstCalls) || written >= maxFiles) return;
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
        ...(sample.error ? { error: boundedDebugText(sample.error, maxChars) } : {}),
      }, null, 2)}\n`,
    );
  };
}
