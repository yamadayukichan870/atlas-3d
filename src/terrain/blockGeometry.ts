import type { Block, BlockMap } from './blocks';
import { insideBounds, type ChunkRange } from './flatSurface';
import type { Layout } from './layout';
import { DIR_VECTORS, DOWN, OPPOSITE, SHAPE_INFO, facesOf, occludes, quarterOf, scaleNormal, type Dir } from './shapes';

/**
 * Builds terrain vertex buffers (floors, blocks, water, and full Minecraft-style block outlines `edges`)
 * per 16x16 chunk. Pure (no three.js, no DOM).
 */

export interface TerrainBuildOptions {
  map: BlockMap;
  layout: Layout;
  /** Show the map image on up-facing faces (needs `layout.uv`). */
  useImage: boolean;
  /** Alternate the shade of neighbouring blocks, so single blocks read in a flat colour field. */
  checker: boolean;
  /** Optional ceiling layer for vertical cutaways (blocks above this layer are omitted). */
  maxLayer?: number;
}

export interface TerrainChunkBuffers {
  tops: { positions: Float32Array; normals: Float32Array; uvs: Float32Array };
  solid: { positions: Float32Array; normals: Float32Array; colors: Float32Array };
  liquid: { positions: Float32Array; normals: Float32Array; colors: Float32Array };
  edges: Float32Array;
}

interface PendingEdge {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  nx: number; ny: number; nz: number;
}

const CHECKER_DARK = 0.82;
/** Outward offset along averaged face normal so block edges never z-fight and stay below `LINE_LIFT` (0.012). */
const EDGE_OFFSET = 0.005;
/** Water with no colour of its own. It is one colour all round, not grass on top and soil at the sides. */
export const WATER_COLOR = '#0284C7';

const linear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const cache = new Map<string, readonly [number, number, number]>();

/** `#rrggbb` as linear RGB, which is what vertex colours are read as. */
export function hexToLinear(hex: string): readonly [number, number, number] {
  let rgb = cache.get(hex);
  if (!rgb) {
    const n = Number.parseInt(hex.slice(1), 16);
    rgb = [linear(((n >> 16) & 255) / 255), linear(((n >> 8) & 255) / 255), linear((n & 255) / 255)];
    cache.set(hex, rgb);
  }
  return rgb;
}

const qKey = (n: number): number => Math.round(n * 10000);

