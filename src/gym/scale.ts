import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { MemoryKind } from "../kernel/types.js";
import { createMemoryOS } from "../runtime/create-memory-os.js";
import { createSqliteMemoryStore } from "../store/sqlite/index.js";

export interface LatencySummary {
  samples: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  avgMs: number;
}

export interface MemoryScaleBenchmarkRow {
  size: number;
  seedMs: number;
  prepareTurn: LatencySummary;
  reconstructContext: LatencySummary;
  contextNoHitSearch: LatencySummary;
  promptTokenEstimate: {
    p50: number;
    p95: number;
    max: number;
  };
  reconstructedTokenEstimate: {
    p50: number;
    p95: number;
    max: number;
  };
  reconstructedPathCount: {
    p50: number;
    p95: number;
    max: number;
  };
}

export interface MemoryScaleFailedOperation {
  size: number;
  operation: "prepareTurn" | "reconstructContext" | "contextNoHitSearch";
  p95Ms: number;
  thresholdMs: number;
}

export interface MemoryScaleBenchmarkResult {
  pass: boolean;
  thresholds: {
    prepareTurnP95Ms: number;
    reconstructContextP95Ms: number;
  };
  failedOperations: MemoryScaleFailedOperation[];
  results: MemoryScaleBenchmarkRow[];
}

function percentile(values: number[], rate: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] ?? 0;
  const boundedRate = Math.min(1, Math.max(0, rate));
  const rank = (sorted.length - 1) * boundedRate;
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sorted[lowerIndex] ?? 0;
  const upper = sorted[upperIndex] ?? lower;
  return lower + (upper - lower) * (rank - lowerIndex);
}

export function summarizeMemoryScaleLatenciesForTest(values: number[]): LatencySummary {
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    samples: values.length,
    minMs: Math.min(...values),
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: Math.max(...values),
    avgMs: values.length === 0 ? 0 : sum / values.length,
  };
}

