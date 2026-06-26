import type {
  MemoryExtractionCandidate,
  MemoryExtractionInput,
  MemoryExtractionResult,
  MemoryExtractor,
} from "./types.js";
import { isPersonRoutedMemory } from "./safety.js";

function normalize(content: string): string {
  return content.replace(/\s+/gu, " ").trim();
}

const KNOWN_MEMORY_KINDS = new Set([
  "fact",
  "preference",
  "boundary",
  "procedure",
  "project",
  "person",
  "task_trajectory",
]);

function extractorName(extractor: MemoryExtractor | undefined): string | undefined {
  if (!extractor) return undefined;
  if (typeof extractor === "function") return extractor.name || undefined;
  return extractor.name;
}

function asCandidateArray(result: MemoryExtractionResult): MemoryExtractionCandidate[] | null {
  if (result === null || result === undefined) return null;
  return Array.isArray(result) ? result : [result];
}

function boundedConfidence(input: number, fallback: number): number {
  if (!Number.isFinite(input)) return fallback;
  return Math.max(0, Math.min(1, input));
}

function normalizeCandidate(
  candidate: MemoryExtractionCandidate,
  options: { minConfidence: number },
): MemoryExtractionCandidate | null {
  const content = normalize(candidate.content);
  if (
    !KNOWN_MEMORY_KINDS.has(String(candidate.kind)) ||
    !content ||
    candidate.kind === "person" ||
    isPersonRoutedMemory(content)
  ) {
    return null;
  }
  const confidence = boundedConfidence(candidate.confidence, 0);
  if (confidence < options.minConfidence) return null;
  return {
    ...candidate,
    content,
    confidence,
  };
}

function uniqueCandidates(candidates: MemoryExtractionCandidate[]): MemoryExtractionCandidate[] {
  const seen = new Set<string>();
  const result: MemoryExtractionCandidate[] = [];
  for (const candidate of candidates) {
    const key = [
      candidate.kind,
      candidate.predicate ?? "",
      candidate.content.toLowerCase(),
    ].join("\n");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

export function extractRuleMemoryCandidates(content: string): MemoryExtractionCandidate[] {
  const text = normalize(content);
  if (!text || isPersonRoutedMemory(text)) return [];

  if (
    /不要再提醒|别再提醒|不要主动提|不要再推|do not remind|don't remind|do not push|don't push/iu.test(
      text,
    )
  ) {
    return [
      {
        kind: "boundary",
        content: text,
        confidence: 0.95,
        predicate: "boundary.do_not_push",
        actionPolicyKind: "do_not_push",
      },
    ];
  }

  if (/我喜欢|我偏好|我更喜欢|I prefer|I like|my preference is/iu.test(text)) {
    return [
      {
        kind: "preference",
        content: text,
        confidence: 0.82,
        predicate: "user.preference",
        actionPolicyKind: "prefer",
      },
    ];
  }

  if (/步骤|流程|procedure|workflow|when .* do|每次.*先/u.test(text)) {
    return [
      {
        kind: "procedure",
        content: text,
        confidence: 0.74,
        predicate: "user.procedure",
        actionPolicyKind: "procedure",
      },
    ];
  }

  if (/项目|project|repo|仓库|deadline|里程碑/iu.test(text)) {
    return [
      {
        kind: "project",
        content: text,
        confidence: 0.68,
        predicate: "project.state",
      },
    ];
  }

  if (/^我(是|在|有)|我的|my name is|I am|I work|I live/iu.test(text)) {
    return [
      {
        kind: "fact",
        content: text,
        confidence: 0.7,
        predicate: "user.fact",
      },
    ];
  }

  return [];
}

export function extractMemoryCandidate(content: string): MemoryExtractionCandidate | null {
  return extractRuleMemoryCandidates(content)[0] ?? null;
}

export async function extractMemoryCandidates(input: {
  extractor?: MemoryExtractor | undefined;
  extractionInput: MemoryExtractionInput;
  fallbackToRules?: boolean | undefined;
  minConfidence?: number | undefined;
}): Promise<MemoryExtractionCandidate[]> {
  const minConfidence = input.minConfidence ?? 0.01;
  const ruleCandidates = input.extractionInput.ruleCandidates;
  let selected: MemoryExtractionCandidate[] | null = null;

  if (input.extractor) {
    try {
      const raw =
        typeof input.extractor === "function"
          ? await input.extractor(input.extractionInput)
          : await input.extractor.extract(input.extractionInput);
      selected = asCandidateArray(raw);
    } catch {
      selected = null;
    }
  }

  const fallbackToRules = input.fallbackToRules ?? true;
  const source = selected === null && fallbackToRules ? ruleCandidates : (selected ?? []);
  return uniqueCandidates(
    source
      .map((candidate) => normalizeCandidate(candidate, { minConfidence }))
      .filter((candidate): candidate is MemoryExtractionCandidate => candidate !== null)
      .map((candidate) => ({
        ...candidate,
        metadata: {
          ...(candidate.metadata ?? {}),
          extractionSource:
            selected === null && fallbackToRules ? "rules" : "custom",
          ...(selected === null && input.extractor
            ? { extractorFallback: true, extractorName: extractorName(input.extractor) }
            : input.extractor
              ? { extractorName: extractorName(input.extractor) }
              : {}),
        },
      })),
  );
}
