import { AsyncLocalStorage } from "node:async_hooks";
import APP_HTML from "./app.html";
import { handleStore, runAllSavedSearches } from "./store.js";
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
async function rawFetch(input: any, init?: any): Promise<Response> {
  if (init?.redirect === "error") {
    const res = await nativeFetch(input, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      throw new TypeError("fetch failed: unexpected redirect (redirect: error)");
    }
    return res;
  }
  return nativeFetch(input, init);
}

// ── Upstream response cache (Workers KV) ────────────────────────────────
// Only successful (HTTP 200) text/JSON responses are stored, so outages, 429s and
// schema errors are never cached and still surface as errors. Keys are SHA-256
// hashes, so API keys that ride in URLs/bodies are never stored. Per-tool-call
// stats are carried in AsyncLocalStorage and reported in the result's _meta.cache.
interface CacheStore {
  kv: KVNamespace;
  ctx: ExecutionContext;
  hits: number;
  misses: number;
  oldestAgeSeconds: number;
}
interface CachedEntry {
  body: string;
  contentType: string;
  storedAt: number;
  /** Final URL after redirects (tools check it against an allowlisted host). */
  finalUrl?: string;
}
const cacheALS = new AsyncLocalStorage<CacheStore>();

const LIVE_HOSTS = new Set(["api.weather.gov", "bwt.cbp.gov"]); // never cached
const REFERENCE_HOSTS = /(^|\.)(ecfr\.gov|federalregister\.gov|acquisition\.gov|nist\.gov|usitc\.gov)$/;
function ttlSeconds(host: string): number {
  if (LIVE_HOSTS.has(host)) return 0;
  if (REFERENCE_HOSTS.test(host)) return 3600; // slow-changing reference data
  return 600; // everything else: 10 minutes
}
const CACHEABLE_TYPE = /json|text|xml|csv/i;
const MAX_CACHED_CHARS = 1_000_000;

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

globalThis.fetch = (async (input: any, init?: any) => {
  const store = cacheALS.getStore();
  if (!store) return rawFetch(input, init);

  const url = typeof input === "string" ? input : input instanceof URL ? input.href : null;
  const method = String(init?.method ?? "GET").toUpperCase();
  const body = init?.body;
  if (!url || (method !== "GET" && method !== "POST")) return rawFetch(input, init);
  if (body !== undefined && body !== null && typeof body !== "string") return rawFetch(input, init);

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return rawFetch(input, init);
  }
  const ttl = ttlSeconds(host);
  if (ttl === 0) return rawFetch(input, init);

  const key = "v2:" + (await sha256Hex(`${method} ${url} ${body ?? ""}`));
  try {
    const hit = await store.kv.get<CachedEntry>(key, "json");
    if (hit && typeof hit.body === "string") {
      store.hits++;
      store.oldestAgeSeconds = Math.max(
        store.oldestAgeSeconds,
        Math.round((Date.now() - hit.storedAt) / 1000),
      );
      const cached = new Response(hit.body, {
        status: 200,
        headers: { "content-type": hit.contentType, "x-mcp-cache": "HIT" },
      });
      // Some tools verify res.url (SSRF guard on the final host); a constructed Response has none.
      Object.defineProperty(cached, "url", { value: hit.finalUrl || url });
      return cached;
    }
  } catch {
    // KV read failed: fall through to a live fetch.
  }

  const res = await rawFetch(input, init);
  store.misses++;
  if (res.status === 200 && CACHEABLE_TYPE.test(res.headers.get("content-type") ?? "")) {
    try {
      const text = await res.clone().text();
      if (text.length <= MAX_CACHED_CHARS) {
        const entry: CachedEntry = {
          body: text,
          contentType: res.headers.get("content-type") ?? "application/json",
          storedAt: Date.now(),
          finalUrl: res.url || url,
        };
        // Best-effort write (e.g. the free plan's daily KV write cap can reject it).
        store.ctx.waitUntil(
          store.kv.put(key, JSON.stringify(entry), { expirationTtl: ttl }).catch(() => {}),
        );
      }
    } catch {
      // Could not read the body for caching: ignore, the caller still has the response.
    }
  }
  return res;
}) as typeof fetch;

interface Env {
  /** Bearer token agents must present. Set with `wrangler secret put MCP_AUTH_TOKEN`. */
  MCP_AUTH_TOKEN: string;
  /** Optional: unlocks the SAM.gov tools that need a key. */
  SAM_GOV_API_KEY?: string;
  /** Optional default toolset profile (comma-separated), e.g. "core,vetting". Unset = all tools. */
  MCP_SAM_GOV_TOOLSETS?: string;
  /** KV namespace for the upstream response cache. Unset = no caching. */
  CACHE?: KVNamespace;
  DB?: D1Database;
}

