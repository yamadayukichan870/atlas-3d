/**
 * The geometry of a measured area, and which terrain cells and tokens it covers.
 *
 * Semantics verified first-hand against atlas-vtt/atlas-vtt @ tag 0.16.0:
 *   src/app/measure/measureGeometry.ts -> `box()` in full, `shapedArea()` in full,
 *       `EDGE_TOLERANCE`, and the `ShapedArea` / `AreaShapeRules` contracts.
 *   src/app/measure/areaRules.ts       -> in full, including what `flat` and `round` mean.
 *   src/app/measure/rangeOutline.ts    -> `MAX_RANGE_CELLS` and how an outline is built.
 *
 * The bodies of Atlas' `cone()` and `circle()` were elided by the extractor, so their shape is
 * taken from their own doc comments, read literally:
 *   "round on the arc as far from its apex as it is long"        -> reach = length
 *   "flat on a straight side across the drag at the drag's length (a triangle)"
 *                                                                -> reach = length / cos(half)
 *   "A cone that opens half a turn or more has no flat end and is round whatever this says."
 * The >= 360 branch (a full turn is a circle) is forced by geometry, not quoted.
 * `MAX_AREA_CELLS` and the curve sagitta come from an earlier verified reading of
 * measureCells.ts; they are safety valves, not parity rules, and are marked as such below.
 *
 * World convention is Atlas 3D's: x/z are the plan, y is up, one grid cell spans one world unit.
 * Atlas works in world pixels with y down; only the plan carries over. Areas are plan figures —
 * as they are in Atlas — and are projected onto every exposed terrain surface under the slice.
 * A sphere is offered separately (`cellsInSphere`) because that is still an open choice, not
 * Atlas parity.
 *
 * Pure: no three.js, no DOM. Tested in Node.
 */

import type { BlockMap, Rotation } from './blocks';
import type { Layout } from './layout';
import { createColumnFlatSampler, isTopExposed } from './flatSurface';
import { SHAPE_INFO, quarterOf, surfaceFraction, type BlockShape } from './shapes';
import {
  EDGE_TOLERANCE,
  MAX_RANGE_CELLS,
  cellsByRule,
  type AtlasAreaShapeRules,
  type AtlasCellRule,
  type AtlasDiagonalRule,
  type AtlasMeasureShape,
} from '../atlas/measureRules';

// ---------------------------------------------------------------------------
// Plan types
// ---------------------------------------------------------------------------

/** A point in the plan, in world units. */
export interface PlanPoint { readonly x: number; readonly z: number }

/** A closed ring of plan corners; the last joins the first. */
export type PlanRing = readonly PlanPoint[];

/** A grid cell by index. */
export interface PlanCell { readonly cx: number; readonly cz: number }

/**
 * An area as its measurement shapes it, before anything cuts it.
 * Rings are wound so their shoelace sum in (x, z) is positive; the clipper below relies on it.
 */
export interface PlanArea {
  readonly shape: Exclude<AtlasMeasureShape, 'ruler'>;
  readonly origin: PlanPoint;
  /** The direction it was dragged in, one unit long. */
  readonly towards: PlanPoint;
  /** How far the drag reaches over the plan. */
  readonly length: number;
  /** How far from the origin its farthest point lies. */
  readonly reach: number;
  readonly rings: readonly PlanRing[];
  /** A line's middle line, from its origin to its end. Other areas have none. */
  readonly spine?: readonly [PlanPoint, PlanPoint];
  /** Whether a plan point lies in the area, its edge included. */
  contains(point: PlanPoint): boolean;
}

/** One covered piece of terrain: a cell, on one of its exposed surfaces. */
export interface AreaCell {
  readonly cx: number;
  readonly cz: number;
  /** The surface's height at the middle of the covered rectangle, in world units. */
  readonly y: number;
  /** The covered rectangle in world units: a whole cell, or the part of it the map holds. */
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
  /** Present when the surface is a ramp or steps, so a caller can drape a quad over it. */
  readonly slope?: { readonly shape: BlockShape; readonly rot: Rotation };
}

