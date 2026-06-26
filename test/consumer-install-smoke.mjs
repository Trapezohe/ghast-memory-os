import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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
        parseMemorySnapshotExport,
      } from "@ghast/memory/host";
      import { createMemoryHttpServer } from "@ghast/memory/http";
      import {
        renderHostCompatibilityGymMarkdown,
        renderMemoryReleaseGateMarkdown,
        runHostCompatibilityGym,
        runMemoryGym,
        runMemoryReleaseGate,
      } from "@ghast/memory/gym";
      import { createMemoryMcpServer, createMemoryMcpStdioServer } from "@ghast/memory/mcp";
      import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

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
      assert.equal(Object.hasOwn(prepareTool.inputSchema.properties, "includeSensitive"), false);
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
      assert.equal(memoryGym.runManifest.sqliteSchemaVersion, 2);
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
      const status = await createMemoryStatusReport({
        store,
        profileId: "consumer",
        host: "ghast",
      });
      assert.equal(status.package.name, installedPackage.name);
      assert.equal(status.package.version, installedPackage.version);
      assert.equal(status.storage.schemaVersion, 2);
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
      import { createMemoryOS, type MemoryRecord, type MemoryStore } from "@ghast/memory";
      import {
        createMemoryStatusReport,
        type MemoryStatusReport,
      } from "@ghast/memory/diagnostics";
      import { createEvolutionControlPlane } from "@ghast/memory/evolution";
      import {
        runHostCompatibilityGym,
        runMemoryGym,
        runMemoryReleaseGate,
        type HostCompatibilityGymResult,
        type MemoryGymResult,
        type MemoryReleaseGateResult,
      } from "@ghast/memory/gym";
      import {
        createPresetHostAdapter,
        exportMemorySnapshots,
        loadHostMemorySnapshotsIntoStore,
        parseMemorySnapshotExport,
        type HostAdapter,
        type HostCompatibilityReport,
        type MemorySnapshotExport,
      } from "@ghast/memory/host";
      import { createMemoryHttpServer } from "@ghast/memory/http";
      import {
        createMemoryMcpServer,
        type MemoryMcpServer,
        type MemoryMcpToolName,
      } from "@ghast/memory/mcp";
      import {
        createSqliteMemoryStore,
        type SqliteMemoryStore,
      } from "@ghast/memory/store/sqlite";

      const sqliteStore: SqliteMemoryStore = createSqliteMemoryStore({ path: ":memory:" });
      const genericStore: MemoryStore = sqliteStore;
      const schemaVersion: number = sqliteStore.schemaVersion();
      const memory = createMemoryOS({ profileId: "consumer-types", store: genericStore });
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
      const hostAdapter: HostAdapter = createPresetHostAdapter("ghast");
      const hostCompatibility: HostCompatibilityReport = hostAdapter.compatibility;
      if (hostCompatibility.level !== "L4") throw new Error("unexpected typed host compatibility");
      const hostGymResult: HostCompatibilityGymResult = await runHostCompatibilityGym({
        hosts: ["ghast"],
      });
      if (!hostGymResult.pass) throw new Error("typed host gym failed");
      const mcpServer: MemoryMcpServer = createMemoryMcpServer(memory);
      const prepareToolName: MemoryMcpToolName = "memory.prepare_context";
      if (!mcpServer.listTools().some((tool) => tool.name === prepareToolName)) {
        throw new Error("typed mcp tool missing");
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
  assert.equal(doctor.schema.version, 2);
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
  assert.equal(status.storage.schemaVersion, 2);
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
  assert.equal(quickstartOutput.schemaVersion, 2);
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
