import type {
  FailureEventRecord,
  FailureKind,
  ListFailuresInput,
  MemoryStore,
  ReadAuditSnapshot,
  SearchIndexStatus,
} from "../kernel/types.js";
import {
  classifyHostCompatibility,
  createPresetHostAdapter,
  type HostCapabilities,
  type HostCompatibilityReport,
  type HostPreset,
} from "../host/index.js";
import { readGmosPackageInfo } from "../kernel/package-info.js";
import { getGmosRuntimeInfo, type GmosRuntimeInfo } from "../runtime-info.js";

export interface DiagnosticsStore {
  rowCounts(): Promise<Record<string, number>> | Record<string, number>;
  readAuditSnapshot?(): Promise<ReadAuditSnapshot> | ReadAuditSnapshot;
  schemaVersion?(): Promise<number> | number;
  searchIndexStatus?(): Promise<SearchIndexStatus> | SearchIndexStatus;
  listFailures?(input: ListFailuresInput): Promise<FailureEventRecord[]> | FailureEventRecord[];
}

export interface MemoryStatusReportInput {
  store: DiagnosticsStore;
  profileId?: string | undefined;
  host?:
    | HostPreset
    | {
        hostId: string;
        capabilities?: Partial<HostCapabilities> | undefined;
      }
    | undefined;
  packageInfo?: {
    name: string;
    version: string;
  } | undefined;
  failureLimit?: number | undefined;
  now?: (() => string) | undefined;
}

export interface MemoryStorageStatus {
  status: "ok" | "unavailable";
  schemaVersion: number | null;
  rowCounts: Record<string, number>;
  readAudit: MemoryReadAuditStatus;
  searchIndex?: SearchIndexStatus | undefined;
  error?: {
    name: string;
    code: string;
  } | undefined;
}

export interface MemoryReadAuditStatus {
  status: "ok" | "unsupported" | "unavailable";
  schema: "gmos.read_audit_snapshot.v1" | null;
  tableCount: number;
  rowCountTotal: number;
  auditedTables: string[];
  missingTables: string[];
  hashesAvailable: boolean;
  error?: {
    name: string;
    code: string;
  } | undefined;
}

export interface MemoryFailureSummary {
  status: "ok" | "unsupported" | "unavailable";
  inspectedFailureCount: number;
  byKind: Partial<Record<FailureKind, number>>;
  latestAt?: string | undefined;
  error?: {
    name: string;
    code: string;
  } | undefined;
}

export interface MemoryStatusReport {
  framework: "ghast-memory-os";
  generatedAt: string;
  profileId: string;
  package: {
    name: string;
    version: string;
  };
  runtimeInfo: GmosRuntimeInfo;
  storage: MemoryStorageStatus;
  failureSummary: MemoryFailureSummary;
  hostCompatibility?: HostCompatibilityReport | undefined;
  trustContract: {
    encrypted: false;
    reportContainsMemoryContent: false;
    readPathSideEffectsChecked: boolean;
  };
}

function errorInfo(_error: unknown): { name: string; code: string } {
  return {
    name: "DiagnosticsStoreUnavailable",
    code: "diagnostics_store_unavailable",
  };
}

function hostCompatibility(
  input: MemoryStatusReportInput["host"],
): HostCompatibilityReport | undefined {
  if (!input) return undefined;
  if (typeof input === "string") return createPresetHostAdapter(input).compatibility;
  return classifyHostCompatibility({
    hostId: input.hostId,
    capabilities: input.capabilities,
  });
}

function summarizeFailures(events: FailureEventRecord[]): MemoryFailureSummary {
  const byKind: Partial<Record<FailureKind, number>> = {};
  let latestAt: string | undefined;
  for (const event of events) {
    byKind[event.failureKind] = (byKind[event.failureKind] ?? 0) + 1;
    if (!latestAt || event.createdAt > latestAt) latestAt = event.createdAt;
  }
  return {
    status: "ok",
    inspectedFailureCount: events.length,
    byKind,
    ...(latestAt !== undefined ? { latestAt } : {}),
  };
}

