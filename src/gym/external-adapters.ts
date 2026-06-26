import {
  parseExternalMemoryBenchmarkJsonl,
  type ExternalMemoryBenchmarkCase,
  type ExternalMemoryBenchmarkDatasetFormat,
  type ExternalMemoryBenchmarkEvent,
  type ExternalMemoryBenchmarkMessageEvent,
} from "./external.js";

export type ExternalMemoryBenchmarkDatasetAdapter = "gmos" | "longmemeval" | "locomo";

export interface ParsedExternalMemoryBenchmarkDataset {
  adapter: ExternalMemoryBenchmarkDatasetAdapter;
  datasetFormat: ExternalMemoryBenchmarkDatasetFormat;
  cases: ExternalMemoryBenchmarkCase[];
  warnings: string[];
}

export interface ParseExternalMemoryBenchmarkDatasetOptions {
  adapter?: ExternalMemoryBenchmarkDatasetAdapter | string | undefined;
  longMemEvalAbstention?: "skip" | "score_answer" | undefined;
}

interface ParsedCaseSet {
  cases: ExternalMemoryBenchmarkCase[];
  warnings: string[];
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseJson(input: string, label: string): unknown {
  try {
    return JSON.parse(input);
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${(error as Error).message}`);
  }
}

function parseJsonArrayOrJsonl(input: string, label: string): unknown[] {
  const trimmed = input.trim();
  if (!trimmed) throw new Error(`${label} requires at least one row`);
  if (trimmed.startsWith("[")) {
    const parsed = parseJson(trimmed, label);
    if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array`);
    return parsed;
  }
  const rows: unknown[] = [];
  for (const [index, rawLine] of input.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    rows.push(parseJson(line, `${label} JSONL line ${index + 1}`));
  }
  if (rows.length === 0) throw new Error(`${label} requires at least one row`);
  return rows;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringsFromAnswer(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (typeof value === "number" && Number.isFinite(value)) return [String(value)];
  if (typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => stringsFromAnswer(entry))
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return [
      ...stringsFromAnswer(record.answer),
      ...stringsFromAnswer(record.answers),
      ...stringsFromAnswer(record.target),
      ...stringsFromAnswer(record.targets),
    ];
  }
  return [];
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function normalizeRole(value: unknown, fallback: ExternalMemoryBenchmarkMessageEvent["role"]): ExternalMemoryBenchmarkMessageEvent["role"] {
  if (value === "system" || value === "user" || value === "assistant" || value === "tool") {
    return value;
  }
  return fallback;
}

function messageEvent(input: {
  role?: unknown;
  content: string;
  createdAt?: unknown;
  fallbackRole?: ExternalMemoryBenchmarkMessageEvent["role"] | undefined;
}): ExternalMemoryBenchmarkMessageEvent {
  const createdAt = stringValue(input.createdAt);
  return {
    type: "message",
    role: normalizeRole(input.role, input.fallbackRole ?? "user"),
    content: input.content,
    ...(createdAt ? { createdAt } : {}),
  };
}

function contentFromTurn(turn: Record<string, unknown>): string | null {
  const content =
    stringValue(turn.content) ?? stringValue(turn.text) ?? stringValue(turn.message);
  const caption = stringValue(turn.blip_caption) ?? stringValue(turn.caption);
  if (!content && !caption) return null;
  return [content, caption ? `Image caption: ${caption}` : ""].filter(Boolean).join("\n");
}

function longMemEvalEvents(row: Record<string, unknown>, caseId: string): ExternalMemoryBenchmarkEvent[] {
  if (!Array.isArray(row.haystack_sessions)) {
    throw new Error(`LongMemEval case ${caseId} requires haystack_sessions`);
  }
  const dates = Array.isArray(row.haystack_dates) ? row.haystack_dates : [];
  const events: ExternalMemoryBenchmarkEvent[] = [];
  for (const [sessionIndex, session] of row.haystack_sessions.entries()) {
    const turns: unknown[] = Array.isArray(session)
      ? session
      : Array.isArray((session as Record<string, unknown>)?.turns)
        ? ((session as Record<string, unknown>).turns as unknown[])
        : [];
    for (const turn of turns) {
      const record = assertRecord(turn, `LongMemEval case ${caseId} turn`);
      const content = contentFromTurn(record);
      if (!content) continue;
      events.push(
        messageEvent({
          role: record.role,
          content,
          createdAt: dates[sessionIndex],
        }),
      );
    }
  }
  if (events.length === 0) throw new Error(`LongMemEval case ${caseId} contains no message turns`);
  return events;
}

function parseLongMemEvalCaseSet(
  input: string,
  options: Pick<ParseExternalMemoryBenchmarkDatasetOptions, "longMemEvalAbstention"> = {},
): ParsedCaseSet {
  const cases: ExternalMemoryBenchmarkCase[] = [];
  const warnings: string[] = [];
  const abstentionMode = options.longMemEvalAbstention ?? "skip";
  for (const [index, entry] of parseJsonArrayOrJsonl(input, "LongMemEval dataset").entries()) {
    const row = assertRecord(entry, `LongMemEval row ${index + 1}`);
    const caseId = stringValue(row.question_id) ?? `longmemeval-${index + 1}`;
    if (caseId.endsWith("_abs") && abstentionMode === "skip") {
      warnings.push(`skipped_longmemeval_abstention:${caseId}`);
      continue;
    }
    const question = stringValue(row.question);
    if (!question) throw new Error(`LongMemEval case ${caseId} requires question`);
    const expectedAny = uniqueStrings(stringsFromAnswer(row.answer));
    if (expectedAny.length === 0) throw new Error(`LongMemEval case ${caseId} requires answer`);
    cases.push({
      id: caseId,
      profileId: `longmemeval_${caseId}`,
      mode: "reconstruct",
      events: longMemEvalEvents(row, caseId),
      question,
      expectedAny,
    });
  }
  if (cases.length === 0) {
    throw new Error("LongMemEval dataset requires at least one non-abstention case");
  }
  return { cases, warnings };
}

export function parseLongMemEvalBenchmarkDataset(input: string): ExternalMemoryBenchmarkCase[] {
  return parseLongMemEvalCaseSet(input).cases;
}

function locomoSessionKeys(conversation: Record<string, unknown>): string[] {
  return Object.keys(conversation)
    .filter((key) => /^session_\d+$/.test(key))
    .sort((a, b) => Number(a.slice("session_".length)) - Number(b.slice("session_".length)));
}

function locomoEvents(row: Record<string, unknown>, sampleId: string): ExternalMemoryBenchmarkEvent[] {
  const conversation = assertRecord(row.conversation, `LoCoMo sample ${sampleId}.conversation`);
  const speakerA = stringValue(conversation.speaker_a);
  const events: ExternalMemoryBenchmarkEvent[] = [];
  for (const sessionKey of locomoSessionKeys(conversation)) {
    const turns = conversation[sessionKey];
    if (!Array.isArray(turns)) continue;
    const createdAt = conversation[`${sessionKey}_date_time`];
    for (const turn of turns) {
      const record = assertRecord(turn, `LoCoMo sample ${sampleId} ${sessionKey} turn`);
      const content = contentFromTurn(record);
      if (!content) continue;
      const speaker = stringValue(record.speaker);
      events.push(
        messageEvent({
          role: speakerA && speaker === speakerA ? "user" : "assistant",
          content,
          createdAt,
        }),
      );
    }
  }
  if (events.length === 0) throw new Error(`LoCoMo sample ${sampleId} contains no dialog turns`);
  return events;
}

export function parseLocomoBenchmarkDataset(input: string): ExternalMemoryBenchmarkCase[] {
  const samples = parseJsonArrayOrJsonl(input, "LoCoMo dataset");
  const cases: ExternalMemoryBenchmarkCase[] = [];
  for (const [sampleIndex, sample] of samples.entries()) {
    const row = assertRecord(sample, `LoCoMo sample ${sampleIndex + 1}`);
    const sampleId = stringValue(row.sample_id) ?? `locomo-${sampleIndex + 1}`;
    const events = locomoEvents(row, sampleId);
    const qaRows = Array.isArray(row.qa) ? row.qa : [];
    if (qaRows.length === 0) throw new Error(`LoCoMo sample ${sampleId} requires qa annotations`);
    for (const [qaIndex, qa] of qaRows.entries()) {
      const qaRecord = assertRecord(qa, `LoCoMo sample ${sampleId} qa ${qaIndex + 1}`);
      const question = stringValue(qaRecord.question);
      if (!question) throw new Error(`LoCoMo sample ${sampleId} qa ${qaIndex + 1} requires question`);
      const expectedAny = uniqueStrings([
        ...stringsFromAnswer(qaRecord.answer),
        ...stringsFromAnswer(qaRecord.adversarial_answer),
      ]);
      if (expectedAny.length === 0) {
        throw new Error(`LoCoMo sample ${sampleId} qa ${qaIndex + 1} requires answer`);
      }
      cases.push({
        id: `${sampleId}:qa-${qaIndex + 1}`,
        profileId: `locomo_${sampleId}`,
        mode: "reconstruct",
        events,
        question,
        expectedAny,
      });
    }
  }
  if (cases.length === 0) throw new Error("LoCoMo dataset requires at least one QA case");
  return cases;
}

export function parseExternalMemoryBenchmarkDataset(
  input: string,
  options: ParseExternalMemoryBenchmarkDatasetOptions = {},
): ParsedExternalMemoryBenchmarkDataset {
  const adapter = options.adapter ?? "gmos";
  if (adapter !== "gmos" && adapter !== "longmemeval" && adapter !== "locomo") {
    throw new Error("External benchmark adapter must be gmos, longmemeval, or locomo");
  }
  if (adapter === "longmemeval") {
    const parsed = parseLongMemEvalCaseSet(input, options);
    return {
      adapter,
      datasetFormat: "longmemeval.json",
      cases: parsed.cases,
      warnings: parsed.warnings,
    };
  }
  if (adapter === "locomo") {
    return {
      adapter,
      datasetFormat: "locomo.json",
      cases: parseLocomoBenchmarkDataset(input),
      warnings: [],
    };
  }
  return {
    adapter,
    datasetFormat: "gmos.external_long_memory_qa.jsonl",
    cases: parseExternalMemoryBenchmarkJsonl(input),
    warnings: [],
  };
}
