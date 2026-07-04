import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  hashExternalMemoryBenchmarkInput,
  parseExternalMemoryBenchmarkDataset,
  runExternalMemoryBenchmark,
} from "@ghast/memory/gym";

const examplesDir = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(examplesDir, "external-mini-fixture.jsonl");
const fixtureText = readFileSync(fixturePath, "utf8");
const parsed = parseExternalMemoryBenchmarkDataset(fixtureText, { adapter: "gmos" });

const report = await runExternalMemoryBenchmark({
  cases: parsed.cases,
  datasetFormat: parsed.datasetFormat,
  datasetHash: hashExternalMemoryBenchmarkInput(fixtureText),
  datasetId: "examples/external-mini-fixture.jsonl",
  datasetWarnings: parsed.warnings,
  diagnosticsLevel: "basic",
  failureSampleLimit: 3,
  maxSteps: 4,
  maxBranch: 4,
  maxMemories: 6,
  contextBudgetTokens: 1600,
});

assert.equal(report.schema, "gmos.external_long_memory_qa.v1");
assert.equal(report.pass, true);
assert.equal(report.caseCount, 3);
assert.equal(report.strictScore, 1);
assert.equal(report.normalizedEvidenceScore, 1);
assert.equal(report.runManifest.protocol, "deterministic_local");
assert.equal(report.runManifest.judgeProvenance.kind, "none");
assert.equal(report.runManifest.scoreSemantics.protocol, "deterministic_local");
assert.equal(report.runManifest.scoreSemantics.officialProtocol, "not_run");
assert.equal(report.runManifest.scoreSemantics.comparableToOfficialScore, false);
assert.equal(report.runManifest.deterministicOnly, true);
assert.equal(report.ceilingMetrics.lexicalCeiling, 1);
assert.equal(report.ceilingMetrics.reachableScore, 1);

const sliceScores = Object.fromEntries(
  (report.summary.sliceScores ?? []).map((slice) => [slice.name, slice.score]),
);

console.log(
  JSON.stringify(
    {
      ok: true,
      fixture: "examples/external-mini-fixture.jsonl",
      datasetFormat: report.datasetFormat,
      protocol: report.runManifest.protocol,
      judgeName: report.runManifest.judgeProvenance.name,
      deterministicOnly: report.runManifest.deterministicOnly,
      officialProtocol: report.runManifest.scoreSemantics.officialProtocol,
      comparableToOfficialScore: report.runManifest.scoreSemantics.comparableToOfficialScore,
      caseCount: report.caseCount,
      passedCount: report.passedCount,
      lexicalCeiling: report.ceilingMetrics.lexicalCeiling,
      reachableScore: report.ceilingMetrics.reachableScore,
      unreachableCount: report.ceilingMetrics.unreachableCount,
      strictScore: report.strictScore,
      normalizedEvidenceScore: report.normalizedEvidenceScore,
      sliceScores,
      failureReasonCount: report.summary.failureReasons.length,
    },
    null,
    2,
  ),
);
