import { createRequire } from "node:module";
import path from "node:path";

export interface GmosPackageInfo {
  name: string;
  version: string;
}

export interface GmosPackageManifest {
  name?: unknown;
  version?: unknown;
  bin?: unknown;
  exports?: unknown;
}

export const DEFAULT_GMOS_PACKAGE_INFO: GmosPackageInfo = {
  name: "@ghast/memory",
  version: "0.0.0-development",
};

export const DEFAULT_GMOS_CLI_BINARIES = ["gmos", "ghast-memory"];

export function readGmosPackageManifest(): GmosPackageManifest | null {
  try {
    const require = createRequire(import.meta.url);
    return require("../../package.json") as GmosPackageManifest;
  } catch {
    return null;
  }
}

export function readGmosPackageInfo(): GmosPackageInfo {
  const parsed = readGmosPackageManifest();
  if (
    parsed?.name === DEFAULT_GMOS_PACKAGE_INFO.name &&
    typeof parsed.version === "string" &&
    parsed.version.length > 0
  ) {
    return {
      name: parsed.name,
      version: parsed.version,
    };
  }
  return DEFAULT_GMOS_PACKAGE_INFO;
}

export function readGmosPackageRoot(): string | null {
  try {
    const require = createRequire(import.meta.url);
    return path.dirname(require.resolve("../../package.json"));
  } catch {
    return null;
  }
}

function publicStringKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).filter((key) => key.length > 0).sort();
}

export function publicCommandNameFromPackageName(packageName: string): string {
  const trimmed = packageName.trim();
  if (!trimmed) return "";
  const parts = trimmed.split("/").filter(Boolean);
  return parts.at(-1) ?? "";
}

export function publicCliBinariesFromManifest(
  manifest: GmosPackageManifest | null,
  fallback: readonly string[] = DEFAULT_GMOS_CLI_BINARIES,
): string[] {
  const objectBinNames = publicStringKeys(manifest?.bin);
  if (objectBinNames.length > 0) return objectBinNames;
  if (typeof manifest?.bin === "string" && manifest.bin.trim().length > 0) {
    const packageName = typeof manifest.name === "string" ? manifest.name : "";
    const commandName = publicCommandNameFromPackageName(packageName);
    if (commandName) return [commandName];
  }
  return [...fallback];
}

export function publicPackageExportsFromManifest(manifest: GmosPackageManifest | null): string[] {
  const objectExportKeys = publicStringKeys(manifest?.exports);
  if (objectExportKeys.length > 0) return objectExportKeys;
  if (typeof manifest?.exports === "string" && manifest.exports.trim().length > 0) {
    return ["."];
  }
  return [];
}
