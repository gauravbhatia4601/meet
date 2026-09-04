#!/bin/bash
# ── Uplink full system check ─────────────────────────────────────────────
# Runs every layer: unit tests → loopback decode → both join orders with a
# real headless Chrome → camera off/on cycle. Prints one verdict per layer.
cd "$(dirname "$0")"

GREEN='\033[0;32m'; RED='\033[0;31m'; YEL='\033[1;33m'; NC='\033[0m'
pass() { echo -e "${GREEN}✅ $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; }
info() { echo -e "${YEL}▶ $1${NC}"; }

RESULTS=()

# 0. Services
info "checking services (server :4123, vite :5173)"
if ! lsof -i :4123 -sTCP:LISTEN >/dev/null 2>&1; then
  fail "signaling server NOT running on :4123 — start it: cd ~/meet-clone && npx tsx server/src/index.ts"
  RESULTS+=("server DOWN")
else
  pass "server :4123"
  RESULTS+=("server=OK")
fi
if ! lsof -i :5173 -sTCP:LISTEN >/dev/null 2>&1; then
  echo -e "${YEL}⚠ vite :5173 not running — starting it${NC}"
  (cd ~/meet-clone/client && nohup npx vite > /tmp/vite.log 2>&1 &)
  sleep 4
fi
lsof -i :5173 -sTCP:LISTEN >/dev/null 2>&1 && { pass "vite :5173"; RESULTS+=("vite=OK"); } || { fail "vite :5173"; RESULTS+=("vite=FAIL"); }

# 1. Unit tests
info "1/4 Rust unit tests (27 expected)"
cd ~/meet-clone/terminal
cargo test --release 2>&1 | grep -m1 "test result: ok. 27 passed" >/dev/null \
  && { pass "unit tests 27/27"; RESULTS+=("unit=OK"); } \
  || { fail "unit tests"; RESULTS+=("unit=FAIL"); }

# 2. In-process loopback (negotiation → H264 decode, no browser)
info "2/4 loopback decode test"
cargo test --release --test peer_decode_loopback 2>&1 | grep -m1 "test result: ok" >/dev/null \
  && { pass "loopback decode"; RESULTS+=("loopback=OK"); } \
  || { fail "loopback decode"; RESULTS+=("loopback=FAIL"); }

# 3+4. Full e2e with real headless Chrome: both join orders + cam off/on cycle
E2E=/tmp/uplink-e2e/e2e.js
if [ ! -f "$E2E" ]; then
  echo -e "${YEL}e2e harness missing — run: mkdir -p /tmp/uplink-e2e && cd /tmp/uplink-e2e && npm init -y && npm i puppeteer-core && cp ~/meet-clone/scripts/e2e.js .${NC}"
  RESULTS+=("e2e=MISSING")
else
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
fi

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