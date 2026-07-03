export type GmosJsonObject = Record<string, unknown>;

export type GmosFetch = (input: string, init?: RequestInit) => Promise<Response>;
export type GmosAgentRole = "system" | "user" | "assistant" | "tool";

export interface GmosAgentMessage {
  role: GmosAgentRole;
  content: string;
}

export interface GmosAgentMemoryOptions {
  profileId: string;
  disposition?: string | undefined;
}

export interface GmosAgentMemoryLoadResult {
  contextBlock: string;
  prepared: GmosJsonObject;
  memoryIds: string[];
}

export interface GmosAgentMemorySaveTurnInput {
  messages: GmosAgentMessage[];
  outcome?: {
    taskId?: string | undefined;
    objective: string;
    status: "completed" | "failed";
    summary?: string | undefined;
  } | undefined;
  usedMemoryIds?: string[] | undefined;
}

export interface GmosAgentMemoryBindings {
  loadContext(messagesOrQuery: string | GmosAgentMessage[]): Promise<GmosAgentMemoryLoadResult>;
  saveTurn(input: GmosAgentMemorySaveTurnInput): Promise<void>;
}

export interface GmosAgentMemoryClient {
  prepareTurn(input: GmosJsonObject): Promise<GmosJsonObject>;
  observe(input: GmosJsonObject): Promise<GmosJsonObject>;
  commitOutcome(input: GmosJsonObject): Promise<GmosJsonObject>;
}

export interface GmosLangChainMemoryOptions extends GmosAgentMemoryOptions {
  memoryKey?: string | undefined;
  inputKey?: string | undefined;
  outputKey?: string | undefined;
}

export interface GmosClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: GmosFetch | undefined;
  timeoutMs?: number | undefined;
  max429Retries?: number | undefined;
  maxRetryAfterMs?: number | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export class GmosClientError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly body: unknown;

  constructor(message: string, input: { status: number; code?: string | undefined; body: unknown }) {
    super(message);
    this.name = "GmosClientError";
    this.status = input.status;
    this.code = input.code;
    this.body = input.body;
  }
}

function normalizeAgentMessages(input: string | GmosAgentMessage[]): GmosAgentMessage[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  return input.map((message, index) => {
    if (!message.content.trim()) {
      throw new Error(`messages[${index}].content must be non-empty`);
    }
    return {
      role: message.role,
      content: message.content,
    };
  });
}

