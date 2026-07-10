import { createHash } from "node:crypto";

import { GMOS_EVIDENCE_PAYLOAD_SCHEMAS } from "../kernel/evidence-schema.js";
import {
  GMOS_METADATA_REFERENCE_SCHEMAS,
  hasGmosMetadataReferenceSchema,
} from "../kernel/metadata-schema.js";
import { classifySensitivity, redactForReport } from "../kernel/safety.js";
import { DEFAULT_MEMORY_HALF_LIVES_DAYS } from "../kernel/retention.js";
import type {
  EvolutionAction,
  EvolutionApplyStoreInput,
  EvolutionApplyStoreResult,
  EvolutionRevertStoreInput,
  EvolutionRevertStoreResult,
  EvidenceEvent,
  FailureEventRecord,
  FailureKind,
  ListFailuresInput,
  MemoryListInput,
  MemoryRecord,
} from "../kernel/types.js";

export interface FailureReviewStore {
  listFailures(input: ListFailuresInput): Promise<FailureEventRecord[]> | FailureEventRecord[];
  listMemories?(input: MemoryListInput): Promise<MemoryRecord[]> | MemoryRecord[];
  listEvidence?(input: {
    profileId: string;
    limit?: number | undefined;
    sourceType?: string | undefined;
    includeSensitive?: boolean | undefined;
  }): Promise<EvidenceEvent[]> | EvidenceEvent[];
}

export interface EvolutionApplicationStore extends FailureReviewStore {
  applyEvolutionActions(
    input: EvolutionApplyStoreInput,
  ): Promise<EvolutionApplyStoreResult> | EvolutionApplyStoreResult;
  revertEvolutionApplication(
    input: EvolutionRevertStoreInput,
  ): Promise<EvolutionRevertStoreResult> | EvolutionRevertStoreResult;
}

export interface EvolutionFailureCluster {
  id: string;
  signatureHash: string;
  failureKind: FailureKind;
  eventCount: number;
  latestAt: string;
  sampleEventIds: string[];
  sampleContents: string[];
  targetMemoryIds: string[];
  suggestedFocus: string;
}

export interface EvolutionRepairHypothesis {
  id: string;
  clusterId: string;
  title: string;
  rationale: string;
  confidence: number;
}

export interface EvolutionPolicyPatchProposal {
  id: string;
  clusterId: string;
  title: string;
  summary: string;
  suggestedActions: EvolutionAction[];
  autoApply: false;
  autoRollout: false;
}

export interface EvolutionParameterTuningProposal {
  id: string;
  title: string;
  configKeyPath: string;
  currentDefault: unknown;
  proposedValue: unknown;
  supportingStatistics: Record<string, unknown>;
  rationale: string;
  configSnippet: string;
  autoApply: false;
  autoRollout: false;
}

export interface EvolutionFailureReviewReport {
  mode: "propose_with_approval";
  autoApply: false;
  autoRollout: false;
  profileId: string;
  generatedAt: string;
  inspectedFailureCount: number;
  decision: "no_failures" | "propose_with_approval_review";
  clusters: EvolutionFailureCluster[];
  hypotheses: EvolutionRepairHypothesis[];
  patchProposals: EvolutionPolicyPatchProposal[];
  parameterProposals: EvolutionParameterTuningProposal[];
  hardGateReminders: string[];
}

export interface ReviewFailuresInput {
  profileId?: string | undefined;
  failureKind?: FailureKind | undefined;
  limit?: number | undefined;
}

export interface ApplyEvolutionProposalInput {
  profileId?: string | undefined;
  proposalId: string;
  actions?: EvolutionAction[] | undefined;
  approvedBy: string;
}

export interface RevertEvolutionApplicationInput {
  profileId?: string | undefined;
  applicationEventId: string;
}

export interface EvolutionControlPlane {
  mode: "propose_with_approval";
  autoApply: false;
  autoRollout: false;
  reviewFailures(input?: ReviewFailuresInput): Promise<EvolutionFailureReviewReport>;
  applyEvolutionProposal(input: ApplyEvolutionProposalInput): Promise<EvolutionApplyStoreResult>;
  revertEvolutionApplication(
    input: RevertEvolutionApplicationInput,
  ): Promise<EvolutionRevertStoreResult>;
}

