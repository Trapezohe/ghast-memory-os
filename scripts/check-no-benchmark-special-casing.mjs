import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreRuntimeScanRoots = [
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
const benchmarkSurfaceScanRoots = [
  "src/cli/gmos.ts",
  "src/gym/external-adapters.ts",
  "src/gym/external.ts",
  "src/gym/external-suite.ts",
  "src/gym/state-bench.ts",
  "scripts/create-release-evidence.mjs",
  "examples",
];
const publicExampleScanRoots = [
  "README.md",
  "docs/API_REFERENCE.md",
  "docs/INTEGRATION_GUIDE.md",
  "src/cli/gmos.ts",
  "scripts/create-release-evidence.mjs",
  "examples",
];
const benchmarkSurfaceExcludes = new Set([
  "examples/external-mini-fixture.jsonl",
  "examples/external-mini-benchmark.mjs",
]);
const forbidden = /longmemeval|locomo|state[-_]?bench|statebench|mem2act|beam|hotpotqa|naturalquestions|qasper|financebench|benchmark|dataset|fixture|case[_-]?id|hidden[_-]?world|scenario/iu;
const datasetShortcutPattern =
  /longmemeval_s_cleaned|longmemeval_oracle|locomo10|locomo-mini|lme-mini|curated-gmos|budget-drop-mini|native-[a-z0-9_-]+/iu;
const fixtureScanRoots = [
  path.join(root, "test/fixtures/external-benchmark"),
  path.join(root, "examples/external-mini-fixture.jsonl"),
];
const fixtureAnswerKeys = new Set(["expectedAny", "expectedAll", "forbiddenAny", "answer", "adversarial_answer"]);
const fixtureIdentifierKeys = new Set([
  "id",
  "sample_id",
  "question_id",
  "inputFile",
]);

const selfCheckSamples = [
  "benchmarkPass",
  "external_benchmark",
  "datasetFormat",
  "longmemeval_s_cleaned",
  "locomo10",
  "case_id",
  "hidden_world",
  "scenarioId",
  "native-project-next-step",
];
if (selfCheckSamples.some((sample) => !forbidden.test(sample) && !datasetShortcutPattern.test(sample))) {
  throw new Error("no-benchmark-special-casing scanner self-check failed");
}

function filesUnder(dir) {
  if (statSync(dir).isFile()) return /\.(?:ts|js|mjs|json|jsonl|md)$/u.test(dir) ? [dir] : [];
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) return filesUnder(fullPath);
    return /\.(?:ts|js|mjs|json|jsonl|md)$/u.test(fullPath) ? [fullPath] : [];
  });
}

function fixtureFilesUnder(dir) {
  if (!existsSync(dir)) return [];
  if (statSync(dir).isFile()) return /\.(?:json|jsonl)$/u.test(dir) ? [dir] : [];
  return readdirSync(dir).flatMap((entry) => fixtureFilesUnder(path.join(dir, entry)));
}

const fixtureFiles = fixtureScanRoots.flatMap(fixtureFilesUnder);
const fixtureRelativeFiles = new Set(fixtureFiles.map(relative));
for (const expectedFixtureFile of [
  "examples/external-mini-fixture.jsonl",
  "test/fixtures/external-benchmark/curated-gmos.jsonl",
]) {
  if (!fixtureRelativeFiles.has(expectedFixtureFile)) {
    throw new Error(`fixture scanner did not include ${expectedFixtureFile}`);
  }
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

function collectFixtureIdentifiers(value) {
  if (Array.isArray(value)) return value.flatMap(collectFixtureIdentifiers);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    fixtureIdentifierKeys.has(key) ? collectStrings(child) : collectFixtureIdentifiers(child),
  );
}

function parseFixtureFile(file) {
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".jsonl")) {
    return text.split(/\r?\n/u).filter(Boolean).flatMap((line) => collectFixtureAnswers(JSON.parse(line)));
  }
  return collectFixtureAnswers(JSON.parse(text));
}

function parseFixtureIdentifiers(file) {
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".jsonl")) {
    return text.split(/\r?\n/u).filter(Boolean).flatMap((line) => collectFixtureIdentifiers(JSON.parse(line)));
  }
  return collectFixtureIdentifiers(JSON.parse(text));
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

