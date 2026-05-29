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
  planning-center-mcp
```

Check health:

```bash
curl -i http://localhost:8000/health
```

Connect an MCP Inspector or compatible Streamable HTTP client to:

```text
http://localhost:8000/mcp
```

If `MCP_BEARER_TOKEN` is set, include `Authorization: Bearer dev-token`.

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
