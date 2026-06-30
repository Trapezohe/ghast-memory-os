import type {
  CommitOutcomeInput,
  FeedbackInput,
  ForgetInput,
  ForgetResult,
  HostEvent,
  MemoryOS,
  MemoryRole,
  PrepareTurnInput,
  PreparedTurn,
  PrivacyMode,
  ReconstructContextInput,
  ReconstructedContext,
  TurnMessage,
} from "../kernel/types.js";

export interface AgentMemoryAdapterOptions {
  memory: MemoryOS;
  profileId?: string | undefined;
  injectContextMessage?: boolean | undefined;
  contextRole?: Extract<MemoryRole, "system" | "user"> | undefined;
  includeEvidence?: boolean | undefined;
  contextBudgetTokens?: number | undefined;
  reconstruction?: PrepareTurnInput["reconstruction"] | undefined;
}

export interface AgentMemoryMessageInput {
  profileId?: string | undefined;
  conversationId?: string | undefined;
  messageId?: string | undefined;
  role: MemoryRole;
  content: string;
  privacyMode?: PrivacyMode | undefined;
  createdAt?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface AgentMemoryPrepareInput {
  profileId?: string | undefined;
  messages: TurnMessage[];
  task?: PrepareTurnInput["task"] | undefined;
  includeEvidence?: boolean | undefined;
  contextBudgetTokens?: number | undefined;
  reconstruction?: PrepareTurnInput["reconstruction"] | undefined;
  injectContextMessage?: boolean | undefined;
  contextRole?: Extract<MemoryRole, "system" | "user"> | undefined;
}

export interface AgentMemoryPreparedTurn {
  profileId: string;
  prepared: PreparedTurn;
  modelMessages: TurnMessage[];
  contextMessage?: TurnMessage | undefined;
  directives: PreparedTurn["directives"];
  actionPolicies: PreparedTurn["actionPolicies"];
  stats: PreparedTurn["stats"];
}

export interface AgentMemoryAdapter {
  observeEvent(event: HostEvent): Promise<void>;
  observeMessage(input: AgentMemoryMessageInput): Promise<void>;
  prepareTurn(input: AgentMemoryPrepareInput): Promise<AgentMemoryPreparedTurn>;
  reconstructContext(input: ReconstructContextInput): Promise<ReconstructedContext>;
  commitOutcome(input: CommitOutcomeInput): Promise<void>;
  recordFeedback(input: FeedbackInput): Promise<void>;
  forget(input: ForgetInput): Promise<ForgetResult>;
}

export function createAgentMemoryAdapter(
  options: AgentMemoryAdapterOptions,
): AgentMemoryAdapter {
  const defaultInjectContextMessage = options.injectContextMessage ?? true;
  const defaultContextRole = options.contextRole ?? "system";

  function profileId(inputProfileId?: string | undefined): string | undefined {
    return inputProfileId ?? options.profileId;
  }

  function withProfile<T extends { profileId?: string | undefined }>(input: T): T {
    const resolvedProfileId = profileId(input.profileId);
    if (!resolvedProfileId) return input;
    return { ...input, profileId: resolvedProfileId };
  }

  async function observeEvent(event: HostEvent): Promise<void> {
    await options.memory.observe(withProfile(event));
  }

  async function observeMessage(input: AgentMemoryMessageInput): Promise<void> {
    const event: HostEvent = {
      type: "conversation.message",
      role: input.role,
      content: input.content,
    };
    const resolvedProfileId = profileId(input.profileId);
    if (resolvedProfileId) event.profileId = resolvedProfileId;
    if (input.conversationId) event.conversationId = input.conversationId;
    if (input.messageId) event.messageId = input.messageId;
    if (input.privacyMode) event.privacyMode = input.privacyMode;
    if (input.createdAt) event.createdAt = input.createdAt;
    if (input.metadata) event.metadata = input.metadata;
    await options.memory.observe(event);
  }

  async function prepareTurn(
    input: AgentMemoryPrepareInput,
  ): Promise<AgentMemoryPreparedTurn> {
    const prepareInput: PrepareTurnInput = { messages: input.messages };
    const resolvedProfileId = profileId(input.profileId);
    if (resolvedProfileId) prepareInput.profileId = resolvedProfileId;
    if (input.task) prepareInput.task = input.task;
    prepareInput.includeEvidence = input.includeEvidence ?? options.includeEvidence;
    prepareInput.contextBudgetTokens =
      input.contextBudgetTokens ?? options.contextBudgetTokens;
    prepareInput.reconstruction = input.reconstruction ?? options.reconstruction;

    const prepared = await options.memory.prepareTurn(prepareInput);
    const injectContextMessage = input.injectContextMessage ?? defaultInjectContextMessage;
    const contextRole = input.contextRole ?? defaultContextRole;
    const contextMessage =
      prepared.contextBlock.trim().length > 0
        ? { role: contextRole, content: prepared.contextBlock }
        : undefined;
    const modelMessages =
      injectContextMessage && contextMessage
        ? [contextMessage, ...input.messages]
        : [...input.messages];

    return {
      profileId: prepared.profileId,
      prepared,
      modelMessages,
      contextMessage,
      directives: prepared.directives,
      actionPolicies: prepared.actionPolicies,
      stats: prepared.stats,
    };
  }

  async function reconstructContext(
    input: ReconstructContextInput,
  ): Promise<ReconstructedContext> {
    return options.memory.reconstructContext(withProfile(input));
  }

  async function commitOutcome(input: CommitOutcomeInput): Promise<void> {
    await options.memory.commitOutcome(withProfile(input));
  }

  async function recordFeedback(input: FeedbackInput): Promise<void> {
    await options.memory.recordFeedback(withProfile(input));
  }

  async function forget(input: ForgetInput): Promise<ForgetResult> {
    return options.memory.forget(withProfile(input));
  }

  return {
    observeEvent,
    observeMessage,
    prepareTurn,
    reconstructContext,
    commitOutcome,
    recordFeedback,
    forget,
  };
}
