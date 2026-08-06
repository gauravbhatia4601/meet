import { describe, it, expect } from 'vitest';
import { normalizeRoomId, isValidRoomId } from './roomCode';

describe('normalizeRoomId', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeRoomId('  abc-defg-hij  ')).toBe('abc-defg-hij');
  });

  it('lowercases uppercase input', () => {
    expect(normalizeRoomId('ABC-DEFG-HIJ')).toBe('abc-defg-hij');
  });

  it('handles mixed case and whitespace together', () => {
    expect(normalizeRoomId('  AbC-DeFg-HiJ ')).toBe('abc-defg-hij');
  });
});

describe('isValidRoomId', () => {
  it('accepts a well-formed code', () => {
    expect(isValidRoomId('abc-defg-hij')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isValidRoomId('')).toBe(false);
  });

  it('rejects codes without separators', () => {
    expect(isValidRoomId('abcdefghij')).toBe(false);
  });

  it('rejects wrong segment lengths', () => {
    expect(isValidRoomId('abc-def-hij')).toBe(false); // 4-char middle missing
    expect(isValidRoomId('abc-defgh-hij')).toBe(false); // middle too long
    expect(isValidRoomId('ab-defg-hij')).toBe(false); // first too short
  });

  it('rejects non-letter characters', () => {
    expect(isValidRoomId('12c-defg-hij')).toBe(false);
  });

  it('rejects uppercase (must be normalized first)', () => {
    expect(isValidRoomId('ABC-DEFG-HIJ')).toBe(false);
  });
});
