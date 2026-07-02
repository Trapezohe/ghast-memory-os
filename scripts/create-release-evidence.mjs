#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  inspectGithubActionsTriggerPolicy,
  workflowRequiresRunCiLabel,
} from "./lib/github-actions-trigger-policy.mjs";

const root = path.resolve(import.meta.dirname, "..");
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const nodeBin = process.execPath;
const statusCoreTables = [
  "gmos_memories",
  "gmos_evidence_events",
  "gmos_failure_events",
];

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

if (has("--self-test")) {
  runSelfTest();
  process.exit(0);
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
  const workflowsDir = path.join(root, ".github", "workflows");
  if (!existsSync(workflowsDir)) {
    return {
      workflowFile: ".github/workflows/ci.yml",
      workflowFiles: [],
      workflows: [],
      present: false,
      triggerNames: [],
      pushTriggerPresent: false,
      branchPushTriggerPresent: false,
      pullRequestTriggerPresent: false,
      workflowDispatchPresent: false,
      nonOptInTriggerPresent: false,
      optInRemoteCi: false,
    };
  }
  const workflows = readdirSync(workflowsDir)
    .filter((entry) => /\.ya?ml$/u.test(entry))
    .sort()
    .map((entry) => {
      const workflowFile = path.posix.join(".github/workflows", entry);
      const content = readFileSync(path.join(workflowsDir, entry), "utf8");
      const policy = inspectGithubActionsTriggerPolicy(content);
      const labelGated = workflowRequiresRunCiLabel(content);
      return {
        workflowFile,
        ...policy,
        labelGated,
        optInRemoteCi:
          !policy.nonOptInTriggerPresent &&
          (policy.workflowDispatchPresent || policy.pullRequestTriggerPresent) &&
          (!policy.pullRequestTriggerPresent ||
            (policy.pullRequestLabeledOnly && labelGated)),
      };
    });
  const workflowFiles = workflows.map((workflow) => workflow.workflowFile);
  const workflowFile = workflowFiles.includes(".github/workflows/ci.yml")
    ? ".github/workflows/ci.yml"
    : workflowFiles[0] ?? ".github/workflows/ci.yml";
  const pushTriggerPresent = workflows.some((workflow) => workflow.pushTriggerPresent);
  const pullRequestTriggerPresent = workflows.some((workflow) => workflow.pullRequestTriggerPresent);
  const nonOptInTriggerPresent = workflows.some((workflow) => workflow.nonOptInTriggerPresent);
  return {
    workflowFile,
    workflowFiles,
    workflows,
    present: workflows.length > 0,
    triggerNames: [...new Set(workflows.flatMap((workflow) => workflow.triggerNames ?? []))].sort(),
    pushTriggerPresent,
    branchPushTriggerPresent: workflows.some((workflow) => workflow.branchPushTriggerPresent),
    pullRequestTriggerPresent,
    workflowDispatchPresent: workflows.some((workflow) => workflow.workflowDispatchPresent),
    nonOptInTriggerPresent,
    optInRemoteCi:
      workflows.length > 0 &&
      !nonOptInTriggerPresent &&
      workflows.some((workflow) => workflow.workflowDispatchPresent) &&
      workflows.every((workflow) => workflow.optInRemoteCi),
  };
}

function writeCommandLogs(logDir, name, result, options = {}) {
  mkdirSync(logDir, { recursive: true });
  const safeName = name.replace(/[^a-z0-9_.-]+/giu, "-");
  writeFileSync(
    path.join(logDir, `${safeName}.stdout.log`),
    redactEvidenceText(result.stdout, options.redactValues),
  );
  writeFileSync(
    path.join(logDir, `${safeName}.stderr.log`),
    redactEvidenceText(result.stderr, options.redactValues),
  );
  return {
    stdoutLog: path.relative(root, path.join(logDir, `${safeName}.stdout.log`)),
    stderrLog: path.relative(root, path.join(logDir, `${safeName}.stderr.log`)),
  };
}

function redactEvidenceText(value, extraValues = []) {
  const credentialKey =
    "api[\\s_.-]?key|access[\\s_.-]?token|refresh[\\s_.-]?token|id[\\s_.-]?token|client[\\s_.-]?secret|token|password|secret|auth(?:entication)?(?:[\\s_.-]?token)?|authorization|cookies?|credentials?(?:[\\s_.-]?id)?|session(?:[\\s_.-]?(?:id|token))?";
  let redacted = value
    .replace(/(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}(?=$|[^A-Za-z0-9])/gu, "$1[redacted_secret]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/giu, "Bearer [redacted_secret]")
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, "[redacted_secret]")
    .replace(
      new RegExp(`\\b(${credentialKey})\\b(\\s*["']?\\s*[:=]\\s*)"(?:\\\\.|[^"\\\\])*"`, "giu"),
      '$1$2"[redacted_secret]"',
    )
    .replace(
      new RegExp(`\\b(${credentialKey})\\b(\\s*["']?\\s*[:=]\\s*)'(?:\\\\.|[^'\\\\])*'`, "giu"),
      "$1$2'[redacted_secret]'",
    )
    .replace(
      new RegExp(`\\b(${credentialKey})\\b(\\s*["']?\\s*[:=]\\s*)(?!["'\\[])([^\\s"',}\\]\\)\\[]){8,}`, "giu"),
      "$1$2[redacted_secret]",
    );
  for (const extraValue of extraValues ?? []) {
    if (!extraValue) continue;
    redacted = redacted.split(extraValue).join("[redacted_value]");
    redacted = redacted
      .split(JSON.stringify(extraValue).slice(1, -1))
      .join("[redacted_value]");
  }
  return redacted;
}

function displayCommandPart(value, cwd) {
  if (!path.isAbsolute(value)) return value;
  const rootRelative = path.relative(root, value);
  if (!rootRelative.startsWith("..") && !path.isAbsolute(rootRelative)) {
    return path.relative(cwd, value) || ".";
  }
  return path.basename(value);
}

function commandForDisplay(command, args, cwd = root) {
  return redactEvidenceText([command, ...args].map((part) => displayCommandPart(part, cwd)).join(" "));
}

const redactionSelfCheck = redactEvidenceText(
  '{"token":"abcdefghijkl","ok":true} access_token=abcdefghijkl api_key_sk-redactorsecret1234567890 Bearer abcdefghijkl aaaaaaaaaa.bbbbbbbbbb.cccccccccc',
);
const extraRedactionSelfCheck = redactEvidenceText(
  "plain profile fresh-install and path C:\\Users\\Example\\consumer.db secret sk-releaseevidencequerysecret1234567890",
  ["fresh-install", "C:\\Users\\Example\\consumer.db", "sk-releaseevidencequerysecret"],
);
if (
  redactionSelfCheck.includes("abcdefghijkl") ||
  redactionSelfCheck.includes("sk-redactorsecret") ||
  redactionSelfCheck.includes("aaaaaaaaaa.bbbbbbbbbb.cccccccccc") ||
  !redactionSelfCheck.includes('{"token":"[redacted_secret]","ok":true}') ||
  extraRedactionSelfCheck.includes("fresh-install") ||
  extraRedactionSelfCheck.includes("consumer.db") ||
  extraRedactionSelfCheck.includes("releaseevidencequerysecret") ||
  extraRedactionSelfCheck.includes("1234567890")
) {
  throw new Error("release evidence redaction self-check failed");
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
    `Workflow files: ${manifest.ci.workflowFiles?.length ? manifest.ci.workflowFiles.join(", ") : "none"}`,
    `Trigger names: ${manifest.ci.triggerNames?.length ? manifest.ci.triggerNames.join(", ") : "none"}`,
    `Push trigger present: ${manifest.ci.pushTriggerPresent ? "yes" : "no"}`,
    `Branch push trigger present: ${manifest.ci.branchPushTriggerPresent ? "yes" : "no"}`,
    `Non-opt-in trigger present: ${manifest.ci.nonOptInTriggerPresent ? "yes" : "no"}`,
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
    "- Current public external benchmark numbers are local deterministic baselines, not official leaderboard results.",
    "- STATE-Bench and tool/action benchmark claims require their unchanged official runners and manifests.",
    "",
  ].join("\n");
}