/** A token as an area reads it: where it stands and how much room it takes. */
export interface AreaTokenTarget {
  readonly id: string;
  /** Centre of its footprint, in world units over the plan. */
  readonly x: number;
  readonly z: number;
  /** Footprint in cells: 1, 2, 3, 4 as Atlas sizes give them. */
  readonly diameter: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The most cells one area may hold before it is not counted at all. A safety valve from
 * Atlas' measureCells.ts, carried from an earlier reading; a damaged rule must not hang a frame.
 */
const MAX_AREA_CELLS = 65_536;

/**
 * How far the polygon standing in for a curve may fall inside it, in cells. Atlas holds a
 * quarter of a world pixel; at its usual 50 pixels to a cell that is this. Only the polygon
 * is approximate — `contains` is exact.
 */
const CURVE_SAGITTA = 0.005;
const MIN_CURVE_SEGMENTS = 32;
const MAX_CURVE_SEGMENTS = 128;

/** An area of clipped polygon below this is nothing. */
const AREA_EPSILON = 1e-9;
/** Two crossings this close together are one crossing, on a corner. */
const SPINE_TIE = 1e-9;

/** Heights are grouped the way the grid groups them, so fills land on the same planes. */
const heightKey = (y: number): number => Math.round(y * 10000);
const cornerKey = (p: PlanPoint): string => `${Math.round(p.x * 1e6)},${Math.round(p.z * 1e6)}`;
const cellKey = (cx: number, cz: number): string => `${cx},${cz}`;

// ---------------------------------------------------------------------------
// Plan arithmetic
// ---------------------------------------------------------------------------

const sub = (a: PlanPoint, b: PlanPoint): PlanPoint => ({ x: a.x - b.x, z: a.z - b.z });
const dot = (a: PlanPoint, b: PlanPoint): number => a.x * b.x + a.z * b.z;
const cross = (a: PlanPoint, b: PlanPoint): number => a.x * b.z - a.z * b.x;
const norm = (a: PlanPoint): number => Math.hypot(a.x, a.z);

/** Half the shoelace sum: positive for the winding this module uses. */
function signedArea(ring: PlanRing): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    sum += a.x * b.z - b.x * a.z;
  }
  return sum / 2;
}

function wound(ring: readonly PlanPoint[]): PlanPoint[] {
  return signedArea(ring) < 0 ? [...ring].reverse() : [...ring];
}

/** Whether every turn of the ring goes the same way, so it can be clipped against directly. */
function isConvex(ring: PlanRing): boolean {
  let sign = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const c = ring[(i + 2) % ring.length]!;
    const turn = cross(sub(b, a), sub(c, b));
    if (Math.abs(turn) < AREA_EPSILON) continue;
    const now = turn > 0 ? 1 : -1;
    if (sign === 0) sign = now;
    else if (sign !== now) return false;
  }
  return true;
}

interface Bounds { x0: number; x1: number; z0: number; z1: number }

function ringsBounds(rings: readonly PlanRing[]): Bounds {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.z < z0) z0 = p.z;
      if (p.z > z1) z1 = p.z;
    }
  }
  return { x0, x1, z0, z1 };
}

function rectRing(x0: number, z0: number, x1: number, z1: number): PlanPoint[] {
  return [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];
}

/**
 * How many sides the polygon standing in for an arc needs, in eights as Atlas keeps them,
 * so that it never falls further inside the curve than the sagitta.
 */
function curveSegments(radius: number, turnFraction: number): number {
  if (!(radius > CURVE_SAGITTA)) return MIN_CURVE_SEGMENTS;
  const ratio = Math.min(1, Math.max(-1, 1 - CURVE_SAGITTA / radius));
  const perTurn = ratio <= -1 ? 2 : Math.PI / Math.acos(ratio);
  const wanted = Math.ceil((perTurn * Math.max(turnFraction, 1 / 8)) / 8) * 8;
  return Math.min(MAX_CURVE_SEGMENTS, Math.max(MIN_CURVE_SEGMENTS, wanted));
}

// ---------------------------------------------------------------------------
// The shapes
// ---------------------------------------------------------------------------

