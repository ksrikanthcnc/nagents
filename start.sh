#!/usr/bin/env bash
# nagents — start/stop/status
#
# Usage:
#   ./start.sh          Start (background, PID tracked)
#   ./start.sh stop     Stop
#   ./start.sh status   Show status
#   ./start.sh logs     Tail log file
#
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
HTTP_PORT=3335
VITE_PORT=5180
PID_FILE="$DIR/.nagents.pid"
LOG_FILE="$DIR/.nagents.log"
case "${1:-start}" in
  stop|kill)
    if [ -f "$PID_FILE" ]; then
      kill $(cat "$PID_FILE") 2>/dev/null && echo "[nagents] stopped" || echo "[nagents] not running"
      rm -f "$PID_FILE"
    else
      echo "[nagents] not running (no PID file)"
    fi
    lsof -ti :$HTTP_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
    lsof -ti :$VITE_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
    ;;
  status)
    if [ -f "$PID_FILE" ] && kill -0 $(cat "$PID_FILE") 2>/dev/null; then
      echo "[nagents] running (PID $(cat "$PID_FILE"))"
      echo "  HTTP: http://127.0.0.1:$HTTP_PORT"
      echo "  Vite: http://localhost:$VITE_PORT"
    else
      echo "[nagents] not running"
      rm -f "$PID_FILE"
    fi
    ;;
  logs)
    if [ -f "$LOG_FILE" ]; then
      tail -f "$LOG_FILE"
    else
      echo "[nagents] no log file"
    fi
    ;;
  start|"")
    # Kill previous
    if [ -f "$PID_FILE" ]; then
      kill $(cat "$PID_FILE") 2>/dev/null || true
      rm -f "$PID_FILE"
      sleep 0.5
    fi
    lsof -ti :$HTTP_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
    lsof -ti :$VITE_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
    # Clear WebKit cache (prevents stale JS modules after code changes)
    rm -rf ~/Library/WebKit/nagents ~/Library/Caches/nagents 2>/dev/null || true
    # Start in background
    cd "$DIR"
    RUST_LOG=info cargo tauri dev > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"

    # Wait for server to be ready (stream log while waiting)
    echo "[nagents] starting (PID $!)..."
    echo "  log: $LOG_FILE"
    echo ""
    tail -f "$LOG_FILE" 2>/dev/null &
    TAIL_PID=$!
    for i in $(seq 1 30); do
      if curl -s http://127.0.0.1:$HTTP_PORT/health >/dev/null 2>&1; then
        kill $TAIL_PID 2>/dev/null
        wait $TAIL_PID 2>/dev/null
        echo ""
        echo "[nagents] ready"
        echo "  HTTP API:  http://127.0.0.1:$HTTP_PORT"
        echo "  ./start.sh logs     — tail output"
        echo "  ./start.sh stop     — kill"
        break
      fi
      sleep 1
    done
    kill $TAIL_PID 2>/dev/null || true
    wait $TAIL_PID 2>/dev/null || true

    if ! curl -s http://127.0.0.1:$HTTP_PORT/health >/dev/null 2>&1; then
      echo ""
      echo "[nagents] FAILED to start (30s timeout). Check: ./start.sh logs"
      exit 1
    fi
    ;;
  *)
    echo "Usage: ./start.sh [start|stop|status|logs]"
    exit 1
    ;;
esac
