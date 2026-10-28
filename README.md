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
