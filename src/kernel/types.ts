import type { EntityResolver } from "./entities.js";

export type MemoryRole = "system" | "user" | "assistant" | "tool";

export type PrivacyMode = "normal" | "incognito";

export type Sensitivity = "normal" | "sensitive" | "secret_like";

export type SourceTrust = "user" | "agent" | "external";

export interface MemorySensitivityClassifierInput {
  value: string;
  surface:
    | "content"
    | "failure"
    | "metadata"
    | "route_signal"
    | "scope"
    | "speaker"
    | "structured_candidate"
    | "task_trajectory";
}

export type MemorySensitivityClassifier =
  | ((
      input: MemorySensitivityClassifierInput,
    ) => Sensitivity | null | undefined)
  | {
      name?: string | undefined;
      classify(input: MemorySensitivityClassifierInput): Sensitivity | null | undefined;
    };

export type MemoryKind =
  | "fact"
  | "preference"
  | "boundary"
  | "procedure"
  | "project"
  | "person"
  | "task_trajectory";

export type MemoryStatus = "active" | "dormant" | "archived";

export type FailureKind =
  | "missed_recall"
  | "wrong_recall"
  | "privacy_leak"
  | "forget_failure"
  | "controller_route_error"
  | "action_policy_missing"
  | "task_failure";

export type ConversationSpeakerKind =
  | "person"
  | "human"
  | "assistant"
  | "bot"
  | "system"
  | "tool"
  | "unknown"
  | (string & {});

export interface ConversationSourceMetadata extends Record<string, unknown> {
  speaker?: string | undefined;
  speakerKind?: ConversationSpeakerKind | undefined;
  speakerId?: string | undefined;
  speakerAliases?: readonly string[] | undefined;
  participants?: readonly string[] | undefined;
  sessionId?: string | undefined;
  sessionKey?: string | undefined;
  sourceId?: string | undefined;
  sourceUri?: string | undefined;
  sourceTrust?: SourceTrust | undefined;
}

export interface ConversationMessageEvent {
  type: "conversation.message";
  profileId?: string | undefined;
  conversationId?: string | undefined;
  messageId?: string | undefined;
  role: MemoryRole;
  content: string;
  sourceTrust?: SourceTrust | undefined;
  allowLowerTrustPolicyWrites?: boolean | undefined;
  privacyMode?: PrivacyMode | undefined;
  createdAt?: string | undefined;
  metadata?: ConversationSourceMetadata | undefined;
}

export interface UserForgetEvent {
  type: "user.forget_request";
  profileId?: string | undefined;
  query: string;
  targetTerms?: string[] | undefined;
  reason?: string | undefined;
  createdAt?: string | undefined;
}

export interface UserFeedbackEvent {
  type: "user.feedback" | "user.correction";
  profileId?: string | undefined;
  content: string;
  failureKind?: FailureKind | undefined;
  createdAt?: string | undefined;
}

export interface TaskOutcomeEvent {
  type: "task.completed" | "task.failed";
  profileId?: string | undefined;
  taskId?: string | undefined;
  objective: string;
  summary?: string | undefined;
  createdAt?: string | undefined;
}

export type HostEvent =
  | ConversationMessageEvent
  | UserForgetEvent
  | UserFeedbackEvent
  | TaskOutcomeEvent;

export interface TurnMessage {
  role: MemoryRole;
  content: string;
}

export interface PrepareTurnInput {
  profileId?: string | undefined;
  messages: TurnMessage[];
  dispositionPreset?: string | undefined;
  task?: {
    intent?: string | undefined;
    projectId?: string | undefined;
    topic?: string | undefined;
  } | undefined;
  includeEvidence?: boolean | undefined;
  includeSensitive?: boolean | undefined;
  includeTemporalContext?: boolean | undefined;
  contextBudgetTokens?: number | undefined;
  curiosityBudget?: number | undefined;
  suppressGapIds?: string[] | undefined;
  reconstruction?: {
    mode: "shadow";
    maxSteps?: number | undefined;
    maxBranch?: number | undefined;
    maxMemories?: number | undefined;
    anchorCoverage?: boolean | undefined;
    stopWhenEvidenceEnough?: boolean | undefined;
    evidenceConvergenceThreshold?: number | undefined;
    includeTemporalMetadata?: boolean | undefined;
    includeTemporalContext?: boolean | undefined;
    temporalMode?: "auto" | "current" | "history" | undefined;
    recallPurpose?: ReconstructionRecallPurpose | undefined;
    reconstructionIntent?: ReconstructionIntentHint | undefined;
    maxCharsPerMemory?: number | undefined;
    fullContentTopRank?: number | undefined;
    fullContentMaxChars?: number | undefined;
    layerPolicy?: ReconstructionLayerPolicy | undefined;
  } | undefined;
  retrieval?: MemoryReadRetrievalOptions | undefined;
}

