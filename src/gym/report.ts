import type { MemoryGymResult } from "./index.js";
import type { MemoryScaleBenchmarkResult } from "./scale.js";

export function renderMemoryGymMarkdown(report: MemoryGymResult): string {
  return [
    "# gmOS Memory Gym Report",
    "",
    `Status: ${report.pass ? "PASS" : "FAIL"}`,
    `Score: ${report.score.toFixed(4)}`,
    "",
    "## Hard Gates",
    ...Object.entries(report.hardGates).map(
      ([name, passed]) => `- ${name}: ${passed ? "PASS" : "FAIL"}`,
    ),
    "",
    "## Details",
    ...report.details.map((detail) => `- ${detail}`),
    "",
  ].join("\n");
}

export function renderMemoryScaleMarkdown(report: MemoryScaleBenchmarkResult): string {
  return [
    "# gmOS Memory Scale Benchmark",
    "",
    `Status: ${report.pass ? "PASS" : "FAIL"}`,
    "Scope: local SQLite prepareTurn cost curve; not an external benchmark proof.",
    "",
    "| Memories | Seed ms | prepareTurn p50/p95/max ms | Prompt p95 tokens |",
    "| ---: | ---: | ---: | ---: |",
    ...report.results.map(
      (row) =>
        `| ${row.size} | ${row.seedMs.toFixed(3)} | ${row.prepareTurn.p50Ms.toFixed(3)}/${row.prepareTurn.p95Ms.toFixed(3)}/${row.prepareTurn.maxMs.toFixed(3)} | ${row.promptTokenEstimate.p95} |`,
    ),
    "",
  ].join("\n");
}
