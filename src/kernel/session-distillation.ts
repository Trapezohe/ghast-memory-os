import { createHash } from "node:crypto";

import { properNounTokens, sourceGroundsTerms } from "./extraction.js";
import { isPersonRoutedMemory } from "./safety.js";
import {
  normalizeExplicitTemporalInstant,
  temporalCueValuesFromText,
} from "./temporal-validity.js";
import type {
  MemoryCanonicalEventCandidate,
  MemoryExtractionCandidate,
  MemoryRole,
  MemorySessionDistillationResult,
} from "./types.js";

const MAX_EVENT_CONTENT_LENGTH = 2000;
const NON_EVENT_TYPE_PART = /(?:^|_)(?:advice|consideration|discussion|information|inquiry|interest|opinion|preference|question|recommendation|request|statement|topic)(?:_|$)/u;
const NON_EVENT_CONTENT = /^(?:(?:the )?(?:assistant|user) )?(?:asked|considered|discussed|expressed (?:an )?(?:interest|opinion|preference)|inquired|requested|sought advice|wondered)\b/iu;
const EVENT_ACTION = "attend|visit|view|see|buy|purchase|return|pick up|collect|receive|get|make|bake|cook|play|spend|finish|complete|start|stop|change|update|book|reserve|travel|go|arrive|leave|meet|win|lose|sell|exchange|inspect|sign|submit|pay|move|graduate|join|create|build|fix|send|share|use|try|take|give";
const EVENT_ACTION_PAST = "attended|visited|viewed|saw|bought|purchased|returned|picked up|collected|received|got|made|baked|cooked|played|spent|finished|completed|started|stopped|changed|updated|booked|reserved|traveled|travelled|went|arrived|left|met|won|lost|sold|exchanged|inspected|signed|submitted|paid|moved|graduated|joined|created|built|fixed|sent|shared|used|tried|took|gave|became|fell";
const EVENT_BEARING_PATTERNS = [
  new RegExp(`\\b(?:i|we)(?:'ve| have| had)?\\s+(?:(?:just|recently|already|finally|actually)\\s+)?(?:${EVENT_ACTION_PAST})\\b`, "iu"),
  new RegExp(`\\b(?:i|we)\\s+(?:still\\s+)?(?:need|have|must)\\s+to\\s+(?:${EVENT_ACTION})\\b`, "iu"),
  new RegExp(`\\b(?:i|we)\\s+(?:still\\s+)?(?:haven't|have not|hadn't|had not)\\s+(?:(?:yet|just)\\s+)?(?:(?:${EVENT_ACTION_PAST})|had a chance to (?:${EVENT_ACTION}))\\b`, "iu"),
  /\b(?:i|we)\s+(?:(?:was|were)\s+|(?:served|acted)\s+as\s+)[^.!?]{1,80}\s+(?:at|during)\s+/iu,
];

export interface SessionDistillationSource {
  evidenceId: string;
  sourceEvidenceId: string;
  episodeKey?: string | undefined;
  turnOrdinal?: number | undefined;
  role: MemoryRole;
  content: string;
  createdAt?: string | undefined;
}

interface CitedSessionDistillationSource extends SessionDistillationSource {
  episodeKey: string;
  turnOrdinal: number;
}

export interface AcceptedCanonicalEvent {
  candidate: MemoryExtractionCandidate;
  eventRecordKey: string;
  eventType: string;
  citations: Array<{
    sourceEvidenceId: string;
    episodeKey: string;
    turnOrdinal: number;
  }>;
  eventTime: string;
  metadata: Record<string, unknown>;
}

export interface AcceptedSessionDistillation {
  narrative: MemoryExtractionCandidate | null;
  events: AcceptedCanonicalEvent[];
}

function text(value: unknown, maxLength = 240): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}

function strings(value: unknown, maxItems = 16): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) return undefined;
  const normalized = value.map((entry) => text(entry)).filter((entry): entry is string => Boolean(entry));
  if (normalized.length !== value.length) return undefined;
  return [...new Map(normalized.map((entry) => [entry.toLowerCase(), entry])).values()];
}

function ordinals(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return undefined;
  if (!value.every((entry) => typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0)) {
    return undefined;
  }
  return [...new Set(value)].sort((left, right) => left - right);
}

function normalizedEventTypeSurface(value: unknown): string | undefined {
  const normalized = text(value, 80)
    ?.toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return normalized && /^[\p{L}\p{N}][\p{L}\p{N}_]*$/u.test(normalized)
    ? normalized
    : undefined;
}

function singularTypePart(value: string): string {
  if (value === "series" || value === "species") return value;
  if (/[^aeiou]ies$/u.test(value)) return `${value.slice(0, -3)}y`;
  if (/(?:ches|shes|sses|xes|zes)$/u.test(value)) return value.slice(0, -2);
  if (value.endsWith("s") && !/(?:is|ss|us)$/u.test(value)) return value.slice(0, -1);
  return value;
}

