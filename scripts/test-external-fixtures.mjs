import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const suiteFile = path.join(root, "test", "fixtures", "external-benchmark", "suite.json");
const cliFile = path.join(root, "dist", "cli", "gmos.js");

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
if (report.runCount !== 3) failures.push(`runCount=${report.runCount}`);
if (report.totalCaseCount !== 23) failures.push(`totalCaseCount=${report.totalCaseCount}`);
if (report.totalPassedCount !== 23) failures.push(`totalPassedCount=${report.totalPassedCount}`);
if (report.totalFailedCount !== 0) failures.push(`totalFailedCount=${report.totalFailedCount}`);
if (report.scoreWeighted !== 1) failures.push(`scoreWeighted=${report.scoreWeighted}`);

const runs = new Map((report.runs ?? []).map((run) => [run.id, run]));
const gmosRun = runs.get("curated-gmos");
const longMemEvalRun = runs.get("longmemeval-mini");
const locomoRun = runs.get("locomo-mini");

if (!gmosRun || gmosRun.caseCount !== 20 || gmosRun.pass !== true) {
  failures.push("curated-gmos run did not pass 20 cases");
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
  locomoRun.caseCount !== 2 ||
  locomoRun.pass !== true ||
  locomoRun.reusedProfileCaseCount < 1 ||
  !locomoRun.warnings?.includes("skipped_locomo_unscored_qa:locomo-mini-atlas:qa-3")
) {
  failures.push("locomo-mini run did not pass with profile reuse and unscored warning");
}

if (failures.length > 0) {
  process.stderr.write(`External fixture gate failed: ${failures.join("; ")}\n`);
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(1);
}

process.stdout.write(
  `External fixture gate passed: ${report.totalPassedCount}/${report.totalCaseCount} cases across ${report.runCount} runs\n`,
);
