import type {
  MemoryExtractionCandidate,
  MemoryExtractionInput,
  MemoryExtractor,
  MemoryKind,
} from "./types.js";
import { sanitizePublicPayloadRecord, sanitizePublicSourceMetadata } from "./safety.js";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "statusText" | "text">>;

export interface OpenAICompatibleExtractorOptions {
  name?: string | undefined;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model: string;
  fetch?: FetchLike | undefined;
  timeoutMs?: number | undefined;
  maxCandidates?: number | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  responseFormat?: boolean | undefined;
  headers?: Record<string, string> | undefined;
  includeEventMetadata?: boolean | undefined;
}

const MEMORY_KINDS = new Set<MemoryKind>([
  "fact",
  "preference",
  "boundary",
  "procedure",
  "project",
  "task_trajectory",
]);

function endpoint(baseUrl: string | undefined): string {
  const root = (baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/u, "");
  return `${root}/chat/completions`;
}

function boundedInteger(input: number | undefined, fallback: number, min: number, max: number): number {
  if (input === undefined || !Number.isFinite(input)) return fallback;
  return Math.max(min, Math.min(Math.trunc(input), max));
}

function boundedNumber(input: number | undefined, fallback: number, min: number, max: number): number {
  if (input === undefined || !Number.isFinite(input)) return fallback;
  return Math.max(min, Math.min(input, max));
}

function contentFromCompletion(payload: unknown): string {
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return "";
  const first = choices[0] as { message?: { content?: unknown }; text?: unknown } | undefined;
  const content = first?.message?.content ?? first?.text;
  return typeof content === "string" ? content : "";
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("```")) {
    const withoutFence = trimmed
      .replace(/^```(?:json)?\s*/iu, "")
      .replace(/\s*```$/u, "")
      .trim();
    return JSON.parse(withoutFence) as unknown;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  }
  return JSON.parse(trimmed) as unknown;
}

function candidateArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  for (const key of ["memories", "candidates", "memoryCandidates"]) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const output = value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
  return output.length > 0 ? output : undefined;
}

function optionalActionPolicyKind(
  value: unknown,
): MemoryExtractionCandidate["actionPolicyKind"] | undefined {
  return value === "do_not_push" || value === "prefer" || value === "procedure"
    ? value
    : undefined;
}

function optionalCardinality(value: unknown): MemoryExtractionCandidate["cardinality"] | undefined {
  return value === "single" || value === "multi" ? value : undefined;
}

function metadataRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function normalizeCandidate(value: unknown): MemoryExtractionCandidate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  const content = optionalString(record.content);
  if (!MEMORY_KINDS.has(kind as MemoryKind) || !content) return null;
  const confidence = boundedNumber(Number(record.confidence), 0, 0, 1);
  const subjectAliases = optionalStringArray(record.subjectAliases);
  return {
    kind: kind as MemoryKind,
    content,
    confidence,
    ...(optionalString(record.predicate) ? { predicate: optionalString(record.predicate) } : {}),
    ...(optionalString(record.subject) ? { subject: optionalString(record.subject) } : {}),
    ...(subjectAliases ? { subjectAliases } : {}),
    ...(optionalString(record.object) ? { object: optionalString(record.object) } : {}),
    ...(optionalString(record.source) ? { source: optionalString(record.source) } : {}),
    ...(optionalString(record.eventTime) ? { eventTime: optionalString(record.eventTime) } : {}),
    ...(optionalString(record.validFrom) ? { validFrom: optionalString(record.validFrom) } : {}),
    ...(optionalString(record.validTo) ? { validTo: optionalString(record.validTo) } : {}),
    ...(optionalCardinality(record.cardinality)
      ? { cardinality: optionalCardinality(record.cardinality) }
      : {}),
    ...(optionalActionPolicyKind(record.actionPolicyKind)
      ? { actionPolicyKind: optionalActionPolicyKind(record.actionPolicyKind) }
      : {}),
    metadata: metadataRecord(record.metadata),
  };
}

function systemPrompt(maxCandidates: number): string {
  return [
    "You are a structured memory extractor for a local-first personal agent memory runtime.",
    "Return only JSON. Do not include markdown.",
    `Return at most ${maxCandidates} memory candidates in {"memories":[...]}.`,
    "Allowed kind values: fact, preference, boundary, procedure, project, task_trajectory.",
    "Do not emit person memory or PERSON-routed facts.",
    "Do not emit API keys, passwords, tokens, private keys, SSNs, or other secret-like content.",
    "Only extract durable user-world information that is useful in future turns.",
    "Use confidence from 0 to 1. Use cardinality='single' only for current-state beliefs.",
    "Use subject, subjectAliases, predicate, and object for world-state facts; object should be the concise current value. Use source only for a concise public source label. Use eventTime, validFrom, and validTo as ISO dates or instants when the text gives time bounds.",
  ].join("\n");
}

function userPrompt(input: MemoryExtractionInput, options: OpenAICompatibleExtractorOptions): string {
  return JSON.stringify({
    event: {
      role: input.event.role,
      content: input.event.content,
      privacyMode: input.event.privacyMode ?? "normal",
      ...(options.includeEventMetadata
        ? { metadata: sanitizePublicSourceMetadata(input.event.metadata) }
        : {}),
    },
    evidence: {
      sourceType: input.evidence.sourceType,
      eligibleForLongTermMemory: input.evidence.eligibleForLongTermMemory,
      sensitivity: input.evidence.sensitivity,
    },
    ruleCandidates: input.ruleCandidates,
  });
}

export function createOpenAICompatibleExtractor(
  options: OpenAICompatibleExtractorOptions,
): MemoryExtractor {
  const maxCandidates = boundedInteger(options.maxCandidates, 6, 1, 16);
  const timeoutMs = boundedInteger(options.timeoutMs, 20_000, 1000, 120_000);
  const maxTokens = boundedInteger(options.maxTokens, 1200, 64, 8192);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("createOpenAICompatibleExtractor requires fetch in this runtime");
  }
  return {
    name: options.name ?? `openai-compatible:${options.model}`,
    async extract(input) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(endpoint(options.baseUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
            ...(options.headers ?? {}),
          },
          signal: controller.signal,
          body: JSON.stringify({
            model: options.model,
            temperature: boundedNumber(options.temperature, 0, 0, 2),
            max_tokens: maxTokens,
            ...(options.responseFormat === false
              ? {}
              : { response_format: { type: "json_object" } }),
            messages: [
              { role: "system", content: systemPrompt(maxCandidates) },
              { role: "user", content: userPrompt(input, options) },
            ],
          }),
        });
        const responseText = await response.text();
        if (!response.ok) {
          throw new Error(
            `OpenAI-compatible extractor request failed: ${response.status} ${response.statusText}`,
          );
        }
        const completion = JSON.parse(responseText) as unknown;
        const content = contentFromCompletion(completion);
        const parsed = parseJsonObject(content);
        return candidateArray(parsed)
          .slice(0, maxCandidates)
          .map(normalizeCandidate)
          .filter((candidate): candidate is MemoryExtractionCandidate => candidate !== null)
          .map((candidate) => ({
            ...candidate,
            metadata: {
              ...(candidate.metadata ?? {}),
              llmExtractorModel: options.model,
              llmExtractorProvider: "openai-compatible",
            },
          }));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
