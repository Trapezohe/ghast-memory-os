import { createHash } from "node:crypto";

export const LOCAL_TEXT_VECTOR_DIMENSIONS = 384;

function hashFeature(feature: string): number {
  let hash = 2166136261;
  for (let index = 0; index < feature.length; index += 1) {
    hash ^= feature.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function localTextFeatures(text: string): string[] {
  const normalized = text.toLowerCase().replace(/\s+/gu, " ").trim();
  const tokens = normalized.match(/[\p{L}\p{N}_][\p{L}\p{N}_-]{1,}/gu) ?? [];
  const features: string[] = [];
  for (const token of tokens) {
    features.push(`tok:${token}`);
    const compact = token.replace(/[^\p{L}\p{N}]/gu, "");
    for (const size of [2, 3, 4]) {
      for (let index = 0; index + size <= compact.length; index += 1) {
        features.push(`ng${size}:${compact.slice(index, index + size)}`);
      }
    }
  }
  for (const match of normalized.matchAll(/\p{Script=Han}{2,}/gu)) {
    const run = match[0];
    for (const size of [2, 3]) {
      for (let index = 0; index + size <= run.length; index += 1) {
        features.push(`han${size}:${run.slice(index, index + size)}`);
      }
    }
  }
  return unique(features);
}

function candidateFeaturePriority(feature: string): number {
  if (feature.startsWith("tok:")) return 0;
  if (feature.startsWith("han3:")) return 1;
  if (feature.startsWith("han2:")) return 2;
  if (feature.startsWith("ng4:")) return 3;
  if (feature.startsWith("ng3:")) return 4;
  return 5;
}

export function localTextCandidateFeatures(text: string, limit = 96): string[] {
  return localTextFeatures(text)
    .map((feature, index) => ({ feature, index }))
    .sort(
      (left, right) =>
        candidateFeaturePriority(left.feature) - candidateFeaturePriority(right.feature) ||
        left.index - right.index,
    )
    .slice(0, Math.max(1, limit))
    .map((entry) => entry.feature);
}

export function localTextVector(text: string, dimensions = LOCAL_TEXT_VECTOR_DIMENSIONS): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (const feature of localTextFeatures(text)) {
    const hash = hashFeature(feature);
    const index = hash % dimensions;
    vector[index] = (vector[index] ?? 0) + (hash & 1 ? 1 : -1);
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude > 0 ? vector.map((value) => Number((value / magnitude).toFixed(6))) : vector;
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let score = 0;
  for (let index = 0; index < length; index += 1) {
    score += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return score;
}

export function vectorContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
