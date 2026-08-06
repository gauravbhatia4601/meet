import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '../types';
import { SERVER_ORIGIN } from '../lib/config';

const SOCKET_URL = SERVER_ORIGIN;

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Returns a lazily-connected socket singleton. Using a module-level singleton
 * means the connection survives React StrictMode double-invocation in dev.
 */
export function useSocket(): AppSocket {
  const socketRef = useRef<AppSocket | null>(null);

  if (socketRef.current === null) {
    socketRef.current = io(SOCKET_URL, {
      autoConnect: false,
      transports: ['websocket', 'polling'],
    }) as AppSocket;
  }

  useEffect(() => {
    const socket = socketRef.current!;
    socket.connect();
    return () => {
      socket.disconnect();
    };
  }, []);

  return socketRef.current!;
}
