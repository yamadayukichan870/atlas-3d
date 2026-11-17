import type { Block, BlockMap } from './blocks';
import type { Layout } from './layout';
import { SHAPE_INFO, facesOf, quarterOf, type Vec3 } from './shapes';

export interface TerrainRayHit {
  blocked: boolean;
  t: number;
  hitPoint: Vec3 | null;
  hitBlock: Block | null;
}

export type AoEShape = 'line' | 'sphere' | 'cone' | 'cube';

export interface AoECell {
  cx: number;
  cz: number;
  y: number;
}

const EPS = 1e-6;

function intersectAABB(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
): number | null {
  let tMin = 0;
  let tMax = 1;

  const axes: Array<[number, number, number, number]> = [
    [ox, dx, minX, maxX],
    [oy, dy, minY, maxY],
    [oz, dz, minZ, maxZ],
  ];

  for (const [o, d, bMin, bMax] of axes) {
    if (Math.abs(d) < EPS) {
      if (o < bMin || o > bMax) return null;
      continue;
    }
    let t1 = (bMin - o) / d;
    let t2 = (bMax - o) / d;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }

  return tMin <= tMax ? tMin : null;
}

function intersectTriangle(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  a: Vec3, b: Vec3, c: Vec3,
): number | null {
  const e1x = b[0] - a[0];
  const e1y = b[1] - a[1];
  const e1z = b[2] - a[2];
  const e2x = c[0] - a[0];
  const e2y = c[1] - a[1];
  const e2z = c[2] - a[2];

  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-8) return null;

  const invDet = 1 / det;
  const tx = ox - a[0];
  const ty = oy - a[1];
  const tz = oz - a[2];
  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < -1e-5 || u > 1 + 1e-5) return null;

  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * invDet;
  if (v < -1e-5 || u + v > 1 + 1e-5) return null;

  const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  return t > 0.004 && t < 0.996 ? t : null;
}

function intersectBlock(
  block: Block,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  layout: Layout,
  layerHeight: number,
): number | null {
  if (SHAPE_INFO[block.shape].liquid) return null;

  const bx0 = layout.originX + block.x;
  const by0 = (block.y - 1) * layerHeight;
  const bz0 = layout.originZ + block.z;

  if (block.shape === 'Solid' || block.shape === 'Slab') {
    const h = block.shape === 'Slab' ? 0.5 * layerHeight : layerHeight;
    const t = intersectAABB(ox, oy, oz, dx, dy, dz, bx0, by0, bz0, bx0 + 1, by0 + h, bz0 + 1);
    if (t === null || t <= 0.004 || t >= 0.996) return null;
    return t;
  }

  const aabbT = intersectAABB(ox, oy, oz, dx, dy, dz, bx0, by0, bz0, bx0 + 1, by0 + layerHeight, bz0 + 1);
  if (aabbT === null) return null;

  let bestT: number | null = null;
  for (const face of facesOf(block.shape, quarterOf(block.rot))) {
    const tris = face.verts.length === 4 ? [[0, 1, 2], [0, 2, 3]] : [[0, 1, 2]];
    for (const [i0, i1, i2] of tris) {
      const va = face.verts[i0!]!;
      const vb = face.verts[i1!]!;
      const vc = face.verts[i2!]!;
      const a: Vec3 = [bx0 + va[0], by0 + va[1] * layerHeight, bz0 + va[2]];
      const b: Vec3 = [bx0 + vb[0], by0 + vb[1] * layerHeight, bz0 + vb[2]];
      const c: Vec3 = [bx0 + vc[0], by0 + vc[1] * layerHeight, bz0 + vc[2]];
      const t = intersectTriangle(ox, oy, oz, dx, dy, dz, a, b, c);
      if (t !== null && (bestT === null || t < bestT)) bestT = t;
    }
  }
  return bestT;
}

/**
 * Tests whether a 3D segment `[start, end]` is obstructed by any non-liquid block in `map`
 * up to `maxLayer`. Returns the closest hit along the segment.
 */
