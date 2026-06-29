import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const suiteFile = path.join(root, "test", "fixtures", "external-benchmark", "suite.json");
const cliFile = path.join(root, "dist", "cli", "gmos.js");
const fixturesDir = path.dirname(suiteFile);

function jsonlIds(fileName) {
  return new Set(
    readFileSync(path.join(fixturesDir, fileName), "utf8")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => JSON.parse(line).id),
  );
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [cliFile, ...args], {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
}

function runSlicePassed(run, name, caseCount) {
  return run?.sliceScores?.some(
    (slice) =>
      slice.name === name &&
      slice.caseCount === caseCount &&
      slice.passedCount === caseCount &&
      slice.failedCount === 0 &&
      slice.score === 1,
  );
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function caseById(runReport, id) {
  return runReport?.cases?.find((entry) => entry.id === id);
}

function matched(caseReport, value) {
  return caseReport?.expectedAnyMatched?.includes(value) || caseReport?.expectedAllMatched?.includes(value);
}

function hasDiagnostics(caseReport) {
  const diagnostics = caseReport?.diagnostics;
  return (
    diagnostics &&
    typeof diagnostics.evidenceCoverageRate === "number" &&
    typeof diagnostics.evidenceConvergenceScore === "number" &&
    typeof diagnostics.evidenceConvergenceReached === "boolean" &&
    typeof diagnostics.uncertaintyLevel === "string"
  );
}

const mainTmp = mkdtempSync(path.join(os.tmpdir(), "gmos-external-main-"));
process.on("exit", () => rmSync(mainTmp, { recursive: true, force: true }));
const mainOutputDir = path.join(mainTmp, "reports");
const result = runCli([
  "gym",
  "external-suite",
  "--suite-file",
  suiteFile,
  "--output-dir",
  mainOutputDir,
  "--fail-on-benchmark-fail",
  "--format",
  "json",
]);

if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.stderr.write(result.stdout);
  process.exit(result.status ?? 1);
}

const report = JSON.parse(result.stdout);
const failures = [];
if (report.pass !== true) failures.push("suite pass=false");
if (report.benchmarkPass !== true) failures.push("benchmarkPass=false");
if (report.runCount !== 4) failures.push(`runCount=${report.runCount}`);
if (report.totalCaseCount !== 51) failures.push(`totalCaseCount=${report.totalCaseCount}`);
if (report.totalPassedCount !== 51) failures.push(`totalPassedCount=${report.totalPassedCount}`);
if (report.totalFailedCount !== 0) failures.push(`totalFailedCount=${report.totalFailedCount}`);
if (report.scoreWeighted !== 1) failures.push(`scoreWeighted=${report.scoreWeighted}`);

const runs = new Map((report.runs ?? []).map((run) => [run.id, run]));
const gmosRun = runs.get("curated-gmos");
const budgetRun = runs.get("budget-drop-mini");
const longMemEvalRun = runs.get("longmemeval-mini");
const locomoRun = runs.get("locomo-mini");
const longMemEvalReport = readJsonFile(path.join(mainOutputDir, "longmemeval-mini.json"));
const locomoReport = readJsonFile(path.join(mainOutputDir, "locomo-mini.json"));
const curatedIds = jsonlIds("curated-gmos.jsonl");
const budgetIds = jsonlIds("budget-drop-mini.jsonl");

for (const id of [
  "native-history-recall",
  "native-current-status",
  "native-historical-status",
  "native-current-contact-suppresses-history",
  "native-speaker-alex-tool",
  "native-speaker-blair-tool",
  "native-speaker-prefixed-first-person-alex",
  "native-speaker-prefixed-first-person-blair",
  "native-speaker-prefixed-compare-alex-blair",
  "native-speaker-prefixed-prepare-alex",
  "native-speaker-prefixed-prepare-blair",
  "native-speaker-current-tool",
  "native-speaker-historical-tool",
  "native-non-speaker-colon-first-person",
  "native-speaker-possessive-tool",
  "native-speaker-possessive-attribute",
  "native-speaker-direct-attribute",
  "native-speaker-origin-location",
  "native-speaker-birthdate",
  "native-speaker-relation-name",
  "native-temporal-current-deadline",
  "native-temporal-history-deadline",
  "native-incognito-filter",
  "native-secret-like-message-filter",
  "native-sensitive-memory-filter",
  "native-sensitive-memory-prepare-filter",
  "native-task-trajectory-reuse",
  "native-forbidden-action-boundary",
  "native-forget-residue",
  "native-forget-natural-language",
  "native-forget-token-boundary",
  "native-forget-chinese-compact",
]) {
  if (!curatedIds.has(id)) failures.push(`missing curated fixture ${id}`);
}
if (!budgetIds.has("native-budget-drop-critical-retention")) {
  failures.push("missing budget-drop fixture native-budget-drop-critical-retention");
}

