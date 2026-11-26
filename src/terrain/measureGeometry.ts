/**
 * The geometry of a measured area, and which terrain cells and tokens it covers.
 *
 * COVERAGE IS ATLAS' EXACT CLIP, not a sample grid: only the cells the outline TOUCHES are clipped,
 * and a cell the outline does not come near is wholly in or out, decided by one centre test. The
 * AREA ring is the subject and the CELL rectangle the convex clip (Sutherland–Hodgman); clipping
 * the other way round is invalid for a reflex ring. Signed areas are summed and abs'd at the end,
 * so winding never matters and a wall-cut hole subtracts.
 *
 * A LINE'S MIDDLE LINE IS CLASSIFIED, NOT WALKED. This replaces a digital-line (DDA) walk, which
 * marked every cell the segment touched and whose corner tie-break stepped both axes at once — so
 * a spine lying on a grid line forced the cells of BOTH rows, and a beam placed between two cells
 * marked both where Atlas marks only the one its body reaches into. Atlas' own `cellsOnSpine`
 * (measure/measureCells.ts) clips the segment against each cell and asks where the middle of the
 * clipped part lies. Its own words: "a corner or a point of a side is no meeting", and "A spine
 * that runs through no cell (along a square grid's line) makes none."
 *
 * World convention: x/z the plan, y up, one grid cell spans one world unit. Areas are plan figures
 * projected onto every exposed terrain surface under the slice. Pure: no three.js, no DOM.
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
export interface PlanPoint { readonly x: number; readonly z: number }
export type PlanRing = readonly PlanPoint[];
export interface PlanCell { readonly cx: number; readonly cz: number }

export interface PlanArea {
  readonly shape: Exclude<AtlasMeasureShape, 'ruler'>;
  readonly origin: PlanPoint;
  readonly towards: PlanPoint;
  readonly length: number;
  readonly reach: number;
  readonly rings: readonly PlanRing[];
  readonly spine?: readonly [PlanPoint, PlanPoint];
  contains(point: PlanPoint): boolean;
}

export interface AreaCell {
  readonly cx: number;
  readonly cz: number;
  readonly y: number;
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
  readonly slope?: { readonly shape: BlockShape; readonly rot: Rotation };
}

export interface AreaTokenTarget {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly diameter: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_AREA_CELLS = 65_536;
const CURVE_SAGITTA = 0.005;
const MIN_CURVE_SEGMENTS = 32;
const MAX_CURVE_SEGMENTS = 128;
const AREA_EPSILON = 1e-9;
const SHARE_TOLERANCE = 1e-9;
const CELL_CIRCUMRADIUS = Math.SQRT1_2;
/** A cell's corners around its centre in GRID coordinates, wound so `depthAtSide` is positive inside. */
const CELL_CORNERS: readonly number[] = [-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5];

const heightKey = (y: number): number => Math.round(y * 10000);
const cellKey = (cx: number, cz: number): string => `${cx},${cz}`;
const cornerKey = (p: PlanPoint): string => `${Math.round(p.x * 1e6)},${Math.round(p.z * 1e6)}`;

const sub = (a: PlanPoint, b: PlanPoint): PlanPoint => ({ x: a.x - b.x, z: a.z - b.z });
const dot = (a: PlanPoint, b: PlanPoint): number => a.x * b.x + a.z * b.z;
const cross = (a: PlanPoint, b: PlanPoint): number => a.x * b.z - a.z * b.x;
const norm = (a: PlanPoint): number => Math.hypot(a.x, a.z);

function signedArea(ring: readonly PlanPoint[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    sum += a.x * b.z - b.x * a.z;
  }
  return sum / 2;
}

function ringBounds(rings: readonly PlanRing[]): { x0: number; x1: number; z0: number; z1: number } {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const ring of rings) for (const p of ring) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.z < z0) z0 = p.z;
    if (p.z > z1) z1 = p.z;
  }
  return { x0, x1, z0, z1 };
}

