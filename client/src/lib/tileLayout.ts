// Responsive tile layout for the call stage.
//
// The layout is driven by two inputs: the number of participants and the
// measured stage width/height (device width). Behavior matches Google Meet:
//   - 1 participant  -> single tile fills the whole stage.
//   - 2 participants -> one large tile fills the stage, one small self-view
//                       tile sits in the bottom-right corner.
//   - 3 participants -> three tiles fill the whole stage in one row.
//   - 4-6            -> a uniform grid of rectangles filling the stage.
//   - 7+             -> a fixed-size grid that scrolls vertically.

export type TileLayout =
  | { mode: 'single'; width: number; height: number }
  | {
      mode: 'spotlight';
      mainWidth: number;
      mainHeight: number;
      secondaryWidth: number;
      secondaryHeight: number;
    }
  | { mode: 'grid'; tileWidth: number; tileHeight: number; columns: number; rows: number }
  | { mode: 'scrollable'; tileWidth: number; tileHeight: number; columns: number };

interface Options {
  participantCount: number;
  width: number;
  height: number;
  gap?: number;
  aspectRatio?: number;
}

const DEFAULT_GAP = 16;
const DEFAULT_ASPECT = 16 / 9;

// Max grid columns a given stage width can sensibly hold; narrow devices get
// fewer columns so tiles stay readable.
function maxColsForWidth(width: number): number {
  if (width < 480) return 2;
  if (width < 768) return 3;
  if (width < 1100) return 4;
  return 5;
}

// Columns for the scrollable (7+) mode. Google Meet keeps a fixed 3-column
// grid on wide screens and drops to 2 on narrow devices.
function scrollableColsForWidth(width: number): number {
  return width < 480 ? 2 : 3;
}

interface FittedTile {
  width: number;
  height: number;
}

// Largest tile (maintaining aspect ratio) that fits `cols` x `rows` in the
// container, accounting for the gaps. Returns null if the container is too
// small for that configuration.
function fitTile(
  containerW: number,
  containerH: number,
  cols: number,
  rows: number,
  gap: number,
  aspect: number,
): FittedTile | null {
  const contentW = containerW - (cols - 1) * gap;
  const contentH = containerH - (rows - 1) * gap;
  if (contentW <= 0 || contentH <= 0) return null;
  let w = contentW / cols;
  let h = w / aspect;
  if (h > contentH / rows) {
    h = contentH / rows;
    w = h * aspect;
  }
  return { width: w, height: h };
}

export function computeTileLayout({
  participantCount,
  width,
  height,
  gap = DEFAULT_GAP,
  aspectRatio = DEFAULT_ASPECT,
}: Options): TileLayout {
  const n = Math.max(1, Math.floor(participantCount));
  const safeW = Math.max(1, width);
  const safeH = Math.max(1, height);

  if (n === 1) {
    return { mode: 'single', width: safeW, height: safeH };
  }

  if (n === 2) {
    // Small corner self-view: capped at ~30% of stage width (and a sensible
    // absolute cap) so it never dominates the main tile.
    const secondaryWidth = Math.min(safeW * 0.3, 340);
    const secondaryHeight = secondaryWidth / aspectRatio;
    return {
      mode: 'spotlight',
      mainWidth: safeW,
      mainHeight: safeH,
      secondaryWidth,
      secondaryHeight,
    };
  }

  // 7+ participants: a fixed-size grid that scrolls vertically. Tiles keep a
  // readable size and the stage scrolls rather than shrinking tiles to fit.
  if (n > 6) {
    const columns = Math.min(scrollableColsForWidth(safeW), n);
    const rows = Math.ceil(n / columns);
    const tile = fitTile(safeW, safeH, columns, rows, gap, aspectRatio);
    if (tile) {
      return { mode: 'scrollable', tileWidth: tile.width, tileHeight: tile.height, columns };
    }
    // Fall back to a plain grid if the container is too small to fit.
    return { mode: 'grid', tileWidth: 0, tileHeight: 0, columns: 1, rows: n };
  }

  // Grid: try every column count up to the device-width cap and keep the
  // configuration that yields the largest tiles (i.e. least wasted space).
  const maxCols = Math.min(maxColsForWidth(safeW), n);
  let best: (FittedTile & { cols: number; rows: number }) | null = null;

  for (let cols = 1; cols <= maxCols; cols++) {
    const rows = Math.ceil(n / cols);
    const tile = fitTile(safeW, safeH, cols, rows, gap, aspectRatio);
    if (!tile) continue;
    if (!best || tile.width * tile.height > best.width * best.height) {
      best = { ...tile, cols, rows };
    }
  }

  if (!best) {
    return { mode: 'grid', tileWidth: 0, tileHeight: 0, columns: 1, rows: n };
  }

  return {
    mode: 'grid',
    tileWidth: best.width,
    tileHeight: best.height,
    columns: best.cols,
    rows: best.rows,
  };
}
