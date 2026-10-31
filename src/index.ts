import { AsyncLocalStorage } from "node:async_hooks";
import APP_HTML from "./app.html";
import { handleStore } from "./store.js";
import { rankTexts } from "./rank.js";
import { runDailyAlerts, collectDue, sendWebhook, digestText } from "./alerts.js";
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

// Some government hosts sit behind Cloudflare and answer HTTP 525 to requests that come from inside
// Cloudflare (i.e. this Worker), so those calls go through a relay hosted elsewhere (see relay/).
const RELAY_HOSTS = new Set(["api.usaspending.gov", "sanctionslistservice.ofac.treas.gov"]);
let relayCfg: { base: string; token: string } | undefined;

async function relayFetch(input: any, init: any): Promise<Response> {
  const mode = init?.redirect; // "follow" (default) | "manual" | "error"
  let current = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  let method = String(init?.method ?? "GET").toUpperCase();
  let body = init?.body;
  for (let hop = 0; hop < 6; hop++) {
    let res: Response;
    if (RELAY_HOSTS.has(current.hostname) && relayCfg) {
      const headers = new Headers(init?.headers);
      headers.set("x-relay-token", relayCfg.token);
      res = await nativeFetch(`${relayCfg.base}/${current.hostname}${current.pathname}${current.search}`, {
        method, headers, body, signal: init?.signal, redirect: "manual",
      });
    } else {
      res = await nativeFetch(current.href, { method, headers: init?.headers, body, signal: init?.signal, redirect: "manual" });
    }
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      if (mode === "manual") return res;
      if (mode === "error") throw new TypeError("fetch failed: unexpected redirect (redirect: error)");
      current = new URL(loc, current);
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) { method = "GET"; body = undefined; }
      continue;
    }
    // Report the real final URL: tools check it against an allowlisted host (OFAC does).
    Object.defineProperty(res, "url", { value: current.href });
    Object.defineProperty(res, "redirected", { value: hop > 0 });
    return res;
  }
  throw new TypeError("fetch failed: too many redirects");
}

