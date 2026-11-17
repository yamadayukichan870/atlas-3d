import type { Block, BlockMap } from '../terrain/blocks';
import { createColumnFlatSampler, isTopExposed, type ChunkRange, type FlatCellInfo } from '../terrain/flatSurface';
import type { Layout } from '../terrain/layout';
import { SHAPE_INFO, facesOf, quarterOf } from '../terrain/shapes';

export type GridLineType = 'solid' | 'dashed' | 'dotted';

export interface GridLineBuildOptions {
  map: BlockMap;
  layout: Layout;
  lineType: GridLineType;
  maxLayer?: number;
}

const LINE_LIFT = 0.012;
const EPS = 1e-6;
/** 4 clean symmetric dashes per unit cell (dash 0.15, gap 0.10, half-gap at corners). */
const DASH_INTERVALS: readonly (readonly [number, number])[] = [
  [0.05, 0.20],
  [0.30, 0.45],
  [0.55, 0.70],
  [0.80, 0.95],
];
/** Half-arm length of `+` crosshairs in Atlas `Dotted` grid mode. */
const CROSS_ARM = 0.11;

/**
 * Builds deduplicated 3D grid line segments (`solid`, `dashed`, or `dotted` crosshairs) for one chunk,
 * supporting ground floors, floating blocks in mid-air and multi-floor exposed surfaces.
 */
