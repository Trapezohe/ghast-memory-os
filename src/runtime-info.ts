import {
  DEFAULT_GMOS_CLI_BINARIES,
  publicCliBinariesFromManifest,
  publicPackageExportsFromManifest,
  readGmosPackageInfo,
  readGmosPackageManifest,
  type GmosPackageInfo,
} from "./kernel/package-info.js";
import { PUBLIC_MEMORY_HTTP_ROUTES, PUBLIC_MEMORY_MCP_TOOL_NAMES } from "./mcp/public-surface.js";

export interface GmosRuntimeInfo {
  schema: "gmos.runtime_info.v1";
  package: GmosPackageInfo;
  cli: {
    binaries: string[];
  };
  packageExports: string[];
  publicSurface: {
    mcpTools: string[];
    httpRoutes: string[];
  };
  trustContract: {
    localFirst: true;
    defaultStorage: "sqlite";
    encryptedByDefault: false;
    cloudRequired: false;
  };
}

export function getGmosRuntimeInfo(): GmosRuntimeInfo {
  const manifest = readGmosPackageManifest();
  return {
    schema: "gmos.runtime_info.v1",
    package: readGmosPackageInfo(),
    cli: {
      binaries: publicCliBinariesFromManifest(manifest, DEFAULT_GMOS_CLI_BINARIES),
    },
    packageExports: publicPackageExportsFromManifest(manifest),
    publicSurface: {
      mcpTools: [...PUBLIC_MEMORY_MCP_TOOL_NAMES],
      httpRoutes: [...PUBLIC_MEMORY_HTTP_ROUTES],
    },
    trustContract: {
      localFirst: true,
      defaultStorage: "sqlite",
      encryptedByDefault: false,
      cloudRequired: false,
    },
  };
}
