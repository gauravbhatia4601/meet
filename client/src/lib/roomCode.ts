/**
 * Normalize a user-entered meeting code: strip surrounding whitespace and
 * lowercase it. Room codes are generated lowercase (`abc-defg-hij`).
 */
export function normalizeRoomId(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * Validate a meeting code against the format used by the server
 * (`xxx-yyyy-xxx` where each segment is 3-4 lowercase letters).
 */
const ROOM_ID_PATTERN = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

export function isValidRoomId(roomId: string): boolean {
  return ROOM_ID_PATTERN.test(roomId);
}
