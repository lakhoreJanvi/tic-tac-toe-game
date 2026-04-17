#!/bin/sh
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required (Render Postgres connection string)." 1>&2
  exit 1
fi

# Render provides a Postgres URL like:
#   postgresql://USER:PASSWORD@HOST:PORT/DBNAME
# Nakama expects:
#   USER:PASSWORD@HOST:PORT/DBNAME
NAKAMA_DB_ADDRESS="$(echo "$DATABASE_URL" | sed -E 's#^[a-zA-Z0-9+.-]+://##')"

# Render routes external traffic to this port (default 10000).
SOCKET_PORT="${PORT:-10000}"

# Run migrations (idempotent), then start the server.
/nakama/nakama migrate up --database.address "$NAKAMA_DB_ADDRESS"

exec /nakama/nakama \
  --name "nakama1" \
  --database.address "$NAKAMA_DB_ADDRESS" \
  --logger.level "INFO" \
  --session.token_expiry_sec "7200" \
  --runtime.js_entrypoint "index.js" \
  --runtime.path "/nakama/data/modules" \
  --config "/nakama/data/config.yml" \
  --socket.port "$SOCKET_PORT"