export function buildGridLines(opts: GridLineBuildOptions, range: ChunkRange): Float32Array {
  const { map, layout, lineType } = opts;
  const L = map.layerHeight;
  const { originX: ox, originZ: oz } = layout;
  const maxLayer = opts.maxLayer ?? Infinity;
  const flatListAt = createColumnFlatSampler(map, layout, maxLayer);
  const lines: number[] = [];

  const emitDashedEdge3D = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): void => {
    for (const [t0, t1] of DASH_INTERVALS) {
      lines.push(
        ax + (bx - ax) * t0, ay + (by - ay) * t0, az + (bz - az) * t0,
        ax + (bx - ax) * t1, ay + (by - ay) * t1, az + (bz - az) * t1,
      );
    }
  };

  // Non-flat blocks (Slope, Steps) emit grid lines along their exposed top faces.
  const emitSlopedGrid = (b: Block): void => {
    for (const f of facesOf(b.shape, quarterOf(b.rot))) {
      if (f.role !== 'top') continue;
      for (let i = 0; i < f.verts.length; i++) {
        const a = f.verts[i] as readonly [number, number, number];
        const c = f.verts[(i + 1) % f.verts.length] as readonly [number, number, number];
        const ax = ox + b.x + a[0];
        const ay = (b.y - 1 + a[1]) * L + LINE_LIFT;
        const az = oz + b.z + a[2];
        const cxp = ox + b.x + c[0];
        const cyp = (b.y - 1 + c[1]) * L + LINE_LIFT;
        const czp = oz + b.z + c[2];
        if (lineType === 'dashed') {
          emitDashedEdge3D(ax, ay, az, cxp, cyp, czp);
        } else if (lineType === 'dotted') {
          const t = CROSS_ARM;
          lines.push(
            ax, ay, az, ax + (cxp - ax) * t, ay + (cyp - ay) * t, az + (czp - az) * t,
            cxp, cyp, czp, cxp + (ax - cxp) * t, cyp + (ay - cyp) * t, czp + (az - czp) * t,
          );
        } else {
          lines.push(ax, ay, az, cxp, cyp, czp);
        }
      }
    }
  };

  const flatHeights = new Set<number>();
  for (let cz = range.cz0; cz <= range.cz1; cz++) {
    for (let cx = range.cx0; cx <= range.cx1; cx++) {
      for (const info of flatListAt(cx, cz)) {
        flatHeights.add(Math.round(info.y * 10000) / 10000);
      }
      const top = Math.min(map.topLayer(cx, cz), maxLayer);
      for (let y = 1; y <= top; y++) {
        const b = map.get(cx, y, cz);
        if (!b || SHAPE_INFO[b.shape].liquid || b.shape === 'Solid' || b.shape === 'Slab') continue;
        if (isTopExposed(map, b, maxLayer)) emitSlopedGrid(b);
      }
    }
  }

  const emitDashedX = (cx: number, y: number, z: number, xa: number, xb: number): void => {
    const base = ox + cx;
    for (const [d0, d1] of DASH_INTERVALS) {
      const s = Math.max(xa, base + d0);
      const e = Math.min(xb, base + d1);
      if (e > s + EPS) lines.push(s, y, z, e, y, z);
    }
  };

  const emitDashedZ = (cz: number, y: number, x: number, za: number, zb: number): void => {
    const base = oz + cz;
    for (const [d0, d1] of DASH_INTERVALS) {
      const s = Math.max(za, base + d0);
      const e = Math.min(zb, base + d1);
      if (e > s + EPS) lines.push(x, y, s, x, y, e);
    }
  };

  for (const targetY of flatHeights) {
    const flatAt = (cx: number, cz: number): FlatCellInfo | null => {
      for (const info of flatListAt(cx, cz)) {
        if (Math.abs(info.y - targetY) < EPS) return info;
      }
      return null;
    };

    const emitSupportedCrosshair = (gx: number, gz: number): void => {
      const vx = ox + gx;
      const vz = oz + gz;
      const y = targetY + LINE_LIFT;
      const nw = flatAt(gx - 1, gz - 1);
      const ne = flatAt(gx, gz - 1);
      const sw = flatAt(gx - 1, gz);
      const se = flatAt(gx, gz);

      const supports = (c: FlatCellInfo | null): c is FlatCellInfo =>
        c !== null && vx >= c.x0 - EPS && vx <= c.x1 + EPS && vz >= c.z0 - EPS && vz <= c.z1 + EPS;

      let hx0 = vx;
      let hx1 = vx;
      if (supports(nw)) hx0 = Math.min(hx0, Math.max(vx - CROSS_ARM, nw.x0));
      if (supports(sw)) hx0 = Math.min(hx0, Math.max(vx - CROSS_ARM, sw.x0));
      if (supports(ne)) hx1 = Math.max(hx1, Math.min(vx + CROSS_ARM, ne.x1));
      if (supports(se)) hx1 = Math.max(hx1, Math.min(vx + CROSS_ARM, se.x1));
      if (hx1 > hx0 + EPS) lines.push(hx0, y, vz, hx1, y, vz);

      let vz0 = vz;
      let vz1 = vz;
      if (supports(nw)) vz0 = Math.min(vz0, Math.max(vz - CROSS_ARM, nw.z0));
      if (supports(ne)) vz0 = Math.min(vz0, Math.max(vz - CROSS_ARM, ne.z0));
      if (supports(sw)) vz1 = Math.max(vz1, Math.min(vz + CROSS_ARM, sw.z1));
      if (supports(se)) vz1 = Math.max(vz1, Math.min(vz + CROSS_ARM, se.z1));
      if (vz1 > vz0 + EPS) lines.push(vx, y, vz0, vx, y, vz1);
    };

    if (lineType === 'dotted') {
      for (let cz = range.cz0; cz <= range.cz1; cz++) {
        for (let cx = range.cx0; cx <= range.cx1; cx++) {
          const cur = flatAt(cx, cz);
          if (!cur) continue;
          const east = flatAt(cx + 1, cz);
          const south = flatAt(cx, cz + 1);
          const northEast = flatAt(cx + 1, cz - 1);
          const southEast = flatAt(cx + 1, cz + 1);

          const vx0 = ox + cx;
          const vx1 = ox + cx + 1;
          const vz0 = oz + cz;
          const vz1 = oz + cz + 1;

          const hasTL = Math.abs(cur.x0 - vx0) < EPS && Math.abs(cur.z0 - vz0) < EPS;
          const hasTR = Math.abs(cur.x1 - vx1) < EPS && Math.abs(cur.z0 - vz0) < EPS;
          const hasBL = Math.abs(cur.x0 - vx0) < EPS && Math.abs(cur.z1 - vz1) < EPS;
          const hasBR = Math.abs(cur.x1 - vx1) < EPS && Math.abs(cur.z1 - vz1) < EPS;

          if (hasTL) emitSupportedCrosshair(cx, cz);
          if (hasTR && !east && !northEast) emitSupportedCrosshair(cx + 1, cz);
          if (hasBL && !south) emitSupportedCrosshair(cx, cz + 1);
          if (hasBR && !east && !south && !southEast) emitSupportedCrosshair(cx + 1, cz + 1);
        }
      }
    } else if (lineType === 'dashed') {
      const y = targetY + LINE_LIFT;
      for (let cz = range.cz0; cz <= range.cz1; cz++) {
        for (let cx = range.cx0; cx <= range.cx1; cx++) {
          const cur = flatAt(cx, cz);
          if (!cur) continue;
          const east = flatAt(cx + 1, cz);
          const south = flatAt(cx, cz + 1);

          emitDashedX(cx, y, cur.z0, cur.x0, cur.x1);
          if (!south || Math.abs(south.z0 - cur.z1) > EPS) emitDashedX(cx, y, cur.z1, cur.x0, cur.x1);

          emitDashedZ(cz, y, cur.x0, cur.z0, cur.z1);
          if (!east || Math.abs(east.x0 - cur.x1) > EPS) emitDashedZ(cz, y, cur.x1, cur.z0, cur.z1);
        }
      }
    } else {
      const y = targetY + LINE_LIFT;
      for (let cz = range.cz0; cz <= range.cz1; cz++) {
        let runN: { x0: number; x1: number; z: number } | null = null;
        let runS: { x0: number; x1: number; z: number } | null = null;
        const flushN = (): void => { if (runN) { lines.push(runN.x0, y, runN.z, runN.x1, y, runN.z); runN = null; } };
        const flushS = (): void => { if (runS) { lines.push(runS.x0, y, runS.z, runS.x1, y, runS.z); runS = null; } };

        for (let cx = range.cx0; cx <= range.cx1; cx++) {
          const cur = flatAt(cx, cz);
          if (!cur) { flushN(); flushS(); continue; }

          if (runN && Math.abs(runN.z - cur.z0) < EPS && Math.abs(runN.x1 - cur.x0) < EPS) {
            runN.x1 = cur.x1;
          } else {
            flushN();
            runN = { x0: cur.x0, x1: cur.x1, z: cur.z0 };
          }

          const south = flatAt(cx, cz + 1);
          if (!south || Math.abs(south.z0 - cur.z1) > EPS) {
            if (runS && Math.abs(runS.z - cur.z1) < EPS && Math.abs(runS.x1 - cur.x0) < EPS) {
              runS.x1 = cur.x1;
            } else {
              flushS();
              runS = { x0: cur.x0, x1: cur.x1, z: cur.z1 };
            }
          } else {
            flushS();
          }
        }
        flushN();
        flushS();
      }

      for (let cx = range.cx0; cx <= range.cx1; cx++) {
        let runW: { z0: number; z1: number; x: number } | null = null;
        let runE: { z0: number; z1: number; x: number } | null = null;
        const flushW = (): void => { if (runW) { lines.push(runW.x, y, runW.z0, runW.x, y, runW.z1); runW = null; } };
        const flushE = (): void => { if (runE) { lines.push(runE.x, y, runE.z0, runE.x, y, runE.z1); runE = null; } };

        for (let cz = range.cz0; cz <= range.cz1; cz++) {
          const cur = flatAt(cx, cz);
          if (!cur) { flushW(); flushE(); continue; }

          if (runW && Math.abs(runW.x - cur.x0) < EPS && Math.abs(runW.z1 - cur.z0) < EPS) {
            runW.z1 = cur.z1;
          } else {
            flushW();
            runW = { z0: cur.z0, z1: cur.z1, x: cur.x0 };
          }

          const east = flatAt(cx + 1, cz);
          if (!east || Math.abs(east.x0 - cur.x1) > EPS) {
            if (runE && Math.abs(runE.x - cur.x1) < EPS && Math.abs(runE.z1 - cur.z0) < EPS) {
              runE.z1 = cur.z1;
            } else {
              flushE();
              runE = { z0: cur.z0, z1: cur.z1, x: cur.x1 };
            }
          } else {
            flushE();
          }
        }
        flushW();
        flushE();
      }
    }
  }

  return new Float32Array(lines);
}