import { randomUUID } from "node:crypto";

import { composeTurnContext } from "../kernel/context-composer.js";
import { extractMemoryCandidate } from "../kernel/extraction.js";
import {
  classifySensitivity,
  eligibleForLongTermMemory,
  isPersonRoutedMemory,
  sanitizeEvidenceForPublicOutput,
  sanitizePublicPayloadRecord,
} from "../kernel/safety.js";
import type {
  CommitOutcomeInput,
  EvidenceEvent,
  ExplainResult,
  FeedbackInput,
  ForgetInput,
  ForgetResult,
  HostEvent,
  LowLevelAddMemoryInput,
  LowLevelArchiveMemoryInput,
  LowLevelClearMemoriesInput,
  LowLevelRestoreArchivedMemoryInput,
  LowLevelSearchInput,
  LowLevelUpdateMemoryInput,
  MemoryKind,
  MemoryRecord,
  MemoryOS,
  MemoryOSOptions,
  PrepareTurnInput,
  RestoreArchivedResult,
  Sensitivity,
} from "../kernel/types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function profileIdFor(defaultProfileId: string, profileId?: string): string {
  return profileId ?? defaultProfileId;
}

function eventKey(event: HostEvent): string {
  if (event.type === "conversation.message") {
    return [
      event.type,
      event.profileId ?? "default",
      event.conversationId ?? "conversation",
      event.messageId ?? randomUUID(),
      event.createdAt ?? nowIso(),
    ].join(":");
  }
  return [event.type, event.profileId ?? "default", event.createdAt ?? nowIso(), randomUUID()].join(":");
}

function latestUserText(input: PrepareTurnInput): string {
  return [...input.messages].reverse().find((message) => message.role === "user")?.content ?? "";
}

function lowLevelKind(input: LowLevelAddMemoryInput): MemoryKind {
  return isPersonRoutedMemory(input.content) ? "person" : input.kind;
}

function lowLevelSensitivity(input: {
  content: string;
  sensitivity?: Sensitivity | undefined;
}): Sensitivity {
  const detected = classifySensitivity(input.content);
  if (detected === "secret_like" || input.sensitivity === "secret_like") {
    throw new Error("gmOS low-level mutation rejects secret-like content");
  }
  if (detected === "sensitive") return "sensitive";
  return input.sensitivity ?? detected;
}

function assertLowLevelPersonAllowed(input: {
  kind?: MemoryKind | undefined;
  content: string;
  allowPerson?: boolean | undefined;
}): void {
  const routesToPerson = input.kind === "person" || isPersonRoutedMemory(input.content);
  if (routesToPerson && !input.allowPerson) {
    throw new Error("gmOS low-level add rejects person memory unless allowPerson is true");
  }
}

function requireUpdateMemory(
  store: MemoryOSOptions["store"],
): NonNullable<MemoryOSOptions["store"]["updateMemory"]> {
  if (!store.updateMemory) throw new Error("gmOS store does not support low-level update");
  return store.updateMemory.bind(store);
}

function requireArchiveMemoryById(
  store: MemoryOSOptions["store"],
): NonNullable<MemoryOSOptions["store"]["archiveMemoryById"]> {
  if (!store.archiveMemoryById) {
    throw new Error("gmOS store does not support low-level archive");
  }
  return store.archiveMemoryById.bind(store);
}

function requireRestoreArchivedMemory(
  store: MemoryOSOptions["store"],
): NonNullable<MemoryOSOptions["store"]["restoreArchivedMemory"]> {
  if (!store.restoreArchivedMemory) {
    throw new Error("gmOS store does not support low-level restore archived memory");
  }
  return store.restoreArchivedMemory.bind(store);
}

function requireArchiveMemories(
  store: MemoryOSOptions["store"],
): NonNullable<MemoryOSOptions["store"]["archiveMemories"]> {
  if (!store.archiveMemories) throw new Error("gmOS store does not support low-level clear");
  return store.archiveMemories.bind(store);
}

