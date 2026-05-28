FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the MCP server and entrypoint
COPY planning_center_server.py .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

# Expose port
EXPOSE 8000

# Run via entrypoint
ENTRYPOINT ["./entrypoint.sh"]
