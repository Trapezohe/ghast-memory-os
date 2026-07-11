import { associationCueKey, extractAssociationCues } from "./associations.js";
import {
  GMOS_METADATA_REFERENCE_SCHEMAS,
  hasGmosMetadataReferenceSchema,
} from "./metadata-schema.js";
import { queryTerms } from "./query-terms.js";
import {
  canonicalReaderConversationSource,
  classifySensitivity,
  sanitizeEvidenceForPublicOutput,
} from "./safety.js";
import type { EvidenceEvent, MemoryRecord, MemoryStore } from "./types.js";

const MAX_READER_EVIDENCE_COMPANIONS = 8;
interface ReaderConversationSourceProjection {
  evidenceId: string;
  profileId: string;
  role: "user" | "assistant";
  sourceTrust: "user" | "agent";
}

const readerConversationSources = new WeakMap<
  EvidenceEvent,
  ReaderConversationSourceProjection
>();
const readerMemorySources = new WeakMap<MemoryRecord, ReaderConversationSourceProjection>();

function canonicalReaderSourceProjection(
  event: EvidenceEvent,
): ReaderConversationSourceProjection | null {
  const source = canonicalReaderConversationSource(event);
  return source
    ? { ...source, evidenceId: event.id, profileId: event.profileId }
    : null;
}

function readerSourceKey(source: ReaderConversationSourceProjection): string {
  return `${source.profileId}\u0000${source.evidenceId}`;
}

function readerMemorySource(memory: MemoryRecord): ReaderConversationSourceProjection | undefined {
  const source = readerMemorySources.get(memory);
  if (
    !source || source.evidenceId !== memory.sourceEventId || source.profileId !== memory.profileId
  ) {
    return undefined;
  }
  return source;
}

export function bindReaderMemorySources(
  memories: MemoryRecord[],
  events: EvidenceEvent[],
): void {
  const sources = new Map<string, ReaderConversationSourceProjection>();
  for (const event of events) {
    const source = readerConversationSources.get(event) ?? canonicalReaderSourceProjection(event);
    if (source) sources.set(readerSourceKey(source), source);
  }
  for (const memory of memories) {
    readerMemorySources.delete(memory);
    if (!memory.sourceEventId) continue;
    if (!exactPrimaryEvidenceIds(memory).includes(memory.sourceEventId)) continue;
    const source = sources.get(`${memory.profileId}\u0000${memory.sourceEventId}`);
    if (source) readerMemorySources.set(memory, source);
  }
}

export function carryReaderMemorySource(
  sourceMemory: MemoryRecord,
  outputMemory: MemoryRecord,
): MemoryRecord {
  const source = readerMemorySource(sourceMemory);
  readerMemorySources.delete(outputMemory);
  if (source) readerMemorySources.set(outputMemory, source);
  return outputMemory;
}

export function readerMemoryHasUserAuthority(memory: MemoryRecord): boolean {
  const source = readerMemorySource(memory);
  return source?.role === "user" && source.sourceTrust === "user";
}

export function sanitizeReaderEvidenceForPublicOutput(
  event: EvidenceEvent,
  sanitizer: (event: EvidenceEvent) => EvidenceEvent = sanitizeEvidenceForPublicOutput,
): EvidenceEvent {
  const source = readerConversationSources.get(event) ?? canonicalReaderSourceProjection(event);
  const sanitized = sanitizer(event);
  readerConversationSources.delete(sanitized);
  if (source) readerConversationSources.set(sanitized, source);
  return sanitized;
}

export function carryReaderEvidenceSource(
  sourceEvent: EvidenceEvent,
  outputEvent: EvidenceEvent,
): EvidenceEvent {
  const source = readerConversationSources.get(sourceEvent);
  readerConversationSources.delete(outputEvent);
  if (source) readerConversationSources.set(outputEvent, source);
  return outputEvent;
}

function readerSurfaceJsonContent(content: string): string {
  // A single-line JSON string preserves the trust boundary without charging
  // two or six visible characters for every line separator in long memories.
  // This matters because context budgets are enforced on the rendered surface.
  return JSON.stringify(content.replace(/(?:\r\n?|\n|\u0085|\u2028|\u2029)+/gu, " "));
}

/**
 * Render one reader-sanitized event without allowing payload metadata or
 * multiline content to impersonate an authoritative conversation source.
 */
export type ReaderSourceBindings = ReadonlyMap<string, string>;

export function createReaderSourceBindings(memories: MemoryRecord[]): ReaderSourceBindings {
  const bindings = new Map<string, string>();
  for (const memory of memories) {
    const source = readerMemorySource(memory);
    const sourceKey = source ? readerSourceKey(source) : "";
    if (source && !bindings.has(sourceKey)) {
      bindings.set(sourceKey, `source-${bindings.size + 1}`);
    }
  }
  return bindings;
}

