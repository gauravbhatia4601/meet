import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PeerConnectionManager } from './PeerConnectionManager';

/** Minimal fake RTCDataChannel for the chat-channel tests. */
class FakeDataChannel {
  readyState = 'open';
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
}

/**
 * Minimal fake RTCPeerConnection so the PeerConnectionManager can be tested
 * in Node. The manager only constructs RTCPeerConnection inside its methods,
 * so stubbing it before each test (and before any call) is sufficient.
 */
class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  signalingState = 'have-local-offer';
  localDescription: { type: string; sdp: string } | null = null;
  onicecandidate: ((ev: { candidate: unknown }) => void) | null = null;
  ontrack: ((ev: { streams: MediaStream[] }) => void) | null = null;
  ondatachannel: ((ev: { channel: FakeDataChannel }) => void) | null = null;
  senders: { kind: string; track: { kind: string } | null; replaceTrack: ReturnType<typeof vi.fn> }[] = [];

  constructor() {
    FakePeerConnection.instances.push(this);
  }

  addTrack(track: { kind: string }) {
    const sender = { kind: track.kind, track, replaceTrack: vi.fn(), getParameters: vi.fn(() => ({ encodings: [] })), setParameters: vi.fn(() => Promise.resolve()) };
    this.senders.push(sender);
    return sender;
  }
  getSenders() {
    return this.senders;
  }
  createDataChannel() {
    return new FakeDataChannel();
  }
  createOffer() {
    return Promise.resolve({ type: 'offer', sdp: 'offer-sdp' });
  }
  createAnswer() {
    return Promise.resolve({ type: 'answer', sdp: 'answer-sdp' });
  }
  setLocalDescription(desc: { type: string; sdp: string }) {
    this.localDescription = desc;
    return Promise.resolve();
  }
  setRemoteDescription() {
    return Promise.resolve();
  }
  addIceCandidate() {
    return Promise.resolve();
  }
  close() {}
}

function makeSocket() {
  return { emit: vi.fn() } as unknown as import('socket.io-client').Socket;
}

function makeStream(): MediaStream {
  return {
    getTracks: () => [],
    getVideoTracks: () => [],
  } as unknown as MediaStream;
}

function makeCallbacks() {
  return { onStream: vi.fn(), onRemoteMediaState: vi.fn(), onChat: vi.fn() };
}

