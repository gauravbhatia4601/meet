#!/usr/bin/env bash
#
# webcam-terminal.sh — Live webcam → terminal renderer (ffmpeg + chafa)
#
# USAGE:
#   ./scripts/webcam-terminal.sh                          # default 640x480
#   ./scripts/webcam-terminal.sh --format sixel --size 1280x720   # iTerm2 HD
#   ./scripts/webcam-terminal.sh --scale 480x270          # downscale = faster FPS
#   ./scripts/webcam-terminal.sh --screen                 # capture screen
#   ./scripts/webcam-terminal.sh --list                   # list devices
#
set -euo pipefail

# ── Kill leftover processes from a previous crashed run ──────────────────────
pgrep -f 'ffmpeg.*avfoundation.*webcam-terminal' | xargs kill -9 2>/dev/null || true

# ── Defaults ──────────────────────────────────────────────────────────────────
VIDEO_DEVICE="0"
RESOLUTION="640x480"
FRAMERATE="30"
SCALE=""                  # empty = no scaling; e.g. "480x270" to downscale
COLS="${COLUMNS:-100}"
ROWS="${LINES:-50}"
FORMAT="symbols"          # symbols | sixel | kitty | iterm
QUALITY="high"            # fast | high | max
FRAME_DIR="/tmp/webcam-terminal"
FRAME_RAW="$FRAME_DIR/frame-raw.png"
FRAME_STAGING="$FRAME_DIR/frame-stage.png"
FRAME_FILE="$FRAME_DIR/frame.png"
FF_LOG="$FRAME_DIR/ffmpeg.log"

# ── Parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --list)    ffmpeg -f avfoundation -list_devices true -i "" 2>&1 | grep -E "^\[AVFoundation"; exit 0 ;;
    --device)  VIDEO_DEVICE="$2"; shift 2 ;;
    --size)    RESOLUTION="$2";   shift 2 ;;
    --scale)   SCALE="$2";        shift 2 ;;
    --fps)     FRAMERATE="$2";    shift 2 ;;
    --cols)    COLS="$2";         shift 2 ;;
    --rows)    ROWS="$2";         shift 2 ;;
    --screen)  VIDEO_DEVICE="3";  shift ;;
    --format)  FORMAT="$2";       shift 2 ;;
    --quality) QUALITY="$2";      shift 2 ;;
    -h|--help) grep '^#' "$0" | head -16; exit 0 ;;
    *) echo "Unknown: $1" >&2; exit 1 ;;
  esac
done

command -v ffmpeg >/dev/null || { echo "✗ brew install ffmpeg" >&2; exit 1; }
command -v chafa  >/dev/null || { echo "✗ brew install chafa" >&2; exit 1; }

# ── chafa flags ───────────────────────────────────────────────────────────────
CHAFA_FLAGS="--size ${COLS}x${ROWS} --clear"
case "$QUALITY" in
  fast) CHAFA_FLAGS="$CHAFA_FLAGS --work 1 --colors 16" ;;
  high) CHAFA_FLAGS="$CHAFA_FLAGS --work 5 --colors 240" ;;
  max)  CHAFA_FLAGS="$CHAFA_FLAGS --work 9 --colors 240 --dither ordered" ;;
  *) echo "✗ Quality: fast | high | max" >&2; exit 1 ;;
esac

# ── Build ffmpeg video filter ────────────────────────────────────────────────
VF_ARGS=""
if [[ -n "$SCALE" ]]; then
  VF_ARGS="-vf scale=${SCALE}"
fi

# ── Setup ─────────────────────────────────────────────────────────────────────
mkdir -p "$FRAME_DIR"
rm -f "$FRAME_RAW" "$FRAME_STAGING" "$FRAME_FILE" "$FF_LOG"

FF_PID=""
COPIER_PID=""
WATCHDOG_PID=""

cleanup() {
  [[ -n "$FF_PID" ]]       && kill -9 "$FF_PID" 2>/dev/null || true
  [[ -n "$COPIER_PID" ]]   && kill -9 "$COPIER_PID" 2>/dev/null || true
  [[ -n "$WATCHDOG_PID" ]] && kill -9 "$WATCHDOG_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$FRAME_DIR"
  printf '\033[?25h'
}
trap cleanup EXIT INT TERM HUP QUIT BUS SEGV PIPE ABRT