function rectRing(x0: number, z0: number, x1: number, z1: number): PlanPoint[] {
  return [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];
}

function curveSegments(radius: number, turnFraction: number): number {
  if (!(radius > CURVE_SAGITTA)) return MIN_CURVE_SEGMENTS;
  const ratio = Math.min(1, Math.max(-1, 1 - CURVE_SAGITTA / radius));
  const perTurn = ratio <= -1 ? 2 : Math.PI / Math.acos(ratio);
  const wanted = Math.ceil((perTurn * Math.max(turnFraction, 1 / 8)) / 8) * 8;
  return Math.min(MAX_CURVE_SEGMENTS, Math.max(MIN_CURVE_SEGMENTS, wanted));
}

function distToSegment(p: PlanPoint, a: PlanPoint, b: PlanPoint): number {
  const dx = b.x - a.x, dz = b.z - a.z;
  const l2 = dx * dx + dz * dz;
  const t = l2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
}

// ---------------------------------------------------------------------------
// The shapes
// ---------------------------------------------------------------------------
function boxArea(
  shape: 'square' | 'line', origin: PlanPoint, towards: PlanPoint, length: number, halfWidth: number,
): PlanArea | null {
  if (!(halfWidth > 0) || !Number.isFinite(halfWidth)) return null;
  const side: PlanPoint = { x: -towards.z * halfWidth, z: towards.x * halfWidth };
  const far: PlanPoint = { x: origin.x + towards.x * length, z: origin.z + towards.z * length };
  const ring: PlanPoint[] = [
    { x: origin.x - side.x, z: origin.z - side.z },
    { x: origin.x + side.x, z: origin.z + side.z },
    { x: far.x + side.x, z: far.z + side.z },
    { x: far.x - side.x, z: far.z - side.z },
  ];
  return {
    shape, origin, towards, length, reach: Math.hypot(length, halfWidth), rings: [ring],
    contains: (p) => {
      const v = sub(p, origin);
      const along = dot(v, towards);
      return along >= -EDGE_TOLERANCE && along <= length + EDGE_TOLERANCE
        && Math.abs(cross(v, towards)) <= halfWidth + EDGE_TOLERANCE;
    },
  };
}

function circleArea(shape: 'circle' | 'cone', origin: PlanPoint, towards: PlanPoint, radius: number): PlanArea {
  const segments = curveSegments(radius, 1);
  const ring: PlanPoint[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    ring.push({ x: origin.x + Math.cos(a) * radius, z: origin.z + Math.sin(a) * radius });
  }
  return {
    shape, origin, towards, length: radius, reach: radius, rings: [ring],
    contains: (p) => norm(sub(p, origin)) <= radius + EDGE_TOLERANCE,
  };
}

function coneArea(
  origin: PlanPoint, towards: PlanPoint, length: number, angle: number, end: AtlasAreaShapeRules['coneEnd'],
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
    shape: 'cone', origin, towards, length, reach, rings: [ring],
    contains: (p) => {
      const v = sub(p, origin);
      const d = norm(v);
      if (d <= EDGE_TOLERANCE) return true;
      const along = dot(v, towards);
      if (along + EDGE_TOLERANCE < d * cosHalf) return false;
      return flat ? along <= length + EDGE_TOLERANCE : d <= length + EDGE_TOLERANCE;
    },
  };
}

export function shapedArea(
  shape: AtlasMeasureShape, origin: PlanPoint, end: PlanPoint,
  rules: AtlasAreaShapeRules, lineWidthCells?: number,
): PlanArea | null {
  if (shape === 'ruler') return null;
  if (!Number.isFinite(origin.x) || !Number.isFinite(origin.z)) return null;
  const dx = end.x - origin.x, dz = end.z - origin.z;
  const length = Math.hypot(dx, dz);
  if (!(length > 0) || !Number.isFinite(length)) return null;
  const towards: PlanPoint = { x: dx / length, z: dz / length };
  switch (shape) {
    case 'circle': return circleArea('circle', origin, towards, length);
    case 'cone': return coneArea(origin, towards, length, rules.coneAngle, rules.coneEnd);
    case 'square': return boxArea('square', origin, towards, length, length / 2);
    case 'line': {
      const width = lineWidthCells !== undefined && Number.isFinite(lineWidthCells) && lineWidthCells > 0
        ? lineWidthCells : rules.lineWidthCells;
      const line = boxArea('line', origin, towards, length, width / 2);
      return line && { ...line, spine: [origin, { x: origin.x + towards.x * length, z: origin.z + towards.z * length }] };
    }
  }
}