function readerAuthoritySurface(input: {
  source: ReaderConversationSourceProjection | undefined;
  content: string;
  bindings?: ReaderSourceBindings | undefined;
  unboundReference: "unbound" | "unverified";
}): string {
  const role = input.source?.role ?? "unverified";
  const trust = input.source?.sourceTrust ?? "unverified";
  const reference = input.bindings
    ? input.source
      ? input.bindings.get(readerSourceKey(input.source)) ?? input.unboundReference
      : "unverified"
    : undefined;
  return `[${reference ? `source_ref=${reference}; ` : ""}source_role=${role}; source_trust=${trust}] content=${readerSurfaceJsonContent(input.content)}`;
}

export function readerMemorySurfaceText(
  memory: MemoryRecord,
  options: {
    bindings?: ReaderSourceBindings | undefined;
    content?: string | undefined;
  } = {},
): string {
  return readerAuthoritySurface({
    source: readerMemorySource(memory),
    content: options.content ?? memory.content,
    bindings: options.bindings,
    unboundReference: "unverified",
  });
}

export function readerEvidenceSurfaceText(
  event: EvidenceEvent,
  bindings?: ReaderSourceBindings | undefined,
  content = event.content,
): string {
  const source = readerConversationSources.get(event);
  return readerAuthoritySurface({
    source,
    content,
    bindings,
    unboundReference: "unbound",
  });
}

export function readerUnverifiedSurfaceText(content: string): string {
  return readerAuthoritySurface({
    source: undefined,
    content,
    unboundReference: "unverified",
  });
}

function stringIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function explicitPrimaryIds(memory: MemoryRecord): string[] {
  if (
    !hasGmosMetadataReferenceSchema(
      memory.metadata,
      GMOS_METADATA_REFERENCE_SCHEMAS.runtimeLineage,
    )
  ) {
    return [];
  }
  const ids = [
    memory.metadata.sourceEvidenceId,
    memory.metadata.turnEvidenceId,
    memory.metadata.sessionDistillationEvidenceId,
  ].filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  const windowEvidenceIds = stringIds(memory.metadata.windowEvidenceIds);
  const sourceIndex = memory.metadata.sourceIndex;
  if (
    typeof sourceIndex === "number" &&
    Number.isInteger(sourceIndex) &&
    sourceIndex >= 0 &&
    sourceIndex < windowEvidenceIds.length
  ) {
    ids.push(windowEvidenceIds[sourceIndex]!);
  }
  return ids;
}

function lineageIds(memory: MemoryRecord): Set<string> {
  if (
    !hasGmosMetadataReferenceSchema(
      memory.metadata,
      GMOS_METADATA_REFERENCE_SCHEMAS.runtimeLineage,
    )
  ) {
    return new Set();
  }
  return new Set([
    ...stringIds(memory.metadata.windowEvidenceIds),
    ...stringIds(memory.metadata.sessionEvidenceIds),
  ]);
}

function safeSourceEventId(memory: MemoryRecord): string | null {
  if (!memory.sourceEventId) return null;
  const lineage = lineageIds(memory);
  return lineage.size > 1 && lineage.has(memory.sourceEventId)
    ? null
    : memory.sourceEventId;
}

export function exactPrimaryEvidenceIds(memory: MemoryRecord): string[] {
  const explicit = [...new Set(explicitPrimaryIds(memory))];
  if (explicit.length > 0) return explicit;
  const sourceEventId = safeSourceEventId(memory);
  return sourceEventId ? [sourceEventId] : [];
}

export function exactPrimaryEvidenceId(memory: MemoryRecord): string | undefined {
  return exactPrimaryEvidenceIds(memory)[0];
}

function readerTermSignals(text: string): Set<string> {
  return new Set(queryTerms(text, 64).map(associationCueKey).filter(Boolean));
}

function readerEntitySignals(text: string): Set<string> {
  return new Set(
    extractAssociationCues(text, 64)
      .filter((cue) => cue.cueKind === "entity" || /\p{Script=Han}/u.test(cue.cue))
      .map((cue) => associationCueKey(cue.cue))
      .filter(Boolean),
  );
}

function readerNumericSignals(text: string): Set<string> {
  return new Set(
    (text.normalize("NFC").match(/(?:[$€£¥]\s*)?\d+(?:[.,]\d+)*(?:%|\b)/gu) ?? [])
      .map((value) => value.toLowerCase().replace(/[\s,]/gu, "")),
  );
}

