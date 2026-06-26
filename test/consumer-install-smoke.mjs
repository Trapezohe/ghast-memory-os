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
    env: { ...process.env, npm_config_cache: path.join(tmp, "npm-cache"), ...options.env },
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
  const packOutput = run(npmBin, ["pack", "--pack-destination", packDir]);
  const tarball = packOutput.trim().split(/\s+/u).at(-1);
  assert.ok(tarball?.endsWith(".tgz"));
  const tarballPath = path.join(packDir, tarball);
  assert.equal(existsSync(tarballPath), true);

  writeFileSync(
    path.join(consumerDir, "package.json"),
    JSON.stringify({ name: "host-app-should-not-leak", type: "module", private: true }, null, 2),
  );
  run(npmBin, ["install", tarballPath], { cwd: consumerDir, stdio: "pipe" });

  const consumerScript = path.join(consumerDir, "consumer-smoke.mjs");
  writeFileSync(
    consumerScript,
    `
      import { strict as assert } from "node:assert";
      import { readFileSync } from "node:fs";
      import path from "node:path";
      import { createMemoryOS } from "@ghast/memory";
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
        renderMemoryReleaseGateMarkdown,
        parseExternalMemoryBenchmarkDataset,
        parseLocomoBenchmarkDataset,
        parseLongMemEvalBenchmarkDataset,
        runExternalMemoryBenchmark,
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
      assert.equal(createPresetHostAdapter("ghast").compatibility.level, "L4");

      const mcp = createMemoryMcpServer(memory);
      const prepareTool = mcp.listTools().find((tool) => tool.name === "memory.prepare_context");
      assert.ok(prepareTool);
      assert.deepEqual(
        mcp.listTools().map((tool) => tool.name),
        [...PUBLIC_MEMORY_MCP_TOOL_NAMES],
      );
      assert.deepEqual(HTTP_PUBLIC_MEMORY_HTTP_ROUTES, PUBLIC_MEMORY_HTTP_ROUTES);
      assert.equal(PUBLIC_MEMORY_HTTP_ROUTES.includes("POST /backup"), false);
      assert.equal(PUBLIC_MEMORY_HTTP_ROUTES.includes("POST /restore"), false);
      assert.equal(Object.hasOwn(prepareTool.inputSchema.properties, "includeSensitive"), false);
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
      assert.equal(installedPackage.types, "./dist/index.d.ts");
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
      assert.equal(memoryGym.runManifest.sqliteSchemaVersion, 5);
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
      assert.equal(status.storage.schemaVersion, 5);
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
        const unauthenticatedTools = await fetch(httpAddress.url + "/tools");
        assert.equal(unauthenticatedTools.status, 401);
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
        type MemoryExtractionCandidate,
        type MemoryExtractor,
        type MemoryOS,
        type MemoryRecord,
        type MemoryStore,
        type ObserveResult,
        type OpenAICompatibleExtractorOptions,
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
        runExternalMemoryBenchmark,
        parseExternalMemoryBenchmarkDataset,
        runHostCompatibilityGym,
        runMemoryGym,
        runMemoryReleaseGate,
        type BuildStateBenchLearningsOptions,
        type PrepareStateBenchAgentLearningRunOptions,
        type StateBenchPreparedRunManifest,
        type ExternalMemoryBenchmarkDatasetAdapter,
        type ExternalMemoryBenchmarkDatasetFormat,
        type ExternalMemoryBenchmarkResult,
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
          kind: "preference",
          content: \`Typed extractor saw \${input.event.content}\`,
          confidence: 0.83,
          predicate: "user.preference",
          actionPolicyKind: "prefer",
          cardinality: "multi",
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
      const stateBenchPreparedShape: Pick<StateBenchPreparedRunManifest, "schema" | "framework"> = {
        schema: "gmos.state_bench_prepare_run.v1",
        framework: "state-bench-agent-learning-track",
      };
      void stateBenchPreparedShape;
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
      const prepareToolName: MemoryMcpToolName = "memory.prepare_context";
      const addToolName: MemoryMcpToolName = "memory.add";
      const searchToolName: MemoryMcpToolName = "memory.search";
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

  const bin = runInstalledCli(["doctor", "--db", path.join(consumerDir, "doctor.db"), "--host", "ghast"]);
  assert.equal(bin.status, 0, bin.stderr);
  const doctor = JSON.parse(bin.stdout);
  assert.equal(doctor.encrypted, false);
  assert.equal(doctor.schema.dialect, "sqlite");
  assert.equal(doctor.schema.version, 5);
  assert.equal(doctor.searchIndex.status, "ok");
  assert.equal(doctor.searchIndex.vectorIndex.status, "ok");
  assert.equal(doctor.hostCompatibility.level, "L4");
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
  const corruptBinDb = new Database(binLowLevelDb);
  try {
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
  assert.equal(status.storage.schemaVersion, 5);
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
  assert.equal(quickstartOutput.schemaVersion, 5);
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