// ---------------------------------------------------------------------------
// Exact clipping
// ---------------------------------------------------------------------------
function clipToConvex(subject: readonly PlanPoint[], clip: PlanRing): PlanPoint[] {
  let out = [...subject];
  for (let i = 0; i < clip.length && out.length > 0; i++) {
    const a = clip[i]!, b = clip[(i + 1) % clip.length]!;
    const ex = b.x - a.x, ez = b.z - a.z;
    const side = (p: PlanPoint): number => ex * (p.z - a.z) - ez * (p.x - a.x);
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const cur = input[j]!;
      const prev = input[(j + input.length - 1) % input.length]!;
      const sc = side(cur), sp = side(prev);
      const curIn = sc >= -AREA_EPSILON, prevIn = sp >= -AREA_EPSILON;
      if (curIn) {
        if (!prevIn) {
          const t = sp / (sp - sc);
          out.push({ x: prev.x + (cur.x - prev.x) * t, z: prev.z + (cur.z - prev.z) * t });
        }
        out.push(cur);
      } else if (prevIn) {
        const t = sp / (sp - sc);
        out.push({ x: prev.x + (cur.x - prev.x) * t, z: prev.z + (cur.z - prev.z) * t });
      }
    }
  }
  return out;
}

function ringOverlap(ring: PlanRing, rect: PlanRing): number {
  const piece = clipToConvex(ring, rect);
  return piece.length >= 3 ? signedArea(piece) : 0;
}

function areaOverlap(area: PlanArea, rect: PlanRing): number {
  let sum = 0;
  for (const ring of area.rings) sum += ringOverlap(ring, rect);
  return Math.abs(sum);
}

function touchedCells(
  area: PlanArea, cx0: number, cx1: number, cz0: number, cz1: number, layout: Layout,
): Set<string> {
  const out = new Set<string>();
  const m = CELL_CIRCUMRADIUS;
  for (const ring of area.rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
      const ex0 = Math.max(cx0, Math.floor(Math.min(a.x, b.x) - m - layout.originX));
      const ex1 = Math.min(cx1, Math.ceil(Math.max(a.x, b.x) + m - layout.originX) - 1);
      const ez0 = Math.max(cz0, Math.floor(Math.min(a.z, b.z) - m - layout.originZ));
      const ez1 = Math.min(cz1, Math.ceil(Math.max(a.z, b.z) + m - layout.originZ) - 1);
      for (let cz = ez0; cz <= ez1; cz++) {
        for (let cx = ex0; cx <= ex1; cx++) {
          const centre: PlanPoint = { x: layout.originX + cx + 0.5, z: layout.originZ + cz + 0.5 };
          if (distToSegment(centre, a, b) <= m) out.add(cellKey(cx, cz));
        }
      }
    }
  }
  return out;
}

function rectCovered(
  area: PlanArea, rect: PlanRing, x0: number, z0: number, x1: number, z1: number,
  rule: AtlasCellRule, touched: boolean,
): boolean {
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  if (rule === 'centre') return area.contains({ x: cx, z: cz });
  if (!touched) return area.contains({ x: cx, z: cz });
  const whole = (x1 - x0) * (z1 - z0);
  if (!(whole > 0)) return false;
  const overlap = areaOverlap(area, rect);
  if (rule === 'any') return overlap > AREA_EPSILON;
  return overlap >= whole * (0.5 - SHARE_TOLERANCE);
}

