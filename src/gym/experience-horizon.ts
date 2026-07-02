import { createMemoryOS } from "../runtime/create-memory-os.js";
import { createSqliteMemoryStore } from "../store/sqlite/index.js";
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

    const forgotten = await memory.forget({
      query: "ForgettableSubjectResidue",
      reason: "experience horizon forget compliance",
    });
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
    const surfaceResidues = {
      prepareTurnResidue: containsAny(prepared.contextBlock, forgottenTerms) ? 1 : 0,
      reconstructContextResidue: containsAny(reconstructed.contextBlock, forgottenTerms) ? 1 : 0,
      searchContextResidue: containsAny(contextSearch, forgottenTerms) ? 1 : 0,
      searchHistoryResidue: containsAny(historySearch, forgottenTerms) ? 1 : 0,
      explainTurnResidue: containsAny(
        { included: explanation.included, excluded: explanation.excluded },
        forgottenTerms,
      ) ? 1 : 0,
      lifecycleHistoryResidue: containsAny(unrelatedExplanation?.lifecycle, forgottenTerms) ? 1 : 0,
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
        all_checked_surfaces_residue_free: surfaceResidue === 0,
        derived_indexes_residue_free: indexResidueFree,
      },
      counters: {
        forgettingSurfacesChecked: 9,
        forgettingResidueSurfaces: surfaceResidue,
        forgottenMemoryCount: forgotten.archivedMemoryIds.length,
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

async function runExperienceHorizonOnce(): Promise<MemoryGymExperienceHorizonScenario[]> {
  return [
    await preferenceAdherenceOverTime(),
    await forgettingComplianceFullSurface(),
    await contradictionResolutionOverTime(),
    await procedureReuseOverTime(),
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