async function rawFetch(input: any, init?: any): Promise<Response> {
  if (relayCfg) {
    try {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
      const h = new URL(raw).hostname;
      if (RELAY_HOSTS.has(h)) return relayFetch(input, init);
      // A direct call that redirects into a relayed host (e.g. www.treasury.gov -> sanctionslistservice).
      if (!init?.redirect || init.redirect === "follow") {
        const first = await nativeFetch(input, { ...init, redirect: "manual" });
        const loc = first.headers.get("location");
        if (first.status >= 300 && first.status < 400 && loc && RELAY_HOSTS.has(new URL(loc, raw).hostname)) {
          return relayFetch(new URL(loc, raw).href, { ...init, method: "GET", body: undefined });
        }
        if (first.status >= 300 && first.status < 400) return nativeFetch(input, init);
        return first;
      }
    } catch (e) {
      if (e instanceof TypeError && /redirect/.test(e.message)) throw e;
    }
  }
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
  if (PORTAL_HOSTS.test(host)) return 1800; // city and county bid portals change slowly, and a state scan makes hundreds of calls
  return 600; // everything else: 10 minutes
}
const PORTAL_HOSTS = /(^|\.)(bonfirehub\.com|opengov\.com)$/;
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
  GOV_RELAY_URL?: string;
  RELAY_TOKEN?: string;
  DB?: D1Database;
  /** Optional: where the daily digest is sent (Slack, Discord, n8n or ntfy URL). Set as a Secret. */
  ALERT_WEBHOOK_URL?: string;
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
    relayCfg = env.GOV_RELAY_URL && env.RELAY_TOKEN ? { base: env.GOV_RELAY_URL.replace(/\/$/, ""), token: env.RELAY_TOKEN } : undefined;

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

    if (url.pathname === "/api/diag") {
      // Reachability of the upstream APIs from this Worker (fixed list, no user-supplied URLs).
      if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
      const targets: [string, string, RequestInit?][] = [
        ["usaspending", "https://api.usaspending.gov/api/v2/references/toptier_agencies/"],
        ["usaspending-post", "https://api.usaspending.gov/api/v2/autocomplete/naics/", { method: "POST", headers: { "content-type": "application/json" }, body: '{"search_text":"computer","limit":2}' }],
        ["sam", "https://sam.gov/api/prod/sgs/v1/search/?index=opp&page=0&size=1&mode=search&q=test"],
        ["treasury", "https://www.treasury.gov/ofac/downloads/sdn.csv", { method: "HEAD" }],
        ["ofac-service", "https://sanctionslistservice.ofac.treas.gov/", { method: "HEAD" }],
      ];
      const out = await Promise.all(
        targets.map(async ([name, u, init]) => {
          const t0 = Date.now();
          try {
            const r = await rawFetch(u, { ...(init ?? {}), redirect: "manual", signal: AbortSignal.timeout(8000) });
            return { name, status: r.status, ms: Date.now() - t0, location: r.headers.get("location") };
          } catch (e: any) {
            return { name, error: String(e?.message || e), ms: Date.now() - t0 };
          }
        }),
      );
      return json({ colo: (req as any).cf?.colo, results: out });
    }

    if (url.pathname === "/api/grants/agencies") {
      // Department list for the Grants tab dropdown. Grants.gov only filters by a pipe-joined list of
      // sub-agency codes, so each department's value is built from its current sub-agencies.
      if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
      const key = "grants-agencies:v1";
      const hit = env.CACHE ? await env.CACHE.get(key, "json") : null;
      if (hit) return json(hit);
      try {
        const r = await fetch("https://api.grants.gov/v1/api/search2", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rows: 1, oppStatuses: "forecasted|posted" }),
          signal: AbortSignal.timeout(15000),
        });
        const j: any = await r.json();
        const agencies = (j?.data?.agencies ?? []).map((a: any) => ({
          label: a.label,
          value: (a.subAgencyOptions?.length ? a.subAgencyOptions.map((x: any) => x.value) : [a.value]).join("|"),
        }));
        if (!agencies.length) return json({ error: "Grants.gov returned no agency list" }, 502);
        const body = { agencies };
        if (env.CACHE) ctx.waitUntil(env.CACHE.put(key, JSON.stringify(body), { expirationTtl: 43200 }));
        return json(body);
      } catch (e: any) {
        return json({ error: "Grants.gov agency list unavailable: " + String(e?.message || e) }, 502);
      }
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

    if (url.pathname === "/api/profile") {
      // One short description of the company, used to rank notices by fit. Stored in KV so it follows you across devices.
      if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
      if (!env.CACHE) return json({ error: "KV is not set up" }, 503);
      if (req.method === "GET") return json({ profile: (await env.CACHE.get("settings:profile")) || "" });
      if (req.method === "PUT") {
        const b: any = await req.json().catch(() => ({}));
        const text = String(b.profile || "").trim().slice(0, 1500);
        if (text) await env.CACHE.put("settings:profile", text); else await env.CACHE.delete("settings:profile");
        return json({ ok: true });
      }
    }

    if (url.pathname === "/api/rank" && req.method === "POST") {
      if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
      const b: any = await req.json().catch(() => ({}));
      const profile = String(b.profile || (env.CACHE ? await env.CACHE.get("settings:profile") : "") || "").trim();
      const items: { id: string; text: string }[] = Array.isArray(b.items) ? b.items.slice(0, 300) : [];
      if (!profile) return json({ error: "Describe your company first." }, 400);
      try {
        const r = await rankTexts(items.map((i) => String(i.text || "")), profile);
        return json({ results: items.map((i, k) => ({ id: i.id, ...r[k] })) });
      } catch (e: any) {
        return json({ error: String(e?.message || e) }, 502);
      }
    }

    if (url.pathname === "/api/alerts") {
      if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
      const hook = env.ALERT_WEBHOOK_URL?.trim();
      if (req.method === "GET") return json({ configured: !!hook, kind: hook ? (/(^|\/\/)ntfy\./.test(hook) ? "ntfy" : "webhook") : null });
      if (req.method === "POST") {
        if (!hook) return json({ error: "No alert webhook is set. Add the ALERT_WEBHOOK_URL secret." }, 400);
        const due = env.DB ? await collectDue(env.DB) : [];
        const err = await sendWebhook(hook, "Test alert from your gov contracting dashboard.\n" + (due.length ? digestText(due) : "Nothing is due in the next 3 days."), due);
        return err ? json({ error: err }, 502) : json({ ok: true });
      }
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
    relayCfg = env.GOV_RELAY_URL && env.RELAY_TOKEN ? { base: env.GOV_RELAY_URL.replace(/\/$/, ""), token: env.RELAY_TOKEN } : undefined;
    const sam = new SamGovClient({ apiKey: env.SAM_GOV_API_KEY?.trim() || undefined });
    const cache = env.CACHE ? { kv: env.CACHE, ctx } : undefined;
    ctx.waitUntil(
      runDailyAlerts(env.DB, async (name, args) => (await runEnvelope(sam, name, args, cache)).envelope, env.ALERT_WEBHOOK_URL?.trim() || undefined, env.CACHE ? await env.CACHE.get("settings:profile") : null),
    );
  },
};
