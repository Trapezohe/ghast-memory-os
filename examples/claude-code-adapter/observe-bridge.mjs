#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMemoryOS } from "@ghast/memory";
import { createMemoryHttpServer } from "@ghast/memory/http";
import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

function stringField(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function eventName(event) {
  return stringField(event, ["hook_event_name", "hookEventName", "event"]);
}

function sessionId(event) {
  return stringField(event, ["session_id", "sessionId"]);
}

function toolName(event) {
  return stringField(event, ["tool_name", "toolName", "name"]);
}

function timestamp(event) {
  return stringField(event, ["timestamp", "createdAt"]);
}

function metadataFor(event) {
  return {
    adapter: "claude-code",
    hookEventName: eventName(event),
    ...(sessionId(event) ? { sessionId: sessionId(event) } : {}),
    ...(toolName(event) ? { toolName: toolName(event) } : {}),
    ...(stringField(event, ["cwd"]) ? { cwd: stringField(event, ["cwd"]) } : {}),
  };
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new Error("observe bridge requires hook event JSON on stdin");
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("hook event must be a JSON object");
  }
  return parsed;
}

async function postJson(url, token, pathname, body) {
  const response = await fetch(`${url}${pathname}`, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`gmOS HTTP ${pathname} failed: ${JSON.stringify(payload)}`);
  }
  return payload;
}

function runBridgeSample(scriptPath, env, sample) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(sample));
  });
}

async function bridgeEvent(event, env = process.env) {
  const name = eventName(event);
  const profileId = env.GMOS_PROFILE_ID || "claude-code";
  const url = env.GMOS_HTTP_URL || "http://127.0.0.1:4787";
  const token = env.GMOS_HTTP_AUTH_TOKEN;
  const createdAt = timestamp(event);
  if (name === "SessionStart") {
    await postJson(url, token, "/observe", {
      profileId,
      role: "system",
      content: `Claude Code session started${sessionId(event) ? `: ${sessionId(event)}` : ""}.`,
      ...(createdAt ? { createdAt } : {}),
      metadata: metadataFor(event),
    });
    return { forwarded: "observe", hookEventName: name };
  }
  if (name === "PostToolUse") {
    await postJson(url, token, "/observe", {
      profileId,
      role: "tool",
      content: `Claude Code tool used: ${toolName(event) ?? "unknown"}.`,
      ...(createdAt ? { createdAt } : {}),
      metadata: metadataFor(event),
    });
    return { forwarded: "observe", hookEventName: name };
  }
  if (name === "SessionStop") {
    const status = stringField(event, ["status"]) === "failed" ? "failed" : "completed";
    await postJson(url, token, "/commit-outcome", {
      profileId,
      taskId: sessionId(event),
      objective: `Claude Code session${sessionId(event) ? ` ${sessionId(event)}` : ""}`,
      status,
      summary: stringField(event, ["summary"]) ?? "Claude Code session stopped.",
      ...(createdAt ? { createdAt } : {}),
    });
    return { forwarded: "commit-outcome", hookEventName: name, status };
  }
  throw new Error(`unsupported hook event: ${name ?? "unknown"}`);
}

async function smoke() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "gmos-claude-code-adapter-"));
  const profileId = "claude-code-smoke";
  const authToken = "claude-code-local-token";
  const dbPath = path.join(tmp, "claude-code-memory.db");
  const store = createSqliteMemoryStore({ path: dbPath });
  const memory = createMemoryOS({ profileId, store });
  const server = createMemoryHttpServer({
    memory,
    store,
    profileId,
    host: "ghast",
    authToken,
  });
  const scriptPath = fileURLToPath(import.meta.url);
  const samples = [
    {
      hook_event_name: "SessionStart",
      session_id: "claude-code-alpha",
      timestamp: "2026-06-25T00:00:00.000Z",
      cwd: "/workspace/demo",
    },
    {
      hook_event_name: "PostToolUse",
      session_id: "claude-code-alpha",
      tool_name: "Read",
      timestamp: "2026-06-25T00:00:01.000Z",
    },
    {
      hook_event_name: "SessionStop",
      session_id: "claude-code-alpha",
      status: "completed",
      summary: "Session completed with gmOS memory bridge enabled.",
      timestamp: "2026-06-25T00:00:02.000Z",
    },
  ];
  try {
    const address = await server.listen({ port: 0, hostname: "127.0.0.1" });
    const env = {
      ...process.env,
      GMOS_HTTP_URL: address.url,
      GMOS_HTTP_AUTH_TOKEN: authToken,
      GMOS_PROFILE_ID: profileId,
    };
    const results = [];
    for (const sample of samples) {
      results.push(await runBridgeSample(scriptPath, env, sample));
    }
    for (const result of results) {
      assert.equal(result.status, 0, result.stderr);
    }
    const counts = await store.rowCounts();
    assert.equal(counts.gmos_evidence_events, 2);
    assert.equal(counts.gmos_task_trajectories, 1);
    await server.close();
    await memory.close();
    console.log(JSON.stringify({
      ok: true,
      url: "[local ephemeral http]",
      dbPath: "[temporary plaintext sqlite]",
      forwardedEvents: results.length,
      evidenceEvents: counts.gmos_evidence_events,
      taskTrajectories: counts.gmos_task_trajectories,
    }, null, 2));
  } finally {
    await server.close().catch(() => undefined);
    await memory.close().catch(() => undefined);
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv.includes("--smoke")) {
  await smoke();
} else {
  const result = await bridgeEvent(await readStdinJson());
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}
