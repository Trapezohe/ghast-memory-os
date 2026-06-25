export type MemoryGymStatus = "pass" | "fail" | "partial" | "not_run";

export interface MemoryGymGateResult {
  name: string;
  passed: boolean;
  detail: string;
  layer: string;
}

export interface MemoryGymScenarioResult {
  name: string;
  group: "dev" | "holdout" | "generated" | "adversarial";
  pass: boolean;
  gates: string[];
}

export interface MemoryGymScoreResult {
  status: MemoryGymStatus;
  score: number | null;
  gate: string;
}

export interface MemoryGymGeneralizationResult {
  status: MemoryGymStatus;
  devScore: number;
  holdoutScore: number;
  generatedMean: number;
  generatedStd: number;
  generatedSeedCount: number;
  adversarialScore: number;
  generalizationGap: number;
}

export interface MemoryGymRoadmapResult {
  status: "clear" | "action_required";
  suggestions: string[];
}

export interface MemoryGymCoverageRow {
  layer: string;
  status: MemoryGymStatus;
  evidence: string;
}

export interface MemoryGymRunManifest {
  framework: "gmos-memory-gym";
  startedAt: string;
  node: string;
  platform: string;
  dbPathMode: "memory" | "file";
  generatedSeeds: string[];
  deterministicOnly: boolean;
}

export interface MemoryGymResult {
  pass: boolean;
  score: number;
  framework: "complete memory system benchmark framework";
  deterministicArchitectureResult: MemoryGymScoreResult;
  agentMemoryUseResult: MemoryGymScoreResult;
  generalizationResult: MemoryGymGeneralizationResult;
  roadmapResult: MemoryGymRoadmapResult;
  stage5ReadinessView: number;
  releaseConfidence: "deterministic_internal_gate_only" | "action_required";
  hardGates: Record<string, boolean>;
  gateResults: MemoryGymGateResult[];
  details: string[];
  scenarios: MemoryGymScenarioResult[];
  coverageMatrix: MemoryGymCoverageRow[];
  memoryStackCoverage: MemoryGymCoverageRow[];
  runManifest: MemoryGymRunManifest;
}
