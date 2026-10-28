import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  TOOLS,
  runTool,
  zodToJsonSchema,
  toolAnnotations,
} from "@cliwant/mcp-sam-gov";
import { SamGovClient } from "@cliwant/mcp-sam-gov/sam-gov";
// Deep imports are blocked by the package exports map, so use relative paths.
// @ts-ignore
import { buildMeta, isMetaBundle } from "../node_modules/@cliwant/mcp-sam-gov/dist/meta.js";
// @ts-ignore
import { toToolError } from "../node_modules/@cliwant/mcp-sam-gov/dist/errors.js";
// @ts-ignore
import {
  resolveToolsets,
  filterToolsFor,
  toolNotLoadedEnvelope,
  ALL_TOOLSET_NAMES,
  TOOLSET_HINTS,
} from "../node_modules/@cliwant/mcp-sam-gov/dist/toolsets.js";
// @ts-ignore
import { renderDataMapMarkdown } from "../node_modules/@cliwant/mcp-sam-gov/dist/data-map.js";

// Workers' fetch rejects `redirect: "error"`, which many tools in the package use
// as an SSRF guard. Keep the same guarantee: request "manual" and throw on any 3xx.
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: any, init?: any) => {
  if (init?.redirect === "error") {
    const res = await nativeFetch(input, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      throw new TypeError("fetch failed: unexpected redirect (redirect: error)");
    }
    return res;
  }
  return nativeFetch(input, init);
}) as typeof fetch;

interface Env {
  /** Bearer token agents must present. Set with `wrangler secret put MCP_AUTH_TOKEN`. */
  MCP_AUTH_TOKEN: string;
  /** Optional: unlocks the SAM.gov tools that need a key. */
  SAM_GOV_API_KEY?: string;
  /** Optional default toolset profile (comma-separated), e.g. "core,vetting". Unset = all tools. */
  MCP_SAM_GOV_TOOLSETS?: string;
}

const DATA_MAP_URI = "samgov://data-map/state-local";

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  // Compare against the longer length so length differences don't short-circuit.
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function authorized(req: Request, env: Env): boolean {
  if (!env.MCP_AUTH_TOKEN) return false; // fail closed if the secret isn't set
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return !!m && timingSafeEqual(m[1].trim(), env.MCP_AUTH_TOKEN);
}

function buildServer(env: Env, toolsetParam: string | null): Server {
  // Profile precedence: ?toolsets= on the URL, then the Worker default, then all tools.
  const toolsetSpec = toolsetParam ?? env.MCP_SAM_GOV_TOOLSETS;
  const allNames = TOOLS.map((t: any) => t.name);
  const ts = resolveToolsets(toolsetSpec, allNames);
  const loaded: Set<string> = ts.loaded;
  const isAll = ts.sets.length === 1 && ts.sets[0] === "all";

  const notes: string[] = [];
  if (!isAll) {
    notes.push(
      `Loaded toolsets: ${ts.sets.join(", ")} (${loaded.size}/${TOOLS.length} tools). ` +
        `Other toolsets: ${ALL_TOOLSET_NAMES.filter((n: string) => !ts.sets.includes(n))
          .map((n: string) => `${n} (${(TOOLSET_HINTS as Record<string, string>)[n]})`)
          .join("; ")}.`,
    );
  }
  for (const u of ts.unknown) {
    notes.push(`Unknown toolset '${u}' ignored; valid: ${ALL_TOOLSET_NAMES.join(", ")}.`);
  }
  if (ts.fellBack) notes.push("No valid toolset names given; all tools loaded.");

  const sam = new SamGovClient({
    apiKey: env.SAM_GOV_API_KEY?.trim() || undefined,
  });

  const server = new Server(
    { name: "mcp-sam-gov", version: "1.17.0" },
    {
      capabilities: { tools: {}, resources: {} },
      ...(notes.length ? { instructions: notes.join(" ") } : {}),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: filterToolsFor(TOOLS, loaded).map((t: any) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
      annotations: toolAnnotations(t.name),
    })),
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: DATA_MAP_URI,
        name: "State & local data map",
        description:
          "Jurisdiction → verified tool call → row count for every allowlisted state/local dataset.",
        mimeType: "text/markdown",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    if (req.params.uri !== DATA_MAP_URI) {
      throw new Error(`Unknown resource: ${req.params.uri}`);
    }
    return {
      contents: [
        {
          uri: DATA_MAP_URI,
          mimeType: "text/markdown",
          text: renderDataMapMarkdown(),
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (TOOLS.some((t: any) => t.name === name) && !loaded.has(name)) {
      return {
        content: [
          { type: "text", text: JSON.stringify(toolNotLoadedEnvelope(name, ts.sets), null, 2) },
        ],
        isError: true,
      };
    }
    try {
      const raw = await runTool(name, (args ?? {}) as Record<string, unknown>, sam);
      const data = isMetaBundle(raw) ? raw.data : raw;
      const _meta = isMetaBundle(raw) ? buildMeta(raw.meta) : buildMeta({});
      return {
        content: [
          { type: "text", text: JSON.stringify({ ok: true, data, _meta }, null, 2) },
        ],
      };
    } catch (err) {
      const error = toToolError(err, name);
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error }, null, 2) }],
        isError: true,
      };
    }
  });

  return server;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response("ok");
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }

    if (!authorized(req, env)) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: {
          "content-type": "application/json",
          "www-authenticate": 'Bearer realm="mcp-sam-gov"',
        },
      });
    }

    // Stateless: a fresh server + transport per request, no session storage.
    const server = buildServer(env, url.searchParams.get("toolsets"));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(req);
  },
};
