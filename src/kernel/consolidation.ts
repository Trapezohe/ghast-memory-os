import {
  associationCueKey,
  associationCuesForMemory,
  associationTagsForMemory,
} from "./associations.js";
import { classifySensitivity, isPersonRoutedMemory } from "./safety.js";
import type {
  MemoryConsolidationCandidate,
  MemoryConsolidationCluster,
  MemoryConsolidationConfig,
  MemoryConsolidationSourceSnapshot,
  MemoryKind,
  MemoryRecord,
  ResolvedMemoryConsolidationConfig,
} from "./types.js";

export const DEFAULT_CONSOLIDATION_ELIGIBLE_KINDS: MemoryKind[] = [
  "task_trajectory",
  "fact",
  "project",
];

const CONSOLIDATION_EXCLUDED_KINDS = new Set<MemoryKind>(["boundary", "person"]);
const KNOWN_MEMORY_KINDS = new Set<MemoryKind>([
  "fact",
  "preference",
  "boundary",
  "procedure",
  "project",
  "person",
  "task_trajectory",
]);

const DEFAULT_TAG_OVERLAP_THRESHOLD = 0.6;
const DEFAULT_DUPLICATE_MIN_CLUSTER_SIZE = 2;
const DEFAULT_HOOK_MIN_CLUSTER_SIZE = 3;
const DEFAULT_MAX_CLUSTERS_PER_RUN = 10;
const DEFAULT_MAX_MEMBERS_PER_CLUSTER = 8;
const DEFAULT_ENTITY_MIN_CLUSTER_SIZE = 2;
const DEFAULT_ENTITY_MAX_CLUSTERS_PER_RUN = 100;
const DEFAULT_ENTITY_MAX_MEMBERS_PER_CLUSTER = 40;
const ENTITY_TOKEN_MIN_DF = 2;
const ENTITY_TOKEN_MAX_DF_FRACTION = 0.15;
export const MAX_CONSOLIDATION_SUMMARY_CONTENT_LENGTH = 2000;

export interface DuplicateConsolidationCluster {
  kind: MemoryKind;
  survivor: MemoryRecord;
  members: MemoryRecord[];
  archivedMembers: MemoryRecord[];
  reasons: string[];
}

export interface ConsolidationCandidateDecision {
  candidate: MemoryConsolidationCandidate;
  normalized: {
    kind: MemoryKind;
    content: string;
    confidence: number;
    subject?: string | undefined;
    predicate?: string | undefined;
    object?: string | undefined;
  };
}

interface EntityTokenCandidate {
  token: string;
  isCode: boolean;
}

interface EntityTokenSignal {
  memory: MemoryRecord;
  entityKey: string;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const integer = Math.trunc(value);
  return integer > 0 ? integer : fallback;
}

function configuredKinds(
  value: MemoryKind[] | undefined,
  fallback: MemoryKind[],
): MemoryKind[] {
  const kinds = value?.length ? value : fallback;
  return [...new Set(kinds)].filter(
    (kind) => KNOWN_MEMORY_KINDS.has(kind) && !CONSOLIDATION_EXCLUDED_KINDS.has(kind),
  );
}

export function resolveMemoryConsolidationConfig(
  input: MemoryConsolidationConfig | undefined,
): ResolvedMemoryConsolidationConfig {
  return {
    enabled: input?.enabled ?? true,
    tagOverlapThreshold: clamp(
      input?.tagOverlapThreshold ?? DEFAULT_TAG_OVERLAP_THRESHOLD,
      0,
      1,
    ),
    duplicateMinClusterSize: positiveInteger(
      input?.duplicateMinClusterSize,
      DEFAULT_DUPLICATE_MIN_CLUSTER_SIZE,
    ),
    hookMinClusterSize: positiveInteger(input?.hookMinClusterSize, DEFAULT_HOOK_MIN_CLUSTER_SIZE),
    maxClustersPerRun: positiveInteger(input?.maxClustersPerRun, DEFAULT_MAX_CLUSTERS_PER_RUN),
    maxMembersPerCluster: positiveInteger(
      input?.maxMembersPerCluster,
      DEFAULT_MAX_MEMBERS_PER_CLUSTER,
    ),
    eligibleKinds: configuredKinds(input?.eligibleKinds, DEFAULT_CONSOLIDATION_ELIGIBLE_KINDS),
    entityConsolidation: {
      enabled: input?.entityConsolidation?.enabled ?? false,
      minClusterSize: positiveInteger(
        input?.entityConsolidation?.minClusterSize,
        DEFAULT_ENTITY_MIN_CLUSTER_SIZE,
      ),
      maxClustersPerRun: positiveInteger(
        input?.entityConsolidation?.maxClustersPerRun,
        DEFAULT_ENTITY_MAX_CLUSTERS_PER_RUN,
      ),
      maxMembersPerCluster: positiveInteger(
        input?.entityConsolidation?.maxMembersPerCluster,
        DEFAULT_ENTITY_MAX_MEMBERS_PER_CLUSTER,
      ),
    },
  };
}