export interface EvolutionControlPlaneOptions {
  store?: FailureReviewStore | undefined;
  profileId?: string | undefined;
  now?: (() => string) | undefined;
}

export type EvolutionApplicationErrorCode =
  | "approved_by_required"
  | "proposal_not_found"
  | "parameter_proposal_host_owned"
  | "actions_not_allowed"
  | "no_actions"
  | "store_apply_unsupported"
  | "application_already_reverted"
  | "application_not_found";

export class EvolutionApplicationError extends Error {
  readonly code: EvolutionApplicationErrorCode;

  constructor(code: EvolutionApplicationErrorCode, message: string) {
    super(message);
    this.name = "EvolutionApplicationError";
    this.code = code;
  }
}

const HARD_GATE_REMINDERS = [
  "PERSON isolation must not regress",
  "secret-like content must not be persisted or exposed",
  "incognito events must not become long-term memory",
  "forget residue must remain zero",
  "do_not_push directives must keep priority over initiative",
  "read paths must remain side-effect free",
];

const FAILURE_FOCUS: Record<FailureKind, string> = {
  missed_recall: "Improve retrieval route selection and context budget before adding new memory writes.",
  wrong_recall: "Tighten ranking, source grounding, and stale-memory suppression.",
  privacy_leak: "Audit safety filters and prompt materialization before changing recall behavior.",
  forget_failure: "Trace raw, derived, action-policy, and prompt residue for the forgotten target.",
  controller_route_error: "Review controller route selection and host capability assumptions.",
  action_policy_missing: "Promote eligible boundary/procedure memory into explicit action directives.",
  task_failure: "Inspect task trajectory patterns before proposing procedure or policy changes.",
};

function signatureHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function byLatestDesc(a: FailureEventRecord, b: FailureEventRecord): number {
  return b.createdAt.localeCompare(a.createdAt);
}

function safeFailureSample(content: string): string {
  if (classifySensitivity(content) !== "normal") return "[redacted_sensitive_failure]";
  return redactForReport(content);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right)
  );
}

function targetMemoryIdsForFailure(event: FailureEventRecord): string[] {
  if (
    !hasGmosMetadataReferenceSchema(
      event.metadata,
      GMOS_METADATA_REFERENCE_SCHEMAS.failureMemoryLinks,
    )
  ) {
    return [];
  }
  return uniqueSorted([
    ...stringArray(event.metadata.relatedMemoryIds),
    ...stringArray(event.metadata.usedMemoryIds),
  ]);
}

function clusterSignature(input: {
  profileId: string;
  failureKind: FailureKind;
  events: FailureEventRecord[];
}): {
  hash: string;
  targetMemoryIds: string[];
} {
  const targetMemoryIds = uniqueSorted(input.events.flatMap(targetMemoryIdsForFailure));
  const signature = {
    profileId: input.profileId,
    failureKind: input.failureKind,
    eventIds: uniqueSorted(input.events.map((event) => event.id)),
    targetMemoryIds,
  };
  return {
    hash: signatureHash(signature),
    targetMemoryIds,
  };
}

function summarizeCluster(
  profileId: string,
  failureKind: FailureKind,
  events: FailureEventRecord[],
): EvolutionFailureCluster {
  const sorted = [...events].sort(byLatestDesc);
  const signature = clusterSignature({ profileId, failureKind, events });
  return {
    id: `failure_cluster_${signature.hash}`,
    signatureHash: signature.hash,
    failureKind,
    eventCount: sorted.length,
    latestAt: sorted[0]?.createdAt ?? "",
    sampleEventIds: sorted.slice(0, 3).map((event) => event.id),
    sampleContents: sorted.slice(0, 3).map((event) => safeFailureSample(event.content)),
    targetMemoryIds: signature.targetMemoryIds,
    suggestedFocus: FAILURE_FOCUS[failureKind],
  };
}

function hypothesisFor(cluster: EvolutionFailureCluster): EvolutionRepairHypothesis {
  return {
    id: `hypothesis_${cluster.id}`,
    clusterId: cluster.id,
    title: `${cluster.failureKind} repair hypothesis`,
    rationale: `${cluster.eventCount} recent failure event(s) indicate: ${cluster.suggestedFocus}`,
    confidence: Math.min(0.85, 0.45 + cluster.eventCount * 0.1),
  };
}

