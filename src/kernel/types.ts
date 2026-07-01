import type { EntityResolver } from "./entities.js";

export type MemoryRole = "system" | "user" | "assistant" | "tool";

export type PrivacyMode = "normal" | "incognito";

export type Sensitivity = "normal" | "sensitive" | "secret_like";

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

export type MemoryStatus = "active" | "archived";

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
}

export interface ConversationMessageEvent {
  type: "conversation.message";
  profileId?: string | undefined;
  conversationId?: string | undefined;
  messageId?: string | undefined;
  role: MemoryRole;
  content: string;
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
  task?: {
    intent?: string | undefined;
    projectId?: string | undefined;
    topic?: string | undefined;
  } | undefined;
  includeEvidence?: boolean | undefined;
  includeSensitive?: boolean | undefined;
  contextBudgetTokens?: number | undefined;
  reconstruction?: {
    mode: "shadow";
    maxSteps?: number | undefined;
    maxBranch?: number | undefined;
    maxMemories?: number | undefined;
    stopWhenEvidenceEnough?: boolean | undefined;
    evidenceConvergenceThreshold?: number | undefined;
    includeTemporalMetadata?: boolean | undefined;
    temporalMode?: "auto" | "current" | "history" | undefined;
    recallPurpose?: ReconstructionRecallPurpose | undefined;
    reconstructionIntent?: ReconstructionIntentHint | undefined;
  } | undefined;
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
  predicate?: string | undefined;
  subject?: string | undefined;
  subjectAliases?: string[] | undefined;
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
  predicate?: string | undefined;
  subject?: string | undefined;
  subjectAliases?: string[] | undefined;
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

export interface MemoryExtractionReport {
  extractorName?: string | undefined;
  extractionSource: "custom" | "none";
  extractorFailed: boolean;
  rawCandidateCount: number;
  acceptedCandidateCount: number;
  rejectedCandidateCount: number;
  hardRejectCount: number;
  softRejectCount: number;
  decisions: MemoryExtractionDecision[];
}

export type ObserveSkippedReason =
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

export interface MemoryRecord {
  id: string;
  profileId: string;
  kind: MemoryKind;
  scope: string;
  content: string;
  sensitivity: Sensitivity;
  status: MemoryStatus;
  confidence: number;
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
  kind: "do_not_push" | "prefer" | "procedure";
  text: string;
  priority: number;
  sourceMemoryId?: string | null | undefined;
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

export type ReconstructionRecallPurpose = "context" | "history";

export interface ReconstructionIntentTagGroupHint {
  name?: string | undefined;
  tags: string[];
}

export interface ReconstructionIntentHint {
  expectedTags?: string[] | undefined;
  requiredTagGroups?: ReconstructionIntentTagGroupHint[] | undefined;
  queryCues?: string[] | undefined;
}

export interface ReconstructContextInput {
  profileId?: string | undefined;
  query?: string | undefined;
  messages?: TurnMessage[] | undefined;
  includeEvidence?: boolean | undefined;
  includeSensitive?: boolean | undefined;
  contextBudgetTokens?: number | undefined;
  maxSteps?: number | undefined;
  maxBranch?: number | undefined;
  maxMemories?: number | undefined;
  stopWhenEvidenceEnough?: boolean | undefined;
  evidenceConvergenceThreshold?: number | undefined;
  includeTemporalMetadata?: boolean | undefined;
  temporalMode?: "auto" | "current" | "history" | undefined;
  recallPurpose?: ReconstructionRecallPurpose | undefined;
  reconstructionIntent?: ReconstructionIntentHint | undefined;
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
  steps: ReconstructedPlannerStep[];
  stopReason: ReconstructedContext["stats"]["stopReason"];
}

export interface ReconstructedContext {
  profileId: string;
  query: string;
  contextBlock: string;
  memories: MemoryRecord[];
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
}

export interface FeedbackInput {
  profileId?: string | undefined;
  content: string;
  failureKind?: FailureKind | undefined;
  createdAt?: string | undefined;
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

export interface ExplainResult {
  id: string;
  kind: "memory" | "belief";
  memoryKind?: MemoryKind | undefined;
  sensitivity?: Sensitivity | undefined;
  text: string;
  evidence: EvidenceEvent[];
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
  purpose?: "context" | "history" | "delete" | "manage";
  includeSensitive?: boolean | undefined;
  includePerson?: boolean | undefined;
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
  subjectAliases?: string[] | undefined;
  predicate: string;
  object: string;
  confidence?: number | undefined;
  sourceMemoryId?: string | null | undefined;
  cardinality?: "single" | "multi" | undefined;
  metadata?: Record<string, unknown> | undefined;
  createdAt?: string | undefined;
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

export interface ArchiveStaleHostImportsInput {
  profileId: string;
  sourceType: string;
  activeImportKeys: string[];
  archivedAt?: string | undefined;
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
    dimensions: number;
  } | undefined;
}

export interface RepairSearchIndexResult {
  repaired: boolean;
  before: SearchIndexStatus;
  after: SearchIndexStatus;
  repairedAt: string;
}

export interface MemoryStore {
  initialize(): Promise<void> | void;
  close(): Promise<void> | void;
  recordEvidence(input: RecordEvidenceInput): Promise<EvidenceEvent> | EvidenceEvent;
  addMemory(input: AddMemoryInput): Promise<MemoryRecord> | MemoryRecord;
  updateMemory?(input: UpdateMemoryInput): Promise<MemoryRecord | null> | MemoryRecord | null;
  archiveMemoryById?(input: ArchiveMemoryInput): Promise<boolean> | boolean;
  restoreArchivedMemory?(input: RestoreArchivedMemoryInput): Promise<boolean> | boolean;
  archiveMemories?(input: ArchiveMemoriesInput): Promise<string[]> | string[];
  addWorldBelief(input: AddWorldBeliefInput): Promise<WorldBeliefRecord> | WorldBeliefRecord;
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
  archiveStaleHostImports?(
    input: ArchiveStaleHostImportsInput,
  ): Promise<string[]> | string[];
  listActionPolicies(
    profileId: string,
    options?: { includeSensitive?: boolean | undefined },
  ): Promise<ActionPolicy[]> | ActionPolicy[];
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
  repairSearchIndex?(): Promise<RepairSearchIndexResult> | RepairSearchIndexResult;
}

export interface MemoryOSOptions {
  profileId?: string | undefined;
  store: MemoryStore;
  extractor?: MemoryExtractor | undefined;
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
  update(input: LowLevelUpdateMemoryInput): Promise<MemoryRecord | null>;
  archive(input: LowLevelArchiveMemoryInput): Promise<ForgetResult>;
  restoreArchived(input: LowLevelRestoreArchivedMemoryInput): Promise<RestoreArchivedResult>;
  clear(input: LowLevelClearMemoriesInput): Promise<ForgetResult>;
  search(input?: LowLevelSearchInput): Promise<MemoryRecord[]>;
  list(input?: LowLevelListMemoriesInput): Promise<MemoryRecord[]>;
  get(input: LowLevelGetMemoryInput): Promise<MemoryRecord | null>;
  observe(event: HostEvent): Promise<void>;
  observeWithReport(event: HostEvent): Promise<ObserveResult>;
  listEvidence(
    input?: Omit<EvidenceListInput, "profileId"> & { profileId?: string | undefined },
  ): Promise<EvidenceEvent[]>;
  prepareTurn(input: PrepareTurnInput): Promise<PreparedTurn>;
  reconstructContext(input: ReconstructContextInput): Promise<ReconstructedContext>;
  explainEvidencePath(input: ExplainEvidencePathInput): Promise<EvidencePathExplanation>;
  commitOutcome(input: CommitOutcomeInput): Promise<void>;
  recordFeedback(input: FeedbackInput): Promise<void>;
  forget(input: ForgetInput): Promise<ForgetResult>;
  explain(id: string, profileId?: string): Promise<ExplainResult | null>;
  close(): Promise<void>;
}
