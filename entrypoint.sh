#!/bin/bash
set -euo pipefail

# Planning Center credentials are required before any tool can call the PCO API.
if [ -z "${PCO_CLIENT_ID:-}" ] || [ -z "${PCO_CLIENT_SECRET:-}" ]; then
    echo "Error: PCO_CLIENT_ID and PCO_CLIENT_SECRET must be set" >&2
    exit 1
fi

# Railway provides PORT. FastMCP reads UVICORN_HOST/UVICORN_PORT via the server config.
export UVICORN_HOST="${UVICORN_HOST:-0.0.0.0}"
export UVICORN_PORT="${PORT:-${UVICORN_PORT:-8000}}"

# Docker/Railway are hosted by default. Override with MCP_TRANSPORT=stdio for local stdio use.
export MCP_TRANSPORT="${MCP_TRANSPORT:-streamable-http}"

exec python /app/planning_center_server.py
