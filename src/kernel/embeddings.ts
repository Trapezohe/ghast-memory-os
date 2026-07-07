import { AsyncLocalStorage } from "node:async_hooks";

import {
  LOCAL_TEXT_VECTOR_DIMENSIONS,
  LOCAL_TEXT_VECTOR_PROVIDER,
  localTextVector,
  normalizeVector,
} from "./local-vector.js";
import { classifySensitivity, isPersonRoutedMemory } from "./safety.js";
import type {
  EmbeddingProvider,
  EmbeddingProviderConfig,
  MemoryKind,
  MemoryVectorEmbedding,
  QueryVectorEmbedding,
  Sensitivity,
} from "./types.js";

export const DEFAULT_EMBEDDING_TIMEOUT_MS = 1500;
export const DEFAULT_EMBEDDING_BATCH_SIZE = 32;
export const DEFAULT_VECTOR_BACKFILL_BATCH_SIZE = DEFAULT_EMBEDDING_BATCH_SIZE;

export type EmbeddingProviderCallPriority = "bulk" | "query";

const embeddingProviderCallPriority = new AsyncLocalStorage<EmbeddingProviderCallPriority>();

export function currentEmbeddingProviderCallPriority(): EmbeddingProviderCallPriority | undefined {
  return embeddingProviderCallPriority.getStore();
}

export interface MemoryEmbeddingInput {
  kind: MemoryKind;
  sensitivity: Sensitivity;
  content: string;
}

export interface MemoryEmbeddingBatchResult {
  embeddings: MemoryVectorEmbedding[];
  providerCallCount: number;
  providerFailureCount: number;
  embeddedMemoryCount: number;
}

export interface ResolvedEmbeddingProviderConfig {
  name: string;
  dimensions: number;
  maxBatchSize: number;
  embedSensitive: boolean;
  embedPerson: boolean;
  timeoutMs: number;
  embed(texts: string[]): Promise<number[][]>;
}

export function resolveEmbeddingProviderConfig(
  input: EmbeddingProvider | EmbeddingProviderConfig | undefined,
): ResolvedEmbeddingProviderConfig | null {
  if (!input) return null;
  let provider: EmbeddingProvider;
  let embedSensitive = false;
  let embedPerson = false;
  let timeoutMs: number | undefined;
  if (isEmbeddingProviderConfig(input)) {
    provider = input.provider;
    embedSensitive = input.embedSensitive === true;
    embedPerson = input.embedPerson === true;
    timeoutMs = input.timeoutMs;
  } else {
    provider = input;
  }
  const name = typeof provider === "function" ? "host-embedding-provider" : provider.name.trim();
  const dimensions = typeof provider === "function" ? 0 : Math.trunc(provider.dimensions);
  const maxBatchSize =
    typeof provider === "function"
      ? DEFAULT_EMBEDDING_BATCH_SIZE
      : boundedBatchSize(provider.maxBatchSize);
  const embed = typeof provider === "function" ? provider : provider.embed.bind(provider);
  if (!name) throw new Error("gmOS embedding provider requires a non-empty name");
  if (typeof provider !== "function" && (!Number.isInteger(dimensions) || dimensions <= 0)) {
    throw new Error("gmOS embedding provider dimensions must be a positive integer");
  }
  return {
    name,
    dimensions,
    maxBatchSize,
    embedSensitive,
    embedPerson,
    timeoutMs: boundedTimeout(timeoutMs),
    embed,
  };
}

function isEmbeddingProviderConfig(
  input: EmbeddingProvider | EmbeddingProviderConfig,
): input is EmbeddingProviderConfig {
  return typeof input !== "function" && "provider" in input;
}

export function providerNameForHealth(
  provider: ResolvedEmbeddingProviderConfig | null,
): string {
  return provider?.name ?? LOCAL_TEXT_VECTOR_PROVIDER;
}

export function providerDimensionsForHealth(
  provider: ResolvedEmbeddingProviderConfig | null,
): number {
  return provider?.dimensions && provider.dimensions > 0
    ? provider.dimensions
    : LOCAL_TEXT_VECTOR_DIMENSIONS;
}

export function memoryEligibleForEmbeddingProvider(input: {
  provider: ResolvedEmbeddingProviderConfig | null;
  kind: MemoryKind;
  sensitivity: Sensitivity;
  content: string;
}): boolean {
  if (!input.provider) return false;
  if (classifySensitivity(input.content) === "secret_like") return false;
  if (isPersonRoutedMemory(input.content)) return false;
  if (input.kind === "person" && !input.provider.embedPerson) return false;
  if (input.sensitivity !== "normal" && !input.provider.embedSensitive) return false;
  return true;
}

export function queryEligibleForEmbeddingProvider(query: string): boolean {
  return classifySensitivity(query) !== "secret_like" && !isPersonRoutedMemory(query);
}

export async function embeddingForMemory(input: {
  provider: ResolvedEmbeddingProviderConfig | null;
  kind: MemoryKind;
  sensitivity: Sensitivity;
  content: string;
  timeoutMs?: number | undefined;
}): Promise<MemoryVectorEmbedding> {
  const result = await embeddingsForMemories({
    provider: input.provider,
    memories: [input],
    timeoutMs: input.timeoutMs,
  });
  return result.embeddings[0] ?? localMemoryEmbedding(input.content, "embedded");
}