/**
 * A box from the middle of its near side, `length` along `towards` and `halfWidth` to either
 * side. This is Atlas' anchoring: a square is as long and as wide as the drag, and a line is
 * as long as the drag and its width wide.
 */
function boxArea(
  shape: 'square' | 'line',
  origin: PlanPoint,
  towards: PlanPoint,
  length: number,
  halfWidth: number,
): PlanArea | null {
  if (!(halfWidth > 0) || !Number.isFinite(halfWidth)) return null;
  const side: PlanPoint = { x: -towards.z * halfWidth, z: towards.x * halfWidth };
  const far: PlanPoint = { x: origin.x + towards.x * length, z: origin.z + towards.z * length };
  const ring = wound([
    { x: origin.x - side.x, z: origin.z - side.z },
    { x: origin.x + side.x, z: origin.z + side.z },
    { x: far.x + side.x, z: far.z + side.z },
    { x: far.x - side.x, z: far.z - side.z },
  ]);
  return {
    shape,
    origin,
    towards,
    length,
    reach: Math.hypot(length, halfWidth),
    rings: [ring],
    contains: (point) => {
      const v = sub(point, origin);
      const along = dot(v, towards);
      return along >= -EDGE_TOLERANCE
        && along <= length + EDGE_TOLERANCE
        && Math.abs(cross(v, towards)) <= halfWidth + EDGE_TOLERANCE;
    },
  };
}

/** A circle around its origin, as far as its end. Its direction only says which way it was dragged. */
function circleArea(
  shape: 'circle' | 'cone',
  origin: PlanPoint,
  towards: PlanPoint,
  radius: number,
): PlanArea {
  const segments = curveSegments(radius, 1);
  const ring: PlanPoint[] = [];
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    ring.push({ x: origin.x + Math.cos(angle) * radius, z: origin.z + Math.sin(angle) * radius });
  }
  return {
    shape,
    origin,
    towards,
    length: radius,
    reach: radius,
    rings: [wound(ring)],
    contains: (point) => norm(sub(point, origin)) <= radius + EDGE_TOLERANCE,
  };
}

/**
 * A cone from its origin towards its end, as long as the drag, opening `angle` degrees in all.
 * A cone that opens half a turn or more has no flat end and is round whatever `end` says; a
 * full turn is a circle.
 */
function coneArea(
  origin: PlanPoint,
  towards: PlanPoint,
  length: number,
  angle: number,
  end: AtlasAreaShapeRules['coneEnd'],
): PlanArea {
  if (!(angle > 0) || angle >= 360) return circleArea('cone', origin, towards, length);
  const half = (angle * Math.PI) / 360;
  const cosHalf = Math.cos(half);
  const flat = end === 'flat' && angle < 180;
  const reach = flat ? length / cosHalf : length;

  const ring: PlanPoint[] = [origin];
  if (flat) {
    const halfWidth = length * Math.tan(half);
    const side: PlanPoint = { x: -towards.z * halfWidth, z: towards.x * halfWidth };
    const far: PlanPoint = { x: origin.x + towards.x * length, z: origin.z + towards.z * length };
    ring.push({ x: far.x - side.x, z: far.z - side.z });
    ring.push({ x: far.x + side.x, z: far.z + side.z });
  } else {
    const segments = curveSegments(length, angle / 360);
    const base = Math.atan2(towards.z, towards.x);
    for (let i = 0; i <= segments; i++) {
      const theta = base - half + (2 * half * i) / segments;
      ring.push({ x: origin.x + Math.cos(theta) * length, z: origin.z + Math.sin(theta) * length });
    }
  }

  return {
    shape: 'cone',
    origin,
    towards,
    length,
    reach,
    rings: [wound(ring)],
    contains: (point) => {
      const v = sub(point, origin);
      const distance = norm(v);
      if (distance <= EDGE_TOLERANCE) return true;
      const along = dot(v, towards);
      if (along + EDGE_TOLERANCE < distance * cosHalf) return false;
      return flat ? along <= length + EDGE_TOLERANCE : distance <= length + EDGE_TOLERANCE;
    },
  };
}