interface CompanionCandidate {
  event: EvidenceEvent;
  score: number;
  memoryScore: number;
  queryScore: number;
  trustMatch: boolean;
  memoryRank: number;
  windowRank: number;
}

function sensitivityRank(value: unknown): number {
  if (value === "normal") return 0;
  if (value === "sensitive") return 1;
  return 2;
}

function eventSourceTrust(event: EvidenceEvent): unknown {
  if (typeof event.payload.sourceTrust === "string") return event.payload.sourceTrust;
  const sourceMetadata = event.payload.sourceMetadata;
  return sourceMetadata && typeof sourceMetadata === "object" && !Array.isArray(sourceMetadata)
    ? (sourceMetadata as Record<string, unknown>).sourceTrust
    : undefined;
}

function safeReaderEvidenceEvent(event: EvidenceEvent, memory: MemoryRecord): boolean {
  if (!event.eligibleForLongTermMemory || event.payload.privacyMode === "incognito") return false;
  const eventSensitivity = Math.max(
    sensitivityRank(event.sensitivity),
    sensitivityRank(classifySensitivity(event.content)),
  );
  return eventSensitivity < 2 && eventSensitivity <= sensitivityRank(memory.sensitivity);
}

function matchedValues(left: Set<string>, right: Set<string>): Set<string> {
  const matched = new Set<string>();
  for (const value of left) {
    if (right.has(value)) matched.add(value);
  }
  return matched;
}

function companionCandidateForMemory(input: {
  memory: MemoryRecord;
  events: EvidenceEvent[];
  query: string;
  primaryIds: Set<string>;
  memoryRank: number;
}): CompanionCandidate | undefined {
  if (
    !hasGmosMetadataReferenceSchema(
      input.memory.metadata,
      GMOS_METADATA_REFERENCE_SCHEMAS.runtimeLineage,
    )
  ) {
    return undefined;
  }
  const windowEvidenceIds = [...new Set(stringIds(input.memory.metadata.windowEvidenceIds))];
  if (windowEvidenceIds.length <= 1) return undefined;
  const eventsById = new Map(input.events.map((event) => [event.id, event]));

  const memoryTerms = readerTermSignals(input.memory.content);
  const querySignals = readerTermSignals(input.query);
  const memoryEntities = readerEntitySignals(input.memory.content);
  const queryEntities = readerEntitySignals(input.query);
  const memoryNumbers = readerNumericSignals(input.memory.content);
  const queryNumbers = readerNumericSignals(input.query);
  let best: CompanionCandidate | undefined;

  for (const [windowRank, eventId] of windowEvidenceIds.entries()) {
    const event = eventsById.get(eventId);
    if (!event || input.primaryIds.has(event.id) || !safeReaderEvidenceEvent(event, input.memory)) continue;
    const eventTerms = readerTermSignals(event.content);
    const eventEntities = readerEntitySignals(event.content);
    const eventNumbers = readerNumericSignals(event.content);
    const memoryTermHits = matchedValues(eventTerms, memoryTerms);
    const memoryEntityHits = matchedValues(eventEntities, memoryEntities);
    const memoryNumericHits = matchedValues(eventNumbers, memoryNumbers);
    const queryTermHits = matchedValues(eventTerms, querySignals);
    const queryEntityHits = matchedValues(eventEntities, queryEntities);
    const queryNumericHits = matchedValues(eventNumbers, queryNumbers);
    const memoryHits = new Set([
      ...memoryTermHits,
      ...memoryEntityHits,
      ...memoryNumericHits,
    ]);
    const queryHits = new Set([
      ...queryTermHits,
      ...queryEntityHits,
      ...queryNumericHits,
    ]);
    const unionHits = new Set([...memoryHits, ...queryHits]);
    const memoryScore = memoryNumericHits.size * 6 + memoryEntityHits.size * 3 +
      memoryTermHits.size * 2;
    const queryScore = queryNumericHits.size * 3 + queryEntityHits.size * 2 +
      Math.min(queryTermHits.size, 4);
    const score = memoryScore + queryScore;
    const qualifies = memoryNumericHits.size > 0 || memoryHits.size >= 2 ||
      (memoryHits.size > 0 && queryHits.size > 0 && unionHits.size >= 2);
    if (!qualifies || score < 4) continue;
    const sourceTrust = input.memory.metadata.sourceTrust;
    const candidate = {
      event,
      score,
      memoryScore,
      queryScore,
      trustMatch: typeof sourceTrust === "string" && eventSourceTrust(event) === sourceTrust,
      memoryRank: input.memoryRank,
      windowRank,
    };
    if (
      !best ||
      candidate.score > best.score ||
      (candidate.score === best.score && candidate.memoryScore > best.memoryScore) ||
      (
        candidate.score === best.score &&
        candidate.memoryScore === best.memoryScore &&
        candidate.trustMatch &&
        !best.trustMatch
      ) ||
      (
        candidate.score === best.score &&
        candidate.memoryScore === best.memoryScore &&
        candidate.trustMatch === best.trustMatch &&
        candidate.queryScore > best.queryScore
      ) ||
      (
        candidate.score === best.score &&
        candidate.memoryScore === best.memoryScore &&
        candidate.trustMatch === best.trustMatch &&
        candidate.queryScore === best.queryScore &&
        candidate.windowRank < best.windowRank
      )
    ) {
      best = candidate;
    }
  }
  return best;
}

