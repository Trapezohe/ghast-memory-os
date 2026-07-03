import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const snapshotFile = path.join(root, "docs", "openapi.json");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const pyproject = readFileSync(path.join(root, "python", "pyproject.toml"), "utf8");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function normalizedJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const openapi = spawnSync(
  process.execPath,
  ["--import", "tsx", "src/cli/gmos.ts", "http", "openapi"],
  { cwd: root, encoding: "utf8" },
);
if (openapi.status !== 0) {
  fail(`OpenAPI generation failed:\n${openapi.stderr}`);
}

const generated = JSON.parse(openapi.stdout);
const snapshot = JSON.parse(readFileSync(snapshotFile, "utf8"));
if (normalizedJson(generated) !== normalizedJson(snapshot)) {
  fail(`docs/openapi.json is stale. Regenerate it with: node --import tsx src/cli/gmos.ts http openapi > docs/openapi.json`);
}

const versionMatch = pyproject.match(/^version = "([^"]+)"$/mu);
if (!versionMatch) fail("python/pyproject.toml is missing a project version");
if (versionMatch[1] !== packageJson.version) {
  fail(`python/pyproject.toml version ${versionMatch[1]} does not match package.json ${packageJson.version}`);
}

const pythonVersion = spawnSync("python3", ["--version"], { cwd: root, encoding: "utf8" });
if (pythonVersion.error?.code === "ENOENT") {
  console.log("python3 not found; skipping python unittest");
  process.exit(0);
}
if (pythonVersion.status !== 0) {
  fail(`python3 --version failed:\n${pythonVersion.stderr}`);
}

const unittest = spawnSync(
  "python3",
  ["-m", "unittest", "discover", "-s", "python/tests"],
  { cwd: root, encoding: "utf8" },
);
if (unittest.status !== 0) {
  fail(`${unittest.stdout}${unittest.stderr}`);
}
process.stdout.write(unittest.stdout);
process.stderr.write(unittest.stderr);