function memoryIdsFromPrepared(prepared: GmosJsonObject): string[] {
  const memories = prepared.memories;
  if (!Array.isArray(memories)) return [];
  return memories.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const id = (entry as { id?: unknown }).id;
    return typeof id === "string" ? [id] : [];
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function langChainMessages(
  inputValues: Record<string, unknown>,
  outputValues: Record<string, unknown> | undefined,
  options: { inputKey: string; outputKey: string },
): GmosAgentMessage[] {
  const messages: GmosAgentMessage[] = [];
  const input = stringValue(inputValues[options.inputKey]) ?? stringValue(inputValues.input);
  if (input) messages.push({ role: "user", content: input });
  const output = outputValues
    ? stringValue(outputValues[options.outputKey]) ?? stringValue(outputValues.output)
    : undefined;
  if (output) messages.push({ role: "assistant", content: output });
  return messages;
}

export function createAgentMemoryBindings(
  client: GmosAgentMemoryClient,
  options: GmosAgentMemoryOptions,
): GmosAgentMemoryBindings {
  return {
    async loadContext(messagesOrQuery) {
      const prepared = await client.prepareTurn({
        profileId: options.profileId,
        messages: normalizeAgentMessages(messagesOrQuery),
        ...(options.disposition ? { dispositionPreset: options.disposition } : {}),
      });
      return {
        contextBlock: typeof prepared.contextBlock === "string" ? prepared.contextBlock : "",
        prepared,
        memoryIds: memoryIdsFromPrepared(prepared),
      };
    },
    async saveTurn(input) {
      for (const message of input.messages) {
        await client.observe({
          profileId: options.profileId,
          role: message.role,
          content: message.content,
        });
      }
      if (!input.outcome) return;
      await client.commitOutcome({
        profileId: options.profileId,
        ...input.outcome,
        ...(input.usedMemoryIds ? { usedMemoryIds: input.usedMemoryIds } : {}),
      });
    },
  };
}

export class GmosLangChainMemory {
  readonly memoryKey: string;
  private readonly inputKey: string;
  private readonly outputKey: string;
  private readonly bindings: GmosAgentMemoryBindings;

  constructor(client: GmosAgentMemoryClient, options: GmosLangChainMemoryOptions) {
    this.memoryKey = options.memoryKey ?? "gmos_context";
    this.inputKey = options.inputKey ?? "input";
    this.outputKey = options.outputKey ?? "output";
    this.bindings = createAgentMemoryBindings(client, options);
  }

  async loadMemoryVariables(values: Record<string, unknown> = {}): Promise<Record<string, string>> {
    const query = stringValue(values[this.inputKey]) ?? stringValue(values.input) ?? "";
    const loaded = await this.bindings.loadContext(query);
    return { [this.memoryKey]: loaded.contextBlock };
  }

  async saveContext(
    inputValues: Record<string, unknown>,
    outputValues: Record<string, unknown> = {},
  ): Promise<void> {
    const messages = langChainMessages(inputValues, outputValues, {
      inputKey: this.inputKey,
      outputKey: this.outputKey,
    });
    if (messages.length === 0) return;
    await this.bindings.saveTurn({ messages });
  }
}

export const GMOS_CLIENT_METHOD_ROUTES = {
  health: "GET /health",
  healthz: "GET /healthz",
  runtimeInfo: "GET /runtime-info",
  tools: "GET /tools",
  status: "GET /status",
  openapi: "GET /openapi.json",
  profilesList: "GET /profiles",
  profilesCreate: "POST /profiles",
  keysList: "GET /keys",
  evolutionReview: "GET /evolution/review",
  add: "POST /add",
  search: "POST /search",
  observe: "POST /observe",
  prepareTurn: "POST /prepare",
  explainTurn: "POST /explain-turn",
  reconstructContext: "POST /reconstruct",
  explainPath: "POST /explain-path",
  commitOutcome: "POST /commit-outcome",
  recordFeedback: "POST /feedback",
  maintain: "POST /maintain",
  forget: "POST /forget",
  explain: "POST /explain",
  mcpCall: "POST /mcp/call",
} as const;

function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/u, "");
  if (!normalized) throw new Error("baseUrl is required");
  return normalized;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(header: string | null, maxMs: number): number {
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(maxMs, Math.ceil(seconds * 1000));
  }
  const timestamp = Date.parse(header);
  if (Number.isNaN(timestamp)) return 0;
  return Math.min(maxMs, Math.max(0, timestamp - Date.now()));
}

function errorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") return fallback;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : fallback;
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  return JSON.parse(text) as unknown;
}