export function normalizedConsolidationContent(content: string): string {
  return content
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function stableMemoryOrder(left: MemoryRecord, right: MemoryRecord): number {
  const kind = left.kind.localeCompare(right.kind);
  if (kind !== 0) return kind;
  const content = normalizedConsolidationContent(left.content).localeCompare(
    normalizedConsolidationContent(right.content),
  );
  if (content !== 0) return content;
  const updated = left.updatedAt.localeCompare(right.updatedAt);
  if (updated !== 0) return updated;
  return left.id.localeCompare(right.id);
}

function canonicalMemoryOrder(left: MemoryRecord, right: MemoryRecord): number {
  const confidence = right.confidence - left.confidence;
  if (confidence !== 0) return confidence;
  const updated = right.updatedAt.localeCompare(left.updatedAt);
  if (updated !== 0) return updated;
  return left.id.localeCompare(right.id);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function metadataHasConsolidationResidue(memory: MemoryRecord): boolean {
  return Boolean(memory.metadata.consolidationSummary || memory.metadata.consolidatedInto);
}

export function memoryCanEnterConsolidation(memory: MemoryRecord): boolean {
  if (memory.status === "archived") return false;
  if (CONSOLIDATION_EXCLUDED_KINDS.has(memory.kind)) return false;
  if (memory.sensitivity !== "normal") return false;
  if (classifySensitivity(memory.content) !== "normal") return false;
  if (isPersonRoutedMemory(memory.content)) return false;
  return true;
}

function consolidationTags(memory: MemoryRecord): string[] {
  return uniqueSorted([
    ...associationTagsForMemory(memory),
    ...associationCuesForMemory(memory)
      .map((cue) => associationCueKey(cue.cue))
      .filter((cue) => cue.length >= 3),
  ]);
}

function overlapScore(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const denominator = Math.min(leftSet.size, rightSet.size);
  if (denominator === 0) return 0;
  let intersection = 0;
  for (const tag of leftSet) {
    if (rightSet.has(tag)) intersection += 1;
  }
  return intersection / denominator;
}

function nearDuplicateContent(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  return shorter.length >= 12 && longer.includes(shorter);
}

function sharedTagsForMembers(members: MemoryRecord[]): string[] {
  if (members.length === 0) return [];
  const [first, ...rest] = members.map(consolidationTags);
  let shared = new Set(first);
  for (const tags of rest) {
    const tagSet = new Set(tags);
    shared = new Set([...shared].filter((tag) => tagSet.has(tag)));
  }
  return uniqueSorted([...shared]).slice(0, 16);
}

function memberSnapshots(members: MemoryRecord[]): MemoryConsolidationSourceSnapshot[] {
  return members.map((memory) => ({
    id: memory.id,
    kind: memory.kind,
    content: memory.content,
    confidence: memory.confidence,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  }));
}

const ENTITY_TOKEN_STOPWORDS = new Set([
  "a",
  "about",
  "after",
  "all",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "before",
  "but",
  "by",
  "can",
  "could",
  "do",
  "does",
  "fact",
  "for",
  "from",
  "had",
  "has",
  "have",
  "in",
  "into",
  "is",
  "it",
  "its",
  "kit",
  "kits",
  "model",
  "models",
  "mentions",
  "note",
  "of",
  "on",
  "or",
  "scale",
  "some",
  "that",
  "the",
  "this",
  "to",
  "user",
  "was",
  "were",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

function losslessCoverageSignature(value: string): string {
  return value
    .normalize("NFC")
    .toLowerCase()
    .replace(/\p{White_Space}+/gu, " ")
    .trim();
}

export function consolidationCandidateCoveredSourceIds(input: {
  candidate: ConsolidationCandidateDecision["normalized"];
  sources: MemoryRecord[];
}): string[] {
  const candidateSignature = losslessCoverageSignature(input.candidate.content);
  const sourceSignatures = input.sources.map((source) => losslessCoverageSignature(source.content));
  if (sourceSignatures.some((signature) => signature.length === 0)) return [];
  if (candidateSignature !== sourceSignatures.join(" ")) return [];
  return input.sources.map((source) => source.id);
}

function uniqueEntityTokenCandidates(candidates: EntityTokenCandidate[]): EntityTokenCandidate[] {
  const byToken = new Map<string, EntityTokenCandidate>();
  for (const candidate of candidates) {
    const existing = byToken.get(candidate.token);
    byToken.set(candidate.token, {
      token: candidate.token,
      isCode: candidate.isCode || existing?.isCode === true,
    });
  }
  return [...byToken.values()].sort((left, right) => left.token.localeCompare(right.token));
}

function entityTokenCandidates(content: string): EntityTokenCandidate[] {
  const candidates: EntityTokenCandidate[] = [];
  for (const match of content.matchAll(/\b[A-Za-z]{1,5}-\d{1,4}\b/gu)) {
    candidates.push({ token: match[0]!.toLowerCase(), isCode: true });
  }
  for (const match of content.matchAll(/\b\d\/\d{2,3}\b/gu)) {
    candidates.push({ token: match[0]!.toLowerCase(), isCode: true });
  }
  for (const match of content.matchAll(/\b[A-Z][a-z]{2,}\b/gu)) {
    candidates.push({ token: match[0]!.toLowerCase(), isCode: false });
  }
  return uniqueEntityTokenCandidates(candidates);
}

function entityTokenDocumentFrequency(memories: MemoryRecord[]): Map<string, EntityTokenCandidate & { df: number }> {
  const frequencies = new Map<string, EntityTokenCandidate & { df: number }>();
  for (const memory of memories) {
    for (const candidate of entityTokenCandidates(memory.content)) {
      const existing = frequencies.get(candidate.token);
      frequencies.set(candidate.token, {
        token: candidate.token,
        isCode: candidate.isCode || existing?.isCode === true,
        df: (existing?.df ?? 0) + 1,
      });
    }
  }
  return frequencies;
}

function primaryEntityToken(
  memory: MemoryRecord,
  frequencies: Map<string, EntityTokenCandidate & { df: number }>,
  maxDf: number,
): string | null {
  const distinctiveTokens = entityTokenCandidates(memory.content)
    .map((candidate) => frequencies.get(candidate.token))
    .filter((candidate): candidate is EntityTokenCandidate & { df: number } =>
      candidate !== undefined &&
      candidate.df >= ENTITY_TOKEN_MIN_DF &&
      candidate.df <= maxDf &&
      !ENTITY_TOKEN_STOPWORDS.has(candidate.token)
    )
    .sort((left, right) =>
      left.df - right.df ||
      Number(right.isCode) - Number(left.isCode) ||
      left.token.localeCompare(right.token)
    );
  return distinctiveTokens[0]?.token ?? null;
}

function contentSnippet(content: string): string {
  const snippet = content.replace(/\s+/gu, " ").trim();
  return snippet.length <= 160 ? snippet : `${snippet.slice(0, 157).trimEnd()}...`;
}

function normalizedMetadataObject(memory: MemoryRecord): string {
  return typeof memory.metadata.object === "string"
    ? memory.metadata.object.replace(/\s+/gu, " ").trim()
    : "";
}

function phraseContainsEntityToken(phrase: string, entityKey: string): boolean {
  const escaped = entityKey.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "u").test(phrase.toLowerCase());
}

function bestEntityObject(members: MemoryRecord[], entityKey: string): string {
  const objects = members.map(normalizedMetadataObject).filter((value) => value.length > 0);
  const matchingObjects = objects.filter((candidate) => phraseContainsEntityToken(candidate, entityKey));
  if (matchingObjects.length > 0) {
    return matchingObjects.sort((left, right) => right.length - left.length || left.localeCompare(right))[0]!;
  }
  const snippets = members.map((memory) => contentSnippet(memory.content)).filter((value) => value.length > 0);
  const matchingSnippets = snippets.filter((candidate) => phraseContainsEntityToken(candidate, entityKey));
  return (matchingSnippets.length > 0 ? matchingSnippets : [...objects, ...snippets])
    .sort((left, right) => right.length - left.length || left.localeCompare(right))[0] ?? entityKey;
}

export function selectDuplicateConsolidationClusters(
  memories: MemoryRecord[],
  config: ResolvedMemoryConsolidationConfig,
): DuplicateConsolidationCluster[] {
  if (!config.enabled) return [];
  const minClusterSize = Math.max(2, config.duplicateMinClusterSize);
  const candidates = memories
    .filter(memoryCanEnterConsolidation)
    .sort(stableMemoryOrder);
  const consumed = new Set<string>();
  const clusters: DuplicateConsolidationCluster[] = [];
  for (const anchor of candidates) {
    if (consumed.has(anchor.id)) continue;
    const anchorContent = normalizedConsolidationContent(anchor.content);
    const anchorTags = consolidationTags(anchor);
    const members = [anchor];
    for (const candidate of candidates) {
      if (candidate.id === anchor.id || consumed.has(candidate.id)) continue;
      if (candidate.kind !== anchor.kind) continue;
      const candidateContent = normalizedConsolidationContent(candidate.content);
      if (!nearDuplicateContent(anchorContent, candidateContent)) continue;
      const tags = consolidationTags(candidate);
      if (overlapScore(anchorTags, tags) < config.tagOverlapThreshold) continue;
      members.push(candidate);
      if (members.length >= config.maxMembersPerCluster) break;
    }
    if (members.length < minClusterSize) continue;
    const orderedMembers = [...members].sort(canonicalMemoryOrder);
    const survivor = orderedMembers[0]!;
    const archivedMembers = orderedMembers.slice(1);
    for (const member of orderedMembers) consumed.add(member.id);
    clusters.push({
      kind: anchor.kind,
      survivor,
      members: orderedMembers,
      archivedMembers,
      reasons: [
        "normalized_content_duplicate",
        `tag_overlap_threshold:${config.tagOverlapThreshold.toFixed(4)}`,
      ],
    });
    if (clusters.length >= config.maxClustersPerRun) break;
  }
  return clusters;
}

export function selectEntityConsolidationClusters(
  memories: MemoryRecord[],
  config: ResolvedMemoryConsolidationConfig,
): MemoryConsolidationCluster[] {
  if (!config.enabled || !config.entityConsolidation.enabled) return [];
  const minClusterSize = Math.max(2, config.entityConsolidation.minClusterSize);
  const activeMemories = memories.filter((memory) => memory.status === "active");
  const frequencies = entityTokenDocumentFrequency(activeMemories);
  const maxDf = Math.ceil(activeMemories.length * ENTITY_TOKEN_MAX_DF_FRACTION);
  const candidates = activeMemories
    .filter(memoryCanEnterConsolidation)
    .filter((memory) => !metadataHasConsolidationResidue(memory))
    .map((memory) => {
      const entityKey = primaryEntityToken(memory, frequencies, maxDf);
      return entityKey ? { memory, entityKey } : null;
    })
    .filter((signal): signal is EntityTokenSignal => signal !== null)
    .sort((left, right) => stableMemoryOrder(left.memory, right.memory));
  const groups = new Map<string, EntityTokenSignal[]>();
  for (const signal of candidates) {
    groups.set(signal.entityKey, [...(groups.get(signal.entityKey) ?? []), signal]);
  }
  return [...groups.values()]
    .map((group) => group.sort((left, right) => stableMemoryOrder(left.memory, right.memory)))
    .filter((group) => group.length >= minClusterSize)
    .sort((left, right) =>
      left[0]!.entityKey.localeCompare(right[0]!.entityKey) ||
      stableMemoryOrder(left[0]!.memory, right[0]!.memory)
    )
    .slice(0, config.entityConsolidation.maxClustersPerRun)
    .map((group) => {
      const members = group
        .slice(0, config.entityConsolidation.maxMembersPerCluster)
        .map((signal) => signal.memory);
      const entityKey = group[0]!.entityKey;
      return {
        kind: "entity",
        memoryKind: members[0]!.kind,
        entityKey,
        entityObject: bestEntityObject(members, entityKey),
        sharedTags: sharedTagsForMembers(members),
        memories: memberSnapshots(members),
      };
    });
}

export function selectSemanticConsolidationClusters(
  memories: MemoryRecord[],
  config: ResolvedMemoryConsolidationConfig,
): MemoryConsolidationCluster[] {
  if (!config.enabled) return [];
  const eligibleKinds = new Set(config.eligibleKinds);
  const minClusterSize = Math.max(2, config.hookMinClusterSize);
  const candidates = memories
    .filter((memory) => memoryCanEnterConsolidation(memory))
    .filter((memory) => eligibleKinds.has(memory.kind))
    .filter((memory) => !metadataHasConsolidationResidue(memory))
    .sort(stableMemoryOrder);
  const consumed = new Set<string>();
  const clusters: MemoryConsolidationCluster[] = [];
  for (const anchor of candidates) {
    if (consumed.has(anchor.id)) continue;
    const anchorTags = consolidationTags(anchor);
    const members = [anchor];
    for (const candidate of candidates) {
      if (candidate.id === anchor.id || consumed.has(candidate.id)) continue;
      if (candidate.kind !== anchor.kind) continue;
      const tags = consolidationTags(candidate);
      if (overlapScore(anchorTags, tags) < config.tagOverlapThreshold) continue;
      members.push(candidate);
      if (members.length >= config.maxMembersPerCluster) break;
    }
    if (members.length < minClusterSize) continue;
    const orderedMembers = members.sort(stableMemoryOrder);
    for (const member of orderedMembers) consumed.add(member.id);
    clusters.push({
      kind: anchor.kind,
      sharedTags: sharedTagsForMembers(orderedMembers),
      memories: memberSnapshots(orderedMembers),
    });
    if (clusters.length >= config.maxClustersPerRun) break;
  }
  return clusters;
}

function normalizeOptionalField(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeConsolidationCandidate(
  candidate: MemoryConsolidationCandidate,
  cluster: MemoryConsolidationCluster,
): ConsolidationCandidateDecision | { reason: string } {
  const content = normalizeOptionalField(candidate.content);
  if (!content) return { reason: "empty_content" };
  if (content.length > MAX_CONSOLIDATION_SUMMARY_CONTENT_LENGTH) return { reason: "content_too_long" };
  const clusterMemoryKind = cluster.memoryKind ?? (KNOWN_MEMORY_KINDS.has(cluster.kind as MemoryKind)
    ? cluster.kind as MemoryKind
    : undefined);
  const kind = candidate.kind ?? clusterMemoryKind;
  if (!kind) return { reason: "invalid_kind" };
  if (!KNOWN_MEMORY_KINDS.has(kind)) return { reason: "invalid_kind" };
  if (CONSOLIDATION_EXCLUDED_KINDS.has(kind)) return { reason: "person_or_boundary_kind" };
  if (classifySensitivity(content) === "secret_like") return { reason: "secret_like" };
  if (isPersonRoutedMemory(content)) return { reason: "person_routed" };
  const subject = normalizeOptionalField(candidate.subject);
  const predicate = normalizeOptionalField(candidate.predicate);
  const object = normalizeOptionalField(candidate.object);
  if (
    [subject, predicate, object].some(
      (value) => typeof value === "string" && classifySensitivity(value) === "secret_like",
    )
  ) {
    return { reason: "secret_like" };
  }
  if (kind === "person" || (subject && /^person\s*[:/]/iu.test(subject))) {
    return { reason: "person_routed" };
  }
  return {
    candidate,
    normalized: {
      kind,
      content,
      confidence: clamp(candidate.confidence ?? 0.7, 0, 1),
      ...(subject ? { subject } : {}),
      ...(predicate ? { predicate } : {}),
      ...(object ? { object } : {}),
    },
  };
}

export function uniqueConsolidationCandidateKey(input: {
  kind: MemoryKind;
  content: string;
  subject?: string | undefined;
  predicate?: string | undefined;
  object?: string | undefined;
}): string {
  return [
    input.kind,
    normalizedConsolidationContent(input.content),
    input.subject?.toLowerCase() ?? "",
    input.predicate?.toLowerCase() ?? "",
    input.object?.toLowerCase() ?? "",
  ].join("\n");
}
