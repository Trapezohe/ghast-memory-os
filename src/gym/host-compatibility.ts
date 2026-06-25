import {
  createPresetHostAdapter,
  type HostActualCompatibilityReport,
  type HostAdapter,
  type HostCompatibilityLevel,
  type HostCompatibilityReport,
  type HostPreset,
} from "../host/index.js";
import { createMemoryMcpServer } from "../mcp/index.js";
import { createMemoryOS } from "../runtime/create-memory-os.js";
import { createSqliteMemoryStore } from "../store/sqlite/index.js";
import type { MemoryGymStatus } from "./types.js";

export type HostCompatibilityProbeArea =
  | "static_contract"
  | "agent_memory_use"
  | "memory_to_action"
  | "forget_residue"
  | "privacy"
  | "evidence"
  | "mcp_boundary";

export type HostCompatibilityProbeStatus =
  | "pass"
  | "fail"
  | "not_applicable";

export interface HostCompatibilityProbeResult {
  name: string;
  area: HostCompatibilityProbeArea;
  status: HostCompatibilityProbeStatus;
  detail: string;
}

export interface HostCompatibilityGymHostResult {
  hostId: HostPreset;
  displayName: string;
  pass: boolean;
  verificationMode: "preset_contract" | "actual_host_report";
  expectedLevel: HostCompatibilityLevel;
  level: HostCompatibilityLevel;
  presetLevel: HostCompatibilityLevel;
  actualReport?: HostActualCompatibilityReport | undefined;
  score: number;
  capabilityRetention: string;
  gaps: string[];
  hardGateCoverage: Record<string, boolean>;
  memoryToAction: MemoryGymStatus;
  forgetResidue: MemoryGymStatus;
  agentMemoryUse: MemoryGymStatus;
  compatibility: HostCompatibilityReport;
  probes: HostCompatibilityProbeResult[];
}

export interface HostCompatibilityGymResult {
  framework: "gmos-host-compatibility-gym";
  pass: boolean;
  startedAt: string;
  node: string;
  platform: string;
  hostCount: number;
  unmatchedActualReportHostIds: string[];
  hosts: HostCompatibilityGymHostResult[];
  failures: string[];
}

export interface RunHostCompatibilityGymOptions {
  hosts?: HostPreset[] | undefined;
  actualReports?: HostActualCompatibilityReport[] | undefined;
}

const DEFAULT_HOSTS: HostPreset[] = ["ghast", "mock_l3", "mcp", "search_only"];

const EXPECTED_LEVELS: Record<HostPreset, HostCompatibilityLevel> = {
  ghast: "L4",
  mock_l3: "L3",
  mcp: "L2",
  search_only: "L1",
};

const LEVEL_RANK: Record<HostCompatibilityLevel, number> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
};

function profileId(host: HostPreset): string {
  return `host_gym_${host}`;
}

function addProbe(
  probes: HostCompatibilityProbeResult[],
  name: string,
  area: HostCompatibilityProbeArea,
  status: HostCompatibilityProbeStatus,
  detail: string,
): void {
  probes.push({ name, area, status, detail });
}

function areaStatus(
  probes: HostCompatibilityProbeResult[],
  area: HostCompatibilityProbeArea,
): MemoryGymStatus {
  const scoped = probes.filter((probe) => probe.area === area);
  const applicable = scoped.filter((probe) => probe.status !== "not_applicable");
  if (applicable.length === 0) return "not_run";
  return applicable.every((probe) => probe.status === "pass") ? "pass" : "fail";
}

function normalizeActualHostId(hostId: string): HostPreset | null {
  if (hostId === "ghast" || hostId === "ghast_desktop") return "ghast";
  if (hostId === "mcp") return "mcp";
  if (hostId === "mock_l3") return "mock_l3";
  if (hostId === "search_only") return "search_only";
  return null;
}

function actualReportMap(reports: HostActualCompatibilityReport[] | undefined): {
  reportsByHost: Map<HostPreset, HostActualCompatibilityReport>;
  unmatchedHostIds: string[];
} {
  const map = new Map<HostPreset, HostActualCompatibilityReport>();
  const unmatchedHostIds: string[] = [];
  for (const report of reports ?? []) {
    const host = normalizeActualHostId(report.hostId);
    if (host) {
      map.set(host, report);
    } else {
      unmatchedHostIds.push(report.hostId);
    }
  }
  return { reportsByHost: map, unmatchedHostIds };
}

function actualReportMeetsExpectedLevel(input: {
  report: HostActualCompatibilityReport;
  expectedLevel: HostCompatibilityLevel;
}): boolean {
  const levelPass =
    LEVEL_RANK[input.report.level] >= LEVEL_RANK[input.expectedLevel];
  const targetClaimPass = input.report.canClaimTargetLevel !== false;
  return levelPass && targetClaimPass;
}

