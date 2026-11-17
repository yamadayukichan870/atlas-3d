/**
 * Block shapes. Pure data and maths: no three.js, so everything here is tested in Node.
 *
 * A shape is described in a unit cell: x and z in [0, 1], y in [0, 1] as a fraction of one layer.
 * Each face needs only its vertices and its outward normal. Everything else is derived, because
 * hand-written winding order is exactly what went wrong before:
 *   - the vertex order is flipped when needed so the face looks along its normal;
 *   - a face is a "top" (faces up) or a "side" by its normal;
 *   - a face "lies on an edge" when it sits in one of the cell's six boundary planes;
 *   - a shape "occludes" a boundary when its faces there cover the whole square.
 */

export type BlockShape = 'Solid' | 'Slope' | 'Steps' | 'Slab' | 'Liquid';
export const BLOCK_SHAPES: readonly BlockShape[] = ['Solid', 'Slope', 'Steps', 'Slab', 'Liquid'];

export type Vec3 = readonly [number, number, number];
/** Cell boundaries and neighbour directions: +x, -x, +y, -y, +z, -z. */
export type Dir = 0 | 1 | 2 | 3 | 4 | 5;
export const DIR_VECTORS: readonly Vec3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
export const OPPOSITE: readonly Dir[] = [1, 0, 3, 2, 5, 4];
export const DOWN: Dir = 3;
/** Quarter turns about the vertical axis. */
export type Quarter = 0 | 1 | 2 | 3;

export interface Face {
  /** 3 or 4 vertices, counter-clockwise seen from outside. */
  readonly verts: readonly Vec3[];
  /** Unit normal, pointing out of the shape. */
  readonly normal: Vec3;
  readonly role: 'top' | 'side';
  /** The cell boundary this face lies in, or null when it is inside the cell. */
  readonly edge: Dir | null;
}

export interface ShapeInfo {
  readonly liquid: boolean;
  /** Fraction of a layer a token stands at, at the middle of the cell. */
  readonly walk: number;
  /** Fraction of a layer reached by the shape's highest point. */
  readonly topPlane: number;
}

export const SHAPE_INFO: Readonly<Record<BlockShape, ShapeInfo>> = {
  Solid: { liquid: false, walk: 1, topPlane: 1 },
  Slab: { liquid: false, walk: 0.5, topPlane: 0.5 },
  Liquid: { liquid: true, walk: 0.85, topPlane: 0.85 },
  Slope: { liquid: false, walk: 0.5, topPlane: 1 },
  Steps: { liquid: false, walk: 0.75, topPlane: 1 },
};

// ---- small vector helpers ------------------------------------------------------------------

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };

/** Area of a planar polygon given in order (fan of triangles from the first vertex). */
export function polygonArea(verts: readonly Vec3[]): number {
  let area = 0;
  for (let i = 1; i + 1 < verts.length; i++) {
    const c = cross(sub(verts[i] as Vec3, verts[0] as Vec3), sub(verts[i + 1] as Vec3, verts[0] as Vec3));
    area += Math.hypot(c[0], c[1], c[2]) / 2;
  }
  return area;
}

// ---- building faces --------------------------------------------------------------------------

function detectEdge(verts: readonly Vec3[], n: Vec3): Dir | null {
  for (let axis = 0; axis < 3; axis++) {
    if (n[axis] === 1 && verts.every((v) => v[axis] === 1)) return (axis * 2) as Dir;
    if (n[axis] === -1 && verts.every((v) => v[axis] === 0)) return (axis * 2 + 1) as Dir;
  }
  return null;
}

/** A face from vertices in any order and its outward normal; the order is fixed up to match. */
function face(verts: Vec3[], normal: Vec3): Face {
  const n = unit(normal);
  const winding = cross(sub(verts[1] as Vec3, verts[0] as Vec3), sub(verts[2] as Vec3, verts[0] as Vec3));
  const ordered = dot(winding, n) > 0 ? verts : [...verts].reverse();
  return { verts: ordered, normal: n, role: n[1] > 0.5 ? 'top' : 'side', edge: detectEdge(ordered, n) };
}