function projectMemoryEvidenceForReader(input: {
  memory: MemoryRecord;
  events: EvidenceEvent[];
  query?: string | undefined;
  memoryRank?: number | undefined;
}): { primaries: EvidenceEvent[]; companion?: CompanionCandidate | undefined } {
  const byId = new Map(input.events.map((event) => [event.id, event]));
  const primaries: EvidenceEvent[] = [];
  const primaryIds = new Set<string>();
  const appendPrimary = (id: string | null | undefined): void => {
    if (!id || primaryIds.has(id)) return;
    const event = byId.get(id);
    if (!event || !safeReaderEvidenceEvent(event, input.memory)) return;
    primaryIds.add(id);
    primaries.push(event);
  };
  for (const id of exactPrimaryEvidenceIds(input.memory)) appendPrimary(id);
  if (primaries.length === 0) appendPrimary(safeSourceEventId(input.memory));
  const companion = companionCandidateForMemory({
    memory: input.memory,
    events: input.events,
    query: input.query ?? "",
    primaryIds,
    memoryRank: input.memoryRank ?? 0,
  });
  return { primaries, ...(companion ? { companion } : {}) };
}

/**
 * Project store lineage into bounded agent reader evidence. Exact primary
 * sources for every ranked memory are emitted first, followed by at most one
 * relevant window companion per memory and eight companions globally. Full
 * lineage remains available through explain, audit, forget, and backup APIs.
 */
export async function collectReaderEvidenceForMemories(input: {
  store: MemoryStore;
  memories: MemoryRecord[];
  query: string;
  maxCompanions?: number | undefined;
}): Promise<EvidenceEvent[]> {
  const sourceBatches = await Promise.all(
    input.memories.map(async (memory) => ({
      memory,
      events: await input.store.listEvidenceForMemory(memory.id),
    })),
  );
  for (const { memory, events } of sourceBatches) bindReaderMemorySources([memory], events);
  const evidence: EvidenceEvent[] = [];
  const seen = new Set<string>();
  const append = (event: EvidenceEvent): void => {
    if (seen.has(event.id)) return;
    seen.add(event.id);
    evidence.push(event);
  };
  const primaryBatches = sourceBatches.map(({ memory, events }) =>
    projectMemoryEvidenceForReader({ memory, events, query: input.query }).primaries
  );
  for (const primaries of primaryBatches) {
    for (const event of primaries) append(event);
  }
  const primaryIds = new Set(seen);
  const maxCompanions = Math.max(
    0,
    Math.min(Math.trunc(input.maxCompanions ?? MAX_READER_EVIDENCE_COMPANIONS), 32),
  );
  const companions = sourceBatches
    .flatMap(({ memory, events }, memoryRank) => {
      const companion = companionCandidateForMemory({
        memory,
        events,
        query: input.query,
        primaryIds,
        memoryRank,
      });
      return companion ? [companion] : [];
    })
    .sort((left, right) =>
      right.score - left.score ||
      right.memoryScore - left.memoryScore ||
      Number(right.trustMatch) - Number(left.trustMatch) ||
      right.queryScore - left.queryScore ||
      left.memoryRank - right.memoryRank ||
      left.windowRank - right.windowRank ||
      left.event.id.localeCompare(right.event.id)
    );
  let includedCompanions = 0;
  for (const companion of companions) {
    if (includedCompanions >= maxCompanions) break;
    if (seen.has(companion.event.id)) continue;
    append(companion.event);
    includedCompanions += 1;
  }
  return evidence;
}

/**
 * Resolve source authority for memory-only reader surfaces without exposing the
 * linked evidence lane. Metadata is never used as an authority source.
 */
export async function establishReaderMemoryAuthority(input: {
  store: MemoryStore;
  memories: MemoryRecord[];
}): Promise<void> {
  await Promise.all(
    input.memories.map(async (memory) => {
      const events = memory.sourceEventId
        ? await input.store.listEvidenceForMemory(memory.id)
        : [];
      bindReaderMemorySources([memory], events);
    }),
  );
}
