import { useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '../types';
import { SERVER_ORIGIN } from '../lib/config';

const SOCKET_URL = SERVER_ORIGIN;

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

// TRUE module singleton: exactly one socket per page. The previous per-hook
// ref created a new socket per component (and StrictMode remounts doubled
// that again), and the unmount cleanup closed sockets mid-handshake —
// "WebSocket is closed before the connection is established".
let singleton: AppSocket | null = null;

export function getSocket(): AppSocket {
  if (!singleton) {
    singleton = io(SOCKET_URL, {
      autoConnect: false,
      transports: ['websocket', 'polling'],
      reconnection: true,
    }) as AppSocket;
  }
  return singleton;
}

export function useSocket(): AppSocket {
  const socket = getSocket();

  useEffect(() => {
    // Idempotent: connecting an already-connected socket is a no-op, and a
    // disconnected one (after a room leave) reconnects here.
    socket.connect();
    // Intentionally no disconnect on unmount — the socket outlives any one
    // component; room leaves call disconnect() explicitly.
  }, [socket]);

  return socket;
}
