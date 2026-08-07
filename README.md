# Meet Clone — WebRTC Video Conferencing

A production-ready clone of Google Meet built with React, Socket.io, and WebRTC.
Peer-to-peer video/audio, screen sharing, chat, and media controls.

## Features

- 🎥 Real-time **P2P video & audio** via WebRTC (mesh topology)
- 🖥️ **Screen sharing** with presenter label
- 💬 In-call **chat**
- 🎙️ Mute / camera on-off, with live indicators on every tile
- ✋ **Raise hand** (auto-dismisses after 6s)
- 👥 Live participant roster + host tracking
- 🔗 Shareable meeting codes (`abc-defg-hij`)
- 🐳 Dockerized with health checks

## Tech Stack

| Layer   | Tech |
| ------- | ---- |
| Frontend | React 18, Vite 6, TypeScript, React Router |
| Signaling | Socket.io (Node.js) |
| Media | WebRTC (RTCPeerConnection) |
| Backend | Express, Helmet, CORS |
| Infra | Docker, multi-stage build, health check |

## Quick Start (Development)

```bash
# Install dependencies (npm workspaces)
npm install

# Run server + client with hot reload
npm run dev
```

- Server: http://localhost:3001 (Socket.io + REST)
- Client: http://localhost:5173

Open the client in **two browser tabs** (or two machines) and join the same
meeting code to test video.

## Testing

```bash
npm test          # runs the vitest suite (room codes, room manager, WebRTC)
npm run typecheck # type-checks both workspaces
```

The suite covers room-code normalization/validation, the server's room store
(host assignment, host transfer, room cleanup), and the WebRTC
`PeerConnectionManager` (offer/answer, media-state broadcast, disconnect).

## Production

### Docker

```bash
docker compose up -d --build
```

The container builds both apps and serves the client from the Express server
on port `3001` in a single process.

> **TLS is handled by your existing proxy, not by this stack.** Your domain
> (e.g. `meet.technioz.com`) is already SSL-protected, so no cert provisioning
> is needed here. Point your proxy (Cloudflare / nginx / Caddy) at this VPS on
> port `3001`. WebRTC requires HTTPS for camera/mic, which your proxy provides.
> Set `CLIENT_ORIGIN` to your public origin (defaults to
> `https://meet.technioz.com`).

### Manual

```bash
npm install
npm run build          # builds client into client/dist
NODE_ENV=production CLIENT_ORIGIN=http://<host>:3001 npm run start
```

### Intranet (LAN) deployment

Serve it from a single process so the client and WebRTC signaling come from one
origin. The server already binds `0.0.0.0` and serves the built client, so any
machine on the same LAN can reach it via the host's IP.

```bash
npm install
npm run build
# Your machine's LAN IP, e.g. 192.168.1.50:
HOST_IP=$(ipconfig getifaddr en0)   # macOS; on Linux use: hostname -I
NODE_ENV=production CLIENT_ORIGIN="http://$HOST_IP:3001" npm run start
```

Then open `http://<HOST_IP>:3001` from any device on the intranet. Get your IP
with `ipconfig getifaddr en0` (macOS) or `hostname -I` (Linux).

> **HTTPS is required for camera/mic.** Browsers only allow `getUserMedia`
> (camera, microphone) in a secure context (HTTPS or `localhost`). Over plain
> `http://<LAN-IP>`, the page loads but video/audio capture is blocked. Use a
> self-signed cert:

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout key.pem -out cert.pem -days 365 -subj "/CN=<HOST_IP>"

NODE_ENV=production CLIENT_ORIGIN="https://$HOST_IP:3001" \
  TLS_CERT=./cert.pem TLS_KEY=./key.pem npm run start
```

Then open `https://<HOST_IP>:3001` and accept the self-signed cert warning. On
iOS/Android you may need to install the cert as trusted to use the camera.
For a fully trusted setup, point a reverse proxy (nginx/Caddy) with a real cert
at the container's `:3001`.

### Deployment requirements

- **HTTPS is mandatory** for WebRTC except on `localhost`. Terminate TLS at a
  reverse proxy (nginx/Caddy/Cloudflare) pointing at the container's `:3001`.
- Set `CLIENT_ORIGIN` to the app's public origin.
- **Configure a TURN server** (see below) so calls connect reliably on the
  public internet behind strict NATs/firewalls. Without TURN, some corporate
  and mobile networks will fail to establish calls.
- For horizontal scaling across multiple server instances, replace the
  in-memory `RoomManager` with a shared store (Redis) and enable Socket.io
  Redis adapter; signaling must be shared between nodes.

### Vercel (client) + persistent host (signaling server)

> **Vercel cannot host the signaling server.** Vercel is serverless: functions
> are stateless and short-lived and do not support persistent WebSocket
> connections. The Socket.io server (`server/src/index.ts`) is a long-lived
> process with in-memory room state, so it must run on a persistent host
> (Railway, Render, Fly.io, or a VPS). Vercel serves the static client.

