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
const freshInstallDbPaths = [
  freshInstallDbPath,
  freshInstallAgentDbPath,
  freshInstallHostDbPath,
  freshInstallHttpDbPath,
  freshInstallMcpDbPath,
];
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

function expectInspectorValidationFailure(name, stdout) {
  try {
    validateInspectorContentSafety(stdout, ["secret-value"]);
  } catch {
    return;
  }
  throw new Error(`${name} unexpectedly passed`);
}

function runSelfTest() {
  validateInspectorContentSafety(selfTestInspectorReport(), ["secret-value"]);
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
  console.log(JSON.stringify({ ok: true, check: "release_evidence_self_test" }));
}

function recordDoctorContentSafety(result, forbiddenValues) {
  const check = {
    name: "fresh_install_doctor_content_safety",
    status: "pass",
    command: "validate fresh_install_doctor_smoke stdout",
  };
  try {
    const report = JSON.parse(result.stdout);
    if (report.ok !== true || report.encrypted !== false) {
      throw new Error("unexpected doctor report shape");
    }
    if (report.dbPath !== "[plaintext sqlite path redacted]") {
      throw new Error("doctor report did not redact dbPath");
    }
    const stdout = result.stdout;
    for (const [index, value] of forbiddenValues.entries()) {
      if (value && (stdout.includes(value) || stdout.includes(JSON.stringify(value).slice(1, -1)))) {
        throw new Error(`doctor report leaked forbidden value #${index + 1}`);
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

function recordStatusContentSafety(result, forbiddenValues) {
  const check = {
    name: "fresh_install_status_content_safety",
    status: "pass",
    command: "validate fresh_install_status_smoke stdout",
  };
  try {
    const report = JSON.parse(result.stdout);
    if (report.framework !== "ghast-memory-os") {
      throw new Error("unexpected status report shape");
    }
    if (report.profileId !== "[profile id redacted]") {
      throw new Error("status report did not redact profileId");
    }
    if (report.trustContract?.encrypted !== false) {
      throw new Error("status report did not expose plaintext local trust contract");
    }
    const stdout = result.stdout;
    for (const [index, value] of forbiddenValues.entries()) {
      if (value && (stdout.includes(value) || stdout.includes(JSON.stringify(value).slice(1, -1)))) {
        throw new Error(`status report leaked forbidden value #${index + 1}`);
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
      !Number.isInteger(report.failureEvents) ||
      report.failureEvents < 2
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
      !Number.isInteger(report.failureEvents) ||
      report.failureEvents < 2 ||
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
      !Number.isInteger(report.failureEvents) ||
      report.failureEvents < 2
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
  const files = freshInstallDbPaths.flatMap((dbPath) =>
    ["", "-shm", "-wal"].map((suffix) => `${dbPath}${suffix}`),
  );
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
    command: "remove generated fresh-install plaintext sqlite databases",
  };
  const cleanup = cleanupFreshInstallDatabaseFiles();
  if (cleanup.leftover.length > 0 || cleanup.errors.length > 0) {
    check.status = "fail";
    check.reason = [
      cleanup.leftover.length > 0
        ? `leftover generated database files: ${cleanup.leftover.join(", ")}`
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
  const agentAdapterSmokeFile = path.join(freshInstallDir, "fresh-install-agent-adapter-smoke.mjs");
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
        assert.equal(rowCounts.gmos_failure_events >= 2, true);
        console.log(JSON.stringify({
          ok: true,
          adapter: "agent",
          modelMessageCount: turn.modelMessages.length,
          actionPolicyCount: turn.actionPolicies.length,
          evidenceCount: turn.prepared.evidence.length,
          failureEvents: rowCounts.gmos_failure_events,
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
        assert.equal(statusBody.report.failureSummary.inspectedFailureCount >= 2, true);
        console.log(JSON.stringify({
          ok: true,
          routes: ["POST /mcp/call", "POST /reconstruct", "POST /commit-outcome", "POST /feedback"],
          mcpCallRuntimeInfoSchema: mcpRuntimeInfoBody.runtimeInfo.schema,
          failureEvents: statusBody.report.failureSummary.inspectedFailureCount,
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
        assert.equal(rowCounts.gmos_failure_events >= 2, true);
        console.log(JSON.stringify({
          ok: true,
          tools: ["memory.prepare_context", "memory.commit_outcome", "memory.record_feedback"],
          failureEvents: rowCounts.gmos_failure_events,
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
  recordCommand("fresh_install_cli_smoke", cliBin, ["version", "--format", "json"], {
    cwd: freshInstallDir,
  });
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
