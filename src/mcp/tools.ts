import {
  PUBLIC_MEMORY_MCP_TOOL_NAMES,
  type PublicMemoryMcpToolName,
} from "./public-surface.js";

export type MemoryMcpToolName = PublicMemoryMcpToolName;

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

const RECONSTRUCTION_INTENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    expectedTags: { type: "array", items: { type: "string" } },
    queryCues: { type: "array", items: { type: "string" } },
    requiredTagGroups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["tags"],
        properties: {
          name: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

const PREPARE_RECONSTRUCTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["mode"],
  properties: {
    mode: { type: "string", enum: ["shadow"] },
    maxSteps: { type: "integer", minimum: 1 },
    maxBranch: { type: "integer", minimum: 1 },
    maxMemories: { type: "integer", minimum: 1 },
    stopWhenEvidenceEnough: { type: "boolean" },
    evidenceConvergenceThreshold: { type: "number", exclusiveMinimum: 0 },
    includeTemporalMetadata: { type: "boolean" },
    temporalMode: { type: "string", enum: ["auto", "current", "history"] },
    reconstructionIntent: RECONSTRUCTION_INTENT_SCHEMA,
  },
};

export function listMemoryMcpTools(): MemoryMcpTool[] {
  const tools: Record<MemoryMcpToolName, MemoryMcpTool> = {
    "memory.runtime_info": {
      name: "memory.runtime_info",
      description: "Return gmOS package, public integration surface, and local-first trust contract.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
    "memory.add": {
      name: "memory.add",
      description: "Remember a non-secret, non-person memory.",
      inputSchema: {
        type: "object",
        required: ["kind", "content"],
        additionalProperties: false,
        properties: {
          profileId: { type: "string" },
          kind: {
            type: "string",
            enum: ["fact", "preference", "boundary", "procedure", "project", "task_trajectory"],
          },
          scope: { type: "string" },
          content: { type: "string" },
          confidence: { type: "number", exclusiveMinimum: 0, maximum: 1 },
        },
      },
    },
    "memory.search": {
      name: "memory.search",
      description: "Search public context-safe memories.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          profileId: { type: "string" },
          query: { type: "string" },
          limit: { type: "integer", minimum: 1 },
          purpose: { type: "string", enum: ["context", "history"] },
        },
      },
    },
    "memory.observe": {
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
    "memory.prepare_context": {
      name: "memory.prepare_context",
      description: "Prepare memory context for a turn.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          profileId: { type: "string" },
          text: { type: "string" },
          messages: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["content"],
              properties: {
                role: { type: "string", enum: ["system", "user", "assistant", "tool"] },
                content: { type: "string" },
              },
            },
          },
          includeEvidence: { type: "boolean" },
          contextBudgetTokens: { type: "number", exclusiveMinimum: 0 },
          reconstruction: PREPARE_RECONSTRUCTION_SCHEMA,
        },
      },
    },
    "memory.reconstruct_context": {
      name: "memory.reconstruct_context",
      description: "Actively reconstruct context through bounded cue-tag-content associations.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          profileId: { type: "string" },
          text: { type: "string" },
          messages: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["content"],
              properties: {
                role: { type: "string", enum: ["system", "user", "assistant", "tool"] },
                content: { type: "string" },
              },
            },
          },
          includeEvidence: { type: "boolean" },
          contextBudgetTokens: { type: "number", exclusiveMinimum: 0 },
          maxSteps: { type: "integer", minimum: 1 },
          maxBranch: { type: "integer", minimum: 1 },
          maxMemories: { type: "integer", minimum: 1 },
          stopWhenEvidenceEnough: { type: "boolean" },
          evidenceConvergenceThreshold: { type: "number", exclusiveMinimum: 0 },
          includeTemporalMetadata: { type: "boolean" },
          temporalMode: { type: "string", enum: ["auto", "current", "history"] },
          reconstructionIntent: RECONSTRUCTION_INTENT_SCHEMA,
        },
      },
    },
    "memory.explain_evidence_path": {
      name: "memory.explain_evidence_path",
      description: "Explain the reconstructed cue-tag-content evidence path without returning a prompt block.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          profileId: { type: "string" },
          text: { type: "string" },
          messages: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["content"],
              properties: {
                role: { type: "string", enum: ["system", "user", "assistant", "tool"] },
                content: { type: "string" },
              },
            },
          },
          includeEvidence: { type: "boolean" },
          includePlannerTrace: { type: "boolean" },
          contextBudgetTokens: { type: "number", exclusiveMinimum: 0 },
          maxSteps: { type: "integer", minimum: 1 },
          maxBranch: { type: "integer", minimum: 1 },
          maxMemories: { type: "integer", minimum: 1 },
          stopWhenEvidenceEnough: { type: "boolean" },
          evidenceConvergenceThreshold: { type: "number", exclusiveMinimum: 0 },
          includeTemporalMetadata: { type: "boolean" },
          temporalMode: { type: "string", enum: ["auto", "current", "history"] },
          reconstructionIntent: RECONSTRUCTION_INTENT_SCHEMA,
        },
      },
    },
    "memory.commit_outcome": {
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
    "memory.record_feedback": {
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
    "memory.forget": {
      name: "memory.forget",
      description: "Forget matching memories.",
      inputSchema: {
        type: "object",
        required: ["query"],
        additionalProperties: false,
        properties: {
          profileId: { type: "string" },
          query: { type: "string" },
          targetTerms: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
      },
    },
    "memory.explain_belief": {
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
  };
  return PUBLIC_MEMORY_MCP_TOOL_NAMES.map((name) => tools[name]);
}
