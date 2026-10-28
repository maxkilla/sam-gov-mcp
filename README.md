# sam-gov-mcp on Cloudflare Workers

Private remote MCP server wrapping [`@cliwant/mcp-sam-gov`](https://github.com/cliwant/mcp-sam-gov)
(152 tools for federal + SLED contracting, spending, regulation and vetting).
Streamable HTTP at `/mcp`, bearer-token protected, stateless.

## Deploy

```bash
npm install
npx wrangler login
npx wrangler secret put MCP_AUTH_TOKEN      # paste a long random token (openssl rand -hex 32)
npx wrangler secret put SAM_GOV_API_KEY     # optional, only for the key-gated tools
npx wrangler deploy
```

Optional keys use the same pattern: `FRED_API_KEY`, `CENSUS_API_KEY`, `BEA_API_KEY`,
`DOL_API_KEY`, `DATA_GOV_API_KEY`.

The server fails closed: if `MCP_AUTH_TOKEN` is unset, every `/mcp` request returns 401.

## Connect an agent

```json
{
  "mcpServers": {
    "sam-gov": {
      "type": "http",
      "url": "https://sam-gov-mcp.<your-subdomain>.workers.dev/mcp",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

Claude Code: `claude mcp add --transport http sam-gov <url> --header "Authorization: Bearer <token>"`

## Toolset profiles (cut agent context)

All 153 tools load by default. Add `?toolsets=` to the URL to load only what an agent needs:

```
https://<worker>/mcp?toolsets=core,vetting
```

Sets: `core` (60: SAM.gov, USAspending, Grants, FAR/eCFR, OFAC), `sled` (13), `vetting` (16),
`disclosure` (8), `regulatory` (9), `pricing` (15), `health` (17), `safety` (3), `geo` (8),
`cyber` (3). `api_key_status` and `feedback` are always loaded. Unknown names are ignored with a
note in the server instructions; if none are valid, all tools load. Calls to tools outside the
profile return a `tool_not_loaded` error (ignore its "set MCP_SAM_GOV_TOOLSETS" hint here: use
the URL parameter instead). To set a Worker-wide default, add a `MCP_SAM_GOV_TOOLSETS` variable;
the URL parameter overrides it.

## Caching

Upstream API responses are cached in Workers KV (binding `CACHE`, namespace `sam-gov-mcp-cache`).
Workers' Cache API does not work on `workers.dev`, which is why this uses KV.

- Only successful (HTTP 200) text/JSON responses are stored. Outages, 429s and bad responses are never
  cached, so they still surface as errors.
- TTL: 10 minutes by default, 1 hour for slow-changing reference data (eCFR, Federal Register, FAR,
  NIST, USITC). Live-data hosts (`api.weather.gov`, `bwt.cbp.gov`) are never cached.
- Cache keys are SHA-256 hashes of method + URL + body, so API keys are never stored.
- Every tool result carries `_meta.cache` (`hits`, `misses`, `servedFromCache`, and the age of the
  oldest cached item when served from cache), so an agent can tell stale from fresh.
- Add `?cache=off` to the MCP URL to bypass the cache (combine with toolsets: `?toolsets=core&cache=off`).
- Remove the `[[kv_namespaces]]` block to disable caching entirely.
- Workers Free plan: KV allows 1,000 writes/day (100,000 reads/day). When the write cap is hit, writes
  fail quietly and calls simply go live. Workers Paid has no such cap.
- The package also keeps a small in-memory cache inside a warm instance; KV covers cold starts and
  other regions.

## Local test

```bash
echo 'MCP_AUTH_TOKEN=dev-token' > .dev.vars
npx wrangler dev
curl -s localhost:8787/mcp -H 'authorization: Bearer dev-token' \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Notes

- `src/index.ts` shims `fetch` so `redirect: "error"` (used by many tools as an SSRF guard,
  rejected by Workers) becomes "manual" + throw on any 3xx. Same no-redirect guarantee.
- Tools that read `process.env` get your secrets via `nodejs_compat_populate_process_env`.
- Free plan: Workers have a CPU time limit per request; heavy tools (PDF attachment text
  extraction, big paginated pulls) may need the paid plan.
- For defense in depth, put the route behind Cloudflare Access (service token) in addition
  to the bearer token.
