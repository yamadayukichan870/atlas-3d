import type { Vec3 } from './shapes';

/** Picking maths for building: which block a ray hit, and which cell a new block goes in. */

export interface BlockRef { x: number; y: number; z: number }
export interface PlacementGrid { originX: number; originZ: number; layerHeight: number }

/** How far a hit point is pushed back into the surface, in cells, to find the block that owns it. */
const NUDGE = 1e-3;

/** The block cell containing a surface hit (it may be empty ground: layer 0 means "the floor"). */
export function blockAtHit(point: Vec3, normal: Vec3, grid: PlacementGrid): BlockRef {
  const x = point[0] - normal[0] * NUDGE;
  const y = point[1] - normal[1] * NUDGE;
  const z = point[2] - normal[2] * NUDGE;
  return {
    x: Math.floor(x - grid.originX),
    y: Math.floor(y / grid.layerHeight) + 1,
    z: Math.floor(z - grid.originZ),
  };
}

/** The cell next to the hit face, on the side the face looks to: where "add" puts a block. */
export function placementCell(point: Vec3, normal: Vec3, grid: PlacementGrid): BlockRef {
  const hit = blockAtHit(point, normal, grid);
  const ax = Math.abs(normal[0]);
  const ay = Math.abs(normal[1]);
  const az = Math.abs(normal[2]);
  // Sloped faces (ramps) count as the floor of the block: they place on top.
  if (ay >= ax && ay >= az) return { ...hit, y: hit.y + Math.sign(normal[1]) };
  if (ax >= az) return { ...hit, x: hit.x + Math.sign(normal[0]) };
  return { ...hit, z: hit.z + Math.sign(normal[2]) };
}