function box(h: number, withBottom: boolean): Face[] {
  const faces = [
    face([[1, 0, 0], [1, 0, 1], [1, h, 1], [1, h, 0]], [1, 0, 0]),
    face([[0, 0, 0], [0, 0, 1], [0, h, 1], [0, h, 0]], [-1, 0, 0]),
    face([[0, h, 0], [1, h, 0], [1, h, 1], [0, h, 1]], [0, 1, 0]),
    face([[0, 0, 1], [1, 0, 1], [1, h, 1], [0, h, 1]], [0, 0, 1]),
    face([[0, 0, 0], [1, 0, 0], [1, h, 0], [0, h, 0]], [0, 0, -1]),
  ];
  if (withBottom) faces.push(face([[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], [0, -1, 0]));
  return faces;
}

const BASE: Readonly<Record<BlockShape, readonly Face[]>> = {
  Solid: box(1, true),
  Slab: box(0.5, true),
  // Water has an underside too: with none, looking through it you would see the empty background.
  Liquid: box(0.85, true),
  // Rises towards +z: the back wall (z = 1) is full height.
  Slope: [
    face([[0, 0, 0], [1, 0, 0], [1, 1, 1], [0, 1, 1]], [0, 1, -1]),
    face([[0, 0, 1], [0, 1, 1], [1, 1, 1], [1, 0, 1]], [0, 0, 1]),
    face([[0, 0, 0], [0, 0, 1], [0, 1, 1]], [-1, 0, 0]),
    face([[1, 0, 0], [1, 1, 1], [1, 0, 1]], [1, 0, 0]),
    face([[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], [0, -1, 0]),
  ],
  // Two treads: a low one in front (top at half a layer), a high one behind (a full layer).
  Steps: [
    face([[0, 0.5, 0], [1, 0.5, 0], [1, 0.5, 0.5], [0, 0.5, 0.5]], [0, 1, 0]),
    face([[0, 1, 0.5], [1, 1, 0.5], [1, 1, 1], [0, 1, 1]], [0, 1, 0]),
    face([[0, 0, 0], [1, 0, 0], [1, 0.5, 0], [0, 0.5, 0]], [0, 0, -1]),
    face([[0, 0.5, 0.5], [1, 0.5, 0.5], [1, 1, 0.5], [0, 1, 0.5]], [0, 0, -1]),
    face([[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], [0, 0, 1]),
    face([[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], [0, -1, 0]),
    face([[0, 0, 0], [0, 0, 1], [0, 0.5, 1], [0, 0.5, 0]], [-1, 0, 0]),
    face([[0, 0.5, 0.5], [0, 0.5, 1], [0, 1, 1], [0, 1, 0.5]], [-1, 0, 0]),
    face([[1, 0, 0], [1, 0, 1], [1, 0.5, 1], [1, 0.5, 0]], [1, 0, 0]),
    face([[1, 0.5, 0.5], [1, 0.5, 1], [1, 1, 1], [1, 1, 0.5]], [1, 0, 0]),
  ],
};

// ---- rotation ---------------------------------------------------------------------------------

const COS = [1, 0, -1, 0] as const;
const SIN = [0, 1, 0, -1] as const;

/** The same rotation as three.js `rotation.y`, about the cell's centre column. */
function turnPoint(p: Vec3, q: Quarter): Vec3 {
  const dx = p[0] - 0.5;
  const dz = p[2] - 0.5;
  return [0.5 + dx * COS[q] + dz * SIN[q], p[1], 0.5 - dx * SIN[q] + dz * COS[q]];
}
const turnNormal = (n: Vec3, q: Quarter): Vec3 => [n[0] * COS[q] + n[2] * SIN[q], n[1], -n[0] * SIN[q] + n[2] * COS[q]];

const ROTATED: Record<BlockShape, readonly (readonly Face[])[]> = {} as never;
const OCCLUDES: Record<BlockShape, readonly number[]> = {} as never;

for (const shape of BLOCK_SHAPES) {
  const turned: Face[][] = [];
  const masks: number[] = [];
  for (const q of [0, 1, 2, 3] as const) {
    const faces = (BASE[shape] as readonly Face[]).map((f) => face(f.verts.map((v) => turnPoint(v, q)), turnNormal(f.normal, q)));
    turned.push(faces);
    let mask = 0;
    if (!SHAPE_INFO[shape].liquid) {
      for (const dir of [0, 1, 2, 3, 4, 5] as const) {
        const covered = faces.filter((f) => f.edge === dir).reduce((sum, f) => sum + polygonArea(f.verts), 0);
        if (Math.abs(covered - 1) < 1e-9) mask |= 1 << dir;
      }
    }
    masks.push(mask);
  }
  ROTATED[shape] = turned;
  OCCLUDES[shape] = masks;
}

/** The faces of a shape turned by `q` quarter turns. */
export function facesOf(shape: BlockShape, q: Quarter): readonly Face[] {
  return (ROTATED[shape] as readonly (readonly Face[])[])[q] as readonly Face[];
}

/** Whether a shape turned by `q` fully covers the cell boundary `dir` (so it hides a neighbour's face there). */
export function occludes(shape: BlockShape, q: Quarter, dir: Dir): boolean {
  return (((OCCLUDES[shape] as readonly number[])[q] as number) >> dir & 1) === 1;
}

export function quarterOf(rotation: number): Quarter {
  return ((((Math.round(rotation / 90) % 4) + 4) % 4) as Quarter);
}

/** A point of the unit cell given in a turned shape's frame, brought back to the shape's own frame. */
export function unturnPoint(u: number, v: number, q: Quarter): [number, number] {
  const back = ((4 - q) % 4) as Quarter;
  const p = turnPoint([u, 0, v], back);
  return [p[0], p[2]];
}

/**
 * How high a shape's surface is, as a fraction of a layer, at the point (u, v) of its cell, where u runs
 * along x and v along z (both 0..1) and the shape is turned by `q` quarters. Flat shapes are flat; a
 * ramp rises in a straight line; steps are two levels.
 */
export function surfaceFraction(shape: BlockShape, q: Quarter, u: number, v: number): number {
  const lv = unturnPoint(u, v, q)[1];
  if (shape === 'Slope') return Math.min(1, Math.max(0, lv));
  if (shape === 'Steps') return lv < 0.5 ? 0.5 : 1;
  return SHAPE_INFO[shape].topPlane;
}

/** The outward normal of a ramp turned by `q` quarters: what a token standing on it should lean to. */
export function rampNormal(q: Quarter): Vec3 {
  const ramp = facesOf('Slope', q).find((f) => f.role === 'top');
  return ramp ? ramp.normal : [0, 1, 0];
}

/**
 * A face's normal once a layer is `layerHeight` cells tall instead of one. Shapes are defined in a unit cell,
 * so a ramp's slope there is 45 degrees; stretching the cell vertically changes its slope, and so its normal,
 * (a half-height layer makes it 26.6 degrees). Axis-aligned faces are unchanged.
 */
export function scaleNormal(n: Vec3, layerHeight: number): Vec3 {
  if (!(layerHeight > 0) || layerHeight === 1) return n;
  const y = n[1] / layerHeight;
  const length = Math.hypot(n[0], y, n[2]);
  return [n[0] / length, y / length, n[2] / length];
}

