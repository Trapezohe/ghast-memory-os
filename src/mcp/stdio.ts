import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { readGmosPackageInfo } from "../kernel/package-info.js";
import type { MemoryOS } from "../kernel/types.js";
import { createMemoryMcpServer, type MemoryMcpToolResult } from "./router.js";
import { listMemoryMcpTools, type MemoryMcpToolName } from "./tools.js";

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
const publicAddKindSchema = z.enum([
  "fact",
  "preference",
  "boundary",
  "procedure",
  "project",
  "task_trajectory",
]);
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

const addSchema = z.object({
  profileId: z.string().optional(),
  kind: publicAddKindSchema,
  scope: z.string().optional(),
  content: z.string().min(1),
  confidence: z.number().positive().max(1).optional(),
}).strict();

const searchSchema = z.object({
  profileId: z.string().optional(),
  query: z.string().optional(),
  limit: z.number().int().positive().optional(),
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

const reconstructContextSchema = z.object({
  profileId: z.string().optional(),
  text: z.string().optional(),
  messages: z.array(messageSchema).optional(),
  includeEvidence: z.boolean().optional(),
  contextBudgetTokens: z.number().positive().optional(),
  maxSteps: z.number().int().positive().optional(),
  maxBranch: z.number().int().positive().optional(),
  maxMemories: z.number().int().positive().optional(),
  stopWhenEvidenceEnough: z.boolean().optional(),
  evidenceConvergenceThreshold: z.number().positive().optional(),
  includeTemporalMetadata: z.boolean().optional(),
}).strict();

const explainEvidencePathSchema = z.object({
  profileId: z.string().optional(),
  text: z.string().optional(),
  messages: z.array(messageSchema).optional(),
  includeEvidence: z.boolean().optional(),
  includePlannerTrace: z.boolean().optional(),
  contextBudgetTokens: z.number().positive().optional(),
  maxSteps: z.number().int().positive().optional(),
  maxBranch: z.number().int().positive().optional(),
  maxMemories: z.number().int().positive().optional(),
  stopWhenEvidenceEnough: z.boolean().optional(),
  evidenceConvergenceThreshold: z.number().positive().optional(),
  includeTemporalMetadata: z.boolean().optional(),
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

const STDIO_TOOL_SCHEMAS: Record<MemoryMcpToolName, z.ZodObject> = {
  "memory.add": addSchema,
  "memory.search": searchSchema,
  "memory.observe": observeSchema,
  "memory.prepare_context": prepareContextSchema,
  "memory.reconstruct_context": reconstructContextSchema,
  "memory.explain_evidence_path": explainEvidencePathSchema,
  "memory.commit_outcome": commitOutcomeSchema,
  "memory.record_feedback": recordFeedbackSchema,
  "memory.forget": forgetSchema,
  "memory.explain_belief": explainBeliefSchema,
};

export function createMemoryMcpStdioServer(
  memory: MemoryOS,
  options: MemoryMcpStdioServerOptions = {},
): McpServer {
  const router = createMemoryMcpServer(memory);
  const server = new McpServer({
    name: options.name ?? "gmos-memory",
    version: options.version ?? readGmosPackageInfo().version,
  });

  for (const tool of listMemoryMcpTools()) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: STDIO_TOOL_SCHEMAS[tool.name],
      },
      async (args) => resultToMcp(await router.callTool(tool.name, args)),
    );
  }

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