// ---------------------------------------------------------------------------
// The surfaces a column shows
// ---------------------------------------------------------------------------
interface Surface {
  readonly x0: number; readonly x1: number; readonly z0: number; readonly z1: number;
  heightAt(x: number, z: number): number;
  readonly slope?: { readonly shape: BlockShape; readonly rot: Rotation };
}

function surfacesOfColumn(
  cx: number, cz: number, map: BlockMap, layout: Layout, maxLayer: number,
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
      x0, x1: x0 + 1, z0, z1: z0 + 1,
      heightAt: (x, z) => (block.y - 1 + surfaceFraction(block.shape, quarter, x - x0, z - z0)) * layerHeight,
      slope: { shape: block.shape, rot: block.rot },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// A line's middle line, as Atlas classifies it
// ---------------------------------------------------------------------------
type Meeting = 'none' | 'beside' | 'inside';

/** How far inside the side of a cell from corner `c` the point (`px`, `pz`) lies. Positive is inside. */
function depthAtSide(c: number, cx: number, cz: number, px: number, pz: number): number {
  const ex = CELL_CORNERS[(c + 2) % CELL_CORNERS.length]! - CELL_CORNERS[c]!;
  const ez = CELL_CORNERS[(c + 3) % CELL_CORNERS.length]! - CELL_CORNERS[c + 1]!;
  return (ex * (pz - cz - CELL_CORNERS[c + 1]!) - ez * (px - cx - CELL_CORNERS[c]!)) / Math.hypot(ex, ez);
}

/**
 * How the way from a to b meets the cell around (`cx`, `cz`), in GRID coordinates: the part of it
 * within the cell must have a length, and runs through the inside where its middle lies off every
 * side. A corner, or a single point of a side, is no meeting at all.
 */
function meetingOf(cx: number, cz: number, ax: number, az: number, bx: number, bz: number): Meeting {
  let enters = 0;
  let leaves = 1;
  for (let c = 0; c < CELL_CORNERS.length; c += 2) {
    const from = depthAtSide(c, cx, cz, ax, az);
    const gain = depthAtSide(c, cx, cz, bx, bz) - from;
    if (Math.abs(gain) <= EDGE_TOLERANCE) {
      if (from < -EDGE_TOLERANCE) return 'none';
    } else if (gain > 0) {
      enters = Math.max(enters, -from / gain);
    } else {
      leaves = Math.min(leaves, -from / gain);
    }
  }
  if (!((leaves - enters) * Math.hypot(bx - ax, bz - az) > EDGE_TOLERANCE)) return 'none';
  const middle = (enters + leaves) / 2;
  const mx = ax + (bx - ax) * middle;
  const mz = az + (bz - az) * middle;
  for (let c = 0; c < CELL_CORNERS.length; c += 2) {
    if (!(depthAtSide(c, cx, cz, mx, mz) > EDGE_TOLERANCE)) return 'beside';
  }
  return 'inside';
}

/**
 * The cells a line's middle line makes its own, whatever the cell rule. EMPTY for a spine that runs
 * along a grid line without entering any cell — Atlas' own answer, and what stops a beam placed
 * between two cells from marking both. Those cells are left to the cell rule alone.
 */
function cellsOnSpine(a: PlanPoint, b: PlanPoint, layout: Layout): PlanCell[] {
  if (!Number.isFinite(a.x) || !Number.isFinite(a.z)) return [];
  if (!Number.isFinite(b.x) || !Number.isFinite(b.z)) return [];
  const ax = a.x - layout.originX, az = a.z - layout.originZ;
  const bx = b.x - layout.originX, bz = b.z - layout.originZ;
  if (!(Math.hypot(bx - ax, bz - az) > EDGE_TOLERANCE)) return [];
  const gx0 = Math.max(layout.range.cx0, Math.floor(Math.min(ax, bx) - CELL_CIRCUMRADIUS));
  const gx1 = Math.min(layout.range.cx1, Math.ceil(Math.max(ax, bx) + CELL_CIRCUMRADIUS));
  const gz0 = Math.max(layout.range.cz0, Math.floor(Math.min(az, bz) - CELL_CIRCUMRADIUS));
  const gz1 = Math.min(layout.range.cz1, Math.ceil(Math.max(az, bz) + CELL_CIRCUMRADIUS));
  const from: PlanPoint = { x: ax, z: az };
  const to: PlanPoint = { x: bx, z: bz };
  const inside: PlanCell[] = [];
  const beside: PlanCell[] = [];
  for (let cz = gz0; cz <= gz1; cz++) {
    for (let cx = gx0; cx <= gx1; cx++) {
      const mx = cx + 0.5, mz = cz + 0.5;
      if (distToSegment({ x: mx, z: mz }, from, to) > CELL_CIRCUMRADIUS) continue;
      const meeting = meetingOf(mx, mz, ax, az, bx, bz);
      if (meeting === 'inside') inside.push({ cx, cz });
      else if (meeting === 'beside') beside.push({ cx, cz });
    }
  }
  if (inside.length === 0) return [];
  return [...inside, ...beside];
}

// ---------------------------------------------------------------------------
// Cells an area covers
// ---------------------------------------------------------------------------
export interface AreaCellOptions {
  readonly map: BlockMap;
  readonly layout: Layout;
  readonly maxLayer?: number;
  readonly cellRule?: AtlasCellRule;
}

export function cellsInArea(area: PlanArea, options: AreaCellOptions): AreaCell[] {
  const { map, layout } = options;
  const rule: AtlasCellRule = options.cellRule ?? 'half';
  const maxLayer = options.maxLayer ?? Infinity;
  const bounds = ringBounds(area.rings);
  if (!Number.isFinite(bounds.x0)) return [];
  const cx0 = Math.max(layout.range.cx0, Math.floor(bounds.x0 - layout.originX - EDGE_TOLERANCE));
  const cx1 = Math.min(layout.range.cx1, Math.ceil(bounds.x1 - layout.originX + EDGE_TOLERANCE) - 1);
  const cz0 = Math.max(layout.range.cz0, Math.floor(bounds.z0 - layout.originZ - EDGE_TOLERANCE));
  const cz1 = Math.min(layout.range.cz1, Math.ceil(bounds.z1 - layout.originZ + EDGE_TOLERANCE) - 1);
  if (cx1 < cx0 || cz1 < cz0) return [];
  if ((cx1 - cx0 + 1) * (cz1 - cz0 + 1) > MAX_AREA_CELLS) return [];
  const flatAt = createColumnFlatSampler(map, layout, maxLayer);
  const touched = rule === 'centre' ? new Set<string>() : touchedCells(area, cx0, cx1, cz0, cz1, layout);
  const out: AreaCell[] = [];
  const taken = new Set<string>();
  const cover = (cx: number, cz: number, forced: boolean): void => {
    for (const surface of surfacesOfColumn(cx, cz, map, layout, maxLayer, flatAt)) {
      const width = surface.x1 - surface.x0, depth = surface.z1 - surface.z0;
      if (!(width > 0) || !(depth > 0)) continue;
      if (!forced && !rectCovered(
        area, rectRing(surface.x0, surface.z0, surface.x1, surface.z1),
        surface.x0, surface.z0, surface.x1, surface.z1, rule, touched.has(cellKey(cx, cz)),
      )) continue;
      const midX = (surface.x0 + surface.x1) / 2, midZ = (surface.z0 + surface.z1) / 2;
      const y = surface.heightAt(midX, midZ);
      const key = `${cellKey(cx, cz)}@${heightKey(y)}`;
      if (taken.has(key)) continue;
      taken.add(key);
      out.push({
        cx, cz, y, x0: surface.x0, x1: surface.x1, z0: surface.z0, z1: surface.z1,
        ...(surface.slope !== undefined && { slope: surface.slope }),
      });
    }
  };
  for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) cover(cx, cz, false);
  const spine = area.spine;
  if (spine) {
    for (const cell of cellsOnSpine(spine[0], spine[1], layout)) cover(cell.cx, cell.cz, true);
  }
  return out;
}

