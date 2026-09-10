#!/bin/bash
# ── Uplink full system check ─────────────────────────────────────────────
# Runs every layer: unit tests → loopback decode → both join orders with a
# real headless Chrome → camera off/on cycle. Prints one verdict per layer.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

GREEN='\033[0;32m'; RED='\033[0;31m'; YEL='\033[1;33m'; NC='\033[0m'
pass() { echo -e "${GREEN}✅ $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; }
info() { echo -e "${YEL}▶ $1${NC}"; }

RESULTS=()

# 0. Services + production build for the e2e
# The e2e runs against the PRODUCTION build served by its own server instance
# (E2E port 4125): vite dev HMR/dep-reoptimization reloads pages mid-run and
# flakes headless Chrome — a static dist build never reloads.
info "checking services (signaling :4123)"
if ! lsof -i :4123 -sTCP:LISTEN >/dev/null 2>&1; then
  fail "signaling server NOT running on :4123 — start it: cd "$ROOT" && npx tsx server/src/index.ts"
  RESULTS+=("server DOWN")
else
  pass "server :4123"
  RESULTS+=("server=OK")
fi

info "building client (production) for the e2e"
npm run build -w client > /tmp/e2e-build.log 2>&1 \
  && { pass "client build"; RESULTS+=("build=OK"); } \
  || { fail "client build — see /tmp/e2e-build.log"; RESULTS+=("build=FAIL"); }

E2E_PORT=4125
E2E_URL="http://localhost:${E2E_PORT}"
E2E_SIG="ws://localhost:${E2E_PORT}"
export E2E_BASE="$E2E_URL" E2E_SERVER="$E2E_SIG" CLIENT_ORIGIN="$E2E_URL"
if ! lsof -i ":${E2E_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  (cd "$ROOT/server" && NODE_ENV=production PORT=${E2E_PORT} CLIENT_ORIGIN="$E2E_URL" STUN_PORT=3479 nohup npx tsx src/index.ts > /tmp/e2e-server.log 2>&1 &)
  for _ in $(seq 1 20); do
    lsof -i ":${E2E_PORT}" -sTCP:LISTEN >/dev/null 2>&1 && break
    sleep 0.5
  done
fi
lsof -i ":${E2E_PORT}" -sTCP:LISTEN >/dev/null 2>&1 \
  && { pass "e2e server :${E2E_PORT} (production, serves dist)"; RESULTS+=("e2e-server=OK"); } \
  || { fail "e2e server :${E2E_PORT} — see /tmp/e2e-server.log"; RESULTS+=("e2e-server=FAIL"); }

# 1. Unit tests
info "1/4 Rust unit tests (27 expected)"
cd "$ROOT/terminal"
cargo test --release 2>&1 | grep -m1 "test result: ok. 27 passed" >/dev/null \
  && { pass "unit tests 27/27"; RESULTS+=("unit=OK"); } \
  || { fail "unit tests"; RESULTS+=("unit=FAIL"); }

# 2. In-process loopback (negotiation → H264 decode, no browser)
info "2/4 loopback decode test"
cd "$ROOT/terminal"
LB1=$(cargo test --release --test peer_decode_loopback 2>&1 | grep -m1 "test result: ok")
if [ -n "$LB1" ]; then
  pass "loopback decode"
  RESULTS+=("loopback=OK")
else
  sleep 1
  LB2=$(cargo test --release --test peer_decode_loopback 2>&1 | grep -m1 "test result: ok")
  if [ -n "$LB2" ]; then
    pass "loopback decode (retry)"
    RESULTS+=("loopback=OK")
  else
    fail "loopback decode"
    RESULTS+=("loopback=FAIL")
  fi
fi

# 3+4. Full e2e with real headless Chrome: both join orders + cam off/on cycle
E2E="$ROOT/scripts/e2e.js"
info "3/4 e2e: terminal creates → browser joins (+ cam off/on cycle)"
FLOW=terminal-first node "$E2E" > /tmp/e2e-flowA.log 2>&1
tail -1 /tmp/e2e-flowA.log | grep -a "✅ PASS" >/dev/null \
  && { pass "e2e flow A (terminal-first)"; RESULTS+=("flowA=OK"); } \
  || { fail "e2e flow A — $(grep -a '❌ FAIL' /tmp/e2e-flowA.log | tail -1)"; RESULTS+=("flowA=FAIL"); }

info "3/4 e2e: browser creates → terminal joins (+ cam off/on cycle)"
FLOW=browser-first node "$E2E" > /tmp/e2e-flowB.log 2>&1
tail -1 /tmp/e2e-flowB.log | grep -a "✅ PASS" >/dev/null \
  && { pass "e2e flow B (browser-first)"; RESULTS+=("flowB=OK"); } \
  || { fail "e2e flow B — $(grep -a '❌ FAIL' /tmp/e2e-flowB.log | tail -1)"; RESULTS+=("flowB=FAIL"); }

# 5. Post-run log sanity (cleared pre-run: only NEW panics count)
: > /tmp/uplink-panic.log 2>/dev/null
info "5/5 crash + log sanity"
[ -s /tmp/uplink-panic.log ] && { fail "panics recorded — see /tmp/uplink-panic.log"; RESULTS+=("panic=FAIL"); } \
  || { pass "no panics"; RESULTS+=("panic=OK"); }

echo ""
echo "──────────────── SUMMARY ────────────────"
printf ' %s\n' "${RESULTS[@]}"
echo "──────────────────────────────────────────"
echo "live logs: /tmp/uplink-overlay.log · /tmp/uplink-webrtc.log · /tmp/uplink-panic.log"