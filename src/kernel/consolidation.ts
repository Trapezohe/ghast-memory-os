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
const DEFAULT_ENTITY_MIN_CLUSTER_SIZE = 3;
const DEFAULT_ENTITY_MAX_CLUSTERS_PER_RUN = 40;
const DEFAULT_ENTITY_MAX_MEMBERS_PER_CLUSTER = 24;
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

interface EntityObjectSignal {
  memory: MemoryRecord;
  object: string;
  phrase: string;
  tokens: string[];
  distinctiveTokens: string[];
  codeTokens: string[];
  specificTokens: string[];
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

const ENTITY_GENERIC_TOKENS = new Set([
  "a",
  "an",
  "the",
  "scale",
  "model",
  "models",
  "kit",
  "kits",
  "miniature",
  "miniatures",
]);

function isScaleToken(token: string): boolean {
  return /^\d+\s*(?:[/:-]\s*\d+)$/u.test(token);
}

function isCodeToken(token: string): boolean {
  return /[\p{L}]/u.test(token) && /[\d/-]/u.test(token);
}

function normalizedEntityPhrase(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const phrase = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’]/gu, "")
    .replace(/[^\p{L}\p{N}/:-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^(?:a|an|the)\s+/u, "")
    .replace(/^(?:\d+\s*(?:[/:-]\s*\d+)|\d+\s*:\s*\d+)\s*(?:scale)?\s+/u, "")
    .replace(/^scale\s+/u, "")
    .trim();
  return phrase.length > 0 ? phrase : null;
}

function entityTokens(phrase: string): string[] {
  return [...phrase.matchAll(/[\p{L}\p{N}]+(?:[/-][\p{L}\p{N}]+)*/gu)]
    .map((match) => match[0]!)
    .filter((token) => !ENTITY_GENERIC_TOKENS.has(token) && !isScaleToken(token));
}

function entityObjectSignal(memory: MemoryRecord): EntityObjectSignal | null {
  const phrase = normalizedEntityPhrase(memory.metadata.object);
  if (!phrase) return null;
  const tokens = entityTokens(phrase);
  const distinctiveTokens = tokens.filter((token) => token.length >= 3 || isCodeToken(token));
  if (distinctiveTokens.length === 0) return null;
  const codeTokens = distinctiveTokens.filter(isCodeToken);
  const specificTokens = distinctiveTokens.filter((token) => isCodeToken(token) || /^\d+$/u.test(token));
  return {
    memory,
    object: memory.metadata.object as string,
    phrase,
    tokens,
    distinctiveTokens,
    codeTokens,
    specificTokens,
  };
}

function tokenPhraseContains(left: string[], right: string[]): boolean {
  if (right.length === 0 || right.length > left.length) return false;
  for (let index = 0; index <= left.length - right.length; index += 1) {
    if (right.every((token, offset) => left[index + offset] === token)) return true;
  }
  return false;
}

function intersects(left: readonly string[], right: readonly string[]): boolean {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function conflictingSpecificTokens(left: EntityObjectSignal, right: EntityObjectSignal): boolean {
  if (left.specificTokens.length === 0 || right.specificTokens.length === 0) return false;
  return !intersects(left.specificTokens, right.specificTokens);
}

function entitySignalsCompatible(left: EntityObjectSignal, right: EntityObjectSignal): boolean {
  if (left.phrase === right.phrase) return true;
  if (tokenPhraseContains(left.tokens, right.tokens) || tokenPhraseContains(right.tokens, left.tokens)) {
    return true;
  }
  if (intersects(left.codeTokens, right.codeTokens)) return true;
  const sharedNameToken = left.distinctiveTokens.some(
    (token) => token.length >= 5 && right.distinctiveTokens.includes(token),
  );
  return sharedNameToken && !conflictingSpecificTokens(left, right);
}

function bestEntityToken(signals: EntityObjectSignal[]): string {
  const [first, ...rest] = signals.map((signal) => signal.distinctiveTokens);
  let shared = new Set(first ?? []);
  for (const tokens of rest) {
    const tokenSet = new Set(tokens);
    shared = new Set([...shared].filter((token) => tokenSet.has(token)));
  }
  const sharedTokens = [...shared].sort(
    (left, right) =>
      Number(isCodeToken(right)) - Number(isCodeToken(left)) ||
      right.length - left.length ||
      left.localeCompare(right),
  );
  return sharedTokens[0] ?? signals[0]?.phrase ?? "entity";
}

function bestEntityObject(signals: EntityObjectSignal[]): string {
  return signals
    .map((signal) => signal.object)
    .sort((left, right) => right.length - left.length || left.localeCompare(right))[0]!;
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
  const candidates = memories
    .filter(memoryCanEnterConsolidation)
    .filter((memory) => !metadataHasConsolidationResidue(memory))
    .map(entityObjectSignal)
    .filter((signal): signal is EntityObjectSignal => signal !== null)
    .sort((left, right) => stableMemoryOrder(left.memory, right.memory));
  const groups: EntityObjectSignal[][] = [];
  for (const signal of candidates) {
    const group = groups.find((entry) => entry.some((existing) => entitySignalsCompatible(existing, signal)));
    if (group) {
      group.push(signal);
    } else {
      groups.push([signal]);
    }
  }
  return groups
    .map((group) => group.sort((left, right) => stableMemoryOrder(left.memory, right.memory)))
    .filter((group) => group.length >= minClusterSize)
    .sort((left, right) =>
      bestEntityToken(left).localeCompare(bestEntityToken(right)) ||
      stableMemoryOrder(left[0]!.memory, right[0]!.memory)
    )
    .slice(0, config.entityConsolidation.maxClustersPerRun)
    .map((group) => {
      const members = group
        .slice(0, config.entityConsolidation.maxMembersPerCluster)
        .map((signal) => signal.memory);
      const signals = group.slice(0, members.length);
      return {
        kind: "entity",
        memoryKind: members[0]!.kind,
        entityKey: bestEntityToken(signals),
        entityObject: bestEntityObject(signals),
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