export async function embeddingsForMemories(input: {
  provider: ResolvedEmbeddingProviderConfig | null;
  memories: MemoryEmbeddingInput[];
  timeoutMs?: number | undefined;
}): Promise<MemoryEmbeddingBatchResult> {
  const embeddings = input.memories.map((memory) =>
    localMemoryEmbedding(memory.content, "embedded")
  );
  const provider = input.provider;
  if (!provider || input.memories.length === 0) {
    return {
      embeddings,
      providerCallCount: 0,
      providerFailureCount: 0,
      embeddedMemoryCount: 0,
    };
  }
  const candidates = input.memories.flatMap((memory, index) =>
    memoryEligibleForEmbeddingProvider({ provider, ...memory })
      ? [{ index, memory }]
      : []
  );
  let providerCallCount = 0;
  let providerFailureCount = 0;
  let embeddedMemoryCount = 0;
  for (let index = 0; index < candidates.length; index += provider.maxBatchSize) {
    const batch = candidates.slice(index, index + provider.maxBatchSize);
    providerCallCount += 1;
    const embedded = await callProvider({
      provider,
      texts: batch.map((candidate) => candidate.memory.content),
      timeoutMs: input.timeoutMs,
      priority: "bulk",
    });
    if (!embedded) {
      providerFailureCount += 1;
      for (const candidate of batch) {
        embeddings[candidate.index] = localMemoryEmbedding(candidate.memory.content, "pending");
      }
      continue;
    }
    embeddedMemoryCount += batch.length;
    for (const [offset, candidate] of batch.entries()) {
      embeddings[candidate.index] = {
        providerName: provider.name,
        dimensions: embedded.dimensions,
        vector: embedded.vectors[offset] ?? [],
        status: "embedded",
      };
    }
  }
  return {
    embeddings,
    providerCallCount,
    providerFailureCount,
    embeddedMemoryCount,
  };
}

export async function embeddingForQuery(input: {
  provider: ResolvedEmbeddingProviderConfig | null;
  query: string;
  timeoutMs?: number | undefined;
}): Promise<QueryVectorEmbedding | null> {
  if (!input.provider || !queryEligibleForEmbeddingProvider(input.query)) return null;
  const embedded = await callProvider({
    provider: input.provider,
    texts: [input.query],
    timeoutMs: input.timeoutMs,
    priority: "query",
  });
  if (!embedded) return null;
  return {
    providerName: input.provider.name,
    dimensions: embedded.dimensions,
    vector: embedded.vectors[0] ?? [],
  };
}

export function localMemoryEmbedding(
  content: string,
  status: MemoryVectorEmbedding["status"],
): MemoryVectorEmbedding {
  const vector = localTextVector(content);
  return {
    providerName: LOCAL_TEXT_VECTOR_PROVIDER,
    dimensions: vector.length,
    vector,
    status,
  };
}

export function validateStoredEmbedding(input: MemoryVectorEmbedding): MemoryVectorEmbedding {
  return {
    providerName: input.providerName.trim() || LOCAL_TEXT_VECTOR_PROVIDER,
    dimensions: validateDimensions(input.dimensions, input.vector),
    vector: normalizeVector(input.vector),
    status: input.status,
  };
}

export function validateQueryEmbedding(input: QueryVectorEmbedding): QueryVectorEmbedding {
  return {
    providerName: input.providerName.trim() || LOCAL_TEXT_VECTOR_PROVIDER,
    dimensions: validateDimensions(input.dimensions, input.vector),
    vector: normalizeVector(input.vector),
  };
}

function validateDimensions(dimensions: number, vector: number[]): number {
  const normalizedDimensions = Math.trunc(dimensions);
  if (!Number.isInteger(normalizedDimensions) || normalizedDimensions <= 0) {
    throw new Error("gmOS embedding dimensions must be a positive integer");
  }
  if (vector.length !== normalizedDimensions) {
    throw new Error("gmOS embedding vector dimensions do not match provider dimensions");
  }
  return normalizedDimensions;
}

async function callProvider(input: {
  provider: ResolvedEmbeddingProviderConfig;
  texts: string[];
  timeoutMs?: number | undefined;
  priority: EmbeddingProviderCallPriority;
}): Promise<{ dimensions: number; vectors: number[][] } | null> {
  try {
    const timeoutMs = boundedTimeout(input.timeoutMs ?? input.provider.timeoutMs);
    const vectors = await withTimeout(
      embeddingProviderCallPriority.run(input.priority, () => input.provider.embed(input.texts)),
      timeoutMs,
    );
    if (vectors.length !== input.texts.length) return null;
    const dimensions =
      input.provider.dimensions > 0 ? input.provider.dimensions : vectors[0]?.length ?? 0;
    const normalized = vectors.map((vector) => normalizeVector(vector));
    if (normalized.some((vector) => vector.length !== dimensions)) return null;
    return { dimensions, vectors: normalized };
  } catch {
    return null;
  }
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_EMBEDDING_TIMEOUT_MS;
  return Math.max(50, Math.min(Math.trunc(value), 30_000));
}

function boundedBatchSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_EMBEDDING_BATCH_SIZE;
  return Math.max(1, Math.min(Math.trunc(value), 256));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("gmOS embedding provider timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
