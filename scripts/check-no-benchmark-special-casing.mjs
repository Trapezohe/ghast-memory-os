import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanRoots = [
  "src/index.ts",
  "src/kernel",
  "src/runtime",
  "src/store",
  "src/mcp",
  "src/http",
  "src/host",
  "src/diagnostics",
  "src/evolution",
];
const forbidden = /longmemeval|locomo|state[-_]?bench|statebench|mem2act|beam|hotpotqa|naturalquestions|qasper|financebench|benchmark|dataset|fixture|case[_-]?id|hidden[_-]?world|scenario/iu;
const fixtureRoot = path.join(root, "test/fixtures/external-benchmark");
const fixtureAnswerKeys = new Set(["expectedAny", "expectedAll", "forbiddenAny", "answer", "adversarial_answer"]);

const selfCheckSamples = [
  "benchmarkPass",
  "external_benchmark",
  "datasetFormat",
  "longmemeval_s_cleaned",
  "locomo10",
  "case_id",
  "hidden_world",
  "scenarioId",
];
if (selfCheckSamples.some((sample) => !forbidden.test(sample))) {
  throw new Error("no-benchmark-special-casing scanner self-check failed");
}

function filesUnder(dir) {
  if (statSync(dir).isFile()) return dir.endsWith(".ts") ? [dir] : [];
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) return filesUnder(fullPath);
    return fullPath.endsWith(".ts") ? [fullPath] : [];
  });
}

function fixtureFilesUnder(dir) {
  if (!existsSync(dir)) return [];
  if (statSync(dir).isFile()) return /\.(?:json|jsonl)$/u.test(dir) ? [dir] : [];
  return readdirSync(dir).flatMap((entry) => fixtureFilesUnder(path.join(dir, entry)));
}

function collectStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  return [];
}

function collectFixtureAnswers(value) {
  if (Array.isArray(value)) return value.flatMap(collectFixtureAnswers);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    fixtureAnswerKeys.has(key) ? collectStrings(child) : collectFixtureAnswers(child),
  );
}

function parseFixtureFile(file) {
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".jsonl")) {
    return text.split(/\r?\n/u).filter(Boolean).flatMap((line) => collectFixtureAnswers(JSON.parse(line)));
  }
  return collectFixtureAnswers(JSON.parse(text));
}

function stableFixtureAnswerTerm(value) {
  const term = value.trim();
  if (term.length < 4) return "";
  if (/^[a-z]+$/u.test(term)) return "";
  return term;
}

if (
  stableFixtureAnswerTerm("Chronos") !== "Chronos" ||
  stableFixtureAnswerTerm("architect") !== "" ||
  stableFixtureAnswerTerm("2022") !== "2022"
) {
  throw new Error("fixture answer scanner self-check failed");
}

const coreFiles = scanRoots.flatMap((relativeRoot) => filesUnder(path.join(root, relativeRoot)));
const findings = coreFiles.flatMap((file) =>
  readFileSync(file, "utf8")
      .split(/\r?\n/u)
      .flatMap((line, index) =>
        forbidden.test(line)
          ? [`${path.relative(root, file)}:${index + 1}: ${line.trim()}`]
          : [],
      ),
);
const fixtureAnswerTerms = [
  ...new Set(fixtureFilesUnder(fixtureRoot).flatMap(parseFixtureFile).map(stableFixtureAnswerTerm).filter(Boolean)),
];
const fixtureAnswerFindings = coreFiles.flatMap((file) =>
  readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .flatMap((line, index) =>
      fixtureAnswerTerms
        .filter((term) => line.includes(term))
        .map((term) => `${path.relative(root, file)}:${index + 1}: hard-coded fixture answer "${term}"`),
    ),
);

if (findings.length > 0 || fixtureAnswerFindings.length > 0) {
  process.stderr.write(
    `Benchmark special-casing terms are not allowed in core runtime paths:\n${[...findings, ...fixtureAnswerFindings].join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write("[gmos] no benchmark special-casing scan passed\n");
