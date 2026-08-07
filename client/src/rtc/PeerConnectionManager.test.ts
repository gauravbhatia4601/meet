import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PeerConnectionManager } from './PeerConnectionManager';

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
  senders: { kind: string; track: { kind: string } | null }[] = [];

  constructor() {
    FakePeerConnection.instances.push(this);
  }

  addTrack() {}
  getSenders() {
    return this.senders;
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

function makeManager(socket = makeSocket()) {
  return new PeerConnectionManager(
    socket,
    { onStream: vi.fn(), onRemoteMediaState: vi.fn() },
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
    const manager = makeManager();
    manager.handleNewPeer('peer-1');
    const pc = FakePeerConnection.instances[0];
    const sender = {
      kind: 'video',
      track: { kind: 'video', readyState: 'live' },
      replaceTrack: vi.fn(),
    };
    pc.senders.push(sender as unknown as { kind: string; track: { kind: string } | null });
    const replaceSpy = vi.spyOn(sender as unknown as { replaceTrack: () => Promise<void> }, 'replaceTrack');

    const newTrack = { kind: 'video' } as MediaStreamTrack;
    manager.replaceLocalTrack('video', newTrack);
    expect(replaceSpy).toHaveBeenCalledWith(newTrack);
  });

  it('replaceLocalTrack with null stops the matching sender', () => {
    const manager = makeManager();
    manager.handleNewPeer('peer-1');
    const pc = FakePeerConnection.instances[0];
    const sender = {
      kind: 'audio',
      track: { kind: 'audio', readyState: 'live' },
      replaceTrack: vi.fn(),
    };
    pc.senders.push(sender as unknown as { kind: string; track: { kind: string } | null });
    const replaceSpy = vi.spyOn(sender as unknown as { replaceTrack: () => Promise<void> }, 'replaceTrack');

    manager.replaceLocalTrack('audio', null);
    expect(replaceSpy).toHaveBeenCalledWith(null);
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
      { onStream: vi.fn(), onRemoteMediaState: vi.fn() },
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
});