function summarizeReadAuditSnapshot(snapshot: ReadAuditSnapshot): MemoryReadAuditStatus {
  const auditedTables = Object.keys(snapshot.tables).sort();
  const entries = auditedTables
    .map((table) => [table, snapshot.tables[table]] as const)
    .filter(
      (entry): entry is readonly [string, NonNullable<(typeof entry)[1]>] =>
        entry[1] !== undefined,
    );
  const missingTables = entries
    .filter(([, table]) => table.stateHash === "missing")
    .map(([table]) => table);
  return {
    status: "ok",
    schema: snapshot.schema,
    tableCount: auditedTables.length,
    rowCountTotal: entries.reduce((sum, [, table]) => sum + table.rowCount, 0),
    auditedTables,
    missingTables,
    hashesAvailable: entries.every(([, table]) => typeof table.stateHash === "string"),
  };
}

async function readAuditStatus(store: DiagnosticsStore): Promise<MemoryReadAuditStatus> {
  if (!store.readAuditSnapshot) {
    return {
      status: "unsupported",
      schema: null,
      tableCount: 0,
      rowCountTotal: 0,
      auditedTables: [],
      missingTables: [],
      hashesAvailable: false,
    };
  }
  try {
    return summarizeReadAuditSnapshot(await store.readAuditSnapshot());
  } catch (error) {
    return {
      status: "unavailable",
      schema: null,
      tableCount: 0,
      rowCountTotal: 0,
      auditedTables: [],
      missingTables: [],
      hashesAvailable: false,
      error: errorInfo(error),
    };
  }
}

async function storageStatus(store: DiagnosticsStore): Promise<MemoryStorageStatus> {
  try {
    const schemaVersion = store.schemaVersion ? await store.schemaVersion() : null;
    const rowCounts = await store.rowCounts();
    const readAudit = await readAuditStatus(store);
    const searchIndex = store.searchIndexStatus ? await store.searchIndexStatus() : undefined;
    return {
      status: "ok",
      schemaVersion,
      rowCounts,
      readAudit,
      ...(searchIndex !== undefined ? { searchIndex } : {}),
    };
  } catch (error) {
    return {
      status: "unavailable",
      schemaVersion: null,
      rowCounts: {},
      readAudit: {
        status: "unavailable",
        schema: null,
        tableCount: 0,
        rowCountTotal: 0,
        auditedTables: [],
        missingTables: [],
        hashesAvailable: false,
        error: errorInfo(error),
      },
      error: errorInfo(error),
    };
  }
}

async function failureSummary(input: {
  store: DiagnosticsStore;
  profileId: string;
  limit: number;
  storage: MemoryStorageStatus;
}): Promise<MemoryFailureSummary> {
  if (input.storage.status !== "ok") {
    return {
      status: "unavailable",
      inspectedFailureCount: 0,
      byKind: {},
      error: input.storage.error,
    };
  }
  if (!input.store.listFailures) {
    return {
      status: "unsupported",
      inspectedFailureCount: 0,
      byKind: {},
    };
  }
  try {
    return summarizeFailures(
      await input.store.listFailures({
        profileId: input.profileId,
        limit: input.limit,
      }),
    );
  } catch (error) {
    return {
      status: "unavailable",
      inspectedFailureCount: 0,
      byKind: {},
      error: errorInfo(error),
    };
  }
}

export async function createMemoryStatusReport(
  input: MemoryStatusReportInput,
): Promise<MemoryStatusReport> {
  const profileId = input.profileId ?? "default";
  const storage = await storageStatus(input.store);
  const packageInfo = input.packageInfo ?? readGmosPackageInfo();
  const runtimeInfo: GmosRuntimeInfo = {
    ...getGmosRuntimeInfo(),
    package: packageInfo,
  };
  return {
    framework: "ghast-memory-os",
    generatedAt: input.now?.() ?? new Date().toISOString(),
    profileId,
    package: packageInfo,
    runtimeInfo,
    storage,
    failureSummary: await failureSummary({
      store: input.store,
      profileId,
      limit: Math.max(1, Math.min(input.failureLimit ?? 100, 500)),
      storage,
    }),
    hostCompatibility: hostCompatibility(input.host),
    trustContract: {
      encrypted: false,
      reportContainsMemoryContent: false,
      readPathSideEffectsChecked: storage.readAudit.status === "ok",
    },
  };
}

