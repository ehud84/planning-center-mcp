# Planning Center MCP Server

FastMCP-based MCP server for Planning Center Online Groups and People APIs.

## Configuration

Required for tool calls:

```env
PCO_CLIENT_ID=...
PCO_CLIENT_SECRET=...
```

Transport:

```env
# Local/direct clients such as Claude Desktop
MCP_TRANSPORT=stdio

# Hosted clients such as Railway
MCP_TRANSPORT=streamable-http
```

Hosted HTTP defaults to `0.0.0.0:${PORT:-8000}` and exposes:

- MCP: `https://<host>/mcp`
- Health: `https://<host>/health`
- Roster page: `https://<host>/roster` (only when `ROSTER_PIN` is set)

For public hosted deployments, set a long random `MCP_BEARER_TOKEN` and configure clients to send `Authorization: Bearer <token>`. Without this, anyone with the URL can use the MCP tools against the configured Planning Center credentials.

## Claude Desktop local setup

Use stdio and pass credentials in the server environment:

```json
{
  "mcpServers": {
    "planning-center": {
      "command": "python",
      "args": ["/absolute/path/to/planning_center_server.py"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "PCO_CLIENT_ID": "...",
        "PCO_CLIENT_SECRET": "..."
      }
    }
  }
}
```

## Railway / hosted setup

Set environment variables:

```env
MCP_TRANSPORT=streamable-http
PCO_CLIENT_ID=...
PCO_CLIENT_SECRET=...
MCP_PUBLIC_URL=https://<your-app>.up.railway.app
MCP_BEARER_TOKEN=<long-random-token>
ROSTER_PIN=<4-digit-pin>
```

Connect MCP clients to:

```text
https://<your-app>.up.railway.app/mcp
```

Use the health check URL:

```text
https://<your-app>.up.railway.app/health
```

## Docker

Build:

```bash
docker build -t planning-center-mcp .
```

Run hosted Streamable HTTP locally:

```bash
docker run --rm -p 8000:8000 \
  -e MCP_TRANSPORT=streamable-http \
  -e PCO_CLIENT_ID=x \
  -e PCO_CLIENT_SECRET=y \
  -e MCP_BEARER_TOKEN=dev-token \
  -e ROSTER_PIN=1234 \
  planning-center-mcp
```

Then open the roster at `http://localhost:8000/roster` and enter the PIN.

Check health:

```bash
curl -i http://localhost:8000/health
```

Connect an MCP Inspector or compatible Streamable HTTP client to:

```text
http://localhost:8000/mcp
```

If `MCP_BEARER_TOKEN` is set, include `Authorization: Bearer dev-token`.

## Mobile roster page

A PIN-protected, mobile-friendly roster is served at `/roster` when `ROSTER_PIN`
is set. It lists everyone on a Planning Center **Services** team and the teams
they serve on, with a By-Person / By-Team toggle, search, and sort. Data is
fetched live from Planning Center on each page load, server-side — credentials
never reach the browser.

```env
ROSTER_PIN=1234
# Optional: keep logins valid across redeploys by pinning the cookie secret.
# ROSTER_COOKIE_SECRET=<long-random-string>
```

Then open `https://<your-app>.up.railway.app/roster` on a phone, enter the PIN,
and the roster loads. A signed, HttpOnly cookie keeps the viewer signed in for
12 hours; `/roster/logout` clears it.

Notes:

- The PIN is verified server-side; the roster data is only rendered after a
  correct PIN. Teams that repeat across service types (e.g. several "Band"
  records) are combined into one, and stray whitespace in team names is
  normalized so duplicates merge.
- A short numeric PIN is a light gate, not strong security. Anyone with the URL
  can attempt PINs. For anything sensitive, prefer a longer `ROSTER_PIN` and/or
  keep the URL private.

## Planning Center API bases

This server uses service-scoped Planning Center base URLs by default:

- Groups: `https://api.planningcenteronline.com/groups/v2`
- People: `https://api.planningcenteronline.com/people/v2`

Optional overrides:

```env
PCO_API_ROOT=https://api.planningcenteronline.com
PCO_GROUPS_API_BASE=https://api.planningcenteronline.com/groups/v2
PCO_PEOPLE_API_BASE=https://api.planningcenteronline.com/people/v2
```
