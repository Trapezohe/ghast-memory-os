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
export const DEFAULT_VECTOR_BACKFILL_BATCH_SIZE = 32;

export interface ResolvedEmbeddingProviderConfig {
  name: string;
  dimensions: number;
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
  const embed = typeof provider === "function" ? provider : provider.embed.bind(provider);
  if (!name) throw new Error("gmOS embedding provider requires a non-empty name");
  if (typeof provider !== "function" && (!Number.isInteger(dimensions) || dimensions <= 0)) {
    throw new Error("gmOS embedding provider dimensions must be a positive integer");
  }
  return {
    name,
    dimensions,
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
  const fallback = localMemoryEmbedding(input.content, "embedded");
  const provider = input.provider;
  if (!provider) return fallback;
  if (!memoryEligibleForEmbeddingProvider(input)) return fallback;
  const embedded = await callProvider({
    provider,
    texts: [input.content],
    timeoutMs: input.timeoutMs,
  });
  if (!embedded) return localMemoryEmbedding(input.content, "pending");
  return {
    providerName: provider.name,
    dimensions: embedded.dimensions,
    vector: embedded.vectors[0] ?? [],
    status: "embedded",
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
}): Promise<{ dimensions: number; vectors: number[][] } | null> {
  try {
    const timeoutMs = boundedTimeout(input.timeoutMs ?? input.provider.timeoutMs);
    const vectors = await withTimeout(input.provider.embed(input.texts), timeoutMs);
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