function suggestedActionsFor(cluster: EvolutionFailureCluster): EvolutionAction[] {
  if (cluster.targetMemoryIds.length === 0) return [];
  if (cluster.failureKind === "wrong_recall") {
    return cluster.targetMemoryIds.flatMap((memoryId) => [
      { type: "adjust_reinforcement", memoryId, delta: -0.1 },
      { type: "adjust_confidence", memoryId, delta: -0.1 },
    ]);
  }
  if (cluster.failureKind === "missed_recall") {
    return cluster.targetMemoryIds.flatMap((memoryId) => [
      { type: "adjust_reinforcement", memoryId, delta: 0.1 },
      { type: "reactivate", memoryId },
    ]);
  }
  if (cluster.failureKind === "action_policy_missing") {
    return cluster.targetMemoryIds.map((memoryId) => ({ type: "reactivate", memoryId }));
  }
  return [];
}

function patchProposalFor(cluster: EvolutionFailureCluster): EvolutionPolicyPatchProposal {
  return {
    id: `proposal_${cluster.signatureHash}`,
    clusterId: cluster.id,
    title: `${cluster.failureKind} approval-gated policy patch candidate`,
    summary:
      `Candidate only: ${cluster.suggestedFocus} Apply only after human or host approval and keep Memory Gym gates green.`,
    suggestedActions: suggestedActionsFor(cluster),
    autoApply: false,
    autoRollout: false,
  };
}

const MAX_PARAMETER_PROPOSALS = 5;

function parameterProposal(input: {
  title: string;
  configKeyPath: string;
  currentDefault: unknown;
  proposedValue: unknown;
  supportingStatistics: Record<string, unknown>;
  rationale: string;
  configSnippet: string;
}): EvolutionParameterTuningProposal {
  const hash = signatureHash({
    configKeyPath: input.configKeyPath,
    proposedValue: input.proposedValue,
    supportingStatistics: input.supportingStatistics,
  });
  return {
    id: `parameter_proposal_${hash}`,
    title: input.title,
    configKeyPath: input.configKeyPath,
    currentDefault: input.currentDefault,
    proposedValue: input.proposedValue,
    supportingStatistics: input.supportingStatistics,
    rationale: input.rationale,
    configSnippet: input.configSnippet,
    autoApply: false,
    autoRollout: false,
  };
}

function createMemoryOsSnippet(body: string): string {
  return [
    "createMemoryOS({",
    "  store,",
    "  profileId,",
    body,
    "});",
  ].join("\n");
}

function sampleIds(ids: string[]): string[] {
  return uniqueSorted(ids).slice(0, 5);
}

function reviewTerms(content: string): string[] {
  return uniqueSorted(
    (content.toLowerCase().match(/[\p{Letter}\p{Number}_-]{3,}/gu) ?? [])
      .filter((term) => classifySensitivity(term) === "normal"),
  ).slice(0, 12);
}

