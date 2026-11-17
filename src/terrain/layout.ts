import type { BlockMap } from './blocks';

/**
 * Where the map sits in world units (grid cells: X = pixelX / gridSize, Z = pixelY / gridSize).
 * A map follows its image unless it has a fixed size (maps made of blocks alone have no image).
 */
export interface Layout {
  /** World position of the grid's cell (0, 0). */
  originX: number;
  originZ: number;
  /** The map's area in world cells. */
  bounds: { x0: number; x1: number; z0: number; z1: number };
  /** Cell indices covering that area. */
  range: { cx0: number; cx1: number; cz0: number; cz1: number };
  /** The image's size in world cells, for texture coordinates; null without an image. */
  uv: { w: number; h: number } | null;
}

export interface LayoutInput {
  image: { widthPx: number; heightPx: number } | null;
  grid: { size: number; offsetX: number; offsetY: number };
  extent: BlockMap['extent'];
}

/** Used when there is neither an image nor a stored size. */
export const DEFAULT_EXTENT = 20;

export function computeLayout({ image, grid, extent }: LayoutInput): Layout {
  const ox = grid.offsetX / grid.size;
  const oz = grid.offsetY / grid.size;
  const uv = image ? { w: image.widthPx / grid.size, h: image.heightPx / grid.size } : null;

  const fixed = extent ?? (uv ? null : { cols: DEFAULT_EXTENT, rows: DEFAULT_EXTENT });
  if (fixed) {
    return {
      originX: ox, originZ: oz, uv,
      bounds: { x0: ox, x1: ox + fixed.cols, z0: oz, z1: oz + fixed.rows },
      range: { cx0: 0, cx1: fixed.cols - 1, cz0: 0, cz1: fixed.rows - 1 },
    };
  }
  const { w, h } = uv as { w: number; h: number };
  return {
    originX: ox, originZ: oz, uv,
    bounds: { x0: 0, x1: w, z0: 0, z1: h },
    range: { cx0: Math.floor(-ox), cx1: Math.ceil(w - ox) - 1, cz0: Math.floor(-oz), cz1: Math.ceil(h - oz) - 1 },
  };
}
