#!/usr/bin/env bash
# nagents — start/stop
#
# Usage:
#   ./start.sh          Start full app (panel + overlay + server on :3334)
#   ./start.sh stop     Stop everything
#   ./start.sh status   Show status
#   ./start.sh logs     Attach to tmux (view logs)
#
# The app starts:
#   - Rust backend: HTTP server on :3334, scanners, attention loop
#   - Vite dev server: :5180 (hot-reload for frontend)
#   - Tauri: panel window + overlay window (native)
#
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
SESSION="nagents"
HTTP_PORT=3335
VITE_PORT=5180

case "${1:-start}" in
  stop|kill)
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      tmux kill-session -t "$SESSION"
      echo "[nagents] stopped"
    else
      echo "[nagents] not running"
    fi
    lsof -ti :$HTTP_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
    lsof -ti :$VITE_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
    ;;

  status)
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      echo "[nagents] running (tmux: $SESSION)"
      echo ""
      echo "  HTTP server: http://127.0.0.1:$HTTP_PORT"
      echo "  Vite:        http://localhost:$VITE_PORT"
      echo ""
      tmux capture-pane -t "$SESSION" -p -S -10
    else
      echo "[nagents] not running"
    fi
    ;;

  logs|attach)
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      tmux attach -t "$SESSION"
    else
      echo "[nagents] not running"
      exit 1
    fi
    ;;

  start|"")
    # Kill previous
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      tmux kill-session -t "$SESSION"
      sleep 0.5
    fi
    lsof -ti :$HTTP_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
    lsof -ti :$VITE_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true

    # Start: cargo tauri dev runs Vite + Rust + native windows
    tmux new-session -d -s "$SESSION" -c "$DIR" \
      "RUST_LOG=info cargo tauri dev 2>&1"

    sleep 3
    echo "[nagents] started in tmux session '$SESSION'"
    echo ""
    echo "  HTTP API:  http://127.0.0.1:$HTTP_PORT"
    echo "  Panel:     Tauri window (native)"
    echo "  Overlay:   Tauri window (transparent, auto-created)"
    echo ""
    echo "  ./start.sh logs    — view output"
    echo "  ./start.sh stop    — kill"
    echo "  ./start.sh status  — check"
    ;;

  *)
    echo "Usage: ./start.sh [start|stop|status|logs]"
    exit 1
    ;;
esac