function memoryMatchesTerms(memory: MemoryRecord, terms: string[]): boolean {
  if (terms.length === 0) return false;
  const lower = memory.content.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

function mostCommonMemoryKind(memories: MemoryRecord[]): MemoryRecord["kind"] | null {
  const counts = new Map<MemoryRecord["kind"], number>();
  for (const memory of memories) counts.set(memory.kind, (counts.get(memory.kind) ?? 0) + 1);
  return [...counts.entries()]
    .sort((left, right) => {
      const count = right[1] - left[1];
      if (count !== 0) return count;
      return left[0].localeCompare(right[0]);
    })[0]?.[0] ?? null;
}

async function listReviewMemories(
  store: FailureReviewStore,
  input: MemoryListInput,
): Promise<MemoryRecord[]> {
  return store.listMemories ? await store.listMemories(input) : [];
}

async function listReviewEvidence(
  store: FailureReviewStore,
  input: { profileId: string; sourceType: string; limit: number },
): Promise<EvidenceEvent[]> {
  return store.listEvidence
    ? await store.listEvidence({ ...input, includeSensitive: true })
    : [];
}

async function parameterProposalsFor(input: {
  store: FailureReviewStore;
  profileId: string;
  failures: FailureEventRecord[];
}): Promise<EvolutionParameterTuningProposal[]> {
  const proposals: EvolutionParameterTuningProposal[] = [];
  const failuresByKind = new Map<FailureKind, FailureEventRecord[]>();
  for (const failure of input.failures) {
    const events = failuresByKind.get(failure.failureKind) ?? [];
    events.push(failure);
    failuresByKind.set(failure.failureKind, events);
  }

  const targetIds = uniqueSorted(input.failures.flatMap(targetMemoryIdsForFailure));
  const memories = targetIds.length > 0
    ? await listReviewMemories(input.store, {
        profileId: input.profileId,
        status: "any",
        includeSensitive: true,
        includePerson: true,
        limit: 500,
      })
    : [];
  const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
  const wrongRecallEvents = failuresByKind.get("wrong_recall") ?? [];
  const weakWrongRecallTargets = uniqueSorted(
    wrongRecallEvents
      .flatMap(targetMemoryIdsForFailure)
      .filter((memoryId) => {
        const memory = memoryById.get(memoryId);
        return memory && (memory.confidence <= 0.5 || (memory.reinforcement ?? 0) <= 0);
      }),
  );
  if (wrongRecallEvents.length >= 2 && weakWrongRecallTargets.length > 0) {
    proposals.push(parameterProposal({
      title: "Increase wrong-recall confidence penalty",
      configKeyPath: "lifecycle.feedbackConfidencePenalty.step",
      currentDefault: 0.1,
      proposedValue: 0.15,
      supportingStatistics: {
        failureKind: "wrong_recall",
        failureCount: wrongRecallEvents.length,
        sampleEventIds: sampleIds(wrongRecallEvents.map((event) => event.id)),
        targetMemoryIds: sampleIds(weakWrongRecallTargets),
      },
      rationale:
        "Repeated wrong_recall failures target low-confidence or non-reinforced memories; a larger penalty makes later review demote them faster.",
      configSnippet: createMemoryOsSnippet(
        "  lifecycle: { feedbackConfidencePenalty: { step: 0.15 } },",
      ),
    }));
  }

  const missedRecallEvents = failuresByKind.get("missed_recall") ?? [];
  if (missedRecallEvents.length > 0) {
    const dormantMemories = await listReviewMemories(input.store, {
      profileId: input.profileId,
      status: "dormant",
      includeSensitive: true,
      limit: 500,
    });
    const matches = dormantMemories.filter((memory) =>
      missedRecallEvents.some((event) => memoryMatchesTerms(memory, reviewTerms(event.content)))
    );
    const kind = mostCommonMemoryKind(matches);
    if (kind) {
      const currentDefault = DEFAULT_MEMORY_HALF_LIVES_DAYS[kind];
      const proposedValue = Math.max(currentDefault + 1, Math.round(currentDefault * 1.25));
      proposals.push(parameterProposal({
        title: `Lengthen ${kind} half-life after missed recall`,
        configKeyPath: `lifecycle.halfLivesDays.${kind}`,
        currentDefault,
        proposedValue,
        supportingStatistics: {
          failureKind: "missed_recall",
          failureCount: missedRecallEvents.length,
          sampleEventIds: sampleIds(missedRecallEvents.map((event) => event.id)),
          dormantMemoryIds: sampleIds(matches.map((memory) => memory.id)),
        },
        rationale:
          "Missed recall failures had dormant memories matching the failure terms; a longer half-life keeps that kind active longer.",
        configSnippet: createMemoryOsSnippet(
          `  lifecycle: { halfLivesDays: { ${kind}: ${proposedValue} } },`,
        ),
      }));
    }
  }

  const consolidationEvidence = await listReviewEvidence(input.store, {
    profileId: input.profileId,
    sourceType: "consolidation",
    limit: 100,
  });
  const duplicateConsolidationEvidence = consolidationEvidence.filter(
    (event) =>
      event.payload._gmosSchema === GMOS_EVIDENCE_PAYLOAD_SCHEMAS.consolidationDuplicate &&
      typeof event.payload.archivedMemberId === "string",
  );
  if (duplicateConsolidationEvidence.length >= 2) {
    proposals.push(parameterProposal({
      title: "Tighten duplicate consolidation threshold",
      configKeyPath: "consolidation.tagOverlapThreshold",
      currentDefault: 0.6,
      proposedValue: 0.7,
      supportingStatistics: {
        evidenceCount: duplicateConsolidationEvidence.length,
        sampleEvidenceIds: sampleIds(duplicateConsolidationEvidence.map((event) => event.id)),
      },
      rationale:
        "Repeated duplicate consolidation evidence suggests near-duplicate grouping is too broad for this profile.",
      configSnippet: createMemoryOsSnippet(
        "  consolidation: { tagOverlapThreshold: 0.7 },",
      ),
    }));
  }

  return proposals
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, MAX_PARAMETER_PROPOSALS);
}

