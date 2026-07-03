import {
  PUBLIC_MEMORY_HTTP_ROUTE_REGISTRY,
  type PublicMemoryHttpRouteEntry,
} from "../mcp/public-surface.js";
import { listMemoryMcpTools, type MemoryMcpJsonSchema } from "../mcp/tools.js";
import { readGmosPackageInfo } from "../kernel/package-info.js";

type OpenApiSchema = Record<string, unknown>;
type OpenApiDocument = Record<string, unknown>;

const ERROR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "error"],
  properties: {
    ok: { type: "boolean", enum: [false] },
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
      },
    },
  },
};

function operationId(route: string): string {
  return route
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+([a-z0-9])/gu, (_match, value: string) => value.toUpperCase());
}

function jsonResponse(description: string, schema: OpenApiSchema): OpenApiSchema {
  return {
    description,
    content: {
      "application/json": {
        schema,
      },
    },
  };
}

function requestBody(schema: MemoryMcpJsonSchema | OpenApiSchema): OpenApiSchema {
  return {
    required: true,
    content: {
      "application/json": {
        schema,
      },
    },
  };
}

function securityFor(scope: PublicMemoryHttpRouteEntry["scope"]): OpenApiSchema[] {
  return scope === "open" ? [] : [{ bearerAuth: [scope] }];
}

function toolSchema(route: PublicMemoryHttpRouteEntry): MemoryMcpJsonSchema | undefined {
  if (!("toolName" in route)) return undefined;
  return listMemoryMcpTools().find((tool) => tool.name === route.toolName)?.inputSchema;
}

function bodySchemaFor(route: PublicMemoryHttpRouteEntry): OpenApiSchema | undefined {
  const schema = toolSchema(route);
  if (schema) return { ...schema };
  if (route.route === "POST /mcp/call") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["tool"],
      properties: {
        tool: { type: "string" },
        args: { type: "object" },
      },
    };
  }
  if (route.route === "POST /profiles") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["profileId"],
      properties: {
        profileId: { type: "string" },
      },
    };
  }
  return undefined;
}

function parametersFor(route: PublicMemoryHttpRouteEntry): OpenApiSchema[] {
  if (route.route !== "GET /status") return [];
  return [
    {
      name: "profileId",
      in: "query",
      required: false,
      schema: { type: "string" },
    },
  ];
}

function successSchemaFor(route: PublicMemoryHttpRouteEntry): OpenApiSchema {
  if (route.route === "GET /health") {
    return {
      type: "object",
      required: ["ok", "framework", "status", "authRequired"],
      properties: {
        ok: { type: "boolean" },
        framework: { type: "string" },
        status: { type: "string" },
        authRequired: { type: "boolean" },
      },
    };
  }
  return {
    type: "object",
    additionalProperties: true,
    properties: {
      ok: { type: "boolean" },
    },
  };
}

function operationFor(route: PublicMemoryHttpRouteEntry): OpenApiSchema {
  const bodySchema = bodySchemaFor(route);
  return {
    operationId: operationId(route.route),
    summary: route.route,
    "x-gmos-scope": route.scope,
    security: securityFor(route.scope),
    parameters: parametersFor(route),
    ...(bodySchema ? { requestBody: requestBody(bodySchema) } : {}),
    responses: {
      "200": jsonResponse("Success", successSchemaFor(route)),
      "400": jsonResponse("Bad request", ERROR_SCHEMA),
      "401": jsonResponse("Unauthorized", ERROR_SCHEMA),
      "403": jsonResponse("Forbidden", ERROR_SCHEMA),
      "404": jsonResponse("Not found", ERROR_SCHEMA),
      "405": jsonResponse("Method not allowed", ERROR_SCHEMA),
      "413": jsonResponse("Request body too large", ERROR_SCHEMA),
      "429": jsonResponse("Rate limit exceeded", ERROR_SCHEMA),
      "500": jsonResponse("Internal server error", ERROR_SCHEMA),
    },
  };
}

export function createMemoryHttpOpenApiDocument(): OpenApiDocument {
  const packageInfo = readGmosPackageInfo();
  const paths: Record<string, Record<string, OpenApiSchema>> = {};
  for (const route of PUBLIC_MEMORY_HTTP_ROUTE_REGISTRY) {
    paths[route.pathname] ??= {};
    paths[route.pathname]![route.method.toLowerCase()] = operationFor(route);
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "gmOS Memory HTTP API",
      version: packageInfo.version,
    },
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "gmOS service API key or legacy GMOS_HTTP_AUTH_TOKEN",
          description: "Scopes: read, readwrite, admin.",
        },
      },
      schemas: {
        Error: ERROR_SCHEMA,
      },
    },
  };
}
