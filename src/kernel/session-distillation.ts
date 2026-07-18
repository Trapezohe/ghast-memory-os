import { createHash } from "node:crypto";

import { properNounTokens, sourceGroundsTerms } from "./extraction.js";
import { classifySensitivity, isPersonRoutedMemory } from "./safety.js";
import {
  normalizeExplicitTemporalInstant,
  temporalCueValuesFromText,
} from "./temporal-validity.js";
import type {
  MemoryInstanceAttributes,
  MemoryInstanceKind,
  MemoryInstanceMention,
  MemoryInstanceMentionCandidate,
  MemoryInstanceState,
  MemoryExtractionCandidate,
  MemoryRole,
  MemorySessionDistillationResult,
} from "./types.js";

const MAX_CONTENT_LENGTH = 2000;
const EVENT_ACTION = "attend|visit|view|see|buy|purchase|return|pick up|collect|receive|get|make|bake|cook|play|spend|finish|complete|start|stop|change|update|book|reserve|travel|go|arrive|leave|meet|win|lose|sell|exchange|inspect|sign|submit|pay|move|graduate|join|create|build|fix|replace|send|share|use|try|take|give";
const EVENT_ACTION_PAST = "attended|visited|viewed|saw|bought|purchased|returned|picked up|collected|received|got|made|baked|cooked|played|spent|finished|completed|started|stopped|changed|updated|booked|reserved|traveled|travelled|went|arrived|left|met|won|lost|sold|exchanged|inspected|signed|submitted|paid|moved|graduated|joined|created|built|fixed|replaced|sent|shared|used|tried|took|gave|became|fell";
const EVENT_BEARING_PATTERNS = [
  new RegExp(`\\b(?:i|we)(?:'ve| have| had)?\\s+(?:(?:just|recently|already|finally|actually)\\s+)?(?:${EVENT_ACTION_PAST})\\b`, "iu"),
  new RegExp(`\\b(?:i|we)\\s+(?:still\\s+)?(?:need|have|must)\\s+to\\s+(?:${EVENT_ACTION})\\b`, "iu"),
  new RegExp(`\\b(?:i|we)\\s+(?:still\\s+)?(?:haven't|have not|hadn't|had not)\\s+(?:(?:yet|just)\\s+)?(?:(?:${EVENT_ACTION_PAST})|had a chance to (?:${EVENT_ACTION}))\\b`, "iu"),
  new RegExp(`\\b(?:${EVENT_ACTION}|${EVENT_ACTION_PAST})\\b`, "giu"),
];
const NON_EVENT_CONTENT = /^(?:(?:the )?(?:assistant|user) )?(?:asked|considered|discussed|expressed (?:an )?(?:interest|opinion|preference)|inquired|requested|sought advice|wondered)\b/iu;
const INSTANCE_KINDS = new Set<MemoryInstanceKind>(["object", "occurrence", "obligation", "value"]);
const INSTANCE_STATES = new Set<MemoryInstanceState>([
  "active", "planned", "not_current", "occurred", "pending", "completed", "current", "inactive",
]);

export interface SessionDistillationSource {
  evidenceId: string;
  sourceEvidenceId: string;
  episodeKey?: string | undefined;
  turnOrdinal?: number | undefined;
  role: MemoryRole;
  content: string;
  createdAt?: string | undefined;
}

export interface AcceptedSessionDistillation {
  narrative: MemoryExtractionCandidate | null;
  mentions: MemoryInstanceMention[];
}

function text(value: unknown, maxLength = 240): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}

function normalizedNarrative(result: MemorySessionDistillationResult): MemoryExtractionCandidate | null {
  if (!result?.narrative || typeof result.narrative !== "object") return null;
  const content = text(result.narrative.content, MAX_CONTENT_LENGTH);
  if (!content || result.narrative.kind === "person" || isPersonRoutedMemory(content)) return null;
  return {
    kind: "fact",
    content,
    confidence: Math.max(0, Math.min(result.narrative.confidence ?? 0.6, 1)),
    metadata: {},
  };
}

function citedSource(
  candidate: MemoryInstanceMentionCandidate,
  sources: SessionDistillationSource[],
): SessionDistillationSource | null {
  const sourceEvidenceId = text(candidate.sourceEvidenceId, 160);
  const episodeKey = text(candidate.episodeKey, 80);
  if (!sourceEvidenceId || !episodeKey || !Number.isSafeInteger(candidate.turnOrdinal) || candidate.turnOrdinal < 0) {
    return null;
  }
  const source = sources.find((entry) => entry.evidenceId === sourceEvidenceId);
  return source?.episodeKey === episodeKey && source.turnOrdinal === candidate.turnOrdinal ? source : null;
}

function sourceAnchorsDate(date: string, source: SessionDistillationSource): string | null {
  const normalized = normalizeExplicitTemporalInstant(date);
  if (!normalized) return null;
  const exactInstant = /T\d{2}:\d{2}/u.test(date);
  const cue = exactInstant ? normalized : normalized.slice(0, 10);
  const sourceDate = source.createdAt ? normalizeExplicitTemporalInstant(source.createdAt) : null;
  return temporalCueValuesFromText(source.content).includes(cue) ||
      (sourceDate !== null && (exactInstant ? sourceDate === normalized : sourceDate.slice(0, 10) === cue))
    ? normalized
    : null;
}

function groundedAttributes(
  claim: string,
  attributes: MemoryInstanceAttributes,
  source: SessionDistillationSource,
): boolean {
  const fields = [
    attributes.entity,
    attributes.target,
    attributes.action,
    attributes.quantity,
    attributes.amount,
    ...properNounTokens(claim),
  ].filter((entry): entry is string => Boolean(entry));
  return Boolean(attributes.entity || attributes.target) &&
    fields.every((field) => sourceGroundsTerms(source.content, field));
}

