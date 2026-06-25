import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

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
  promptTokenEstimate: {
    p50: number;
    p95: number;
    max: number;
  };
}

export interface MemoryScaleBenchmarkResult {
  pass: boolean;
  thresholds: {
    prepareTurnP95Ms: number;
  };
  results: MemoryScaleBenchmarkRow[];
}

function percentile(values: number[], rate: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * rate) - 1);
  return sorted[index] ?? 0;
}

function summarize(values: number[]): LatencySummary {
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
  const iterations = options.iterations ?? 12;
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
    for (let index = 0; index < size; index += 1) {
      await store.addMemory({
        profileId: "scale",
        kind: index % 5 === 0 ? "boundary" : index % 3 === 0 ? "preference" : "fact",
        content: `scale memory ${index} project-${index % 20} preference-${index % 11}`,
        confidence: 0.5 + (index % 10) / 20,
        metadata: { synthetic: true, bucket: index % 20 },
      });
    }
    const seedMs = performance.now() - seedStart;
    const latencies: number[] = [];
    const tokens: number[] = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const started = performance.now();
      const prepared = await memory.prepareTurn({
        profileId: "scale",
        messages: [{ role: "user", content: `project-${iteration % 20} preference` }],
      });
      latencies.push(performance.now() - started);
      tokens.push(prepared.stats.promptTokenEstimate);
    }
    await memory.close();
    rmSync(tmp, { recursive: true, force: true });
    results.push({
      size,
      seedMs,
      prepareTurn: summarize(latencies),
      promptTokenEstimate: {
        p50: percentile(tokens, 0.5),
        p95: percentile(tokens, 0.95),
        max: Math.max(...tokens),
      },
    });
  }

  return {
    pass: results.every((row) => row.prepareTurn.p95Ms <= thresholdP95Ms),
    thresholds: { prepareTurnP95Ms: thresholdP95Ms },
    results,
  };
}