function failAfterWriting(manifest, outputDir, message) {
  recordFreshInstallDatabaseCleanupIfNeeded();
  recordNpmCacheCleanupIfNeeded();
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
const freshInstallDbPath = path.join(freshInstallDir, "consumer.db");
const freshInstallAgentDbPath = path.join(freshInstallDir, "consumer-agent.db");
const freshInstallHostDbPath = path.join(freshInstallDir, "consumer-host.db");
const freshInstallHttpDbPath = path.join(freshInstallDir, "consumer-http.db");
const freshInstallMcpDbPath = path.join(freshInstallDir, "consumer-mcp.db");
const freshInstallEvolutionDbPath = path.join(freshInstallDir, "consumer-evolution.db");
const freshInstallRestoreDbPath = path.join(freshInstallDir, "consumer-restore.db");
const freshInstallBackupPath = path.join(freshInstallDir, "consumer-backup.json");
const freshInstallDbPaths = [
  freshInstallDbPath,
  freshInstallAgentDbPath,
  freshInstallHostDbPath,
  freshInstallHttpDbPath,
  freshInstallMcpDbPath,
  freshInstallEvolutionDbPath,
  freshInstallRestoreDbPath,
];
const freshInstallGeneratedFilePaths = [freshInstallBackupPath];
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

function sameStringSet(actual, expected) {
  return Array.isArray(actual) &&
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function recordSdkSmokeContentSafety(result, forbiddenValues) {
  const check = {
    name: "fresh_install_sdk_content_safety",
    status: "pass",
    command: "validate fresh_install_sdk_smoke stdout",
  };
  try {
    validateSdkSmokeContentSafety(result.stdout, forbiddenValues, packageJson);
  } catch (error) {
    check.status = "fail";
    check.reason = error instanceof Error ? error.message : String(error);
    manifest.checks.push(check);
    failAfterWriting(manifest, outputDir, `${check.name} failed`);
  }
  manifest.checks.push(check);
}

function validateSdkSmokeContentSafety(stdout, forbiddenValues, expectedPackage) {
  const report = JSON.parse(stdout);
  if (
    report.ok !== true ||
    report.package?.name !== expectedPackage.name ||
    report.package?.version !== expectedPackage.version ||
    report.trustContract?.localFirst !== true ||
    report.trustContract?.defaultStorage !== "sqlite" ||
    report.trustContract?.encryptedByDefault !== false ||
    report.trustContract?.cloudRequired !== false ||
    report.mcpPrepareContextAvailable !== true ||
    report.contextInjected !== true ||
    !Number.isInteger(report.evidenceCount) ||
    report.evidenceCount < 1
  ) {
    throw new Error("unexpected SDK smoke report shape");
  }
  for (const [index, value] of forbiddenValues.entries()) {
    if (value && (stdout.includes(value) || stdout.includes(JSON.stringify(value).slice(1, -1)))) {
      throw new Error(`SDK smoke report leaked forbidden value #${index + 1}`);
    }
  }
}

function validateCliVersionContentSafety(stdout, forbiddenValues, expectedPackage) {
  const report = JSON.parse(stdout);
  const expectedBinaries = Object.keys(expectedPackage.bin ?? {});
  const expectedExports = Object.keys(expectedPackage.exports ?? {});
  if (
    report.schema !== "gmos.cli_version.v1" ||
    report.package?.name !== expectedPackage.name ||
    report.package?.version !== expectedPackage.version ||
    !sameStringSet(report.cli?.binaries, expectedBinaries) ||
    !Array.isArray(report.cli?.commands) ||
    !report.cli?.commands?.includes("evolution") ||
    !sameStringSet(report.packageExports, expectedExports) ||
    report.trustContract?.localFirst !== true ||
    report.trustContract?.defaultStorage !== "sqlite" ||
    report.trustContract?.encryptedByDefault !== false ||
    report.trustContract?.cloudRequired !== false
  ) {
    throw new Error("unexpected CLI version report shape");
  }
  for (const [index, value] of forbiddenValues.entries()) {
    if (value && (stdout.includes(value) || stdout.includes(JSON.stringify(value).slice(1, -1)))) {
      throw new Error(`CLI version report leaked forbidden value #${index + 1}`);
    }
  }
}

function recordCliVersionContentSafety(result, forbiddenValues) {
  const check = {
    name: "fresh_install_cli_content_safety",
    status: "pass",
    command: "validate fresh_install_cli_smoke stdout",
  };
  try {
    validateCliVersionContentSafety(result.stdout, forbiddenValues, packageJson);
  } catch (error) {
    check.status = "fail";
    check.reason = error instanceof Error ? error.message : String(error);
    manifest.checks.push(check);
    failAfterWriting(manifest, outputDir, `${check.name} failed`);
  }
  manifest.checks.push(check);
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
  const logs = writeCommandLogs(logDir, name, result, {
    redactValues: options.redactLogValues,
  });
  const check = {
    name,
    status: statusForResult(result),
    command: commandForDisplay(command, args, result.cwd),
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

function recordInspectorContentSafety(result, forbiddenValues) {
  const check = {
    name: "fresh_install_inspect_content_safety",
    status: "pass",
    command: "validate fresh_install_inspect_smoke stdout",
  };
  try {
    validateInspectorContentSafety(result.stdout, forbiddenValues);
  } catch (error) {
    check.status = "fail";
    check.reason = error instanceof Error ? error.message : String(error);
    manifest.checks.push(check);
    failAfterWriting(manifest, outputDir, `${check.name} failed`);
  }
  manifest.checks.push(check);
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function validateCoreRowCounts(rowCounts, label) {
  if (
    !rowCounts ||
    Object.values(rowCounts).some((count) => !nonNegativeInteger(count)) ||
    statusCoreTables.some((table) => !nonNegativeInteger(rowCounts[table]))
  ) {
    throw new Error(`${label} did not include numeric storage row counts`);
  }
}

function validateReadAudit(readAudit, label, options = {}) {
  const auditedTables = readAudit?.auditedTables;
  if (
    !readAudit ||
    readAudit.status !== "ok" ||
    readAudit.schema !== "gmos.read_audit_snapshot.v1" ||
    !nonNegativeInteger(readAudit.rowCountTotal) ||
    !nonNegativeInteger(readAudit.tableCount) ||
    readAudit.tableCount < statusCoreTables.length ||
    !Array.isArray(readAudit.missingTables) ||
    readAudit.missingTables.length !== 0 ||
    readAudit.hashesAvailable !== true ||
    (options.requireAuditedTables &&
      (!Array.isArray(auditedTables) || statusCoreTables.some((table) => !auditedTables.includes(table))))
  ) {
    throw new Error(`${label} did not include healthy read audit`);
  }
}

function validateSearchIndex(searchIndex, label) {
  const vectorIndex = searchIndex?.vectorIndex;
  if (
    !searchIndex ||
    searchIndex.status !== "ok" ||
    !nonNegativeInteger(searchIndex.totalMemoryCount) ||
    !nonNegativeInteger(searchIndex.indexedMemoryCount) ||
    !nonNegativeInteger(searchIndex.activeMemoryCount) ||
    !vectorIndex ||
    vectorIndex.status !== "ok" ||
    !nonNegativeInteger(vectorIndex.indexedMemoryCount)
  ) {
    throw new Error(`${label} did not include healthy search index`);
  }
}

function validateRuntimeLocalFirstContract(runtimeInfo, label) {
  const runtimeTrust = runtimeInfo?.trustContract;
  if (
    runtimeInfo?.schema !== "gmos.runtime_info.v1" ||
    runtimeTrust?.localFirst !== true ||
    runtimeTrust?.defaultStorage !== "sqlite" ||
    runtimeTrust?.encryptedByDefault !== false ||
    runtimeTrust?.cloudRequired !== false
  ) {
    throw new Error(`${label} did not include runtime local-first contract`);
  }
}

function validateInspectorContentSafety(stdout, forbiddenValues) {
  const report = JSON.parse(stdout);
  if (report.schema !== "gmos.inspect_report.v1") {
    throw new Error("unexpected inspector report schema");
  }
  if (report.dbPath !== "[plaintext sqlite path redacted]") {
    throw new Error("inspector report did not redact dbPath");
  }
  if (report.profileId !== "[profile id redacted]") {
    throw new Error("inspector report did not redact profileId");
  }
  const forgetSummary = report.forgetSummary;
  const health = report.health;
  const evidenceSummary = report.evidenceSummary;
  const counts = report.counts;
  if (
    !forgetSummary ||
    !nonNegativeInteger(forgetSummary.archivedMemories) ||
    !nonNegativeInteger(forgetSummary.activeWorldBeliefResidue) ||
    !nonNegativeInteger(forgetSummary.activeAssociationResidue) ||
    !nonNegativeInteger(forgetSummary.derivedResidue) ||
    forgetSummary.derivedResidue !==
      forgetSummary.activeWorldBeliefResidue + forgetSummary.activeAssociationResidue
  ) {
    throw new Error("inspector report did not include numeric forgetSummary");
  }
  if (
    !health ||
    !nonNegativeInteger(health.evidenceEvents) ||
    !nonNegativeInteger(health.memories) ||
    !nonNegativeInteger(health.worldBeliefs) ||
    !nonNegativeInteger(health.associations) ||
    !nonNegativeInteger(health.taskTrajectories) ||
    !nonNegativeInteger(health.failureEvents) ||
    !nonNegativeInteger(health.memoryVectors) ||
    !nonNegativeInteger(health.memoryVectorTerms) ||
    health.evidenceEvents < 1 ||
    health.memories < 1 ||
    health.associations < 1
  ) {
    throw new Error("inspector report did not include numeric health signals");
  }
  if (
    !counts ||
    !nonNegativeInteger(counts.evidence) ||
    !nonNegativeInteger(counts.activeMemories) ||
    !nonNegativeInteger(counts.archivedMemories) ||
    counts.evidence < 1 ||
    counts.activeMemories < 1
  ) {
    throw new Error("inspector report did not include numeric top-level counts");
  }
  if (
    !evidenceSummary ||
    !nonNegativeInteger(evidenceSummary.inspected) ||
    !nonNegativeInteger(evidenceSummary.eligibleForLongTermMemory) ||
    !nonNegativeInteger(evidenceSummary.ineligibleForLongTermMemory) ||
    evidenceSummary.inspected !== counts.evidence ||
    evidenceSummary.inspected !== health.evidenceEvents ||
    evidenceSummary.eligibleForLongTermMemory + evidenceSummary.ineligibleForLongTermMemory !==
      evidenceSummary.inspected
  ) {
    throw new Error("inspector report did not include consistent evidence eligibility summary");
  }
  if (typeof report.query !== "string" || !report.query.includes("[redacted_secret]")) {
    throw new Error("inspector report did not redact secret-like query");
  }
  for (const [index, value] of forbiddenValues.entries()) {
    if (value && (stdout.includes(value) || stdout.includes(JSON.stringify(value).slice(1, -1)))) {
      throw new Error(`inspector report leaked forbidden value #${index + 1}`);
    }
  }
}

function validateStatusContentSafety(stdout, forbiddenValues) {
  const report = JSON.parse(stdout);
  if (report.framework !== "ghast-memory-os") {
    throw new Error("unexpected status report shape");
  }
  if (report.profileId !== "[profile id redacted]") {
    throw new Error("status report did not redact profileId");
  }
  const storage = report.storage;
  if (!storage || storage.status !== "ok" || !nonNegativeInteger(storage.schemaVersion) || storage.schemaVersion < 1) {
    throw new Error("status report did not include healthy storage metadata");
  }
  const rowCounts = storage.rowCounts;
  validateCoreRowCounts(rowCounts, "status report");
  validateReadAudit(storage.readAudit, "status report", { requireAuditedTables: true });
  validateSearchIndex(storage.searchIndex, "status report");
  if (
    !report.failureSummary ||
    report.failureSummary.status !== "ok" ||
    !nonNegativeInteger(report.failureSummary.inspectedFailureCount)
  ) {
    throw new Error("status report did not include healthy failure summary");
  }
  if (
    report.trustContract?.encrypted !== false ||
    report.trustContract?.reportContainsMemoryContent !== false ||
    report.trustContract?.readPathSideEffectsChecked !== true
  ) {
    throw new Error("status report did not expose safe local trust contract");
  }
  validateRuntimeLocalFirstContract(report.runtimeInfo, "status report");
  for (const [index, value] of forbiddenValues.entries()) {
    if (value && (stdout.includes(value) || stdout.includes(JSON.stringify(value).slice(1, -1)))) {
      throw new Error(`status report leaked forbidden value #${index + 1}`);
    }
  }
}

function validateDoctorContentSafety(stdout, forbiddenValues) {
  const report = JSON.parse(stdout);
  if (report.ok !== true || report.encrypted !== false) {
    throw new Error("unexpected doctor report shape");
  }
  if (report.dbPath !== "[plaintext sqlite path redacted]") {
    throw new Error("doctor report did not redact dbPath");
  }
  validateRuntimeLocalFirstContract(report.runtimeInfo, "doctor report");
  if (report.schema?.dialect !== "sqlite" || !nonNegativeInteger(report.schema?.version) || report.schema.version < 1) {
    throw new Error("doctor report did not include sqlite schema metadata");
  }
  validateCoreRowCounts(report.rowCounts, "doctor report");
  validateReadAudit(report.readAudit, "doctor report");
  validateSearchIndex(report.searchIndex, "doctor report");
  if (report.hostCompatibility?.hostId !== "ghast" || report.hostCompatibility?.level !== "L4") {
    throw new Error("doctor report did not include expected ghast host compatibility");
  }
  for (const [index, value] of forbiddenValues.entries()) {
    if (value && (stdout.includes(value) || stdout.includes(JSON.stringify(value).slice(1, -1)))) {
      throw new Error(`doctor report leaked forbidden value #${index + 1}`);
    }
  }
}

function selfTestDoctorReport(overrides = {}) {
  const {
    rowCounts,
    readAudit,
    searchIndex,
    vectorIndex,
    runtimeInfo,
    runtimeTrustContract,
    schema,
    hostCompatibility,
    ...topLevelOverrides
  } = overrides;
  const baseRowCounts = Object.fromEntries(statusCoreTables.map((table) => [table, 1]));
  return JSON.stringify({
    ok: true,
    dbPath: "[plaintext sqlite path redacted]",
    encrypted: false,
    runtimeInfo: {
      schema: "gmos.runtime_info.v1",
      trustContract: {
        localFirst: true,
        defaultStorage: "sqlite",
        encryptedByDefault: false,
        cloudRequired: false,
        ...runtimeTrustContract,
      },
      ...runtimeInfo,
    },
    schema: {
      dialect: "sqlite",
      version: 7,
      ...schema,
    },
    rowCounts: { ...baseRowCounts, ...rowCounts },
    readAudit: {
      status: "ok",
      schema: "gmos.read_audit_snapshot.v1",
      tableCount: statusCoreTables.length,
      rowCountTotal: statusCoreTables.length,
      missingTables: [],
      hashesAvailable: true,
      ...readAudit,
    },
    searchIndex: {
      status: "ok",
      totalMemoryCount: 1,
      indexedMemoryCount: 1,
      activeMemoryCount: 1,
      vectorIndex: {
        status: "ok",
        indexedMemoryCount: 1,
        ...vectorIndex,
      },
      ...searchIndex,
    },
    hostCompatibility: {
      hostId: "ghast",
      level: "L4",
      ...hostCompatibility,
    },
    ...topLevelOverrides,
  });
}

function selfTestStatusReport(overrides = {}) {
  const {
    storage,
    rowCounts,
    readAudit,
    searchIndex,
    vectorIndex,
    failureSummary,
    trustContract,
    runtimeInfo,
    runtimeTrustContract,
    ...topLevelOverrides
  } = overrides;
  const baseRowCounts = Object.fromEntries(statusCoreTables.map((table) => [table, 1]));
  return JSON.stringify({
    framework: "ghast-memory-os",
    profileId: "[profile id redacted]",
    storage:
      storage === null
        ? null
        : {
            status: "ok",
            schemaVersion: 7,
            rowCounts: { ...baseRowCounts, ...rowCounts },
            readAudit: {
              status: "ok",
              schema: "gmos.read_audit_snapshot.v1",
              tableCount: statusCoreTables.length,
              rowCountTotal: statusCoreTables.length,
              auditedTables: statusCoreTables,
              missingTables: [],
              hashesAvailable: true,
              ...readAudit,
            },
            searchIndex: {
              status: "ok",
              totalMemoryCount: 1,
              indexedMemoryCount: 1,
              activeMemoryCount: 1,
              vectorIndex: {
                status: "ok",
                indexedMemoryCount: 1,
                ...vectorIndex,
              },
              ...searchIndex,
            },
            ...storage,
          },
    failureSummary: {
      status: "ok",
      inspectedFailureCount: 0,
      byKind: {},
      ...failureSummary,
    },
    trustContract: {
      encrypted: false,
      reportContainsMemoryContent: false,
      readPathSideEffectsChecked: true,
      ...trustContract,
    },
    runtimeInfo: {
      schema: "gmos.runtime_info.v1",
      trustContract: {
        localFirst: true,
        defaultStorage: "sqlite",
        encryptedByDefault: false,
        cloudRequired: false,
        ...runtimeTrustContract,
      },
      ...runtimeInfo,
    },
    ...topLevelOverrides,
  });
}

function selfTestInspectorReport(overrides = {}) {
  const { counts, health, evidenceSummary, forgetSummary, ...topLevelOverrides } = overrides;
  const base = {
    counts: {
      evidence: 1,
      activeMemories: 1,
      archivedMemories: 0,
    },
    health: {
      evidenceEvents: 1,
      memories: 1,
      worldBeliefs: 0,
      associations: 1,
      taskTrajectories: 0,
      failureEvents: 0,
      memoryVectors: 1,
      memoryVectorTerms: 1,
    },
    evidenceSummary: {
      inspected: 1,
      eligibleForLongTermMemory: 1,
      ineligibleForLongTermMemory: 0,
    },
    forgetSummary: {
      archivedMemories: 0,
      activeWorldBeliefResidue: 0,
      activeAssociationResidue: 0,
      derivedResidue: 0,
    },
  };
  return JSON.stringify({
    schema: "gmos.inspect_report.v1",
    profileId: "[profile id redacted]",
    dbPath: "[plaintext sqlite path redacted]",
    query: "release note api key: [redacted_secret]",
    counts: { ...base.counts, ...counts },
    health: { ...base.health, ...health },
    evidenceSummary: { ...base.evidenceSummary, ...evidenceSummary },
    forgetSummary: { ...base.forgetSummary, ...forgetSummary },
    ...topLevelOverrides,
  });
}

function selfTestSdkSmokeReport(expectedPackage, overrides = {}) {
  const { pkg, trustContract, ...topLevelOverrides } = overrides;
  return JSON.stringify({
    ok: true,
    package: {
      name: expectedPackage.name,
      version: expectedPackage.version,
      ...pkg,
    },
    trustContract: {
      localFirst: true,
      defaultStorage: "sqlite",
      encryptedByDefault: false,
      cloudRequired: false,
      ...trustContract,
    },
    mcpPrepareContextAvailable: true,
    contextInjected: true,
    evidenceCount: 1,
    ...topLevelOverrides,
  });
}

function expectSdkSmokeValidationFailure(name, stdout, expectedPackage) {
  try {
    validateSdkSmokeContentSafety(stdout, ["secret-value"], expectedPackage);
  } catch {
    return;
  }
  throw new Error(`${name} unexpectedly passed`);
}

function expectInspectorValidationFailure(name, stdout) {
  try {
    validateInspectorContentSafety(stdout, ["secret-value"]);
  } catch {
    return;
  }
  throw new Error(`${name} unexpectedly passed`);
}

function expectStatusValidationFailure(name, stdout) {
  try {
    validateStatusContentSafety(stdout, ["secret-value"]);
  } catch {
    return;
  }
  throw new Error(`${name} unexpectedly passed`);
}

function expectDoctorValidationFailure(name, stdout) {
  try {
    validateDoctorContentSafety(stdout, ["secret-value"]);
  } catch {
    return;
  }
  throw new Error(`${name} unexpectedly passed`);
}

function selfTestCliVersionReport(expectedPackage, overrides = {}) {
  const { pkg, cli, trustContract, ...topLevelOverrides } = overrides;
  return JSON.stringify({
    schema: "gmos.cli_version.v1",
    package: {
      name: expectedPackage.name,
      version: expectedPackage.version,
      ...pkg,
    },
    cli: {
      binaries: Object.keys(expectedPackage.bin ?? {}),
      commands: ["evolution"],
      ...cli,
    },
    packageExports: Object.keys(expectedPackage.exports ?? {}),
    trustContract: {
      localFirst: true,
      defaultStorage: "sqlite",
      encryptedByDefault: false,
      cloudRequired: false,
      ...trustContract,
    },
    ...topLevelOverrides,
  });
}

function expectCliVersionValidationFailure(name, stdout, expectedPackage) {
  try {
    validateCliVersionContentSafety(stdout, ["consumer.db"], expectedPackage);
  } catch {
    return;
  }
  throw new Error(`${name} unexpectedly passed`);
}

function expectFailureKindsValidationFailure(name, report) {
  if (!hasExactFailureKinds(report)) return;
  throw new Error(`${name} unexpectedly passed`);
}

function expectEvolutionFailureKindsValidationFailure(name, report) {
  if (!hasExactEvolutionFailureKinds(report)) return;
  throw new Error(`${name} unexpectedly passed`);
}

function runSelfTest() {
  const expectedPackage = readJson("package.json");
  validateSdkSmokeContentSafety(selfTestSdkSmokeReport(expectedPackage), ["secret-value"], expectedPackage);
  validateInspectorContentSafety(selfTestInspectorReport(), ["secret-value"]);
  validateDoctorContentSafety(selfTestDoctorReport(), ["secret-value"]);
  validateStatusContentSafety(selfTestStatusReport(), ["secret-value"]);
  validateCliVersionContentSafety(selfTestCliVersionReport(expectedPackage), ["consumer.db"], expectedPackage);
  expectSdkSmokeValidationFailure(
    "missing SDK trust contract",
    selfTestSdkSmokeReport(expectedPackage, { trustContract: { localFirst: undefined } }),
    expectedPackage,
  );
  expectSdkSmokeValidationFailure(
    "SDK cloud requirement",
    selfTestSdkSmokeReport(expectedPackage, { trustContract: { cloudRequired: true } }),
    expectedPackage,
  );
  expectSdkSmokeValidationFailure(
    "SDK non-sqlite default storage",
    selfTestSdkSmokeReport(expectedPackage, { trustContract: { defaultStorage: "cloud" } }),
    expectedPackage,
  );
  expectSdkSmokeValidationFailure(
    "SDK encrypted by default",
    selfTestSdkSmokeReport(expectedPackage, { trustContract: { encryptedByDefault: true } }),
    expectedPackage,
  );
  expectSdkSmokeValidationFailure(
    "SDK missing MCP prepare context",
    selfTestSdkSmokeReport(expectedPackage, { mcpPrepareContextAvailable: false }),
    expectedPackage,
  );
  expectSdkSmokeValidationFailure(
    "SDK missing context injection",
    selfTestSdkSmokeReport(expectedPackage, { contextInjected: false }),
    expectedPackage,
  );
  expectSdkSmokeValidationFailure(
    "SDK empty evidence",
    selfTestSdkSmokeReport(expectedPackage, { evidenceCount: 0 }),
    expectedPackage,
  );
  expectSdkSmokeValidationFailure(
    "forbidden SDK smoke value",
    selfTestSdkSmokeReport(expectedPackage, { diagnostics: "secret-value" }),
    expectedPackage,
  );
  if (
    !hasExactFailureKinds({
      failureEvents: 2,
      failureKinds: ["controller_route_error", "wrong_recall"],
    })
  ) {
    throw new Error("exact failure kind report unexpectedly failed");
  }
  expectFailureKindsValidationFailure("missing failure kind", {
    failureEvents: 2,
    failureKinds: ["controller_route_error"],
  });
  expectFailureKindsValidationFailure("extra failure kind", {
    failureEvents: 2,
    failureKinds: ["controller_route_error", "privacy_leak", "wrong_recall"],
  });
  expectFailureKindsValidationFailure("reordered failure kind", {
    failureEvents: 2,
    failureKinds: ["wrong_recall", "controller_route_error"],
  });
  expectFailureKindsValidationFailure("wrong failure event count", {
    failureEvents: 3,
    failureKinds: ["controller_route_error", "wrong_recall"],
  });
  if (
    !hasExactEvolutionFailureKinds({
      sdkClusterCount: 2,
      sdkFailureKinds: ["privacy_leak", "wrong_recall"],
      cliInspectedFailureCount: 2,
      cliFailureKinds: ["privacy_leak", "wrong_recall"],
    })
  ) {
    throw new Error("exact evolution failure kind report unexpectedly failed");
  }
  expectEvolutionFailureKindsValidationFailure("missing SDK evolution failure kind", {
    sdkClusterCount: 2,
    sdkFailureKinds: ["privacy_leak"],
    cliInspectedFailureCount: 2,
    cliFailureKinds: ["privacy_leak", "wrong_recall"],
  });
  expectEvolutionFailureKindsValidationFailure("extra CLI evolution failure kind", {
    sdkClusterCount: 2,
    sdkFailureKinds: ["privacy_leak", "wrong_recall"],
    cliInspectedFailureCount: 2,
    cliFailureKinds: ["privacy_leak", "wrong_recall", "stale_pollution"],
  });
  expectEvolutionFailureKindsValidationFailure("reordered evolution failure kind", {
    sdkClusterCount: 2,
    sdkFailureKinds: ["wrong_recall", "privacy_leak"],
    cliInspectedFailureCount: 2,
    cliFailureKinds: ["privacy_leak", "wrong_recall"],
  });
  expectEvolutionFailureKindsValidationFailure("wrong CLI evolution failure count", {
    sdkClusterCount: 2,
    sdkFailureKinds: ["privacy_leak", "wrong_recall"],
    cliInspectedFailureCount: 3,
    cliFailureKinds: ["privacy_leak", "wrong_recall"],
  });
  expectCliVersionValidationFailure(
    "string cli binaries",
    selfTestCliVersionReport(expectedPackage, { cli: { binaries: Object.keys(expectedPackage.bin ?? {}).join(",") } }),
    expectedPackage,
  );
  expectCliVersionValidationFailure(
    "missing default storage",
    selfTestCliVersionReport(expectedPackage, { trustContract: { defaultStorage: undefined } }),
    expectedPackage,
  );
  expectCliVersionValidationFailure(
    "forbidden cli value",
    selfTestCliVersionReport(expectedPackage, { cli: { commands: ["evolution", "consumer.db"] } }),
    expectedPackage,
  );
  expectInspectorValidationFailure(
    "empty inspector report",
    selfTestInspectorReport({
      counts: { evidence: 0, activeMemories: 0, archivedMemories: 0 },
      health: {
        evidenceEvents: 0,
        memories: 0,
        worldBeliefs: 0,
        associations: 0,
        taskTrajectories: 0,
        failureEvents: 0,
        memoryVectors: 0,
        memoryVectorTerms: 0,
      },
      evidenceSummary: {
        inspected: 0,
        eligibleForLongTermMemory: 0,
        ineligibleForLongTermMemory: 0,
      },
    }),
  );
  expectInspectorValidationFailure(
    "fractional inspector count",
    selfTestInspectorReport({ health: { evidenceEvents: 1.5 } }),
  );
  expectInspectorValidationFailure(
    "negative inspector count",
    selfTestInspectorReport({ forgetSummary: { archivedMemories: -1 } }),
  );
  expectInspectorValidationFailure(
    "inconsistent evidence summary",
    selfTestInspectorReport({
      evidenceSummary: {
        inspected: 1,
        eligibleForLongTermMemory: 0,
        ineligibleForLongTermMemory: 0,
      },
    }),
  );
  expectInspectorValidationFailure(
    "forbidden inspector value",
    selfTestInspectorReport({ query: "release note api key: [redacted_secret] secret-value" }),
  );
  expectStatusValidationFailure("missing status storage", selfTestStatusReport({ storage: null }));
  expectStatusValidationFailure(
    "negative status row count",
    selfTestStatusReport({ rowCounts: { gmos_memories: -1 } }),
  );
  expectStatusValidationFailure(
    "missing status audited tables",
    selfTestStatusReport({ readAudit: { auditedTables: [] } }),
  );
  expectStatusValidationFailure(
    "unsafe status content flag",
    selfTestStatusReport({ trustContract: { reportContainsMemoryContent: true } }),
  );
  expectStatusValidationFailure(
    "missing status runtime trust",
    selfTestStatusReport({ runtimeTrustContract: { localFirst: false } }),
  );
  expectStatusValidationFailure(
    "forbidden status value",
    selfTestStatusReport({ diagnostics: "secret-value" }),
  );
  expectDoctorValidationFailure("encrypted doctor report", selfTestDoctorReport({ encrypted: true }));
  expectDoctorValidationFailure(
    "missing doctor runtime trust",
    selfTestDoctorReport({ runtimeTrustContract: { defaultStorage: "cloud" } }),
  );
  expectDoctorValidationFailure(
    "missing doctor read audit",
    selfTestDoctorReport({ readAudit: { missingTables: ["gmos_memories"] } }),
  );
  expectDoctorValidationFailure(
    "forbidden doctor value",
    selfTestDoctorReport({ diagnostics: "secret-value" }),
  );
  console.log(JSON.stringify({ ok: true, check: "release_evidence_self_test" }));
}

function recordDoctorContentSafety(result, forbiddenValues) {
  const check = {
    name: "fresh_install_doctor_content_safety",
    status: "pass",
    command: "validate fresh_install_doctor_smoke stdout",
  };
  try {
    validateDoctorContentSafety(result.stdout, forbiddenValues);
  } catch (error) {
    check.status = "fail";
    check.reason = error instanceof Error ? error.message : String(error);
    manifest.checks.push(check);
    failAfterWriting(manifest, outputDir, `${check.name} failed`);
  }
  manifest.checks.push(check);
}

function recordStatusContentSafety(result, forbiddenValues) {
  const check = {
    name: "fresh_install_status_content_safety",
    status: "pass",
    command: "validate fresh_install_status_smoke stdout",
  };
  try {
    validateStatusContentSafety(result.stdout, forbiddenValues);
  } catch (error) {
    check.status = "fail";
    check.reason = error instanceof Error ? error.message : String(error);
    manifest.checks.push(check);
    failAfterWriting(manifest, outputDir, `${check.name} failed`);
  }
  manifest.checks.push(check);
}

function hasExactFailureKinds(report) {
  return (
    report.failureEvents === 2 &&
    Array.isArray(report.failureKinds) &&
    report.failureKinds.length === 2 &&
    report.failureKinds[0] === "controller_route_error" &&
    report.failureKinds[1] === "wrong_recall"
  );
}

function hasExactEvolutionFailureKinds(report) {
  return (
    report.sdkClusterCount === 2 &&
    Array.isArray(report.sdkFailureKinds) &&
    report.sdkFailureKinds.length === 2 &&
    report.sdkFailureKinds[0] === "privacy_leak" &&
    report.sdkFailureKinds[1] === "wrong_recall" &&
    report.cliInspectedFailureCount === 2 &&
    Array.isArray(report.cliFailureKinds) &&
    report.cliFailureKinds.length === 2 &&
    report.cliFailureKinds[0] === "privacy_leak" &&
    report.cliFailureKinds[1] === "wrong_recall"
  );
}

function recordHttpContentSafety(result, forbiddenValues) {
  const check = {
    name: "fresh_install_http_content_safety",
    status: "pass",
    command: "validate fresh_install_http_smoke stdout",
  };
  try {
    const report = JSON.parse(result.stdout);
    if (
      report.ok !== true ||
      !Array.isArray(report.routes) ||
      !report.routes.includes("POST /mcp/call") ||
      !report.routes.includes("POST /reconstruct") ||
      !report.routes.includes("POST /commit-outcome") ||
      !report.routes.includes("POST /feedback") ||
      report.mcpCallRuntimeInfoSchema !== "gmos.runtime_info.v1" ||
      !hasExactFailureKinds(report)
    ) {
      throw new Error("unexpected HTTP smoke report shape");
    }
    const stdout = result.stdout;
    for (const [index, value] of forbiddenValues.entries()) {
      if (value && (stdout.includes(value) || stdout.includes(JSON.stringify(value).slice(1, -1)))) {
        throw new Error(`HTTP smoke report leaked forbidden value #${index + 1}`);
      }
    }
  } catch (error) {
    check.status = "fail";
    check.reason = error instanceof Error ? error.message : String(error);
    manifest.checks.push(check);
    failAfterWriting(manifest, outputDir, `${check.name} failed`);
  }
  manifest.checks.push(check);
}

function recordAgentAdapterContentSafety(result, forbiddenValues) {
  const check = {
    name: "fresh_install_agent_adapter_content_safety",
    status: "pass",
    command: "validate fresh_install_agent_adapter_smoke stdout",
  };
  try {
    const report = JSON.parse(result.stdout);
    if (
      report.ok !== true ||
      report.adapter !== "agent" ||
      !Number.isInteger(report.modelMessageCount) ||
      report.modelMessageCount < 2 ||
      !Number.isInteger(report.actionPolicyCount) ||
      report.actionPolicyCount < 1 ||
      !Number.isInteger(report.evidenceCount) ||
      report.evidenceCount < 1 ||
      !hasExactFailureKinds(report) ||
      !Number.isInteger(report.archivedMemoryCount) ||
      report.archivedMemoryCount < 1
    ) {
      throw new Error("unexpected agent adapter smoke report shape");
    }
    const stdout = result.stdout;
    for (const [index, value] of forbiddenValues.entries()) {
      if (value && (stdout.includes(value) || stdout.includes(JSON.stringify(value).slice(1, -1)))) {
        throw new Error(`agent adapter smoke report leaked forbidden value #${index + 1}`);
      }
    }
  } catch (error) {
    check.status = "fail";
    check.reason = error instanceof Error ? error.message : String(error);
    manifest.checks.push(check);
    failAfterWriting(manifest, outputDir, `${check.name} failed`);
  }
  manifest.checks.push(check);
}

function recordHostAdapterContentSafety(result, forbiddenValues) {
  const check = {
    name: "fresh_install_host_adapter_content_safety",
    status: "pass",
    command: "validate fresh_install_host_adapter_smoke stdout",
  };
  try {
    const report = JSON.parse(result.stdout);
    if (
      report.ok !== true ||
      report.adapter !== "host" ||
      report.compatibilityLevel !== "L3" ||
      !Number.isInteger(report.loadedCount) ||
      report.loadedCount < 2 ||
      !Number.isInteger(report.skippedCount) ||
      report.skippedCount < 2 ||
      !Number.isInteger(report.exportedCount) ||
      report.exportedCount < 2 ||
      !Number.isInteger(report.archivedCount) ||
      report.archivedCount < 1
    ) {
      throw new Error("unexpected host adapter smoke report shape");
    }
    const stdout = result.stdout;
    for (const [index, value] of forbiddenValues.entries()) {
      if (value && (stdout.includes(value) || stdout.includes(JSON.stringify(value).slice(1, -1)))) {
        throw new Error(`host adapter smoke report leaked forbidden value #${index + 1}`);
      }
    }
  } catch (error) {
    check.status = "fail";
    check.reason = error instanceof Error ? error.message : String(error);
    manifest.checks.push(check);
    failAfterWriting(manifest, outputDir, `${check.name} failed`);
  }
  manifest.checks.push(check);
}

function recordBackupRestoreContentSafety(result, forbiddenValues) {
  const check = {
    name: "fresh_install_backup_restore_content_safety",
    status: "pass",
    command: "validate fresh_install_backup_restore_smoke stdout",
  };
  try {
    const report = JSON.parse(result.stdout);
    if (
      report.ok !== true ||
      report.backupSchema !== "gmos.profile_backup.v1" ||
      report.restoreSchema !== "gmos.profile_backup_restore_result.v1" ||
      !Number.isInteger(report.backupMemoryCount) ||
      report.backupMemoryCount < 1 ||
      !Number.isInteger(report.restoredMemoryCount) ||
      report.restoredMemoryCount < 1 ||
      report.restoredSearchHit !== true
    ) {
      throw new Error("unexpected backup/restore smoke report shape");
    }
    const stdout = result.stdout;
    for (const [index, value] of forbiddenValues.entries()) {
      if (value && (stdout.includes(value) || stdout.includes(JSON.stringify(value).slice(1, -1)))) {
        throw new Error(`backup/restore smoke report leaked forbidden value #${index + 1}`);
      }
    }
  } catch (error) {
    check.status = "fail";
    check.reason = error instanceof Error ? error.message : String(error);
    manifest.checks.push(check);
    failAfterWriting(manifest, outputDir, `${check.name} failed`);
  }
  manifest.checks.push(check);
}

function recordEvolutionContentSafety(result, forbiddenValues) {
  const check = {
    name: "fresh_install_evolution_content_safety",
    status: "pass",
    command: "validate fresh_install_evolution_smoke stdout",
  };
  try {
    const report = JSON.parse(result.stdout);
    if (
      report.ok !== true ||
      report.sdkMode !== "report_only" ||
      report.cliMode !== "report_only" ||
      report.autoApply !== false ||
      report.autoRollout !== false ||
      !hasExactEvolutionFailureKinds(report) ||
      report.sensitiveSampleRedacted !== true ||
      report.cliSensitiveSampleRedacted !== true
    ) {
      throw new Error("unexpected evolution smoke report shape");
    }
    const stdout = result.stdout;
    for (const [index, value] of forbiddenValues.entries()) {
      if (value && (stdout.includes(value) || stdout.includes(JSON.stringify(value).slice(1, -1)))) {
        throw new Error(`evolution smoke report leaked forbidden value #${index + 1}`);
      }
    }
  } catch (error) {
    check.status = "fail";
    check.reason = error instanceof Error ? error.message : String(error);
    manifest.checks.push(check);
    failAfterWriting(manifest, outputDir, `${check.name} failed`);
  }
  manifest.checks.push(check);
}

function recordMcpContentSafety(result, forbiddenValues) {
  const check = {
    name: "fresh_install_mcp_content_safety",
    status: "pass",
    command: "validate fresh_install_mcp_smoke stdout",
  };
  try {
    const report = JSON.parse(result.stdout);
    if (
      report.ok !== true ||
      !Array.isArray(report.tools) ||
      !report.tools.includes("memory.prepare_context") ||
      !report.tools.includes("memory.commit_outcome") ||
      !report.tools.includes("memory.record_feedback") ||
      !hasExactFailureKinds(report)
    ) {
      throw new Error("unexpected MCP smoke report shape");
    }
    const stdout = result.stdout;
    for (const [index, value] of forbiddenValues.entries()) {
      if (value && (stdout.includes(value) || stdout.includes(JSON.stringify(value).slice(1, -1)))) {
        throw new Error(`MCP smoke report leaked forbidden value #${index + 1}`);
      }
    }
  } catch (error) {
    check.status = "fail";
    check.reason = error instanceof Error ? error.message : String(error);
    manifest.checks.push(check);
    failAfterWriting(manifest, outputDir, `${check.name} failed`);
  }
  manifest.checks.push(check);
}

function cleanupFreshInstallDatabaseFiles() {
  const files = [
    ...freshInstallDbPaths.flatMap((dbPath) =>
      ["", "-shm", "-wal"].map((suffix) => `${dbPath}${suffix}`),
    ),
    ...freshInstallGeneratedFilePaths,
  ];
  const errors = [];
  for (const file of files) {
    try {
      rmSync(file, { force: true });
    } catch (error) {
      errors.push(`${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const leftover = files.filter((file) => existsSync(file)).map((file) => path.basename(file));
  return { errors, leftover };
}

function recordFreshInstallDatabaseCleanupIfNeeded(options = {}) {
  if (manifest.checks.some((check) => check.name === "fresh_install_plaintext_db_cleanup")) {
    return;
  }
  if (!options.always && !existsSync(freshInstallDir)) {
    return;
  }
  const check = {
    name: "fresh_install_plaintext_db_cleanup",
    status: "pass",
    command: "remove generated fresh-install plaintext sqlite databases, backup files, and smoke scripts",
  };
  const cleanup = cleanupFreshInstallDatabaseFiles();
  if (cleanup.leftover.length > 0 || cleanup.errors.length > 0) {
    check.status = "fail";
    check.reason = [
      cleanup.leftover.length > 0
        ? `leftover generated fresh-install files: ${cleanup.leftover.join(", ")}`
        : "",
      cleanup.errors.length > 0 ? `cleanup errors: ${cleanup.errors.join("; ")}` : "",
    ].filter(Boolean).join("; ");
  }
  manifest.checks.push(check);
}

function recordFreshInstallDatabaseCleanup() {
  recordFreshInstallDatabaseCleanupIfNeeded({ always: true });
  const check = manifest.checks.find((entry) => entry.name === "fresh_install_plaintext_db_cleanup");
  if (check?.status === "fail") {
    failAfterWriting(manifest, outputDir, "fresh_install_plaintext_db_cleanup failed");
  }
}

function recordNpmCacheCleanupIfNeeded(options = {}) {
  if (manifest.checks.some((check) => check.name === "release_evidence_npm_cache_cleanup")) {
    return;
  }
  if (!options.always && !existsSync(npmCacheDir)) {
    return;
  }
  const check = {
    name: "release_evidence_npm_cache_cleanup",
    status: "pass",
    command: "remove generated npm cache",
  };
  try {
    rmSync(npmCacheDir, { recursive: true, force: true });
  } catch (error) {
    check.status = "fail";
    check.reason = error instanceof Error ? error.message : String(error);
  }
  if (existsSync(npmCacheDir)) {
    check.status = "fail";
    check.reason = check.reason
      ? `${check.reason}; npm cache still exists`
      : "npm cache still exists";
  }
  manifest.checks.push(check);
}

function recordNpmCacheCleanup() {
  recordNpmCacheCleanupIfNeeded();
  const check = manifest.checks.find((entry) => entry.name === "release_evidence_npm_cache_cleanup");
  if (check?.status === "fail") {
    failAfterWriting(manifest, outputDir, "release_evidence_npm_cache_cleanup failed");
  }
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
  freshInstallGeneratedFilePaths.push(smokeFile);
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
      const contextInjected = /summary first/.test(prepared.contextBlock);
      assert.equal(contextInjected, true);
      assert.equal(prepared.evidence.length >= 1, true);
      await memory.close();
      console.log(JSON.stringify({
        ok: true,
        package: runtimeInfo.package,
        trustContract: runtimeInfo.trustContract,
        mcpPrepareContextAvailable: runtimeInfo.publicSurface.mcpTools.includes("memory.prepare_context"),
        contextInjected,
        evidenceCount: prepared.evidence.length,
      }));
    `,
  );
  const sdkForbiddenValues = [
    "fresh-install",
    "consumer.db",
    "Release note response style",
    "summary first",
    freshInstallDbPath,
  ];
  const sdkResult = recordCommand("fresh_install_sdk_smoke", nodeBin, [smokeFile], {
    cwd: freshInstallDir,
    redactLogValues: sdkForbiddenValues,
  });
  recordSdkSmokeContentSafety(sdkResult, sdkForbiddenValues);
  const agentAdapterSmokeFile = path.join(freshInstallDir, "fresh-install-agent-adapter-smoke.mjs");
  freshInstallGeneratedFilePaths.push(agentAdapterSmokeFile);
  writeFileSync(
    agentAdapterSmokeFile,
    `
      import { strict as assert } from "node:assert";
      import path from "node:path";
      import { createMemoryOS } from "@ghast/memory";
      import { createAgentMemoryAdapter } from "@ghast/memory/host";
      import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

      const store = createSqliteMemoryStore({ path: path.join(process.cwd(), "consumer-agent.db") });
      const structuredCandidates = [];
      const memory = createMemoryOS({
        profileId: "fresh-install-agent",
        store,
        extractor: {
          name: "fresh-install-host-extractor",
          extract() {
            return structuredCandidates.shift() ?? [];
          },
        },
        host: {
          hostId: "fresh-install-agent-host",
          capabilities: {
            canObserveConversation: true,
            canInjectSystemContext: true,
            canEnforceHardDirectives: true,
            canCommitTaskOutcomes: true,
            canRecordUserFeedback: true,
            canForget: true,
            supportsActionPolicies: true,
            supportsEvidenceInContext: true,
          },
        },
      });
      const adapter = createAgentMemoryAdapter({
        memory,
        profileId: "fresh-install-agent",
        includeEvidence: true,
        reconstruction: { mode: "shadow", maxSteps: 2, maxBranch: 3 },
      });
      try {
        structuredCandidates.push([
          {
            kind: "preference",
            content: "Agent release planning style: start with constraints.",
            confidence: 0.9,
            predicate: "user.preference",
            subject: "user",
            object: "constraint-first agent release planning",
            actionPolicyKind: "prefer",
          },
        ]);
        await adapter.observeMessage({
          role: "user",
          content: "Please use constraint-first release planning.",
        });
        structuredCandidates.push([
          {
            kind: "boundary",
            content: "project:agent-release must wait for owner approval before execution.",
            confidence: 0.95,
            predicate: "boundary.do_not_push",
            subject: "project:agent-release",
            object: "release execution without owner approval",
            actionPolicyKind: "do_not_push",
          },
        ]);
        await adapter.observeMessage({
          role: "user",
          content: "project:agent-release must wait for owner approval before execution.",
        });
        const turn = await adapter.prepareTurn({
          messages: [{ role: "user", content: "How should agent-release proceed?" }],
          task: { intent: "release planning", topic: "project:agent-release" },
        });
        assert.equal(turn.modelMessages[0]?.role, "system");
        assert.equal(turn.actionPolicies.length >= 1, true);
        assert.equal(turn.prepared.evidence.length >= 1, true);
        await adapter.commitOutcome({
          taskId: "fresh-install-agent-task",
          objective: "Verify fresh install agent adapter.",
          status: "failed",
          summary: "Fresh install agent adapter missed release memory.",
          failureKind: "controller_route_error",
        });
        await adapter.recordFeedback({
          content: "Fresh install agent adapter feedback should be recorded.",
          failureKind: "wrong_recall",
        });
        const forgetResult = await adapter.forget({
          query: "start with constraints",
          reason: "fresh install smoke cleanup",
        });
        assert.equal(forgetResult.archivedMemoryIds.length >= 1, true);
        const rowCounts = await store.rowCounts();
        assert.equal(rowCounts.gmos_failure_events, 2);
        const failureKinds = (await store.listFailures({ profileId: "fresh-install-agent" }))
          .map((failure) => failure.failureKind)
          .sort();
        assert.deepEqual(failureKinds, ["controller_route_error", "wrong_recall"]);
        console.log(JSON.stringify({
          ok: true,
          adapter: "agent",
          modelMessageCount: turn.modelMessages.length,
          actionPolicyCount: turn.actionPolicies.length,
          evidenceCount: turn.prepared.evidence.length,
          failureEvents: rowCounts.gmos_failure_events,
          failureKinds,
          archivedMemoryCount: forgetResult.archivedMemoryIds.length,
        }));
      } finally {
        await memory.close();
      }
    `,
  );
  const agentAdapterForbiddenValues = [
    "fresh-install-agent",
    "consumer-agent.db",
    "Agent release planning style",
    "constraint-first",
    "start with constraints",
    "project:agent-release",
    "Fresh install agent adapter missed release memory.",
    "Fresh install agent adapter feedback should be recorded.",
    freshInstallAgentDbPath,
  ];
  const agentAdapterResult = recordCommand(
    "fresh_install_agent_adapter_smoke",
    nodeBin,
    [agentAdapterSmokeFile],
    {
      cwd: freshInstallDir,
      redactLogValues: agentAdapterForbiddenValues,
    },
  );
  recordAgentAdapterContentSafety(agentAdapterResult, agentAdapterForbiddenValues);
  const hostAdapterSmokeFile = path.join(freshInstallDir, "fresh-install-host-adapter-smoke.mjs");
  freshInstallGeneratedFilePaths.push(hostAdapterSmokeFile);
  writeFileSync(
    hostAdapterSmokeFile,
    `
      import { strict as assert } from "node:assert";
      import path from "node:path";
      import { createMemoryOS } from "@ghast/memory";
      import {
        classifyHostCompatibility,
        exportMemorySnapshots,
        parseMemorySnapshotExport,
        syncHostMemorySnapshotsIntoStore,
      } from "@ghast/memory/host";
      import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

      const profileId = "fresh-install-host";
      const nowIso = "2026-06-25T00:00:00.000Z";
      const store = createSqliteMemoryStore({ path: path.join(process.cwd(), "consumer-host.db") });
      const memory = createMemoryOS({ profileId, store });
      const hostMemories = [
        {
          id: "host_pref_1",
          kind: "preference",
          content: "Host imported response style: concise release summaries.",
          confidence: 0.91,
          updatedAt: nowIso,
        },
        {
          id: "host_boundary_1",
          kind: "boundary",
          content: "Host imported release flow must wait for owner approval.",
          confidence: 0.94,
          updatedAt: nowIso,
        },
        {
          id: "host_secret_1",
          kind: "fact",
          content: "Host imported API key is sk-freshhostsecret1234567890.",
          updatedAt: nowIso,
        },
        {
          id: "host_person_1",
          kind: "person",
          content: "PERSON: Alice: Alice prefers TypeScript.",
          updatedAt: nowIso,
        },
      ];
      try {
        const compatibility = classifyHostCompatibility({
          hostId: "fresh-install-host-adapter",
          capabilities: {
            canObserveConversation: true,
            canInjectSystemContext: true,
            canEnforceHardDirectives: true,
            canForget: true,
            supportsPrivateMode: true,
            supportsActionPolicies: true,
            supportsEvidenceInContext: true,
          },
        });
        assert.equal(compatibility.level, "L3");
        const firstSync = await syncHostMemorySnapshotsIntoStore({
          store,
          profileId,
          memories: hostMemories,
          sourceType: "fresh.host.memory",
          sourceUriPrefix: "fresh-host://memory",
          nowIso,
        });
        assert.equal(firstSync.loadedCount, 2);
        assert.equal(firstSync.skippedCount, 2);
        const prepared = await memory.prepareTurn({
          profileId,
          messages: [{ role: "user", content: "How should imported release planning work?" }],
          includeEvidence: true,
        });
        assert.match(prepared.contextBlock, /concise release summaries/);
        assert.match(prepared.contextBlock, /owner approval/);
        assert.equal(prepared.contextBlock.includes("sk-freshhostsecret"), false);
        assert.equal(prepared.contextBlock.includes("PERSON: Alice"), false);
        assert.equal(prepared.actionPolicies.length >= 1, true);
        assert.equal(prepared.evidence.length >= 1, true);
        const exported = await exportMemorySnapshots({
          memory,
          profileId,
          sourceUriPrefix: "gmos://fresh-host-export",
          nowIso,
        });
        const parsedExport = parseMemorySnapshotExport(exported);
        assert.equal(parsedExport.memoryCount >= 2, true);
        const secondSync = await syncHostMemorySnapshotsIntoStore({
          store,
          profileId,
          memories: hostMemories.filter((memoryRecord) => memoryRecord.id !== "host_pref_1"),
          sourceType: "fresh.host.memory",
          sourceUriPrefix: "fresh-host://memory",
          nowIso: "2026-06-25T01:00:00.000Z",
        });
        assert.equal(secondSync.archivedCount >= 1, true);
        const afterArchive = await memory.prepareTurn({
          profileId,
          messages: [{ role: "user", content: "concise release summaries" }],
        });
        assert.equal(afterArchive.contextBlock.includes("concise release summaries"), false);
        console.log(JSON.stringify({
          ok: true,
          adapter: "host",
          compatibilityLevel: compatibility.level,
          loadedCount: firstSync.loadedCount,
          skippedCount: firstSync.skippedCount,
          exportedCount: parsedExport.memoryCount,
          archivedCount: secondSync.archivedCount,
        }));
      } finally {
        await memory.close();
      }
    `,
  );
  const hostAdapterForbiddenValues = [
    "fresh-install-host",
    "consumer-host.db",
    "Host imported response style",
    "concise release summaries",
    "Host imported release flow",
    "owner approval",
    "sk-freshhostsecret",
    "PERSON: Alice",
    "fresh-host://memory",
    "gmos://fresh-host-export",
    freshInstallHostDbPath,
  ];
  const hostAdapterResult = recordCommand(
    "fresh_install_host_adapter_smoke",
    nodeBin,
    [hostAdapterSmokeFile],
    {
      cwd: freshInstallDir,
      redactLogValues: hostAdapterForbiddenValues,
    },
  );
  recordHostAdapterContentSafety(hostAdapterResult, hostAdapterForbiddenValues);
  const httpSmokeFile = path.join(freshInstallDir, "fresh-install-http-smoke.mjs");
  freshInstallGeneratedFilePaths.push(httpSmokeFile);
  writeFileSync(
    httpSmokeFile,
    `
      import { strict as assert } from "node:assert";
      import path from "node:path";
      import { createMemoryOS } from "@ghast/memory";
      import { createMemoryHttpServer } from "@ghast/memory/http";
      import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

      const store = createSqliteMemoryStore({ path: path.join(process.cwd(), "consumer-http.db") });
      const memory = createMemoryOS({ profileId: "fresh-install-http", store });
      const server = createMemoryHttpServer({
        memory,
        store,
        profileId: "fresh-install-http",
        host: "ghast",
        authToken: "fresh-install-http-token",
      });
      const address = await server.listen();
      try {
        const health = await fetch(address.url + "/health");
        assert.equal(health.status, 200);
        const runtimeInfoWithoutToken = await fetch(address.url + "/runtime-info");
        assert.equal(runtimeInfoWithoutToken.status, 401);
        assert.equal((await runtimeInfoWithoutToken.text()).includes("fresh-install-http-token"), false);
        const mcpRuntimeInfo = await fetch(address.url + "/mcp/call", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer fresh-install-http-token",
          },
          body: JSON.stringify({ tool: "memory.runtime_info", args: {} }),
        });
        assert.equal(mcpRuntimeInfo.status, 200);
        const mcpRuntimeInfoBody = await mcpRuntimeInfo.json();
        assert.equal(mcpRuntimeInfoBody.runtimeInfo.schema, "gmos.runtime_info.v1");
        const add = await fetch(address.url + "/add", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer fresh-install-http-token",
          },
          body: JSON.stringify({
            profileId: "fresh-install-http",
            kind: "preference",
            content: "Fresh install HTTP route prefers release evidence.",
          }),
        });
        assert.equal(add.status, 200);
        const reconstructed = await fetch(address.url + "/reconstruct", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer fresh-install-http-token",
          },
          body: JSON.stringify({
            profileId: "fresh-install-http",
            text: "release evidence route",
            temporalMode: "current",
          }),
        });
        assert.equal(reconstructed.status, 200);
        const reconstructedBody = await reconstructed.json();
        assert.equal(reconstructedBody.reconstructed.paths.length > 0, true);
        assert.equal(JSON.stringify(reconstructedBody).includes("fresh-install-http-token"), false);
        const failedOutcome = await fetch(address.url + "/commit-outcome", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer fresh-install-http-token",
          },
          body: JSON.stringify({
            profileId: "fresh-install-http",
            taskId: "fresh-install-http-task",
            objective: "Verify fresh install HTTP feedback routes.",
            status: "failed",
            summary: "Fresh install HTTP route missed release evidence.",
            failureKind: "controller_route_error",
          }),
        });
        assert.equal(failedOutcome.status, 200);
        const feedback = await fetch(address.url + "/feedback", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer fresh-install-http-token",
          },
          body: JSON.stringify({
            profileId: "fresh-install-http",
            content: "Fresh install HTTP feedback should be recorded.",
            failureKind: "wrong_recall",
          }),
        });
        assert.equal(feedback.status, 200);
        const status = await fetch(address.url + "/status?profileId=fresh-install-http", {
          headers: { authorization: "Bearer fresh-install-http-token" },
        });
        assert.equal(status.status, 200);
        const statusBody = await status.json();
        assert.equal(statusBody.report.failureSummary.inspectedFailureCount, 2);
        assert.equal(statusBody.report.failureSummary.byKind.controller_route_error, 1);
        assert.equal(statusBody.report.failureSummary.byKind.wrong_recall, 1);
        assert.deepEqual(Object.keys(statusBody.report.failureSummary.byKind).sort(), [
          "controller_route_error",
          "wrong_recall",
        ]);
        console.log(JSON.stringify({
          ok: true,
          routes: ["POST /mcp/call", "POST /reconstruct", "POST /commit-outcome", "POST /feedback"],
          mcpCallRuntimeInfoSchema: mcpRuntimeInfoBody.runtimeInfo.schema,
          failureEvents: statusBody.report.failureSummary.inspectedFailureCount,
          failureKinds: Object.keys(statusBody.report.failureSummary.byKind).sort(),
        }));
      } finally {
        await server.close();
        await memory.close();
      }
    `,
  );
  const httpForbiddenValues = [
    "fresh-install-http",
    "fresh-install-http-token",
    "consumer-http.db",
    "Fresh install HTTP route missed release evidence.",
    "Fresh install HTTP feedback should be recorded.",
    freshInstallHttpDbPath,
  ];
  const httpResult = recordCommand("fresh_install_http_smoke", nodeBin, [httpSmokeFile], {
    cwd: freshInstallDir,
    redactLogValues: httpForbiddenValues,
  });
  recordHttpContentSafety(httpResult, httpForbiddenValues);
  const mcpSmokeFile = path.join(freshInstallDir, "fresh-install-mcp-smoke.mjs");
  freshInstallGeneratedFilePaths.push(mcpSmokeFile);
  writeFileSync(
    mcpSmokeFile,
    `
      import { strict as assert } from "node:assert";
      import path from "node:path";
      import { createMemoryOS } from "@ghast/memory";
      import { createMemoryMcpServer } from "@ghast/memory/mcp";
      import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

      const store = createSqliteMemoryStore({ path: path.join(process.cwd(), "consumer-mcp.db") });
      const memory = createMemoryOS({ profileId: "fresh-install-mcp", store });
      const server = createMemoryMcpServer(memory);
      try {
        const tools = server.listTools().map((tool) => tool.name);
        assert.equal(tools.includes("memory.prepare_context"), true);
        assert.equal(tools.includes("memory.commit_outcome"), true);
        assert.equal(tools.includes("memory.record_feedback"), true);
        const runtimeInfo = await server.callTool("memory.runtime_info");
        assert.equal(runtimeInfo.isError, undefined);
        assert.equal(runtimeInfo.structuredContent.runtimeInfo.schema, "gmos.runtime_info.v1");
        const add = await server.callTool("memory.add", {
          profileId: "fresh-install-mcp",
          kind: "preference",
          content: "Fresh install MCP route prefers release evidence.",
        });
        assert.equal(add.isError, undefined);
        const prepared = await server.callTool("memory.prepare_context", {
          profileId: "fresh-install-mcp",
          text: "release evidence route",
          includeEvidence: true,
        });
        assert.equal(prepared.isError, undefined);
        assert.match(JSON.stringify(prepared.structuredContent), /release evidence/);
        const failedOutcome = await server.callTool("memory.commit_outcome", {
          profileId: "fresh-install-mcp",
          taskId: "fresh-install-mcp-task",
          objective: "Verify fresh install MCP feedback tools.",
          status: "failed",
          summary: "Fresh install MCP route missed release evidence.",
          failureKind: "controller_route_error",
        });
        assert.equal(failedOutcome.isError, undefined);
        const feedback = await server.callTool("memory.record_feedback", {
          profileId: "fresh-install-mcp",
          content: "Fresh install MCP feedback should be recorded.",
          failureKind: "wrong_recall",
        });
        assert.equal(feedback.isError, undefined);
        const rowCounts = await store.rowCounts();
        assert.equal(rowCounts.gmos_failure_events, 2);
        const failureKinds = (await store.listFailures({ profileId: "fresh-install-mcp" }))
          .map((failure) => failure.failureKind)
          .sort();
        assert.deepEqual(failureKinds, ["controller_route_error", "wrong_recall"]);
        console.log(JSON.stringify({
          ok: true,
          tools: ["memory.prepare_context", "memory.commit_outcome", "memory.record_feedback"],
          failureEvents: rowCounts.gmos_failure_events,
          failureKinds,
        }));
      } finally {
        await memory.close();
      }
    `,
  );
  const mcpForbiddenValues = [
    "fresh-install-mcp",
    "consumer-mcp.db",
    "Fresh install MCP route missed release evidence.",
    "Fresh install MCP feedback should be recorded.",
    freshInstallMcpDbPath,
  ];
  const mcpResult = recordCommand("fresh_install_mcp_smoke", nodeBin, [mcpSmokeFile], {
    cwd: freshInstallDir,
    redactLogValues: mcpForbiddenValues,
  });
  recordMcpContentSafety(mcpResult, mcpForbiddenValues);
  const cliBin = path.join("node_modules", ".bin", process.platform === "win32" ? "gmos.cmd" : "gmos");
  const cliForbiddenValues = ["fresh-install", "consumer.db", freshInstallDbPath];
  const cliResult = recordCommand("fresh_install_cli_smoke", cliBin, ["version", "--format", "json"], {
    cwd: freshInstallDir,
    redactLogValues: cliForbiddenValues,
  });
  recordCliVersionContentSafety(cliResult, cliForbiddenValues);
  const backupRestoreSmokeFile = path.join(freshInstallDir, "fresh-install-backup-restore-smoke.mjs");
  freshInstallGeneratedFilePaths.push(backupRestoreSmokeFile);
  writeFileSync(
    backupRestoreSmokeFile,
    `
      import { spawnSync } from "node:child_process";
      import { strict as assert } from "node:assert";
      import { readFileSync, rmSync } from "node:fs";
      import path from "node:path";

      const cliBin = path.join(
        process.cwd(),
        "node_modules",
        ".bin",
        process.platform === "win32" ? "gmos.cmd" : "gmos",
      );
      const backupFile = "consumer-backup.json";
      const restoreDb = "consumer-restore.db";

      function runGmos(args) {
        const result = spawnSync(cliBin, args, {
          cwd: process.cwd(),
          encoding: "utf8",
          shell: process.platform === "win32",
        });
        assert.equal(result.status, 0);
        return result.stdout;
      }

      try {
        const backupStdout = runGmos([
          "backup",
          "--db",
          "consumer.db",
          "--profile",
          "fresh-install",
          "--mode",
          "safe",
          "--output-file",
          backupFile,
        ]);
        const backupCommandReport = JSON.parse(backupStdout);
        assert.equal(backupCommandReport.ok, true);
        assert.equal(backupCommandReport.outputFile, backupFile);
        const backup = JSON.parse(readFileSync(path.join(process.cwd(), backupFile), "utf8"));
        assert.equal(backup.schema, "gmos.profile_backup.v1");
        assert.equal(backup.mode, "safe");
        assert.equal(backup.counts.memories >= 1, true);
        assert.equal(JSON.stringify(backup).includes("summary first"), true);

        const restore = JSON.parse(runGmos([
          "restore",
          "--db",
          restoreDb,
          "--profile",
          "fresh-install-restored",
          "--input-file",
          backupFile,
        ]));
        assert.equal(restore.ok, true);
        assert.equal(restore.schema, "gmos.profile_backup_restore_result.v1");
        assert.equal(restore.targetProfileId, "fresh-install-restored");
        assert.equal(restore.inserted.memories >= 1, true);

        const search = JSON.parse(runGmos([
          "search",
          "--db",
          restoreDb,
          "--profile",
          "fresh-install-restored",
          "--query",
          "summary first",
        ]));
        const restoredSearchHit = search.memories.some((memory) =>
          typeof memory.content === "string" && memory.content.includes("summary first"),
        );
        assert.equal(restoredSearchHit, true);
        console.log(JSON.stringify({
          ok: true,
          backupSchema: backup.schema,
          restoreSchema: restore.schema,
          backupMemoryCount: backup.counts.memories,
          restoredMemoryCount: restore.inserted.memories,
          restoredSearchHit,
        }));
      } finally {
        rmSync(path.join(process.cwd(), backupFile), { force: true });
      }
    `,
  );
  const backupRestoreForbiddenValues = [
    "fresh-install",
    "fresh-install-restored",
    "consumer.db",
    "consumer-restore.db",
    "consumer-backup.json",
    "Release note response style",
    "summary first",
    freshInstallDbPath,
    freshInstallRestoreDbPath,
    freshInstallBackupPath,
  ];
  const backupRestoreResult = recordCommand(
    "fresh_install_backup_restore_smoke",
    nodeBin,
    [backupRestoreSmokeFile],
    {
      cwd: freshInstallDir,
      redactLogValues: backupRestoreForbiddenValues,
    },
  );
  recordBackupRestoreContentSafety(backupRestoreResult, backupRestoreForbiddenValues);
  const evolutionSmokeFile = path.join(freshInstallDir, "fresh-install-evolution-smoke.mjs");
  freshInstallGeneratedFilePaths.push(evolutionSmokeFile);
  writeFileSync(
    evolutionSmokeFile,
    `
      import { spawnSync } from "node:child_process";
      import { strict as assert } from "node:assert";
      import path from "node:path";
      import { createMemoryOS } from "@ghast/memory";
      import {
        createEvolutionControlPlane,
        renderEvolutionFailureReviewMarkdown,
      } from "@ghast/memory/evolution";
      import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

      const profileId = "fresh-install-evolution";
      const store = createSqliteMemoryStore({ path: path.join(process.cwd(), "consumer-evolution.db") });
      const memory = createMemoryOS({ profileId, store });
      const cliBin = path.join(
        process.cwd(),
        "node_modules",
        ".bin",
        process.platform === "win32" ? "gmos.cmd" : "gmos",
      );
      try {
        await memory.commitOutcome({
          profileId,
          taskId: "fresh-evolution-task",
          objective: "Verify report-only evolution review.",
          status: "failed",
          summary: "Evolution smoke wrong recall sample.",
          failureKind: "wrong_recall",
        });
        await memory.recordFeedback({
          profileId,
          content: "Evolution smoke privacy leak sample with SSN 123-45-6789.",
          failureKind: "privacy_leak",
        });
        const controlPlane = createEvolutionControlPlane({ store, profileId });
        const sdkReport = await controlPlane.reviewFailures({ limit: 10 });
        assert.equal(sdkReport.mode, "report_only");
        assert.equal(sdkReport.autoApply, false);
        assert.equal(sdkReport.autoRollout, false);
        assert.equal(sdkReport.inspectedFailureCount, 2);
        assert.equal(sdkReport.clusters.length, 2);
        const sdkFailureKinds = sdkReport.clusters.map((cluster) => cluster.failureKind).sort();
        assert.deepEqual(sdkFailureKinds, ["privacy_leak", "wrong_recall"]);
        const markdown = renderEvolutionFailureReviewMarkdown(sdkReport);
        assert.match(markdown, /gmOS Evolution Failure Review/);
        const sdkReportJson = JSON.stringify(sdkReport);
        const sdkPrivacyLeakSamples =
          sdkReport.clusters.find((cluster) => cluster.failureKind === "privacy_leak")?.sampleContents ?? [];
        assert.equal(sdkReportJson.includes("123-45-6789"), false);
        assert.equal(sdkPrivacyLeakSamples.includes("[redacted_sensitive_failure]"), true);

        const cliResult = spawnSync(
          cliBin,
          [
            "evolution",
            "report",
            "--db",
            "consumer-evolution.db",
            "--profile",
            profileId,
            "--format",
            "json",
          ],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            shell: process.platform === "win32",
          },
        );
        assert.equal(cliResult.status, 0);
        const cliReport = JSON.parse(cliResult.stdout);
        assert.equal(cliReport.mode, "report_only");
        assert.equal(cliReport.autoApply, false);
        assert.equal(cliReport.autoRollout, false);
        assert.equal(cliReport.inspectedFailureCount, 2);
        assert.equal(cliReport.clusters.length, 2);
        const cliFailureKinds = cliReport.clusters.map((cluster) => cluster.failureKind).sort();
        assert.deepEqual(cliFailureKinds, ["privacy_leak", "wrong_recall"]);
        const cliReportJson = JSON.stringify(cliReport);
        const cliPrivacyLeakSamples =
          cliReport.clusters.find((cluster) => cluster.failureKind === "privacy_leak")?.sampleContents ?? [];
        assert.equal(cliReportJson.includes("123-45-6789"), false);
        assert.equal(cliPrivacyLeakSamples.includes("[redacted_sensitive_failure]"), true);
        console.log(JSON.stringify({
          ok: true,
          sdkMode: sdkReport.mode,
          cliMode: cliReport.mode,
          autoApply: sdkReport.autoApply || cliReport.autoApply,
          autoRollout: sdkReport.autoRollout || cliReport.autoRollout,
          sdkClusterCount: sdkReport.clusters.length,
          sdkFailureKinds,
          cliInspectedFailureCount: cliReport.inspectedFailureCount,
          cliFailureKinds,
          sensitiveSampleRedacted: sdkPrivacyLeakSamples.includes("[redacted_sensitive_failure]"),
          cliSensitiveSampleRedacted: cliPrivacyLeakSamples.includes("[redacted_sensitive_failure]"),
        }));
      } finally {
        await memory.close();
      }
    `,
  );
  const evolutionForbiddenValues = [
    "fresh-install-evolution",
    "consumer-evolution.db",
    "Evolution smoke wrong recall sample",
    "Evolution smoke privacy leak sample",
    "123-45-6789",
    freshInstallEvolutionDbPath,
  ];
  const evolutionResult = recordCommand(
    "fresh_install_evolution_smoke",
    nodeBin,
    [evolutionSmokeFile],
    {
      cwd: freshInstallDir,
      redactLogValues: evolutionForbiddenValues,
    },
  );
  recordEvolutionContentSafety(evolutionResult, evolutionForbiddenValues);
  const doctorForbiddenValues = [
    "consumer.db",
    path.join(freshInstallDir, "consumer.db"),
  ];
  const doctorResult = recordCommand(
    "fresh_install_doctor_smoke",
    cliBin,
    ["doctor", "--db", "consumer.db", "--host", "ghast", "--format", "json"],
    {
      cwd: freshInstallDir,
      redactLogValues: doctorForbiddenValues,
    },
  );
  recordDoctorContentSafety(doctorResult, doctorForbiddenValues);
  const statusForbiddenValues = [
    "fresh-install",
    "consumer.db",
    path.join(freshInstallDir, "consumer.db"),
  ];
  const statusResult = recordCommand(
    "fresh_install_status_smoke",
    cliBin,
    ["status", "--db", "consumer.db", "--profile", "fresh-install", "--host", "ghast", "--format", "json"],
    {
      cwd: freshInstallDir,
      redactLogValues: statusForbiddenValues,
    },
  );
  recordStatusContentSafety(statusResult, statusForbiddenValues);
  const inspectBin = path.join(
    "node_modules",
    ".bin",
    process.platform === "win32" ? "gmos-inspect.cmd" : "gmos-inspect",
  );
  const inspectForbiddenValues = [
    "fresh-install",
    "consumer.db",
    "Release note response style",
    "summary first",
    "sk-releaseevidencequerysecret",
    freshInstallDbPath,
  ];
  const inspectResult = recordCommand(
    "fresh_install_inspect_smoke",
    inspectBin,
    [
      "--db",
      "consumer.db",
      "--profile",
      "fresh-install",
      "--query",
      "release note api key: sk-releaseevidencequerysecret1234567890",
      "--format",
      "json",
    ],
    {
      cwd: freshInstallDir,
      redactLogValues: inspectForbiddenValues,
    },
  );
  recordInspectorContentSafety(inspectResult, inspectForbiddenValues);
  recordFreshInstallDatabaseCleanup();
  manifest.artifacts.freshInstallDir = path.relative(root, freshInstallDir);
}

recordNpmCacheCleanup();

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
