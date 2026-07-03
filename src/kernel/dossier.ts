import { classifySensitivity, isPersonRoutedMemory } from "./safety.js";
import type {
  MemoryDossierCandidate,
  MemoryDossierConfig,
  MemoryDossierEntitySnapshot,
  MemoryDossierBeliefSnapshot,
  MemoryKind,
  MemoryRecord,
  ResolvedMemoryDossierConfig,
  WorldBeliefRecord,
} from "./types.js";

const DEFAULT_MIN_BELIEFS = 1;
const DEFAULT_MIN_LINKED_MEMORIES = 2;
const DEFAULT_MAX_ENTITIES_PER_RUN = 8;
const DEFAULT_MAX_BELIEFS_PER_ENTITY = 8;
const DEFAULT_MAX_MEMORIES_PER_ENTITY = 8;
export const MAX_DOSSIER_CONTENT_LENGTH = 2000;

export interface DossierCandidateDecision {
  candidate: MemoryDossierCandidate;
  normalized: {
    content: string;
    confidence: number;
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const integer = Math.trunc(value);
  return integer > 0 ? integer : fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function compact(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function normalizeOptionalField(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = compact(value);
  return normalized.length > 0 ? normalized : undefined;
}

function dossierKindForSubject(subject: string): MemoryKind {
  if (/^person\s*[:/]/iu.test(subject)) return "person";
  if (/^project\s*[:/]/iu.test(subject)) return "project";
  return "fact";
}

function beliefCanEnterDossier(belief: WorldBeliefRecord): boolean {
  if (belief.status !== "active") return false;
  return classifySensitivity(
    `${belief.subject} ${belief.predicate} ${belief.object}`,
  ) === "normal";
}

function memoryCanEnterDossier(memory: MemoryRecord, dossierKind: MemoryKind): boolean {
  if (memory.status === "archived") return false;
  if (memory.sensitivity !== "normal") return false;
  if (classifySensitivity(memory.content) !== "normal") return false;
  if (dossierKind !== "person" && isPersonRoutedMemory(memory.content)) return false;
  return true;
}

function beliefOrder(left: WorldBeliefRecord, right: WorldBeliefRecord): number {
  const subject = left.subject.localeCompare(right.subject);
  if (subject !== 0) return subject;
  const predicate = left.predicate.localeCompare(right.predicate);
  if (predicate !== 0) return predicate;
  const updated = right.updatedAt.localeCompare(left.updatedAt);
  if (updated !== 0) return updated;
  return left.id.localeCompare(right.id);
}

function memoryOrder(left: MemoryRecord, right: MemoryRecord): number {
  const created = left.createdAt.localeCompare(right.createdAt);
  if (created !== 0) return created;
  return left.id.localeCompare(right.id);
}

function sourceMemoryIdsForBeliefs(beliefs: WorldBeliefRecord[]): string[] {
  return uniqueSorted(
    beliefs.flatMap((belief) =>
      typeof belief.sourceMemoryId === "string" && belief.sourceMemoryId.trim().length > 0
        ? [belief.sourceMemoryId]
        : []
    ),
  );
}

function aliasesForEntity(entityKey: string, beliefs: WorldBeliefRecord[], memories: MemoryRecord[]): string[] {
  return uniqueSorted([
    entityKey,
    ...beliefs.flatMap((belief) => {
      const aliases = belief.metadata.aliases;
      return Array.isArray(aliases)
        ? aliases.filter((entry): entry is string => typeof entry === "string")
        : [];
    }),
    ...memories.flatMap((memory) => {
      const aliases = memory.metadata.subjectAliases;
      return Array.isArray(aliases)
        ? aliases.filter((entry): entry is string => typeof entry === "string")
        : [];
    }),
  ]).slice(0, 12);
}

function beliefSnapshot(belief: WorldBeliefRecord): MemoryDossierBeliefSnapshot {
  return {
    id: belief.id,
    subject: belief.subject,
    predicate: belief.predicate,
    object: belief.object,
    confidence: belief.confidence,
    ...(belief.sourceMemoryId ? { sourceMemoryId: belief.sourceMemoryId } : {}),
    createdAt: belief.createdAt,
    updatedAt: belief.updatedAt,
  };
}

export function resolveMemoryDossierConfig(
  input: MemoryDossierConfig | undefined,
): ResolvedMemoryDossierConfig {
  return {
    enabled: input?.enabled ?? true,
    minBeliefs: positiveInteger(input?.minBeliefs, DEFAULT_MIN_BELIEFS),
    minLinkedMemories: positiveInteger(input?.minLinkedMemories, DEFAULT_MIN_LINKED_MEMORIES),
    maxEntitiesPerRun: positiveInteger(input?.maxEntitiesPerRun, DEFAULT_MAX_ENTITIES_PER_RUN),
    maxBeliefsPerEntity: positiveInteger(
      input?.maxBeliefsPerEntity,
      DEFAULT_MAX_BELIEFS_PER_ENTITY,
    ),
    maxMemoriesPerEntity: positiveInteger(
      input?.maxMemoriesPerEntity,
      DEFAULT_MAX_MEMORIES_PER_ENTITY,
    ),
  };
}

export function selectEntityDossierSnapshots(input: {
  beliefs: WorldBeliefRecord[];
  memories: MemoryRecord[];
  config: ResolvedMemoryDossierConfig;
}): MemoryDossierEntitySnapshot[] {
  if (!input.config.enabled) return [];
  const memoryById = new Map(input.memories.map((memory) => [memory.id, memory]));
  const beliefsBySubject = new Map<string, WorldBeliefRecord[]>();
  for (const belief of input.beliefs.filter(beliefCanEnterDossier).sort(beliefOrder)) {
    const entries = beliefsBySubject.get(belief.subject) ?? [];
    entries.push(belief);
    beliefsBySubject.set(belief.subject, entries);
  }
  const snapshots: MemoryDossierEntitySnapshot[] = [];
  for (const [entityKey, rawBeliefs] of [...beliefsBySubject.entries()].sort((left, right) =>
    left[0].localeCompare(right[0])
  )) {
    const entityKind = dossierKindForSubject(entityKey);
    const beliefs = rawBeliefs.slice(0, input.config.maxBeliefsPerEntity);
    if (beliefs.length < input.config.minBeliefs) continue;
    const sourceMemoryIds = sourceMemoryIdsForBeliefs(beliefs);
    const linkedMemories = sourceMemoryIds
      .flatMap((memoryId) => {
        const memory = memoryById.get(memoryId);
        return memory && memoryCanEnterDossier(memory, entityKind) ? [memory] : [];
      })
      .sort(memoryOrder)
      .slice(0, input.config.maxMemoriesPerEntity);
    if (linkedMemories.length < input.config.minLinkedMemories) continue;
    snapshots.push({
      entityKey,
      entityKind,
      aliases: aliasesForEntity(entityKey, beliefs, linkedMemories),
      beliefs: beliefs.map(beliefSnapshot),
      memories: linkedMemories.map((memory) => ({
        id: memory.id,
        kind: memory.kind,
        content: memory.content,
        confidence: memory.confidence,
        createdAt: memory.createdAt,
        updatedAt: memory.updatedAt,
      })),
    });
    if (snapshots.length >= input.config.maxEntitiesPerRun) break;
  }
  return snapshots;
}

export function normalizeDossierCandidate(
  candidate: MemoryDossierCandidate,
  snapshot: MemoryDossierEntitySnapshot,
): DossierCandidateDecision | { reason: string } {
  const content = normalizeOptionalField(candidate.content);
  if (!content) return { reason: "empty_content" };
  if (content.length > MAX_DOSSIER_CONTENT_LENGTH) return { reason: "content_too_long" };
  if (classifySensitivity(content) === "secret_like") return { reason: "secret_like" };
  if (snapshot.entityKind !== "person" && isPersonRoutedMemory(content)) {
    return { reason: "person_routed" };
  }
  return {
    candidate,
    normalized: {
      content,
      confidence: clamp(candidate.confidence ?? 0.7, 0, 1),
    },
  };
}

export function dossierInputKey(input: {
  snapshot: MemoryDossierEntitySnapshot;
  content: string;
}): string {
  return [
    input.snapshot.entityKey,
    input.snapshot.entityKind,
    input.snapshot.beliefs.map((belief) => belief.id).join(","),
    input.snapshot.memories.map((memory) => memory.id).join(","),
    input.content,
  ].join("\n");
}
