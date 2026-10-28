#!/usr/bin/env bash
# Measures the start time and the memory of a Kestrel release build.
#
# Usage: scripts/measure.sh [binary] [folder]
#   binary  default: target/release/kestrel
#   folder  default: the current folder (the folder that Kestrel opens)
#
# What it does:
#   1. Starts the app with the folder as argument. stderr goes to a log file.
#   2. Waits for the log line "window shown" and prints the time in ms.
#   3. Prints the RSS memory of the app process (MB) one second after the
#      window is shown, and 5 seconds after the start.
#   4. Stops the app.
#
# RSS is the Rust process only. The web view runs in separate helper
# processes (WebKit on macOS and Linux, WebView2 on Windows). They are not
# counted here.
#
# How to get the log line in a release build:
#   The frontend sends "window shown" to the Rust command `app_log`. That
#   command always calls `log::info!`, but the app starts no logger. It only
#   prints to stderr with `eprintln!` when `cfg!(debug_assertions)` is true.
#   So in a release build you see no line, unless the code is changed to:
#
#       if cfg!(debug_assertions) || std::env::var_os("KESTREL_LOG").is_some() {
#           eprintln!("[web:{level}] {message}");
#       }
#
#   This script sets KESTREL_LOG=1 for that reason. Without the change, you can
#   build with debug assertions: `cargo build --release` with
#   `CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS=true`. That build is a bit slower
#   than the real release, so use the number only as an upper limit.
#
# Needs: bash, perl (for a millisecond clock), ps. Works on macOS and Linux.

set -u

BIN="${1:-target/release/kestrel}"
FOLDER="${2:-$PWD}"
WAIT_SECONDS="${WAIT_SECONDS:-20}"

if [ ! -x "$BIN" ]; then
  echo "binary not found or not executable: $BIN" >&2
  echo "build it first: npm run tauri build" >&2
  exit 1
fi
if [ ! -d "$FOLDER" ]; then
  echo "folder not found: $FOLDER" >&2
  exit 1
fi

now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'; }

# RSS of one process in MB, or "n/a".
rss_mb() {
  local pid="$1" kb=""
  case "$(uname -s)" in
    Darwin)
      kb="$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ')"
      ;;
    *)
      kb="$(awk '/^VmRSS:/ {print $2}' "/proc/$pid/status" 2>/dev/null)"
      ;;
  esac
  if [ -z "$kb" ]; then
    echo "n/a"
  else
    awk -v kb="$kb" 'BEGIN { printf "%.1f", kb / 1024 }'
  fi
}

LOG="$(mktemp "${TMPDIR:-/tmp}/kestrel-measure.XXXXXX")"
PID=""
cleanup() {
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -9 "$PID" 2>/dev/null
  fi
  rm -f "$LOG"
}
trap cleanup EXIT INT TERM

START="$(now_ms)"
KESTREL_LOG=1 "$BIN" "$FOLDER" 2>"$LOG" >/dev/null &
PID=$!

# Wait for the "window shown" line.
SHOWN=""
DEADLINE=$((START + WAIT_SECONDS * 1000))
while :; do
  if grep -q "window shown" "$LOG" 2>/dev/null; then
    SHOWN="$(now_ms)"
    break
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "the app exited before it showed the window" >&2
    cat "$LOG" >&2
    exit 1
  fi
  if [ "$(now_ms)" -gt "$DEADLINE" ]; then
    break
  fi
  sleep 0.01
done

if [ -z "$SHOWN" ]; then
  echo "no 'window shown' line after ${WAIT_SECONDS}s." >&2
  echo "This build probably does not print logs to stderr. See the comments at the top of this script." >&2
  echo "Last log lines:" >&2
  tail -n 5 "$LOG" >&2
  echo "start to window shown : n/a"
else
  echo "start to window shown : $((SHOWN - START)) ms   (budget: 300 ms)"
  echo "frontend says         : $(grep -o 'window shown.*' "$LOG" | head -n 1)"
fi

# Memory one second after the window is shown (the folder is open by then).
sleep 1
echo "RSS after open (+1s)  : $(rss_mb "$PID") MB"

# Memory 5 seconds after the start.
ELAPSED=$(($(now_ms) - START))
if [ "$ELAPSED" -lt 5000 ]; then
  sleep "$(awk -v ms="$((5000 - ELAPSED))" 'BEGIN { printf "%.2f", ms / 1000 }')"
fi
echo "RSS after 5 s         : $(rss_mb "$PID") MB"
# On macOS, RSS also counts shared system library pages. The physical
# footprint (the number in Activity Monitor) is the real cost of the app.
if [ "$(uname)" = "Darwin" ]; then
  echo "Footprint after 5 s   : $(vmmap -summary "$PID" 2>/dev/null | awk '/^Physical footprint:/ {print $3}')   (budget: 60 MB)"
fi

echo "stopping the app (pid $PID)"
