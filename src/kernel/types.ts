export type MemoryRole = "system" | "user" | "assistant" | "tool";

export type PrivacyMode = "normal" | "incognito";

export type Sensitivity = "normal" | "sensitive" | "secret_like";

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

export interface ConversationMessageEvent {
  type: "conversation.message";
  profileId?: string | undefined;
  conversationId?: string | undefined;
  messageId?: string | undefined;
  role: MemoryRole;
  content: string;
  privacyMode?: PrivacyMode | undefined;
  createdAt?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface UserForgetEvent {
  type: "user.forget_request";
  profileId?: string | undefined;
  query: string;
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
  status: "active" | "candidate" | "rejected";
  sourceMemoryId?: string | null | undefined;
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
  stats: {
    retrievedMemoryCount: number;
    actionPolicyCount: number;
    promptTokenEstimate: number;
  };
}

export interface CommitOutcomeInput {
  profileId?: string | undefined;
  taskId?: string | undefined;
  objective: string;
  status: "completed" | "failed";
  summary?: string | undefined;
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
  reason?: string | undefined;
}

export interface ForgetResult {
  archivedMemoryIds: string[];
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
  purpose?: "context" | "delete" | "manage" | undefined;
  includeSensitive?: boolean | undefined;
  includePerson?: boolean | undefined;
}

export interface MemorySearchInput {
  profileId: string;
  query?: string;
  limit?: number;
  purpose?: "context" | "delete" | "manage";
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
  predicate: string;
  object: string;
  confidence?: number | undefined;
  sourceMemoryId?: string | null | undefined;
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

export interface MemoryStore {
  initialize(): Promise<void> | void;
  close(): Promise<void> | void;
  recordEvidence(input: RecordEvidenceInput): Promise<EvidenceEvent> | EvidenceEvent;
  addMemory(input: AddMemoryInput): Promise<MemoryRecord> | MemoryRecord;
  updateMemory?(input: UpdateMemoryInput): Promise<MemoryRecord | null> | MemoryRecord | null;
  archiveMemoryById?(input: ArchiveMemoryInput): Promise<boolean> | boolean;
  archiveMemories?(input: ArchiveMemoriesInput): Promise<string[]> | string[];
  addWorldBelief(input: AddWorldBeliefInput): Promise<WorldBeliefRecord> | WorldBeliefRecord;
  searchMemories(input: MemorySearchInput): Promise<MemoryRecord[]> | MemoryRecord[];
  getMemoryById(
    profileId: string,
    id: string,
    options?: {
      includeSensitive?: boolean | undefined;
      includePerson?: boolean | undefined;
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
  listEvidenceForMemory(memoryId: string): Promise<EvidenceEvent[]> | EvidenceEvent[];
  forget(input: ForgetInput & { profileId: string }): Promise<ForgetResult> | ForgetResult;
  recordFailure(input: RecordFailureInput): Promise<void> | void;
  listFailures?(input: ListFailuresInput): Promise<FailureEventRecord[]> | FailureEventRecord[];
  recordTaskTrajectory(input: TaskTrajectoryInput): Promise<void> | void;
  rowCounts(): Promise<Record<string, number>> | Record<string, number>;
  schemaVersion?(): Promise<number> | number;
}

export interface MemoryOSOptions {
  profileId?: string | undefined;
  store: MemoryStore;
  host?: {
    hostId?: string | undefined;
    capabilities?: Record<string, boolean> | undefined;
  } | undefined;
}

export interface MemoryOS {
  add(input: LowLevelAddMemoryInput): Promise<MemoryRecord>;
  update(input: LowLevelUpdateMemoryInput): Promise<MemoryRecord | null>;
  archive(input: LowLevelArchiveMemoryInput): Promise<ForgetResult>;
  clear(input: LowLevelClearMemoriesInput): Promise<ForgetResult>;
  search(input?: LowLevelSearchInput): Promise<MemoryRecord[]>;
  observe(event: HostEvent): Promise<void>;
  prepareTurn(input: PrepareTurnInput): Promise<PreparedTurn>;
  commitOutcome(input: CommitOutcomeInput): Promise<void>;
  recordFeedback(input: FeedbackInput): Promise<void>;
  forget(input: ForgetInput): Promise<ForgetResult>;
  explain(id: string, profileId?: string): Promise<ExplainResult | null>;
  close(): Promise<void>;
}
