import type { HostPreset } from "../host/index.js";

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
  package: {
    name: string | null;
    version: string | null;
  };
  git: {
    branch: string | null;
    sha: string | null;
    dirty: boolean | null;
  };
  sqliteSchemaVersion: number | null;
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

export interface MemoryReleaseGateResult {
  schema: "gmos.memory_release_gate.v1";
  pass: boolean;
  startedAt: string;
  finishedAt: string;
  releaseConfidence:
    | "release_candidate"
    | "action_required";
  inputs: {
    dbPathMode: "memory";
    generatedSeeds: number;
    scaleSizes: number[];
    scaleThresholdP95Ms: number;
    hosts: HostPreset[];
    actualHostReports: number;
  };
  components: {
    memoryGym: {
      pass: boolean;
      score: number;
      deterministicArchitectureStatus: MemoryGymStatus;
      generalizationStatus: MemoryGymStatus;
      roadmapStatus: MemoryGymRoadmapResult["status"];
      hardGateCount: number;
      failedHardGates: string[];
    };
    hostCompatibility: {
      pass: boolean;
      hostCount: number;
      failedHosts: string[];
    };
    scale: {
      pass: boolean;
      sizes: number[];
      thresholdP95Ms: number;
      failedSizes: number[];
      failedOperations?: import("./scale.js").MemoryScaleFailedOperation[] | undefined;
    };
    diagnostics: {
      pass: boolean;
      schemaVersion: number | null;
      storageStatus: "ok" | "unavailable";
      encrypted: false;
      readAuditStatus: "ok" | "unsupported" | "unavailable";
      readAuditTableCount: number;
      readPathSideEffectsChecked: boolean;
    };
  };
  reports: {
    memoryGym: MemoryGymResult;
    hostCompatibility: import("./host-compatibility.js").HostCompatibilityGymResult;
    scale: import("./scale.js").MemoryScaleBenchmarkResult;
    diagnostics: import("../diagnostics/index.js").MemoryStatusReport;
  };
}