export function segmentBlockedByTerrain(
  map: BlockMap,
  layout: Layout,
  start: Vec3,
  end: Vec3,
  maxLayer: number = Infinity,
): TerrainRayHit {
  const ox = start[0];
  const oy = start[1];
  const oz = start[2];
  const dx = end[0] - ox;
  const dy = end[1] - oy;
  const dz = end[2] - oz;
  if (dx * dx + dy * dy + dz * dz < 1e-8) {
    return { blocked: false, t: 1, hitPoint: null, hitBlock: null };
  }

  const sx = ox - layout.originX;
  const sz = oz - layout.originZ;
  const ex = end[0] - layout.originX;
  const ez = end[2] - layout.originZ;

  let cx = Math.floor(sx);
  let cz = Math.floor(sz);
  const endCx = Math.floor(ex);
  const endCz = Math.floor(ez);

  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const tDeltaX = Math.abs(dx) > EPS ? Math.abs(1 / dx) : Infinity;
  const tDeltaZ = Math.abs(dz) > EPS ? Math.abs(1 / dz) : Infinity;
  let tMaxX = dx > 0 ? (cx + 1 - sx) / dx : dx < 0 ? (sx - cx) / -dx : Infinity;
  let tMaxZ = dz > 0 ? (cz + 1 - sz) / dz : dz < 0 ? (sz - cz) / -dz : Infinity;

  let bestT = Infinity;
  let bestBlock: Block | null = null;
  const L = map.layerHeight;
  const maxSteps = Math.abs(endCx - cx) + Math.abs(endCz - cz) + 4;

  for (let step = 0; step <= maxSteps; step++) {
    const top = Math.min(map.topLayer(cx, cz), maxLayer);
    for (let y = 1; y <= top; y++) {
      const b = map.get(cx, y, cz);
      if (!b) continue;
      const t = intersectBlock(b, ox, oy, oz, dx, dy, dz, layout, L);
      if (t !== null && t < bestT) {
        bestT = t;
        bestBlock = b;
      }
    }

    if (bestBlock !== null && bestT <= Math.min(tMaxX, tMaxZ)) break;
    if (cx === endCx && cz === endCz) break;

    if (tMaxX < tMaxZ) {
      cx += stepX;
      tMaxX += tDeltaX;
    } else {
      cz += stepZ;
      tMaxZ += tDeltaZ;
    }
  }

  if (bestBlock === null || bestT > 1) {
    return { blocked: false, t: 1, hitPoint: null, hitBlock: null };
  }

  return {
    blocked: true,
    t: bestT,
    hitPoint: [ox + dx * bestT, oy + dy * bestT, oz + dz * bestT],
    hitBlock: bestBlock,
  };
}

/**
 * Collects terrain surface cells inside a 3D AoE volume (`sphere`, `cone`, or `cube`),
 * respecting vertical slice `maxLayer`.
 */
export function collectAoECells(
  shape: Exclude<AoEShape, 'line'>,
  origin: Vec3,
  target: Vec3,
  radiusCells: number,
  map: BlockMap,
  layout: Layout,
  maxLayer: number = Infinity,
  coneHalfAngleRad: number = (53.13 * Math.PI) / 360,
): AoECell[] {
  if (radiusCells <= 0.05) return [];

  const ceilingY = Number.isFinite(maxLayer) ? maxLayer * map.layerHeight : Infinity;
  const out: AoECell[] = [];
  const centerX = shape === 'cube' ? target[0] : origin[0];
  const centerZ = shape === 'cube' ? target[2] : origin[2];
  const halfExtent = shape === 'cube' ? radiusCells * 0.5 : radiusCells;

  const minCx = Math.max(layout.range.cx0, Math.floor(centerX - layout.originX - halfExtent - 1));
  const maxCx = Math.min(layout.range.cx1, Math.ceil(centerX - layout.originX + halfExtent + 1));
  const minCz = Math.max(layout.range.cz0, Math.floor(centerZ - layout.originZ - halfExtent - 1));
  const maxCz = Math.min(layout.range.cz1, Math.ceil(centerZ - layout.originZ + halfExtent + 1));

  const dirX = target[0] - origin[0];
  const dirY = target[1] - origin[1];
  const dirZ = target[2] - origin[2];
  const dirLen = Math.hypot(dirX, dirY, dirZ);
  const cosHalf = Math.cos(coneHalfAngleRad);

  for (let cz = minCz; cz <= maxCz; cz++) {
    for (let cx = minCx; cx <= maxCx; cx++) {
      const wx = layout.originX + cx + 0.5;
      const wz = layout.originZ + cz + 0.5;
      const y = map.surfaceHeightAt(cx + 0.5, cz + 0.5, ceilingY);

      if (shape === 'sphere') {
        const dist = Math.hypot(wx - origin[0], y - origin[1], wz - origin[2]);
        if (dist <= radiusCells + 0.15) out.push({ cx, cz, y });
      } else if (shape === 'cube') {
        const half = radiusCells * 0.5;
        if (
          Math.abs(wx - target[0]) <= half + 0.1
          && Math.abs(wz - target[2]) <= half + 0.1
          && Math.abs(y - target[1]) <= half + 0.5
        ) {
          out.push({ cx, cz, y });
        }
      } else if (dirLen > 1e-4) {
        const vx = wx - origin[0];
        const vy = y - origin[1];
        const vz = wz - origin[2];
        const vLen = Math.hypot(vx, vy, vz);
        if (vLen <= radiusCells + 0.15) {
          if (vLen < 0.35) {
            out.push({ cx, cz, y });
          } else {
            const dot = (vx * dirX + vy * dirY + vz * dirZ) / (vLen * dirLen);
            if (dot >= cosHalf) out.push({ cx, cz, y });
          }
        }
      }
    }
  }

  return out;
}