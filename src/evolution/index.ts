export interface EvolutionControlPlane {
  mode: "report_only";
  autoApply: false;
  autoRollout: false;
}

export function createEvolutionControlPlane(): EvolutionControlPlane {
  return {
    mode: "report_only",
    autoApply: false,
    autoRollout: false,
  };
}