export class GmosClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: GmosFetch;
  private readonly timeoutMs: number | undefined;
  private readonly max429Retries: number;
  private readonly maxRetryAfterMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(input: GmosClientOptions) {
    this.baseUrl = normalizeBaseUrl(input.baseUrl);
    if (!input.apiKey) throw new Error("apiKey is required");
    this.apiKey = input.apiKey;
    const fetchImpl = input.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) throw new Error("fetch is unavailable; pass fetchImpl");
    this.fetchImpl = fetchImpl.bind(globalThis) as GmosFetch;
    this.timeoutMs = input.timeoutMs;
    this.max429Retries = input.max429Retries ?? 1;
    this.maxRetryAfterMs = input.maxRetryAfterMs ?? 5_000;
    this.sleep = input.sleep ?? defaultSleep;
  }

  private async request(
    method: "GET" | "POST",
    pathname: string,
    input: { body?: GmosJsonObject | undefined; query?: Record<string, string | undefined> | undefined } = {},
  ): Promise<GmosJsonObject> {
    const url = new URL(`${this.baseUrl}${pathname}`);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
    };
    let body: string | undefined;
    if (method === "POST") {
      headers["content-type"] = "application/json";
      body = JSON.stringify(input.body ?? {});
    }
    for (let attempt = 0; ; attempt += 1) {
      const controller =
        this.timeoutMs === undefined ? undefined : new AbortController();
      const timer =
        controller && this.timeoutMs !== undefined
          ? setTimeout(() => controller.abort(), this.timeoutMs)
          : undefined;
      try {
        const init: RequestInit = {
          method,
          headers,
        };
        if (body !== undefined) init.body = body;
        if (controller) init.signal = controller.signal;
        const response = await this.fetchImpl(url.toString(), init);
        if (response.status === 429 && attempt < this.max429Retries) {
          await this.sleep(retryAfterMs(response.headers.get("retry-after"), this.maxRetryAfterMs));
          continue;
        }
        const payload = await responseJson(response);
        if (!response.ok) {
          throw new GmosClientError(
            errorMessage(payload, `gmOS request failed with status ${response.status}`),
            { status: response.status, code: errorCode(payload), body: payload },
          );
        }
        return payload as GmosJsonObject;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  }

  health(): Promise<GmosJsonObject> {
    return this.request("GET", "/health");
  }

  healthz(): Promise<GmosJsonObject> {
    return this.request("GET", "/healthz");
  }

  runtimeInfo(): Promise<GmosJsonObject> {
    return this.request("GET", "/runtime-info");
  }

  tools(): Promise<GmosJsonObject> {
    return this.request("GET", "/tools");
  }

  status(input: { profileId?: string | undefined } = {}): Promise<GmosJsonObject> {
    return this.request("GET", "/status", { query: { profileId: input.profileId } });
  }

  openapi(): Promise<GmosJsonObject> {
    return this.request("GET", "/openapi.json");
  }

  profilesList(): Promise<GmosJsonObject> {
    return this.request("GET", "/profiles");
  }

  profilesCreate(profileId: string): Promise<GmosJsonObject> {
    return this.request("POST", "/profiles", { body: { profileId } });
  }

  keysList(): Promise<GmosJsonObject> {
    return this.request("GET", "/keys");
  }

  evolutionReview(input: {
    profileId?: string | undefined;
    failureKind?: string | undefined;
    limit?: number | undefined;
  } = {}): Promise<GmosJsonObject> {
    return this.request("GET", "/evolution/review", {
      query: {
        profileId: input.profileId,
        failureKind: input.failureKind,
        limit: input.limit === undefined ? undefined : String(input.limit),
      },
    });
  }

  add(input: GmosJsonObject): Promise<GmosJsonObject> {
    return this.request("POST", "/add", { body: input });
  }

  search(input: GmosJsonObject): Promise<GmosJsonObject> {
    return this.request("POST", "/search", { body: input });
  }

  observe(input: GmosJsonObject): Promise<GmosJsonObject> {
    return this.request("POST", "/observe", { body: input });
  }

  prepareTurn(input: GmosJsonObject): Promise<GmosJsonObject> {
    return this.request("POST", "/prepare", { body: input });
  }

  explainTurn(input: GmosJsonObject): Promise<GmosJsonObject> {
    return this.request("POST", "/explain-turn", { body: input });
  }

  reconstructContext(input: GmosJsonObject): Promise<GmosJsonObject> {
    return this.request("POST", "/reconstruct", { body: input });
  }

  explainPath(input: GmosJsonObject): Promise<GmosJsonObject> {
    return this.request("POST", "/explain-path", { body: input });
  }

  commitOutcome(input: GmosJsonObject): Promise<GmosJsonObject> {
    return this.request("POST", "/commit-outcome", { body: input });
  }

  recordFeedback(input: GmosJsonObject): Promise<GmosJsonObject> {
    return this.request("POST", "/feedback", { body: input });
  }

  maintain(input: GmosJsonObject): Promise<GmosJsonObject> {
    return this.request("POST", "/maintain", { body: input });
  }

  forget(input: GmosJsonObject): Promise<GmosJsonObject> {
    return this.request("POST", "/forget", { body: input });
  }

  explain(input: GmosJsonObject): Promise<GmosJsonObject> {
    return this.request("POST", "/explain", { body: input });
  }

  mcpCall(tool: string, args: GmosJsonObject = {}): Promise<GmosJsonObject> {
    return this.request("POST", "/mcp/call", { body: { tool, args } });
  }
}

export function createGmosClient(input: GmosClientOptions): GmosClient {
  return new GmosClient(input);
}