function edgeKey(ax: number, ay: number, az: number, bx: number, by: number, bz: number): string {
  const ka = `${qKey(ax)},${qKey(ay)},${qKey(az)}`;
  const kb = `${qKey(bx)},${qKey(by)},${qKey(bz)}`;
  return ka <= kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

export function buildTerrainChunk(opts: TerrainBuildOptions, range: ChunkRange): TerrainChunkBuffers {
  const { map, layout } = opts;
  const L = map.layerHeight;
  const { originX: ox, originZ: oz, bounds, uv } = layout;
  const image = opts.useImage && uv !== null ? uv : null;
  const maxLayer = opts.maxLayer ?? Infinity;

  const topPos: number[] = [];
  const topNorm: number[] = [];
  const topUv: number[] = [];
  const solid = { p: [] as number[], n: [] as number[], c: [] as number[] };
  const liquid = { p: [] as number[], n: [] as number[], c: [] as number[] };
  const edgeMap = new Map<string, PendingEdge>();

  const blockAt = (x: number, y: number, z: number): Block | undefined => (y <= maxLayer ? map.get(x, y, z) : undefined);
  const shade = (x: number, y: number, z: number): number => (((x + y + z) % 2 + 2) % 2 === 0 || !opts.checker ? 1 : CHECKER_DARK);

  /** A floor quad where a column has nothing on the ground, clipped to the map's area. */
  const floor = (cx: number, cz: number): void => {
    const x0 = Math.max(ox + cx, bounds.x0);
    const x1 = Math.min(ox + cx + 1, bounds.x1);
    const z0 = Math.max(oz + cz, bounds.z0);
    const z1 = Math.min(oz + cz + 1, bounds.z1);
    if (x1 <= x0 || z1 <= z0) return;
    const quad: [number, number][] = [[x0, z0], [x0, z1], [x1, z1], [x0, z0], [x1, z1], [x1, z0]];
    for (const [x, z] of quad) {
      if (image) {
        topPos.push(x, 0, z);
        topNorm.push(0, 1, 0);
        topUv.push(x / image.w, 1 - z / image.h);
      } else {
        const rgb = hexToLinear(map.preset.top);
        const k = shade(cx, 0, cz);
        solid.p.push(x, 0, z);
        solid.n.push(0, 1, 0);
        solid.c.push(rgb[0] * k, rgb[1] * k, rgb[2] * k);
      }
    }
  };

  const hidden = (b: Block, edge: Dir, neighbour: Block | undefined): boolean => {
    if (!neighbour) return false;
    // Water against water shows no wall between the two.
    if (SHAPE_INFO[b.shape].liquid && SHAPE_INFO[neighbour.shape].liquid) return true;
    return occludes(neighbour.shape, quarterOf(neighbour.rot), OPPOSITE[edge] as Dir);
  };

  const addBlockEdge = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    nx: number, ny: number, nz: number,
  ): void => {
    const key = edgeKey(ax, ay, az, bx, by, bz);
    const existing = edgeMap.get(key);
    if (existing) {
      existing.nx += nx;
      existing.ny += ny;
      existing.nz += nz;
    } else {
      edgeMap.set(key, { ax, ay, az, bx, by, bz, nx, ny, nz });
    }
  };

  const emit = (b: Block): void => {
    const isLiquid = SHAPE_INFO[b.shape].liquid;
    const k = shade(b.x, b.y, b.z);

    for (const f of facesOf(b.shape, quarterOf(b.rot))) {
      if (f.edge !== null) {
        if (f.edge === DOWN && b.y === 1 && !isLiquid) continue;
        const d = DIR_VECTORS[f.edge] as readonly [number, number, number];
        if (hidden(b, f.edge, blockAt(b.x + d[0], b.y + d[1], b.z + d[2]))) continue;
      }
      const toImage = !isLiquid && f.role === 'top' && image !== null;
      const normal = scaleNormal(f.normal, L);
      const water = b.top ?? WATER_COLOR;
      const rgb = hexToLinear(isLiquid ? (f.role === 'top' ? water : (b.side ?? water))
        : f.role === 'top' ? (b.top ?? map.preset.top) : (b.side ?? map.preset.side));
      const out = isLiquid ? liquid : solid;

      for (const i of f.verts.length === 4 ? [0, 1, 2, 0, 2, 3] : [0, 1, 2]) {
        const v = f.verts[i] as readonly [number, number, number];
        const x = ox + b.x + v[0];
        const y = (b.y - 1 + v[1]) * L;
        const z = oz + b.z + v[2];
        if (toImage && image) {
          topPos.push(x, y, z);
          topNorm.push(normal[0], normal[1], normal[2]);
          topUv.push(x / image.w, 1 - z / image.h);
        } else {
          out.p.push(x, y, z);
          out.n.push(normal[0], normal[1], normal[2]);
          out.c.push(rgb[0] * k, rgb[1] * k, rgb[2] * k);
        }
      }

      // Minecraft-style complete block outlines across all exposed faces (top, sides and base).
      if (!isLiquid) {
        for (let i = 0; i < f.verts.length; i++) {
          const a = f.verts[i] as readonly [number, number, number];
          const c = f.verts[(i + 1) % f.verts.length] as readonly [number, number, number];
          addBlockEdge(
            ox + b.x + a[0], (b.y - 1 + a[1]) * L, oz + b.z + a[2],
            ox + b.x + c[0], (b.y - 1 + c[1]) * L, oz + b.z + c[2],
            normal[0], normal[1], normal[2],
          );
        }
      }
    }
  };

  for (let cz = range.cz0; cz <= range.cz1; cz++) {
    for (let cx = range.cx0; cx <= range.cx1; cx++) {
      const top = Math.min(map.topLayer(cx, cz), maxLayer);
      if (insideBounds(layout, cx, cz) && !blockAt(cx, 1, cz)) floor(cx, cz);
      for (let y = 1; y <= top; y++) {
        const b = blockAt(cx, y, cz);
        if (b) emit(b);
      }
    }
  }

  const edges: number[] = [];
  for (const e of edgeMap.values()) {
    const len = Math.hypot(e.nx, e.ny, e.nz) || 1;
    const oxn = (e.nx / len) * EDGE_OFFSET;
    const oyn = (e.ny / len) * EDGE_OFFSET;
    const ozn = (e.nz / len) * EDGE_OFFSET;
    edges.push(e.ax + oxn, e.ay + oyn, e.az + ozn, e.bx + oxn, e.by + oyn, e.bz + ozn);
  }

  return {
    tops: { positions: new Float32Array(topPos), normals: new Float32Array(topNorm), uvs: new Float32Array(topUv) },
    solid: { positions: new Float32Array(solid.p), normals: new Float32Array(solid.n), colors: new Float32Array(solid.c) },
    liquid: { positions: new Float32Array(liquid.p), normals: new Float32Array(liquid.n), colors: new Float32Array(liquid.c) },
    edges: new Float32Array(edges),
  };
}