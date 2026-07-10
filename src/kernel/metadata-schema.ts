export const GMOS_METADATA_REFERENCE_MARKER = "_gmosMetadataSchemas" as const;

export const GMOS_METADATA_REFERENCE_SCHEMAS = {
  runtimeLineage: "gmos.metadata.runtime_lineage.v1",
  consolidationSummary: "gmos.metadata.consolidation_summary.v1",
  dossier: "gmos.metadata.dossier.v1",
  procedureDistillation: "gmos.metadata.procedure_distillation.v1",
  consolidationTarget: "gmos.metadata.consolidation_target.v1",
  duplicateSupersession: "gmos.metadata.duplicate_supersession.v1",
  lifecycleArchive: "gmos.metadata.lifecycle_archive.v1",
  dossierSupersession: "gmos.metadata.dossier_supersession.v1",
  failureMemoryLinks: "gmos.metadata.failure_memory_links.v1",
  worldBeliefProjection: "gmos.metadata.world_belief_projection.v1",
  mem0Import: "gmos.metadata.mem0_import.v1",
  hostSnapshotImport: "gmos.metadata.host_snapshot_import.v1",
} as const;

export type GmosMetadataReferenceSchema =
  (typeof GMOS_METADATA_REFERENCE_SCHEMAS)[keyof typeof GMOS_METADATA_REFERENCE_SCHEMAS];

export interface GmosMetadataReferenceShape {
  evidenceIdFields?: readonly string[] | undefined;
  evidenceIdArrays?: readonly string[] | undefined;
  memoryIdFields?: readonly string[] | undefined;
  memoryIdArrays?: readonly string[] | undefined;
  beliefIdArrays?: readonly string[] | undefined;
  trajectoryIdArrays?: readonly string[] | undefined;
  annealingSourceEventId?: boolean | undefined;
  sourceIndexEvidenceField?: string | undefined;
  sessionKeyEvidenceField?: string | undefined;
  archiveReasonMemoryPrefixes?: readonly string[] | undefined;
}

export const GMOS_METADATA_REFERENCE_SHAPES: Readonly<
  Record<GmosMetadataReferenceSchema, GmosMetadataReferenceShape>
> = {
  [GMOS_METADATA_REFERENCE_SCHEMAS.runtimeLineage]: {
    evidenceIdFields: [
      "sourceEvidenceId",
      "turnEvidenceId",
      "sessionDistillationEvidenceId",
    ],
    evidenceIdArrays: ["windowEvidenceIds", "sessionEvidenceIds"],
    annealingSourceEventId: true,
    sourceIndexEvidenceField: "sourceEvidenceId",
    sessionKeyEvidenceField: "sessionDistillationEvidenceId",
  },
  [GMOS_METADATA_REFERENCE_SCHEMAS.consolidationSummary]: {
    memoryIdArrays: ["sourceMemoryIds"],
  },
  [GMOS_METADATA_REFERENCE_SCHEMAS.dossier]: {
    memoryIdArrays: ["sourceMemoryIds"],
    beliefIdArrays: ["sourceBeliefIds"],
  },
  [GMOS_METADATA_REFERENCE_SCHEMAS.procedureDistillation]: {
    trajectoryIdArrays: ["sourceTrajectoryIds"],
  },
  [GMOS_METADATA_REFERENCE_SCHEMAS.consolidationTarget]: {
    memoryIdFields: ["consolidatedInto"],
  },
  [GMOS_METADATA_REFERENCE_SCHEMAS.duplicateSupersession]: {
    memoryIdFields: ["supersededBy"],
  },
  [GMOS_METADATA_REFERENCE_SCHEMAS.lifecycleArchive]: {},
  [GMOS_METADATA_REFERENCE_SCHEMAS.dossierSupersession]: {
    archiveReasonMemoryPrefixes: ["dossier_superseded_by:"],
  },
  [GMOS_METADATA_REFERENCE_SCHEMAS.failureMemoryLinks]: {
    memoryIdArrays: ["relatedMemoryIds", "usedMemoryIds"],
  },
  [GMOS_METADATA_REFERENCE_SCHEMAS.worldBeliefProjection]: {},
  [GMOS_METADATA_REFERENCE_SCHEMAS.mem0Import]: {},
  [GMOS_METADATA_REFERENCE_SCHEMAS.hostSnapshotImport]: {},
};

const KNOWN_GMOS_METADATA_REFERENCE_SCHEMAS = new Set<GmosMetadataReferenceSchema>(
  Object.values(GMOS_METADATA_REFERENCE_SCHEMAS),
);

export function gmosMetadataReferenceSchemas(
  metadata: Record<string, unknown>,
): GmosMetadataReferenceSchema[] {
  const marker = metadata[GMOS_METADATA_REFERENCE_MARKER];
  if (!Array.isArray(marker)) return [];
  return [...new Set(marker.flatMap((entry) =>
    typeof entry === "string" &&
      KNOWN_GMOS_METADATA_REFERENCE_SCHEMAS.has(entry as GmosMetadataReferenceSchema)
      ? [entry as GmosMetadataReferenceSchema]
      : []
  ))];
}

export function hasGmosMetadataReferenceSchema(
  metadata: Record<string, unknown>,
  schema: GmosMetadataReferenceSchema,
): boolean {
  return gmosMetadataReferenceSchemas(metadata).includes(schema);
}

export function markedGmosMetadata(
  metadata: Record<string, unknown>,
  ...schemas: GmosMetadataReferenceSchema[]
): Record<string, unknown> {
  const existingMarker = metadata[GMOS_METADATA_REFERENCE_MARKER];
  const existing = Array.isArray(existingMarker)
    ? existingMarker.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    ...metadata,
    [GMOS_METADATA_REFERENCE_MARKER]: [...new Set([...existing, ...schemas])].sort(),
  };
}

export function withoutGmosMetadataReferenceSchemas(
  metadata: Record<string, unknown>,
  ...schemas: GmosMetadataReferenceSchema[]
): Record<string, unknown> {
  const next = { ...metadata };
  const marker = metadata[GMOS_METADATA_REFERENCE_MARKER];
  if (!Array.isArray(marker)) return next;
  const removed = new Set<string>(schemas);
  const remaining = marker.filter(
    (entry): entry is string => typeof entry === "string" && !removed.has(entry),
  );
  if (remaining.length > 0) next[GMOS_METADATA_REFERENCE_MARKER] = remaining;
  else delete next[GMOS_METADATA_REFERENCE_MARKER];
  return next;
}