export async function runMemoryScaleBenchmark(
  options: {
    sizes?: number[] | undefined;
    iterations?: number | undefined;
    thresholdP95Ms?: number | undefined;
  } = {},
): Promise<MemoryScaleBenchmarkResult> {
  const sizes = options.sizes ?? [100, 1000];
  const iterations = options.iterations ?? 16;
  const thresholdP95Ms = options.thresholdP95Ms ?? 250;
  if (
    sizes.length === 0 ||
    sizes.some((size) => !Number.isInteger(size) || size <= 0)
  ) {
    throw new Error("Memory scale benchmark requires at least one positive integer size");
  }
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error("Memory scale benchmark iterations must be a positive integer");
  }
  const results: MemoryScaleBenchmarkRow[] = [];

  for (const size of sizes) {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "gmos-scale-"));
    const dbPath = path.join(tmp, "scale.db");
    const store = createSqliteMemoryStore({ path: dbPath });
    const memory = createMemoryOS({ profileId: "scale", store });
    const seedStart = performance.now();
    await store.initialize();
    const routeBucketCount = Math.max(1, Math.min(20, Math.floor(size / 3)));
    for (let index = 0; index < size; index += 1) {
      const routeBucket = index % routeBucketCount;
      let kind: MemoryKind;
      let content: string;
      if (index < routeBucketCount) {
        kind = "project";
        content = `scale project-${routeBucket} is the routed benchmark plan for route-${routeBucket}`;
      } else if (index < routeBucketCount * 2) {
        kind = "procedure";
        content = `scale project-${routeBucket} next step is to verify route-${routeBucket} reconstruction evidence before implementation`;
      } else if (index < routeBucketCount * 3) {
        kind = "fact";
        content = `scale project-${routeBucket} high-confidence distractor note ${index} should not replace the next step`;
      } else {
        kind = index % 5 === 0 ? "boundary" : index % 3 === 0 ? "preference" : "fact";
        content = `scale memory ${index} project-${routeBucket} preference-${index % 11} distractor-${index}`;
      }
      await store.addMemory({
        profileId: "scale",
        kind,
        content,
        confidence: 0.5 + (index % 10) / 20,
        metadata: { synthetic: true, bucket: routeBucket },
      });
    }
    const seedMs = performance.now() - seedStart;
    const prepareTurnLatencies: number[] = [];
    const reconstructContextLatencies: number[] = [];
    const contextNoHitSearchLatencies: number[] = [];
    const tokens: number[] = [];
    const reconstructedTokens: number[] = [];
    const reconstructedPathCounts: number[] = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const routeBucket = iteration % routeBucketCount;
      const started = performance.now();
      const prepared = await memory.prepareTurn({
        profileId: "scale",
        messages: [{ role: "user", content: `project-${routeBucket} preference` }],
      });
      prepareTurnLatencies.push(performance.now() - started);
      tokens.push(prepared.stats.promptTokenEstimate);
      const reconstructStarted = performance.now();
      const reconstructed = await memory.reconstructContext({
        profileId: "scale",
        query: `project-${routeBucket} next step`,
        maxSteps: 4,
        maxBranch: 6,
        maxMemories: 6,
        contextBudgetTokens: 1200,
      });
      reconstructContextLatencies.push(performance.now() - reconstructStarted);
      reconstructedTokens.push(reconstructed.stats.promptTokenEstimate);
      reconstructedPathCounts.push(reconstructed.paths.length);
      const noHitStarted = performance.now();
      await memory.search({
        profileId: "scale",
        query: `neptunian orbit passwd relationless ${iteration}`,
        limit: 6,
      });
      contextNoHitSearchLatencies.push(performance.now() - noHitStarted);
    }
    await memory.close();
    rmSync(tmp, { recursive: true, force: true });
    results.push({
      size,
      seedMs,
      prepareTurn: summarizeMemoryScaleLatenciesForTest(prepareTurnLatencies),
      reconstructContext: summarizeMemoryScaleLatenciesForTest(reconstructContextLatencies),
      contextNoHitSearch: summarizeMemoryScaleLatenciesForTest(contextNoHitSearchLatencies),
      promptTokenEstimate: {
        p50: percentile(tokens, 0.5),
        p95: percentile(tokens, 0.95),
        max: Math.max(...tokens),
      },
      reconstructedTokenEstimate: {
        p50: percentile(reconstructedTokens, 0.5),
        p95: percentile(reconstructedTokens, 0.95),
        max: Math.max(...reconstructedTokens),
      },
      reconstructedPathCount: {
        p50: percentile(reconstructedPathCounts, 0.5),
        p95: percentile(reconstructedPathCounts, 0.95),
        max: Math.max(...reconstructedPathCounts),
      },
    });
  }
  const failedOperations = results.flatMap((row) => {
    const failures: MemoryScaleFailedOperation[] = [];
    if (row.prepareTurn.p95Ms > thresholdP95Ms) {
      failures.push({
        size: row.size,
        operation: "prepareTurn",
        p95Ms: row.prepareTurn.p95Ms,
        thresholdMs: thresholdP95Ms,
      });
    }
    if (row.reconstructContext.p95Ms > thresholdP95Ms) {
      failures.push({
        size: row.size,
        operation: "reconstructContext",
        p95Ms: row.reconstructContext.p95Ms,
        thresholdMs: thresholdP95Ms,
      });
    }
    if (row.contextNoHitSearch.p95Ms > thresholdP95Ms) {
      failures.push({
        size: row.size,
        operation: "contextNoHitSearch",
        p95Ms: row.contextNoHitSearch.p95Ms,
        thresholdMs: thresholdP95Ms,
      });
    }
    return failures;
  });

  return {
    pass: failedOperations.length === 0,
    thresholds: {
      prepareTurnP95Ms: thresholdP95Ms,
      reconstructContextP95Ms: thresholdP95Ms,
    },
    failedOperations,
    results,
  };
}
