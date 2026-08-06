/**
 * Resolves the signaling server origin.
 *
 * In development the Vite dev server proxies /api and /socket.io to the local
 * server, so an empty value means "same origin". In production the client is
 * served statically (e.g. on Vercel) and must point at the separately-hosted
 * signaling server via VITE_SERVER_URL.
 */
const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? '';

/** Origin of the signaling server, or '' for same-origin (dev proxy). */
export const SERVER_ORIGIN = SERVER_URL.replace(/\/+$/, '');

/** Full URL for REST endpoints on the signaling server. */
export function apiUrl(path: string): string {
  return `${SERVER_ORIGIN}${path}`;
}