/**
 * The area of a measurement: a circle around its origin as far as its end; a cone from its
 * origin towards its end, as long as the drag; a square whose near side has the origin at its
 * middle, as long and as wide as the drag; a line from its origin as long as the drag and its
 * width wide. Null for a ruler, and for an area without a size or with points that are no place.
 *
 * `lineWidthCells` overrides the width the rules name, as a measurement's own width does.
 */
export function shapedArea(
  shape: AtlasMeasureShape,
  origin: PlanPoint,
  end: PlanPoint,
  rules: AtlasAreaShapeRules,
  lineWidthCells?: number,
): PlanArea | null {
  if (shape === 'ruler') return null;
  if (!Number.isFinite(origin.x) || !Number.isFinite(origin.z)) return null;
  const dx = end.x - origin.x;
  const dz = end.z - origin.z;
  const length = Math.hypot(dx, dz);
  if (!(length > 0) || !Number.isFinite(length)) return null;
  const towards: PlanPoint = { x: dx / length, z: dz / length };
  switch (shape) {
    case 'circle':
      return circleArea('circle', origin, towards, length);
    case 'cone':
      return coneArea(origin, towards, length, rules.coneAngle, rules.coneEnd);
    case 'square':
      return boxArea('square', origin, towards, length, length / 2);
    case 'line': {
      const width = lineWidthCells !== undefined && Number.isFinite(lineWidthCells) && lineWidthCells > 0
        ? lineWidthCells
        : rules.lineWidthCells;
      const line = boxArea('line', origin, towards, length, width / 2);
      return line && {
        ...line,
        spine: [origin, { x: origin.x + towards.x * length, z: origin.z + towards.z * length }],
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Clipping a rectangle against an area
// ---------------------------------------------------------------------------

function crossing(p: PlanPoint, q: PlanPoint, sp: number, sq: number): PlanPoint {
  const t = sp / (sp - sq);
  return { x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t };
}

/**
 * The part of `subject` inside a convex `clip` wound the way this module winds its rings
 * (Sutherland–Hodgman). The subject may be any polygon; the clip must be convex.
 */
function clipToConvex(subject: readonly PlanPoint[], clip: PlanRing): PlanPoint[] {
  let out = [...subject];
  for (let i = 0; i < clip.length && out.length > 0; i++) {
    const a = clip[i]!;
    const b = clip[(i + 1) % clip.length]!;
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const side = (p: PlanPoint): number => ex * (p.z - a.z) - ez * (p.x - a.x);
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const cur = input[j]!;
      const prev = input[(j + input.length - 1) % input.length]!;
      const sc = side(cur);
      const sp = side(prev);
      const curIn = sc >= -AREA_EPSILON;
      const prevIn = sp >= -AREA_EPSILON;
      if (curIn) {
        if (!prevIn) out.push(crossing(prev, cur, sp, sc));
        out.push(cur);
      } else if (prevIn) {
        out.push(crossing(prev, cur, sp, sc));
      }
    }
  }
  return out;
}

/** How much of a rectangle lies inside an area, by exact clipping. */
function overlapArea(area: PlanArea, rect: readonly PlanPoint[], convex: boolean): number {
  let total = 0;
  for (const ring of area.rings) {
    if (convex) {
      const piece = clipToConvex(rect, ring);
      if (piece.length >= 3) total += Math.abs(signedArea(piece));
      continue;
    }
    // A ring with a reflex corner (a cone wider than half a turn) is taken apart into a fan
    // of triangles from its first corner, which for these shapes is the apex: disjoint pieces
    // whose clipped areas add up to the whole.
    for (let i = 1; i + 1 < ring.length; i++) {
      const triangle = [ring[0]!, ring[i]!, ring[i + 1]!];
      const piece = clipToConvex(rect, wound(triangle));
      if (piece.length >= 3) total += Math.abs(signedArea(piece));
    }
  }
  return total;
}

/** Whether an area touches a rectangle at all, edges included. */
function touchesRect(area: PlanArea, rect: readonly PlanPoint[], convex: boolean): boolean {
  const bounds = ringsBounds(area.rings);
  const box = ringsBounds([rect]);
  if (box.x1 < bounds.x0 - EDGE_TOLERANCE || box.x0 > bounds.x1 + EDGE_TOLERANCE) return false;
  if (box.z1 < bounds.z0 - EDGE_TOLERANCE || box.z0 > bounds.z1 + EDGE_TOLERANCE) return false;
  for (const corner of rect) if (area.contains(corner)) return true;
  return overlapArea(area, rect, convex) > AREA_EPSILON;
}

// ---------------------------------------------------------------------------
// The surfaces a column shows
// ---------------------------------------------------------------------------

interface Surface {
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
  heightAt(x: number, z: number): number;
  readonly slope?: { readonly shape: BlockShape; readonly rot: Rotation };
}

/**
 * Every exposed surface of a column, the way the grid finds them: the ground floor and any
 * exposed flat top from the shared sampler, plus the top faces of ramps and steps. This is
 * what lets one area cover a floor and a balcony above it, instead of only the highest one.
 */
function surfacesOfColumn(
  cx: number,
  cz: number,
  map: BlockMap,
  layout: Layout,
  maxLayer: number,
  flatAt: (cx: number, cz: number) => readonly { y: number; x0: number; x1: number; z0: number; z1: number }[],
): Surface[] {
  const out: Surface[] = [];
  for (const info of flatAt(cx, cz)) {
    out.push({ x0: info.x0, x1: info.x1, z0: info.z0, z1: info.z1, heightAt: () => info.y });
  }
  const layerHeight = map.layerHeight;
  const top = Math.min(map.topLayer(cx, cz), maxLayer);
  for (let layer = 1; layer <= top; layer++) {
    const block = map.get(cx, layer, cz);
    if (!block || SHAPE_INFO[block.shape].liquid) continue;
    if (block.shape === 'Solid' || block.shape === 'Slab') continue;
    if (!isTopExposed(map, block, maxLayer)) continue;
    const quarter = quarterOf(block.rot);
    const x0 = layout.originX + block.x;
    const z0 = layout.originZ + block.z;
    out.push({
      x0,
      x1: x0 + 1,
      z0,
      z1: z0 + 1,
      heightAt: (x, z) => (block.y - 1 + surfaceFraction(block.shape, quarter, x - x0, z - z0)) * layerHeight,
      slope: { shape: block.shape, rot: block.rot },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cells an area covers
// ---------------------------------------------------------------------------

export interface AreaCellOptions {
  readonly map: BlockMap;
  readonly layout: Layout;
  /** The vertical slice: layers above it are not there to cover. */
  readonly maxLayer?: number;
  /** When a cell is covered: half of it, its centre, or any part of it. Default `half`. */
  readonly cellRule?: AtlasCellRule;
}

/** The cells a segment runs through, taking a corner crossing as one diagonal step. */
function cellsOnSegment(a: PlanPoint, b: PlanPoint, layout: Layout): PlanCell[] {
  const ax = a.x - layout.originX;
  const az = a.z - layout.originZ;
  const bx = b.x - layout.originX;
  const bz = b.z - layout.originZ;
  let cx = Math.floor(ax);
  let cz = Math.floor(az);
  const endCx = Math.floor(bx);
  const endCz = Math.floor(bz);
  const dx = bx - ax;
  const dz = bz - az;
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dz) : Infinity;
  let tMaxX = stepX > 0 ? (cx + 1 - ax) / dx : stepX < 0 ? (cx - ax) / dx : Infinity;
  let tMaxZ = stepZ > 0 ? (cz + 1 - az) / dz : stepZ < 0 ? (cz - az) / dz : Infinity;
  const out: PlanCell[] = [{ cx, cz }];
  const limit = Math.abs(endCx - cx) + Math.abs(endCz - cz) + 2;
  for (let i = 0; i < limit; i++) {
    if (cx === endCx && cz === endCz) break;
    if (Math.abs(tMaxX - tMaxZ) < SPINE_TIE) {
      cx += stepX;
      cz += stepZ;
      tMaxX += tDeltaX;
      tMaxZ += tDeltaZ;
    } else if (tMaxX < tMaxZ) {
      cx += stepX;
      tMaxX += tDeltaX;
    } else {
      cz += stepZ;
      tMaxZ += tDeltaZ;
    }
    out.push({ cx, cz });
  }
  return out;
}

/**
 * The terrain cells an area covers, on every exposed surface under the slice.
 *
 * `half` and `any` clip the area against each cell exactly; `centre` asks only after the middle
 * of the cell. A rectangle the map cuts short is judged by its own size, so half a cell at the
 * map's edge is still half of what is there. A line also covers every cell its middle line runs
 * through, whatever the rule, so it never skips a cell along its length.
 */
export function cellsInArea(area: PlanArea, options: AreaCellOptions): AreaCell[] {
  const { map, layout } = options;
  const rule: AtlasCellRule = options.cellRule ?? 'half';
  const maxLayer = options.maxLayer ?? Infinity;
  const bounds = ringsBounds(area.rings);
  if (!Number.isFinite(bounds.x0)) return [];

  const cx0 = Math.max(layout.range.cx0, Math.floor(bounds.x0 - layout.originX - EDGE_TOLERANCE));
  const cx1 = Math.min(layout.range.cx1, Math.ceil(bounds.x1 - layout.originX + EDGE_TOLERANCE) - 1);
  const cz0 = Math.max(layout.range.cz0, Math.floor(bounds.z0 - layout.originZ - EDGE_TOLERANCE));
  const cz1 = Math.min(layout.range.cz1, Math.ceil(bounds.z1 - layout.originZ + EDGE_TOLERANCE) - 1);
  if (cx1 < cx0 || cz1 < cz0) return [];
  if ((cx1 - cx0 + 1) * (cz1 - cz0 + 1) > MAX_AREA_CELLS) return [];

  const flatAt = createColumnFlatSampler(map, layout, maxLayer);
  const convex = area.rings.every(isConvex);
  const out: AreaCell[] = [];
  const taken = new Set<string>();

  const cover = (cx: number, cz: number, forced: boolean): void => {
    for (const surface of surfacesOfColumn(cx, cz, map, layout, maxLayer, flatAt)) {
      const width = surface.x1 - surface.x0;
      const depth = surface.z1 - surface.z0;
      if (!(width > 0) || !(depth > 0)) continue;
      const midX = (surface.x0 + surface.x1) / 2;
      const midZ = (surface.z0 + surface.z1) / 2;
      if (!forced) {
        if (rule === 'centre') {
          if (!area.contains({ x: midX, z: midZ })) continue;
        } else {
          const rect = rectRing(surface.x0, surface.z0, surface.x1, surface.z1);
          const whole = width * depth;
          let inside = 0;
          if (convex && rect.every((corner) => area.contains(corner))) inside = whole;
          else inside = overlapArea(area, rect, convex);
          if (rule === 'any') {
            if (inside <= AREA_EPSILON) continue;
          } else if (inside < whole / 2 - AREA_EPSILON) {
            continue;
          }
        }
      }
      const y = surface.heightAt(midX, midZ);
      const key = `${cellKey(cx, cz)}@${heightKey(y)}`;
      if (taken.has(key)) continue;
      taken.add(key);
      out.push({
        cx,
        cz,
        y,
        x0: surface.x0,
        x1: surface.x1,
        z0: surface.z0,
        z1: surface.z1,
        ...(surface.slope !== undefined && { slope: surface.slope }),
      });
    }
  };

  for (let cz = cz0; cz <= cz1; cz++) {
    for (let cx = cx0; cx <= cx1; cx++) cover(cx, cz, false);
  }

  const spine = area.spine;
  if (spine) {
    for (const cell of cellsOnSegment(spine[0], spine[1], layout)) {
      if (cell.cx < layout.range.cx0 || cell.cx > layout.range.cx1) continue;
      if (cell.cz < layout.range.cz0 || cell.cz > layout.range.cz1) continue;
      cover(cell.cx, cell.cz, true);
    }
  }

  return out;
}

/**
 * The terrain cells a sphere covers: every exposed surface whose middle lies within `radius`
 * of `centre` in space. This is the alternative to Atlas' plan circle, kept apart so choosing
 * it is one call, not a rule woven through the area code.
 */
export function cellsInSphere(
  centre: { readonly x: number; readonly y: number; readonly z: number },
  radius: number,
  options: AreaCellOptions,
): AreaCell[] {
  if (!(radius > 0) || !Number.isFinite(radius)) return [];
  const { map, layout } = options;
  const maxLayer = options.maxLayer ?? Infinity;
  const reach = radius + EDGE_TOLERANCE;
  const cx0 = Math.max(layout.range.cx0, Math.floor(centre.x - reach - layout.originX));
  const cx1 = Math.min(layout.range.cx1, Math.ceil(centre.x + reach - layout.originX) - 1);
  const cz0 = Math.max(layout.range.cz0, Math.floor(centre.z - reach - layout.originZ));
  const cz1 = Math.min(layout.range.cz1, Math.ceil(centre.z + reach - layout.originZ) - 1);
  if (cx1 < cx0 || cz1 < cz0) return [];
  if ((cx1 - cx0 + 1) * (cz1 - cz0 + 1) > MAX_AREA_CELLS) return [];

  const flatAt = createColumnFlatSampler(map, layout, maxLayer);
  const out: AreaCell[] = [];
  for (let cz = cz0; cz <= cz1; cz++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      for (const surface of surfacesOfColumn(cx, cz, map, layout, maxLayer, flatAt)) {
        const midX = (surface.x0 + surface.x1) / 2;
        const midZ = (surface.z0 + surface.z1) / 2;
        const y = surface.heightAt(midX, midZ);
        if (Math.hypot(midX - centre.x, y - centre.y, midZ - centre.z) > reach) continue;
        out.push({
          cx,
          cz,
          y,
          x0: surface.x0,
          x1: surface.x1,
          z0: surface.z0,
          z1: surface.z1,
          ...(surface.slope !== undefined && { slope: surface.slope }),
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tokens an area covers
// ---------------------------------------------------------------------------

/** The cells a token stands on: an even footprint sits on corners, an odd one on a centre. */
export function stoodCells(x: number, z: number, diameter: number, layout: Layout): PlanCell[] {
  const half = Math.max(1, diameter) / 2;
  const gx0 = Math.floor(x - half - layout.originX + EDGE_TOLERANCE);
  const gx1 = Math.ceil(x + half - layout.originX - EDGE_TOLERANCE) - 1;
  const gz0 = Math.floor(z - half - layout.originZ + EDGE_TOLERANCE);
  const gz1 = Math.ceil(z + half - layout.originZ - EDGE_TOLERANCE) - 1;
  const out: PlanCell[] = [];
  for (let cz = gz0; cz <= gz1; cz++) {
    for (let cx = gx0; cx <= gx1; cx++) out.push({ cx, cz });
  }
  return out;
}

/**
 * The tokens an area covers. A token counts when its footprint touches the area, not when its
 * centre does: a 3x3 whose middle is outside but whose base is in is in, as Atlas counts a token
 * in range when it stands on a cell inside it. Height plays no part, an area being a plan figure
 * projected onto every surface.
 */
export function tokensInArea(area: PlanArea, tokens: readonly AreaTokenTarget[]): string[] {
  const convex = area.rings.every(isConvex);
  const out: string[] = [];
  for (const token of tokens) {
    const half = Math.max(1, token.diameter) / 2;
    const rect = rectRing(token.x - half, token.z - half, token.x + half, token.z + half);
    if (touchesRect(area, rect, convex)) out.push(token.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cells within a reach: ranges and auras
// ---------------------------------------------------------------------------

/**
 * Every cell within `reach` cells of the nearest cell in `stood`, counted by the map's diagonal
 * rule — a square under equidistant diagonals, a stepped octagon under alternating ones, a
 * stepped diamond under Manhattan, a stepped circle under Euclidean. This is the shape Atlas
 * draws ranges and auras as; a circle only stands in where the cells are too many to count.
 *
 * Null when there are more than `MAX_RANGE_CELLS` of them: the caller draws a circle instead.
 */
export function cellsWithinReach(
  stood: readonly PlanCell[],
  reach: number,
  rule: AtlasDiagonalRule,
  layout: Layout,
): PlanCell[] | null {
  if (stood.length === 0 || !(reach >= 0) || !Number.isFinite(reach)) return null;
  const span = Math.ceil(reach + EDGE_TOLERANCE);
  let sx0 = Infinity;
  let sx1 = -Infinity;
  let sz0 = Infinity;
  let sz1 = -Infinity;
  for (const cell of stood) {
    if (cell.cx < sx0) sx0 = cell.cx;
    if (cell.cx > sx1) sx1 = cell.cx;
    if (cell.cz < sz0) sz0 = cell.cz;
    if (cell.cz > sz1) sz1 = cell.cz;
  }
  const cx0 = Math.max(layout.range.cx0, sx0 - span);
  const cx1 = Math.min(layout.range.cx1, sx1 + span);
  const cz0 = Math.max(layout.range.cz0, sz0 - span);
  const cz1 = Math.min(layout.range.cz1, sz1 + span);
  if (cx1 < cx0 || cz1 < cz0) return null;
  if ((cx1 - cx0 + 1) * (cz1 - cz0 + 1) > MAX_RANGE_CELLS) return null;

  const out: PlanCell[] = [];
  for (let cz = cz0; cz <= cz1; cz++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      let nearest = Infinity;
      for (const cell of stood) {
        const dx = Math.abs(cx - cell.cx);
        const dz = Math.abs(cz - cell.cz);
        const straight = Math.abs(dx - dz);
        const diagonal = Math.min(dx, dz);
        const cost = cellsByRule({ straight, diagonal, euclidean: Math.hypot(dx, dz) }, rule, 0);
        if (cost < nearest) nearest = cost;
        if (nearest <= EDGE_TOLERANCE) break;
      }
      if (nearest <= reach + EDGE_TOLERANCE) out.push({ cx, cz });
    }
  }
  return out;
}

/**
 * The closed outlines around a set of cells: every cell's edges, less the edges two cells share,
 * joined end to start. A reach grows side by side, so no cell touches at a corner alone and every
 * corner has one edge leaving it. Rings come back wound as this module winds them.
 */
export function outlineOfCells(cells: readonly PlanCell[], layout: Layout): PlanRing[] {
  if (cells.length === 0) return [];
  const held = new Set(cells.map((cell) => cellKey(cell.cx, cell.cz)));
  interface Edge { from: PlanPoint; to: PlanPoint; used: boolean }
  const leaving = new Map<string, Edge[]>();
  const add = (from: PlanPoint, to: PlanPoint): void => {
    const key = cornerKey(from);
    const list = leaving.get(key);
    if (list) list.push({ from, to, used: false });
    else leaving.set(key, [{ from, to, used: false }]);
  };

  for (const cell of cells) {
    const x0 = layout.originX + cell.cx;
    const x1 = x0 + 1;
    const z0 = layout.originZ + cell.cz;
    const z1 = z0 + 1;
    if (!held.has(cellKey(cell.cx, cell.cz - 1))) add({ x: x0, z: z0 }, { x: x1, z: z0 });
    if (!held.has(cellKey(cell.cx + 1, cell.cz))) add({ x: x1, z: z0 }, { x: x1, z: z1 });
    if (!held.has(cellKey(cell.cx, cell.cz + 1))) add({ x: x1, z: z1 }, { x: x0, z: z1 });
    if (!held.has(cellKey(cell.cx - 1, cell.cz))) add({ x: x0, z: z1 }, { x: x0, z: z0 });
  }

  const rings: PlanRing[] = [];
  for (const list of leaving.values()) {
    for (const start of list) {
      if (start.used) continue;
      const ring: PlanPoint[] = [];
      let edge: Edge | undefined = start;
      while (edge && !edge.used) {
        edge.used = true;
        ring.push(edge.from);
        edge = (leaving.get(cornerKey(edge.to)) ?? []).find((candidate) => !candidate.used);
      }
      if (ring.length >= 3) rings.push(wound(ring));
    }
  }
  return rings;
}