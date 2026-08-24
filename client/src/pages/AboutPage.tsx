import { Link } from 'react-router-dom';

export default function AboutPage() {
  return (
    <main id="main-content" className="about">
      <div className="scanline" aria-hidden="true" />
      <header className="about__bar">
        <Link to="/" className="about__back">&lt; back</Link>
        <span className="about__title glitch-text" data-text="UPLINK // HOW_IT_WORKS">
          UPLINK // HOW_IT_WORKS
        </span>
      </header>

      <article className="about__body">
        <p className="about__lead">
          Uplink is a browser-based, peer-to-peer video meeting app with a terminal HUD.
          No plugins, no installs — the media flows directly between participants.
        </p>

        <Section title="media // webrtc">
          <p>
            Each participant holds an <code>RTCPeerConnection</code> to every other
            participant (a full mesh). Audio and video are negotiated over WebRTC and
            transported with <strong>SRTP</strong>, so media is encrypted in transit
            (DTLS-SRTP key exchange) end-to-end between browsers. The server never sees
            or stores a single frame.
          </p>
        </Section>

        <Section title="signaling // socket.io">
          <p>
            Before peers can talk directly, they need to exchange SDP offers/answers and
            ICE candidates. That happens over a Socket.io relay on a persistent Node
            process. The server is a dumb relay for signaling and chat/control messages —
            it routes them between the right sockets and keeps an in-memory room roster
            (with host tracking), nothing more.
          </p>
        </Section>

        <Section title="connectivity // ice + turn">
          <p>
            WebRTC uses ICE to find a usable path. STUN gives each peer its public
            reflexive address so most direct connections work. Behind strict NATs
            (mobile/corporate), a TURN relay is required; Uplink mints short-lived TURN
            credentials from Cloudflare Calls server-side on each request, so TURN
            secrets never ship in the client bundle.
          </p>
        </Section>

        <Section title="rooms // codes">
          <p>
            Meetings are keyed by short codes (<code>abc-defg-hij</code>). Anyone with the
            code can join; the first participant becomes the host. Rooms live in memory on
            the signaling server for the duration of the call.
          </p>
        </Section>

        <Section title="controls // commands">
          <p>
            There are no media toggle buttons. The call is driven from a command bar:
            <code>/mute</code>, <code>/cam</code>, <code>/share</code>, <code>/hand</code>,
            <code>/chat</code>, <code>/copy</code>, <code>/exit</code>, <code>/help</code>.
            Type <code>/</code> to see all available commands.
          </p>
        </Section>

        <Section title="hud // live readouts">
          <p>
            The <strong>LATENCY</strong> readout is real: on the landing page it measures
            round-trip time to the signaling server (<code>latency:probe</code> echo); in a
            call it measures worst-case peer RTT from WebRTC <code>getStats()</code>
            (selected ICE candidate-pair <code>currentRoundTripTime</code>). <strong>NODES</strong>{' '}
            is the live participant count and <strong>STATUS</strong> reflects the actual
            link state (LIVE / LINKING / OFFLINE / NOMINAL / DEGRADED).
          </p>
        </Section>

        <Section title="stack">
          <p>
            React 18 + Vite + TypeScript on the client; Node.js + Express + Socket.io on
            the server; WebRTC for media. The whole UI is a custom terminal theme — black
            canvas, phosphor-green monospace, sharp corners, scanlines.
          </p>
        </Section>

        <Link to="/" className="about__cta terminal-button">RETURN_HOME</Link>
      </article>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="about__section">
      <h2 className="about__section-title">&gt; {title}</h2>
      {children}
    </section>
  );
}