import { createRequire } from "node:module";

export interface GmosPackageInfo {
  name: string;
  version: string;
}

export const DEFAULT_GMOS_PACKAGE_INFO: GmosPackageInfo = {
  name: "@ghast/memory",
  version: "0.0.0-development",
};

export function readGmosPackageInfo(): GmosPackageInfo {
  try {
    const require = createRequire(import.meta.url);
    const parsed = require("../../package.json") as { name?: unknown; version?: unknown };
    if (
      parsed.name === DEFAULT_GMOS_PACKAGE_INFO.name &&
      typeof parsed.version === "string" &&
      parsed.version.length > 0
    ) {
      return {
        name: parsed.name,
        version: parsed.version,
      };
    }
  } catch {
    // Keep runtime adapters usable when the SDK is bundled without package.json.
  }
  return DEFAULT_GMOS_PACKAGE_INFO;
}
