export type MemoryMcpToolName =
  | "memory.observe"
  | "memory.prepare_context"
  | "memory.commit_outcome"
  | "memory.record_feedback"
  | "memory.forget"
  | "memory.explain_belief";

export interface MemoryMcpJsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface MemoryMcpTool {
  name: MemoryMcpToolName;
  description: string;
  inputSchema: MemoryMcpJsonSchema;
}

export function listMemoryMcpTools(): MemoryMcpTool[] {
  return [
    {
      name: "memory.observe",
      description: "Ingest a host event into gmOS.",
      inputSchema: {
        type: "object",
        required: ["content"],
        additionalProperties: true,
        properties: {
          profileId: { type: "string" },
          conversationId: { type: "string" },
          messageId: { type: "string" },
          role: { type: "string", enum: ["system", "user", "assistant", "tool"] },
          content: { type: "string" },
          privacyMode: { type: "string", enum: ["normal", "incognito"] },
          createdAt: { type: "string" },
          metadata: { type: "object" },
        },
      },
    },
    {
      name: "memory.prepare_context",
      description: "Prepare memory context for a turn.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          profileId: { type: "string" },
          text: { type: "string" },
          messages: { type: "array" },
          includeEvidence: { type: "boolean" },
          contextBudgetTokens: { type: "number" },
        },
      },
    },
    {
      name: "memory.commit_outcome",
      description: "Commit task outcome feedback.",
      inputSchema: {
        type: "object",
        required: ["objective", "status"],
        additionalProperties: false,
        properties: {
          profileId: { type: "string" },
          taskId: { type: "string" },
          objective: { type: "string" },
          status: { type: "string", enum: ["completed", "failed"] },
          summary: { type: "string" },
          createdAt: { type: "string" },
        },
      },
    },
    {
      name: "memory.record_feedback",
      description: "Record memory feedback or correction.",
      inputSchema: {
        type: "object",
        required: ["content"],
        additionalProperties: false,
        properties: {
          profileId: { type: "string" },
          content: { type: "string" },
          failureKind: { type: "string" },
          createdAt: { type: "string" },
        },
      },
    },
    {
      name: "memory.forget",
      description: "Forget matching memories.",
      inputSchema: {
        type: "object",
        required: ["query"],
        additionalProperties: false,
        properties: {
          profileId: { type: "string" },
          query: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    {
      name: "memory.explain_belief",
      description: "Explain a memory or belief with evidence.",
      inputSchema: {
        type: "object",
        required: ["id"],
        additionalProperties: false,
        properties: {
          profileId: { type: "string" },
          id: { type: "string" },
        },
      },
    },
  ];
}
