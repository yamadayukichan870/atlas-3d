import type { BlockMap } from '../terrain/blocks';
import { createColumnFlatSampler, insideBounds, isTopExposed, type ChunkRange } from '../terrain/flatSurface';
import type { Layout } from '../terrain/layout';
import { SHAPE_INFO, quarterOf, surfaceFraction } from '../terrain/shapes';

export type CellNumberMode = 'off' | 'col-row' | 'sequential' | 'a1';

export const GLYPH_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const GLYPH_ATLAS_COLS = 16;
export const GLYPH_ATLAS_ROWS = 3;

export interface CellNumberBuildOptions {
  map: BlockMap;
  layout: Layout;
  mode: CellNumberMode;
  maxLayer?: number;
}

const NUMBER_LIFT = 0.015;

function colToLetters(col1: number): string {
  let n = col1;
  let out = '';
  while (n > 0) {
    n--;
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

export function formatCellLabel(cx: number, cz: number, layout: Layout, mode: CellNumberMode): string {
  if (mode === 'off') return '';
  const col0 = cx - layout.range.cx0;
  const row0 = cz - layout.range.cz0;
  if (col0 < 0 || row0 < 0) return '';
  const col1 = col0 + 1;
  const row1 = row0 + 1;
  if (mode === 'col-row') return `${String(col1).padStart(2, '0')}${String(row1).padStart(2, '0')}`;
  if (mode === 'sequential') {
    const cols = layout.range.cx1 - layout.range.cx0 + 1;
    return String(row0 * cols + col0 + 1);
  }
  return `${colToLetters(col1)}${row1}`;
}

export function buildCellNumbers(
  opts: CellNumberBuildOptions,
  range: ChunkRange,
): { positions: Float32Array; uvs: Float32Array } {
  const { map, layout, mode } = opts;
  if (mode === 'off') return { positions: new Float32Array(0), uvs: new Float32Array(0) };

  const L = map.layerHeight;
  const { originX: ox, originZ: oz } = layout;
  const maxLayer = opts.maxLayer ?? Infinity;
  const flatListAt = createColumnFlatSampler(map, layout, maxLayer);

  const positions: number[] = [];
  const uvs: number[] = [];

  const emitLabel = (cx: number, cz: number, yAt: (x: number, z: number) => number): void => {
    const text = formatCellLabel(cx, cz, layout, mode);
    if (!text) return;
    const centerX = ox + cx + 0.5;
    const centerZ = oz + cz + 0.18;
    const baseCharW = 0.145;
    const baseCharH = 0.21;
    const scale = Math.min(1, 0.78 / (text.length * baseCharW));
    const cw = baseCharW * scale;
    const ch = baseCharH * scale;
    const startX = centerX - (text.length * cw) / 2;
    const z0 = centerZ - ch / 2;
    const z1 = centerZ + ch / 2;

    for (let i = 0; i < text.length; i++) {
      const idx = GLYPH_CHARS.indexOf(text[i] as string);
      if (idx < 0) continue;
      const col = idx % GLYPH_ATLAS_COLS;
      const row = Math.floor(idx / GLYPH_ATLAS_COLS);
      const u0 = col / GLYPH_ATLAS_COLS;
      const u1 = (col + 1) / GLYPH_ATLAS_COLS;
      const v1 = 1 - row / GLYPH_ATLAS_ROWS;
      const v0 = 1 - (row + 1) / GLYPH_ATLAS_ROWS;

      const x0 = startX + i * cw;
      const x1 = x0 + cw;
      const yTL = yAt(x0, z0) + NUMBER_LIFT;
      const yBL = yAt(x0, z1) + NUMBER_LIFT;
      const yBR = yAt(x1, z1) + NUMBER_LIFT;
      const yTR = yAt(x1, z0) + NUMBER_LIFT;

      positions.push(
        x0, yTL, z0, x0, yBL, z1, x1, yBR, z1,
        x0, yTL, z0, x1, yBR, z1, x1, yTR, z0,
      );
      uvs.push(
        u0, v1, u0, v0, u1, v0,
        u0, v1, u1, v0, u1, v1,
      );
    }
  };

  for (let cz = range.cz0; cz <= range.cz1; cz++) {
    for (let cx = range.cx0; cx <= range.cx1; cx++) {
      if (!insideBounds(layout, cx, cz)) continue;

      for (const info of flatListAt(cx, cz)) {
        if ((info.x1 - info.x0) >= 0.45 && (info.z1 - info.z0) >= 0.45) {
          emitLabel(cx, cz, () => info.y);
        }
      }

      const top = Math.min(map.topLayer(cx, cz), maxLayer);
      for (let y = 1; y <= top; y++) {
        const b = map.get(cx, y, cz);
        if (!b || SHAPE_INFO[b.shape].liquid || b.shape === 'Solid' || b.shape === 'Slab') continue;
        if (!isTopExposed(map, b, maxLayer)) continue;
        const q = quarterOf(b.rot);
        if (b.shape === 'Slope') {
          emitLabel(cx, cz, (x, z) => (b.y - 1 + surfaceFraction('Slope', q, x - ox - b.x, z - oz - b.z)) * L);
        } else if (b.shape === 'Steps') {
          const yConst = (b.y - 1 + surfaceFraction('Steps', q, 0.5, 0.18)) * L;
          emitLabel(cx, cz, () => yConst);
        }
      }
    }
  }

  return { positions: new Float32Array(positions), uvs: new Float32Array(uvs) };
}