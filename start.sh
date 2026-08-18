#!/usr/bin/env bash
# nagents — start/stop (tmux-managed, idempotent)
#
# Usage:
#   ./start.sh          Start nagents (tauri dev mode)
#   ./start.sh stop     Stop nagents
#   ./start.sh status   Show running status
#   ./start.sh logs     Attach to tmux session (view logs)
#
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
SESSION="nagents"

case "${1:-start}" in
  stop|kill)
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      tmux kill-session -t "$SESSION"
      echo "[nagents] stopped"
    else
      echo "[nagents] not running"
    fi
    # Kill any leftover processes on our port
    lsof -ti :3334 2>/dev/null | xargs kill -9 2>/dev/null || true
    ;;

  status)
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      echo "[nagents] running (tmux session: $SESSION)"
      tmux capture-pane -t "$SESSION" -p -S -5
    else
      echo "[nagents] not running"
    fi
    ;;

  logs|attach)
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      echo "[nagents] attaching to tmux session (Ctrl+B, D to detach)..."
      tmux attach -t "$SESSION"
    else
      echo "[nagents] not running"
      exit 1
    fi
    ;;

  start|"")
    # Kill previous if running
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      tmux kill-session -t "$SESSION"
      sleep 0.5
    fi
    lsof -ti :3334 2>/dev/null | xargs kill -9 2>/dev/null || true

    # Start: cargo tauri dev handles both Vite + Rust
    tmux new-session -d -s "$SESSION" -c "$DIR" \
      "RUST_LOG=info cargo tauri dev 2>&1"

    sleep 2
    echo "[nagents] started in tmux session '$SESSION'"
    echo ""
    echo "  View logs:  ./start.sh logs"
    echo "  Status:     ./start.sh status"
    echo "  Stop:       ./start.sh stop"
    echo ""
    echo "  Tauri dev serves frontend on http://localhost:5180"
    echo "  HTTP API on http://127.0.0.1:3334"
    ;;

  *)
    echo "Usage: ./start.sh [start|stop|status|logs]"
    exit 1
    ;;
esac