export interface EvidenceEvent {
  id: string;
  eventKey: string;
  profileId: string;
  sourceType: string;
  sourceUri?: string | null | undefined;
  content: string;
  sensitivity: Sensitivity;
  eligibleForLongTermMemory: boolean;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface MemoryExtractionCandidate {
  kind: MemoryKind;
  content: string;
  confidence: number;
  sourceIndex?: number | undefined;
  predicate?: string | undefined;
  subject?: string | undefined;
  subjectAliases?: readonly string[] | undefined;
  speaker?: string | undefined;
  object?: string | undefined;
  source?: string | undefined;
  eventTime?: string | undefined;
  validFrom?: string | undefined;
  validTo?: string | undefined;
  cardinality?: "single" | "multi" | undefined;
  actionPolicyKind?: "do_not_push" | "prefer" | "procedure" | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface MemoryExtractionInput {
  profileId: string;
  event: ConversationMessageEvent;
  evidence: EvidenceEvent;
  window?: {
    messages: Array<{
      role: MemoryRole;
      content: string;
      createdAt?: string | undefined;
      metadata?: ConversationSourceMetadata | undefined;
    }>;
    evidenceIds: string[];
  } | undefined;
}

export type MemoryExtractionResult =
  | MemoryExtractionCandidate
  | MemoryExtractionCandidate[]
  | null
  | undefined;

export type MemoryExtractor =
  | ((
      input: MemoryExtractionInput,
    ) => Promise<MemoryExtractionResult> | MemoryExtractionResult)
  | {
      name?: string | undefined;
      extract(
        input: MemoryExtractionInput,
      ): Promise<MemoryExtractionResult> | MemoryExtractionResult;
    };

export interface MemorySessionDistillationCandidate {
  content: string;
  kind?: MemoryKind | undefined;
  confidence?: number | undefined;
}

export interface MemorySessionDistillationInput {
  profileId: string;
  eventTime: string;
  context: {
    eventKey: string;
    evidenceIds: string[];
    conversationId?: never;
    sessionId?: never;
    sourceUri?: never;
  };
  messages: Array<{
    role: MemoryRole;
    content: string;
    createdAt?: string | undefined;
    evidenceId?: string | undefined;
    metadata?: ConversationSourceMetadata | undefined;
  }>;
}

export type MemorySessionDistillationResult =
  | MemorySessionDistillationCandidate
  | MemorySessionDistillationCandidate[]
  | null
  | undefined;

export type MemorySessionDistiller =
  | ((
      input: MemorySessionDistillationInput,
    ) => Promise<MemorySessionDistillationResult> | MemorySessionDistillationResult)
  | {
      name?: string | undefined;
      distill(
        input: MemorySessionDistillationInput,
      ): Promise<MemorySessionDistillationResult> | MemorySessionDistillationResult;
    };

export interface MemoryTemporalMetadata {
  eventDate?: string | undefined;
  eventTime?: string | undefined;
  validFrom?: string | undefined;
  validTo?: string | undefined;
}

export interface MemoryTemporalParserInput {
  content: string;
  metadata?: Record<string, unknown> | undefined;
  createdAt?: string | undefined;
}

export type MemoryTemporalParser =
  | ((
      input: MemoryTemporalParserInput,
    ) => Promise<MemoryTemporalMetadata | null | undefined> | MemoryTemporalMetadata | null | undefined)
  | {
      name?: string | undefined;
      parse(
        input: MemoryTemporalParserInput,
      ): Promise<MemoryTemporalMetadata | null | undefined> | MemoryTemporalMetadata | null | undefined;
    };

export type MemoryAssociationCueKind =
  | "lexical"
  | "kind"
  | "scope"
  | "predicate"
  | "task"
  | "entity"
  | "temporal";

export interface MemoryCue {
  cue: string;
  cueKind: MemoryAssociationCueKind;
}

export interface MemoryCueExtractorInput {
  text: string;
  phase: "query" | "evidence";
  maxCues: number;
}

export type MemoryCueExtractor =
  | ((input: MemoryCueExtractorInput) => MemoryCue[] | null | undefined)
  | {
      name?: string | undefined;
      extract(input: MemoryCueExtractorInput): MemoryCue[] | null | undefined;
    };

export type MemoryExtractionRejectReason =
  | "empty_content"
  | "invalid_kind"
  | "person_kind"
  | "person_routed"
  | "non_person_speaker"
  | "secret_like"
  | "low_confidence"
  | "duplicate";

export type MemoryExtractionRejectClass = "hardReject" | "softReject";

export interface MemoryExtractionCandidateSnapshot {
  kind?: string | undefined;
  content: string;
  confidence?: number | undefined;
  sourceIndex?: number | undefined;
  predicate?: string | undefined;
  subject?: string | undefined;
  subjectAliases?: readonly string[] | undefined;
  speaker?: string | undefined;
  object?: string | undefined;
  source?: string | undefined;
  eventTime?: string | undefined;
  validFrom?: string | undefined;
  validTo?: string | undefined;
  cardinality?: string | undefined;
  actionPolicyKind?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface AcceptedMemoryExtractionDecision {
  decision: "accepted";
  candidate: MemoryExtractionCandidateSnapshot;
}

export interface RejectedMemoryExtractionDecision {
  decision: "rejected";
  rejectClass: MemoryExtractionRejectClass;
  candidate: MemoryExtractionCandidateSnapshot;
  reason: MemoryExtractionRejectReason;
}

export type MemoryExtractionDecision =
  | AcceptedMemoryExtractionDecision
  | RejectedMemoryExtractionDecision;

export type MemoryExtractionOutcome =
  | "not_configured"
  | "ok_with_candidates"
  | "ok_empty"
  | "parse_failure"
  | "transport_failure";

export interface MemoryExtractionReport {
  extractorName?: string | undefined;
  windowIndex?: number | undefined;
  transcriptCharCount?: number | undefined;
  minConfidence: number;
  retryCount: number;
  extractionSource: "custom" | "none";
  extractorFailed: boolean;
  outcome: MemoryExtractionOutcome;
  rawCandidateCount: number;
  acceptedCandidateCount: number;
  rejectedCandidateCount: number;
  hardRejectCount: number;
  softRejectCount: number;
  decisions: MemoryExtractionDecision[];
}

export interface MemoryConsolidationSourceSnapshot {
  id: string;
  kind: MemoryKind;
  content: string;
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryConsolidationCluster {
  kind: MemoryKind | "duplicate" | "entity";
  memoryKind?: MemoryKind | undefined;
  entityKey?: string | undefined;
  entityObject?: string | undefined;
  sharedTags: string[];
  memories: MemoryConsolidationSourceSnapshot[];
}

export interface MemoryConsolidationCandidate {
  content: string;
  kind?: MemoryKind | undefined;
  confidence?: number | undefined;
  subject?: string | undefined;
  predicate?: string | undefined;
  object?: string | undefined;
}

export type MemoryConsolidationResult =
  | MemoryConsolidationCandidate
  | MemoryConsolidationCandidate[]
  | null
  | undefined;

export type MemoryConsolidator =
  | ((
      input: MemoryConsolidationCluster,
    ) => Promise<MemoryConsolidationResult> | MemoryConsolidationResult)
  | {
      name?: string | undefined;
      consolidate(
        input: MemoryConsolidationCluster,
      ): Promise<MemoryConsolidationResult> | MemoryConsolidationResult;
    };

export interface MemoryProcedureDistillationTrajectorySnapshot {
  id: string;
  objective: string;
  status: "completed" | "failed";
  summary?: string | undefined;
  createdAt: string;
}

export interface MemoryProcedureDistillationCluster {
  objective: string;
  sharedTags: string[];
  trajectories: MemoryProcedureDistillationTrajectorySnapshot[];
  clusterKey: string;
}

export interface MemoryProcedureDistillationCandidate {
  content: string;
  confidence?: number | undefined;
}

export type MemoryProcedureDistillationResult =
  | MemoryProcedureDistillationCandidate
  | MemoryProcedureDistillationCandidate[]
  | null
  | undefined;

export type MemoryProcedureDistiller =
  | ((
      input: Omit<MemoryProcedureDistillationCluster, "clusterKey">,
    ) => Promise<MemoryProcedureDistillationResult> | MemoryProcedureDistillationResult)
  | {
      name?: string | undefined;
      distill(
        input: Omit<MemoryProcedureDistillationCluster, "clusterKey">,
      ): Promise<MemoryProcedureDistillationResult> | MemoryProcedureDistillationResult;
    };

export interface MemoryDossierBeliefSnapshot {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  sourceMemoryId?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryDossierEntitySnapshot {
  entityKey: string;
  entityKind: MemoryKind;
  aliases: string[];
  beliefs: MemoryDossierBeliefSnapshot[];
  memories: MemoryConsolidationSourceSnapshot[];
}

export interface MemoryDossierCandidate {
  content: string;
  confidence?: number | undefined;
}

export type MemoryDossierResult =
  | MemoryDossierCandidate
  | MemoryDossierCandidate[]
  | null
  | undefined;

export type MemoryDossierSynthesizer =
  | ((
      input: MemoryDossierEntitySnapshot,
    ) => Promise<MemoryDossierResult> | MemoryDossierResult)
  | {
      name?: string | undefined;
      synthesize(
        input: MemoryDossierEntitySnapshot,
      ): Promise<MemoryDossierResult> | MemoryDossierResult;
    };

export type ObserveSkippedReason =
  | "deduplicated_event"
  | "forget_request"
  | "feedback_recorded"
  | "task_trajectory_recorded"
  | "unsupported_event"
  | "non_user_message"
  | "not_eligible_for_long_term_memory"
  | "person_routed";

export interface ObserveResult {
  profileId: string;
  eventType: HostEvent["type"];
  observedAt: string;
  evidenceId?: string | undefined;
  eligibleForLongTermMemory?: boolean | undefined;
  skippedReason?: ObserveSkippedReason | undefined;
  memoryIds: string[];
  worldBeliefIds: string[];
  extraction?: MemoryExtractionReport | undefined;
}

export interface IngestConversationInput {
  profileId?: string | undefined;
  messages: Array<Omit<ConversationMessageEvent, "type" | "profileId"> & {
    type?: "conversation.message" | undefined;
    profileId?: string | undefined;
  }>;
  window?: {
    maxMessages?: number | undefined;
    /**
     * Maximum source transcript characters sent to one extractor window.
     * Character-budget splits can preserve recent messages via overlapMessages.
     */
    maxChars?: number | undefined;
    /**
     * Recent messages to repeat only when maxChars forces a split.
     * Session-boundary and maxMessages splits do not preserve overlap.
     */
    overlapMessages?: number | undefined;
    /**
     * Number of extractor windows and session-distillation groups to run concurrently.
     * Results are always persisted in source/session order.
     */
    concurrency?: number | undefined;
  } | undefined;
  extraction?: {
    extractFromRoles?: MemoryRole[] | undefined;
    replayAttempts?: number | undefined;
  } | undefined;
  turnRetention?: {
    enabled: boolean;
    kind?: MemoryKind | undefined;
    confidence?: number | undefined;
  } | undefined;
  sessionDistillation?: boolean | undefined;
  consolidateEntities?: boolean | {
    minClusterSize?: number | undefined;
    maxClustersPerRun?: number | undefined;
    maxMembersPerCluster?: number | undefined;
  } | undefined;
  progress?: {
    everyWindows?: number | undefined;
    onWindow?: ((progress: IngestConversationProgress) => void) | undefined;
  } | undefined;
}

export interface IngestConversationProgress {
  profileId: string;
  windowsDone: number;
  windowsTotal: number;
  extractionWindowCount: number;
  extractionCallCount: number;
  extractionRetryCount: number;
  extractionOkWithCandidatesCount: number;
  extractionEmptyCount: number;
  extractionParseFailureCount: number;
  extractionTransportFailureCount: number;
  extractionFailureCount: number;
  extractionOkWithCandidatesCharCount: number;
  extractionEmptyCharCount: number;
  extractionParseFailureCharCount: number;
  extractionTransportFailureCharCount: number;
  replayedWindowCount: number;
  replayRecoveredCount: number;
  extractedMemoryCount: number;
  turnMemoryCount: number;
  distilledMemoryCount: number;
  elapsedMs: number;
  etaMs: number | null;
}

export interface IngestConversationResult {
  profileId: string;
  observedAt: string;
  results: ObserveResult[];
  evidenceIds: string[];
  memoryIds: string[];
  worldBeliefIds: string[];
  extractionWindowCount: number;
  extractionCallCount: number;
  extractionRetryCount: number;
  extractionOkWithCandidatesCount: number;
  extractionEmptyCount: number;
  extractionParseFailureCount: number;
  extractionTransportFailureCount: number;
  extractionFailureCount: number;
  extractionOkWithCandidatesCharCount: number;
  extractionEmptyCharCount: number;
  extractionParseFailureCharCount: number;
  extractionTransportFailureCharCount: number;
  extractionFailedWindowIndexes: number[];
  replayedWindowCount: number;
  replayRecoveredCount: number;
  turnMemoryCount: number;
  distilledMemoryCount: number;
  embeddingCallCount: number;
  embeddedMemoryCount: number;
  embeddingFailureCount: number;
  distillationCallCount: number;
  distillationOkWithCandidatesCount: number;
  distillationEmptyCount: number;
  distillationParseFailureCount: number;
  distillationTransportFailureCount: number;
  distillationFailureCount: number;
  distillationTruncatedMessageCount: number;
  entityConsolidation?: {
    clustersFound: number;
    clustersMerged: number;
    consolidatorCallCount: number;
    consolidatorFailureCount: number;
  } | undefined;
  extractionMinConfidence: number;
  extractionReports: MemoryExtractionReport[];
}

export interface DistillAndAddInput {
  profileId?: string | undefined;
  messages: IngestConversationInput["messages"];
  /**
   * Number of session-distillation groups to run concurrently.
   * Results are always persisted in session order.
   */
  concurrency?: number | undefined;
}

export interface DistillAndAddResult {
  profileId: string;
  observedAt: string;
  results: ObserveResult[];
  evidenceIds: string[];
  memoryIds: string[];
  worldBeliefIds: string[];
  distilledMemoryCount: number;
  embeddingCallCount: number;
  embeddedMemoryCount: number;
  embeddingFailureCount: number;
  distillationCallCount: number;
  distillationOkWithCandidatesCount: number;
  distillationEmptyCount: number;
  distillationParseFailureCount: number;
  distillationTransportFailureCount: number;
  distillationFailureCount: number;
  distillationTruncatedMessageCount: number;
}

export interface MemoryRecord {
  id: string;
  profileId: string;
  kind: MemoryKind;
  scope: string;
  content: string;
  sensitivity: Sensitivity;
  status: MemoryStatus;
  confidence: number;
  recallCount?: number | undefined;
  lastRecalledAt?: string | null | undefined;
  reinforcement?: number | undefined;
  sourceEventId?: string | null | undefined;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface WorldBeliefRecord {
  id: string;
  profileId: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  status: "active" | "candidate" | "rejected" | "superseded";
  sourceMemoryId?: string | null | undefined;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ActionPolicy {
  id: string;
  kind: "do_not_push" | "prefer" | "procedure" | "curiosity";
  text: string;
  priority: number;
  sourceMemoryId?: string | null | undefined;
  gapId?: string | undefined;
  gapKind?: MemoryGapKind | undefined;
  score?: number | undefined;
  sourceIds?: string[] | undefined;
}

export interface PreparedTurn {
  profileId: string;
  contextBlock: string;
  memories: MemoryRecord[];
  actionPolicies: ActionPolicy[];
  directives: string[];
  evidence: EvidenceEvent[];
  reconstruction?: ReconstructedContext | undefined;
  stats: {
    retrievedMemoryCount: number;
    actionPolicyCount: number;
    promptTokenEstimate: number;
  };
}

export type TurnExplanationExcludedReason =
  | "dormant"
  | "archived"
  | "superseded"
  | "out_of_window"
  | "sensitivity_gated"
  | "person_gated"
  | "incognito_gated"
  | "forget_residue"
  | "budget_cut"
  | "below_score_threshold"
  | "deduplicated";

export interface MemorySearchScoreComponents {
  confidence: number;
  retrievalScore: number;
  contentScore: number;
  ftsScore?: number | undefined;
  vectorScore?: number | undefined;
  associationScore?: number | undefined;
  fusionScore?: number | undefined;
  sourceTrust?: SourceTrust | undefined;
  annealing?: MemoryAnnealingState | undefined;
  finalScore: number;
}

export interface MemorySearchTraceDecision {
  memory: MemoryRecord;
  decision: "included" | "excluded";
  reason?: TurnExplanationExcludedReason | undefined;
  cues: string[];
  associations: string[];
  tags: string[];
  scoreComponents: MemorySearchScoreComponents;
}

export interface MemorySearchTraceCollector {
  recordMemorySearchDecision(decision: MemorySearchTraceDecision): void;
}

export type EmbeddingProvider =
  | ((texts: string[]) => Promise<number[][]>)
  | {
      name: string;
      dimensions: number;
      maxBatchSize?: number | undefined;
      embed(texts: string[]): Promise<number[][]>;
    };

export interface EmbeddingProviderConfig {
  provider: EmbeddingProvider;
  embedSensitive?: boolean | undefined;
  embedPerson?: boolean | undefined;
  timeoutMs?: number | undefined;
}

export interface MemoryVectorEmbedding {
  providerName: string;
  dimensions: number;
  vector: number[];
  status: "embedded" | "pending";
}

export interface QueryVectorEmbedding {
  providerName: string;
  dimensions: number;
  vector: number[];
}

export type QueryEmbeddingFailureReason = "timeout" | "http_status" | "transport" | "parse";

export interface MemoryRetrievalFusionWeights {
  fts?: number | undefined;
  vector?: number | undefined;
  association?: number | undefined;
}

export interface MemoryReadRetrievalOptions {
  embedQuery?: boolean | undefined;
  queryEmbeddingTimeoutMs?: number | undefined;
  onQueryEmbeddingFailure?: ((reason: QueryEmbeddingFailureReason) => void) | undefined;
  onQueryEmbeddingRetry?: ((reason: QueryEmbeddingFailureReason) => void) | undefined;
  onQueryEmbeddingRecovered?: (() => void) | undefined;
}

export interface MemoryRetrievalConfig extends MemoryReadRetrievalOptions {
  fusion?: MemoryRetrievalFusionWeights | undefined;
  reranker?: MemoryRetrievalReranker | undefined;
}

export interface MemoryRetrievalRerankerCandidate {
  id: string;
  kind: MemoryKind;
  snippet: string;
  fusedScore: number;
  sourceRole?: MemoryRole | undefined;
  sourceTrust?: SourceTrust | undefined;
}

export type MemoryRetrievalReranker =
  | ((
      candidates: MemoryRetrievalRerankerCandidate[],
      context?: {
        query: string;
        asOf?: string | undefined;
        purpose?: "context" | "history" | "delete" | "manage" | undefined;
      },
    ) => Promise<string[]> | string[])
  | {
      name?: string | undefined;
      rerank(
        candidates: MemoryRetrievalRerankerCandidate[],
        context?: {
          query: string;
          asOf?: string | undefined;
          purpose?: "context" | "history" | "delete" | "manage" | undefined;
        },
      ): Promise<string[]> | string[];
    };

export type MemoryQueryPlanner =
  | ((
      input: {
        question: string;
        maxAnchors?: number | undefined;
        maxSweepCues?: number | undefined;
      },
    ) => Promise<MemoryQueryPlan | ReconstructionRequiredAnchorHint[] | null | undefined> |
      MemoryQueryPlan |
      ReconstructionRequiredAnchorHint[] |
      null |
      undefined)
  | {
      name?: string | undefined;
      plan(
        input: {
          question: string;
          maxAnchors?: number | undefined;
          maxSweepCues?: number | undefined;
        },
      ): Promise<MemoryQueryPlan | ReconstructionRequiredAnchorHint[] | null | undefined> |
        MemoryQueryPlan |
        ReconstructionRequiredAnchorHint[] |
        null |
        undefined;
    };

interface MemoryQueryPlan {
  requiredAnchors?: ReconstructionRequiredAnchorHint[] | undefined;
  sweepCues?: string[] | undefined;
}

export interface ExplainTurnInput extends PrepareTurnInput {
  maxExcluded?: number | undefined;
}

export interface TurnExplanationMemoryRetention {
  recallCount?: number | undefined;
  reinforcement?: number | undefined;
  confidence: number;
}

export interface TurnExplanationIncludedMemory {
  id: string;
  kind: MemoryKind;
  status: MemoryStatus;
  content: string;
  temporalLabel?: string | undefined;
  retention: TurnExplanationMemoryRetention;
  cues: string[];
  associations: string[];
  tags: string[];
  scoreComponents: MemorySearchScoreComponents;
  evidenceEventIds: string[];
}

export interface TurnExplanationExcludedMemory {
  id: string;
  kind: MemoryKind;
  status: MemoryStatus;
  reason: TurnExplanationExcludedReason;
  retention: TurnExplanationMemoryRetention;
  cues: string[];
  associations: string[];
  tags: string[];
  scoreComponents: MemorySearchScoreComponents;
}

export interface TurnExplanationBudgetReport {
  dispositionPreset?: string | undefined;
  memorySearchLimit: number;
  contextBudgetTokens: number;
  promptTokenEstimate: number;
  actionPolicyCount: number;
    planner?: {
      maxSteps: number;
      maxBranch: number;
      maxMemories: number;
      stopReason: ReconstructedContext["stats"]["stopReason"];
      anchorCoverage?: ReconstructionAnchorCoverageReport | undefined;
      sweeps?: ReconstructedContext["stats"]["sweeps"] | undefined;
      layers?: ReconstructedContext["stats"]["layers"] | undefined;
      fullContentMemoryCount?: number | undefined;
    } | undefined;
  stoppedAt: "memory_search" | "token_budget" | "planner" | "complete";
}

export interface TurnExplanationReport {
  schema: "gmos.turn_explanation.v1";
  profileId: string;
  query: string;
  included: TurnExplanationIncludedMemory[];
  excluded: TurnExplanationExcludedMemory[];
  curiosity: TurnExplanationCuriosityReport;
  budgets: TurnExplanationBudgetReport;
  stats: PreparedTurn["stats"];
}

export type MemoryGapKind =
  | "stale_belief"
  | "contradiction_hotspot"
  | "coverage_gap"
  | "decaying_procedure";

export type MemoryGapSuppressionReason =
  | "boundary_protected"
  | "forgotten_subject"
  | "host_suppressed"
  | "person_material"
  | "redacted_evidence"
  | "sensitive_material";

export interface MemoryGapCandidate {
  id: string;
  profileId: string;
  kind: MemoryGapKind;
  subject: string;
  cue?: string | undefined;
  score: number;
  supportingRecordIds: string[];
  computedAt: string;
  payload: Record<string, unknown>;
}

export interface MemoryGapCandidateSearchResult {
  candidate: MemoryGapCandidate;
  suppressedReason?: MemoryGapSuppressionReason | undefined;
}

export interface MemoryGapCandidateListInput {
  profileId: string;
  query?: string | undefined;
  limit?: number | undefined;
  suppressGapIds?: string[] | undefined;
  includeSuppressed?: boolean | undefined;
}

export interface TurnExplanationCuriosityPrompt {
  gapId: string;
  kind: MemoryGapKind;
  score: number;
  sourceIds: string[];
  text: string;
}

export interface TurnExplanationCuriositySuppression {
  gapId: string;
  kind: MemoryGapKind;
  score: number;
  reason: MemoryGapSuppressionReason;
  sourceIds: string[];
}

export interface TurnExplanationCuriosityReport {
  emitted: TurnExplanationCuriosityPrompt[];
  suppressed: TurnExplanationCuriositySuppression[];
}

export type ReconstructionRecallPurpose = "context" | "history";

export interface ReconstructionIntentTagGroupHint {
  name?: string | undefined;
  tags: string[];
}

export interface ReconstructionRequiredAnchorHint {
  cue: string;
  hint?: string | undefined;
}

interface ReconstructionSweepCueStats {
  cue: string;
  matched: number;
  included: number;
  truncated: number;
}

interface ReconstructionSweepStats {
  matched: number;
  included: number;
  truncated: number;
  cues: ReconstructionSweepCueStats[];
}

export interface ReconstructionIntentHint {
  expectedTags?: string[] | undefined;
  requiredTagGroups?: ReconstructionIntentTagGroupHint[] | undefined;
  queryCues?: string[] | undefined;
  requiredAnchors?: ReconstructionRequiredAnchorHint[] | undefined;
  sweepCues?: string[] | undefined;
}

export type ReconstructionMemoryLayer = "summary" | "atom" | "turn";

export interface ReconstructionLayerCounts {
  summary: number;
  atom: number;
  turn: number;
}

export interface ReconstructionLayerPolicy {
  summaryMinShare?: number | undefined;
  turnMaxShare?: number | undefined;
}

export interface ReconstructionLayerStats {
  policy: {
    summaryMinShare: number;
    turnMaxShare: number;
  };
  candidates: ReconstructionLayerCounts;
  included: ReconstructionLayerCounts;
  culled: ReconstructionLayerCounts;
}

export interface ReconstructContextInput {
  profileId?: string | undefined;
  query?: string | undefined;
  messages?: TurnMessage[] | undefined;
  asOf?: string | undefined;
  dispositionPreset?: string | undefined;
  includeEvidence?: boolean | undefined;
  includeSensitive?: boolean | undefined;
  includeTemporalContext?: boolean | undefined;
  contextBudgetTokens?: number | undefined;
  maxSteps?: number | undefined;
  maxBranch?: number | undefined;
  maxMemories?: number | undefined;
  anchorCoverage?: boolean | undefined;
  stopWhenEvidenceEnough?: boolean | undefined;
  evidenceConvergenceThreshold?: number | undefined;
  includeTemporalMetadata?: boolean | undefined;
  temporalMode?: "auto" | "current" | "history" | undefined;
  recallPurpose?: ReconstructionRecallPurpose | undefined;
  reconstructionIntent?: ReconstructionIntentHint | undefined;
  maxCharsPerMemory?: number | undefined;
  fullContentTopRank?: number | undefined;
  fullContentMaxChars?: number | undefined;
  episodeExpansion?: "off" | "adjacent" | "full" | undefined;
  layerPolicy?: ReconstructionLayerPolicy | undefined;
  retrieval?: MemoryReadRetrievalOptions | undefined;
}

export interface ExplainEvidencePathInput extends ReconstructContextInput {
  includePlannerTrace?: boolean | undefined;
}

export interface ReconstructedEvidencePath {
  id: string;
  step: number;
  cue: string;
  tag: string;
  targetType: MemoryAssociationTargetType;
  targetId: string;
  targetKind?: string | undefined;
  targetSummary: string;
  confidence: number;
  routeScore?: number | undefined;
  routeReason?: string | undefined;
  routeSources?: string[] | undefined;
  informationGain?: number | undefined;
  sourceMemoryId?: string | null | undefined;
  sourceEvidenceId?: string | null | undefined;
  createdAt?: string | undefined;
  anchorCue?: string | undefined;
}

export interface ReconstructionAnchorCoverageEntry {
  anchorCue: string;
  required?: boolean | undefined;
  hint?: string | undefined;
  candidateCount: number;
  includedCount: number;
  uncovered: boolean;
}

export interface ReconstructionAnchorCoverageReport {
  anchorCount: number;
  coveredAnchorCount: number;
  uncoveredAnchors: string[];
  requiredAnchorCount: number;
  coveredRequiredAnchorCount: number;
  requiredAnchorUnmet: string[];
  anchors: ReconstructionAnchorCoverageEntry[];
}

export interface ReconstructedPlannerBranch {
  pathId: string;
  targetType: MemoryAssociationTargetType;
  targetId: string;
  targetKind?: string | undefined;
  tag: string;
  routeScore?: number | undefined;
  informationGain?: number | undefined;
  decision: "selected" | "selected_new_path" | "reinforced" | "pruned";
  reason: string;
  generatedCues: string[];
}

export interface ReconstructedPlannerStep {
  step: number;
  selectedCue: string;
  cueReason: string;
  exploredAssociationCount: number;
  hybridCandidateCount?: number | undefined;
  selectedBranchCount: number;
  prunedBranchCount: number;
  generatedCues: string[];
  branches: ReconstructedPlannerBranch[];
}

export interface ReconstructedPlannerTrace {
  mode: "associative" | "fallback";
  intentReason: string;
  initialCues: string[];
  maxSteps: number;
  maxBranch: number;
  maxMemories: number;
  anchorCoverage?: ReconstructionAnchorCoverageReport | undefined;
  steps: ReconstructedPlannerStep[];
  stopReason: ReconstructedContext["stats"]["stopReason"];
}

export interface ReconstructedContext {
  profileId: string;
  query: string;
  contextBlock: string;
  memories: MemoryRecord[];
  contentSurfaces?: {
    plain: string;
    temporal: string;
    referenceDate?: string | undefined;
  } | undefined;
  evidence: EvidenceEvent[];
  paths: ReconstructedEvidencePath[];
  plannerTrace?: ReconstructedPlannerTrace | undefined;
  stats: {
    stepCount: number;
    exploredCueCount: number;
    associationCount: number;
    retrievedMemoryCount: number;
    promptTokenEstimate: number;
    stopReason: "budget_exhausted" | "evidence_sufficient" | "no_frontier";
    evidenceCoverage?: {
      queryCueCount: number;
      coveredCueCount: number;
      coverageRate: number;
      coveredCues: string[];
      uncoveredCues: string[];
    } | undefined;
    uncertainty?: {
      level: "low" | "medium" | "high";
      reasons: string[];
    } | undefined;
    evidenceConvergence?: {
      score: number;
      reached: boolean;
      threshold: number;
      stopWhenEvidenceEnough: boolean;
      intentMatched: boolean;
      requiredIntentGroupCount: number;
      coveredIntentGroupCount: number;
      missingRequiredIntentGroups: string[];
      prunedBranchCount: number;
      frontierRemaining: number;
      selectedPathCount: number;
      selectedTags: string[];
    } | undefined;
    anchorCoverage?: ReconstructionAnchorCoverageReport | undefined;
    requiredAnchorUnmet?: string[] | undefined;
    sweeps?: ReconstructionSweepStats | undefined;
    layers?: ReconstructionLayerStats | undefined;
    fullContentMemoryCount?: number | undefined;
  };
}

export interface EvidencePathExplanation {
  schema: "gmos.evidence_path_explanation.v1";
  profileId: string;
  query: string;
  summary: {
    pathCount: number;
    evidenceCount: number;
    memoryCount: number;
    stopReason: ReconstructedContext["stats"]["stopReason"];
    convergenceReached: boolean;
    uncertaintyLevel: "low" | "medium" | "high" | null;
  };
  paths: ReconstructedEvidencePath[];
  evidence: EvidenceEvent[];
  stats: {
    evidenceCoverage?: ReconstructedContext["stats"]["evidenceCoverage"] | undefined;
    evidenceConvergence?: ReconstructedContext["stats"]["evidenceConvergence"] | undefined;
    uncertainty?: ReconstructedContext["stats"]["uncertainty"] | undefined;
    promptTokenEstimate: number;
    stepCount: number;
    exploredCueCount: number;
    associationCount: number;
    sweeps?: ReconstructedContext["stats"]["sweeps"] | undefined;
  };
  plannerTrace?: ReconstructedPlannerTrace | undefined;
}

export interface ReadAuditTableSnapshot {
  rowCount: number;
  stateHash: string;
}

export interface ReadAuditSnapshot {
  schema: "gmos.read_audit_snapshot.v1";
  tables: Record<string, ReadAuditTableSnapshot>;
}

export interface CommitOutcomeInput {
  profileId?: string | undefined;
  taskId?: string | undefined;
  objective: string;
  status: "completed" | "failed";
  summary?: string | undefined;
  failureKind?: FailureKind | undefined;
  createdAt?: string | undefined;
  usedMemoryIds?: string[] | undefined;
}

export interface FeedbackInput {
  profileId?: string | undefined;
  content: string;
  failureKind?: FailureKind | undefined;
  createdAt?: string | undefined;
  relatedMemoryIds?: string[] | undefined;
  signal?: "positive" | "negative" | undefined;
}

export interface ForgetInput {
  profileId?: string | undefined;
  query: string;
  targetTerms?: string[] | undefined;
  reason?: string | undefined;
}

export interface ForgetResult {
  archivedMemoryIds: string[];
}

export interface RestoreArchivedResult {
  restoredMemoryIds: string[];
}

export interface MemoryVersionSnapshot {
  memoryId: string;
  profileId: string;
  kind: MemoryKind;
  scope: string;
  content: string;
  sensitivity: Sensitivity;
  status: MemoryStatus;
  confidence: number;
  recallCount: number;
  lastRecalledAt?: string | null | undefined;
  reinforcement: number;
  sourceEventId?: string | null | undefined;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRollbackInput {
  profileId?: string | undefined;
  memoryId: string;
  toEvidenceEventId: string;
  approvedBy: string;
  rolledBackAt?: string | undefined;
}

export interface MemoryRollbackResult {
  rollbackEventId: string;
  profileId: string;
  memoryId: string;
  toEvidenceEventId: string;
  approvedBy: string;
  restoredValue: MemoryVersionSnapshot;
  previousValues: MemoryVersionSnapshot[];
  rolledBackAt: string;
}

export type MemoryRollbackErrorCode =
  | "approved_by_required"
  | "memory_not_found"
  | "target_event_not_found"
  | "target_event_not_in_chain"
  | "missing_previous_values";

export class MemoryRollbackError extends Error {
  readonly code: MemoryRollbackErrorCode;

  constructor(code: MemoryRollbackErrorCode, message: string) {
    super(message);
    this.name = "MemoryRollbackError";
    this.code = code;
  }
}

export interface ExplainResult {
  id: string;
  kind: "memory" | "belief";
  memoryKind?: MemoryKind | undefined;
  sensitivity?: Sensitivity | undefined;
  text: string;
  evidence: EvidenceEvent[];
  lifecycle: MemoryLifecycleHistory;
}

export type MemoryLifecycleHistoryEventKind =
  | "created"
  | "imported"
  | "updated"
  | "reinforced"
  | "propagated_reinforced"
  | "decayed_to_dormant"
  | "archived"
  | "consolidated_source"
  | "consolidated_survivor"
  | "consolidated_summary"
  | "distilled_source_trajectory"
  | "distilled_procedure"
  | "dossier_created"
  | "annealed"
  | "evolution_applied"
  | "evolution_reverted"
  | "rolled_back"
  | "derived_forget_archived"
  | "forgotten"
  | "restored"
  | "reactivated";

export interface MemoryLifecycleHistoryEntry {
  createdAt: string;
  eventKind: MemoryLifecycleHistoryEventKind;
  eventId?: string | undefined;
  sourceType?: string | undefined;
  fromStatus?: MemoryStatus | undefined;
  toStatus?: MemoryStatus | undefined;
  reasonSummary: string;
}

export interface MemoryLifecycleHistory {
  schema: "gmos.memory_lifecycle_history.v1";
  entries: MemoryLifecycleHistoryEntry[];
}

export interface LowLevelAddMemoryInput {
  profileId?: string | undefined;
  kind: MemoryKind;
  scope?: string | undefined;
  content: string;
  sensitivity?: Sensitivity | undefined;
  confidence?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
  createdAt?: string | undefined;
  allowPerson?: boolean | undefined;
}

export type LowLevelAddManySkippedReason = "empty_content" | "secret_like" | "person_routed";

export interface LowLevelAddManySkipped {
  index: number;
  reason: LowLevelAddManySkippedReason;
  message: string;
}

export interface LowLevelAddManyResult {
  memories: MemoryRecord[];
  skipped: LowLevelAddManySkipped[];
}

export interface LowLevelUpdateMemoryInput {
  profileId?: string | undefined;
  id: string;
  kind?: MemoryKind | undefined;
  scope?: string | undefined;
  content?: string | undefined;
  sensitivity?: Sensitivity | undefined;
  confidence?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
  replaceMetadata?: boolean | undefined;
  updatedAt?: string | undefined;
  allowPerson?: boolean | undefined;
}

export interface LowLevelArchiveMemoryInput {
  profileId?: string | undefined;
  id: string;
  reason?: string | undefined;
  archivedAt?: string | undefined;
}

export interface LowLevelRestoreArchivedMemoryInput {
  profileId?: string | undefined;
  id: string;
  reason?: string | undefined;
  restoredAt?: string | undefined;
}

export interface LowLevelClearMemoriesInput {
  profileId?: string | undefined;
  all?: boolean | undefined;
  scope?: string | undefined;
  metadataEquals?: {
    key: string;
    value: string;
  } | undefined;
  reason?: string | undefined;
  archivedAt?: string | undefined;
}

export interface LowLevelSearchInput {
  profileId?: string | undefined;
  query?: string | undefined;
  limit?: number | undefined;
  purpose?: "context" | "history" | "delete" | "manage" | undefined;
  includeSensitive?: boolean | undefined;
  includePerson?: boolean | undefined;
  retrieval?: MemoryReadRetrievalOptions | undefined;
}

export interface LowLevelListMemoriesInput {
  profileId?: string | undefined;
  query?: string | undefined;
  limit?: number | undefined;
  status?: MemoryStatus | "any" | undefined;
  kind?: MemoryKind | undefined;
  scope?: string | undefined;
  includeSensitive?: boolean | undefined;
  includePerson?: boolean | undefined;
}

export interface LowLevelGetMemoryInput {
  profileId?: string | undefined;
  id: string;
  includeSensitive?: boolean | undefined;
  includePerson?: boolean | undefined;
  includeArchived?: boolean | undefined;
}

export interface MemorySearchInput {
  profileId: string;
  query?: string;
  limit?: number;
  asOf?: string | undefined;
  scoreThreshold?: number | undefined;
  purpose?: "context" | "history" | "delete" | "manage";
  includeSensitive?: boolean | undefined;
  includePerson?: boolean | undefined;
  includeSecretLike?: boolean | undefined;
  trace?: MemorySearchTraceCollector | undefined;
  retrieval?: MemoryRetrievalConfig | undefined;
  queryEmbedding?: QueryVectorEmbedding | null | undefined;
  freshQueryEmbedding?: boolean | undefined;
}

export type MemoryAssociationTargetType = "memory" | "world_belief" | "task_trajectory";

export interface MemoryAssociationRecord {
  id: string;
  profileId: string;
  cue: string;
  cueKind: MemoryAssociationCueKind;
  tag: string;
  targetType: MemoryAssociationTargetType;
  targetId: string;
  targetKind: string;
  targetSummary: string;
  sensitivity: Sensitivity;
  status: "active" | "archived";
  confidence: number;
  sourceMemoryId?: string | null | undefined;
  sourceBeliefId?: string | null | undefined;
  sourceTaskTrajectoryId?: string | null | undefined;
  sourceEvidenceId?: string | null | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryAssociationSearchInput {
  profileId: string;
  query: string;
  limit?: number | undefined;
  asOf?: string | undefined;
  purpose?: "context" | "history" | undefined;
  includeSensitive?: boolean | undefined;
  includePerson?: boolean | undefined;
}

export interface RebuildAssociationsInput {
  profileId?: string | undefined;
}

export interface RebuildAssociationsResult {
  rebuiltAssociationCount: number;
}

export interface MemoryListInput {
  profileId: string;
  query?: string | undefined;
  limit?: number | undefined;
  status?: MemoryStatus | "any" | undefined;
  kind?: MemoryKind | undefined;
  scope?: string | undefined;
  metadataEquals?: {
    key: string;
    value: string;
  } | undefined;
  includeSensitive?: boolean | undefined;
  includePerson?: boolean | undefined;
}

export interface RecordEvidenceInput {
  profileId: string;
  eventKey: string;
  sourceType: string;
  sourceUri?: string | null | undefined;
  content: string;
  sensitivity: Sensitivity;
  eligibleForLongTermMemory: boolean;
  payload?: Record<string, unknown> | undefined;
  createdAt?: string | undefined;
}

export interface EvidenceListInput {
  profileId: string;
  limit?: number | undefined;
  sourceType?: string | undefined;
  includeSensitive?: boolean | undefined;
  eligibleForLongTermMemory?: boolean | undefined;
}

export interface WorldBeliefListInput {
  profileId: string;
  status?: WorldBeliefRecord["status"] | "any" | undefined;
  limit?: number | undefined;
}

export interface AddMemoryInput {
  profileId: string;
  kind: MemoryKind;
  scope?: string;
  content: string;
  sensitivity?: Sensitivity | undefined;
  confidence?: number | undefined;
  sourceEventId?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
  createdAt?: string | undefined;
  embedding?: MemoryVectorEmbedding | undefined;
}

export interface UpdateMemoryInput {
  profileId: string;
  id: string;
  kind?: MemoryKind | undefined;
  scope?: string | undefined;
  content?: string | undefined;
  sensitivity?: Sensitivity | undefined;
  confidence?: number | undefined;
  sourceEventId?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
  updatedAt?: string | undefined;
  embedding?: MemoryVectorEmbedding | undefined;
}

export interface ArchiveMemoryInput {
  profileId: string;
  id: string;
  reason?: string | undefined;
  archivedAt?: string | undefined;
}

export interface RestoreArchivedMemoryInput {
  profileId: string;
  id: string;
  reason?: string | undefined;
  restoredAt?: string | undefined;
}

export interface ArchiveMemoriesInput {
  profileId: string;
  all?: boolean | undefined;
  scope?: string | undefined;
  metadataEquals?: {
    key: string;
    value: string;
  } | undefined;
  reason?: string | undefined;
  archivedAt?: string | undefined;
}

export interface AddWorldBeliefInput {
  profileId: string;
  subject: string;
  subjectAliases?: readonly string[] | undefined;
  predicate: string;
  object: string;
  confidence?: number | undefined;
  sourceMemoryId?: string | null | undefined;
  cardinality?: "single" | "multi" | undefined;
  metadata?: Record<string, unknown> | undefined;
  createdAt?: string | undefined;
}

export interface RecordConsolidationSummaryInput {
  profileId: string;
  kind: MemoryKind;
  content: string;
  sensitivity: Sensitivity;
  confidence: number;
  sourceMemoryIds: string[];
  sharedTags: string[];
  createdAt: string;
  metadata?: Record<string, unknown> | undefined;
  embedding?: MemoryVectorEmbedding | undefined;
  belief?: {
    subject: string;
    predicate: string;
    object: string;
  } | undefined;
}

export interface RecordConsolidationSummaryResult {
  memory: MemoryRecord;
  worldBelief?: WorldBeliefRecord | undefined;
  dormantSourceIds: string[];
}

export interface RecordProcedureDistillationInput {
  profileId: string;
  objective: string;
  content: string;
  sensitivity: Sensitivity;
  confidence: number;
  sourceTrajectoryIds: string[];
  sharedTags: string[];
  clusterKey: string;
  createdAt: string;
  metadata?: Record<string, unknown> | undefined;
  embedding?: MemoryVectorEmbedding | undefined;
}

export interface RecordProcedureDistillationResult {
  memory: MemoryRecord;
  alreadyExists: boolean;
}

export type EvolutionAction =
  | {
      type: "adjust_reinforcement";
      memoryId: string;
      delta: number;
    }
  | {
      type: "adjust_confidence";
      memoryId: string;
      delta: number;
    }
  | {
      type: "demote_to_dormant";
      memoryId: string;
    }
  | {
      type: "reactivate";
      memoryId: string;
    };

export interface EvolutionPreviousMemoryValue {
  memoryId: string;
  confidence: number;
  reinforcement: number;
  status: MemoryStatus;
  updatedAt: string;
}

export interface MemoryAnnealingConfig {
  enabled?: boolean | undefined;
  windowMs?: number | undefined;
  boostThreshold?: number | undefined;
  confidenceCap?: number | undefined;
  retentionCap?: number | undefined;
}

export interface ResolvedMemoryAnnealingConfig {
  enabled: boolean;
  windowMs: number;
  boostThreshold: number;
  confidenceCap: number;
  retentionCap: number;
}

export interface MemoryAnnealingState {
  active: boolean;
  reason: string;
  sourceTrust?: SourceTrust | undefined;
  capConfidence?: number | undefined;
  retentionCap?: number | undefined;
  startedAt?: string | undefined;
  confirmedAt?: string | undefined;
}

export interface EvolutionApplyStoreInput {
  profileId: string;
  proposalId: string;
  approvedBy: string;
  actions: EvolutionAction[];
  appliedAt: string;
}

export interface EvolutionApplyStoreResult {
  applicationEventId: string;
  proposalId: string;
  actions: EvolutionAction[];
  previousValues: EvolutionPreviousMemoryValue[];
  appliedAt: string;
}

export interface EvolutionRevertStoreInput {
  profileId?: string | undefined;
  applicationEventId: string;
  revertedAt: string;
}

export interface EvolutionRevertStoreResult {
  revertEventId: string;
  applicationEventId: string;
  restoredValues: EvolutionPreviousMemoryValue[];
  revertedAt: string;
}

export interface RecordFailureInput {
  profileId: string;
  failureKind: FailureKind;
  content: string;
  createdAt?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface FailureEventRecord {
  id: string;
  profileId: string;
  failureKind: FailureKind;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ListFailuresInput {
  profileId: string;
  failureKind?: FailureKind | undefined;
  limit?: number | undefined;
}

export interface TaskTrajectoryInput {
  profileId: string;
  taskId?: string | undefined;
  objective: string;
  status: "completed" | "failed";
  summary?: string | undefined;
  createdAt?: string | undefined;
}

export interface TaskTrajectoryRecord {
  id: string;
  profileId: string;
  taskId?: string | null | undefined;
  objective: string;
  status: "completed" | "failed";
  summary?: string | null | undefined;
  createdAt: string;
}

export interface CommitOutcomeStoreInput extends TaskTrajectoryInput {
  usedMemoryIds?: string[] | undefined;
  failure?: RecordFailureInput | undefined;
  outcomeReinforcement?: ResolvedOutcomeReinforcementConfig | undefined;
  confidenceAnnealing?: ResolvedMemoryAnnealingConfig | undefined;
}

export interface FeedbackSignalStoreInput extends RecordFailureInput {
  relatedMemoryIds?: string[] | undefined;
  signal?: "positive" | "negative" | undefined;
  confidencePenalty?: ResolvedFeedbackConfidencePenaltyConfig | undefined;
  confidenceAnnealing?: ResolvedMemoryAnnealingConfig | undefined;
}

export interface OutcomeReinforcementConfig {
  enabled?: boolean | undefined;
  step?: number | undefined;
  provenanceCredit?: ProvenanceCreditConfig | undefined;
}

export interface FeedbackConfidencePenaltyConfig {
  enabled?: boolean | undefined;
  step?: number | undefined;
  floor?: number | undefined;
}

export interface ProvenanceCreditConfig {
  enabled?: boolean | undefined;
  hopDecay?: number | undefined;
  maxCreditDepth?: number | undefined;
  maxCreditFanout?: number | undefined;
}

export interface MemoryLifecycleConfig {
  enabled?: boolean | undefined;
  halfLivesDays?: Partial<Record<MemoryKind, number>> | undefined;
  dormantBelow?: number | undefined;
  archiveAfterDormantDays?: number | undefined;
  autoTransitionKinds?: MemoryKind[] | undefined;
  outcomeReinforcement?: OutcomeReinforcementConfig | undefined;
  feedbackConfidencePenalty?: FeedbackConfidencePenaltyConfig | undefined;
  confidenceAnnealing?: MemoryAnnealingConfig | undefined;
}

export interface MemoryTrustConfig {
  agentConfidenceCap?: number | undefined;
  externalConfidenceCap?: number | undefined;
  allowLowerTrustPolicyWrites?: boolean | undefined;
}

export interface ResolvedMemoryTrustConfig {
  agentConfidenceCap: number;
  externalConfidenceCap: number;
  allowLowerTrustPolicyWrites: boolean;
}

export interface MemoryConsolidationConfig {
  enabled?: boolean | undefined;
  tagOverlapThreshold?: number | undefined;
  duplicateMinClusterSize?: number | undefined;
  hookMinClusterSize?: number | undefined;
  maxClustersPerRun?: number | undefined;
  maxMembersPerCluster?: number | undefined;
  eligibleKinds?: MemoryKind[] | undefined;
  entityConsolidation?: {
    enabled?: boolean | undefined;
    minClusterSize?: number | undefined;
    maxClustersPerRun?: number | undefined;
    maxMembersPerCluster?: number | undefined;
  } | undefined;
}

export interface MemoryProcedureDistillationConfig {
  enabled?: boolean | undefined;
  minRepeats?: number | undefined;
  maxClustersPerRun?: number | undefined;
  maxTrajectoriesPerCluster?: number | undefined;
}

export interface MemoryDossierConfig {
  enabled?: boolean | undefined;
  minBeliefs?: number | undefined;
  minLinkedMemories?: number | undefined;
  maxEntitiesPerRun?: number | undefined;
  maxBeliefsPerEntity?: number | undefined;
  maxMemoriesPerEntity?: number | undefined;
}

export interface MemoryExplorationConfig {
  enabled?: boolean | undefined;
  curiosityBudget?: number | undefined;
  maxCandidatesPerRun?: number | undefined;
  maxCandidatesPerKind?: number | undefined;
  minScore?: number | undefined;
  recentWindowDays?: number | undefined;
}

export type MaintenancePhase = "decay" | "consolidate" | "distill" | "dossier" | "explore";

export interface ResolvedOutcomeReinforcementConfig {
  enabled: boolean;
  step: number;
  provenanceCredit: ResolvedProvenanceCreditConfig;
}

export interface ResolvedFeedbackConfidencePenaltyConfig {
  enabled: boolean;
  step: number;
  floor: number;
}

export interface ResolvedProvenanceCreditConfig {
  enabled: boolean;
  hopDecay: number;
  maxCreditDepth: number;
  maxCreditFanout: number;
}

export interface ResolvedMemoryLifecycleConfig {
  enabled: boolean;
  halfLivesDays: Record<MemoryKind, number>;
  dormantBelow: number;
  archiveAfterDormantDays: number;
  autoTransitionKinds: MemoryKind[];
  outcomeReinforcement: ResolvedOutcomeReinforcementConfig;
  feedbackConfidencePenalty: ResolvedFeedbackConfidencePenaltyConfig;
  confidenceAnnealing: ResolvedMemoryAnnealingConfig;
}

export interface ResolvedMemoryConsolidationConfig {
  enabled: boolean;
  tagOverlapThreshold: number;
  duplicateMinClusterSize: number;
  hookMinClusterSize: number;
  maxClustersPerRun: number;
  maxMembersPerCluster: number;
  eligibleKinds: MemoryKind[];
  entityConsolidation: {
    enabled: boolean;
    minClusterSize: number;
    maxClustersPerRun: number;
    maxMembersPerCluster: number;
  };
}

export interface ResolvedMemoryProcedureDistillationConfig {
  enabled: boolean;
  minRepeats: number;
  maxClustersPerRun: number;
  maxTrajectoriesPerCluster: number;
}

export interface ResolvedMemoryDossierConfig {
  enabled: boolean;
  minBeliefs: number;
  minLinkedMemories: number;
  maxEntitiesPerRun: number;
  maxBeliefsPerEntity: number;
  maxMemoriesPerEntity: number;
}

export interface ResolvedMemoryExplorationConfig {
  enabled: boolean;
  curiosityBudget: number;
  maxCandidatesPerRun: number;
  maxCandidatesPerKind: number;
  minScore: number;
  recentWindowDays: number;
}

export interface MaintenanceInput {
  profileId?: string | undefined;
  dryRun?: boolean | undefined;
  now?: string | undefined;
  phases?: MaintenancePhase[] | undefined;
}

export interface MaintenanceTransition {
  memoryId: string;
  kind: MemoryKind;
  from: MemoryStatus;
  to: MemoryStatus;
  retention: number;
  reasons: string[];
}

export interface MaintenanceExemption {
  memoryId: string;
  kind: MemoryKind;
  status: MemoryStatus;
  reason: string;
}

export interface MaintenanceSkippedSummary {
  reason: string;
  count: number;
}

export interface MaintenanceDuplicateConsolidation {
  kind: MemoryKind;
  survivorId: string;
  memberIds: string[];
  archivedMemberIds: string[];
  reasons: string[];
}

export interface MaintenanceSummaryConsolidation {
  kind: MemoryKind;
  sourceMemoryIds: string[];
  sharedTags: string[];
  content: string;
  confidence: number;
  memoryId?: string | undefined;
  worldBeliefId?: string | undefined;
  reasons: string[];
}

export interface MaintenanceConsolidationRejection {
  kind: MemoryKind;
  sourceMemoryIds: string[];
  reason: string;
}

export interface MaintenanceConsolidationReport {
  enabled: boolean;
  evaluated: number;
  duplicateClusters: MaintenanceDuplicateConsolidation[];
  entityClusters?: Array<{
    kind: MemoryKind;
    entityKey: string;
    entityObject: string;
    sourceMemoryIds: string[];
    summaryMemoryId?: string | undefined;
    reasons: string[];
  }> | undefined;
  summaryMemories: MaintenanceSummaryConsolidation[];
  rejectedCandidates: MaintenanceConsolidationRejection[];
  skipped: MaintenanceSkippedSummary[];
}

export interface MaintenanceProcedureDistillation {
  objective: string;
  sourceTrajectoryIds: string[];
  sharedTags: string[];
  clusterKey: string;
}

export interface MaintenanceProcedureDistillationSummary {
  sourceTrajectoryIds: string[];
  objective: string;
  sharedTags: string[];
  content: string;
  confidence: number;
  memoryId?: string | undefined;
  reasons: string[];
}

export interface MaintenanceProcedureDistillationRejection {
  sourceTrajectoryIds: string[];
  reason: string;
}

export interface MaintenanceDistillationReport {
  enabled: boolean;
  evaluated: number;
  clusters: MaintenanceProcedureDistillation[];
  summaryMemories: MaintenanceProcedureDistillationSummary[];
  rejectedCandidates: MaintenanceProcedureDistillationRejection[];
  skipped: MaintenanceSkippedSummary[];
}

export interface MaintenanceDossierEntity {
  entityKey: string;
  kind: MemoryKind;
  sourceBeliefIds: string[];
  sourceMemoryIds: string[];
}

export interface MaintenanceDossierSummary extends MaintenanceDossierEntity {
  content: string;
  confidence: number;
  memoryId?: string | undefined;
  supersededMemoryId?: string | undefined;
  reasons: string[];
}

export interface MaintenanceDossierRejection extends MaintenanceDossierEntity {
  reason: string;
}

export interface MaintenanceDossierReport {
  enabled: boolean;
  evaluated: number;
  entities: MaintenanceDossierEntity[];
  summaryMemories: MaintenanceDossierSummary[];
  rejectedCandidates: MaintenanceDossierRejection[];
  skipped: MaintenanceSkippedSummary[];
}

export interface MaintenanceExplorationCandidate {
  id: string;
  kind: MemoryGapKind;
  subject: string;
  cue?: string | undefined;
  score: number;
  supportingRecordIds: string[];
  computedAt: string;
}

export interface MaintenanceExplorationReport {
  enabled: boolean;
  evaluated: number;
  generated: number;
  persisted: number;
  closedSinceLastRun: number;
  candidates: MaintenanceExplorationCandidate[];
  suppressed: MaintenanceSkippedSummary[];
  skipped: MaintenanceSkippedSummary[];
}

export interface MaintenanceReport {
  schema: "gmos.maintenance_report.v1";
  profileId: string;
  now: string;
  dryRun: boolean;
  evaluated: number;
  transitions: MaintenanceTransition[];
  exempted: MaintenanceExemption[];
  skipped: MaintenanceSkippedSummary[];
  consolidation: MaintenanceConsolidationReport;
  distillation: MaintenanceDistillationReport;
  dossier: MaintenanceDossierReport;
  exploration: MaintenanceExplorationReport;
}

export interface MaintenanceStoreInput extends MaintenanceInput {
  profileId: string;
  now: string;
  dryRun: boolean;
  phases: MaintenancePhase[];
  lifecycle: ResolvedMemoryLifecycleConfig;
  consolidation: ResolvedMemoryConsolidationConfig;
  distillation: ResolvedMemoryProcedureDistillationConfig;
  dossier: ResolvedMemoryDossierConfig;
  exploration: ResolvedMemoryExplorationConfig;
}

export interface MemoryLifecycleStatus {
  schema: "gmos.lifecycle_status.v1";
  profileId?: string | undefined;
  counts: Record<MemoryStatus, number> & { total: number };
  lastMaintenanceAt?: string | undefined;
  consolidationEvidenceCount: number;
  lastConsolidationAt?: string | undefined;
}

export interface ArchiveStaleHostImportsInput {
  profileId: string;
  sourceType: string;
  activeImportKeys: string[];
  archivedAt?: string | undefined;
}

export interface AtomicImportedMemoryResult {
  sourceIndex: number;
  memory: MemoryRecord;
  disposition: "inserted" | "reused" | "restored";
}

export interface AtomicMem0ImportRecord {
  sourceIndex: number;
  originalId: string;
  content: string;
  kind: MemoryKind;
  scope: string;
  sensitivity: Sensitivity;
  metadata: Record<string, unknown>;
  createdAt?: string | undefined;
}

export interface ImportMem0RecordsAtomicallyInput {
  profileId: string;
  sourceFileHash: string;
  records: AtomicMem0ImportRecord[];
  occurredAt: string;
}

export interface AtomicHostSnapshotRecord {
  sourceIndex: number;
  hostMemoryId: string;
  content: string;
  kind: MemoryKind;
  scope: string;
  sensitivity: Sensitivity;
  confidence: number;
  sourceUri: string;
  metadata: Record<string, unknown>;
  createdAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
}

export interface ImportHostSnapshotsAtomicallyInput {
  profileId: string;
  sourceType: string;
  records: AtomicHostSnapshotRecord[];
  sync: boolean;
  allowSecretLike: boolean;
  occurredAt: string;
}

export interface ImportHostSnapshotsAtomicallyResult {
  memories: AtomicImportedMemoryResult[];
  archivedMemoryIds: string[];
}

export interface SearchIndexStatus {
  status: "ok" | "missing" | "stale" | "unsupported";
  totalMemoryCount: number;
  indexedMemoryCount: number;
  activeMemoryCount: number;
  missingEntryCount: number;
  staleEntryCount: number;
  orphanEntryCount: number;
  duplicateEntryCount: number;
  vectorIndex?: {
    status: "ok" | "missing" | "stale" | "unsupported";
    indexedMemoryCount: number;
    missingEntryCount: number;
    staleEntryCount: number;
    orphanEntryCount: number;
    duplicateEntryCount: number;
    providerName: string;
    providerDimensions: number;
    embeddedEntryCount: number;
    pendingEntryCount: number;
    staleProviderEntryCount: number;
    dimensions: number;
  } | undefined;
}

export interface RepairSearchIndexInput {
  dryRun?: boolean | undefined;
  vectorBatchSize?: number | undefined;
  now?: string | undefined;
}

export interface RepairSearchIndexResult {
  repaired: boolean;
  dryRun: boolean;
  before: SearchIndexStatus;
  after: SearchIndexStatus;
  repairedAt: string;
  vectorBackfill: {
    batchSize: number;
    candidateCount: number;
    embeddedCount: number;
    fallbackCount: number;
    pendingCount: number;
    staleProviderCount: number;
    skippedCount: number;
  };
}

export interface MemoryStore {
  configureEmbeddingProvider?(
    input: EmbeddingProvider | EmbeddingProviderConfig | undefined,
  ): void;
  initialize(): Promise<void> | void;
  close(): Promise<void> | void;
  claimEvidence(input: RecordEvidenceInput):
    | Promise<{ evidence: EvidenceEvent; inserted: boolean }>
    | { evidence: EvidenceEvent; inserted: boolean };
  recordEvidence(input: RecordEvidenceInput): Promise<EvidenceEvent> | EvidenceEvent;
  getEvidenceByEventKey?(eventKey: string): Promise<EvidenceEvent | null> | EvidenceEvent | null;
  /** Pair with evidenceMutationVersion to enable safe negative-result caching. */
  hasLegacyEvidenceKeys?(
    profileId: string,
    sourceType: string,
  ): Promise<boolean> | boolean;
  /** Must change whenever hasLegacyEvidenceKeys could change for this profile/source pair. */
  evidenceMutationVersion?(
    profileId: string,
    sourceType: string,
  ): Promise<string | number> | string | number;
  addMemory(input: AddMemoryInput): Promise<MemoryRecord> | MemoryRecord;
  addMemories?(input: AddMemoryInput[]): Promise<MemoryRecord[]> | MemoryRecord[];
  updateMemory?(input: UpdateMemoryInput): Promise<MemoryRecord | null> | MemoryRecord | null;
  archiveMemoryById?(input: ArchiveMemoryInput): Promise<boolean> | boolean;
  restoreArchivedMemory?(input: RestoreArchivedMemoryInput): Promise<boolean> | boolean;
  archiveMemories?(input: ArchiveMemoriesInput): Promise<string[]> | string[];
  addWorldBelief(input: AddWorldBeliefInput): Promise<WorldBeliefRecord> | WorldBeliefRecord;
  listWorldBeliefs?(
    input: WorldBeliefListInput,
  ): Promise<WorldBeliefRecord[]> | WorldBeliefRecord[];
  searchMemories(input: MemorySearchInput): Promise<MemoryRecord[]> | MemoryRecord[];
  listMemories?(input: MemoryListInput): Promise<MemoryRecord[]> | MemoryRecord[];
  getMemoryById(
    profileId: string,
    id: string,
    options?: {
      includeSensitive?: boolean | undefined;
      includePerson?: boolean | undefined;
      includeArchived?: boolean | undefined;
    },
  ): Promise<MemoryRecord | null> | MemoryRecord | null;
  findActiveMemoryByMetadata?(
    profileId: string,
    key: string,
    value: string,
  ): Promise<MemoryRecord | null> | MemoryRecord | null;
  importMem0RecordsAtomically?(
    input: ImportMem0RecordsAtomicallyInput,
  ): Promise<AtomicImportedMemoryResult[]> | AtomicImportedMemoryResult[];
  importHostSnapshotsAtomically?(
    input: ImportHostSnapshotsAtomicallyInput,
  ): Promise<ImportHostSnapshotsAtomicallyResult> | ImportHostSnapshotsAtomicallyResult;
  archiveStaleHostImports?(
    input: ArchiveStaleHostImportsInput,
  ): Promise<string[]> | string[];
  commitOutcome?(input: CommitOutcomeStoreInput): Promise<void> | void;
  recordFeedbackSignal?(input: FeedbackSignalStoreInput): Promise<void> | void;
  maintain?(input: MaintenanceStoreInput): Promise<MaintenanceReport> | MaintenanceReport;
  recordConsolidationSummary?(
    input: RecordConsolidationSummaryInput,
  ): Promise<RecordConsolidationSummaryResult> | RecordConsolidationSummaryResult;
  listTaskTrajectories?(
    input: { profileId: string; limit?: number | undefined },
  ): Promise<TaskTrajectoryRecord[]> | TaskTrajectoryRecord[];
  recordProcedureDistillation?(
    input: RecordProcedureDistillationInput,
  ): Promise<RecordProcedureDistillationResult> | RecordProcedureDistillationResult;
  applyEvolutionActions?(
    input: EvolutionApplyStoreInput,
  ): Promise<EvolutionApplyStoreResult> | EvolutionApplyStoreResult;
  revertEvolutionApplication?(
    input: EvolutionRevertStoreInput,
  ): Promise<EvolutionRevertStoreResult> | EvolutionRevertStoreResult;
  rollbackMemory?(
    input: MemoryRollbackInput & { profileId: string },
  ): Promise<MemoryRollbackResult> | MemoryRollbackResult;
  lifecycleStatus?(
    input?: { profileId?: string | undefined },
  ): Promise<MemoryLifecycleStatus> | MemoryLifecycleStatus;
  listActionPolicies(
    profileId: string,
    options?: { includeSensitive?: boolean | undefined },
  ): Promise<ActionPolicy[]> | ActionPolicy[];
  listGapCandidates?(
    input: MemoryGapCandidateListInput,
  ): Promise<MemoryGapCandidateSearchResult[]> | MemoryGapCandidateSearchResult[];
  listEvidence?(input: EvidenceListInput): Promise<EvidenceEvent[]> | EvidenceEvent[];
  listEvidenceForMemory(memoryId: string): Promise<EvidenceEvent[]> | EvidenceEvent[];
  searchAssociations?(
    input: MemoryAssociationSearchInput,
  ): Promise<MemoryAssociationRecord[]> | MemoryAssociationRecord[];
  rebuildAssociations?(
    input?: RebuildAssociationsInput,
  ): Promise<RebuildAssociationsResult> | RebuildAssociationsResult;
  forget(input: ForgetInput & { profileId: string }): Promise<ForgetResult> | ForgetResult;
  recordFailure(input: RecordFailureInput): Promise<void> | void;
  listFailures?(input: ListFailuresInput): Promise<FailureEventRecord[]> | FailureEventRecord[];
  recordTaskTrajectory(input: TaskTrajectoryInput): Promise<void> | void;
  rowCounts(): Promise<Record<string, number>> | Record<string, number>;
  readAuditSnapshot?(): Promise<ReadAuditSnapshot> | ReadAuditSnapshot;
  schemaVersion?(): Promise<number> | number;
  searchIndexStatus?(): Promise<SearchIndexStatus> | SearchIndexStatus;
  repairSearchIndex?(
    input?: RepairSearchIndexInput,
  ): Promise<RepairSearchIndexResult> | RepairSearchIndexResult;
}

export interface MemoryOSOptions {
  profileId?: string | undefined;
  store: MemoryStore;
  disposition?: string | undefined;
  extractor?: MemoryExtractor | undefined;
  sessionDistiller?: MemorySessionDistiller | undefined;
  consolidator?: MemoryConsolidator | undefined;
  procedureDistiller?: MemoryProcedureDistiller | undefined;
  dossierSynthesizer?: MemoryDossierSynthesizer | undefined;
  embeddingProvider?: EmbeddingProvider | EmbeddingProviderConfig | undefined;
  retrieval?: MemoryRetrievalConfig | undefined;
  entityResolver?: EntityResolver | undefined;
  temporal?: {
    parser?: MemoryTemporalParser | undefined;
    inferFromText?: boolean | undefined;
  } | undefined;
  extraction?: {
    minConfidence?: number | undefined;
    extractFromRoles?: MemoryRole[] | undefined;
  } | undefined;
  reconstruction?: {
    cueExtractor?: MemoryCueExtractor | undefined;
    inferTemporalCuesFromText?: boolean | undefined;
  } | undefined;
  lifecycle?: MemoryLifecycleConfig | undefined;
  trust?: MemoryTrustConfig | undefined;
  consolidation?: MemoryConsolidationConfig | undefined;
  distillation?: MemoryProcedureDistillationConfig | undefined;
  dossier?: MemoryDossierConfig | undefined;
  exploration?: MemoryExplorationConfig | undefined;
  safety?: {
    /**
     * Host-specific additive sensitivity classifier.
     *
     * gmOS always keeps the built-in conservative classifier active and combines
     * the host result with the built-in result by maximum sensitivity. Hosts can
     * mark additional local domains as sensitive or secret-like, but cannot
     * downgrade built-in secret-like detections through this option.
     */
    sensitivityClassifier?: MemorySensitivityClassifier | undefined;
  } | undefined;
  host?: {
    hostId?: string | undefined;
    capabilities?: Record<string, boolean> | undefined;
  } | undefined;
}

export interface MemoryOS {
  add(input: LowLevelAddMemoryInput): Promise<MemoryRecord>;
  addMany(inputs: LowLevelAddMemoryInput[]): Promise<LowLevelAddManyResult>;
  distillAndAdd(input: DistillAndAddInput): Promise<DistillAndAddResult>;
  update(input: LowLevelUpdateMemoryInput): Promise<MemoryRecord | null>;
  archive(input: LowLevelArchiveMemoryInput): Promise<ForgetResult>;
  restoreArchived(input: LowLevelRestoreArchivedMemoryInput): Promise<RestoreArchivedResult>;
  clear(input: LowLevelClearMemoriesInput): Promise<ForgetResult>;
  search(input?: LowLevelSearchInput): Promise<MemoryRecord[]>;
  list(input?: LowLevelListMemoriesInput): Promise<MemoryRecord[]>;
  get(input: LowLevelGetMemoryInput): Promise<MemoryRecord | null>;
  observe(event: HostEvent): Promise<void>;
  observeWithReport(event: HostEvent): Promise<ObserveResult>;
  ingestConversation(input: IngestConversationInput): Promise<IngestConversationResult>;
  listEvidence(
    input?: Omit<EvidenceListInput, "profileId"> & { profileId?: string | undefined },
  ): Promise<EvidenceEvent[]>;
  prepareTurn(input: PrepareTurnInput): Promise<PreparedTurn>;
  explainTurn(input: ExplainTurnInput): Promise<TurnExplanationReport>;
  reconstructContext(input: ReconstructContextInput): Promise<ReconstructedContext>;
  explainEvidencePath(input: ExplainEvidencePathInput): Promise<EvidencePathExplanation>;
  commitOutcome(input: CommitOutcomeInput): Promise<void>;
  recordFeedback(input: FeedbackInput): Promise<void>;
  maintain(input?: MaintenanceInput): Promise<MaintenanceReport>;
  memoryRollback(input: MemoryRollbackInput): Promise<MemoryRollbackResult>;
  forget(input: ForgetInput): Promise<ForgetResult>;
  explain(id: string, profileId?: string): Promise<ExplainResult | null>;
  close(): Promise<void>;
}
