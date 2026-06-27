import { readdirSync, readFileSync, statSync } from "node:fs";
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

const findings = scanRoots.flatMap((relativeRoot) =>
  filesUnder(path.join(root, relativeRoot)).flatMap((file) =>
    readFileSync(file, "utf8")
      .split(/\r?\n/u)
      .flatMap((line, index) =>
        forbidden.test(line)
          ? [`${path.relative(root, file)}:${index + 1}: ${line.trim()}`]
          : [],
      ),
  ),
);

if (findings.length > 0) {
  process.stderr.write(
    `Benchmark special-casing terms are not allowed in core runtime paths:\n${findings.join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write("[gmos] no benchmark special-casing scan passed\n");
