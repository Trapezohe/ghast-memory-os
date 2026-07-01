#!/usr/bin/env node
import { writeFileSync } from "node:fs";

import type { EvidenceEvent } from "../kernel/types.js";
import { createMemoryOS } from "../runtime/create-memory-os.js";
import { createSqliteMemoryStore } from "../store/sqlite/index.js";

function value(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function format(): "json" | "markdown" {
  const selected = value("--format", "json");
  if (selected === "json" || selected === "markdown") return selected;
  throw new Error("--format must be json or markdown");
}

function numberValue(name: string, fallback: number): number {
  const raw = value(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function rowCount(rowCounts: Record<string, number>, table: string): number {
  return rowCounts[table] ?? 0;
}

function healthSignals(rowCounts: Record<string, number>): InspectReport["health"] {
  return {
    evidenceEvents: rowCount(rowCounts, "gmos_evidence_events"),
    memories: rowCount(rowCounts, "gmos_memories"),
    worldBeliefs: rowCount(rowCounts, "gmos_world_beliefs"),
    associations: rowCount(rowCounts, "gmos_associations"),
    taskTrajectories: rowCount(rowCounts, "gmos_task_trajectories"),
    failureEvents: rowCount(rowCounts, "gmos_failure_events"),
    memoryVectors: rowCount(rowCounts, "gmos_memory_vectors"),
    memoryVectorTerms: rowCount(rowCounts, "gmos_memory_vector_terms"),
  };
}

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function evidenceSummary(evidence: EvidenceEvent[]): InspectReport["evidenceSummary"] {
  const bySensitivity: Record<string, number> = {};
  const bySourceType: Record<string, number> = {};
  let eligibleForLongTermMemory = 0;
  for (const event of evidence) {
    if (event.eligibleForLongTermMemory) eligibleForLongTermMemory += 1;
    increment(bySensitivity, event.sensitivity);
    increment(bySourceType, event.sourceType);
  }
  return {
    inspected: evidence.length,
    eligibleForLongTermMemory,
    ineligibleForLongTermMemory: evidence.length - eligibleForLongTermMemory,
    bySensitivity,
    bySourceType,
  };
}

function requireValue(name: string): string {
  const selected = value(name);
  if (!selected) throw new Error(`${name} is required`);
  return selected;
}

function renderMarkdown(report: InspectReport): string {
  const lines = [
    "# gmOS Inspect Report",
    "",
    `- profileId: \`${report.profileId}\``,
    `- dbPath: ${report.dbPath}`,
    `- generatedAt: ${report.generatedAt}`,
    `- query: ${report.query ? `\`${report.query}\`` : "none"}`,
    "",
    "## Counts",
    "",
    `- evidence: ${report.counts.evidence}`,
    `- active memories: ${report.counts.activeMemories}`,
    `- archived memories: ${report.counts.archivedMemories}`,
    `- row count tables: ${Object.keys(report.rowCounts).length}`,
    "",
    "## Evidence Summary",
    "",
    `- inspected evidence events: ${report.evidenceSummary.inspected}`,
    `- eligible for long-term memory: ${report.evidenceSummary.eligibleForLongTermMemory}`,
    `- ineligible for long-term memory: ${report.evidenceSummary.ineligibleForLongTermMemory}`,
    `- sensitivity counts: ${JSON.stringify(report.evidenceSummary.bySensitivity)}`,
    `- source type counts: ${JSON.stringify(report.evidenceSummary.bySourceType)}`,
    "",
    "## Health Signals",
    "",
    `- evidence events: ${report.health.evidenceEvents}`,
    `- memories: ${report.health.memories}`,
    `- world beliefs: ${report.health.worldBeliefs}`,
    `- associations: ${report.health.associations}`,
    `- task trajectories: ${report.health.taskTrajectories}`,
    `- failure events: ${report.health.failureEvents}`,
    `- memory vectors: ${report.health.memoryVectors}`,
    `- memory vector terms: ${report.health.memoryVectorTerms}`,
    "",
    "## Reconstruction",
    "",
  ];
  if (!report.reconstruction) {
    lines.push("No query was provided, so reconstruction was not run.");
  } else {
    lines.push(
      `- path count: ${report.reconstruction.pathCount}`,
      `- retrieved memories: ${report.reconstruction.retrievedMemoryCount}`,
      `- prompt token estimate: ${report.reconstruction.promptTokenEstimate}`,
      `- stop reason: ${report.reconstruction.stopReason}`,
      `- coverage rate: ${report.reconstruction.coverageRate ?? "unknown"}`,
      `- convergence score: ${report.reconstruction.convergenceScore ?? "unknown"}`,
      `- convergence reached: ${report.reconstruction.convergenceReached ?? "unknown"}`,
      `- uncertainty: ${report.reconstruction.uncertaintyLevel ?? "unknown"}`,
    );
  }
  lines.push(
    "",
    "This report is content-safe: it does not print memory content, evidence text, table hashes, or prompt context.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

interface InspectReport {
  schema: "gmos.inspect_report.v1";
  generatedAt: string;
  profileId: string;
  dbPath: string;
  query: string | null;
  counts: {
    evidence: number;
    activeMemories: number;
    archivedMemories: number;
  };
  rowCounts: Record<string, number>;
  health: {
    evidenceEvents: number;
    memories: number;
    worldBeliefs: number;
    associations: number;
    taskTrajectories: number;
    failureEvents: number;
    memoryVectors: number;
    memoryVectorTerms: number;
  };
  evidenceSummary: {
    inspected: number;
    eligibleForLongTermMemory: number;
    ineligibleForLongTermMemory: number;
    bySensitivity: Record<string, number>;
    bySourceType: Record<string, number>;
  };
  reconstruction: null | {
    pathCount: number;
    retrievedMemoryCount: number;
    promptTokenEstimate: number;
    stopReason: string;
    coverageRate: number | null;
    convergenceScore: number | null;
    convergenceReached: boolean | null;
    uncertaintyLevel: "low" | "medium" | "high" | null;
    uncertaintyReasons: string[];
  };
}

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) {
    process.stdout.write([
      "Usage: gmos-inspect --db <path> [--profile <id>] [--query <text>] [--format json|markdown] [--output-file <path>]",
      "",
      "Creates a content-safe local inspection report with counts, evidence summaries, and optional reconstruction diagnostics.",
      "The report does not print memory content, evidence text, table hashes, or context blocks.",
      "",
    ].join("\n"));
    return;
  }

  const dbPath = requireValue("--db");
  const profileId = value("--profile", "default") ?? "default";
  const query = value("--query") ?? null;
  const outputFormat = format();
  const evidenceLimit = numberValue("--evidence-limit", 100);
  const store = createSqliteMemoryStore({ path: dbPath });
  const memory = createMemoryOS({ profileId, store });
  try {
    const evidence = await memory.listEvidence({ profileId, limit: evidenceLimit });
    const activeMemories = await memory.list({ profileId, status: "active" });
    const archivedMemories = await memory.list({ profileId, status: "archived" });
    const rowCounts = await store.rowCounts();
    const reconstructed = query
      ? await memory.reconstructContext({
          profileId,
          query,
          includeEvidence: true,
          maxSteps: numberValue("--max-steps", 2),
          maxBranch: numberValue("--max-branch", 4),
        })
      : null;

    const report: InspectReport = {
      schema: "gmos.inspect_report.v1",
      generatedAt: new Date().toISOString(),
      profileId,
      dbPath: "[plaintext sqlite path redacted]",
      query,
      counts: {
        evidence: evidence.length,
        activeMemories: activeMemories.length,
        archivedMemories: archivedMemories.length,
      },
      rowCounts,
      health: healthSignals(rowCounts),
      evidenceSummary: evidenceSummary(evidence),
      reconstruction: reconstructed
        ? {
            pathCount: reconstructed.paths.length,
            retrievedMemoryCount: reconstructed.stats.retrievedMemoryCount,
            promptTokenEstimate: reconstructed.stats.promptTokenEstimate,
            stopReason: reconstructed.stats.stopReason,
            coverageRate: reconstructed.stats.evidenceCoverage?.coverageRate ?? null,
            convergenceScore: reconstructed.stats.evidenceConvergence?.score ?? null,
            convergenceReached: reconstructed.stats.evidenceConvergence?.reached ?? null,
            uncertaintyLevel: reconstructed.stats.uncertainty?.level ?? null,
            uncertaintyReasons: reconstructed.stats.uncertainty?.reasons ?? [],
          }
        : null,
    };

    const rendered = outputFormat === "markdown" ? renderMarkdown(report) : `${JSON.stringify(report, null, 2)}\n`;
    const outputFile = value("--output-file");
    if (outputFile) {
      writeFileSync(outputFile, rendered);
    } else {
      process.stdout.write(rendered);
    }
  } finally {
    await memory.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