function actionKey(action: EvolutionAction): string {
  if (action.type === "adjust_confidence" || action.type === "adjust_reinforcement") {
    return JSON.stringify({
      type: action.type,
      memoryId: action.memoryId,
      delta: action.delta,
    });
  }
  return JSON.stringify({
    type: action.type,
    memoryId: action.memoryId,
  });
}

function narrowedActions(input: {
  proposal: EvolutionPolicyPatchProposal;
  requested?: EvolutionAction[] | undefined;
}): EvolutionAction[] {
  const actions = input.requested ?? input.proposal.suggestedActions;
  if (actions.length === 0) {
    throw new EvolutionApplicationError(
      "no_actions",
      "gmOS evolution proposal has no suggested actions to apply",
    );
  }
  const allowed = new Set(input.proposal.suggestedActions.map(actionKey));
  const selected: EvolutionAction[] = [];
  const seen = new Set<string>();
  for (const action of actions) {
    const key = actionKey(action);
    if (!allowed.has(key)) {
      throw new EvolutionApplicationError(
        "actions_not_allowed",
        "gmOS evolution actions can narrow a proposal but cannot widen it",
      );
    }
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(action);
  }
  return selected;
}

function applicationStore(store: FailureReviewStore | undefined): EvolutionApplicationStore {
  if (!store || !("applyEvolutionActions" in store) || !("revertEvolutionApplication" in store)) {
    throw new EvolutionApplicationError(
      "store_apply_unsupported",
      "gmOS evolution apply requires a store with evolution admin mutations",
    );
  }
  return store as EvolutionApplicationStore;
}

function mapStoreError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/already reverted/u.test(message)) {
    throw new EvolutionApplicationError("application_already_reverted", message);
  }
  if (/not found/u.test(message)) {
    throw new EvolutionApplicationError("application_not_found", message);
  }
  throw error;
}

export function createEvolutionControlPlane(
  options: EvolutionControlPlaneOptions = {},
): EvolutionControlPlane {
  async function reviewFailures(input: ReviewFailuresInput = {}): Promise<EvolutionFailureReviewReport> {
    const store = options.store;
    if (!store?.listFailures) {
      throw new Error("gmOS evolution review requires a store with listFailures()");
    }
    const profileId = input.profileId ?? options.profileId ?? "default";
    const failures = await store.listFailures({
      profileId,
      failureKind: input.failureKind,
      limit: input.limit ?? 100,
    });
    const groups = new Map<FailureKind, FailureEventRecord[]>();
    for (const failure of failures) {
      const events = groups.get(failure.failureKind) ?? [];
      events.push(failure);
      groups.set(failure.failureKind, events);
    }
    const clusters = [...groups.entries()]
      .map(([failureKind, events]) => summarizeCluster(profileId, failureKind, events))
      .sort((a, b) => {
        const latest = b.latestAt.localeCompare(a.latestAt);
        if (latest !== 0) return latest;
        return a.id.localeCompare(b.id);
      });
    const hypotheses = clusters.map(hypothesisFor);
    const patchProposals = clusters.map(patchProposalFor);
    const parameterProposals = await parameterProposalsFor({ store, profileId, failures });
    return {
      mode: "propose_with_approval",
      autoApply: false,
      autoRollout: false,
      profileId,
      generatedAt: options.now?.() ?? new Date().toISOString(),
      inspectedFailureCount: failures.length,
      decision: failures.length === 0 ? "no_failures" : "propose_with_approval_review",
      clusters,
      hypotheses,
      patchProposals,
      parameterProposals,
      hardGateReminders: HARD_GATE_REMINDERS,
    };
  }

  return {
    mode: "propose_with_approval",
    autoApply: false,
    autoRollout: false,
    reviewFailures,
    async applyEvolutionProposal(input: ApplyEvolutionProposalInput) {
      const approvedBy = input.approvedBy.trim();
      if (!approvedBy) {
        throw new EvolutionApplicationError(
          "approved_by_required",
          "gmOS evolution apply requires approvedBy",
        );
      }
      const profileId = input.profileId ?? options.profileId ?? "default";
      const report = await reviewFailures({ profileId });
      const proposal = report.patchProposals.find((entry) => entry.id === input.proposalId);
      const parameterProposal = report.parameterProposals.find((entry) => entry.id === input.proposalId);
      if (parameterProposal) {
        throw new EvolutionApplicationError(
          "parameter_proposal_host_owned",
          `gmOS parameter proposal is recommendation-only; apply it in createMemoryOS config: ${parameterProposal.configSnippet}`,
        );
      }
      if (!proposal) {
        throw new EvolutionApplicationError(
          "proposal_not_found",
          `gmOS evolution proposal not found: ${input.proposalId}`,
        );
      }
      try {
        return await applicationStore(options.store).applyEvolutionActions({
          profileId,
          proposalId: proposal.id,
          approvedBy,
          actions: narrowedActions({ proposal, requested: input.actions }),
          appliedAt: options.now?.() ?? new Date().toISOString(),
        });
      } catch (error) {
        mapStoreError(error);
      }
    },
    async revertEvolutionApplication(input: RevertEvolutionApplicationInput) {
      try {
        return await applicationStore(options.store).revertEvolutionApplication({
          profileId: input.profileId ?? options.profileId,
          applicationEventId: input.applicationEventId,
          revertedAt: options.now?.() ?? new Date().toISOString(),
        });
      } catch (error) {
        mapStoreError(error);
      }
    },
  };
}

