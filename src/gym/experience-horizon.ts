import { memoryHttpRequestNeedsHistoryAccess } from "../http/index.js";
import { createMemoryOS } from "../runtime/create-memory-os.js";
import { createSqliteMemoryStore } from "../store/sqlite/index.js";
import type {
  EvidenceEvent,
  MemoryExtractor,
  MemoryRecord,
} from "../kernel/types.js";
import type {
  MemoryGymExperienceHorizonAssertion,
  MemoryGymExperienceHorizonReport,
  MemoryGymExperienceHorizonScenario,
} from "./types.js";

const BASE_TIME_MS = Date.parse("2026-01-01T00:00:00.000Z");
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function weekIso(week: number, minute = 0): string {
  return new Date(BASE_TIME_MS + week * WEEK_MS + minute * 60 * 1000).toISOString();
}

function assertions(
  input: Record<string, boolean>,
): MemoryGymExperienceHorizonAssertion[] {
  return Object.entries(input).map(([name, passed]) => ({ name, passed }));
}

function scenarioResult(input: {
  name: string;
  assertions: Record<string, boolean>;
  counters: Record<string, number>;
}): MemoryGymExperienceHorizonScenario {
  const scenarioAssertions = assertions(input.assertions);
  return {
    name: input.name,
    pass: scenarioAssertions.every((assertion) => assertion.passed),
    assertions: scenarioAssertions,
    counters: input.counters,
  };
}

function mergeCounters(
  scenarios: MemoryGymExperienceHorizonScenario[],
): Record<string, number> {
  const counters: Record<string, number> = {};
  for (const scenario of scenarios) {
    for (const [name, value] of Object.entries(scenario.counters)) {
      counters[name] = (counters[name] ?? 0) + value;
    }
  }
  return counters;
}

