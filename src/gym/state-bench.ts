import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { redactForReport } from "../kernel/safety.js";

export interface StateBenchLearning {
  id: string;
  domain: string;
  content: string;
  sourceFile: string;
  toolSequence: string[];
  queryHint: string;
}

export interface StateBenchLearningsArtifact {
  schema: "gmos.state_bench_learnings.v1";
  framework: "state-bench-agent-learning-track";
  domain: string;
  source: {
    protocol: "state-bench-agent-learning-track";
    input: "datasets/train_task_trajectories";
    domain: string;
  };
  itemCount: number;
  warnings: string[];
  learnings: StateBenchLearning[];
}

export interface BuildStateBenchLearningsOptions {
  domain: string;
  inputDir: string;
  maxContentChars?: number | undefined;
  maxItems?: number | undefined;
  allowNonTrainInput?: boolean | undefined;
}

interface ToolCallSummary {
  name: string;
  marker: string;
}

const DEFAULT_MAX_CONTENT_CHARS = 520;

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function cleanText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function publicText(value: string): string {
  return redactForReport(cleanText(value));
}

function clip(text: string, limit: number): string {
  const normalized = publicText(text);
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 1))}...`;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function jsonFiles(inputDir: string): string[] {
  return readdirSync(inputDir)
    .filter((entry) => entry.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => path.join(inputDir, entry));
}

function conversationFromFile(filePath: string): Record<string, unknown>[] | null {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  const record = assertRecord(parsed, "STATE-Bench trajectory");
  return Array.isArray(record.conversation)
    ? record.conversation
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    : null;
}

function assertTrainTrajectoryInput(inputDir: string, domain: string, allowNonTrainInput: boolean): void {
  if (allowNonTrainInput) return;
  const normalized = inputDir.split(path.sep).join("/");
  const suffix = `datasets/train_task_trajectories/${domain}`;
  if (!normalized.endsWith(suffix)) {
    throw new Error(
      "STATE-Bench learnings must be built from datasets/train_task_trajectories/<domain>; pass allowNonTrainInput only for isolated fixtures",
    );
  }
}

function queryHintForTrajectory(id: string): string {
  const tokens = id
    .split(/[^A-Za-z0-9]+/u)
    .map((token) => token.toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(tokens)).slice(0, 10).join(" ");
}

function invalidTrajectoryCode(error: unknown): string {
  return error instanceof SyntaxError ? "parse_error" : "invalid_trajectory";
}

function toolCalls(conversation: Record<string, unknown>[]): ToolCallSummary[] {
  const calls: ToolCallSummary[] = [];
  for (const message of conversation) {
    const rawCalls = message.tool_calls;
    if (!Array.isArray(rawCalls)) continue;
    for (const call of rawCalls) {
      if (!call || typeof call !== "object" || Array.isArray(call)) continue;
      const record = call as Record<string, unknown>;
      const name = stringValue(record.name);
      if (!name) continue;
      const args =
        record.arguments && typeof record.arguments === "object" && !Array.isArray(record.arguments)
          ? (record.arguments as Record<string, unknown>)
          : {};
      let marker = "";
      if (args.confirm === false) marker = "preview";
      if (args.confirm === true) marker = "confirmed";
      calls.push({ name, marker });
    }
  }
  return calls;
}

function toolSequenceSummary(calls: ToolCallSummary[]): string {
  return calls
    .map((call) => (call.marker ? `${call.name}(${call.marker})` : call.name))
    .join(" -> ");
}

function learningFromTrajectory(input: {
  domain: string;
  filePath: string;
  inputDir: string;
  conversation: Record<string, unknown>[];
  maxContentChars: number;
}): StateBenchLearning | null {
  const calls = toolCalls(input.conversation);
  if (calls.length === 0) return null;
  const toolSequence = toolSequenceSummary(calls);
  const id = path.basename(input.filePath, ".json");
  const queryHint = queryHintForTrajectory(id);
  const content = clip(
    [
      `Domain: ${input.domain}.`,
      queryHint ? `Task cue: ${queryHint}.` : "",
      `Useful procedure from prior successful train trajectory: ${toolSequence}.`,
      "Use domain lookup tools before acting, preview fees or irreversible changes when available, ask for missing choices, and get explicit confirmation before mutating bookings, orders, carts, refunds, or account state.",
    ]
      .filter(Boolean)
      .join(" "),
    input.maxContentChars,
  );
  return {
    id,
    domain: input.domain,
    content,
    sourceFile: path.relative(input.inputDir, input.filePath),
    toolSequence: calls.map((call) => (call.marker ? `${call.name}(${call.marker})` : call.name)),
    queryHint,
  };
}

export function buildStateBenchLearnings(
  options: BuildStateBenchLearningsOptions,
): StateBenchLearningsArtifact {
  const domain = cleanText(options.domain);
  if (!domain) throw new Error("STATE-Bench learnings require a domain");
  const inputDir = path.resolve(options.inputDir);
  assertTrainTrajectoryInput(inputDir, domain, options.allowNonTrainInput === true);
  const maxContentChars = Math.max(120, Math.trunc(options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS));
  const maxItems =
    options.maxItems === undefined ? Number.POSITIVE_INFINITY : Math.max(1, Math.trunc(options.maxItems));
  const warnings: string[] = [];
  const learnings: StateBenchLearning[] = [];
  for (const filePath of jsonFiles(inputDir)) {
    if (learnings.length >= maxItems) break;
    try {
      const conversation = conversationFromFile(filePath);
      if (!conversation) {
        warnings.push(`skipped_no_conversation:${path.basename(filePath)}`);
        continue;
      }
      const learning = learningFromTrajectory({
        domain,
        filePath,
        inputDir,
        conversation,
        maxContentChars,
      });
      if (!learning) {
        warnings.push(`skipped_no_tool_calls:${path.basename(filePath)}`);
        continue;
      }
      learnings.push(learning);
    } catch (error) {
      warnings.push(`skipped_invalid_json:${path.basename(filePath)}:${invalidTrajectoryCode(error)}`);
    }
  }
  if (learnings.length === 0) {
    throw new Error("STATE-Bench learnings builder found no train trajectories with tool calls");
  }
  return {
    schema: "gmos.state_bench_learnings.v1",
    framework: "state-bench-agent-learning-track",
    domain,
    source: {
      protocol: "state-bench-agent-learning-track",
      input: "datasets/train_task_trajectories",
      domain,
    },
    itemCount: learnings.length,
    warnings,
    learnings,
  };
}

export function stateBenchAgentPythonTemplate(): string {
  return `"""gmOS memory hook for STATE-Bench Agent Learning Track.

Copy this file into a STATE-Bench checkout's agents/ directory and run with:
  --agent-class GmosMemoryAgent --retrieve-learnings-top-k 3

The default mode is offline and reads a gmOS-generated learnings artifact.
Set GMOS_STATE_BENCH_USE_HTTP=1 to query a running gmOS/Ghast memory endpoint
that returns objects with content/text/learning fields.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from urllib import error, request

from state_bench.agents.state_bench import StateBenchAgent

DEFAULT_TOP_K = 3
TOKEN_RE = re.compile(r"[\\w.-]+", re.UNICODE)


def _tokens(text: str) -> set[str]:
    return {token.lower() for token in TOKEN_RE.findall(text or "")}


def _learning_text(item: object) -> str:
    if isinstance(item, str):
        return item
    if isinstance(item, dict):
        value = item.get("content") or item.get("text") or item.get("learning")
        if isinstance(value, str):
            return value
    return ""


def _learning_items(payload: object) -> list[object]:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        value = (
            payload.get("learnings")
            or payload.get("items")
            or payload.get("results")
            or payload.get("memories")
        )
        if isinstance(value, list):
            return value
    return []


class GmosMemoryAgent(StateBenchAgent):
    """StateBenchAgent with a read-only gmOS learning retrieval hook."""

    def _artifact_path(self) -> Path:
        explicit = os.environ.get("GMOS_STATE_BENCH_LEARNINGS_PATH")
        if explicit:
            return Path(explicit)
        domain = self.runtime_context.domain if self.runtime_context else "travel"
        return Path("outputs/gmos-learnings") / f"{domain}.json"

    def _artifact_learnings(self, query: str, top_k: int) -> list[str]:
        path = self._artifact_path()
        if not path.exists():
            return []
        payload = json.loads(path.read_text())
        query_tokens = _tokens(query)
        domain = self.runtime_context.domain if self.runtime_context else ""
        ranked: list[tuple[int, str]] = []
        for item in _learning_items(payload):
            text = _learning_text(item)
            if not text:
                continue
            score = len(query_tokens & _tokens(text))
            if isinstance(item, dict) and item.get("domain") == domain:
                score += 2
            ranked.append((score, text))
        ranked.sort(key=lambda row: row[0], reverse=True)
        return [text for score, text in ranked[:top_k] if score > 0] or [
            text for _, text in ranked[:top_k]
        ]

    def _http_learnings(self, query: str, top_k: int) -> list[str]:
        base_url = os.environ.get("GMOS_STATE_BENCH_HTTP_URL", "http://localhost:4787").rstrip("/")
        body = json.dumps({"query": query, "limit": top_k}).encode("utf-8")
        req = request.Request(
            f"{base_url}/search",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with request.urlopen(req, timeout=5) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        return [_learning_text(item) for item in _learning_items(payload) if _learning_text(item)][:top_k]

    def retrieve_learnings(self, query: str, top_k: int = DEFAULT_TOP_K) -> list[str]:
        top_k = max(1, int(top_k or DEFAULT_TOP_K))
        if os.environ.get("GMOS_STATE_BENCH_USE_HTTP") == "1":
            try:
                return self._http_learnings(query, top_k)
            except (OSError, error.URLError, json.JSONDecodeError):
                if os.environ.get("GMOS_STATE_BENCH_REQUIRE_HTTP") == "1":
                    raise
        return self._artifact_learnings(query, top_k)
`;
}
