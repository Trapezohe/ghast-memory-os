import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { OpenAICompatibleFetch } from "../intelligence/index.js";
import {
  OPENAI_COMPATIBLE_CACHE_REFRESH,
  openAICompatibleTruncatedFinishReasons,
} from "../kernel/openai-compatible-response.js";

const LLM_RESPONSE_CACHE_VERSION = 2;

interface ExternalBenchmarkLlmResponseCacheCounters {
  hits: number;
  misses: number;
  writes: number;
  bypasses: number;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function privateDirectory(directoryPath: string): boolean {
  try {
    const stat = lstatSync(directoryPath);
    return stat.isDirectory() && !stat.isSymbolicLink() &&
      (process.platform === "win32" || (stat.mode & 0o777) === 0o700);
  } catch {
    return false;
  }
}

function ensurePrivateDirectory(directoryPath: string): void {
  if (!existsSync(directoryPath)) mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  if (!privateDirectory(directoryPath)) {
    throw new Error("External benchmark LLM response cache directories must be private (mode 0700)");
  }
}

function privateRegularFile(filePath: string): boolean {
  try {
    const stat = lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 &&
      (process.platform === "win32" || (stat.mode & 0o777) === 0o600);
  } catch {
    return false;
  }
}

function fsyncPath(filePath: string): void {
  const fd = openSync(filePath, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readEntry(filePath: string): string | null {
  try {
    if (!privateDirectory(path.dirname(filePath)) || !privateRegularFile(filePath)) return null;
    const raw = readFileSync(filePath, "utf8");
    JSON.parse(raw);
    return raw;
  } catch {
    return null;
  }
}

function writeEntry(filePath: string, raw: string): boolean {
  const directory = path.dirname(filePath);
  const tempFile = path.join(directory, `${path.basename(filePath)}.${process.pid}-${randomUUID()}.tmp`);
  try {
    ensurePrivateDirectory(directory);
    writeFileSync(tempFile, raw, { flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") chmodSync(tempFile, 0o600);
    fsyncPath(tempFile);
    renameSync(tempFile, filePath);
    if (process.platform !== "win32") {
      chmodSync(filePath, 0o600);
      fsyncPath(directory);
    }
    return true;
  } catch {
    rmSync(tempFile, { force: true });
    return false;
  }
}

function eligibleRequest(init: RequestInit | undefined): {
  body: string;
  model: string;
} | null {
  if ((init?.method ?? "GET").toUpperCase() !== "POST" || typeof init?.body !== "string") return null;
  try {
    const parsed = JSON.parse(init.body) as Record<string, unknown>;
    return typeof parsed.model === "string" && Array.isArray(parsed.messages) &&
        parsed.temperature === 0 && (parsed.stream === undefined || parsed.stream === false)
      ? { body: init.body, model: parsed.model }
      : null;
  } catch {
    return null;
  }
}

export function createExternalBenchmarkLlmResponseCache(directoryPath: string): {
  dir: string;
  counters: ExternalBenchmarkLlmResponseCacheCounters;
  run<T>(enabled: boolean, task: () => Promise<T>): Promise<T>;
  wrap(fetchImpl: OpenAICompatibleFetch): OpenAICompatibleFetch;
} {
  const dir = path.resolve(directoryPath);
  const versionDir = path.join(dir, `v${LLM_RESPONSE_CACHE_VERSION}`);
  ensurePrivateDirectory(dir);
  ensurePrivateDirectory(versionDir);
  const counters: ExternalBenchmarkLlmResponseCacheCounters = {
    hits: 0,
    misses: 0,
    writes: 0,
    bypasses: 0,
  };
  const enabledForGroup = new AsyncLocalStorage<boolean>();
  return {
    dir,
    counters,
    run(enabled, task) {
      return enabledForGroup.run(enabled, task);
    },
    wrap(fetchImpl) {
      return async (input, init) => {
        if (enabledForGroup.getStore() === false) return fetchImpl(input, init);
        const request = eligibleRequest(init);
        if (!request) {
          counters.bypasses += 1;
          return fetchImpl(input, init);
        }
        const key = createHash("sha256").update(canonicalJson({
          version: LLM_RESPONSE_CACHE_VERSION,
          operation: "chat.completions",
          model: request.model,
          body: request.body,
        })).digest("hex");
        const filePath = path.join(versionDir, key.slice(0, 2), `${key}.json`);
        // Identical cache contract + chat.completions operation + identical model
        // string + byte-identical request body returns the raw HTTP 200 completion
        // previously observed for that tuple; it does not claim the provider would
        // produce the same result today.
        const refresh = (init as RequestInit & {
          [OPENAI_COMPATIBLE_CACHE_REFRESH]?: boolean;
        } | undefined)?.[OPENAI_COMPATIBLE_CACHE_REFRESH] === true;
        if (!refresh) {
          const cached = readEntry(filePath);
          if (cached !== null) {
            counters.hits += 1;
            return { ok: true, status: 200, statusText: "OK", text: async () => cached };
          }
        }
        counters.misses += 1;
        const response = await fetchImpl(input, init);
        if (!response.ok || response.status !== 200) return response;
        const raw = await response.text();
        try {
          const completion = JSON.parse(raw) as unknown;
          if (
            openAICompatibleTruncatedFinishReasons(completion).length === 0 &&
            writeEntry(filePath, raw)
          ) counters.writes += 1;
        } catch {
          // A syntactically invalid outer completion remains a live response only.
        }
        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          ...(response.headers ? { headers: response.headers } : {}),
          text: async () => raw,
        };
      };
    },
  };
}