function mentionId(input: Omit<MemoryInstanceMention, "mentionId">): string {
  const digest = createHash("sha256").update(JSON.stringify({
    sourceEvidenceId: input.sourceEvidenceId,
    episodeKey: input.episodeKey,
    turnOrdinal: input.turnOrdinal,
    instanceKind: input.instanceKind,
    state: input.state,
    attributes: input.attributes,
    occurredAt: input.occurredAt,
  }), "utf8").digest("hex").slice(0, 32);
  return `instance_mention:v1:${digest}`;
}

function normalizeMention(
  raw: MemoryInstanceMentionCandidate,
  sources: SessionDistillationSource[],
): MemoryInstanceMention | null {
  if (!raw || typeof raw !== "object" || !INSTANCE_KINDS.has(raw.instanceKind)) return null;
  const claim = text(raw.claim, MAX_CONTENT_LENGTH);
  const source = citedSource(raw, sources);
  const state = raw.state === undefined || INSTANCE_STATES.has(raw.state) ? raw.state : undefined;
  if (!claim || !source || classifySensitivity(claim) === "secret_like" ||
    isPersonRoutedMemory(claim) || (raw.state !== undefined && state === undefined)) return null;
  const attributes: MemoryInstanceAttributes = {
    ...(text(raw.entity) ? { entity: text(raw.entity) } : {}),
    ...(text(raw.target) ? { target: text(raw.target) } : {}),
    ...(text(raw.action, 120) ? { action: text(raw.action, 120) } : {}),
    ...(text(raw.quantity, 120) ? { quantity: text(raw.quantity, 120) } : {}),
    ...(text(raw.amount, 120) ? { amount: text(raw.amount, 120) } : {}),
    ...(text(raw.date, 64) ? { date: text(raw.date, 64) } : {}),
  };
  if (!groundedAttributes(claim, attributes, source)) return null;
  const occurredAt = attributes.date ? sourceAnchorsDate(attributes.date, source) : null;
  if (attributes.date && !occurredAt) return null;
  const observedAt = normalizeExplicitTemporalInstant(source.createdAt ?? "");
  const episodeKey = source.episodeKey;
  const turnOrdinal = source.turnOrdinal;
  if (!observedAt || !episodeKey || turnOrdinal === undefined) return null;
  const mention: Omit<MemoryInstanceMention, "mentionId"> = {
    claim,
    instanceKind: raw.instanceKind,
    ...(state ? { state } : {}),
    attributes,
    sourceEvidenceId: source.sourceEvidenceId,
    episodeKey,
    turnOrdinal,
    observedAt,
    ...(occurredAt ? { occurredAt } : {}),
    confidence: Math.max(0, Math.min(raw.confidence ?? 0.7, 1)),
  };
  return { mentionId: mentionId(mention), ...mention };
}

function mentionSignalDensity(content: string): number {
  if (NON_EVENT_CONTENT.test(content) || /\?\s*$/u.test(content)) return 0;
  const eventBearing = EVENT_BEARING_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(content);
  });
  if (!eventBearing) return 0;
  const actions = content.match(new RegExp(`\\b(?:${EVENT_ACTION}|${EVENT_ACTION_PAST})\\b`, "giu"))?.length ?? 0;
  const coordinatedPhrases = content
    .split(/\s*(?:[,;]|\band\b)\s*/iu)
    .filter((part) => /\p{L}/u.test(part)).length;
  return Math.max(1, Math.min(4, Math.max(
    properNounTokens(content).length,
    actions,
    coordinatedPhrases,
  )));
}

export function shouldReplaySessionDistillation(
  messages: ReadonlyArray<{ role: MemoryRole; content: string; turnOrdinal?: number | undefined }>,
  mentions: ReadonlyArray<Pick<MemoryInstanceMention, "turnOrdinal">>,
): boolean {
  const expected = new Map<number, number>();
  for (const [index, message] of messages.entries()) {
    const density = mentionSignalDensity(message.content);
    if (density > 0) expected.set(message.turnOrdinal ?? index, density);
  }
  if (expected.size === 0) return false;
  const observed = new Map<number, number>();
  for (const mention of mentions) observed.set(mention.turnOrdinal, (observed.get(mention.turnOrdinal) ?? 0) + 1);
  const expectedDensity = [...expected.values()].reduce((sum, value) => sum + value, 0);
  const observedDensity = [...expected].reduce((sum, [ordinal, density]) =>
    sum + Math.min(density, observed.get(ordinal) ?? 0), 0);
  return observedDensity < expectedDensity;
}

export function normalizeSessionDistillationResult(
  result: MemorySessionDistillationResult,
  sources: SessionDistillationSource[],
): AcceptedSessionDistillation {
  const mentions = new Map<string, MemoryInstanceMention>();
  for (const raw of Array.isArray(result?.mentions) ? result.mentions : []) {
    const mention = normalizeMention(raw, sources);
    if (mention) mentions.set(mention.mentionId, mention);
  }
  return {
    narrative: normalizedNarrative(result),
    mentions: [...mentions.values()].sort((left, right) =>
      left.episodeKey.localeCompare(right.episodeKey) ||
      left.turnOrdinal - right.turnOrdinal ||
      left.sourceEvidenceId.localeCompare(right.sourceEvidenceId) ||
      left.mentionId.localeCompare(right.mentionId)
    ),
  };
}
