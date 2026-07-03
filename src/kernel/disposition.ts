import type {
  PrepareTurnInput,
  ReconstructContextInput,
  ReconstructionRecallPurpose,
} from "./types.js";

export type RecallDispositionPresetName = "focused" | "balanced" | "expansive";

export interface ResolvedRecallDispositionPreset {
  name: RecallDispositionPresetName;
  contextBudgetTokens: number;
  memorySearchLimit: number;
  scoreThreshold: number;
  reconstruction: {
    maxSteps: number;
    maxBranch: number;
    maxMemories: number;
    stopWhenEvidenceEnough?: boolean | undefined;
    evidenceConvergenceThreshold?: number | undefined;
    temporalMode?: "auto" | "current" | "history" | undefined;
    recallPurpose?: ReconstructionRecallPurpose | undefined;
  };
}

export const RECALL_DISPOSITION_PRESETS: Record<
  RecallDispositionPresetName,
  ResolvedRecallDispositionPreset
> = {
  focused: {
    name: "focused",
    contextBudgetTokens: 900,
    memorySearchLimit: 6,
    scoreThreshold: 0.25,
    reconstruction: {
      maxSteps: 2,
      maxBranch: 2,
      maxMemories: 4,
      stopWhenEvidenceEnough: true,
      evidenceConvergenceThreshold: 0.8,
      temporalMode: "current",
    },
  },
  balanced: {
    name: "balanced",
    contextBudgetTokens: 1800,
    memorySearchLimit: 12,
    scoreThreshold: 0,
    reconstruction: {
      maxSteps: 3,
      maxBranch: 4,
      maxMemories: 8,
    },
  },
  expansive: {
    name: "expansive",
    contextBudgetTokens: 3200,
    memorySearchLimit: 24,
    scoreThreshold: -0.01,
    reconstruction: {
      maxSteps: 5,
      maxBranch: 8,
      maxMemories: 16,
      stopWhenEvidenceEnough: false,
      evidenceConvergenceThreshold: 0.55,
      temporalMode: "history",
      recallPurpose: "history",
    },
  },
};

export function normalizeRecallDispositionPreset(
  input: string | undefined,
): RecallDispositionPresetName | undefined {
  if (input === undefined) return undefined;
  const preset = input.trim();
  if (preset === "focused" || preset === "balanced" || preset === "expansive") return preset;
  throw new Error("gmOS disposition preset must be focused, balanced, or expansive");
}

export function resolveRecallDispositionPreset(input: {
  requested?: string | undefined;
  defaultPreset?: string | undefined;
} = {}): ResolvedRecallDispositionPreset {
  const name = normalizeRecallDispositionPreset(input.requested) ??
    normalizeRecallDispositionPreset(input.defaultPreset) ??
    "balanced";
  return RECALL_DISPOSITION_PRESETS[name];
}

export function applyPrepareDisposition(input: {
  request: PrepareTurnInput;
  defaultPreset?: string | undefined;
}): { request: PrepareTurnInput; preset: ResolvedRecallDispositionPreset } {
  const preset = resolveRecallDispositionPreset({
    requested: input.request.dispositionPreset,
    defaultPreset: input.defaultPreset,
  });
  const request: PrepareTurnInput = {
    ...input.request,
    dispositionPreset: preset.name,
    contextBudgetTokens: input.request.contextBudgetTokens ?? preset.contextBudgetTokens,
  };
  if (request.reconstruction?.mode === "shadow") {
    request.reconstruction = {
      ...request.reconstruction,
      maxSteps: request.reconstruction.maxSteps ?? preset.reconstruction.maxSteps,
      maxBranch: request.reconstruction.maxBranch ?? preset.reconstruction.maxBranch,
      maxMemories: request.reconstruction.maxMemories ?? preset.reconstruction.maxMemories,
      stopWhenEvidenceEnough:
        request.reconstruction.stopWhenEvidenceEnough ??
        preset.reconstruction.stopWhenEvidenceEnough,
      evidenceConvergenceThreshold:
        request.reconstruction.evidenceConvergenceThreshold ??
        preset.reconstruction.evidenceConvergenceThreshold,
      temporalMode: request.reconstruction.temporalMode ?? preset.reconstruction.temporalMode,
      recallPurpose: request.reconstruction.recallPurpose ?? preset.reconstruction.recallPurpose,
    };
  }
  return { request, preset };
}

export function applyReconstructDisposition<T extends ReconstructContextInput>(input: {
  request: T;
  defaultPreset?: string | undefined;
}): { request: T; preset: ResolvedRecallDispositionPreset } {
  const preset = resolveRecallDispositionPreset({
    requested: input.request.dispositionPreset,
    defaultPreset: input.defaultPreset,
  });
  return {
    preset,
    request: {
      ...input.request,
      dispositionPreset: preset.name,
      contextBudgetTokens: input.request.contextBudgetTokens ?? preset.contextBudgetTokens,
      maxSteps: input.request.maxSteps ?? preset.reconstruction.maxSteps,
      maxBranch: input.request.maxBranch ?? preset.reconstruction.maxBranch,
      maxMemories: input.request.maxMemories ?? preset.reconstruction.maxMemories,
      stopWhenEvidenceEnough:
        input.request.stopWhenEvidenceEnough ?? preset.reconstruction.stopWhenEvidenceEnough,
      evidenceConvergenceThreshold:
        input.request.evidenceConvergenceThreshold ??
        preset.reconstruction.evidenceConvergenceThreshold,
      temporalMode: input.request.temporalMode ?? preset.reconstruction.temporalMode,
      recallPurpose: input.request.recallPurpose ?? preset.reconstruction.recallPurpose,
    },
  };
}