function makeManager(socket = makeSocket()) {
  return new PeerConnectionManager(
    socket,
    makeCallbacks(),
    makeStream(),
    { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
  );
}

beforeEach(() => {
  FakePeerConnection.instances = [];
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PeerConnectionManager', () => {
  it('creates a peer connection when a new peer announces', async () => {
    const socket = makeSocket();
    const manager = makeManager(socket);

    manager.handleNewPeer('peer-1');
    await vi.waitFor(() => {
      expect(socket.emit).toHaveBeenCalledWith('offer', expect.objectContaining({ to: 'peer-1' }));
    });
    expect(FakePeerConnection.instances).toHaveLength(1);
  });

  it('does not duplicate a peer connection for the same peer', () => {
    const manager = makeManager();
    manager.handleNewPeer('peer-1');
    manager.handleNewPeer('peer-1');
    expect(FakePeerConnection.instances).toHaveLength(1);
  });

  it('answers an incoming offer with an answer', async () => {
    const socket = makeSocket();
    const manager = makeManager(socket);

    await manager.handleOffer('peer-2', { type: 'offer', sdp: 'x' });
    expect(socket.emit).toHaveBeenCalledWith('answer', expect.objectContaining({ to: 'peer-2' }));
  });

  it('ignores an answer when there is no peer connection', async () => {
    const socket = makeSocket();
    const manager = makeManager(socket);
    await expect(manager.handleAnswer('ghost', { type: 'answer', sdp: 'x' })).resolves.toBeUndefined();
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('broadcasts local media state to every peer', () => {
    const socket = makeSocket();
    const manager = makeManager(socket);
    manager.handleNewPeer('peer-1');
    manager.handleNewPeer('peer-2');

    manager.broadcastLocalMediaState({ micOn: false, cameraOn: true, screenShareOn: false });
    const mediaStateCalls = socket.emit.mock.calls.filter(([ev]) => ev === 'media-state');
    expect(mediaStateCalls).toHaveLength(2);
    expect(mediaStateCalls.map(([, p]) => p.to)).toEqual(['peer-1', 'peer-2']);
  });

  it('closes and removes a peer connection on disconnect', () => {
    const manager = makeManager();
    manager.handleNewPeer('peer-1');
    const pc = FakePeerConnection.instances[0];
    const closeSpy = vi.spyOn(pc, 'close');

    manager.handlePeerDisconnected('peer-1');
    expect(closeSpy).toHaveBeenCalled();
    expect(manager.getPeerCount()).toBe(0);
  });

  it('closeAll closes every connection and resets the peer count', () => {
    const manager = makeManager();
    manager.handleNewPeer('peer-1');
    manager.handleNewPeer('peer-2');
    manager.closeAll();
    expect(manager.getPeerCount()).toBe(0);
  });

  it('replaceLocalTrack replaces the matching local sender track', () => {
    const videoTrack = { kind: 'video', readyState: 'live' } as MediaStreamTrack;
    const stream = {
      getTracks: () => [videoTrack],
      getVideoTracks: () => [videoTrack],
    } as unknown as MediaStream;
    const socket = makeSocket();
    const manager = new PeerConnectionManager(
      socket,
      makeCallbacks(),
      stream,
      { iceServers: [] },
    );
    manager.handleNewPeer('peer-1');
    // createPeer called addTrack(videoTrack) which returned a real sender,
    // registered in the manager's per-peer sender map.
    const pc = FakePeerConnection.instances[0];
    const sender = pc.senders[0];
    const replaceSpy = sender.replaceTrack;

    const newTrack = { kind: 'video' } as MediaStreamTrack;
    manager.replaceLocalTrack('video', newTrack);
    expect(replaceSpy).toHaveBeenCalledWith(newTrack);
  });

  it('replaceLocalTrack with null stops the matching sender and a later re-enable still reaches it', () => {
    const audioTrack = { kind: 'audio', readyState: 'live' } as MediaStreamTrack;
    const stream = {
      getTracks: () => [audioTrack],
      getVideoTracks: () => [],
    } as unknown as MediaStream;
    const socket = makeSocket();
    const manager = new PeerConnectionManager(
      socket,
      makeCallbacks(),
      stream,
      { iceServers: [] },
    );
    manager.handleNewPeer('peer-1');
    const pc = FakePeerConnection.instances[0];
    const sender = pc.senders[0];
    const replaceSpy = sender.replaceTrack;

    // Mute: replace with null. The old code lost the sender here because it
    // looked it up by s.track?.kind === 'audio' and the track was now null.
    manager.replaceLocalTrack('audio', null);
    expect(replaceSpy).toHaveBeenCalledWith(null);

    // Unmute: the sender must still be found and receive the new track.
    const restoredTrack = { kind: 'audio', readyState: 'live' } as MediaStreamTrack;
    manager.replaceLocalTrack('audio', restoredTrack);
    expect(replaceSpy).toHaveBeenCalledWith(restoredTrack);
  });

  it('replaceLocalTrack adds the track and renegotiates when no sender exists (peer joined while muted)', async () => {
    // Stream with no tracks: createPeer adds nothing, so no sender is
    // registered for 'video'. Re-enabling video must addTrack + renegotiate.
    const socket = makeSocket();
    const manager = makeManager(socket);
    manager.handleNewPeer('peer-1');
    const pc = FakePeerConnection.instances[0];
    const addTrackSpy = vi.spyOn(pc, 'addTrack');
    const createOfferSpy = vi.spyOn(pc, 'createOffer');

    const newTrack = { kind: 'video', readyState: 'live' } as MediaStreamTrack;
    manager.replaceLocalTrack('video', newTrack);
    expect(addTrackSpy).toHaveBeenCalledWith(newTrack, expect.anything());
    // Renegotiation is async (createOffer -> setLocalDescription -> emit).
    await vi.waitFor(() => {
      expect(createOfferSpy).toHaveBeenCalled();
      expect(socket.emit).toHaveBeenCalledWith('offer', expect.objectContaining({ to: 'peer-1' }));
    });
  });

  it('skips ended local tracks when creating a peer connection', async () => {
    const socket = makeSocket();
    const liveTrack = { kind: 'video', readyState: 'live' } as MediaStreamTrack;
    const endedTrack = { kind: 'audio', readyState: 'ended' } as MediaStreamTrack;
    const stream = {
      getTracks: () => [liveTrack, endedTrack],
      getVideoTracks: () => [liveTrack],
    } as unknown as MediaStream;
    const manager = new PeerConnectionManager(
      socket,
      makeCallbacks(),
      stream,
      { iceServers: [] },
    );
    const addTrackSpy = vi.spyOn(FakePeerConnection.prototype, 'addTrack');

    manager.handleNewPeer('peer-1');
    await vi.waitFor(() => {
      expect(socket.emit).toHaveBeenCalledWith('offer', expect.anything());
    });
    // Only the live track should be added.
    expect(addTrackSpy).toHaveBeenCalledTimes(1);
    expect(addTrackSpy).toHaveBeenCalledWith(liveTrack, stream);
  });

  it('sends chat over the datachannel and reports it delivered', () => {
    const manager = makeManager();
    manager.handleNewPeer('peer-1');
    // handleNewPeer creates a datachannel; sendChat should use it.
    expect(manager.sendChat('hello')).toBe(true);
  });

  it('falls back to false (no open channel) before any peer connects', () => {
    const manager = makeManager();
    expect(manager.sendChat('hello')).toBe(false);
  });

  it('delivers an incoming datachannel message to onChat', () => {
    const cb = makeCallbacks();
    const manager = new PeerConnectionManager(makeSocket(), cb, makeStream(), { iceServers: [] });
    manager.handleNewPeer('peer-1');
    // Simulate the answerer receiving the offerer's datachannel.
    const pc = FakePeerConnection.instances[0];
    const dc = new FakeDataChannel();
    pc.ondatachannel?.({ channel: dc });
    dc.onmessage?.({ data: JSON.stringify({ text: 'hi', ts: 123 }) });
    expect(cb.onChat).toHaveBeenCalledWith('peer-1', 'hi', 123);
  });
});