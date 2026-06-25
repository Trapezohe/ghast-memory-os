import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "gmos-consumer-smoke-"));
const packDir = path.join(tmp, "pack");
const consumerDir = path.join(tmp, "consumer");

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
    env: { ...process.env, ...options.env },
  });
}

try {
  mkdirSync(packDir, { recursive: true });
  mkdirSync(consumerDir, { recursive: true });
  const packOutput = run("npm", ["pack", "--pack-destination", packDir]);
  const tarball = packOutput.trim().split(/\s+/u).at(-1);
  assert.ok(tarball?.endsWith(".tgz"));
  const tarballPath = path.join(packDir, tarball);
  assert.equal(existsSync(tarballPath), true);

  writeFileSync(
    path.join(consumerDir, "package.json"),
    JSON.stringify({ type: "module", private: true }, null, 2),
  );
  run("npm", ["install", tarballPath], { cwd: consumerDir, stdio: "pipe" });

  const consumerScript = path.join(consumerDir, "consumer-smoke.mjs");
  writeFileSync(
    consumerScript,
    `
      import { strict as assert } from "node:assert";
      import path from "node:path";
      import { createMemoryOS } from "@ghast/memory";
      import { createPresetHostAdapter } from "@ghast/memory/host";
      import {
        renderHostCompatibilityGymMarkdown,
        runHostCompatibilityGym,
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
      await memory.close();
      console.log("[gmos-consumer] import smoke passed");
    `,
  );
  run(process.execPath, [consumerScript], { cwd: consumerDir, stdio: "pipe" });

  const gmosBin = path.join(
    consumerDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "gmos.cmd" : "gmos",
  );
  assert.equal(existsSync(gmosBin), true);
  const bin = spawnSync(
    gmosBin,
    ["doctor", "--db", path.join(consumerDir, "doctor.db"), "--host", "ghast"],
    { cwd: consumerDir, encoding: "utf8" },
  );
  assert.equal(bin.status, 0, bin.stderr);
  const doctor = JSON.parse(bin.stdout);
  assert.equal(doctor.encrypted, false);
  assert.equal(doctor.schema.dialect, "sqlite");
  assert.equal(doctor.schema.version, 1);
  assert.equal(doctor.hostCompatibility.level, "L4");
  const helpBin = spawnSync(gmosBin, ["--help"], { cwd: consumerDir, encoding: "utf8" });
  assert.equal(helpBin.status, 1);
  assert.match(helpBin.stdout, /gmos mcp serve/);
  const hostGymBin = spawnSync(
    gmosBin,
    ["gym", "host", "--hosts", "ghast,mcp", "--format", "json"],
    { cwd: consumerDir, encoding: "utf8" },
  );
  assert.equal(hostGymBin.status, 0, hostGymBin.stderr);
  const hostGym = JSON.parse(hostGymBin.stdout);
  assert.equal(hostGym.pass, true);
  assert.equal(hostGym.hostCount, 2);
  console.log("[gmos-consumer] install smoke passed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
