#!/bin/bash
set -e

export HOST=${HOST:-0.0.0.0}
export PORT=${PORT:-8000}

# Verify credentials are set
if [ -z "$PCO_CLIENT_ID" ] || [ -z "$PCO_CLIENT_SECRET" ]; then
    echo "Error: PCO_CLIENT_ID and PCO_CLIENT_SECRET must be set"
    exit 1
fi

# Run with explicit Uvicorn host binding
exec python -m uvicorn \
    --host 0.0.0.0 \
    --port "${PORT}" \
    --app-dir /app \
    planning_center_server:mcp