function eventTypeFamily(value: string): string {
  return value.split("_").map(singularTypePart).join("_");
}

function knownEventTypeMap(values: readonly string[]): Map<string, string> {
  const output = new Map<string, string>();
  for (const value of values.flatMap((entry) => normalizedEventTypeSurface(entry) ?? []).sort()) {
    const family = eventTypeFamily(value);
    if (!output.has(family)) output.set(family, value);
  }
  return output;
}

function resolvedEventType(value: unknown, knownTypes: Map<string, string>): string | undefined {
  const surface = normalizedEventTypeSurface(value);
  if (!surface) return undefined;
  const family = eventTypeFamily(surface);
  return knownTypes.get(family) ?? family;
}

function purelyNonEvent(eventType: string, content: string): boolean {
  return NON_EVENT_TYPE_PART.test(eventType) ||
    NON_EVENT_CONTENT.test(content) ||
    (/\?\s*$/u.test(content) && !EVENT_BEARING_PATTERNS.some((pattern) => pattern.test(content)));
}

export function shouldReplaySessionDistillation(
  messages: ReadonlyArray<{ role: MemoryRole; content: string }>,
  acceptedEventCount: number,
): boolean {
  return acceptedEventCount === 0 && messages.some((message) =>
    message.role === "user" && EVENT_BEARING_PATTERNS.some((pattern) => pattern.test(message.content))
  );
}

function normalizedNarrative(result: MemorySessionDistillationResult): MemoryExtractionCandidate | null {
  if (!result || !result.narrative || typeof result.narrative !== "object") return null;
  const content = text(result.narrative.content, MAX_EVENT_CONTENT_LENGTH);
  if (!content || result.narrative.kind === "person" || isPersonRoutedMemory(content)) return null;
  return {
    kind: "fact",
    content,
    confidence: Math.max(0, Math.min(result.narrative.confidence ?? 0.6, 1)),
    metadata: {},
  };
}

function citedSources(
  candidate: MemoryCanonicalEventCandidate,
  sources: SessionDistillationSource[],
): CitedSessionDistillationSource[] | null {
  const evidenceIds = strings(candidate.sourceEvidenceIds, 64);
  const citedOrdinals = ordinals(candidate.turnOrdinals);
  const episodeKey = text(candidate.episodeKey, 80);
  if (!evidenceIds || !citedOrdinals || !episodeKey) return null;
  const evidenceSet = new Set(evidenceIds);
  const cited = sources.filter((source) => evidenceSet.has(source.evidenceId));
  if (cited.length !== evidenceIds.length) return null;
  if (cited.some((source) => source.episodeKey !== episodeKey || source.turnOrdinal === undefined)) {
    return null;
  }
  const complete = cited.map((source) => ({
    ...source,
    episodeKey,
    turnOrdinal: source.turnOrdinal as number,
  }));
  const sourceOrdinals = [...new Set(complete.map((source) => source.turnOrdinal))].sort((a, b) => a - b);
  return JSON.stringify(sourceOrdinals) === JSON.stringify(citedOrdinals) ? complete : null;
}

function sourceAnchorsEventTime(eventTime: string, sources: SessionDistillationSource[]): boolean {
  const normalized = normalizeExplicitTemporalInstant(eventTime);
  if (!normalized) return false;
  const exactInstant = /T\d{2}:\d{2}/u.test(eventTime);
  for (const source of sources) {
    const cues = temporalCueValuesFromText(source.content);
    if (cues.includes(exactInstant ? normalized : normalized.slice(0, 10))) return true;
    const createdAt = source.createdAt ? normalizeExplicitTemporalInstant(source.createdAt) : null;
    if (createdAt && (exactInstant ? createdAt === normalized : createdAt.slice(0, 10) === normalized.slice(0, 10))) {
      return true;
    }
  }
  return false;
}

function groundedEventFields(input: {
  content: string;
  participants?: string[] | undefined;
  target?: string | undefined;
  action?: string | undefined;
  quantity?: string | undefined;
  amount?: string | undefined;
  sources: SessionDistillationSource[];
}): boolean {
  if (!input.target && !input.participants?.length) return false;
  const source = input.sources.map((entry) => entry.content).join("\n");
  const fields = [
    ...(input.participants ?? []).filter((participant) => participant.toLowerCase() !== "user"),
    input.target,
    input.action,
    input.quantity,
    input.amount,
    ...properNounTokens(input.content),
  ].filter((entry): entry is string => Boolean(entry));
  return fields.every((field) => sourceGroundsTerms(source, field));
}

