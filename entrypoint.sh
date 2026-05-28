#!/bin/bash
set -e

# Verify credentials are set
if [ -z "$PCO_CLIENT_ID" ] || [ -z "$PCO_CLIENT_SECRET" ]; then
    echo "Error: PCO_CLIENT_ID and PCO_CLIENT_SECRET must be set"
    exit 1
fi

# Configure uvicorn (used internally by FastMCP.run())
export UVICORN_HOST=0.0.0.0
export UVICORN_PORT=8000

# Run the Planning Center MCP server
exec python /app/planning_center_server.py