export function renderEvolutionFailureReviewMarkdown(
  report: EvolutionFailureReviewReport,
): string {
  return [
    "# gmOS Evolution Failure Review",
    "",
    `Mode: ${report.mode}`,
    `Decision: ${report.decision}`,
    `Profile: ${report.profileId}`,
    `Generated: ${report.generatedAt}`,
    `Auto apply: ${report.autoApply ? "yes" : "no"}`,
    `Auto rollout: ${report.autoRollout ? "yes" : "no"}`,
    `Inspected failures: ${report.inspectedFailureCount}`,
    "",
    "## Clusters",
    "",
    report.clusters.length === 0
      ? "No failure clusters found."
      : "| Cluster | Kind | Events | Latest | Targets | Focus |\n| --- | --- | ---: | --- | --- | --- |\n" +
          report.clusters
            .map(
              (cluster) =>
                `| ${cluster.id} | ${cluster.failureKind} | ${cluster.eventCount} | ${cluster.latestAt} | ${cluster.targetMemoryIds.join(", ")} | ${cluster.suggestedFocus} |`,
            )
            .join("\n"),
    "",
    "## Hypotheses",
    "",
    report.hypotheses.length === 0
      ? "No repair hypotheses generated."
      : report.hypotheses
          .map(
            (hypothesis) =>
              `- ${hypothesis.title} (${hypothesis.confidence.toFixed(2)}): ${hypothesis.rationale}`,
          )
          .join("\n"),
    "",
    "## Patch Proposals",
    "",
    report.patchProposals.length === 0
      ? "No patch proposals generated."
      : report.patchProposals
          .map(
            (proposal) =>
              `- ${proposal.id}: ${proposal.title}: ${proposal.summary} actions=${proposal.suggestedActions.length} autoApply=${proposal.autoApply} autoRollout=${proposal.autoRollout}`,
          )
          .join("\n"),
    "",
    "## Parameter Proposals",
    "",
    report.parameterProposals.length === 0
      ? "No parameter proposals generated."
      : report.parameterProposals
          .map(
            (proposal) =>
              [
                `- ${proposal.id}: ${proposal.title}`,
                `  - Config: ${proposal.configKeyPath}`,
                `  - Current default: ${JSON.stringify(proposal.currentDefault)}`,
                `  - Proposed value: ${JSON.stringify(proposal.proposedValue)}`,
                `  - Rationale: ${proposal.rationale}`,
                "  - Copy:",
                "```ts",
                proposal.configSnippet,
                "```",
              ].join("\n"),
          )
          .join("\n"),
    "",
    "## Hard Gate Reminders",
    "",
    ...report.hardGateReminders.map((reminder) => `- ${reminder}`),
    "",
  ].join("\n");
}
