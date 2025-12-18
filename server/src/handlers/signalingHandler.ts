/**
 * WebRTC Signaling Handler
 * 
 * Relays WebRTC signaling messages (offer, answer, ICE candidates)
 * between peers in the same room
 */

import { TypedSocket } from '../types/index.js';
import { RoomManager } from '../rooms/RoomManager.js';

/**
 * Handle WebRTC offer
 */
export function handleWebRTCOffer(
  socket: TypedSocket,
  roomManager: RoomManager,
  data: {
    to: string;  // Target peer ID
    offer: RTCSessionDescriptionInit;
  }
): void {
  if (!socket.roomCode) {
    console.warn(`[SignalingHandler] Offer from ${socket.id} but not in room`);
    return;
  }

  const room = roomManager.getRoom(socket.roomCode);
  if (!room) {
    console.warn(`[SignalingHandler] Room ${socket.roomCode} not found`);
    return;
  }

  const sender = room.participants.get(socket.id);
  if (!sender) {
    console.warn(`[SignalingHandler] Sender ${socket.id} not found in room`);
    return;
  }

  // Find target participant by peer ID
  const target = Array.from(room.participants.values()).find(p => p.peerId === data.to);
  if (!target) {
    console.warn(`[SignalingHandler] Target peer ${data.to} not found in room`);
    return;
  }

  // Relay offer to target
  socket.to(target.id).emit('webrtc-offer', {
    to: data.to,
    from: sender.peerId,
    offer: data.offer
  });

  console.log(`[SignalingHandler] Relayed offer from ${sender.name} (${sender.peerId}) to ${target.name} (${data.to})`);
}

/**
 * Handle WebRTC answer
 */
export function handleWebRTCAnswer(
  socket: TypedSocket,
  roomManager: RoomManager,
  data: {
    to: string;  // Target peer ID
    answer: RTCSessionDescriptionInit;
  }
): void {
  if (!socket.roomCode) {
    console.warn(`[SignalingHandler] Answer from ${socket.id} but not in room`);
    return;
  }

  const room = roomManager.getRoom(socket.roomCode);
  if (!room) return;

  const sender = room.participants.get(socket.id);
  if (!sender) return;

  const target = Array.from(room.participants.values()).find(p => p.peerId === data.to);
  if (!target) return;

  // Relay answer to target
  socket.to(target.id).emit('webrtc-answer', {
    to: data.to,
    from: sender.peerId,
    answer: data.answer
  });

  console.log(`[SignalingHandler] Relayed answer from ${sender.name} (${sender.peerId}) to ${target.name} (${data.to})`);
}

/**
 * Handle ICE candidate
 */
export function handleWebRTCIceCandidate(
  socket: TypedSocket,
  roomManager: RoomManager,
  data: {
    to: string;  // Target peer ID
    candidate: RTCIceCandidateInit;
  }
): void {
  if (!socket.roomCode) {
    console.warn(`[SignalingHandler] ICE candidate from ${socket.id} but not in room`);
    return;
  }

  const room = roomManager.getRoom(socket.roomCode);
  if (!room) return;

  const sender = room.participants.get(socket.id);
  if (!sender) return;

  const target = Array.from(room.participants.values()).find(p => p.peerId === data.to);
  if (!target) return;

  // Relay ICE candidate to target
  socket.to(target.id).emit('webrtc-ice-candidate', {
    to: data.to,
    from: sender.peerId,
    candidate: data.candidate
  });

  // Log only occasionally to avoid spam (ICE candidates are frequent)
  if (Math.random() < 0.1) { // Log ~10% of candidates
    console.log(`[SignalingHandler] Relayed ICE candidate from ${sender.name} to ${target.name}`);
  }
}