const DATA_MAP_URI = "samgov://data-map/state-local";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

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

/** Run one tool and return the {ok,data,_meta} / {ok:false,error} envelope (shared by /mcp and /api). */
async function runEnvelope(
  sam: any,
  name: string,
  args: unknown,
  cacheCfg: { kv: KVNamespace; ctx: ExecutionContext } | undefined,
): Promise<{ envelope: Record<string, unknown>; isError: boolean }> {
  const store: CacheStore | undefined = cacheCfg
    ? { ...cacheCfg, hits: 0, misses: 0, oldestAgeSeconds: 0 }
    : undefined;
  const exec = async () => {
    try {
      const raw = await runTool(name, (args ?? {}) as Record<string, unknown>, sam);
      const data = isMetaBundle(raw) ? raw.data : raw;
      const baseMeta = isMetaBundle(raw) ? buildMeta(raw.meta) : buildMeta({});
      const _meta = store
        ? {
            ...baseMeta,
            cache: {
              hits: store.hits,
              misses: store.misses,
              servedFromCache: store.hits > 0,
              ...(store.hits > 0
                ? {
                    oldestCachedAgeSeconds: store.oldestAgeSeconds,
                    note: "Some upstream data came from a short-lived cache (10-60 min depending on source). Add ?cache=off to the MCP URL for live data.",
                  }
                : {}),
            },
          }
        : baseMeta;
      return { envelope: { ok: true, data, _meta }, isError: false };
    } catch (err) {
      return { envelope: { ok: false, error: toToolError(err, name) }, isError: true };
    }
  };
  return store ? cacheALS.run(store, exec) : exec();
}

function buildServer(
  env: Env,
  toolsetParam: string | null,
  cacheCfg: { kv: KVNamespace; ctx: ExecutionContext } | undefined,
): Server {
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
    const { envelope, isError } = await runEnvelope(sam, name, args, cacheCfg);
    return {
      content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
      ...(isError ? { isError: true } : {}),
    };
  });

  return server;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response("ok");
    }

    if (url.pathname === "/app" || url.pathname === "/app/") {
      // The page itself holds no data and no secrets; it asks for the token in the browser.
      return new Response(APP_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-robots-tag": "noindex, nofollow",
          "referrer-policy": "no-referrer",
        },
      });
    }

    if (url.pathname === "/api/tools" || url.pathname === "/api/tool") {
      if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
      if (url.pathname === "/api/tools") {
        return json({
          tools: TOOLS.map((t: any) => ({
            name: t.name,
            description: t.description,
            inputSchema: zodToJsonSchema(t.inputSchema),
          })),
        });
      }
      if (req.method !== "POST") return json({ error: "POST required" }, 405);
      let body: any;
      try {
        body = await req.json();
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      const name = typeof body?.name === "string" ? body.name : "";
      if (!TOOLS.some((t: any) => t.name === name)) return json({ error: `unknown tool '${name}'` }, 404);
      const cache =
        env.CACHE && url.searchParams.get("cache") !== "off" ? { kv: env.CACHE, ctx } : undefined;
      const sam = new SamGovClient({ apiKey: env.SAM_GOV_API_KEY?.trim() || undefined });
      const { envelope } = await runEnvelope(sam, name, body?.args, cache);
      return json(envelope, 200);
    }

    if (url.pathname.startsWith("/api/store")) {
      if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
      const sam = new SamGovClient({ apiKey: env.SAM_GOV_API_KEY?.trim() || undefined });
      const cache = env.CACHE ? { kv: env.CACHE, ctx } : undefined;
      return handleStore(req, url, env.DB, async (name, args) => (await runEnvelope(sam, name, args, cache)).envelope);
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
    const cacheCfg =
      env.CACHE && url.searchParams.get("cache") !== "off"
        ? { kv: env.CACHE, ctx }
        : undefined;
    const server = buildServer(env, url.searchParams.get("toolsets"), cacheCfg);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(req);
  },

  // Daily cron: refresh saved searches so new notices are flagged in the dashboard.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.DB) return;
    const sam = new SamGovClient({ apiKey: env.SAM_GOV_API_KEY?.trim() || undefined });
    const cache = env.CACHE ? { kv: env.CACHE, ctx } : undefined;
    ctx.waitUntil(
      runAllSavedSearches(env.DB, async (name, args) => (await runEnvelope(sam, name, args, cache)).envelope),
    );
  },
};