export function renderMemoryStatusMarkdown(report: MemoryStatusReport): string {
  const failureRows = Object.entries(report.failureSummary.byKind);
  const vectorIndex = report.storage.searchIndex?.vectorIndex;
  return [
    "# gmOS Status Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Profile: ${report.profileId}`,
    `Package: ${report.package.name}@${report.package.version}`,
    "",
    "## Runtime",
    "",
    `CLI binaries: ${report.runtimeInfo.cli.binaries.join(", ")}`,
    `Package exports: ${report.runtimeInfo.packageExports.length ? report.runtimeInfo.packageExports.join(", ") : "unknown"}`,
    `MCP tools: ${report.runtimeInfo.publicSurface.mcpTools.join(", ")}`,
    `HTTP routes: ${report.runtimeInfo.publicSurface.httpRoutes.join(", ")}`,
    `Local-first: ${report.runtimeInfo.trustContract.localFirst ? "yes" : "no"}`,
    `Default storage: ${report.runtimeInfo.trustContract.defaultStorage}`,
    `Encrypted by default: ${report.runtimeInfo.trustContract.encryptedByDefault ? "yes" : "no"}`,
    `Cloud required: ${report.runtimeInfo.trustContract.cloudRequired ? "yes" : "no"}`,
    "",
    "## Storage",
    "",
    `Status: ${report.storage.status}`,
    `Schema version: ${report.storage.schemaVersion ?? "unknown"}`,
    `Encrypted: ${report.trustContract.encrypted ? "yes" : "no"}`,
    `Read audit: ${report.storage.readAudit.status} (${report.storage.readAudit.tableCount} tables; rows=${report.storage.readAudit.rowCountTotal}; missing=${report.storage.readAudit.missingTables.length})`,
    report.storage.error
      ? `Error: ${report.storage.error.name}: ${report.storage.error.code}`
      : "",
    report.storage.readAudit.error
      ? `Read audit error: ${report.storage.readAudit.error.name}: ${report.storage.readAudit.error.code}`
      : "",
    report.storage.searchIndex
      ? `Search index: ${report.storage.searchIndex.status} (${report.storage.searchIndex.indexedMemoryCount}/${report.storage.searchIndex.totalMemoryCount} indexed; missing=${report.storage.searchIndex.missingEntryCount}; stale=${report.storage.searchIndex.staleEntryCount}; orphan=${report.storage.searchIndex.orphanEntryCount}; duplicate=${report.storage.searchIndex.duplicateEntryCount})`
      : "",
    vectorIndex
      ? `Vector index: ${vectorIndex.status} (${vectorIndex.indexedMemoryCount} indexed; missing=${vectorIndex.missingEntryCount}; stale=${vectorIndex.staleEntryCount}; orphan=${vectorIndex.orphanEntryCount}; duplicate=${vectorIndex.duplicateEntryCount}; dimensions=${vectorIndex.dimensions})`
      : "",
    "",
    "### Row Counts",
    "",
    Object.keys(report.storage.rowCounts).length === 0
      ? "No row counts available."
      : "| Table | Rows |\n| --- | ---: |\n" +
          Object.entries(report.storage.rowCounts)
            .map(([table, count]) => `| ${table} | ${count} |`)
            .join("\n"),
    "",
    "## Failure Summary",
    "",
    `Status: ${report.failureSummary.status}`,
    `Inspected failures: ${report.failureSummary.inspectedFailureCount}`,
    report.failureSummary.latestAt ? `Latest failure: ${report.failureSummary.latestAt}` : "",
    report.failureSummary.error
      ? `Error: ${report.failureSummary.error.name}: ${report.failureSummary.error.code}`
      : "",
    "",
    failureRows.length === 0
      ? "No failure counts available."
      : "| Kind | Count |\n| --- | ---: |\n" +
          failureRows.map(([kind, count]) => `| ${kind} | ${count} |`).join("\n"),
    "",
    report.hostCompatibility
      ? [
          "## Host Compatibility",
          "",
          `Host: ${report.hostCompatibility.hostId}`,
          `Level: ${report.hostCompatibility.level}`,
          `Score: ${report.hostCompatibility.score.toFixed(2)}`,
          `Capability retention: ${report.hostCompatibility.capabilityRetention}`,
          report.hostCompatibility.gaps.length === 0
            ? "Gaps: none"
            : `Gaps: ${report.hostCompatibility.gaps.join(", ")}`,
          "",
        ].join("\n")
      : "",
    "## Trust Contract",
    "",
    `Report contains memory content: ${report.trustContract.reportContainsMemoryContent ? "yes" : "no"}`,
    `Read path side effects checked: ${report.trustContract.readPathSideEffectsChecked ? "yes" : "no"}`,
    "",
  ].join("\n");
}

export type { HostCapabilities, HostCompatibilityReport, HostPreset, MemoryStore };
