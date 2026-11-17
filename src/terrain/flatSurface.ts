import type { Block, BlockMap } from './blocks';
import type { Layout } from './layout';
import { DOWN, SHAPE_INFO, occludes, quarterOf } from './shapes';

export const CHUNK_SIZE = 16;

export interface ChunkRange { cx0: number; cx1: number; cz0: number; cz1: number }

export interface FlatCellInfo {
  y: number;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export const chunkOf = (cell: number): number => Math.floor(cell / CHUNK_SIZE);

/** The chunks that touch a map area plus every block placed, as "cx,cz" keys. */
export function chunksToBuild(map: BlockMap, layout: Layout): Set<string> {
  const keys = new Set<string>();
  const { range } = layout;
  for (let cz = chunkOf(range.cz0); cz <= chunkOf(range.cz1); cz++) {
    for (let cx = chunkOf(range.cx0); cx <= chunkOf(range.cx1); cx++) keys.add(`${cx},${cz}`);
  }
  map.forEach((b) => keys.add(`${chunkOf(b.x)},${chunkOf(b.z)}`));
  return keys;
}

export function chunkRange(cx: number, cz: number): ChunkRange {
  return { cx0: cx * CHUNK_SIZE, cx1: cx * CHUNK_SIZE + CHUNK_SIZE - 1, cz0: cz * CHUNK_SIZE, cz1: cz * CHUNK_SIZE + CHUNK_SIZE - 1 };
}

export function insideBounds(layout: Layout, cx: number, cz: number): boolean {
  return cx >= layout.range.cx0 && cx <= layout.range.cx1 && cz >= layout.range.cz0 && cz <= layout.range.cz1;
}

export function isTopExposed(map: BlockMap, b: Block, maxLayer: number): boolean {
  const above = b.y + 1 <= maxLayer ? map.get(b.x, b.y + 1, b.z) : undefined;
  if (!above) return true;
  if (SHAPE_INFO[b.shape].liquid && SHAPE_INFO[above.shape].liquid) return false;
  return !occludes(above.shape, quarterOf(above.rot), DOWN);
}

export function highestVisibleBlock(map: BlockMap, x: number, z: number, maxLayer: number): Block | undefined {
  const top = Math.min(map.topLayer(x, z), maxLayer);
  for (let y = top; y >= 1; y--) {
    const b = map.get(x, y, z);
    if (b) return b;
  }
  return undefined;
}

/**
 * Memoized lookup of ALL exposed flat surfaces in a column (ground floor `y = 0` when layer 1 is empty,
 * plus any exposed flat `Solid` or `Slab` block at `1..maxLayer`, including floating blocks in mid-air).
 */
export function createColumnFlatSampler(
  map: BlockMap,
  layout: Layout,
  maxLayer: number,
): (cx: number, cz: number) => readonly FlatCellInfo[] {
  const { originX: ox, originZ: oz, bounds } = layout;
  const L = map.layerHeight;
  const cache = new Map<string, readonly FlatCellInfo[]>();

  return (cx: number, cz: number): readonly FlatCellInfo[] => {
    const key = `${cx},${cz}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const list: FlatCellInfo[] = [];

    const hasGroundBlock = maxLayer >= 1 && map.get(cx, 1, cz) !== undefined;
    if (!hasGroundBlock && insideBounds(layout, cx, cz)) {
      const x0 = Math.max(ox + cx, bounds.x0);
      const x1 = Math.min(ox + cx + 1, bounds.x1);
      const z0 = Math.max(oz + cz, bounds.z0);
      const z1 = Math.min(oz + cz + 1, bounds.z1);
      if (x1 > x0 && z1 > z0) list.push({ y: 0, x0, x1, z0, z1 });
    }

    const top = Math.min(map.topLayer(cx, cz), maxLayer);
    for (let layer = 1; layer <= top; layer++) {
      const b = map.get(cx, layer, cz);
      if (!b || SHAPE_INFO[b.shape].liquid) continue;
      if (b.shape !== 'Solid' && b.shape !== 'Slab') continue;
      if (!isTopExposed(map, b, maxLayer)) continue;
      list.push({
        y: (b.y - 1 + SHAPE_INFO[b.shape].topPlane) * L,
        x0: ox + cx,
        x1: ox + cx + 1,
        z0: oz + cz,
        z1: oz + cz + 1,
      });
    }

    cache.set(key, list);
    return list;
  };
}