function obligationPredicate(action: string): string {
  return `obligation.${action.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/gu, "")}`;
}

function eventRecordKey(fields: Record<string, unknown>): string {
  const hash = createHash("sha256").update(JSON.stringify(fields), "utf8").digest("hex").slice(0, 32);
  return `canonical_event:v1:${hash}`;
}

function identityText(value: string | undefined): string | undefined {
  return value?.toLowerCase().replace(/\s+/gu, " ").trim();
}

function normalizeEvent(
  raw: MemoryCanonicalEventCandidate,
  sources: SessionDistillationSource[],
  knownTypes: Map<string, string>,
): AcceptedCanonicalEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const eventType = resolvedEventType(raw.eventType, knownTypes);
  const content = text(raw.content, MAX_EVENT_CONTENT_LENGTH);
  const participants = raw.participants === undefined
    ? undefined
    : strings(raw.participants)?.sort((left, right) => left.localeCompare(right));
  const target = text(raw.target);
  const action = text(raw.action, 120);
  const quantity = text(raw.quantity, 120);
  const amount = text(raw.amount, 120);
  const state = raw.state === "pending" || raw.state === "completed" ? raw.state : undefined;
  const eventTime = text(raw.eventTime, 64);
  const cited = citedSources(raw, sources);
  if (!eventType || !content || !eventTime || !cited || isPersonRoutedMemory(content) || purelyNonEvent(eventType, content)) {
    return null;
  }
  if (raw.participants !== undefined && !participants) return null;
  if (!sourceAnchorsEventTime(eventTime, cited)) return null;
  if (!groundedEventFields({ content, participants, target, action, quantity, amount, sources: cited })) return null;
  const obligation = eventType.startsWith("obligation_");
  if (obligation && (!action || !target || !state || !eventType.endsWith(state))) return null;
  const normalizedTime = normalizeExplicitTemporalInstant(eventTime);
  if (!normalizedTime) return null;
  const identity = obligation
    ? {
        eventType: "obligation",
        participants: participants?.map((participant) => identityText(participant)) ?? [],
        target: identityText(target),
        state,
        action: identityText(action),
      }
    : {
        eventType,
        participants: participants?.map((participant) => identityText(participant)) ?? [],
        target: identityText(target),
        eventTime: normalizedTime,
        action: identityText(action),
        quantity: identityText(quantity),
        amount: identityText(amount),
      };
  const citations = cited.map((source) => ({
    sourceEvidenceId: source.sourceEvidenceId,
    episodeKey: source.episodeKey,
    turnOrdinal: source.turnOrdinal,
  }));
  const metadata = { eventType, ...(participants ? { participants } : {}), ...(target ? { target } : {}), ...(state ? { eventState: state } : {}), ...(action ? { eventAction: action } : {}), ...(quantity ? { quantity } : {}), ...(amount ? { amount } : {}) };
  return {
    candidate: {
      kind: "fact",
      content,
      confidence: Math.max(0, Math.min(raw.confidence ?? 0.7, 1)),
      ...(target ? { subject: target } : {}),
      predicate: obligation && action ? obligationPredicate(action) : `event.${eventType}`,
      object: state ?? content,
      cardinality: obligation ? "single" : "multi",
      eventTime: normalizedTime,
      metadata: obligation ? { obligationAction: action, targetInstance: target, obligationState: state } : {},
    },
    eventRecordKey: eventRecordKey(identity),
    eventType,
    citations,
    eventTime: normalizedTime,
    metadata,
  };
}

function mergeEvents(events: AcceptedCanonicalEvent[]): AcceptedCanonicalEvent[] {
  const merged = new Map<string, AcceptedCanonicalEvent>();
  for (const event of events) {
    const existing = merged.get(event.eventRecordKey);
    if (!existing) {
      merged.set(event.eventRecordKey, event);
      continue;
    }
    const citations = [...existing.citations, ...event.citations].filter((citation, index, all) =>
      all.findIndex((entry) => entry.sourceEvidenceId === citation.sourceEvidenceId) === index
    );
    existing.citations = citations;
  }
  return [...merged.values()];
}

export function normalizeSessionDistillationResult(
  result: MemorySessionDistillationResult,
  sources: SessionDistillationSource[],
  knownEventTypes: readonly string[] = [],
): AcceptedSessionDistillation {
  const knownTypes = knownEventTypeMap(knownEventTypes);
  const events: AcceptedCanonicalEvent[] = [];
  for (const raw of Array.isArray(result?.events) ? result.events : []) {
    const event = normalizeEvent(raw, sources, knownTypes);
    if (!event) continue;
    events.push(event);
    knownTypes.set(eventTypeFamily(event.eventType), event.eventType);
  }
  return { narrative: normalizedNarrative(result), events: mergeEvents(events) };
}
