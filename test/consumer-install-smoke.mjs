import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const root = path.resolve(import.meta.dirname, "..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "gmos-consumer-smoke-"));
const packDir = path.join(tmp, "pack");
const consumerDir = path.join(tmp, "consumer");
const npmCacheDir = process.env.npm_config_cache || path.join(tmp, "npm-cache");
const isWindows = process.platform === "win32";
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";

function needsWindowsCommandShell(command) {
  return isWindows && /\.cmd$/iu.test(command);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
    env: { ...process.env, npm_config_cache: npmCacheDir, npm_config_prefer_offline: "true", ...options.env },
    shell: options.shell ?? needsWindowsCommandShell(command),
  });
}

function spawnCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    ...options,
    shell: options.shell ?? needsWindowsCommandShell(command),
  });
}

try {
  mkdirSync(packDir, { recursive: true });
  mkdirSync(consumerDir, { recursive: true });
  mkdirSync(npmCacheDir, { recursive: true });
  const packOutput = run(npmBin, ["pack", "--pack-destination", packDir]);
  const tarball = packOutput.trim().split(/\s+/u).at(-1);
  assert.ok(tarball?.endsWith(".tgz"));
  const tarballPath = path.join(packDir, tarball);
  assert.equal(existsSync(tarballPath), true);

  writeFileSync(
    path.join(consumerDir, "package.json"),
    JSON.stringify({ name: "host-app-should-not-leak", type: "module", private: true }, null, 2),
  );
  writeFileSync(path.join(consumerDir, "README.md"), "host repo\n");
  run("git", ["init"], { cwd: consumerDir });
  run("git", ["add", "README.md", "package.json"], { cwd: consumerDir });
  run(
    "git",
    ["-c", "user.name=gmOS Test", "-c", "user.email=gmos@example.test", "commit", "-m", "init"],
    { cwd: consumerDir },
  );
  assert.match(run("git", ["rev-parse", "HEAD"], { cwd: consumerDir }).trim(), /^[a-f0-9]{40}$/u);
  run(npmBin, ["install", tarballPath], { cwd: consumerDir, stdio: "pipe" });

  const consumerScript = path.join(consumerDir, "consumer-smoke.mjs");
  writeFileSync(
    consumerScript,
    `
      import { strict as assert } from "node:assert";
      import { readFileSync, writeFileSync } from "node:fs";
      import path from "node:path";
      import { createMemoryOS, getGmosRuntimeInfo } from "@ghast/memory";
      import { createMemoryStatusReport } from "@ghast/memory/diagnostics";
      import { createEvolutionControlPlane } from "@ghast/memory/evolution";
      import {
        createPresetHostAdapter,
        exportMemorySnapshots,
        loadHostMemorySnapshotsIntoStore,
        parseHostActualCompatibilityReports,
        parseMemorySnapshotExport,
        requireHostActualCompatibilityReports,
      } from "@ghast/memory/host";
      import {
        createMemoryHttpServer,
        PUBLIC_MEMORY_HTTP_ROUTES as HTTP_PUBLIC_MEMORY_HTTP_ROUTES,
      } from "@ghast/memory/http";
      import {
        renderHostCompatibilityGymMarkdown,
        renderExternalMemoryBenchmarkMarkdown,
        renderExternalMemoryBenchmarkSuiteMarkdown,
        renderMemoryReleaseGateMarkdown,
        parseExternalMemoryBenchmarkDataset,
        parseExternalMemoryBenchmarkSuite,
        parseLocomoBenchmarkDataset,
        parseLongMemEvalBenchmarkDataset,
        runExternalMemoryBenchmark,
        runExternalMemoryBenchmarkSuite,
        runHostCompatibilityGym,
        runMemoryGym,
        runMemoryReleaseGate,
      } from "@ghast/memory/gym";
      import {
        createMemoryMcpServer,
        createMemoryMcpStdioServer,
        PUBLIC_MEMORY_HTTP_ROUTES,
        PUBLIC_MEMORY_MCP_TOOL_NAMES,
      } from "@ghast/memory/mcp";
      import {
        createSqliteMemoryStore,
        parseSqliteProfileBackup,
      } from "@ghast/memory/store/sqlite";

      const store = createSqliteMemoryStore({ path: path.join(process.cwd(), "consumer.db") });
      const memory = createMemoryOS({ profileId: "consumer", store });
      const initialReadAudit = store.readAuditSnapshot();
      assert.equal(initialReadAudit.schema, "gmos.read_audit_snapshot.v1");
      assert.equal(initialReadAudit.tables.gmos_memories.rowCount, 0);
      await memory.observe({
        type: "conversation.message",
        profileId: "consumer",
        role: "user",
        content: "我偏好先讲风险再给方案。",
      });
      const prepared = await memory.prepareTurn({
        profileId: "consumer",
        messages: [{ role: "user", content: "风险 方案" }],
        includeEvidence: true,
      });
      assert.match(prepared.contextBlock, /先讲风险/);
      assert.equal(prepared.evidence.length, 1);
      const explainedPath = await memory.explainEvidencePath({
        profileId: "consumer",
        query: "风险 方案",
        includePlannerTrace: true,
      });
      assert.equal(explainedPath.schema, "gmos.evidence_path_explanation.v1");
      assert.equal(explainedPath.summary.evidenceCount >= 1, true);
      assert.equal(JSON.stringify(explainedPath).includes("contextBlock"), false);
      assert.ok(explainedPath.plannerTrace);
      const lowLevel = await memory.add({
        profileId: "consumer",
        kind: "preference",
        content: "Consumer low-level compatibility prefers stable manifests.",
      });
      const lowLevelMatches = await memory.search({
        profileId: "consumer",
        query: "stable manifests",
      });
      assert.ok(lowLevelMatches.some((entry) => entry.id === lowLevel.id));
      const exported = await exportMemorySnapshots({
        memory,
        profileId: "consumer",
        query: "stable manifests",
      });
      assert.equal(exported.schema, "gmos.memory_snapshot_export.v1");
      assert.equal(exported.memoryCount, 1);
      const parsedExport = parseMemorySnapshotExport(JSON.parse(JSON.stringify(exported)));
      const importStore = createSqliteMemoryStore({ path: path.join(process.cwd(), "consumer-import.db") });
      await loadHostMemorySnapshotsIntoStore({
        store: importStore,
        profileId: "consumer-import",
        memories: parsedExport.memories,
        sourceType: "gmos.snapshot_export",
      });
      const importMemory = createMemoryOS({ profileId: "consumer-import", store: importStore });
      const imported = await importMemory.search({
        profileId: "consumer-import",
        query: "stable manifests",
      });
      assert.equal(imported.length, 1);
      await importMemory.close();
      const parsedActualReports = parseHostActualCompatibilityReports({
        gmosSdkAdapter: {
          hostId: "ghast_desktop",
          level: "L4",
          targetLevel: "L4",
          canClaimTargetLevel: true,
        },
      });
      assert.equal(parsedActualReports.length, 1);
      assert.equal(parsedActualReports[0].hostId, "ghast_desktop");
      assert.equal(requireHostActualCompatibilityReports(parsedActualReports)[0].level, "L4");
      const lowLevelExplanation = await memory.explain(lowLevel.id, "consumer");
      assert.equal(lowLevelExplanation.evidence[0].sourceType, "sdk.low_level_add");
      await assert.rejects(
        () =>
          memory.add({
            profileId: "consumer",
            kind: "fact",
            content: "api key: sk-consumerlowlevelsecret1234567890",
          }),
        /secret-like/,
      );
      const structuredExtractorStore = createSqliteMemoryStore({
        path: path.join(process.cwd(), "consumer-structured-extractor.db"),
      });
      const structuredExtractorMemory = createMemoryOS({
        profileId: "consumer-structured-extractor",
        store: structuredExtractorStore,
        extractor: (input) => [{
          kind: "project",
          content: \`Consumer structured extractor saw \${input.event.content}\`,
          confidence: 0.83,
          predicate: "project.status",
          subject: "project:consumer-structured",
          object: input.event.content.includes("updated") ? "updated" : "typed",
          source: "consumer-runtime-smoke",
          cardinality: "single",
        }],
      });
      const structuredObserveResult = await structuredExtractorMemory.observeWithReport({
        type: "conversation.message",
        profileId: "consumer-structured-extractor",
        role: "user",
        content: "public custom extraction",
      });
      assert.equal(structuredObserveResult.extraction?.acceptedCandidateCount, 1);
      assert.equal(structuredObserveResult.worldBeliefIds.length, 1);
      const structuredExtractorMatches = await structuredExtractorMemory.search({
        profileId: "consumer-structured-extractor",
        query: "public custom extraction",
      });
      assert.equal(structuredExtractorMatches.length, 1);
      assert.equal(structuredExtractorMatches[0]?.metadata.source, "consumer-runtime-smoke");
      const initialStructuredBeliefAssociations = structuredExtractorStore
        .searchAssociations({
          profileId: "consumer-structured-extractor",
          query: "project:consumer-structured project.status typed",
          limit: 5,
        })
        .filter((association) => association.targetType === "world_belief");
      assert.equal(initialStructuredBeliefAssociations.length, 1);
      assert.equal(
        initialStructuredBeliefAssociations[0]?.targetSummary,
        "project:consumer-structured project.status typed",
      );
      const updatedStructuredObserveResult = await structuredExtractorMemory.observeWithReport({
        type: "conversation.message",
        profileId: "consumer-structured-extractor",
        role: "user",
        content: "public custom extraction updated",
      });
      assert.equal(updatedStructuredObserveResult.extraction?.acceptedCandidateCount, 1);
      assert.equal(updatedStructuredObserveResult.worldBeliefIds.length, 1);
      const currentStructuredBeliefAssociations = structuredExtractorStore
        .searchAssociations({
          profileId: "consumer-structured-extractor",
          query: "project:consumer-structured project.status updated",
          limit: 5,
        })
        .filter((association) => association.targetType === "world_belief");
      assert.equal(currentStructuredBeliefAssociations.length, 1);
      assert.equal(
        currentStructuredBeliefAssociations[0]?.targetSummary,
        "project:consumer-structured project.status updated",
      );
      assert.equal(
        currentStructuredBeliefAssociations.some((association) =>
          association.targetSummary.includes(" typed"),
        ),
        false,
      );
      await structuredExtractorMemory.close();
      assert.equal(createPresetHostAdapter("ghast").compatibility.level, "L4");

      const mcp = createMemoryMcpServer(memory);
      const runtimeInfoTool = mcp.listTools().find((tool) => tool.name === "memory.runtime_info");
      const prepareTool = mcp.listTools().find((tool) => tool.name === "memory.prepare_context");
      const explainEvidencePathTool = mcp
        .listTools()
        .find((tool) => tool.name === "memory.explain_evidence_path");
      assert.ok(runtimeInfoTool);
      assert.ok(prepareTool);
      assert.ok(explainEvidencePathTool);
      assert.deepEqual(
        mcp.listTools().map((tool) => tool.name),
        [...PUBLIC_MEMORY_MCP_TOOL_NAMES],
      );
      assert.deepEqual(HTTP_PUBLIC_MEMORY_HTTP_ROUTES, PUBLIC_MEMORY_HTTP_ROUTES);
      assert.equal(PUBLIC_MEMORY_HTTP_ROUTES.includes("GET /runtime-info"), true);
      assert.equal(PUBLIC_MEMORY_HTTP_ROUTES.includes("POST /backup"), false);
      assert.equal(PUBLIC_MEMORY_HTTP_ROUTES.includes("POST /restore"), false);
      assert.equal(Object.keys(runtimeInfoTool.inputSchema.properties).length, 0);
      assert.equal(Object.hasOwn(prepareTool.inputSchema.properties, "includeSensitive"), false);
      assert.equal(
        Object.hasOwn(explainEvidencePathTool.inputSchema.properties, "includeSensitive"),
        false,
      );
      const mcpRuntimeInfo = await mcp.callTool("memory.runtime_info");
      assert.equal(mcpRuntimeInfo.isError, undefined);
      assert.deepEqual(mcpRuntimeInfo.structuredContent.runtimeInfo, getGmosRuntimeInfo());
      assert.equal((await mcp.callTool("memory.runtime_info", { profileId: "consumer" })).isError, true);
      const mcpAddResult = await mcp.callTool("memory.add", {
        profileId: "consumer",
        kind: "preference",
        content: "Consumer MCP add remembers stable package contracts.",
      });
      assert.equal(mcpAddResult.isError, undefined);
      const mcpSearchResult = await mcp.callTool("memory.search", {
        profileId: "consumer",
        query: "stable package contracts",
      });
      assert.equal(mcpSearchResult.isError, undefined);
      assert.match(JSON.stringify(mcpSearchResult.structuredContent), /stable package contracts/);
      assert.equal(
        (await mcp.callTool("memory.search", {
          profileId: "consumer",
          query: "stable package contracts",
          includeSensitive: true,
        })).isError,
        true,
      );
      const mcpResult = await mcp.callTool("memory.prepare_context", {
        profileId: "consumer",
        text: "风险 方案",
      });
      assert.equal(mcpResult.isError, undefined);
      assert.match(JSON.stringify(mcpResult.structuredContent), /先讲风险/);
      const mcpEvidencePath = await mcp.callTool("memory.explain_evidence_path", {
        profileId: "consumer",
        text: "风险 方案",
        includePlannerTrace: true,
      });
      assert.equal(mcpEvidencePath.isError, undefined);
      assert.match(JSON.stringify(mcpEvidencePath.structuredContent), /gmos\.evidence_path_explanation\.v1/);
      assert.equal(JSON.stringify(mcpEvidencePath.structuredContent).includes("contextBlock"), false);
      assert.match(JSON.stringify(mcpEvidencePath.structuredContent), /plannerTrace/);
      assert.equal(
        (await mcp.callTool("memory.explain_evidence_path", {
          profileId: "consumer",
          text: "风险 方案",
          includeSensitive: true,
        })).isError,
        true,
      );
      assert.equal(createMemoryMcpStdioServer(memory).isConnected(), false);
      const hostGym = await runHostCompatibilityGym({ hosts: ["ghast", "mcp"] });
      assert.equal(hostGym.pass, true);
      assert.equal(hostGym.hostCount, 2);
      assert.match(renderHostCompatibilityGymMarkdown(hostGym), /gmOS Host Compatibility Gym/);
      const externalGym = await runExternalMemoryBenchmark({
        cases: [{
          id: "consumer-external",
          events: [{ type: "memory", kind: "preference", content: "用户喜欢先讲风险。" }],
          question: "用户喜欢什么？",
          expectedAll: ["先讲风险"],
        }],
      });
      assert.equal(externalGym.pass, true);
      assert.match(renderExternalMemoryBenchmarkMarkdown(externalGym), /External Long-Memory QA/);
      writeFileSync("consumer-suite.jsonl", JSON.stringify({
        id: "consumer-suite",
        events: [{ type: "memory", kind: "procedure", content: "consumer suite remembers adapter rollback matrix." }],
        question: "What should the consumer suite remember?",
        expectedAll: ["adapter rollback matrix"],
      }));
      const consumerSuite = parseExternalMemoryBenchmarkSuite(JSON.stringify({
        runs: [{ id: "consumer-suite", inputFile: "consumer-suite.jsonl" }],
      }));
      const consumerSuiteExecution = await runExternalMemoryBenchmarkSuite({ suite: consumerSuite });
      assert.equal(consumerSuiteExecution.result.pass, true);
      assert.match(renderExternalMemoryBenchmarkSuiteMarkdown(consumerSuiteExecution.result), /External Benchmark Suite/);
      const parsedConsumerLongMemEval = parseExternalMemoryBenchmarkDataset(JSON.stringify([{
        question_id: "consumer-lme",
        question: "What should the consumer adapter remember?",
        answer: "adapter rollback matrix",
        haystack_sessions: [[{
          role: "user",
          content: "Consumer adapter project workflow says to remember adapter rollback matrix.",
        }]],
      }]), { adapter: "longmemeval" });
      assert.equal(parsedConsumerLongMemEval.datasetFormat, "longmemeval.json");
      assert.equal(parsedConsumerLongMemEval.cases.length, 1);
      assert.equal(parseLongMemEvalBenchmarkDataset(JSON.stringify([{
        question_id: "consumer-lme-direct",
        question: "What should the direct adapter parse?",
        answer: "direct answer",
        haystack_sessions: [[{ role: "user", content: "direct project answer" }]],
      }])).length, 1);
      assert.equal(parseLocomoBenchmarkDataset(JSON.stringify([{
        sample_id: "consumer-locomo",
        conversation: {
          speaker_a: "A",
          speaker_b: "B",
          session_1: [{ speaker: "A", text: "consumer locomo project answer" }],
        },
        qa: [{ question: "What is the locomo answer?", answer: "consumer locomo answer" }],
      }])).length, 1);
      const installedPackage = JSON.parse(
        readFileSync(path.join(process.cwd(), "node_modules", "@ghast", "memory", "package.json"), "utf8"),
      );
      const runtimeInfo = getGmosRuntimeInfo();
      assert.equal(runtimeInfo.schema, "gmos.runtime_info.v1");
      assert.equal(runtimeInfo.package.name, "@ghast/memory");
      assert.equal(runtimeInfo.package.version, installedPackage.version);
      assert.deepEqual(runtimeInfo.cli.binaries, Object.keys(installedPackage.bin).sort());
      assert.deepEqual(runtimeInfo.packageExports, Object.keys(installedPackage.exports).sort());
      assert.equal(runtimeInfo.publicSurface.mcpTools.includes("memory.runtime_info"), true);
      assert.equal(runtimeInfo.publicSurface.mcpTools.includes("memory.prepare_context"), true);
      assert.equal(runtimeInfo.publicSurface.httpRoutes.includes("GET /runtime-info"), true);
      assert.equal(runtimeInfo.publicSurface.httpRoutes.includes("POST /prepare"), true);
      assert.equal(runtimeInfo.trustContract.localFirst, true);
      assert.equal(runtimeInfo.trustContract.defaultStorage, "sqlite");
      assert.equal(runtimeInfo.trustContract.encryptedByDefault, false);
      assert.equal(runtimeInfo.trustContract.cloudRequired, false);
      assert.equal(installedPackage.types, "./dist/index.d.ts");
      assert.equal(consumerSuiteExecution.result.runManifest.package.name, "@ghast/memory");
      assert.equal(consumerSuiteExecution.result.runManifest.package.version, installedPackage.version);
      assert.deepEqual(consumerSuiteExecution.result.runManifest.git, { branch: null, sha: null, dirty: null });
      const expectedExportTypes = {
        ".": "./dist/index.d.ts",
        "./store/sqlite": "./dist/store/sqlite/index.d.ts",
        "./gym": "./dist/gym/index.d.ts",
        "./mcp": "./dist/mcp/index.d.ts",
        "./http": "./dist/http/index.d.ts",
        "./diagnostics": "./dist/diagnostics/index.d.ts",
        "./evolution": "./dist/evolution/index.d.ts",
        "./host": "./dist/host/index.d.ts",
      };
      for (const [subpath, typePath] of Object.entries(expectedExportTypes)) {
        const exportEntry = installedPackage.exports[subpath];
        assert.equal(exportEntry.types, typePath);
        assert.equal(exportEntry.import.endsWith(".js"), true);
        assert.equal(exportEntry.default, exportEntry.import);
      }
      const memoryGym = await runMemoryGym({ generatedSeeds: 1 });
      assert.equal(memoryGym.pass, true);
      assert.equal(memoryGym.runManifest.package.name, installedPackage.name);
      assert.equal(memoryGym.runManifest.package.version, installedPackage.version);
      assert.notEqual(memoryGym.runManifest.package.name, "host-app-should-not-leak");
      assert.equal(memoryGym.runManifest.sqliteSchemaVersion, 7);
      const releaseGate = await runMemoryReleaseGate({
        generatedSeeds: 1,
        scaleSizes: [10],
        hosts: ["ghast", "mcp"],
      });
      assert.equal(releaseGate.pass, true);
      assert.equal(releaseGate.schema, "gmos.memory_release_gate.v1");
      assert.equal(releaseGate.inputs.dbPathMode, "memory");
      assert.equal(releaseGate.inputs.actualHostReports, 0);
      assert.equal(releaseGate.components.diagnostics.encrypted, false);
      assert.match(renderMemoryReleaseGateMarkdown(releaseGate), /gmOS Release Gate Report/);
      await memory.recordFeedback({
        profileId: "consumer",
        content: "consumer package wrong recall",
        failureKind: "wrong_recall",
      });
      const evolution = createEvolutionControlPlane({ store, profileId: "consumer" });
      const failureReview = await evolution.reviewFailures();
      assert.equal(failureReview.mode, "report_only");
      assert.equal(failureReview.autoApply, false);
      assert.equal(failureReview.autoRollout, false);
      assert.equal(failureReview.decision, "report_only_review");
      assert.equal(failureReview.inspectedFailureCount, 1);
      const profileBackup = store.exportProfileBackup({ profileId: "consumer", mode: "full" });
      assert.equal(profileBackup.schema, "gmos.profile_backup.v1");
      assert.equal(profileBackup.failureEvents.length, 1);
      const parsedProfileBackup = parseSqliteProfileBackup(JSON.parse(JSON.stringify(profileBackup)));
      const profileRestoreStore = createSqliteMemoryStore({
        path: path.join(process.cwd(), "consumer-profile-restore.db"),
      });
      const profileRestoreReport = profileRestoreStore.restoreProfileBackup({
        backup: parsedProfileBackup,
        profileId: "consumer-restored",
      });
      assert.equal(profileRestoreReport.inserted.memories, profileBackup.counts.memories);
      assert.equal(profileRestoreReport.inserted.failureEvents, 1);
      const profileRestoreMemory = createMemoryOS({
        profileId: "consumer-restored",
        store: profileRestoreStore,
      });
      const profileRestoreMatches = await profileRestoreMemory.search({
        profileId: "consumer-restored",
        query: "stable manifests",
      });
      assert.ok(profileRestoreMatches.some((entry) => entry.content.includes("stable manifests")));
      assert.equal(profileRestoreMatches.some((entry) => entry.id === lowLevel.id), false);
      await profileRestoreMemory.close();
      const status = await createMemoryStatusReport({
        store,
        profileId: "consumer",
        host: "ghast",
      });
      assert.equal(status.package.name, installedPackage.name);
      assert.equal(status.package.version, installedPackage.version);
      assert.deepEqual(status.runtimeInfo, getGmosRuntimeInfo());
      assert.equal(status.runtimeInfo.publicSurface.mcpTools.includes("memory.runtime_info"), true);
      assert.equal(status.runtimeInfo.publicSurface.httpRoutes.includes("GET /runtime-info"), true);
      assert.equal(status.storage.schemaVersion, 7);
      assert.equal(status.storage.searchIndex.status, "ok");
      assert.equal(status.storage.searchIndex.missingEntryCount, 0);
      assert.equal(status.hostCompatibility.level, "L4");
      assert.equal(JSON.stringify(status).includes("consumer package wrong recall"), false);
      const httpServer = createMemoryHttpServer({
        memory,
        store,
        profileId: "consumer_http",
        host: "ghast",
        authToken: "consumer-local-token",
      });
      const httpAddress = await httpServer.listen();
      try {
        const health = await fetch(httpAddress.url + "/health");
        assert.equal(health.status, 200);
        const healthBody = await health.json();
        assert.equal(healthBody.framework, "ghast-memory-os");
        assert.equal(healthBody.authRequired, true);
        const unauthenticatedRuntimeInfo = await fetch(httpAddress.url + "/runtime-info");
        assert.equal(unauthenticatedRuntimeInfo.status, 401);
        const unauthenticatedTools = await fetch(httpAddress.url + "/tools");
        assert.equal(unauthenticatedTools.status, 401);
        const httpRuntimeInfo = await fetch(httpAddress.url + "/runtime-info", {
          headers: { authorization: "Bearer consumer-local-token" },
        });
        assert.equal(httpRuntimeInfo.status, 200);
        const httpRuntimeInfoBody = await httpRuntimeInfo.json();
        assert.deepEqual(httpRuntimeInfoBody.runtimeInfo, getGmosRuntimeInfo());
        const httpObserve = await fetch(httpAddress.url + "/observe", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer consumer-local-token",
          },
          body: JSON.stringify({
            profileId: "consumer_http",
            role: "user",
            content: "I prefer HTTP consumer stable SDK boundaries.",
          }),
        });
        assert.equal(httpObserve.status, 200);
        const httpAdd = await fetch(httpAddress.url + "/add", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer consumer-local-token",
          },
          body: JSON.stringify({
            profileId: "consumer_http",
            kind: "preference",
            content: "HTTP consumer add remembers stable SDK boundaries.",
          }),
        });
        assert.equal(httpAdd.status, 200);
        const httpSearch = await fetch(httpAddress.url + "/search", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer consumer-local-token",
          },
          body: JSON.stringify({
            profileId: "consumer_http",
            query: "stable SDK boundaries",
          }),
        });
        assert.equal(httpSearch.status, 200);
        assert.match(JSON.stringify(await httpSearch.json()), /stable SDK boundaries/);
        const httpPrepare = await fetch(httpAddress.url + "/prepare", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer consumer-local-token",
          },
          body: JSON.stringify({
            profileId: "consumer_http",
            text: "stable SDK boundaries",
          }),
        });
        assert.equal(httpPrepare.status, 200);
        assert.match(JSON.stringify(await httpPrepare.json()), /stable SDK boundaries/);
        const httpExplainPath = await fetch(httpAddress.url + "/explain-path", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer consumer-local-token",
          },
          body: JSON.stringify({
            profileId: "consumer_http",
            text: "stable SDK boundaries",
            includePlannerTrace: true,
          }),
        });
        assert.equal(httpExplainPath.status, 200);
        const httpExplainPathBody = await httpExplainPath.json();
        assert.match(JSON.stringify(httpExplainPathBody), /gmos\.evidence_path_explanation\.v1/);
        assert.equal(JSON.stringify(httpExplainPathBody).includes("contextBlock"), false);
      } finally {
        await httpServer.close();
      }
      await memory.close();
      console.log("[gmos-consumer] import smoke passed");
    `,
  );
  run(process.execPath, [consumerScript], { cwd: consumerDir, stdio: "pipe" });

  const consumerTypes = path.join(consumerDir, "consumer-types.ts");
  writeFileSync(
    consumerTypes,
    `
      import {
        createMemoryOS,
        createOpenAICompatibleExtractor,
        getGmosRuntimeInfo,
        type GmosRuntimeInfo,
        type MemoryExtractionCandidate,
        type EvidencePathExplanation,
        type ExplainEvidencePathInput,
        type MemoryExtractor,
        type MemoryOS,
        type MemoryRecord,
        type MemoryStore,
        type ObserveResult,
        type OpenAICompatibleExtractorOptions,
        type ReadAuditSnapshot,
        type RepairSearchIndexResult,
        type SearchIndexStatus,
      } from "@ghast/memory";
      import {
        createMemoryStatusReport,
        type MemoryStatusReport,
      } from "@ghast/memory/diagnostics";
      import { createEvolutionControlPlane } from "@ghast/memory/evolution";
      import {
        stateBenchAgentPythonTemplate,
        buildStateBenchLearnings,
        prepareStateBenchAgentLearningRun,
        summarizeStateBenchResults,
        runExternalMemoryBenchmark,
        runExternalMemoryBenchmarkSuite,
        parseExternalMemoryBenchmarkDataset,
        parseExternalMemoryBenchmarkSuite,
        runHostCompatibilityGym,
        runMemoryGym,
        runMemoryReleaseGate,
        type BuildStateBenchLearningsOptions,
        type PrepareStateBenchAgentLearningRunOptions,
        type SummarizeStateBenchResultsOptions,
        type StateBenchResultsSummary,
        type StateBenchPreparedRunManifest,
        type ExternalMemoryBenchmarkDatasetAdapter,
        type ExternalMemoryBenchmarkDatasetFormat,
        type ExternalMemoryBenchmarkResult,
        type ExternalMemoryBenchmarkSliceScore,
        type ExternalMemoryBenchmarkSuiteExecution,
        type ExternalMemoryBenchmarkSuiteResult,
        type HostCompatibilityGymResult,
        type MemoryGymResult,
        type MemoryReleaseGateResult,
      } from "@ghast/memory/gym";
      import {
        createPresetHostAdapter,
        exportMemorySnapshots,
        loadHostMemorySnapshotsIntoStore,
        parseHostActualCompatibilityReports,
        parseMemorySnapshotExport,
        requireHostActualCompatibilityReports,
        type HostAdapter,
        type HostActualCompatibilityReport,
        type HostCompatibilityReport,
        type MemorySnapshotExport,
      } from "@ghast/memory/host";
      import {
        createMemoryHttpServer,
        PUBLIC_MEMORY_HTTP_ROUTES as HTTP_PUBLIC_MEMORY_HTTP_ROUTES,
      } from "@ghast/memory/http";
      import {
        createMemoryMcpServer,
        PUBLIC_MEMORY_HTTP_ROUTES,
        PUBLIC_MEMORY_MCP_TOOL_NAMES,
        type PublicMemoryHttpRoute,
        type PublicMemoryMcpToolName,
        type MemoryMcpServer,
        type MemoryMcpToolName,
      } from "@ghast/memory/mcp";
      import {
        createSqliteMemoryStore,
        parseSqliteProfileBackup,
        type SqliteProfileBackupDocument,
        type SqliteProfileBackupRestoreResult,
        type SqliteMemoryStore,
      } from "@ghast/memory/store/sqlite";

      const runtimeInfo: GmosRuntimeInfo = getGmosRuntimeInfo();
      const runtimeInfoSchema: "gmos.runtime_info.v1" = runtimeInfo.schema;
      const localFirstContract: true = runtimeInfo.trustContract.localFirst;
      void runtimeInfoSchema;
      void localFirstContract;

      const sqliteStore: SqliteMemoryStore = createSqliteMemoryStore({ path: ":memory:" });
      const genericStore: MemoryStore = sqliteStore;
      const schemaVersion: number = sqliteStore.schemaVersion();
      const memory = createMemoryOS({ profileId: "consumer-types", store: genericStore });
      const observeOnlyHost: Pick<MemoryOS, "observe"> = {
        async observe() {},
      };
      void observeOnlyHost;
      const typedExtractor: MemoryExtractor = (input) => {
        const candidate: MemoryExtractionCandidate = {
          kind: "project",
          content: \`Typed extractor saw \${input.event.content}\`,
          confidence: 0.83,
          predicate: "project.status",
          subject: "project:consumer-types",
          object: "typed",
          source: "consumer-type-smoke",
          cardinality: "single",
        };
        return [candidate];
      };
      const extractorStore = createSqliteMemoryStore({ path: ":memory:" });
      const extractorMemory = createMemoryOS({
        profileId: "consumer-types-extractor",
        store: extractorStore,
        extractor: typedExtractor,
      });
      const typedObserveResult: ObserveResult = await extractorMemory.observeWithReport({
        type: "conversation.message",
        profileId: "consumer-types-extractor",
        role: "user",
        content: "public custom extraction",
      });
      if (typedObserveResult.extraction?.acceptedCandidateCount !== 1) {
        throw new Error("typed observe result failed");
      }
      const typedExtractorMatches = await extractorMemory.search({
        profileId: "consumer-types-extractor",
        query: "public custom extraction",
      });
      if (typedExtractorMatches.length !== 1) throw new Error("typed extractor failed");
      await extractorMemory.close();
      const openAiExtractorOptions: OpenAICompatibleExtractorOptions = {
        model: "consumer-fixture-model",
        baseUrl: "https://memory-model.invalid/v1",
        fetch: async () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({ choices: [{ message: { content: "{\\"memories\\":[]}" } }] }),
        }),
      };
      const openAiExtractor: MemoryExtractor = createOpenAICompatibleExtractor(openAiExtractorOptions);
      const emptyExtraction = await (typeof openAiExtractor === "function"
        ? openAiExtractor
        : openAiExtractor.extract)({
        profileId: "consumer-types",
        event: {
          type: "conversation.message",
          profileId: "consumer-types",
          role: "user",
          content: "typed openai compatible extraction",
        },
        evidence: {
          id: "evidence_consumer",
          eventKey: "consumer",
          profileId: "consumer-types",
          sourceType: "consumer",
          content: "typed openai compatible extraction",
          sensitivity: "normal",
          eligibleForLongTermMemory: true,
          payload: {},
          createdAt: new Date().toISOString(),
        },
        ruleCandidates: [],
      });
      if (!Array.isArray(emptyExtraction)) throw new Error("typed openai-compatible extractor failed");
      await memory.add({
        profileId: "consumer-types",
        kind: "preference",
        content: "Typed consumer low-level API fixture.",
      });
      const typedResults = await memory.search({
        profileId: "consumer-types",
        query: "fixture",
      });
      if (typedResults.length < 1) throw new Error("low-level typed search failed");
      const typedExplainInput: ExplainEvidencePathInput = {
        profileId: "consumer-types",
        query: "fixture",
        includePlannerTrace: true,
      };
      const typedEvidencePath: EvidencePathExplanation = await memory.explainEvidencePath(typedExplainInput);
      if (typedEvidencePath.schema !== "gmos.evidence_path_explanation.v1") {
        throw new Error("typed evidence path explanation failed");
      }
      const typedSearchIndexStatus: SearchIndexStatus = sqliteStore.searchIndexStatus();
      if (typedSearchIndexStatus.status !== "ok") throw new Error("typed search index status failed");
      if (typedSearchIndexStatus.vectorIndex?.status !== "ok") {
        throw new Error("typed vector index status failed");
      }
      const typedRepairSearchIndex: RepairSearchIndexResult = sqliteStore.repairSearchIndex();
      if (typedRepairSearchIndex.after.status !== "ok") {
        throw new Error("typed search index repair failed");
      }
      if (typedRepairSearchIndex.after.vectorIndex?.status !== "ok") {
        throw new Error("typed vector index repair failed");
      }
      const typedReadAudit: ReadAuditSnapshot = sqliteStore.readAuditSnapshot();
      if (typedReadAudit.schema !== "gmos.read_audit_snapshot.v1") {
        throw new Error("typed read audit snapshot failed");
      }
      if (typedReadAudit.tables.gmos_memories.rowCount < 1) {
        throw new Error("typed read audit memory table failed");
      }
      const typedBackup: SqliteProfileBackupDocument = sqliteStore.exportProfileBackup({
        profileId: "consumer-types",
        mode: "full",
      });
      const typedParsedBackup = parseSqliteProfileBackup(typedBackup);
      const typedRestore: SqliteProfileBackupRestoreResult = sqliteStore.restoreProfileBackup({
        backup: typedParsedBackup,
      });
      if (typedRestore.targetProfileId !== "consumer-types") {
        throw new Error("typed profile backup restore failed");
      }
      const listed: MemoryRecord[] = await memory.list({
        profileId: "consumer-types",
        query: "fixture",
        status: "any",
      });
      if (listed.length < 1) throw new Error("low-level typed list failed");
      const fetched: MemoryRecord | null = await memory.get({
        profileId: "consumer-types",
        id: listed[0].id,
      });
      if (!fetched) throw new Error("low-level typed get failed");
      const typedExport: MemorySnapshotExport = await exportMemorySnapshots({
        memory,
        profileId: "consumer-types",
        query: "fixture",
      });
      const typedParsedExport = parseMemorySnapshotExport(typedExport);
      await loadHostMemorySnapshotsIntoStore({
        store: sqliteStore,
        profileId: "consumer-types-import",
        memories: typedParsedExport.memories,
        sourceType: "gmos.snapshot_export",
      });
      const evolution = createEvolutionControlPlane({ store: sqliteStore, profileId: "consumer-types" });
      const evolutionMode: "report_only" = evolution.mode;
      if (evolutionMode !== "report_only") throw new Error("unexpected evolution mode");
      const gymResult: MemoryGymResult = await runMemoryGym({ generatedSeeds: 1 });
      if (!gymResult.pass) throw new Error("typed gym result failed");
      const releaseGateResult: MemoryReleaseGateResult = await runMemoryReleaseGate({
        generatedSeeds: 1,
        scaleSizes: [10],
        hosts: ["ghast"],
      });
      if (!releaseGateResult.pass) throw new Error("typed release gate failed");
      const externalResult: ExternalMemoryBenchmarkResult = await runExternalMemoryBenchmark({
        cases: [{
          id: "typed-external",
          slices: ["consumer:typed"],
          events: [{
            type: "memory",
            kind: "procedure",
            content: "typed external benchmark remembers rollback matrix.",
          }],
          question: "What should the benchmark remember?",
          expectedAll: ["rollback matrix"],
        }],
      });
      if (!externalResult.pass) throw new Error("typed external benchmark failed");
      const typedSliceScore: ExternalMemoryBenchmarkSliceScore | undefined = externalResult.summary.sliceScores?.[0];
      if (typedSliceScore?.name !== "consumer:typed") {
        throw new Error("typed external slice score failed");
      }
      const typedSuite = parseExternalMemoryBenchmarkSuite(JSON.stringify({
        runs: [{ id: "typed-suite", inputFile: "typed-suite.jsonl" }],
      }));
      void typedSuite;
      const typedSuiteRunner: typeof runExternalMemoryBenchmarkSuite = runExternalMemoryBenchmarkSuite;
      void typedSuiteRunner;
      const typedSuiteExecution: ExternalMemoryBenchmarkSuiteExecution = {
        result: {
          schema: "gmos.external_benchmark_suite.v1",
          pass: true,
          benchmarkPass: true,
          runCount: 0,
          passedRunCount: 0,
          failedRunCount: 0,
          scoreMean: 0,
          scoreWeighted: 0,
          strictScoreMean: 0,
          strictScoreWeighted: 0,
          normalizedEvidenceScoreMean: 0,
          normalizedEvidenceScoreWeighted: 0,
          totalCaseCount: 0,
          totalPassedCount: 0,
          totalNormalizedEvidencePassedCount: 0,
          totalFailedCount: 0,
          totalWarningCount: 0,
          totalFailureReasons: [],
          totalFailureStages: [],
          totalScoreAttribution: [],
          runManifest: {
            startedAt: "",
            finishedAt: "",
            durationMs: 0,
            suiteFile: null,
            suiteHash: null,
            baseDir: ".",
            failOnBenchmarkFail: false,
            node: null,
            platform: null,
            package: null,
            git: null,
            scoreSemantics: {
              scoreKind: "deterministic_adapter_context",
              primaryScore: "strictScore",
              deterministicAdapterScoreField: "score",
              strictScoreField: "strictScore",
              normalizedEvidenceScoreField: "normalizedEvidenceScore",
              normalizedEvidenceScorePurpose: "diagnostic_only",
              officialProtocol: "not_run",
              officialScore: null,
              comparableToOfficialScore: false,
            },
            deterministicOnly: true,
          },
          runs: [],
        },
        reports: {},
      };
      const typedSuiteResult: ExternalMemoryBenchmarkSuiteResult = typedSuiteExecution.result;
      if (typedSuiteResult.schema !== "gmos.external_benchmark_suite.v1" || !typedSuiteResult.pass) {
        throw new Error("typed external suite schema failed");
      }
      const adapterName: ExternalMemoryBenchmarkDatasetAdapter = "longmemeval";
      const adapterFormat: ExternalMemoryBenchmarkDatasetFormat = "longmemeval.json";
      const parsedExternalDataset = parseExternalMemoryBenchmarkDataset(JSON.stringify([{
        question_id: "typed-lme",
        question: "What is typed?",
        answer: "typed answer",
        haystack_sessions: [[{ role: "user", content: "typed project answer" }]],
      }]), { adapter: adapterName });
      if (parsedExternalDataset.datasetFormat !== adapterFormat) {
        throw new Error("typed external adapter format failed");
      }
      const stateBenchOptions: BuildStateBenchLearningsOptions = {
        domain: "travel",
        inputDir: ".",
        allowNonTrainInput: true,
      };
      void stateBenchOptions;
      const stateBenchPrepareOptions: PrepareStateBenchAgentLearningRunOptions = {
        domain: "travel",
        checkoutDir: ".",
        agentModelName: "typed-model",
      };
      void stateBenchPrepareOptions;
      if (!stateBenchAgentPythonTemplate().includes("class GmosMemoryAgent")) {
        throw new Error("typed statebench agent template failed");
      }
      if (typeof buildStateBenchLearnings !== "function") {
        throw new Error("typed statebench learnings builder failed");
      }
      if (typeof prepareStateBenchAgentLearningRun !== "function") {
        throw new Error("typed statebench prepare failed");
      }
      if (typeof summarizeStateBenchResults !== "function") {
        throw new Error("typed statebench summarize failed");
      }
      const stateBenchPreparedShape: Pick<StateBenchPreparedRunManifest, "schema" | "framework"> = {
        schema: "gmos.state_bench_prepare_run.v1",
        framework: "state-bench-agent-learning-track",
      };
      void stateBenchPreparedShape;
      const stateBenchSummarizeOptions: SummarizeStateBenchResultsOptions = {
        domain: "travel",
        checkoutDir: ".",
      };
      void stateBenchSummarizeOptions;
      const stateBenchSummaryShape: Pick<StateBenchResultsSummary, "schema" | "framework"> = {
        schema: "gmos.state_bench_results_summary.v1",
        framework: "state-bench-agent-learning-track",
      };
      void stateBenchSummaryShape;
      const hostAdapter: HostAdapter = createPresetHostAdapter("ghast");
      const hostCompatibility: HostCompatibilityReport = hostAdapter.compatibility;
      if (hostCompatibility.level !== "L4") throw new Error("unexpected typed host compatibility");
      const actualReports: HostActualCompatibilityReport[] = parseHostActualCompatibilityReports({
        gmosSdkAdapter: {
          hostId: "ghast_desktop",
          level: "L4",
          targetLevel: "L4",
          canClaimTargetLevel: true,
        },
      });
      if (requireHostActualCompatibilityReports(actualReports)[0]?.level !== "L4") {
        throw new Error("typed actual report parser failed");
      }
      const hostGymResult: HostCompatibilityGymResult = await runHostCompatibilityGym({
        hosts: ["ghast"],
      });
      if (!hostGymResult.pass) throw new Error("typed host gym failed");
      const mcpServer: MemoryMcpServer = createMemoryMcpServer(memory);
      const publicToolName: PublicMemoryMcpToolName = PUBLIC_MEMORY_MCP_TOOL_NAMES[0];
      const publicRoute: PublicMemoryHttpRoute = PUBLIC_MEMORY_HTTP_ROUTES[0];
      if (publicToolName !== "memory.add" || publicRoute !== "GET /health") {
        throw new Error("typed public surface constants failed");
      }
      if (HTTP_PUBLIC_MEMORY_HTTP_ROUTES[0] !== "GET /health") {
        throw new Error("typed http public surface export failed");
      }
      const runtimeInfoToolName: MemoryMcpToolName = "memory.runtime_info";
      const prepareToolName: MemoryMcpToolName = "memory.prepare_context";
      const addToolName: MemoryMcpToolName = "memory.add";
      const searchToolName: MemoryMcpToolName = "memory.search";
      if (!mcpServer.listTools().some((tool) => tool.name === runtimeInfoToolName)) {
        throw new Error("typed mcp runtime_info tool missing");
      }
      if (!mcpServer.listTools().some((tool) => tool.name === prepareToolName)) {
        throw new Error("typed mcp tool missing");
      }
      if (!mcpServer.listTools().some((tool) => tool.name === addToolName)) {
        throw new Error("typed mcp add tool missing");
      }
      if (!mcpServer.listTools().some((tool) => tool.name === searchToolName)) {
        throw new Error("typed mcp search tool missing");
      }
      const status: MemoryStatusReport = await createMemoryStatusReport({
        store: sqliteStore,
        profileId: "consumer-types",
      });
      if (status.framework !== "ghast-memory-os") throw new Error("unexpected diagnostics framework");
      const statusRuntimeInfo: GmosRuntimeInfo = status.runtimeInfo;
      if (!statusRuntimeInfo.publicSurface.mcpTools.includes("memory.runtime_info")) {
        throw new Error("typed diagnostics runtime info missing MCP surface");
      }
      if (status.storage.readAudit.status !== "ok") throw new Error("typed read audit diagnostics failed");
      if (!status.trustContract.readPathSideEffectsChecked) {
        throw new Error("typed read path trust contract failed");
      }
      const httpServer = createMemoryHttpServer({
        memory,
        store: sqliteStore,
        authToken: "typed-local-token",
      });
      await httpServer.close();
      if (schemaVersion < 1) throw new Error("schema version must be initialized");
      await sqliteStore.close();
    `,
  );
  run(
    process.execPath,
    [
      path.join(root, "node_modules", "typescript", "bin", "tsc"),
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "--strict",
      "--noEmit",
      "--skipLibCheck",
      consumerTypes,
    ],
    { cwd: consumerDir, stdio: "pipe" },
  );

  const gmosBin = path.join(
    consumerDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "gmos.cmd" : "gmos",
  );
  const installedCli = path.join(
    consumerDir,
    "node_modules",
    "@ghast",
    "memory",
    "dist",
    "cli",
    "gmos.js",
  );
  assert.equal(existsSync(gmosBin), true);
  assert.equal(existsSync(installedCli), true);
  const installedPackage = JSON.parse(
    readFileSync(path.join(consumerDir, "node_modules", "@ghast", "memory", "package.json"), "utf8"),
  );

  function runInstalledCli(args) {
    return spawnSync(process.execPath, [installedCli, ...args], {
      cwd: consumerDir,
      encoding: "utf8",
    });
  }

  const installedVersionDefaultDb = path.join(consumerDir, "gmos.db");
  assert.equal(existsSync(installedVersionDefaultDb), false);
  const installedVersionBin = runInstalledCli(["version", "--format", "json"]);
  assert.equal(installedVersionBin.status, 0, installedVersionBin.stderr);
  assert.equal(existsSync(installedVersionDefaultDb), false);
  const installedVersionJson = JSON.parse(installedVersionBin.stdout);
  assert.equal(installedVersionJson.schema, "gmos.cli_version.v1");
  assert.equal(installedVersionJson.package.name, "@ghast/memory");
  assert.equal(installedVersionJson.package.version, installedPackage.version);
  assert.deepEqual(installedVersionJson.cli.binaries, Object.keys(installedPackage.bin).sort());
  assert.equal(installedVersionJson.cli.binaries.includes("gmos"), true);
  assert.equal(installedVersionJson.cli.binaries.includes("ghast-memory"), true);
  assert.equal(installedVersionJson.cli.commands.includes("version"), true);
  assert.equal(installedVersionJson.cli.commands.includes("history"), true);
  assert.equal(installedVersionJson.cli.commands.includes("gym"), true);
  assert.equal(installedVersionJson.packageExports.includes("./gym"), true);
  assert.equal(installedVersionJson.packageExports.includes("./mcp"), true);
  assert.equal(installedVersionJson.packageExports.includes("./store/sqlite"), true);
  assert.equal(installedVersionJson.publicSurface.mcpTools.includes("memory.runtime_info"), true);
  assert.equal(installedVersionJson.publicSurface.mcpTools.includes("memory.prepare_context"), true);
  assert.equal(installedVersionJson.publicSurface.httpRoutes.includes("POST /prepare"), true);
  assert.equal(installedVersionJson.trustContract.localFirst, true);
  assert.equal(installedVersionJson.trustContract.defaultStorage, "sqlite");
  assert.equal(installedVersionJson.trustContract.encryptedByDefault, false);
  assert.equal(installedVersionJson.trustContract.cloudRequired, false);
  const installedShortVersionBin = runInstalledCli(["--version"]);
  assert.equal(installedShortVersionBin.status, 0, installedShortVersionBin.stderr);
  assert.equal(installedShortVersionBin.stdout.trim(), installedPackage.version);
  assert.equal(existsSync(installedVersionDefaultDb), false);

  const installedExternalPassingFile = path.join(consumerDir, "installed-external-passing.jsonl");
  const installedExternalFailingFile = path.join(consumerDir, "installed-external-failing.jsonl");
  const installedExternalSuiteFile = path.join(consumerDir, "installed-external-suite.json");
  const installedExternalSuiteOutputDir = path.join(consumerDir, "installed-external-suite-output");
  writeFileSync(
    installedExternalPassingFile,
    JSON.stringify({
      id: "installed-suite-pass",
      events: [{ type: "memory", kind: "procedure", content: "installed suite remembers release rollback matrix." }],
      question: "What should installed suite remember?",
      expectedAll: ["release rollback matrix"],
    }),
  );
  writeFileSync(
    installedExternalFailingFile,
    JSON.stringify({
      id: "installed-suite-fail",
      events: [{ type: "memory", kind: "procedure", content: "installed suite remembers visible answer." }],
      question: "What should installed suite remember?",
      expectedAll: ["missing answer"],
    }),
  );
  writeFileSync(
    installedExternalSuiteFile,
    JSON.stringify({
      schema: "gmos.external_benchmark_suite.v1",
      defaults: { datasetFormat: "gmos", concurrency: 1, failureSampleLimit: 0 },
      runs: [
        { id: "installed_pass", inputFile: path.basename(installedExternalPassingFile) },
        { id: "installed_fail", inputFile: path.basename(installedExternalFailingFile) },
      ],
    }),
  );
  const installedExternalSuite = spawnCommand(
    gmosBin,
    [
      "gym",
      "external-suite",
      "--suite-file",
      installedExternalSuiteFile,
      "--output-dir",
      installedExternalSuiteOutputDir,
      "--format",
      "json",
    ],
    { cwd: consumerDir, encoding: "utf8" },
  );
  assert.equal(installedExternalSuite.status, 0, installedExternalSuite.stderr);
  const installedExternalSuiteJson = JSON.parse(installedExternalSuite.stdout);
  assert.equal(installedExternalSuiteJson.schema, "gmos.external_benchmark_suite.v1");
  assert.equal(installedExternalSuiteJson.pass, true);
  assert.equal(installedExternalSuiteJson.benchmarkPass, false);
  assert.equal(installedExternalSuiteJson.totalCaseCount >= 2, true);
  assert.equal(installedExternalSuiteJson.scoreWeighted > 0, true);
  assert.equal(installedExternalSuiteJson.runManifest.durationMs >= 0, true);
  assert.equal(installedExternalSuiteJson.runManifest.package.name, "@ghast/memory");
  assert.equal(typeof installedExternalSuiteJson.runManifest.package.version, "string");
  assert.equal(installedExternalSuiteJson.runManifest.package.version, installedPackage.version);
  assert.deepEqual(installedExternalSuiteJson.runManifest.git, { branch: null, sha: null, dirty: null });
  assert.equal(installedExternalSuiteJson.runs[0].durationMs >= 0, true);
  assert.equal(installedExternalSuiteJson.runs[0].caseGroupCount >= 1, true);
  assert.equal(existsSync(path.join(installedExternalSuiteOutputDir, "installed_pass.json")), true);
  assert.equal(existsSync(path.join(installedExternalSuiteOutputDir, "installed_fail.md")), true);
  const installedExternalSuiteGate = spawnCommand(
    gmosBin,
    [
      "gym",
      "external-suite",
      "--suite-file",
      installedExternalSuiteFile,
      "--format",
      "json",
      "--fail-on-benchmark-fail",
    ],
    { cwd: consumerDir, encoding: "utf8" },
  );
  assert.notEqual(installedExternalSuiteGate.status, 0);
  assert.match(installedExternalSuiteGate.stdout, /"benchmarkPass": false/);

  const bin = runInstalledCli(["doctor", "--db", path.join(consumerDir, "doctor.db"), "--host", "ghast"]);
  assert.equal(bin.status, 0, bin.stderr);
  const doctor = JSON.parse(bin.stdout);
  assert.equal(doctor.encrypted, false);
  assert.equal(doctor.runtimeInfo.schema, "gmos.runtime_info.v1");
  assert.equal(doctor.runtimeInfo.cli.binaries.includes("gmos"), true);
  assert.equal(doctor.runtimeInfo.packageExports.includes("."), true);
  assert.equal(doctor.runtimeInfo.publicSurface.mcpTools.includes("memory.runtime_info"), true);
  assert.equal(doctor.runtimeInfo.publicSurface.httpRoutes.includes("GET /runtime-info"), true);
  assert.equal(doctor.runtimeInfo.trustContract.localFirst, true);
  assert.equal(doctor.runtimeInfo.trustContract.defaultStorage, "sqlite");
  assert.equal(doctor.runtimeInfo.trustContract.encryptedByDefault, false);
  assert.equal(doctor.runtimeInfo.trustContract.cloudRequired, false);
  assert.equal(doctor.schema.dialect, "sqlite");
  assert.equal(doctor.schema.version, 7);
  assert.equal(doctor.readAudit.status, "ok");
  assert.equal(doctor.readAudit.schema, "gmos.read_audit_snapshot.v1");
  assert.equal(doctor.readAudit.tableCount >= 10, true);
  assert.equal(doctor.readAudit.hashesAvailable, true);
  assert.equal(Object.prototype.hasOwnProperty.call(doctor.readAudit, "stateHash"), false);
  assert.equal(doctor.searchIndex.status, "ok");
  assert.equal(doctor.searchIndex.vectorIndex.status, "ok");
  assert.equal(doctor.hostCompatibility.level, "L4");
  const doctorMarkdown = runInstalledCli([
    "doctor",
    "--db",
    path.join(consumerDir, "doctor.db"),
    "--host",
    "ghast",
    "--format",
    "markdown",
  ]);
  assert.equal(doctorMarkdown.status, 0, doctorMarkdown.stderr);
  assert.match(doctorMarkdown.stdout, /^# gmOS Doctor Report/m);
  assert.match(doctorMarkdown.stdout, /memory\.runtime_info/);
  assert.match(doctorMarkdown.stdout, /GET \/runtime-info/);
  assert.match(doctorMarkdown.stdout, /Search index: ok/);
  assert.match(doctorMarkdown.stdout, /Host: ghast/);
  assert.doesNotMatch(doctorMarkdown.stdout, /stateHash/);
  const binLowLevelDb = path.join(consumerDir, "bin-low-level.db");
  const addBin = runInstalledCli(
    [
      "add",
      "--db",
      binLowLevelDb,
      "--profile",
      "bin",
      "--kind",
      "preference",
      "--text",
      "Installed bin low-level add prefers stable manifests.",
    ],
  );
  assert.equal(addBin.status, 0, addBin.stderr);
  const addBinMemory = JSON.parse(addBin.stdout);
  const addExpiredBin = runInstalledCli(
    [
      "add",
      "--db",
      binLowLevelDb,
      "--profile",
      "bin",
      "--kind",
      "fact",
      "--text",
      "Installed bin expired history remembers old manifest checksum.",
    ],
  );
  assert.equal(addExpiredBin.status, 0, addExpiredBin.stderr);
  const addExpiredMemory = JSON.parse(addExpiredBin.stdout);
  const corruptBinDb = new Database(binLowLevelDb);
  try {
    const expiredMetadata = {
      ...(addExpiredMemory.metadata ?? {}),
      validTo: "2000-01-01T00:00:00.000Z",
    };
    corruptBinDb
      .prepare("UPDATE gmos_memories SET metadata_json = ? WHERE id = ?")
      .run(JSON.stringify(expiredMetadata), addExpiredMemory.id);
    corruptBinDb.prepare("DELETE FROM gmos_memories_fts WHERE id = ?").run(addBinMemory.id);
  } finally {
    corruptBinDb.close();
  }
  const staleDoctorBin = runInstalledCli(["doctor", "--db", binLowLevelDb, "--host", "ghast"]);
  assert.equal(staleDoctorBin.status, 0, staleDoctorBin.stderr);
  const staleDoctor = JSON.parse(staleDoctorBin.stdout);
  assert.equal(staleDoctor.searchIndex.status, "stale");
  assert.equal(staleDoctor.searchIndex.missingEntryCount, 1);
  const repairBin = runInstalledCli(["repair", "--db", binLowLevelDb, "--search-index"]);
  assert.equal(repairBin.status, 0, repairBin.stderr);
  const repair = JSON.parse(repairBin.stdout);
  assert.equal(repair.ok, true);
  assert.equal(repair.searchIndex.repaired, true);
  assert.equal(repair.searchIndex.before.status, "stale");
  assert.equal(repair.searchIndex.after.status, "ok");
  const searchBin = runInstalledCli(
    [
      "search",
      "--db",
      binLowLevelDb,
      "--profile",
      "bin",
      "--query",
      "stable manifests",
    ],
  );
  assert.equal(searchBin.status, 0, searchBin.stderr);
  assert.match(searchBin.stdout, /Installed bin low-level add prefers stable manifests/);
  const defaultExpiredSearchBin = runInstalledCli(
    [
      "search",
      "--db",
      binLowLevelDb,
      "--profile",
      "bin",
      "--query",
      "old manifest checksum",
    ],
  );
  assert.equal(defaultExpiredSearchBin.status, 0, defaultExpiredSearchBin.stderr);
  assert.doesNotMatch(defaultExpiredSearchBin.stdout, /old manifest checksum/);
  const purposeHistorySearchBin = runInstalledCli(
    [
      "search",
      "--db",
      binLowLevelDb,
      "--profile",
      "bin",
      "--query",
      "old manifest checksum",
      "--purpose",
      "history",
    ],
  );
  assert.equal(purposeHistorySearchBin.status, 0, purposeHistorySearchBin.stderr);
  assert.match(purposeHistorySearchBin.stdout, /old manifest checksum/);
  const historySearchBin = runInstalledCli(
    [
      "history",
      "--db",
      binLowLevelDb,
      "--profile",
      "bin",
      "--query",
      "old manifest checksum",
    ],
  );
  assert.equal(historySearchBin.status, 0, historySearchBin.stderr);
  assert.match(historySearchBin.stdout, /old manifest checksum/);
  const historyReconstructBin = runInstalledCli(
    [
      "reconstruct",
      "--db",
      binLowLevelDb,
      "--profile",
      "bin",
      "--text",
      "What was the previous stable manifests preference?",
      "--temporal-mode",
      "history",
    ],
  );
  assert.equal(historyReconstructBin.status, 0, historyReconstructBin.stderr);
  assert.match(historyReconstructBin.stdout, /stable manifests/);
  const historyPrepareShadowBin = runInstalledCli(
    [
      "prepare",
      "--db",
      binLowLevelDb,
      "--profile",
      "bin",
      "--text",
      "What was the previous stable manifests preference?",
      "--reconstruct-shadow",
      "--temporal-mode",
      "history",
    ],
  );
  assert.equal(historyPrepareShadowBin.status, 0, historyPrepareShadowBin.stderr);
  const historyPrepareShadowPayload = JSON.parse(historyPrepareShadowBin.stdout);
  assert.equal(typeof historyPrepareShadowPayload.reconstruction?.contextBlock, "string");
  assert.match(historyPrepareShadowPayload.reconstruction.contextBlock, /stable manifests/);
  const observeReportBin = runInstalledCli(
    [
      "observe",
      "--db",
      binLowLevelDb,
      "--profile",
      "bin",
      "--text",
      "I prefer concise extraction reports.",
      "--report",
    ],
  );
  assert.equal(observeReportBin.status, 0, observeReportBin.stderr);
  const observeReportPayload = JSON.parse(observeReportBin.stdout);
  assert.equal(observeReportPayload.extraction?.acceptedCandidateCount, 1);
  assert.equal(observeReportPayload.extraction?.decisions[0]?.decision, "accepted");
  const secretObserveReportBin = runInstalledCli(
    [
      "observe",
      "--db",
      binLowLevelDb,
      "--profile",
      "bin",
      "--text",
      "My API key is sk-observesecretreport1234567890.",
      "--report",
    ],
  );
  assert.equal(secretObserveReportBin.status, 0, secretObserveReportBin.stderr);
  const secretObserveReportPayload = JSON.parse(secretObserveReportBin.stdout);
  assert.equal(secretObserveReportPayload.eligibleForLongTermMemory, false);
  assert.equal(secretObserveReportPayload.skippedReason, "not_eligible_for_long_term_memory");
  assert.equal(JSON.stringify(secretObserveReportPayload).includes("sk-observesecretreport"), false);
  const incognitoObserveReportBin = runInstalledCli(
    [
      "observe",
      "--db",
      binLowLevelDb,
      "--profile",
      "bin",
      "--text",
      "Incognito report should not persist HiddenObserveReportFlag.",
      "--incognito",
      "--report",
    ],
  );
  assert.equal(incognitoObserveReportBin.status, 0, incognitoObserveReportBin.stderr);
  const incognitoObserveReportPayload = JSON.parse(incognitoObserveReportBin.stdout);
  assert.equal(incognitoObserveReportPayload.eligibleForLongTermMemory, false);
  assert.equal(incognitoObserveReportPayload.skippedReason, "not_eligible_for_long_term_memory");
  assert.equal(JSON.stringify(incognitoObserveReportPayload).includes("HiddenObserveReportFlag"), false);
  const afterUnsafeObserveReportPrepare = runInstalledCli(
    [
      "prepare",
      "--db",
      binLowLevelDb,
      "--profile",
      "bin",
      "--text",
      "API key HiddenObserveReportFlag",
    ],
  );
  assert.equal(afterUnsafeObserveReportPrepare.status, 0, afterUnsafeObserveReportPrepare.stderr);
  assert.equal(
    afterUnsafeObserveReportPrepare.stdout.includes("sk-observesecretreport") ||
      afterUnsafeObserveReportPrepare.stdout.includes("HiddenObserveReportFlag"),
    false,
  );
  const unsafeObserveReportDb = new Database(binLowLevelDb, { readonly: true });
  try {
    const unsafeEvidenceRows = unsafeObserveReportDb
      .prepare(
        `SELECT content
           FROM gmos_evidence_events
          WHERE content LIKE ?
             OR content LIKE ?`,
      )
      .all("%sk-observesecretreport%", "%HiddenObserveReportFlag%");
    assert.equal(unsafeEvidenceRows.length, 0);
  } finally {
    unsafeObserveReportDb.close();
  }
  const explainPathBin = runInstalledCli(
    [
      "explain-path",
      "--db",
      binLowLevelDb,
      "--profile",
      "bin",
      "--text",
      "stable manifests",
      "--include-trace",
    ],
  );
  assert.equal(explainPathBin.status, 0, explainPathBin.stderr);
  const explainPathBinPayload = JSON.parse(explainPathBin.stdout);
  assert.equal(explainPathBinPayload.schema, "gmos.evidence_path_explanation.v1");
  assert.equal(JSON.stringify(explainPathBinPayload).includes("contextBlock"), false);
  const listBin = runInstalledCli(
    [
      "list",
      "--db",
      binLowLevelDb,
      "--profile",
      "bin",
      "--query",
      "stable manifests",
    ],
  );
  assert.equal(listBin.status, 0, listBin.stderr);
  assert.equal(
    JSON.parse(listBin.stdout).memories.some((entry) => entry.id === addBinMemory.id),
    true,
  );
  const getBin = runInstalledCli(
    [
      "get",
      "--db",
      binLowLevelDb,
      "--profile",
      "bin",
      "--id",
      addBinMemory.id,
    ],
  );
  assert.equal(getBin.status, 0, getBin.stderr);
  assert.match(getBin.stdout, /Installed bin low-level add prefers stable manifests/);
  const listShim = spawnCommand(
    gmosBin,
    [
      "list",
      "--db",
      binLowLevelDb,
      "--profile",
      "bin",
      "--query",
      "stable manifests",
    ],
    { cwd: consumerDir, encoding: "utf8" },
  );
  assert.equal(listShim.status, 0, listShim.stderr);
  assert.equal(
    JSON.parse(listShim.stdout).memories.some((entry) => entry.id === addBinMemory.id),
    true,
  );
  const getShim = spawnCommand(
    gmosBin,
    [
      "get",
      "--db",
      binLowLevelDb,
      "--profile",
      "bin",
      "--id",
      addBinMemory.id,
    ],
    { cwd: consumerDir, encoding: "utf8" },
  );
  assert.equal(getShim.status, 0, getShim.stderr);
  assert.match(getShim.stdout, /Installed bin low-level add prefers stable manifests/);
  const exportFile = path.join(consumerDir, "bin-memory-export.json");
  const exportBin = runInstalledCli([
    "export",
    "--db",
    binLowLevelDb,
    "--profile",
    "bin",
    "--query",
    "stable manifests",
    "--output-file",
    exportFile,
  ]);
  assert.equal(exportBin.status, 0, exportBin.stderr);
  assert.equal(existsSync(exportFile), true);
  const exportPayload = JSON.parse(readFileSync(exportFile, "utf8"));
  assert.equal(exportPayload.schema, "gmos.memory_snapshot_export.v1");
  assert.equal(exportPayload.memoryCount, 1);
  const importDb = path.join(consumerDir, "bin-memory-import.db");
  const importBin = runInstalledCli([
    "import",
    "--db",
    importDb,
    "--profile",
    "bin-import",
    "--input-file",
    exportFile,
  ]);
  assert.equal(importBin.status, 0, importBin.stderr);
  assert.equal(JSON.parse(importBin.stdout).loadedCount, 1);
  const importSearchBin = runInstalledCli([
    "search",
    "--db",
    importDb,
    "--profile",
    "bin-import",
    "--query",
    "stable manifests",
  ]);
  assert.equal(importSearchBin.status, 0, importSearchBin.stderr);
  assert.match(importSearchBin.stdout, /Installed bin low-level add prefers stable manifests/);
  const statusBin = runInstalledCli(
    [
      "status",
      "--db",
      binLowLevelDb,
      "--profile",
      "bin",
      "--host",
      "ghast",
      "--format",
      "json",
    ],
  );
  assert.equal(statusBin.status, 0, statusBin.stderr);
  const status = JSON.parse(statusBin.stdout);
  assert.equal(status.storage.schemaVersion, 7);
  assert.equal(status.storage.searchIndex.status, "ok");
  assert.equal(status.storage.searchIndex.missingEntryCount, 0);
  assert.equal(status.hostCompatibility.level, "L4");
  const installedMcpVersionScript = path.join(consumerDir, "installed-mcp-version.mjs");
  writeFileSync(
    installedMcpVersionScript,
    `
      import { strict as assert } from "node:assert";
      import { Client } from "@modelcontextprotocol/sdk/client/index.js";
      import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

      const client = new Client({
        name: "gmos-installed-consumer-test",
        version: "0.0.0",
      });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          ${JSON.stringify(installedCli)},
          "mcp",
          "serve",
          "--db",
          ${JSON.stringify(path.join(consumerDir, "installed-mcp.db"))},
          "--profile",
          "installed_mcp",
        ],
        cwd: process.cwd(),
        stderr: "pipe",
      });
      try {
        await client.connect(transport);
        assert.equal(client.getServerVersion()?.name, "gmos-memory");
        assert.equal(client.getServerVersion()?.version, ${JSON.stringify(installedPackage.version)});
      } finally {
        await client.close();
      }
    `,
  );
  run(process.execPath, [installedMcpVersionScript], { cwd: consumerDir, stdio: "pipe" });
  const helpBin = spawnCommand(gmosBin, ["--help"], { cwd: consumerDir, encoding: "utf8" });
  assert.equal(helpBin.status, 1);
  assert.match(helpBin.stdout, /gmos version --format json/);
  assert.match(helpBin.stdout, /gmos http serve/);
  const hostGymBin = runInstalledCli(
    ["gym", "host", "--hosts", "ghast,mcp", "--format", "json"],
  );
  assert.equal(hostGymBin.status, 0, hostGymBin.stderr);
  const hostGym = JSON.parse(hostGymBin.stdout);
  assert.equal(hostGym.pass, true);
  assert.equal(hostGym.hostCount, 2);
  const gateBin = runInstalledCli([
    "gate",
    "--generated-seeds",
    "1",
    "--scale-sizes",
    "10",
    "--hosts",
    "ghast,mcp",
    "--format",
    "json",
  ]);
  assert.equal(gateBin.status, 0, gateBin.stderr);
  const gateReport = JSON.parse(gateBin.stdout);
  assert.equal(gateReport.schema, "gmos.memory_release_gate.v1");
  assert.equal(gateReport.pass, true);
  assert.equal(gateReport.inputs.dbPathMode, "memory");
  assert.equal(gateReport.components.diagnostics.encrypted, false);
  const installedQuickstart = path.join(
    consumerDir,
    "node_modules",
    "@ghast",
    "memory",
    "examples",
    "quickstart.mjs",
  );
  assert.equal(existsSync(installedQuickstart), true);
  const quickstart = spawnSync(process.execPath, [installedQuickstart], {
    cwd: consumerDir,
    encoding: "utf8",
  });
  assert.equal(quickstart.status, 0, quickstart.stderr);
  const quickstartOutput = JSON.parse(quickstart.stdout);
  assert.equal(quickstartOutput.ok, true);
  assert.equal(quickstartOutput.contextHasPreference, true);
  assert.equal(quickstartOutput.importedSearchHit, true);
  assert.equal(quickstartOutput.schemaVersion, 7);
  assert.equal(quickstartOutput.hostLevel, "L4");
  const installedHostAdapterExample = path.join(
    consumerDir,
    "node_modules",
    "@ghast",
    "memory",
    "examples",
    "host-adapter.mjs",
  );
  assert.equal(existsSync(installedHostAdapterExample), true);
  const hostAdapterExample = spawnSync(process.execPath, [installedHostAdapterExample], {
    cwd: consumerDir,
    encoding: "utf8",
  });
  assert.equal(hostAdapterExample.status, 0, hostAdapterExample.stderr);
  const hostAdapterOutput = JSON.parse(hostAdapterExample.stdout);
  assert.equal(hostAdapterOutput.ok, true);
  assert.equal(hostAdapterOutput.compatibilityLevel, "L3");
  assert.equal(hostAdapterOutput.firstSync.loadedCount, 2);
  assert.equal(hostAdapterOutput.firstSync.skippedCount, 2);
  assert.equal(hostAdapterOutput.prepared.contextHasBoundary, true);
  assert.equal(hostAdapterOutput.secondSync.archivedCount, 1);
  console.log("[gmos-consumer] install smoke passed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