if (!gmosRun || gmosRun.caseCount !== 41 || gmosRun.pass !== true) {
  failures.push("curated-gmos run did not pass 41 cases");
}
if (!budgetRun || budgetRun.caseCount !== 1 || budgetRun.pass !== true) {
  failures.push("budget-drop-mini run did not pass 1 case");
}
if (
  !longMemEvalRun ||
  longMemEvalRun.caseCount !== 1 ||
  longMemEvalRun.pass !== true ||
  !longMemEvalRun.warnings?.includes("skipped_longmemeval_abstention:lme-mini-abstention_abs")
) {
  failures.push("longmemeval-mini run did not pass with abstention warning");
}
if (
  !runSlicePassed(longMemEvalRun, "longmemeval:has_question_date", 1) ||
  !runSlicePassed(longMemEvalRun, "longmemeval:multi_session", 1)
) {
  failures.push("longmemeval-mini missing required slice scores");
}
const longMemEvalCase = caseById(longMemEvalReport, "lme-mini-vega-next-step");
if (
  !longMemEvalCase?.pass ||
  !matched(longMemEvalCase, "rollback matrix") ||
  !hasDiagnostics(longMemEvalCase) ||
  longMemEvalCase.diagnostics.evidenceConvergenceReached !== true ||
  longMemEvalCase.forbiddenMatches?.length !== 0
) {
  failures.push("longmemeval-mini missing per-case match or diagnostics");
}
if (
  !locomoRun ||
  locomoRun.caseCount !== 8 ||
  locomoRun.pass !== true ||
  locomoRun.reusedProfileCaseCount < 1 ||
  !locomoRun.warnings?.includes("skipped_locomo_unscored_qa:locomo-mini-atlas:qa-3")
) {
  failures.push("locomo-mini run did not pass 8 cases with profile reuse and unscored warning");
}
if (
  !runSlicePassed(locomoRun, "locomo:evidence_backed", 8) ||
  !runSlicePassed(locomoRun, "locomo:has_adversarial_answer", 6) ||
  !runSlicePassed(locomoRun, "locomo:speaker_grounding", 6)
) {
  failures.push("locomo-mini missing required slice scores");
}
const locomoUncertainty = locomoReport.summary?.uncertaintyLevels ?? {};
const locomoConvergence = locomoReport.summary?.evidenceConvergence ?? {};
const locomoUncertaintyCount =
  (locomoUncertainty.low ?? 0) +
  (locomoUncertainty.medium ?? 0) +
  (locomoUncertainty.high ?? 0) +
  (locomoUncertainty.unknown ?? 0);
const locomoConvergenceCount =
  (locomoConvergence.reached ?? 0) +
  (locomoConvergence.notReached ?? 0) +
  (locomoConvergence.unknown ?? 0);
