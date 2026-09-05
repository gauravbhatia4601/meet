// Full e2e: create room → terminal decode-probe (--fake-cam) joins → headless
// Chrome publishes its fake camera → assert BOTH directions decode.
// On probe freeze, auto-`sample` the wedged process for autopsy.
const { spawn, execSync } = require('node:child_process');
const { io } = require('/Users/gauravbhatia/meet-clone/node_modules/socket.io-client');
const puppeteer = require('puppeteer-core');
const fs = require('node:fs');

const RUN_SECS = 32;
  let camToggled = 0;
const PROBE_PATH = '/tmp/uplink-decode-probe.log';
const STATS_OUT = '/tmp/uplink-e2e-stats.json';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const probeSnapshot = () => {
  try {
    if (!fs.existsSync(PROBE_PATH) || fs.statSync(PROBE_PATH).size === 0) return -1;
    const lines = fs.readFileSync(PROBE_PATH, 'utf8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    return { frames: last.frames, t: last.t, staleMs: Date.now() - last.t };
  } catch {
    return -1;
  }
};

(async () => {
  fs.rmSync(PROBE_PATH, { force: true });
  fs.rmSync(STATS_OUT, { force: true });

  const holder = io('http://127.0.0.1:4123');
  const room = await new Promise((resolve, reject) => {
    holder.on('connect', () => {
      holder.emit('create-room', (res) => {
        if (res && res.ok) resolve(res.roomId);
        else reject(new Error('create-room failed: ' + JSON.stringify(res)));
      });
    });
    holder.on('connect_error', (e) => reject(e));
  });
  console.log('[room] created', room);
  await wait(500);

  const FLOW = process.env.FLOW ?? 'terminal-first';

  const spawnProbe = () => spawn(
    '/Users/gauravbhatia/meet-clone/terminal/target/release/uplink-terminal',
    ['decode-probe', room, '--name', 'Probe', '--server', 'ws://localhost:4123', '--secs', String(RUN_SECS + 10), '--fake-cam', '--toggle-cam-at', '12'],
    { env: { ...process.env, UPLINK_WEBRTC_DEBUG: '1' } },
  );
  let probe;
  const probeErr = [];
  let probeExit = 'still-running';

  function attachProbe(p) {
    probe = p;
    probe.stderr.on('data', (d) => probeErr.push(d.toString()));
    probe.stdout.on('data', (d) => probeErr.push(d.toString()));
    probe.on('exit', (c) => { probeExit = `exited(${c})`; });
  }
  if (FLOW !== 'browser-first') {
    attachProbe(spawnProbe());
  }

  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
      '--window-size=1280,800',
    ],
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    window.__pcs = [];
    const Orig = RTCPeerConnection;
    window.RTCPeerConnection = class extends Orig {
      constructor(...a) {
        super(...a);
        window.__pcs.push(this);
      }
    };
  });
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));

  await page.goto(`http://localhost:5173/room/${room}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#gate-name', { timeout: 20000 });
  await page.type('#gate-name', 'ChromeBot');
  await page.waitForFunction(() => {
    const b = document.querySelector('.namegate__submit');
    return b && !b.disabled;
  }, { timeout: 15000 });
  await page.click('.namegate__submit');
  console.log('[chrome] Connect clicked');

  if (FLOW === 'browser-first') {
    await wait(3000); // browser publishes first, then the terminal joins
    attachProbe(spawnProbe());
    await wait(1500);
  }

  // Stats poll + freeze detector.
  const stats = [];
  const t0 = Date.now();
  let sampled = false;
  let camToggled = 0;
  while (Date.now() - t0 < RUN_SECS * 1000) {
    await wait(1000);
    let s;
    try {
      s = await page.evaluate(async () => {
      const pcs = window.__pcs ?? [];
      if (!pcs.length) return { pcs: 0 };
      const o = { pcs: pcs.length, conn: '', packets: 0, frames: 0, bytes: 0, inPkts: 0, inFrames: 0, inBytes: 0 };
      let live = 0;
      for (const p of pcs) {
        const st = await p.getStats();
        let sent = 0, got = 0;
        st.forEach((r) => {
          if (r.type === 'outbound-rtp' && r.kind === 'video') { o.packets += r.packetsSent ?? 0; o.frames += r.framesEncoded ?? 0; o.bytes += r.bytesSent ?? 0; sent++; }
          if (r.type === 'inbound-rtp' && r.kind === 'video') { o.inPkts += r.packetsReceived ?? 0; o.inFrames += r.framesDecoded ?? 0; o.inBytes += r.bytesReceived ?? 0; got++; }
        });
        if (sent > 0 || got > 0) live = p;
      }
      if (live) { o.conn = live.connectionState; o.ice = live.iceConnectionState; }
      return o;
    });
    } catch {
      s = { error: 'context destroyed (navigation)' };
    }
    stats.push({ t: Date.now() - t0, ...s });
    // Mid-window browser /cam cycle: off at t≈20s, on at t≈24s.
    if (camToggled === 0 && s.t >= 20000) {
      camToggled = 1;
      const btns = await page.$$('.cmdbar__btn');
      await btns[1].click();
      console.log('[chrome] /cam OFF clicked');
    } else if (camToggled === 1 && s.t >= 24000) {
      camToggled = 2;
      const btns = await page.$$('.cmdbar__btn');
      await btns[1].click();
      console.log('[chrome] /cam ON clicked');
    }
    fs.writeFileSync(STATS_OUT, JSON.stringify({ room, stats, logs }, null, 2));

    // Probe-freeze detector: counter stale >10s while call should be live.
    const snap = probeSnapshot();
    if (!sampled && probeExit === 'still-running' && typeof snap === 'object' && snap.staleMs > 10000 && s.inPkts > 50) {
      sampled = true;
      try {
        const pid = fs.readFileSync('/tmp/uplink-probe-pid', 'utf8').trim();
        execSync(`sample ${pid} 3 -file /tmp/uplink-hang-sample.txt`);
        console.log('[e2e] sampled wedged probe pid', pid);
      } catch (e) {
        console.log('[e2e] sample failed:', e.message);
      }
      break;
    }
  }

  // ── camera toggle cycle on the BROWSER side (/cam off → on) ─────────
  const framesBefore = (stats.at(-1)?.frames ?? 0);
  const probeBefore = probeSnapshot();
  try {
    // /cam is the SECOND button in the command bar.
    const btns = await page.$$('.cmdbar__btn');
    await btns[1].click();
    await wait(4000); // camera off
    await btns[1].click();
    await wait(5000); // camera back on
  } catch (e) {
    console.log('[e2e] cam toggle click failed:', e.message);
  }
  const framesAfter = (stats.at(-1)?.frames ?? 0);

  const last = stats[stats.length - 1] ?? { pcs: 0 };
  console.log('CHROME_LAST', JSON.stringify(last));
  console.log('CAM_CYCLE framesEncoded', framesBefore, '->', framesAfter,
    '| probe decoded', probeBefore.frames ?? -1, '->', probeSnapshot().frames ?? -1);
  const deep = await page.evaluate(async () => {
    const out = [];
    for (const [i, p] of (window.__pcs ?? []).entries()) {
      const o = { i, sign: p.signalingState, conn: p.connectionState, ice: p.iceConnectionState };
      try {
        o.local = p.localDescription ? p.localDescription.type : null;
        o.remote = p.remoteDescription ? p.remoteDescription.type : null;
        const st = await p.getStats();
        let localCands = 0, remoteCands = 0, pairs = 0, activePair = '';
        st.forEach((r) => {
          if (r.type === 'local-candidate') localCands++;
          if (r.type === 'remote-candidate') remoteCands++;
          if (r.type === 'candidate-pair') { pairs++; if (r.state === 'succeeded') activePair = r.id; }
        });
        o.localCands = localCands; o.remoteCands = remoteCands; o.pairs = pairs; o.activePair = activePair;
      o.iceEvents = window.__iceCount ?? 0;
      } catch (e) { o.err = String(e); }
      out.push(o);
    }
    return out;
  });
  console.log('PC_DEEP', JSON.stringify(deep, null, 1));
  const media = await page.evaluate(() => {
    return [...document.querySelectorAll('video')].map((v) => ({
      tracks: v.srcObject ? [...v.srcObject.getTracks()].map((t) => t.kind) : null,
    }));
  });
  console.log('MEDIA', JSON.stringify(media));
  console.log('PAGE_URL', page.url());
  const uiCheck = await page.evaluate(() => {
    const names = [...document.querySelectorAll('.tile__name')].map((n) => n.textContent);
    const selfNames = [...document.querySelectorAll('.tile__hostbar span')].map((n) => n.textContent);
    const vids = [...document.querySelectorAll('video')].map((v) => ({
      w: v.videoWidth,
      h: v.videoHeight,
      ready: v.readyState,
      live: v.srcObject ? v.srcObject.getVideoTracks().some((t) => t.readyState === 'live') : null,
    }));
    return {
      names,
      selfNames,
      vids,
      joined: !!document.querySelector('.cmdbar'),
      gate: !!document.querySelector('#gate-name'),
      err: document.querySelector('.call__error-text')?.textContent ?? null,
    };
  });
  console.log('UI_CHECK', JSON.stringify(uiCheck));
  await page.screenshot({ path: '/tmp/final-state.png' });
  const cls = await page.evaluate(() => ({
    tiles: [...document.querySelectorAll('.tile')].length,
    videos: [...document.querySelectorAll('video')].map((v) => v.className),
    body: document.body.className,
    root: document.getElementById('root')?.children.length ?? 0,
  }));
  console.log('DOM', JSON.stringify(cls));
  const state = await page.evaluate(() => ({
    peers: window.__peers ?? null,
    cameraOn: window.__cameraOn ?? null,
  }));
  console.log('APP_STATE', JSON.stringify(state));
  console.log(probeExit, 'sampled=', sampled);
  // Let the probe run out or exit; read its final counter.
  const tP = Date.now();
  let finalFrames = -1;
  while (Date.now() - tP < 20000) {
    const snap = probeSnapshot();
    if (typeof snap === 'object' && snap.staleMs > 5000) { finalFrames = snap.frames; break; }
    if (probeExit !== 'still-running') { finalFrames = probeSnapshot().frames ?? -1; break; }
    await wait(1000);
  }
  const chromeIn = Number(last?.inFrames ?? 0);
  console.log('--- probe stderr (ansi-stripped) ---');
  console.log(probeErr.join('').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').slice(-3000));
  console.log(
    finalFrames > 100 && chromeIn >= 30
      ? `✅ PASS both ways: terminal decoded ${finalFrames} | browser decoded ${chromeIn}`
      : `❌ FAIL: terminalDecoded=${finalFrames} browserInboundDecoded=${chromeIn}`,
  );
  try { await browser.close(); } catch {}
  holder.close();
  process.exit(0);
})().catch((e) => { console.error('E2E ERROR', e?.message ?? e); process.exit(1); });