SCALE_INFO="${SCALE:-none}"
echo "🎥 Webcam → Terminal  |  ${RESOLUTION}@${FRAMERATE}fps  scale=$SCALE_INFO  ${COLS}x${ROWS}  $FORMAT/$QUALITY"
echo "   Press Ctrl+C to quit"
echo ""

# ── ffmpeg: capture → PNG ────────────────────────────────────────────────────
# PNG output (reliable with -update 1). For higher FPS, use --scale to
# downscale before encoding — smaller PNG = faster encode + faster chafa decode.
ffmpeg -f avfoundation \
  -framerate "$FRAMERATE" \
  -video_size "$RESOLUTION" \
  -pix_fmt uyvy422 \
  -i "$VIDEO_DEVICE" \
  $VF_ARGS \
  -update 1 \
  -y "$FRAME_RAW" \
  2>"$FF_LOG" &
FF_PID=$!

# ── Copier: atomically copies frame-raw.png → frame.png ─────────────────────
# FIX for "Unable to allocate 0 bytes": check staging file size AFTER cp, before
# mv. If cp caught ffmpeg mid-truncate, staging will be 0 bytes — skip it.
# FIX for bus error: mv (rename) is atomic so chafa never sees a partial file.
# Polling at 0.01s = up to 100 checks/sec (well above 30fps camera rate).
(
  while true; do
    if [[ -f "$FRAME_RAW" ]] && [[ $(wc -c < "$FRAME_RAW" 2>/dev/null || echo 0) -gt 1000 ]]; then
      cp "$FRAME_RAW" "$FRAME_STAGING" 2>/dev/null
      # Verify staging file is valid BEFORE atomic rename
      if [[ $(wc -c < "$FRAME_STAGING" 2>/dev/null || echo 0) -gt 1000 ]]; then
        mv "$FRAME_STAGING" "$FRAME_FILE" 2>/dev/null
      else
        rm -f "$FRAME_STAGING" 2>/dev/null
      fi
    fi
    sleep 0.01
  done
) &
COPIER_PID=$!

# ── Watchdog ──────────────────────────────────────────────────────────────────
(
  while kill -0 $$ 2>/dev/null; do sleep 0.3; done
  kill -9 "$FF_PID" "$COPIER_PID" 2>/dev/null || true
  rm -rf "$FRAME_DIR"
) &
WATCHDOG_PID=$!

# ── Wait for first frame ─────────────────────────────────────────────────────
echo -n "   Initializing camera"
for i in $(seq 1 100); do
  if [[ -f "$FRAME_FILE" ]] && [[ $(wc -c < "$FRAME_FILE" 2>/dev/null || echo 0) -gt 1000 ]]; then
    echo ""
    break
  fi
  echo -n "."
  sleep 0.1
  if ! kill -0 "$FF_PID" 2>/dev/null; then
    echo ""
    echo ""
    echo "✗ ffmpeg exited unexpectedly:" >&2
    tail -8 "$FF_LOG" >&2
    echo "" >&2
    echo "  Grant camera permission: System Settings → Privacy & Security → Camera" >&2
    echo "  Or try: $0 --screen" >&2
    exit 1
  fi
done

if [[ ! -f "$FRAME_FILE" ]] || [[ $(wc -c < "$FRAME_FILE" 2>/dev/null || echo 0) -le 1000 ]]; then
  echo ""
  echo ""
  echo "✗ Camera didn't produce a frame within 10 seconds." >&2
  echo "  Most likely: $TERM_PROGRAM lacks Camera permission." >&2
  echo "  Fix: System Settings → Privacy & Security → Camera → enable $TERM_PROGRAM" >&2
  echo "  Or: $0 --screen" >&2
  tail -5 "$FF_LOG" >&2
  exit 1
fi

# ── Launch chafa ──────────────────────────────────────────────────────────────
exec chafa --watch --format "$FORMAT" $CHAFA_FLAGS "$FRAME_FILE"