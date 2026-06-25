import type { MemoryOS } from "../kernel/types.js";

export interface MemoryMcpTool {
  name: string;
  description: string;
}

export function listMemoryMcpTools(): MemoryMcpTool[] {
  return [
    { name: "memory.observe", description: "Ingest a host event into gmOS." },
    { name: "memory.prepare_context", description: "Prepare memory context for a turn." },
    { name: "memory.commit_outcome", description: "Commit task outcome feedback." },
    { name: "memory.record_feedback", description: "Record memory feedback or correction." },
    { name: "memory.forget", description: "Forget matching memories." },
    { name: "memory.explain_belief", description: "Explain a memory or belief with evidence." },
  ];
}

export function createMemoryMcpServer(_memory: MemoryOS) {
  return {
    tools: listMemoryMcpTools(),
    status: "not_started" as const,
  };
}

