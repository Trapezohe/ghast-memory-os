import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

const result = spawnSync(
  process.execPath,
  [
    cliFile,
    "gym",
    "external-suite",
    "--suite-file",
    suiteFile,
    "--fail-on-benchmark-fail",
    "--format",
    "json",
  ],
  {
    cwd: root,
    encoding: "utf8",
  },
);

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
if (report.totalCaseCount !== 37) failures.push(`totalCaseCount=${report.totalCaseCount}`);
if (report.totalPassedCount !== 37) failures.push(`totalPassedCount=${report.totalPassedCount}`);
if (report.totalFailedCount !== 0) failures.push(`totalFailedCount=${report.totalFailedCount}`);
if (report.scoreWeighted !== 1) failures.push(`scoreWeighted=${report.scoreWeighted}`);

const runs = new Map((report.runs ?? []).map((run) => [run.id, run]));
const gmosRun = runs.get("curated-gmos");
const budgetRun = runs.get("budget-drop-mini");
const longMemEvalRun = runs.get("longmemeval-mini");
const locomoRun = runs.get("locomo-mini");
const curatedIds = jsonlIds("curated-gmos.jsonl");
const budgetIds = jsonlIds("budget-drop-mini.jsonl");

for (const id of [
  "native-history-recall",
  "native-current-status",
  "native-historical-status",
  "native-speaker-alex-tool",
  "native-speaker-blair-tool",
  "native-speaker-prefixed-first-person-alex",
  "native-speaker-prefixed-first-person-blair",
  "native-speaker-prefixed-prepare-alex",
  "native-speaker-prefixed-prepare-blair",
  "native-non-speaker-colon-first-person",
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

if (!gmosRun || gmosRun.caseCount !== 31 || gmosRun.pass !== true) {
  failures.push("curated-gmos run did not pass 31 cases");
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
  !locomoRun ||
  locomoRun.caseCount !== 4 ||
  locomoRun.pass !== true ||
  locomoRun.reusedProfileCaseCount < 1 ||
  !locomoRun.warnings?.includes("skipped_locomo_unscored_qa:locomo-mini-atlas:qa-3")
) {
  failures.push("locomo-mini run did not pass 4 cases with profile reuse and unscored warning");
}

if (failures.length > 0) {
  process.stderr.write(`External fixture gate failed: ${failures.join("; ")}\n`);
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(1);
}

process.stdout.write(
  `External fixture gate passed: ${report.totalPassedCount}/${report.totalCaseCount} cases across ${report.runCount} runs\n`,
);