async function runHost(
  adapter: HostAdapter,
  actualReport?: HostActualCompatibilityReport | undefined,
): Promise<HostCompatibilityGymHostResult> {
  const host = adapter.hostId as HostPreset;
  const expectedLevel = EXPECTED_LEVELS[host];
  const probes: HostCompatibilityProbeResult[] = [];
  const capabilities = adapter.capabilities;
  const id = profileId(host);
  const store = createSqliteMemoryStore({ path: ":memory:" });
  const memory = createMemoryOS({ profileId: id, store });
  const verificationMode = actualReport ? "actual_host_report" : "preset_contract";
  const effectiveLevel = actualReport?.level ?? adapter.compatibility.level;

  addProbe(
    probes,
    "expected_compatibility_level",
    "static_contract",
    adapter.compatibility.level === expectedLevel ? "pass" : "fail",
    `expected ${expectedLevel}, got ${adapter.compatibility.level}`,
  );
  if (actualReport) {
    const actualPass = actualReportMeetsExpectedLevel({
      report: actualReport,
      expectedLevel,
    });
    addProbe(
      probes,
      "actual_host_report_level",
      "static_contract",
      actualPass ? "pass" : "fail",
      actualPass
        ? `actual ${actualReport.level} can claim ${expectedLevel}`
        : `actual ${actualReport.level} cannot claim ${expectedLevel}: ${(actualReport.blockingGaps ?? []).join("; ") || "no blocking gaps provided"}`,
    );
  }

  try {
    if (
      capabilities.canObserveConversation &&
      capabilities.canInjectSystemContext
    ) {
      await memory.observe({
        type: "conversation.message",
        profileId: id,
        role: "user",
        content: "我偏好先讲风险再给方案。",
        createdAt: "2026-06-25T00:00:00.000Z",
      });
      const prepared = await memory.prepareTurn({
        profileId: id,
        messages: [{ role: "user", content: "方案沟通偏好是什么？" }],
        includeEvidence: capabilities.supportsEvidenceInContext,
      });
      addProbe(
        probes,
        "preference_memory_use",
        "agent_memory_use",
        prepared.contextBlock.includes("先讲风险") ? "pass" : "fail",
        "conversation observation plus context injection should recall a user preference",
      );
      addProbe(
        probes,
        "sensitive_prompt_exclusion",
        "privacy",
        !prepared.contextBlock.includes("123-45-6789") ? "pass" : "fail",
        "ordinary context should not include unrelated sensitive content",
      );
      if (capabilities.supportsEvidenceInContext) {
        addProbe(
          probes,
          "evidence_context",
          "evidence",
          prepared.evidence.length > 0 ? "pass" : "fail",
          "evidence-aware hosts should receive support evidence when requested",
        );
      } else {
        addProbe(
          probes,
          "evidence_context",
          "evidence",
          "not_applicable",
          "host does not claim evidence-aware context",
        );
      }
    } else {
      addProbe(
        probes,
        "preference_memory_use",
        "agent_memory_use",
        "not_applicable",
        "host cannot both observe conversation and inject context",
      );
      addProbe(
        probes,
        "evidence_context",
        "evidence",
        "not_applicable",
        "host cannot receive full memory context",
      );
    }

    if (
      capabilities.canObserveConversation &&
      capabilities.canInjectSystemContext
    ) {
      await memory.observe({
        type: "conversation.message",
        profileId: id,
        role: "user",
        content: "api key: sk-hostgymsecret1234567890 不要泄漏。",
        createdAt: "2026-06-25T00:01:00.000Z",
      });
      const secret = await memory.prepareTurn({
        profileId: id,
        messages: [{ role: "user", content: "api key 是什么？" }],
        includeEvidence: capabilities.supportsEvidenceInContext,
        includeSensitive: true,
      });
      addProbe(
        probes,
        "secret_like_exclusion",
        "privacy",
        !JSON.stringify(secret).includes("sk-hostgymsecret") ? "pass" : "fail",
        "secret-like content must not be persisted or injected even when sensitive context is requested",
      );
    }

    if (capabilities.supportsPrivateMode) {
      await memory.observe({
        type: "conversation.message",
        profileId: id,
        role: "user",
        content: "我的临时内部代号是 Incognito-Host-Gym。",
        privacyMode: "incognito",
        createdAt: "2026-06-25T00:02:00.000Z",
      });
      const incognito = await memory.prepareTurn({
        profileId: id,
        messages: [{ role: "user", content: "临时代号是什么？" }],
      });
      addProbe(
        probes,
        "incognito_exclusion",
        "privacy",
        !incognito.contextBlock.includes("Incognito-Host-Gym") ? "pass" : "fail",
        "hosts that claim private mode must keep incognito events out of long-term context",
      );
    } else {
      addProbe(
        probes,
        "incognito_exclusion",
        "privacy",
        "not_applicable",
        "host does not claim private/incognito mode support",
      );
    }

    if (
      capabilities.supportsActionPolicies &&
      capabilities.canEnforceHardDirectives &&
      capabilities.canObserveConversation &&
      capabilities.canInjectSystemContext
    ) {
      await memory.observe({
        type: "conversation.message",
        profileId: id,
        role: "user",
        content: "以后不要再提醒我 Orion 项目延期。",
        createdAt: "2026-06-25T00:03:00.000Z",
      });
      const boundary = await memory.prepareTurn({
        profileId: id,
        messages: [{ role: "user", content: "Orion 项目怎么样？" }],
      });
      addProbe(
        probes,
        "do_not_push_action_policy",
        "memory_to_action",
        boundary.directives.some((directive) => directive.includes("Orion 项目延期"))
          ? "pass"
          : "fail",
        "full-action hosts should turn boundaries into enforceable directives",
      );
    } else {
      addProbe(
        probes,
        "do_not_push_action_policy",
        "memory_to_action",
        "not_applicable",
        "host does not claim both action policies and hard directive enforcement",
      );
    }

    if (
      capabilities.canForget &&
      capabilities.canObserveConversation &&
      capabilities.canInjectSystemContext
    ) {
      await memory.observe({
        type: "conversation.message",
        profileId: id,
        role: "user",
        content: "我在 Atlas 项目负责发布管理。",
        createdAt: "2026-06-25T00:04:00.000Z",
      });
      const forgot = await memory.forget({
        profileId: id,
        query: "Atlas",
        reason: "host compatibility gym",
      });
      const afterForget = await memory.prepareTurn({
        profileId: id,
        messages: [{ role: "user", content: "Atlas 项目我负责什么？" }],
      });
      addProbe(
        probes,
        "forget_residue",
        "forget_residue",
        forgot.archivedMemoryIds.length > 0 &&
          !afterForget.contextBlock.includes("Atlas")
          ? "pass"
          : "fail",
        "forget-capable hosts must remove matching memory from future context",
      );
    } else {
      addProbe(
        probes,
        "forget_residue",
        "forget_residue",
        "not_applicable",
        "host cannot exercise end-to-end forget residue without observe, context, and forget hooks",
      );
    }

    if (host === "mcp") {
      const mcp = createMemoryMcpServer(memory);
      const prepareTool = mcp
        .listTools()
        .find((tool) => tool.name === "memory.prepare_context");
      const sensitiveOverride = await mcp.callTool("memory.prepare_context", {
        profileId: id,
        text: "api key 是什么？",
        includeSensitive: true,
      });
      addProbe(
        probes,
        "mcp_sensitive_override_rejected",
        "mcp_boundary",
        !Object.hasOwn(prepareTool?.inputSchema.properties ?? {}, "includeSensitive") &&
          sensitiveOverride.isError === true &&
          !JSON.stringify(sensitiveOverride.structuredContent).includes("sk-hostgymsecret")
          ? "pass"
          : "fail",
        "public MCP prepare_context must not expose includeSensitive override",
      );
    } else {
      addProbe(
        probes,
        "mcp_sensitive_override_rejected",
        "mcp_boundary",
        "not_applicable",
        "host preset is not MCP",
      );
    }
  } finally {
    await memory.close();
  }

  const failures = probes.filter((probe) => probe.status === "fail");
  return {
    hostId: host,
    displayName: adapter.displayName ?? adapter.hostId,
    pass: failures.length === 0,
    verificationMode,
    expectedLevel,
    level: effectiveLevel,
    presetLevel: adapter.compatibility.level,
    actualReport,
    score: adapter.compatibility.score,
    capabilityRetention: adapter.compatibility.capabilityRetention,
    gaps: actualReport?.blockingGaps ?? adapter.compatibility.gaps,
    hardGateCoverage: adapter.compatibility.hardGateCoverage,
    memoryToAction: areaStatus(probes, "memory_to_action"),
    forgetResidue: areaStatus(probes, "forget_residue"),
    agentMemoryUse: areaStatus(probes, "agent_memory_use"),
    compatibility: adapter.compatibility,
    probes,
  };
}