function uniqueFiles(files) {
  return [...new Set(files.map((file) => path.resolve(file)))];
}

function relative(file) {
  return path.relative(root, file).replace(/\\/gu, "/");
}

const coreFiles = uniqueFiles(
  coreRuntimeScanRoots.flatMap((relativeRoot) => filesUnder(path.join(root, relativeRoot))),
).filter((file) => file.endsWith(".ts"));
const benchmarkSurfaceFiles = uniqueFiles(
  benchmarkSurfaceScanRoots.flatMap((relativeRoot) => filesUnder(path.join(root, relativeRoot))),
).filter((file) => !benchmarkSurfaceExcludes.has(relative(file)));
const publicExampleFiles = uniqueFiles(
  publicExampleScanRoots.flatMap((relativeRoot) => filesUnder(path.join(root, relativeRoot))),
).filter((file) => !benchmarkSurfaceExcludes.has(relative(file)));
const publicExampleRelativeFiles = new Set(publicExampleFiles.map(relative));
for (const expectedPublicExampleFile of [
  "README.md",
  "docs/API_REFERENCE.md",
  "docs/INTEGRATION_GUIDE.md",
]) {
  if (!publicExampleRelativeFiles.has(expectedPublicExampleFile)) {
    throw new Error(`public example scanner did not include ${expectedPublicExampleFile}`);
  }
}

const findings = coreFiles.flatMap((file) =>
  readFileSync(file, "utf8")
      .split(/\r?\n/u)
      .flatMap((line, index) =>
        forbidden.test(line)
          ? [`${relative(file)}:${index + 1}: ${line.trim()}`]
          : [],
      ),
);
const fixtureAnswerTerms = [
  ...new Set(fixtureFiles.flatMap(parseFixtureFile).map(stableFixtureAnswerTerm).filter(Boolean)),
];
const fixtureIdentifierTerms = [
  ...new Set(
    fixtureFiles
      .flatMap(parseFixtureIdentifiers)
      .map(stableFixtureAnswerTerm)
      .filter(Boolean),
  ),
];
const guardedSurfaceTerms = [...new Set([...fixtureAnswerTerms, ...fixtureIdentifierTerms])];
for (const expectedGuardedFixtureTerm of [
  "venue booking",
  "external-mini-project-next-step",
]) {
  if (!guardedSurfaceTerms.includes(expectedGuardedFixtureTerm)) {
    throw new Error(`fixture scanner did not guard ${expectedGuardedFixtureTerm}`);
  }
}
const fixtureAnswerFindings = coreFiles.flatMap((file) =>
  readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .flatMap((line, index) =>
      fixtureAnswerTerms
        .filter((term) => line.includes(term))
        .map((term) => `${relative(file)}:${index + 1}: hard-coded fixture answer "${term}"`),
    ),
);
const benchmarkSurfaceFindings = benchmarkSurfaceFiles.flatMap((file) =>
  readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .flatMap((line, index) =>
      [
        ...guardedSurfaceTerms
          .filter((term) => line.includes(term))
          .map((term) => `${relative(file)}:${index + 1}: fixture term "${term}"`),
        ...(datasetShortcutPattern.test(line)
          ? [`${relative(file)}:${index + 1}: dataset shortcut "${line.trim()}"`]
          : []),
      ],
    ),
);
const publicExampleFindings = publicExampleFiles.flatMap((file) =>
  readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .flatMap((line, index) =>
      guardedSurfaceTerms
        .filter((term) => line.includes(term))
        .map((term) => `${relative(file)}:${index + 1}: public example fixture term "${term}"`),
    ),
);

if (
  findings.length > 0 ||
  fixtureAnswerFindings.length > 0 ||
  benchmarkSurfaceFindings.length > 0 ||
  publicExampleFindings.length > 0
) {
  process.stderr.write(
    `Benchmark special-casing terms are not allowed in runtime or public benchmark integration paths:\n${[
      ...findings,
      ...fixtureAnswerFindings,
      ...benchmarkSurfaceFindings,
      ...publicExampleFindings,
    ].join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write("[gmos] no benchmark special-casing scan passed\n");