**1. Deploy the signaling server to a persistent host.**

Any host that can run a long-lived Node process works. On Railway/Render/Fly,
set the start command to `npm run start -w server` (or `node server/dist/index.js`)
and configure these env vars:

| Env var | Value |
| ------- | ----- |
| `NODE_ENV` | `production` |
| `PORT` | `3001` (or the host's assigned port) |
| `CLIENT_ORIGIN` | your Vercel app URL, e.g. `https://meet-clone.vercel.app` |
| `CLOUDFLARE_TURN_TOKEN_ID` / `CLOUDFLARE_TURN_API_TOKEN` | Cloudflare Calls credentials (required for public internet) |

The host gives you a public HTTPS URL, e.g. `https://meet-signal.up.railway.app`.

**2. Deploy the client to Vercel.**

The repo already includes `vercel.json` (root directory `client`, SPA rewrites).
Import the repo in Vercel, or use the CLI:

```bash
npm i -g vercel
vercel --prod
```

Set one environment variable in the Vercel dashboard
(Settings > Environment Variables):

| Env var | Value |
| ------- | ----- |
| `VITE_SERVER_URL` | your signaling server URL, e.g. `https://meet-signal.up.railway.app` |

`VITE_SERVER_URL` is baked into the client at build time. The client uses it for
both the Socket.io connection and the `GET /api/rtc-config` REST call. In local
dev it stays empty and the Vite proxy forwards to `localhost:3001`.

**3. Test.** Open the Vercel URL in two browsers/machines and join the same
meeting code. Both must be on HTTPS (Vercel provides it) for camera/mic to work.

> **Note on scaling:** the in-memory `RoomManager` means each signaling-server
> instance only knows about rooms created on it. For a single instance this is
> fine. To scale horizontally, add a shared store (Redis) and the Socket.io
> Redis adapter as noted above.

### TURN server (required for public internet)

The client fetches its ICE config (STUN + TURN) from the server at
`GET /api/rtc-config`, so TURN credentials never ship in the client bundle.
STUN is always enabled as a fallback. TURN/STUN URLs are fetched from the
Cloudflare API on the fly for each request — no TURN URL variables are needed.
Set only the Cloudflare credentials:

```bash
CLOUDFLARE_TURN_TOKEN_ID=your_token_id
CLOUDFLARE_TURN_API_TOKEN=your_api_token
# Optional: credential lifetime in seconds (default 86400 = 24h)
CLOUDFLARE_TURN_TTL=86400
```

Get these from the Cloudflare dashboard (Realtime > TURN). The server calls
`POST https://rtc.live.cloudflare.com/v1/turn/keys/<TOKEN_ID>/credentials/generate-ice-servers`
to mint short-lived TURN/STUN credentials that rotate automatically.

Without a TURN server, calls only work when both peers can reach each other
directly (same LAN, or both behind permissive NATs). On the public internet
with symmetric NATs (common on mobile/cellular), TURN is required.

## Configuration

| Env var | Default | Description |
| ------- | ------- | ----------- |
| `PORT` | `3001` | Server port |
| `CLIENT_ORIGIN` | `http://localhost:5173` | CORS / Socket.io origin |
| `NODE_ENV` | `development` | `production` serves the built client |
| `TLS_CERT` | *(empty)* | Path to a PEM cert — enables HTTPS when set |
| `TLS_KEY` | *(empty)* | Path to the matching PEM private key |
| `CLOUDFLARE_TURN_TOKEN_ID` | *(empty)* | Cloudflare Calls TURN token ID |
| `CLOUDFLARE_TURN_API_TOKEN` | *(empty)* | Cloudflare Calls API token |
| `CLOUDFLARE_TURN_TTL` | `86400` | TURN credential lifetime in seconds |

## Architecture

```
Browser A  <──────────  WebRTC (P2P media)  ──────────>  Browser B
     │                                                    │
     │  offer/answer/ICE (Socket.io signaling)            │
     └────────────────────►  Server  ◄───────────────────┘
                              (room mgmt, relay)
```

The server never sees audio/video — it only relays SDP/ICE signaling and
chat/control messages. Each participant holds an `RTCPeerConnection` to every
other participant (full mesh), which suits small-to-medium calls.

## Project Structure

```
meet-clone/
├── Dockerfile
├── docker-compose.yml
├── server/
│   └── src/
│       ├── index.ts          # Express + Socket.io + signaling
│       └── roomManager.ts    # In-memory room/participant store
└── client/
    └── src/
        ├── pages/            # Home, MeetingRoom
        ├── components/       # VideoTile, ControlsBar, ChatPanel
        ├── rtc/              # PeerConnectionManager
        └── hooks/            # useSocket
```

## License

MIT
