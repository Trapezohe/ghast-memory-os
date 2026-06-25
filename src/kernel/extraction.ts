import type { MemoryKind } from "./types.js";
import { isPersonRoutedMemory } from "./safety.js";

export interface MemoryCandidate {
  kind: MemoryKind;
  content: string;
  confidence: number;
  predicate?: string;
  actionPolicyKind?: "do_not_push" | "prefer" | "procedure";
}

function normalize(content: string): string {
  return content.replace(/\s+/gu, " ").trim();
}

export function extractMemoryCandidate(content: string): MemoryCandidate | null {
  const text = normalize(content);
  if (!text || isPersonRoutedMemory(text)) return null;

  if (
    /不要再提醒|别再提醒|不要主动提|不要再推|do not remind|don't remind|do not push|don't push/iu.test(
      text,
    )
  ) {
    return {
      kind: "boundary",
      content: text,
      confidence: 0.95,
      predicate: "boundary.do_not_push",
      actionPolicyKind: "do_not_push",
    };
  }

  if (/我喜欢|我偏好|我更喜欢|I prefer|I like|my preference is/iu.test(text)) {
    return {
      kind: "preference",
      content: text,
      confidence: 0.82,
      predicate: "user.preference",
      actionPolicyKind: "prefer",
    };
  }

  if (/步骤|流程|procedure|workflow|when .* do|每次.*先/u.test(text)) {
    return {
      kind: "procedure",
      content: text,
      confidence: 0.74,
      predicate: "user.procedure",
      actionPolicyKind: "procedure",
    };
  }

  if (/项目|project|repo|仓库|deadline|里程碑/iu.test(text)) {
    return {
      kind: "project",
      content: text,
      confidence: 0.68,
      predicate: "project.state",
    };
  }

  if (/^我(是|在|有)|我的|my name is|I am|I work|I live/iu.test(text)) {
    return {
      kind: "fact",
      content: text,
      confidence: 0.7,
      predicate: "user.fact",
    };
  }

  return null;
}