export function cellsInSphere(
  centre: { readonly x: number; readonly y: number; readonly z: number },
  radius: number, options: AreaCellOptions,
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
        const midX = (surface.x0 + surface.x1) / 2, midZ = (surface.z0 + surface.z1) / 2;
        const y = surface.heightAt(midX, midZ);
        if (Math.hypot(midX - centre.x, y - centre.y, midZ - centre.z) > reach) continue;
        out.push({
          cx, cz, y, x0: surface.x0, x1: surface.x1, z0: surface.z0, z1: surface.z1,
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
export function stoodCells(x: number, z: number, diameter: number, layout: Layout): PlanCell[] {
  const half = Math.max(1, diameter) / 2;
  const gx0 = Math.floor(x - half - layout.originX + EDGE_TOLERANCE);
  const gx1 = Math.ceil(x + half - layout.originX - EDGE_TOLERANCE) - 1;
  const gz0 = Math.floor(z - half - layout.originZ + EDGE_TOLERANCE);
  const gz1 = Math.ceil(z + half - layout.originZ - EDGE_TOLERANCE) - 1;
  const out: PlanCell[] = [];
  for (let cz = gz0; cz <= gz1; cz++) for (let cx = gx0; cx <= gx1; cx++) out.push({ cx, cz });
  return out;
}

export function tokensInArea(area: PlanArea, tokens: readonly AreaTokenTarget[]): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    const half = Math.max(1, token.diameter) / 2;
    const rect = rectRing(token.x - half, token.z - half, token.x + half, token.z + half);
    if (rect.every((c) => area.contains(c)) || areaOverlap(area, rect) > AREA_EPSILON) out.push(token.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cells within a reach
// ---------------------------------------------------------------------------
export function cellsWithinReach(
  stood: readonly PlanCell[], reach: number, rule: AtlasDiagonalRule, layout: Layout,
): PlanCell[] | null {
  if (stood.length === 0 || !(reach >= 0) || !Number.isFinite(reach)) return null;
  const span = Math.ceil(reach + EDGE_TOLERANCE);
  let sx0 = Infinity, sx1 = -Infinity, sz0 = Infinity, sz1 = -Infinity;
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
        const dx = Math.abs(cx - cell.cx), dz = Math.abs(cz - cell.cz);
        const straight = Math.abs(dx - dz), diagonal = Math.min(dx, dz);
        const cost = cellsByRule({ straight, diagonal, euclidean: Math.hypot(dx, dz) }, rule, 0);
        if (cost < nearest) nearest = cost;
        if (nearest <= EDGE_TOLERANCE) break;
      }
      if (nearest <= reach + EDGE_TOLERANCE) out.push({ cx, cz });
    }
  }
  return out;
}

export function outlineOfCells(cells: readonly PlanCell[], layout: Layout): PlanRing[] {
  if (cells.length === 0) return [];
  const held = new Set(cells.map((c) => cellKey(c.cx, c.cz)));
  interface Edge { from: PlanPoint; to: PlanPoint; used: boolean }
  const leaving = new Map<string, Edge[]>();
  const add = (from: PlanPoint, to: PlanPoint): void => {
    const key = cornerKey(from);
    const list = leaving.get(key);
    if (list) list.push({ from, to, used: false });
    else leaving.set(key, [{ from, to, used: false }]);
  };
  for (const cell of cells) {
    const x0 = layout.originX + cell.cx, x1 = x0 + 1;
    const z0 = layout.originZ + cell.cz, z1 = z0 + 1;
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
        edge = (leaving.get(cornerKey(edge.to)) ?? []).find((c) => !c.used);
      }
      if (ring.length >= 3) rings.push(ring);
    }
  }
  return rings;
}