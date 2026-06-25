import type {
  CommitOutcomeInput,
  FailureKind,
  FeedbackInput,
  ForgetInput,
  HostEvent,
  MemoryOS,
  MemoryRole,
  PrepareTurnInput,
  PrivacyMode,
  TurnMessage,
} from "../kernel/types.js";
import { listMemoryMcpTools, type MemoryMcpTool, type MemoryMcpToolName } from "./tools.js";

export { listMemoryMcpTools };
export type { MemoryMcpJsonSchema, MemoryMcpTool, MemoryMcpToolName } from "./tools.js";

export interface MemoryMcpTextContent {
  type: "text";
  text: string;
}

export interface MemoryMcpToolResult {
  content: MemoryMcpTextContent[];
  structuredContent: unknown;
  isError?: boolean;
}

export interface MemoryMcpServer {
  tools: MemoryMcpTool[];
  status: "ready";
  listTools(): MemoryMcpTool[];
  callTool(name: string, args?: unknown): Promise<MemoryMcpToolResult>;
}

const TOOL_NAMES = new Set(listMemoryMcpTools().map((tool) => tool.name));
const ROLES = new Set<MemoryRole>(["system", "user", "assistant", "tool"]);
const PRIVACY_MODES = new Set<PrivacyMode>(["normal", "incognito"]);
const FAILURE_KINDS = new Set<FailureKind>([
  "missed_recall",
  "wrong_recall",
  "privacy_leak",
  "forget_failure",
  "controller_route_error",
  "action_policy_missing",
  "task_failure",
]);

function objectArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("MCP tool arguments must be an object");
  }
  return args as Record<string, unknown>;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

function optionalPositiveNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive number`);
  }
  return value;
}

function optionalMetadata(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = args.metadata;
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("metadata must be an object");
  }
  return value as Record<string, unknown>;
}

function optionalRole(args: Record<string, unknown>): MemoryRole {
  const value = args.role;
  if (value === undefined) return "user";
  if (typeof value !== "string" || !ROLES.has(value as MemoryRole)) {
    throw new Error("role must be one of: system, user, assistant, tool");
  }
  return value as MemoryRole;
}

function optionalPrivacyMode(args: Record<string, unknown>): PrivacyMode | undefined {
  const value = args.privacyMode;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !PRIVACY_MODES.has(value as PrivacyMode)) {
    throw new Error("privacyMode must be one of: normal, incognito");
  }
  return value as PrivacyMode;
}

function optionalFailureKind(args: Record<string, unknown>): FailureKind | undefined {
  const value = args.failureKind;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !FAILURE_KINDS.has(value as FailureKind)) {
    throw new Error("failureKind is not supported");
  }
  return value as FailureKind;
}

function statusArg(args: Record<string, unknown>): CommitOutcomeInput["status"] {
  const value = args.status;
  if (value !== "completed" && value !== "failed") {
    throw new Error("status must be completed or failed");
  }
  return value;
}

function messagesArg(args: Record<string, unknown>): TurnMessage[] {
  const text = optionalString(args, "text");
  if (text) return [{ role: "user", content: text }];
  const messages = args.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("memory.prepare_context requires text or messages");
  }
  return messages.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`messages[${index}] must be an object`);
    }
    const item = entry as Record<string, unknown>;
    const role = item.role === undefined ? "user" : item.role;
    if (typeof role !== "string" || !ROLES.has(role as MemoryRole)) {
      throw new Error(`messages[${index}].role is not supported`);
    }
    if (typeof item.content !== "string" || item.content.trim().length === 0) {
      throw new Error(`messages[${index}].content must be a non-empty string`);
    }
    return { role: role as MemoryRole, content: item.content };
  });
}

function observeEvent(args: Record<string, unknown>): HostEvent {
  const event: HostEvent = {
    type: "conversation.message",
    role: optionalRole(args),
    content: requiredString(args, "content"),
  };
  const profileId = optionalString(args, "profileId");
  const conversationId = optionalString(args, "conversationId");
  const messageId = optionalString(args, "messageId");
  const privacyMode = optionalPrivacyMode(args);
  const createdAt = optionalString(args, "createdAt");
  const metadata = optionalMetadata(args);
  if (profileId !== undefined) event.profileId = profileId;
  if (conversationId !== undefined) event.conversationId = conversationId;
  if (messageId !== undefined) event.messageId = messageId;
  if (privacyMode !== undefined) event.privacyMode = privacyMode;
  if (createdAt !== undefined) event.createdAt = createdAt;
  if (metadata !== undefined) event.metadata = metadata;
  return event;
}

function prepareInput(args: Record<string, unknown>): PrepareTurnInput {
  if (args.includeSensitive !== undefined) {
    throw new Error("memory.prepare_context does not allow includeSensitive over MCP");
  }
  const input: PrepareTurnInput = {
    messages: messagesArg(args),
  };
  const profileId = optionalString(args, "profileId");
  const includeEvidence = optionalBoolean(args, "includeEvidence");
  const contextBudgetTokens = optionalPositiveNumber(args, "contextBudgetTokens");
  if (profileId !== undefined) input.profileId = profileId;
  if (includeEvidence !== undefined) input.includeEvidence = includeEvidence;
  if (contextBudgetTokens !== undefined) input.contextBudgetTokens = contextBudgetTokens;
  return input;
}

function outcomeInput(args: Record<string, unknown>): CommitOutcomeInput {
  const input: CommitOutcomeInput = {
    objective: requiredString(args, "objective"),
    status: statusArg(args),
  };
  const profileId = optionalString(args, "profileId");
  const taskId = optionalString(args, "taskId");
  const summary = optionalString(args, "summary");
  const createdAt = optionalString(args, "createdAt");
  if (profileId !== undefined) input.profileId = profileId;
  if (taskId !== undefined) input.taskId = taskId;
  if (summary !== undefined) input.summary = summary;
  if (createdAt !== undefined) input.createdAt = createdAt;
  return input;
}

function feedbackInput(args: Record<string, unknown>): FeedbackInput {
  const input: FeedbackInput = {
    content: requiredString(args, "content"),
  };
  const profileId = optionalString(args, "profileId");
  const failureKind = optionalFailureKind(args);
  const createdAt = optionalString(args, "createdAt");
  if (profileId !== undefined) input.profileId = profileId;
  if (failureKind !== undefined) input.failureKind = failureKind;
  if (createdAt !== undefined) input.createdAt = createdAt;
  return input;
}

function forgetInput(args: Record<string, unknown>): ForgetInput {
  const input: ForgetInput = {
    query: requiredString(args, "query"),
  };
  const profileId = optionalString(args, "profileId");
  const reason = optionalString(args, "reason");
  if (profileId !== undefined) input.profileId = profileId;
  if (reason !== undefined) input.reason = reason;
  return input;
}

function ok(structuredContent: Record<string, unknown>): MemoryMcpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

function errorResult(error: unknown): MemoryMcpToolResult {
  const structuredContent = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    isError: true,
  };
}

export function createMemoryMcpServer(memory: MemoryOS): MemoryMcpServer {
  async function callTool(name: string, args: unknown = {}): Promise<MemoryMcpToolResult> {
    try {
      if (!TOOL_NAMES.has(name as MemoryMcpToolName)) {
        throw new Error(`Unknown gmOS MCP tool: ${name}`);
      }
      const object = objectArgs(args);
      if (name === "memory.observe") {
        await memory.observe(observeEvent(object));
        return ok({ ok: true });
      }
      if (name === "memory.prepare_context") {
        return ok({ ok: true, prepared: await memory.prepareTurn(prepareInput(object)) });
      }
      if (name === "memory.commit_outcome") {
        await memory.commitOutcome(outcomeInput(object));
        return ok({ ok: true });
      }
      if (name === "memory.record_feedback") {
        await memory.recordFeedback(feedbackInput(object));
        return ok({ ok: true });
      }
      if (name === "memory.forget") {
        return ok({ ok: true, result: await memory.forget(forgetInput(object)) });
      }
      const id = requiredString(object, "id");
      return ok({
        ok: true,
        explanation: await memory.explain(id, optionalString(object, "profileId")),
      });
    } catch (error) {
      return errorResult(error);
    }
  }

  return {
    tools: listMemoryMcpTools(),
    status: "ready",
    listTools: listMemoryMcpTools,
    callTool,
  };
}
