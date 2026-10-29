// Supabase Edge Function "gov-relay": forwards allowlisted government API requests for the
// Cloudflare Worker, because those hosts return HTTP 525 to requests that come from inside Cloudflare.
// Usage: {FUNCTION_URL}/{host}/{path}?{query}  with header x-relay-token: <RELAY_TOKEN>
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ALLOWED = new Set(["api.usaspending.gov", "sanctionslistservice.ofac.treas.gov"]);
const SKIP_REQ = new Set(["host", "x-relay-token", "authorization", "apikey", "cookie", "content-length", "connection"]);
const SKIP_RES = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie"]);

function eq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

Deno.serve(async (req: Request) => {
  const token = Deno.env.get("RELAY_TOKEN") ?? "";
  if (!token || !eq(req.headers.get("x-relay-token") ?? "", token)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
  }
  const u = new URL(req.url);
  const rest = u.pathname.replace(/^\/(functions\/v1\/)?gov-relay\//, "");
  const slash = rest.indexOf("/");
  const host = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
  const path = slash === -1 ? "/" : rest.slice(slash);
  if (!ALLOWED.has(host)) {
    return new Response(JSON.stringify({ error: "host not allowed" }), { status: 403, headers: { "content-type": "application/json" } });
  }
  const headers = new Headers();
  req.headers.forEach((v, k) => { if (!SKIP_REQ.has(k.toLowerCase())) headers.set(k, v); });
  const method = req.method.toUpperCase();
  const upstream = await fetch(`https://${host}${path}${u.search}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : await req.arrayBuffer(),
    redirect: "manual",
    signal: AbortSignal.timeout(25000),
  }).catch((e) => new Response(JSON.stringify({ error: String(e) }), { status: 502, headers: { "content-type": "application/json" } }));
  const out = new Headers();
  upstream.headers.forEach((v, k) => { if (!SKIP_RES.has(k.toLowerCase())) out.set(k, v); });
  return new Response(upstream.body, { status: upstream.status, headers: out });
});
