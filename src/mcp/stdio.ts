import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import type { MemoryOS } from "../kernel/types.js";
import { createMemoryMcpServer, type MemoryMcpToolResult } from "./router.js";

export interface MemoryMcpStdioServerOptions {
  name?: string;
  version?: string;
}

export interface MemoryMcpStdioHandle {
  server: McpServer;
  close(): Promise<void>;
}

const roleSchema = z.enum(["system", "user", "assistant", "tool"]);
const privacyModeSchema = z.enum(["normal", "incognito"]);
const failureKindSchema = z.enum([
  "missed_recall",
  "wrong_recall",
  "privacy_leak",
  "forget_failure",
  "controller_route_error",
  "action_policy_missing",
  "task_failure",
]);
const metadataSchema = z.record(z.string(), z.unknown());

const observeSchema = z.object({
  profileId: z.string().optional(),
  conversationId: z.string().optional(),
  messageId: z.string().optional(),
  role: roleSchema.optional(),
  content: z.string().min(1),
  privacyMode: privacyModeSchema.optional(),
  createdAt: z.string().optional(),
  metadata: metadataSchema.optional(),
}).strict();

const messageSchema = z.object({
  role: roleSchema.optional(),
  content: z.string().min(1),
}).strict();

const prepareContextSchema = z.object({
  profileId: z.string().optional(),
  text: z.string().optional(),
  messages: z.array(messageSchema).optional(),
  includeEvidence: z.boolean().optional(),
  contextBudgetTokens: z.number().positive().optional(),
}).strict();

const commitOutcomeSchema = z.object({
  profileId: z.string().optional(),
  taskId: z.string().optional(),
  objective: z.string().min(1),
  status: z.enum(["completed", "failed"]),
  summary: z.string().optional(),
  createdAt: z.string().optional(),
}).strict();

const recordFeedbackSchema = z.object({
  profileId: z.string().optional(),
  content: z.string().min(1),
  failureKind: failureKindSchema.optional(),
  createdAt: z.string().optional(),
}).strict();

const forgetSchema = z.object({
  profileId: z.string().optional(),
  query: z.string().min(1),
  reason: z.string().optional(),
}).strict();

const explainBeliefSchema = z.object({
  profileId: z.string().optional(),
  id: z.string().min(1),
}).strict();

export function createMemoryMcpStdioServer(
  memory: MemoryOS,
  options: MemoryMcpStdioServerOptions = {},
): McpServer {
  const router = createMemoryMcpServer(memory);
  const server = new McpServer({
    name: options.name ?? "gmos-memory",
    version: options.version ?? "0.1.0-alpha",
  });

  server.registerTool(
    "memory.observe",
    {
      description: "Ingest a host event into gmOS.",
      inputSchema: observeSchema,
    },
    async (args) => resultToMcp(await router.callTool("memory.observe", args)),
  );

  server.registerTool(
    "memory.prepare_context",
    {
      description: "Prepare memory context for a turn.",
      inputSchema: prepareContextSchema,
    },
    async (args) => resultToMcp(await router.callTool("memory.prepare_context", args)),
  );

  server.registerTool(
    "memory.commit_outcome",
    {
      description: "Commit task outcome feedback.",
      inputSchema: commitOutcomeSchema,
    },
    async (args) => resultToMcp(await router.callTool("memory.commit_outcome", args)),
  );

  server.registerTool(
    "memory.record_feedback",
    {
      description: "Record memory feedback or correction.",
      inputSchema: recordFeedbackSchema,
    },
    async (args) => resultToMcp(await router.callTool("memory.record_feedback", args)),
  );

  server.registerTool(
    "memory.forget",
    {
      description: "Forget matching memories.",
      inputSchema: forgetSchema,
    },
    async (args) => resultToMcp(await router.callTool("memory.forget", args)),
  );

  server.registerTool(
    "memory.explain_belief",
    {
      description: "Explain a memory or belief with evidence.",
      inputSchema: explainBeliefSchema,
    },
    async (args) => resultToMcp(await router.callTool("memory.explain_belief", args)),
  );

  return server;
}

export async function serveMemoryMcpStdio(
  memory: MemoryOS,
  options: MemoryMcpStdioServerOptions = {},
): Promise<MemoryMcpStdioHandle> {
  const server = createMemoryMcpStdioServer(memory, options);
  await server.connect(new StdioServerTransport());
  return {
    server,
    close: () => server.close(),
  };
}

function resultToMcp(result: MemoryMcpToolResult): {
  content: MemoryMcpToolResult["content"];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
} {
  const output: {
    content: MemoryMcpToolResult["content"];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  } = {
    content: result.content,
  };
  if (isRecord(result.structuredContent)) {
    output.structuredContent = result.structuredContent;
  }
  if (result.isError === true) {
    output.isError = true;
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