if (locomoUncertaintyCount !== 8 || locomoConvergenceCount !== 8) {
  failures.push("locomo-mini missing summary diagnostics");
}
for (const [id, expected] of [
  ["locomo-mini-atlas:qa-1", "evidence chain"],
  ["locomo-mini-atlas:qa-2", "2022"],
  ["locomo-mini-relative-date:qa-1", "7 May 2023"],
  ["locomo-mini-speaker-grounding:qa-1", "Meridian"],
  ["locomo-mini-speaker-grounding:qa-2", "architect"],
  ["locomo-mini-speaker-tool-use:qa-1", "Chronos"],
  ["locomo-mini-speaker-tool-use:qa-2", "BudgetBee"],
  ["locomo-mini-speaker-tool-use:qa-3", "Meridian"],
]) {
  const locomoCase = caseById(locomoReport, id);
  if (
    !locomoCase?.pass ||
    !matched(locomoCase, expected) ||
    !hasDiagnostics(locomoCase) ||
    locomoCase.forbiddenMatches?.length !== 0
  ) {
    failures.push(`locomo-mini missing per-case match or diagnostics for ${id}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`External fixture gate failed: ${failures.join("; ")}\n`);
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(1);
}

const failureTmp = mkdtempSync(path.join(os.tmpdir(), "gmos-external-failure-"));
try {
  const failingJsonl = path.join(failureTmp, "failing.jsonl");
  const failingSuite = path.join(failureTmp, "suite.json");
  const outputDir = path.join(failureTmp, "reports");
  const suiteJson = path.join(failureTmp, "suite-summary.json");
  const suiteMarkdown = path.join(failureTmp, "suite-summary.md");
  writeFileSync(
    failingJsonl,
    [
      {
        id: "fixture-failure-report",
        events: [{ type: "memory", kind: "fact", content: "Visible fixture answer is Alpha." }],
        question: "What is visible?",
        expectedAll: ["Missing Alpha"],
      },
      {
        id: "fixture-normalization-report",
        events: [{ type: "memory", kind: "fact", content: "Visible fixture answer is Alpha-Beta." }],
        question: "What is visible?",
        expectedAll: ["Alpha Beta"],
      },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  writeFileSync(
    failingSuite,
    JSON.stringify({
      schema: "gmos.external_benchmark_suite.v1",
      defaults: { failureSampleLimit: 2 },
      runs: [{ id: "failing-report", inputFile: path.basename(failingJsonl), datasetFormat: "gmos" }],
    }),
  );
  const failingResult = runCli([
    "gym",
    "external-suite",
    "--suite-file",
    failingSuite,
    "--output-dir",
    outputDir,
    "--json-file",
    suiteJson,
    "--markdown-file",
    suiteMarkdown,
    "--format",
    "json",
  ]);
  if (failingResult.status !== 0) {
    process.stderr.write(failingResult.stderr);
    process.stderr.write(failingResult.stdout);
    failures.push(`failure smoke command exited ${failingResult.status ?? 1}`);
  } else {
    const failingReport = JSON.parse(failingResult.stdout);
    const perRunReport = JSON.parse(readFileSync(path.join(outputDir, "failing-report.json"), "utf8"));
    const markdown = readFileSync(path.join(outputDir, "failing-report.md"), "utf8");
    const suiteMarkdownText = readFileSync(suiteMarkdown, "utf8");
    if (failingReport.benchmarkPass !== false) failures.push("failure smoke benchmarkPass was not false");
    if (!failingReport.totalFailureStages?.some((entry) => entry.name === "answer_not_in_input" && entry.count === 1)) {
      failures.push("failure smoke missing answer_not_in_input stage");
    }
    if (!failingReport.totalFailureStages?.some((entry) => entry.name === "answer_normalization_mismatch" && entry.count === 1)) {
      failures.push("failure smoke missing answer_normalization_mismatch stage");
    }
    if (perRunReport.summary?.failureSamples?.[0]?.id !== "fixture-failure-report") {
      failures.push("failure smoke missing per-run failure sample");
    }
    if (
      !/## Failure Samples/.test(markdown) ||
      !/answer_not_in_input/.test(markdown) ||
      !/answer_normalization_mismatch/.test(markdown)
    ) {
      failures.push("failure smoke markdown missing failure sample details");
    }
    if (
      !/BenchmarkStatus: FAIL/.test(suiteMarkdownText) ||
      !/answer_normalization_mismatch/.test(suiteMarkdownText)
    ) {
      failures.push("failure smoke suite markdown missing failed benchmark status or normalization stage");
    }
  }
} finally {
  rmSync(failureTmp, { recursive: true, force: true });
}

if (failures.length > 0) {
  process.stderr.write(`External fixture gate failed: ${failures.join("; ")}\n`);
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(1);
}

process.stdout.write(
  `External fixture gate passed: ${report.totalPassedCount}/${report.totalCaseCount} cases across ${report.runCount} runs\n`,
);