function containsAny(value: unknown, terms: string[]): boolean {
  const serialized = JSON.stringify(value);
  return terms.some((term) => serialized.includes(term));
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isRedactedEvidence(event: EvidenceEvent): boolean {
  const redaction = payloadRecord(event.payload.redaction);
  return event.content === "[redacted_evidence_content]" &&
    redaction.marker === "redacted_evidence_content" &&
    typeof redaction.originalSha256 === "string" &&
    typeof redaction.originalLength === "number";
}

function memorySourceTrust(memory: MemoryRecord | null | undefined): string | undefined {
  return typeof memory?.metadata.sourceTrust === "string"
    ? memory.metadata.sourceTrust
    : undefined;
}

function memoryAnnealed(memory: MemoryRecord | null | undefined): boolean {
  return payloadRecord(memory?.metadata.annealing).active === true;
}


async function preferenceAdherenceOverTime(): Promise<MemoryGymExperienceHorizonScenario> {
  const profileId = "experience_preference_horizon";
  const store = createSqliteMemoryStore({ path: ":memory:" });
  const memory = createMemoryOS({
    profileId,
    store,
    lifecycle: {
      halfLivesDays: { fact: 7, preference: 365 },
      dormantBelow: 0.25,
    },
  });
  try {
    const preference = await memory.add({
      kind: "preference",
      content: "HorizonPreferenceSignal: answer with concise risk-first release notes.",
      confidence: 0.72,
      createdAt: weekIso(0),
    });
    await memory.add({
      kind: "boundary",
      content: "HorizonBoundarySignal: do not push Friday deploy reminders.",
      confidence: 0.6,
      createdAt: weekIso(0, 1),
    });
    const unusedFact = await memory.add({
      kind: "fact",
      content: "HorizonUnusedLowConfidenceFactSignal: cafeteria table is blue.",
      confidence: 0.1,
      createdAt: weekIso(0, 2),
    });

    let boundaryPolicyWeeks = 0;
    let preferenceHitWeeks = 0;
    for (let week = 1; week <= 8; week += 1) {
      await memory.maintain({ now: weekIso(week), phases: ["decay"] });
      const prepared = await memory.prepareTurn({
        messages: [{ role: "user", content: "HorizonPreferenceSignal HorizonBoundarySignal" }],
      });
      if (
        prepared.actionPolicies.some(
          (policy) =>
            policy.kind === "do_not_push" &&
            policy.text.includes("HorizonBoundarySignal"),
        )
      ) {
        boundaryPolicyWeeks += 1;
      }
      if (prepared.contextBlock.includes("HorizonPreferenceSignal")) {
        preferenceHitWeeks += 1;
      }
      await memory.commitOutcome({
        objective: `Week ${week} preference adherence`,
        status: "completed",
        createdAt: weekIso(week, 30),
        usedMemoryIds: [preference.id],
      });
    }

    const horizonPrepared = await memory.prepareTurn({
      messages: [{ role: "user", content: "HorizonPreferenceSignal HorizonUnusedLowConfidenceFactSignal" }],
    });
    const unusedAfterDecay = await memory.get({ id: unusedFact.id, includeArchived: true });
    const boundaryAfterDecay = await memory.list({
      kind: "boundary",
      query: "HorizonBoundarySignal",
      limit: 10,
    });
    return scenarioResult({
      name: "preference_adherence_over_time",
      assertions: {
        reinforced_preference_at_horizon: horizonPrepared.contextBlock.includes("HorizonPreferenceSignal"),
        unused_fact_dormant: unusedAfterDecay?.status === "dormant",
        unused_fact_out_of_context: !horizonPrepared.contextBlock.includes("HorizonUnusedLowConfidenceFactSignal"),
        boundary_active_at_horizon: boundaryAfterDecay.some((entry) => entry.content.includes("HorizonBoundarySignal")),
        boundary_policy_every_week: boundaryPolicyWeeks === 8,
      },
      counters: {
        preferenceAdherenceHits: preferenceHitWeeks,
        preferenceAdherenceWeeks: 8,
        boundaryPolicyWeeks,
      },
    });
  } finally {
    await memory.close();
  }
}

async function forgettingComplianceFullSurface(): Promise<MemoryGymExperienceHorizonScenario> {
  const profileId = "experience_forgetting_surface";
  const forgottenTerms = ["ForgettableSubjectResidue", "AmberHorizonResidue"];
  const store = createSqliteMemoryStore({ path: ":memory:" });
  const memory = createMemoryOS({
    profileId,
    store,
    consolidation: { tagOverlapThreshold: 0.3 },
    consolidator(cluster) {
      if (!cluster.memories.some((entry) => entry.content.includes("ForgettableSubjectResidue"))) {
        return null;
      }
      return [{
        kind: "project",
        content: "DerivedSummaryResidue says AmberHorizonResidue was chosen from source notes.",
        confidence: 0.84,
      }];
    },
    procedureDistiller(cluster) {
      if (!cluster.objective.includes("forget compliance cleanup")) return null;
      return {
        content: "ForgettableSubjectResidue distilled procedure should be archived by forget.",
        confidence: 0.82,
      };
    },
  });
  try {
    const unrelated = await memory.add({
      kind: "fact",
      content: "UnrelatedLifecycleHorizonSignal remains explainable after forget.",
      createdAt: weekIso(0),
    });
    const sharedEvidence = await store.recordEvidence({
      profileId,
      eventKey: "experience_forgetting_shared_source",
      sourceType: "test.shared_source",
      content: "SharedSourceResidue contains SharedForgetOnlyTerm and SharedSurvivorTerm.",
      sensitivity: "normal",
      eligibleForLongTermMemory: true,
      createdAt: weekIso(0, 3),
    });
    const sharedForgotten = await store.addMemory({
      profileId,
      kind: "fact",
      content: "SharedForgetOnlyTerm should archive without redacting shared source evidence.",
      confidence: 0.72,
      sourceEventId: sharedEvidence.id,
      createdAt: weekIso(0, 4),
    });
    const sharedSurvivor = await store.addMemory({
      profileId,
      kind: "fact",
      content: "SharedSurvivorTerm remains active from the same evidence event.",
      confidence: 0.72,
      sourceEventId: sharedEvidence.id,
      createdAt: weekIso(0, 5),
    });
    for (const suffix of ["alpha", "beta", "gamma"]) {
      await memory.add({
        kind: "project",
        content: `ForgettableSubjectResidue ${suffix} says AmberHorizonResidue is the launch marker.`,
        confidence: 0.74,
        createdAt: weekIso(0, suffix.charCodeAt(0)),
      });
    }
    const consolidation = await memory.maintain({
      now: weekIso(1),
      phases: ["consolidate"],
    });
    const summaryId = consolidation.consolidation.summaryMemories[0]?.memoryId;

    for (let week = 1; week <= 3; week += 1) {
      await memory.commitOutcome({
        objective: "forget compliance cleanup",
        status: "completed",
        summary: `completed cleanup rehearsal ${week}`,
        createdAt: weekIso(week, 20),
      });
    }
    const distillation = await memory.maintain({
      now: weekIso(4),
      phases: ["distill"],
    });
    const procedureId = distillation.distillation.summaryMemories[0]?.memoryId;

    const forgottenMain = await memory.forget({
      query: "ForgettableSubjectResidue",
      targetTerms: ["ForgettableSubjectResidue"],
      reason: "experience horizon forget compliance",
    });
    const forgottenShared = await memory.forget({
      query: "SharedForgetOnlyTerm",
      targetTerms: ["SharedForgetOnlyTerm"],
      reason: "experience horizon shared-source forget compliance",
    });
    const forgotten = {
      archivedMemoryIds: [...new Set([
        ...forgottenMain.archivedMemoryIds,
        ...forgottenShared.archivedMemoryIds,
      ])],
    };
    const residueQuery = "launch marker source notes";
    const prepared = await memory.prepareTurn({
      messages: [{ role: "user", content: residueQuery }],
      includeEvidence: true,
    });
    const reconstructed = await memory.reconstructContext({
      query: residueQuery,
      includeEvidence: true,
      maxSteps: 4,
      maxBranch: 8,
      maxMemories: 8,
    });
    const contextSearch = await memory.search({
      query: residueQuery,
      purpose: "context",
      limit: 20,
    });
    const historySearch = await memory.search({
      query: residueQuery,
      purpose: "history",
      limit: 20,
    });
    const explanation = await memory.explainTurn({
      messages: [{ role: "user", content: residueQuery }],
      maxExcluded: 50,
    });
    const unrelatedExplanation = await memory.explain(unrelated.id);
    const evidenceEvents = await memory.listEvidence({
      includeSensitive: true,
      limit: 200,
    });
    const associations = store.searchAssociations({
      profileId,
      query: residueQuery,
      purpose: "context",
      limit: 50,
    });
    const indexStatus = store.searchIndexStatus();
    const summaryAfterForget = summaryId
      ? await memory.get({ id: summaryId, includeArchived: true })
      : null;
    const procedureAfterForget = procedureId
      ? await memory.get({ id: procedureId, includeArchived: true })
      : null;
    const sharedForgottenAfterForget = await memory.get({
      id: sharedForgotten.id,
      includeArchived: true,
    });
    const sharedSurvivorAfterForget = await memory.get({ id: sharedSurvivor.id });
    const sharedEvidenceAfterForget = evidenceEvents.find((event) => event.id === sharedEvidence.id);
    const redactedEvidenceEvents = evidenceEvents.filter(isRedactedEvidence);
    const surfaceResidues = {
      prepareTurnResidue: containsAny(prepared.contextBlock, forgottenTerms) ? 1 : 0,
      prepareEvidenceResidue: containsAny(prepared.evidence, forgottenTerms) ? 1 : 0,
      reconstructContextResidue: containsAny(reconstructed.contextBlock, forgottenTerms) ? 1 : 0,
      reconstructEvidenceResidue: containsAny(reconstructed.evidence, forgottenTerms) ? 1 : 0,
      searchContextResidue: containsAny(contextSearch, forgottenTerms) ? 1 : 0,
      searchHistoryResidue: containsAny(historySearch, forgottenTerms) ? 1 : 0,
      explainTurnResidue: containsAny(
        {
          included: explanation.included,
          excluded: explanation.excluded,
        },
        forgottenTerms,
      ) ? 1 : 0,
      lifecycleHistoryResidue: containsAny(unrelatedExplanation?.lifecycle, forgottenTerms) ? 1 : 0,
      evidenceListResidue: containsAny(evidenceEvents, forgottenTerms) ? 1 : 0,
      associationResidue: containsAny(associations, forgottenTerms) ? 1 : 0,
    };
    const surfaceResidue = Object.values(surfaceResidues).reduce((sum, value) => sum + value, 0);
    const indexResidueFree =
      indexStatus.staleEntryCount === 0 &&
      indexStatus.orphanEntryCount === 0 &&
      (indexStatus.vectorIndex?.staleEntryCount ?? 0) === 0 &&
      (indexStatus.vectorIndex?.orphanEntryCount ?? 0) === 0 &&
      (indexStatus.vectorIndex?.staleProviderEntryCount ?? 0) === 0;

    return scenarioResult({
      name: "forgetting_compliance_full_surface",
      assertions: {
        consolidation_summary_created: summaryId !== undefined,
        distillation_procedure_created: procedureId !== undefined,
        source_and_derived_archived:
          forgotten.archivedMemoryIds.length >= 5 &&
          (summaryId ? forgotten.archivedMemoryIds.includes(summaryId) : false) &&
          (procedureId ? forgotten.archivedMemoryIds.includes(procedureId) : false),
        summary_derived_from_forgotten_sources_archived: summaryAfterForget?.status === "archived",
        procedure_archived: procedureAfterForget?.status === "archived",
        shared_source_survivor_preserves_evidence_content:
          sharedForgottenAfterForget?.status === "archived" &&
          sharedSurvivorAfterForget?.status === "active" &&
          sharedEvidenceAfterForget?.content.includes("SharedSourceResidue") === true &&
          !isRedactedEvidence(sharedEvidenceAfterForget),
        source_evidence_content_redacted:
          redactedEvidenceEvents.length >= 5 &&
          redactedEvidenceEvents.every((event) => !containsAny(event.content, forgottenTerms)),
        all_checked_surfaces_residue_free: surfaceResidue === 0,
        derived_indexes_residue_free: indexResidueFree,
      },
      counters: {
        forgettingSurfacesChecked: 13,
        forgettingResidueSurfaces: surfaceResidue,
        forgottenMemoryCount: forgotten.archivedMemoryIds.length,
        redactedEvidenceEvents: redactedEvidenceEvents.length,
        ...surfaceResidues,
      },
    });
  } finally {
    await memory.close();
  }
}

async function contradictionResolutionOverTime(): Promise<MemoryGymExperienceHorizonScenario> {
  const profileId = "experience_contradiction_horizon";
  const store = createSqliteMemoryStore({ path: ":memory:" });
  const memory = createMemoryOS({ profileId, store });
  try {
    const oldFact = await memory.add({
      kind: "project",
      content: "HorizonContradiction project owner is OldOwnerSignal.",
      confidence: 0.78,
      metadata: { predicate: "project.owner" },
      createdAt: weekIso(0),
    });
    await store.addWorldBelief({
      profileId,
      subject: "project:horizon_contradiction",
      predicate: "project.owner",
      object: "OldOwnerSignal",
      confidence: 0.78,
      sourceMemoryId: oldFact.id,
      cardinality: "single",
      createdAt: weekIso(0),
    });
    const newFact = await memory.add({
      kind: "project",
      content: "HorizonContradiction project owner is NewOwnerSignal.",
      confidence: 0.9,
      metadata: { predicate: "project.owner" },
      createdAt: weekIso(4),
    });
    await store.addWorldBelief({
      profileId,
      subject: "project:horizon_contradiction",
      predicate: "project.owner",
      object: "NewOwnerSignal",
      confidence: 0.9,
      sourceMemoryId: newFact.id,
      cardinality: "single",
      createdAt: weekIso(4),
    });
    if (store.rebuildAssociations) {
      await store.rebuildAssociations({ profileId });
    }

    const current = await memory.reconstructContext({
      query: "HorizonContradiction current project owner",
      maxSteps: 4,
      maxBranch: 8,
      maxMemories: 8,
    });
    const history = await memory.reconstructContext({
      query: "HorizonContradiction previous project owner",
      temporalMode: "history",
      maxSteps: 4,
      maxBranch: 8,
      maxMemories: 8,
    });
    const explanation = await memory.explainTurn({
      messages: [{ role: "user", content: "HorizonContradiction current project owner" }],
      maxExcluded: 50,
    });

    return scenarioResult({
      name: "contradiction_resolution_over_time",
      assertions: {
        current_surfaces_newest: current.contextBlock.includes("NewOwnerSignal"),
        current_hides_old: !current.contextBlock.includes("OldOwnerSignal"),
        history_reaches_old: history.contextBlock.includes("OldOwnerSignal"),
        explain_reports_old_excluded: explanation.excluded.some(
          (entry) => entry.id === oldFact.id && (
            entry.reason === "superseded" ||
            entry.reason === "out_of_window"
          ),
        ),
      },
      counters: {
        contradictionHorizonWeeks: 8,
        currentStateHits: current.contextBlock.includes("NewOwnerSignal") ? 1 : 0,
        historyStateHits: history.contextBlock.includes("OldOwnerSignal") ? 1 : 0,
      },
    });
  } finally {
    await memory.close();
  }
}

async function procedureReuseOverTime(): Promise<MemoryGymExperienceHorizonScenario> {
  const profileId = "experience_procedure_reuse";
  const store = createSqliteMemoryStore({ path: ":memory:" });
  const memory = createMemoryOS({
    profileId,
    store,
    lifecycle: {
      halfLivesDays: { procedure: 14 },
      dormantBelow: 0.25,
    },
    procedureDistiller(cluster) {
      if (!cluster.objective.toLowerCase().includes("horizon deploy checklist")) return null;
      return {
        content: "HorizonProcedureSignal deploy checklist: verify evidence, then publish.",
        confidence: 0.82,
      };
    },
  });
  try {
    const unusedProcedure = await memory.add({
      kind: "procedure",
      content: "UnusedHorizonProcedureSignal should decay when never reused.",
      confidence: 0.1,
      createdAt: weekIso(0),
    });
    for (let week = 1; week <= 3; week += 1) {
      await memory.commitOutcome({
        taskId: `horizon-procedure-${week}`,
        objective: "Horizon deploy checklist",
        status: "completed",
        summary: `completed horizon deploy checklist rehearsal ${week}`,
        createdAt: weekIso(week),
      });
    }
    const distillation = await memory.maintain({
      now: weekIso(3, 30),
      phases: ["distill"],
    });
    const procedureId = distillation.distillation.summaryMemories[0]?.memoryId;
    const beforeUse = procedureId ? await memory.get({ id: procedureId }) : null;
    const prepared = await memory.prepareTurn({
      messages: [{ role: "user", content: "How should I run the Horizon deploy checklist?" }],
    });
    if (procedureId) {
      await memory.commitOutcome({
        objective: "Horizon deploy checklist reuse",
        status: "completed",
        createdAt: weekIso(4),
        usedMemoryIds: [procedureId],
      });
    }
    const afterUse = procedureId ? await memory.get({ id: procedureId }) : null;
    await memory.maintain({
      now: weekIso(8),
      phases: ["decay"],
    });
    const unusedAfterDecay = await memory.get({ id: unusedProcedure.id, includeArchived: true });
    const usedAfterDecay = procedureId
      ? await memory.get({ id: procedureId, includeArchived: true })
      : null;

    return scenarioResult({
      name: "procedure_reuse_over_time",
      assertions: {
        procedure_distilled_from_three_trajectories:
          procedureId !== undefined &&
          (distillation.distillation.summaryMemories[0]?.sourceTrajectoryIds.length ?? 0) === 3,
        matching_objective_surfaces_procedure: prepared.actionPolicies.some(
          (policy) =>
            policy.sourceMemoryId === procedureId &&
            policy.kind === "procedure" &&
            policy.text.includes("HorizonProcedureSignal"),
        ),
        committed_use_reinforces_procedure:
          afterUse !== null &&
          beforeUse !== null &&
          (afterUse.recallCount ?? 0) === (beforeUse.recallCount ?? 0) + 1 &&
          (afterUse.reinforcement ?? 0) > (beforeUse.reinforcement ?? 0),
        unused_procedure_decays: unusedAfterDecay?.status === "dormant",
        used_procedure_remains_active: usedAfterDecay?.status === "active",
      },
      counters: {
        procedureReuseDepth: distillation.distillation.summaryMemories[0]?.sourceTrajectoryIds.length ?? 0,
        procedureReuseCount: afterUse?.recallCount ?? 0,
        unusedProcedureDormant: unusedAfterDecay?.status === "dormant" ? 1 : 0,
      },
    });
  } finally {
    await memory.close();
  }
}

async function forensicRollbackAndVersioning(): Promise<MemoryGymExperienceHorizonScenario> {
  const profileId = "experience_forensic_rollback";
  const store = createSqliteMemoryStore({ path: ":memory:" });
  const memory = createMemoryOS({ profileId, store });
  try {
    const original = await memory.add({
      kind: "project",
      content: "RollbackOriginalSignal release owner is Alpha.",
      confidence: 0.41,
      createdAt: weekIso(0),
    });
    const originalEventId = original.sourceEventId ?? "";
    const updated = await memory.update({
      id: original.id,
      content: "RollbackUpdatedSignal release owner is Beta.",
      confidence: 0.86,
      updatedAt: weekIso(0, 10),
    });
    await memory.commitOutcome({
      objective: "Rollback update reinforcement",
      status: "completed",
      usedMemoryIds: [original.id],
      createdAt: weekIso(0, 20),
    });
    const rollback = await memory.memoryRollback({
      memoryId: original.id,
      toEvidenceEventId: originalEventId,
      approvedBy: "experience-horizon",
      rolledBackAt: weekIso(0, 30),
    });
    const restored = await memory.get({ id: original.id });
    const rollbackEvidence = (await memory.listEvidence({
      includeSensitive: true,
      limit: 100,
    })).find((event) => event.id === rollback.rollbackEventId);
    const previousValues = Array.isArray(rollbackEvidence?.payload.previousValues)
      ? rollbackEvidence?.payload.previousValues
      : [];
    const lifecycle = await memory.explain(original.id);

    return scenarioResult({
      name: "forensic_rollback_and_versioning",
      assertions: {
        update_created_new_source_event: Boolean(updated?.sourceEventId && updated.sourceEventId !== originalEventId),
        rollback_restores_original_content:
          restored?.content === "RollbackOriginalSignal release owner is Alpha.",
        rollback_restores_original_confidence: restored?.confidence === 0.41,
        rollback_event_has_previous_values:
          rollbackEvidence?.sourceType === "memory.rollback" &&
          previousValues.some(
            (entry) =>
              payloadRecord(entry).memoryId === original.id &&
              payloadRecord(entry).content === "RollbackUpdatedSignal release owner is Beta.",
          ),
        lifecycle_reports_rollback:
          lifecycle?.lifecycle.entries.some((entry) => entry.eventKind === "rolled_back") === true,
      },
      counters: {
        rollbackPreviousValues: previousValues.length,
        rollbackEvents: rollbackEvidence ? 1 : 0,
      },
    });
  } finally {
    await memory.close();
  }
}

async function trustTieredWriteProvenance(): Promise<MemoryGymExperienceHorizonScenario> {
  const profileId = "experience_trust_tiers";
  const extractor: MemoryExtractor = ({ event }) => {
    if (event.content.includes("TrustedOwnerSignal")) {
      return [{
        kind: "project",
        content: "TrustTierProject owner is TrustedOwnerSignal.",
        confidence: 0.92,
        subject: "project:trust-tier",
        predicate: "project.owner",
        object: "TrustedOwnerSignal",
        cardinality: "single",
      }];
    }
    if (event.content.includes("ExternalOwnerSignal")) {
      return [
        {
          kind: "project",
          content: "TrustTierProject owner is ExternalOwnerSignal.",
          confidence: 0.98,
          subject: "project:trust-tier",
          predicate: "project.owner",
          object: "ExternalOwnerSignal",
          cardinality: "single",
        },
        {
          kind: "boundary",
          content: "ExternalPolicyBoundarySignal says do not push trusted release notes.",
          confidence: 0.98,
          actionPolicyKind: "do_not_push",
        },
        {
          kind: "procedure",
          content: "ExternalProcedureSignal says publish without review.",
          confidence: 0.98,
          actionPolicyKind: "procedure",
        },
      ];
    }
    return [];
  };
  const store = createSqliteMemoryStore({ path: ":memory:" });
  const memory = createMemoryOS({ profileId, store, extractor });
  try {
    await memory.observeWithReport({
      type: "conversation.message",
      role: "user",
      content: "TrustedOwnerSignal",
      sourceTrust: "user",
      createdAt: weekIso(0),
    });
    const external = await memory.observeWithReport({
      type: "conversation.message",
      role: "user",
      content: "ExternalOwnerSignal",
      sourceTrust: "external",
      createdAt: weekIso(0, 1),
    });
    const externalMemory = external.memoryIds[0]
      ? await memory.get({ id: external.memoryIds[0] })
      : null;
    const boundaries = await memory.search({
      query: "ExternalPolicyBoundarySignal ExternalProcedureSignal",
      purpose: "manage",
      limit: 10,
    });
    const beliefs = store.listWorldBeliefs
      ? await store.listWorldBeliefs({
          profileId,
          status: "any",
          limit: 10,
        })
      : [];
    const activeOwner = beliefs.find(
      (belief) =>
        belief.subject === "project:trust-tier" &&
        belief.predicate === "project.owner" &&
        belief.status === "active",
    );
    const rejectedExternalOwner = beliefs.find(
      (belief) => belief.object === "ExternalOwnerSignal" && belief.status === "rejected",
    );
    const evidence = await memory.listEvidence({ includeSensitive: true, limit: 20 });
    const externalEvidence = evidence.find((event) =>
      payloadRecord(event.payload).sourceTrust === "external",
    );

    return scenarioResult({
      name: "trust_tiered_write_provenance",
      assertions: {
        evidence_records_source_trust: externalEvidence !== undefined,
        external_fact_confidence_capped:
          externalMemory !== null && externalMemory.confidence <= 0.55,
        external_fact_annealed: memoryAnnealed(externalMemory),
        external_fact_metadata_trust: memorySourceTrust(externalMemory) === "external",
        external_policy_writes_blocked:
          !boundaries.some((entry) =>
            entry.content.includes("ExternalPolicyBoundarySignal") ||
            entry.content.includes("ExternalProcedureSignal"),
          ),
        lower_trust_cannot_supersede_user_belief:
          activeOwner?.object === "TrustedOwnerSignal" &&
          rejectedExternalOwner !== undefined,
      },
      counters: {
        externalMemoriesCreated: external.memoryIds.length,
        trustBeliefRows: beliefs.length,
      },
    });
  } finally {
    await memory.close();
  }
}

async function confidenceAnnealing(): Promise<MemoryGymExperienceHorizonScenario> {
  const profileId = "experience_confidence_annealing";
  const store = createSqliteMemoryStore({ path: ":memory:" });
  const memory = createMemoryOS({ profileId, store });
  try {
    const target = await memory.add({
      kind: "fact",
      content: "AnnealingRapidBoostSignal should not dominate until independent confirmation.",
      confidence: 0.72,
      createdAt: weekIso(0),
    });
    await memory.commitOutcome({
      objective: "Annealing rapid boost one",
      status: "completed",
      usedMemoryIds: [target.id],
      createdAt: weekIso(0, 1),
    });
    await memory.recordFeedback({
      content: "Annealing rapid boost two",
      signal: "positive",
      relatedMemoryIds: [target.id],
      createdAt: weekIso(0, 2),
    });
    const annealed = await memory.get({ id: target.id });
    const prepared = await memory.prepareTurn({
      messages: [{ role: "user", content: "AnnealingRapidBoostSignal" }],
    });
    const explanation = await memory.explainTurn({
      messages: [{ role: "user", content: "AnnealingRapidBoostSignal" }],
      maxExcluded: 20,
    });
    const included = explanation.included.find((entry) => entry.id === target.id);
    const lifecycle = await memory.explain(target.id);

    return scenarioResult({
      name: "confidence_annealing",
      assertions: {
        rapid_non_independent_boost_sets_annealing: memoryAnnealed(annealed),
        prepare_turn_surfaces_score_annealing:
          prepared.memories.some((entry) => entry.id === target.id) &&
          payloadRecord(
            payloadRecord(
              prepared.memories.find((entry) => entry.id === target.id)?.metadata.annealing,
            ),
          ).active === true,
        explain_turn_reports_annealing:
          payloadRecord(included?.scoreComponents.annealing).active === true,
        lifecycle_reports_annealed:
          lifecycle?.lifecycle.entries.some((entry) => entry.eventKind === "annealed") === true,
      },
      counters: {
        annealedMemories: memoryAnnealed(annealed) ? 1 : 0,
        explanationIncluded: included ? 1 : 0,
      },
    });
  } finally {
    await memory.close();
  }
}

async function principalHistoryAccessScope(): Promise<MemoryGymExperienceHorizonScenario> {
  const profileId = "experience_principal_scope";
  const store = createSqliteMemoryStore({ path: ":memory:" });
  const memory = createMemoryOS({ profileId, store });
  try {
    await memory.add({
      kind: "fact",
      content: "PrincipalScopeCurrentSignal is visible to normal context recall.",
      confidence: 0.8,
      createdAt: weekIso(0),
    });
    await memory.add({
      kind: "fact",
      content: "PrincipalScopeHistorySignal is only for history recall.",
      confidence: 0.8,
      createdAt: weekIso(0, 1),
    });
    const restricted = store.createServiceApiKey({
      label: "experience-no-history",
      scope: "read",
      profiles: [profileId],
      historyAccess: false,
    });
    store.createServiceApiKey({
      label: "experience-full-history",
      scope: "read",
      profiles: [profileId],
    });
    const listedKey = store.listServiceApiKeys().find((key) => key.keyId === restricted.key.keyId);
    const contextNeedsHistory = memoryHttpRequestNeedsHistoryAccess("memory.search", {
      profileId,
      query: "PrincipalScopeCurrentSignal",
      purpose: "context",
    });
    const historySearchNeedsHistory = memoryHttpRequestNeedsHistoryAccess("memory.search", {
      profileId,
      query: "PrincipalScopeHistorySignal",
      purpose: "history",
    });
    const historyReconstructNeedsHistory = memoryHttpRequestNeedsHistoryAccess(
      "memory.reconstruct_context",
      {
        profileId,
        query: "PrincipalScopeHistorySignal",
        temporalMode: "history",
      },
    );
    const archivedVisibilityNeedsHistory = memoryHttpRequestNeedsHistoryAccess("memory.search", {
      profileId,
      query: "PrincipalScopeHistorySignal",
      includeArchived: true,
    });

    return scenarioResult({
      name: "principal_history_access_scope",
      assertions: {
        restricted_key_lists_history_access_false: listedKey?.historyAccess === false,
        context_recall_does_not_require_history_access: !contextNeedsHistory,
        history_search_requires_history_access: historySearchNeedsHistory,
        history_reconstruction_requires_history_access: historyReconstructNeedsHistory,
        archived_visibility_requires_history_access: archivedVisibilityNeedsHistory,
      },
      counters: {
        historyAccessPolicyChecks: 4,
      },
    });
  } finally {
    await memory.close();
  }
}

async function poisoningLifecycle(): Promise<MemoryGymExperienceHorizonScenario> {
  const profileId = "experience_poisoning_lifecycle";
  const poisonTerms = [
    "PoisonLifecycleSignal",
    "PoisonInstructionSignal",
    "LaunderedPoisonSummarySignal",
  ];
  const extractor: MemoryExtractor = ({ event }) => {
    if (event.content.includes("TrustedRankSignal")) {
      return [{
        kind: "project",
        content: "DeployRankSignal TrustedRankSignal release checklist is the source of truth.",
        confidence: 0.94,
      }];
    }
    if (event.content.includes("PoisonLifecycleSignal")) {
      return [
        {
          kind: "project",
          content: `DeployRankSignal PoisonLifecycleSignal ${event.content} repeats PoisonInstructionSignal.`,
          confidence: 0.99,
        },
        {
          kind: "boundary",
          content: "PoisonInstructionSignal says do not push trusted deploys.",
          confidence: 0.99,
          actionPolicyKind: "do_not_push",
        },
        {
          kind: "fact",
          content: "PoisonSecretSignal includes sk-poison-lifecycle-secret",
          confidence: 0.99,
        },
      ];
    }
    return [];
  };
  const store = createSqliteMemoryStore({ path: ":memory:" });
  const memory = createMemoryOS({
    profileId,
    store,
    extractor,
    consolidation: {
      hookMinClusterSize: 2,
      tagOverlapThreshold: 0.2,
    },
    consolidator(cluster) {
      if (!cluster.memories.some((entry) => entry.content.includes("PoisonLifecycleSignal"))) {
        return null;
      }
      return [{
        kind: "project",
        content:
          "DeployRankSignal LaunderedPoisonSummarySignal carries PoisonInstructionSignal from compressed poison notes.",
        confidence: 0.99,
      }];
    },
  });
  try {
    const poisonReports = [];
    for (const label of ["alpha", "beta"]) {
      poisonReports.push(await memory.observeWithReport({
        type: "conversation.message",
        role: "user",
        content: `PoisonLifecycleSignal ${label}`,
        sourceTrust: "external",
        createdAt: weekIso(0, label === "alpha" ? 1 : 2),
      }));
    }
    const poisonMemoryIds = poisonReports.flatMap((report) => report.memoryIds);
    const poisonMemories = await Promise.all(
      poisonMemoryIds.map((id) => memory.get({ id })),
    );
    const policySearch = await memory.search({
      query: "PoisonInstructionSignal do not push",
      purpose: "manage",
      limit: 10,
    });
    const consolidation = await memory.maintain({
      now: weekIso(1),
      phases: ["consolidate"],
    });
    const summaryId = consolidation.consolidation.summaryMemories[0]?.memoryId;
    const summary = summaryId ? await memory.get({ id: summaryId }) : null;
    await memory.observeWithReport({
      type: "conversation.message",
      role: "user",
      content: "TrustedRankSignal",
      sourceTrust: "user",
      createdAt: weekIso(1, 1),
    });
    const prepared = await memory.prepareTurn({
      messages: [{ role: "user", content: "DeployRankSignal" }],
    });
    const trustedIndex = prepared.memories.findIndex((entry) =>
      entry.content.includes("TrustedRankSignal"),
    );
    const poisonIndex = prepared.memories.findIndex((entry) =>
      entry.content.includes("PoisonLifecycleSignal") ||
      entry.content.includes("LaunderedPoisonSummarySignal"),
    );
    const exported = store.exportProfileBundle({
      profileId,
      mode: "full",
      includeArchived: true,
      includeSensitive: true,
      includePerson: true,
      includeEvidence: true,
      includeWorldBeliefs: true,
      includeFailures: true,
      includeTaskTrajectories: true,
    });
    const importedProfileId = "experience_poisoning_imported";
    const importedStore = createSqliteMemoryStore({ path: ":memory:" });
    const importedMemory = createMemoryOS({ profileId: importedProfileId, store: importedStore });
    try {
      importedStore.importProfileBundle({
        backup: exported,
        profileId: importedProfileId,
        onConflict: "replace",
      });
      const importedPoison = await importedMemory.search({
        profileId: importedProfileId,
        query: "PoisonLifecycleSignal LaunderedPoisonSummarySignal",
        purpose: "manage",
        limit: 10,
      });
      const forgotten = await memory.forget({
        query: "PoisonLifecycleSignal",
        targetTerms: ["PoisonLifecycleSignal"],
        reason: "experience horizon poisoning recovery",
      });
      const residueEvidence = await memory.listEvidence({
        includeSensitive: true,
        limit: 200,
      });
      const residueSearch = await memory.search({
        query: poisonTerms.join(" "),
        purpose: "history",
        limit: 20,
      });
      return scenarioResult({
        name: "poisoning_lifecycle",
        assertions: {
          write_external_poison_capped_and_secret_rejected:
            poisonMemories.length > 0 &&
            poisonMemories.every((entry) =>
              entry !== null &&
              entry.confidence <= 0.55 &&
              memorySourceTrust(entry) === "external" &&
              memoryAnnealed(entry),
            ) &&
            !containsAny(poisonMemories, ["sk-poison-lifecycle-secret"]),
          execute_policy_boundary_blocked:
            !policySearch.some((entry) => entry.kind === "boundary" || entry.kind === "procedure"),
          compression_inherits_trust_cap:
            summary !== null &&
            summary.confidence <= 0.55 &&
            memorySourceTrust(summary) === "external" &&
            memoryAnnealed(summary),
          retrieve_trusted_memory_outranks_poison:
            trustedIndex >= 0 && (poisonIndex === -1 || trustedIndex < poisonIndex),
          share_import_preserves_trust_and_anneal:
            importedPoison.some((entry) =>
              memorySourceTrust(entry) === "external" && memoryAnnealed(entry),
            ),
          recover_forget_redacts_all_poison_residue:
            forgotten.archivedMemoryIds.length >= poisonMemoryIds.length &&
            residueSearch.length === 0 &&
            !containsAny(residueEvidence, poisonTerms),
        },
        counters: {
          poisonMemories: poisonMemoryIds.length,
          poisoningArchivedMemories: forgotten.archivedMemoryIds.length,
          poisoningEvidenceResidue: containsAny(residueEvidence, poisonTerms) ? 1 : 0,
        },
      });
    } finally {
      await importedMemory.close();
    }
  } finally {
    await memory.close();
  }
}

async function runExperienceHorizonOnce(): Promise<MemoryGymExperienceHorizonScenario[]> {
  return [
    await preferenceAdherenceOverTime(),
    await forgettingComplianceFullSurface(),
    await contradictionResolutionOverTime(),
    await procedureReuseOverTime(),
    await forensicRollbackAndVersioning(),
    await trustTieredWriteProvenance(),
    await confidenceAnnealing(),
    await principalHistoryAccessScope(),
    await poisoningLifecycle(),
  ];
}

export async function runExperienceHorizonGym(): Promise<MemoryGymExperienceHorizonReport> {
  const scenarios = await runExperienceHorizonOnce();
  const replayed = await runExperienceHorizonOnce();
  const deterministicReplayPass = JSON.stringify(scenarios) === JSON.stringify(replayed);
  const counters = mergeCounters(scenarios);
  return {
    schema: "gmos.experience_horizon.v1",
    pass: deterministicReplayPass && scenarios.every((scenario) => scenario.pass),
    deterministicReplayPass,
    scenarios,
    counters,
  };
}

export type { MemoryGymExperienceHorizonReport };
