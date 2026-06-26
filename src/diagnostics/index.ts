import type {
  FailureEventRecord,
  FailureKind,
  ListFailuresInput,
  MemoryStore,
} from "../kernel/types.js";
import {
  classifyHostCompatibility,
  createPresetHostAdapter,
  type HostCapabilities,
  type HostCompatibilityReport,
  type HostPreset,
} from "../host/index.js";
import { readGmosPackageInfo } from "../kernel/package-info.js";

export interface DiagnosticsStore {
  rowCounts(): Promise<Record<string, number>> | Record<string, number>;
  schemaVersion?(): Promise<number> | number;
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
  storage: MemoryStorageStatus;
  failureSummary: MemoryFailureSummary;
  hostCompatibility?: HostCompatibilityReport | undefined;
  trustContract: {
    encrypted: false;
    reportContainsMemoryContent: false;
    readPathSideEffectsChecked: false;
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

async function storageStatus(store: DiagnosticsStore): Promise<MemoryStorageStatus> {
  try {
    const schemaVersion = store.schemaVersion ? await store.schemaVersion() : null;
    const rowCounts = await store.rowCounts();
    return {
      status: "ok",
      schemaVersion,
      rowCounts,
    };
  } catch (error) {
    return {
      status: "unavailable",
      schemaVersion: null,
      rowCounts: {},
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
  return {
    framework: "ghast-memory-os",
    generatedAt: input.now?.() ?? new Date().toISOString(),
    profileId,
    package: input.packageInfo ?? readGmosPackageInfo(),
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
      readPathSideEffectsChecked: false,
    },
  };
}

export function renderMemoryStatusMarkdown(report: MemoryStatusReport): string {
  const failureRows = Object.entries(report.failureSummary.byKind);
  return [
    "# gmOS Status Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Profile: ${report.profileId}`,
    `Package: ${report.package.name}@${report.package.version}`,
    "",
    "## Storage",
    "",
    `Status: ${report.storage.status}`,
    `Schema version: ${report.storage.schemaVersion ?? "unknown"}`,
    `Encrypted: ${report.trustContract.encrypted ? "yes" : "no"}`,
    report.storage.error
      ? `Error: ${report.storage.error.name}: ${report.storage.error.code}`
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
