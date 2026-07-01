#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const nodeBin = process.execPath;

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function has(name) {
  return process.argv.includes(name);
}

function run(command, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_cache: options.npmCacheDir ?? process.env.npm_config_cache,
      npm_config_prefer_offline: "true",
      ...options.env,
    },
    shell:
      options.shell ??
      (process.platform === "win32" && /\.cmd$/iu.test(command)),
  });
  return {
    command,
    args,
    cwd: options.cwd ?? root,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs: Date.now() - started,
  };
}

function git(args) {
  return run("git", args);
}

function readJson(file) {
  return JSON.parse(readFileSync(path.join(root, file), "utf8"));
}

function compactTimestamp(date) {
  return date.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

function inspectGit() {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const sha = git(["rev-parse", "HEAD"]);
  const status = git(["status", "--porcelain"]);
  return {
    branch: branch.status === 0 ? branch.stdout.trim() : "unknown",
    sha: sha.status === 0 ? sha.stdout.trim() : "unknown",
    dirty: status.status !== 0 || status.stdout.trim().length > 0,
    statusPorcelain: status.stdout.trim(),
  };
}

function inspectCiPolicy() {
  const ciFile = path.join(root, ".github", "workflows", "ci.yml");
  if (!existsSync(ciFile)) {
    return {
      workflowFile: ".github/workflows/ci.yml",
      present: false,
      pushTriggerPresent: false,
      pullRequestTriggerPresent: false,
      workflowDispatchPresent: false,
      optInRemoteCi: false,
    };
  }
  const content = readFileSync(ciFile, "utf8");
  const pushTriggerPresent = /^\s*push\s*:/mu.test(content);
  const pullRequestTriggerPresent = /^\s*pull_request\s*:/mu.test(content);
  const workflowDispatchPresent = /^\s*workflow_dispatch\s*:/mu.test(content);
  const labeledOnly = /types:\s*\[labeled\]/u.test(content);
  const labelGated = /run-ci/u.test(content) && /full-ci/u.test(content);
  return {
    workflowFile: ".github/workflows/ci.yml",
    present: true,
    pushTriggerPresent,
    pullRequestTriggerPresent,
    workflowDispatchPresent,
    optInRemoteCi: !pushTriggerPresent && workflowDispatchPresent && labeledOnly && labelGated,
  };
}

function writeCommandLogs(logDir, name, result) {
  mkdirSync(logDir, { recursive: true });
  const safeName = name.replace(/[^a-z0-9_.-]+/giu, "-");
  writeFileSync(path.join(logDir, `${safeName}.stdout.log`), result.stdout);
  writeFileSync(path.join(logDir, `${safeName}.stderr.log`), result.stderr);
  return {
    stdoutLog: path.relative(root, path.join(logDir, `${safeName}.stdout.log`)),
    stderrLog: path.relative(root, path.join(logDir, `${safeName}.stderr.log`)),
  };
}

function commandForDisplay(command, args) {
  return [command, ...args].join(" ");
}

function statusForResult(result) {
  return result.status === 0 ? "pass" : "fail";
}

function latestTarball(packDir) {
  const entries = readdirSync(packDir)
    .filter((entry) => entry.endsWith(".tgz"))
    .map((entry) => path.join(packDir, entry));
  if (entries.length !== 1) {
    throw new Error(`expected exactly one tarball in ${packDir}, found ${entries.length}`);
  }
  return entries[0];
}

function renderSummary(manifest) {
  const checks = manifest.checks
    .map(
      (check) =>
        `| ${check.name} | ${check.status} | ${check.command ?? check.reason ?? "n/a"} |`,
    )
    .join("\n");
  return [
    "# gmOS Release Evidence",
    "",
    `Package: ${manifest.package.name}@${manifest.package.version}`,
    `Git: ${manifest.git.branch} @ ${manifest.git.sha}`,
    `Dirty: ${manifest.git.dirty ? "yes" : "no"}`,
    `Generated at: ${manifest.createdAt}`,
    `Node: ${manifest.runtime.node}`,
    `Platform: ${manifest.runtime.platform}`,
    "",
    "## Checks",
    "",
    "| Check | Status | Command or Reason |",
    "| --- | --- | --- |",
    checks,
    "",
    "## CI Policy",
    "",
    `Push trigger present: ${manifest.ci.pushTriggerPresent ? "yes" : "no"}`,
    `Workflow dispatch present: ${manifest.ci.workflowDispatchPresent ? "yes" : "no"}`,
    `Opt-in remote CI: ${manifest.ci.optInRemoteCi ? "yes" : "no"}`,
    "",
    "## Claim Boundaries",
    "",
    "- This evidence proves local SDK gates and fresh tarball install behavior for this commit.",
    "- Deterministic adapter scores are not official LongMemEval, LoCoMo, STATE-Bench, Mem2ActBench, BEAM, or SOTA scores.",
    "- External benchmark improvements must be explained by general memory capabilities, not fixture-specific runtime branches.",
    "- Remote CI is opt-in in this repository; if a release requires remote matrix evidence, run workflow_dispatch and attach the run URL.",
    "",
    "## Known limitations",
    "",
    "- gmOS remains plaintext local SQLite by design; it does not provide database encryption or cloud custody.",
    "- gmOS does not ship a built-in semantic extractor. Durable semantic memory requires a host-provided structured extractor profile or explicit low-level import.",
    "- Current public external benchmark numbers are weak deterministic baselines, not official leaderboard results.",
    "- STATE-Bench and tool/action benchmark claims require their unchanged official runners and manifests.",
    "- ghast_desktop production replacement should wait for SDK release evidence and app-side E2E adoption proof.",
    "",
  ].join("\n");
}

function failAfterWriting(manifest, outputDir, message) {
  writeFileSync(path.join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(path.join(outputDir, "SUMMARY.md"), renderSummary(manifest));
  throw new Error(message);
}

const packageJson = readJson("package.json");
const createdAt = new Date();
const gitInfo = inspectGit();
const outputDir = path.resolve(
  root,
  option(
    "--output-dir",
    path.join("release-evidence", `${packageJson.version}-${gitInfo.sha.slice(0, 12)}-${compactTimestamp(createdAt)}`),
  ),
);
const dryRun = has("--dry-run");
const allowDirty = has("--allow-dirty");
const skipGate = has("--skip-gate");
const skipFreshInstall = has("--skip-fresh-install");
const logDir = path.join(outputDir, "logs");
const packDir = path.join(outputDir, "pack");
const freshInstallDir = path.join(outputDir, "fresh-install");
const npmCacheDir = path.join(outputDir, ".npm-cache");

mkdirSync(outputDir, { recursive: true });

const manifest = {
  schema: "gmos.release_evidence.v1",
  createdAt: createdAt.toISOString(),
  package: {
    name: packageJson.name,
    version: packageJson.version,
  },
  git: {
    branch: gitInfo.branch,
    sha: gitInfo.sha,
    dirty: gitInfo.dirty,
  },
  runtime: {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
  },
  ci: inspectCiPolicy(),
  options: {
    dryRun,
    allowDirty,
    skipGate,
    skipFreshInstall,
  },
  artifacts: {
    outputDir: path.relative(root, outputDir),
    manifestFile: path.relative(root, path.join(outputDir, "manifest.json")),
    summaryFile: path.relative(root, path.join(outputDir, "SUMMARY.md")),
    logsDir: path.relative(root, logDir),
  },
  checks: [],
  claimBoundaries: {
    deterministicAdapterIsOfficialScore: false,
    sotaClaimAllowed: false,
    benchmarkSpecialCasingAllowed: false,
    requiresOfficialRunnerForOfficialClaims: true,
  },
};

if ((skipGate || skipFreshInstall) && !dryRun && !allowDirty) {
  failAfterWriting(
    manifest,
    outputDir,
    "release evidence cannot skip pr_gate or fresh_install_smoke unless this is an explicit diagnostic run with --dry-run or --allow-dirty",
  );
}

if (gitInfo.dirty && !allowDirty) {
  failAfterWriting(
    manifest,
    outputDir,
    "worktree is dirty; commit or stash changes before creating release evidence, or pass --allow-dirty for a non-release dry run",
  );
}

function recordSkipped(name, reason) {
  manifest.checks.push({ name, status: "skipped", reason });
}

function recordCommand(name, command, args, options = {}) {
  if (dryRun) {
    recordSkipped(name, "dry-run");
    return null;
  }
  const result = run(command, args, {
    cwd: options.cwd,
    npmCacheDir,
    env: options.env,
  });
  const logs = writeCommandLogs(logDir, name, result);
  const check = {
    name,
    status: statusForResult(result),
    command: commandForDisplay(command, args),
    cwd: path.relative(root, result.cwd) || ".",
    durationMs: result.durationMs,
    exitStatus: result.status,
    signal: result.signal,
    ...logs,
  };
  manifest.checks.push(check);
  if (result.status !== 0) {
    failAfterWriting(manifest, outputDir, `${name} failed; see ${logs.stderrLog}`);
  }
  return result;
}

if (skipGate) {
  recordSkipped("pr_gate", "--skip-gate");
} else {
  recordCommand("pr_gate", npmBin, ["run", "gate:pr"]);
}

let tarballPath = null;
if (dryRun) {
  recordSkipped("pack_tarball", "dry-run");
} else {
  mkdirSync(packDir, { recursive: true });
  recordCommand("pack_tarball", npmBin, ["pack", "--pack-destination", packDir, "--json"]);
  tarballPath = latestTarball(packDir);
  manifest.artifacts.tarball = path.relative(root, tarballPath);
}

if (skipFreshInstall) {
  recordSkipped("fresh_install_smoke", "--skip-fresh-install");
} else if (dryRun) {
  recordSkipped("fresh_install_smoke", "dry-run");
} else {
  mkdirSync(freshInstallDir, { recursive: true });
  writeFileSync(
    path.join(freshInstallDir, "package.json"),
    JSON.stringify({ name: "gmos-release-evidence-consumer", type: "module", private: true }, null, 2),
  );
  recordCommand("fresh_install_npm_install", npmBin, ["install", tarballPath], {
    cwd: freshInstallDir,
  });
  const smokeFile = path.join(freshInstallDir, "fresh-install-smoke.mjs");
  writeFileSync(
    smokeFile,
    `
      import { strict as assert } from "node:assert";
      import path from "node:path";
      import { createMemoryOS, getGmosRuntimeInfo } from "@ghast/memory";
      import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

      const runtimeInfo = getGmosRuntimeInfo();
      assert.equal(runtimeInfo.trustContract.localFirst, true);
      assert.equal(runtimeInfo.trustContract.encryptedByDefault, false);
      assert.ok(runtimeInfo.publicSurface.mcpTools.includes("memory.prepare_context"));

      const store = createSqliteMemoryStore({ path: path.join(process.cwd(), "consumer.db") });
      const memory = createMemoryOS({ profileId: "fresh-install", store });
      await memory.add({
        profileId: "fresh-install",
        kind: "preference",
        content: "Release note response style: summary first.",
      });
      const prepared = await memory.prepareTurn({
        profileId: "fresh-install",
        messages: [{ role: "user", content: "How should this release note be written?" }],
        includeEvidence: true,
      });
      assert.match(prepared.contextBlock, /summary first/);
      assert.equal(prepared.evidence.length >= 1, true);
      await memory.close();
      console.log(JSON.stringify({ ok: true, package: runtimeInfo.package }));
    `,
  );
  recordCommand("fresh_install_sdk_smoke", nodeBin, [smokeFile], {
    cwd: freshInstallDir,
  });
  const cliBin = path.join(
    freshInstallDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "gmos.cmd" : "gmos",
  );
  recordCommand("fresh_install_cli_smoke", cliBin, ["version", "--format", "json"], {
    cwd: freshInstallDir,
  });
  manifest.artifacts.freshInstallDir = path.relative(root, freshInstallDir);
}

writeFileSync(path.join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2));
writeFileSync(path.join(outputDir, "SUMMARY.md"), renderSummary(manifest));
console.log(JSON.stringify({
  ok: true,
  schema: manifest.schema,
  outputDir: manifest.artifacts.outputDir,
  manifestFile: manifest.artifacts.manifestFile,
  summaryFile: manifest.artifacts.summaryFile,
  checks: manifest.checks.map((check) => ({ name: check.name, status: check.status })),
}, null, 2));
