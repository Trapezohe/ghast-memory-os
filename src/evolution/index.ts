import { classifySensitivity, redactForReport } from "../kernel/safety.js";
import type {
  FailureEventRecord,
  FailureKind,
  ListFailuresInput,
} from "../kernel/types.js";

export interface FailureReviewStore {
  listFailures(input: ListFailuresInput): Promise<FailureEventRecord[]> | FailureEventRecord[];
}

export interface EvolutionFailureCluster {
  id: string;
  failureKind: FailureKind;
  eventCount: number;
  latestAt: string;
  sampleEventIds: string[];
  sampleContents: string[];
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
  autoApply: false;
  autoRollout: false;
}

export interface EvolutionFailureReviewReport {
  mode: "report_only";
  autoApply: false;
  autoRollout: false;
  profileId: string;
  generatedAt: string;
  inspectedFailureCount: number;
  decision: "no_failures" | "report_only_review";
  clusters: EvolutionFailureCluster[];
  hypotheses: EvolutionRepairHypothesis[];
  patchProposals: EvolutionPolicyPatchProposal[];
  hardGateReminders: string[];
}

export interface ReviewFailuresInput {
  profileId?: string | undefined;
  failureKind?: FailureKind | undefined;
  limit?: number | undefined;
}

export interface EvolutionControlPlane {
  mode: "report_only";
  autoApply: false;
  autoRollout: false;
  reviewFailures(input?: ReviewFailuresInput): Promise<EvolutionFailureReviewReport>;
}

export interface EvolutionControlPlaneOptions {
  store?: FailureReviewStore | undefined;
  profileId?: string | undefined;
  now?: (() => string) | undefined;
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

function clusterId(profileId: string, failureKind: FailureKind): string {
  return `failure_cluster_${profileId}_${failureKind}`.replace(/[^\w.-]+/gu, "_");
}

function byLatestDesc(a: FailureEventRecord, b: FailureEventRecord): number {
  return b.createdAt.localeCompare(a.createdAt);
}

function safeFailureSample(content: string): string {
  if (classifySensitivity(content) !== "normal") return "[redacted_sensitive_failure]";
  return redactForReport(content);
}

function summarizeCluster(
  profileId: string,
  failureKind: FailureKind,
  events: FailureEventRecord[],
): EvolutionFailureCluster {
  const sorted = [...events].sort(byLatestDesc);
  return {
    id: clusterId(profileId, failureKind),
    failureKind,
    eventCount: sorted.length,
    latestAt: sorted[0]?.createdAt ?? "",
    sampleEventIds: sorted.slice(0, 3).map((event) => event.id),
    sampleContents: sorted.slice(0, 3).map((event) => safeFailureSample(event.content)),
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

function patchProposalFor(cluster: EvolutionFailureCluster): EvolutionPolicyPatchProposal {
  return {
    id: `patch_proposal_${cluster.id}`,
    clusterId: cluster.id,
    title: `${cluster.failureKind} report-only policy patch candidate`,
    summary:
      `Candidate only: ${cluster.suggestedFocus} Run Memory Gym and host compatibility gates before any policy change.`,
    autoApply: false,
    autoRollout: false,
  };
}

export function createEvolutionControlPlane(
  options: EvolutionControlPlaneOptions = {},
): EvolutionControlPlane {
  return {
    mode: "report_only",
    autoApply: false,
    autoRollout: false,
    async reviewFailures(input: ReviewFailuresInput = {}) {
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
        .sort((a, b) => b.latestAt.localeCompare(a.latestAt));
      const hypotheses = clusters.map(hypothesisFor);
      const patchProposals = clusters.map(patchProposalFor);
      return {
        mode: "report_only",
        autoApply: false,
        autoRollout: false,
        profileId,
        generatedAt: options.now?.() ?? new Date().toISOString(),
        inspectedFailureCount: failures.length,
        decision: failures.length === 0 ? "no_failures" : "report_only_review",
        clusters,
        hypotheses,
        patchProposals,
        hardGateReminders: HARD_GATE_REMINDERS,
      };
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
      : "| Cluster | Kind | Events | Latest | Focus |\n| --- | --- | ---: | --- | --- |\n" +
          report.clusters
            .map(
              (cluster) =>
                `| ${cluster.id} | ${cluster.failureKind} | ${cluster.eventCount} | ${cluster.latestAt} | ${cluster.suggestedFocus} |`,
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
              `- ${proposal.title}: ${proposal.summary} autoApply=${proposal.autoApply} autoRollout=${proposal.autoRollout}`,
          )
          .join("\n"),
    "",
    "## Hard Gate Reminders",
    "",
    ...report.hardGateReminders.map((reminder) => `- ${reminder}`),
    "",
  ].join("\n");
}