export function createMemoryOS(options: MemoryOSOptions): MemoryOS {
  const defaultProfileId = options.profileId ?? "default";
  const store = options.store;
  let initialized = false;

  async function initialize(): Promise<void> {
    if (initialized) return;
    await store.initialize();
    initialized = true;
  }

  async function add(input: LowLevelAddMemoryInput): Promise<MemoryRecord> {
    await initialize();
    const content = input.content.trim();
    if (!content) throw new Error("gmOS low-level add requires non-empty content");
    assertLowLevelPersonAllowed(input);
    const profileId = profileIdFor(defaultProfileId, input.profileId);
    const kind = lowLevelKind(input);
    const sensitivity = lowLevelSensitivity(input);
    const createdAt = input.createdAt ?? nowIso();
    const evidence = await store.recordEvidence({
      profileId,
      eventKey: ["sdk.low_level_add", profileId, createdAt, randomUUID()].join(":"),
      sourceType: "sdk.low_level_add",
      sourceUri: null,
      content,
      sensitivity,
      eligibleForLongTermMemory: true,
      payload: {
        kind,
        scope: input.scope ?? "global",
        metadata: sanitizePublicPayloadRecord(input.metadata ?? {}),
      },
      createdAt,
    });
    return store.addMemory({
      profileId,
      kind,
      content,
      sensitivity,
      sourceEventId: evidence.id,
      metadata: {
        ...sanitizePublicPayloadRecord(input.metadata ?? {}),
        lowLevelApi: true,
      },
      createdAt,
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    });
  }

  async function update(input: LowLevelUpdateMemoryInput): Promise<MemoryRecord | null> {
    await initialize();
    const updateMemory = requireUpdateMemory(store);
    const profileId = profileIdFor(defaultProfileId, input.profileId);
    const existing = await store.getMemoryById(profileId, input.id, {
      includeSensitive: true,
      includePerson: true,
    });
    if (!existing) return null;
    const content = (input.content ?? existing.content).trim();
    if (!content) throw new Error("gmOS low-level update requires non-empty content");
    const kind = isPersonRoutedMemory(content) ? "person" : input.kind ?? existing.kind;
    assertLowLevelPersonAllowed({
      kind,
      content,
      allowPerson: input.allowPerson,
    });
    const sensitivity = lowLevelSensitivity({
      content,
      sensitivity: input.sensitivity ?? existing.sensitivity,
    });
    const updatedAt = input.updatedAt ?? nowIso();
    const metadata = input.replaceMetadata
      ? sanitizePublicPayloadRecord(input.metadata ?? {})
      : {
          ...existing.metadata,
          ...sanitizePublicPayloadRecord(input.metadata ?? {}),
        };
    const evidence = await store.recordEvidence({
      profileId,
      eventKey: ["sdk.low_level_update", profileId, input.id, updatedAt, randomUUID()].join(":"),
      sourceType: "sdk.low_level_update",
      sourceUri: null,
      content,
      sensitivity,
      eligibleForLongTermMemory: true,
      payload: {
        memoryId: input.id,
        previousKind: existing.kind,
        kind,
        scope: input.scope ?? existing.scope,
        metadata,
      },
      createdAt: updatedAt,
    });
    return updateMemory({
      profileId,
      id: input.id,
      kind,
      scope: input.scope ?? existing.scope,
      content,
      sensitivity,
      confidence: input.confidence ?? existing.confidence,
      sourceEventId: evidence.id,
      metadata: {
        ...metadata,
        lowLevelApi: true,
        lowLevelUpdatedAt: updatedAt,
      },
      updatedAt,
    });
  }

  async function archive(input: LowLevelArchiveMemoryInput): Promise<ForgetResult> {
    await initialize();
    const profileId = profileIdFor(defaultProfileId, input.profileId);
    const archived = await requireArchiveMemoryById(store)({
      profileId,
      id: input.id,
      reason: input.reason,
      archivedAt: input.archivedAt,
    });
    return { archivedMemoryIds: archived ? [input.id] : [] };
  }

  async function restoreArchived(
    input: LowLevelRestoreArchivedMemoryInput,
  ): Promise<RestoreArchivedResult> {
    await initialize();
    const profileId = profileIdFor(defaultProfileId, input.profileId);
    const restored = await requireRestoreArchivedMemory(store)({
      profileId,
      id: input.id,
      reason: input.reason,
      restoredAt: input.restoredAt,
    });
    return { restoredMemoryIds: restored ? [input.id] : [] };
  }

  async function clear(input: LowLevelClearMemoriesInput): Promise<ForgetResult> {
    await initialize();
    if (!input.all && !input.scope && !input.metadataEquals) {
      throw new Error("gmOS low-level clear requires all, scope, or metadataEquals");
    }
    const archivedMemoryIds = await requireArchiveMemories(store)({
      profileId: profileIdFor(defaultProfileId, input.profileId),
      all: input.all,
      scope: input.scope,
      metadataEquals: input.metadataEquals,
      reason: input.reason,
      archivedAt: input.archivedAt,
    });
    return { archivedMemoryIds };
  }

  async function search(input: LowLevelSearchInput = {}): Promise<MemoryRecord[]> {
    await initialize();
    return store.searchMemories({
      profileId: profileIdFor(defaultProfileId, input.profileId),
      purpose: input.purpose ?? "context",
      ...(input.query !== undefined ? { query: input.query } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.includeSensitive !== undefined ? { includeSensitive: input.includeSensitive } : {}),
      ...(input.includePerson !== undefined ? { includePerson: input.includePerson } : {}),
    });
  }

  async function observe(event: HostEvent): Promise<void> {
    await initialize();
    const profileId = profileIdFor(defaultProfileId, event.profileId);

    if (event.type === "user.forget_request") {
      await store.forget({ profileId, query: event.query, reason: event.reason });
      return;
    }

    if (event.type === "user.feedback" || event.type === "user.correction") {
      await store.recordFailure({
        profileId,
        failureKind: event.failureKind ?? "wrong_recall",
        content: event.content,
        createdAt: event.createdAt,
      });
      return;
    }

    if (event.type === "task.completed" || event.type === "task.failed") {
      await store.recordTaskTrajectory({
        profileId,
        taskId: event.taskId,
        objective: event.objective,
        status: event.type === "task.completed" ? "completed" : "failed",
        summary: event.summary,
        createdAt: event.createdAt,
      });
      if (event.type === "task.failed") {
        await store.recordFailure({
          profileId,
          failureKind: "task_failure",
          content: event.summary ?? event.objective,
          createdAt: event.createdAt,
        });
      }
      return;
    }

    if (event.type !== "conversation.message") return;
    if (event.role !== "user") return;

    const sensitivity = classifySensitivity(event.content);
    const eligible = eligibleForLongTermMemory({
      content: event.content,
      privacyMode: event.privacyMode,
    });
    const evidence = await store.recordEvidence({
      profileId,
      eventKey: eventKey(event),
      sourceType: event.type,
      sourceUri: event.conversationId ? `conversation:${event.conversationId}` : null,
      content: event.content,
      sensitivity,
      eligibleForLongTermMemory: eligible,
      payload: {
        role: event.role,
        messageId: event.messageId,
        privacyMode: event.privacyMode ?? "normal",
        metadata: sanitizePublicPayloadRecord(event.metadata ?? {}),
      },
      createdAt: event.createdAt,
    });

    if (!eligible || isPersonRoutedMemory(event.content)) return;
    const candidate = extractMemoryCandidate(event.content);
    if (!candidate) return;

    const memory = await store.addMemory({
      profileId,
      kind: candidate.kind,
      content: candidate.content,
      confidence: candidate.confidence,
      sensitivity,
      sourceEventId: evidence.id,
      metadata: {
        actionPolicyKind: candidate.actionPolicyKind,
        predicate: candidate.predicate,
      },
      createdAt: event.createdAt,
    });
    if (candidate.predicate) {
      await store.addWorldBelief({
        profileId,
        subject: "user",
        predicate: candidate.predicate,
        object: candidate.content,
        confidence: candidate.confidence,
        sourceMemoryId: memory.id,
      });
    }
  }

  async function prepareTurn(input: PrepareTurnInput) {
    await initialize();
    const profileId = profileIdFor(defaultProfileId, input.profileId);
    const query = latestUserText(input);
    const before = await store.rowCounts();
    const memories = await store.searchMemories({
      profileId,
      query,
      limit: 12,
      purpose: "context",
      includeSensitive: input.includeSensitive,
    });
    const actionPolicies = await store.listActionPolicies(profileId, {
      includeSensitive: input.includeSensitive,
    });
    const evidence: EvidenceEvent[] = [];
    const seenEvidenceIds = new Set<string>();
    async function appendEvidenceForMemory(memoryId: string): Promise<void> {
      for (const event of await store.listEvidenceForMemory(memoryId)) {
        if (seenEvidenceIds.has(event.id)) continue;
        seenEvidenceIds.add(event.id);
        evidence.push(sanitizeEvidenceForPublicOutput(event));
      }
    }
    if (input.includeEvidence) {
      for (const memory of memories) {
        await appendEvidenceForMemory(memory.id);
      }
      for (const policy of actionPolicies) {
        if (policy.sourceMemoryId) await appendEvidenceForMemory(policy.sourceMemoryId);
      }
    }
    const prepared = composeTurnContext({
      profileId,
      memories,
      actionPolicies,
      evidence,
      includeEvidence: input.includeEvidence,
      contextBudgetTokens: input.contextBudgetTokens,
    });
    const after = await store.rowCounts();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error("gmOS invariant failed: prepareTurn produced write side effects");
    }
    return prepared;
  }

  async function commitOutcome(input: CommitOutcomeInput): Promise<void> {
    await initialize();
    const profileId = profileIdFor(defaultProfileId, input.profileId);
    await store.recordTaskTrajectory({
      profileId,
      taskId: input.taskId,
      objective: input.objective,
      status: input.status,
      summary: input.summary,
      createdAt: input.createdAt,
    });
    if (input.status === "failed") {
      await store.recordFailure({
        profileId,
        failureKind: "task_failure",
        content: input.summary ?? input.objective,
        createdAt: input.createdAt,
      });
    }
  }

  async function recordFeedback(input: FeedbackInput): Promise<void> {
    await initialize();
    await store.recordFailure({
      profileId: profileIdFor(defaultProfileId, input.profileId),
      failureKind: input.failureKind ?? "wrong_recall",
      content: input.content,
      createdAt: input.createdAt,
    });
  }

  async function forget(input: ForgetInput): Promise<ForgetResult> {
    await initialize();
    return store.forget({
      profileId: profileIdFor(defaultProfileId, input.profileId),
      query: input.query,
      reason: input.reason,
    });
  }

  async function explain(id: string, profileIdInput?: string): Promise<ExplainResult | null> {
    await initialize();
    const profileId = profileIdFor(defaultProfileId, profileIdInput);
    const memory = await store.getMemoryById(profileId, id, {
      includeSensitive: true,
      includePerson: true,
    });
    if (!memory) return null;
    const evidence = (await store.listEvidenceForMemory(memory.id)).map(
      sanitizeEvidenceForPublicOutput,
    );
    return {
      id: memory.id,
      kind: "memory",
      memoryKind: memory.kind,
      sensitivity: memory.sensitivity,
      text: memory.content,
      evidence,
    };
  }

  return {
    add,
    update,
    archive,
    restoreArchived,
    clear,
    search,
    observe,
    prepareTurn,
    commitOutcome,
    recordFeedback,
    forget,
    explain,
    async close() {
      await store.close();
    },
  };
}