export async function runHostCompatibilityGym(
  options: RunHostCompatibilityGymOptions = {},
): Promise<HostCompatibilityGymResult> {
  const hosts = options.hosts?.length ? options.hosts : DEFAULT_HOSTS;
  const selectedHosts = new Set(hosts);
  const actualReports = actualReportMap(options.actualReports);
  const unconsumedActualReportHostIds = Array.from(actualReports.reportsByHost.keys())
    .filter((host) => !selectedHosts.has(host));
  const unmatchedActualReportHostIds = [
    ...actualReports.unmatchedHostIds,
    ...unconsumedActualReportHostIds,
  ];
  const results: HostCompatibilityGymHostResult[] = [];
  for (const host of hosts) {
    results.push(
      await runHost(createPresetHostAdapter(host), actualReports.reportsByHost.get(host)),
    );
  }
  const failures = [
    ...unmatchedActualReportHostIds.map(
      (hostId) => `actual_report_unmatched:${hostId}`,
    ),
    ...results.flatMap((host) =>
      host.probes
        .filter((probe) => probe.status === "fail")
        .map((probe) => `${host.hostId}:${probe.name}:${probe.detail}`),
    ),
  ];
  return {
    framework: "gmos-host-compatibility-gym",
    pass: results.every((host) => host.pass) && unmatchedActualReportHostIds.length === 0,
    startedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    hostCount: results.length,
    unmatchedActualReportHostIds,
    hosts: results,
    failures,
  };
}
