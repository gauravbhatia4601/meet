import { describe, it, expect } from 'vitest';
import { computeTileLayout } from './tileLayout';

describe('computeTileLayout — single participant', () => {
  it('fills the whole stage with one tile', () => {
    const layout = computeTileLayout({ participantCount: 1, width: 1000, height: 700 });
    expect(layout.mode).toBe('single');
    if (layout.mode !== 'single') return;
    expect(layout.width).toBe(1000);
    expect(layout.height).toBe(700);
  });

  it('clamps invalid counts to at least one participant', () => {
    const layout = computeTileLayout({ participantCount: 0, width: 800, height: 600 });
    expect(layout.mode).toBe('single');
  });
});

describe('computeTileLayout — spotlight (2 participants)', () => {
  it('returns one main tile plus a capped corner tile', () => {
    const layout = computeTileLayout({ participantCount: 2, width: 1200, height: 800 });
    expect(layout.mode).toBe('spotlight');
    if (layout.mode !== 'spotlight') return;
    expect(layout.mainWidth).toBe(1200);
    expect(layout.mainHeight).toBe(800);
    expect(layout.secondaryWidth).toBeLessThan(layout.mainWidth);
    expect(layout.secondaryWidth).toBeLessThanOrEqual(340); // capped
    expect(layout.secondaryHeight).toBeCloseTo(layout.secondaryWidth / (16 / 9), 5);
  });

  it('caps the corner tile at 30% of stage width', () => {
    const layout = computeTileLayout({ participantCount: 2, width: 1000, height: 700 });
    if (layout.mode !== 'spotlight') throw new Error('expected spotlight');
    expect(layout.secondaryWidth).toBeCloseTo(300, 5);
  });
});

describe('computeTileLayout — grid (3-6 participants)', () => {
  it('never exceeds the device-width column cap', () => {
    const layout = computeTileLayout({ participantCount: 6, width: 1200, height: 800 });
    expect(layout.mode).toBe('grid');
    if (layout.mode !== 'grid') return;
    expect(layout.columns).toBeLessThanOrEqual(5);
    expect(layout.columns * layout.rows).toBeGreaterThanOrEqual(6);
  });

  it('uses fewer columns on narrow devices', () => {
    const narrow = computeTileLayout({ participantCount: 6, width: 400, height: 600 });
    const wide = computeTileLayout({ participantCount: 6, width: 1200, height: 800 });
    if (narrow.mode !== 'grid' || wide.mode !== 'grid') throw new Error('expected grid');
    expect(narrow.columns).toBeLessThanOrEqual(2);
    expect(wide.columns).toBeGreaterThanOrEqual(narrow.columns);
  });

  it('produces a complete grid with no dead tiles', () => {
    const layout = computeTileLayout({ participantCount: 6, width: 1280, height: 720 });
    if (layout.mode !== 'grid') throw new Error('expected grid');
    expect(layout.columns * layout.rows).toBeGreaterThanOrEqual(6);
  });

  it('tiles maintain the 16:9 aspect ratio', () => {
    const layout = computeTileLayout({ participantCount: 4, width: 1200, height: 800 });
    if (layout.mode !== 'grid') throw new Error('expected grid');
    expect(layout.tileWidth / layout.tileHeight).toBeCloseTo(16 / 9, 5);
  });
});

describe('computeTileLayout — scrollable (7+ participants)', () => {
  it('returns scrollable mode for more than six participants', () => {
    const layout = computeTileLayout({ participantCount: 7, width: 1200, height: 800 });
    expect(layout.mode).toBe('scrollable');
  });

  it('uses 3 columns on wide screens', () => {
    const layout = computeTileLayout({ participantCount: 9, width: 1200, height: 800 });
    if (layout.mode !== 'scrollable') throw new Error('expected scrollable');
    expect(layout.columns).toBe(3);
  });

  it('drops to 2 columns on narrow devices', () => {
    const layout = computeTileLayout({ participantCount: 9, width: 400, height: 600 });
    if (layout.mode !== 'scrollable') throw new Error('expected scrollable');
    expect(layout.columns).toBe(2);
  });

  it('tiles maintain the 16:9 aspect ratio', () => {
    const layout = computeTileLayout({ participantCount: 8, width: 1280, height: 720 });
    if (layout.mode !== 'scrollable') throw new Error('expected scrollable');
    expect(layout.tileWidth / layout.tileHeight).toBeCloseTo(16 / 9, 5);
  });
});
