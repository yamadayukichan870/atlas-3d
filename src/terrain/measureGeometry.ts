/**
 * The geometry of a measured area, and which terrain cells and tokens it covers.
 *
 * REWORK. The previous engine decided coverage by clipping the area's polygon against every
 * cell (Sutherland–Hodgman, convexity detection, fan triangulation for wide cones). That chain
 * was fragile: a cone whose convexity test failed on floating-point noise fell into the fan
 * path and returned an inflated area, so the fill spilled past the outline.
 *
 * This engine decides coverage with ONE closed-form predicate per shape, `contains(point)`,
 * and samples it over each cell. No polygon clipping, no winding, no convexity: there is no
 * machinery left that can inflate an area. The outline is still drawn from the analytic ring,
 * so fill and border come from the same definition and cannot disagree.
 *
 * It is not Atlas' exact half-cell clip — a 5x5 sample estimates the covered fraction instead —
 * but it is robust and predictable, which is the point of the rework. `centre` is exact (one
 * test); `half` and `any` use the sample grid. Shapes keep Atlas' anchoring (a square is a box
 * from the middle of its near side, a cone opens the collection's angle).
 *
 * World convention: x/z are the plan, y is up, one grid cell spans one world unit. Areas are
 * plan figures projected onto every exposed terrain surface under the slice. A sphere is kept
 * apart (`cellsInSphere`) as the alternative to the plan circle.
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
export interface PlanPoint { readonly x: number; readonly z: number }
export type PlanRing = readonly PlanPoint[];
export interface PlanCell { readonly cx: number; readonly cz: number }

/**
 * An area as its measurement shapes it. `contains` is the closed-form test coverage samples;
 * `rings` is the analytic boundary the overlay draws. Both come from the same parameters.
 */
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
/** Side of the sample grid a cell is judged by for `half`/`any`. Odd, so it has a centre. */
const SAMPLES = 5;
const heightKey = (y: number): number => Math.round(y * 10000);
const cellKey = (cx: number, cz: number): string => `${cx},${cz}`;

const sub = (a: PlanPoint, b: PlanPoint): PlanPoint => ({ x: a.x - b.x, z: a.z - b.z });
const dot = (a: PlanPoint, b: PlanPoint): number => a.x * b.x + a.z * b.z;
const cross = (a: PlanPoint, b: PlanPoint): number => a.x * b.z - a.z * b.x;
const norm = (a: PlanPoint): number => Math.hypot(a.x, a.z);

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

function curveSegments(radius: number, turnFraction: number): number {
  if (!(radius > CURVE_SAGITTA)) return MIN_CURVE_SEGMENTS;
  const ratio = Math.min(1, Math.max(-1, 1 - CURVE_SAGITTA / radius));
  const perTurn = ratio <= -1 ? 2 : Math.PI / Math.acos(ratio);
  const wanted = Math.ceil((perTurn * Math.max(turnFraction, 1 / 8)) / 8) * 8;
  return Math.min(MAX_CURVE_SEGMENTS, Math.max(MIN_CURVE_SEGMENTS, wanted));
}

// ---------------------------------------------------------------------------
// The shapes: analytic predicate + outline ring, from the same parameters
// ---------------------------------------------------------------------------
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
  const ring: PlanPoint[] = [
    { x: origin.x - side.x, z: origin.z - side.z },
    { x: origin.x + side.x, z: origin.z + side.z },
    { x: far.x + side.x, z: far.z + side.z },
    { x: far.x - side.x, z: far.z - side.z },
  ];
  return {
    shape, origin, towards, length,
    reach: Math.hypot(length, halfWidth),
    rings: [ring],
    contains: (p) => {
      const v = sub(p, origin);
      const along = dot(v, towards);
      return along >= -EDGE_TOLERANCE && along <= length + EDGE_TOLERANCE
        && Math.abs(cross(v, towards)) <= halfWidth + EDGE_TOLERANCE;
    },
  };
}

function circleArea(
  shape: 'circle' | 'cone',
  origin: PlanPoint,
  towards: PlanPoint,
  radius: number,
): PlanArea {
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
        ? lineWidthCells : rules.lineWidthCells;
      const line = boxArea('line', origin, towards, length, width / 2);
      return line && {
        ...line,
        spine: [origin, { x: origin.x + towards.x * length, z: origin.z + towards.z * length }],
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Coverage by sampling the analytic predicate
// ---------------------------------------------------------------------------
/** The share of a rectangle's sample grid that lies in the area. */
function sampledFraction(
  area: PlanArea,
  x0: number, z0: number, x1: number, z1: number,
): number {
  let inside = 0;
  const n = SAMPLES;
  for (let i = 0; i < n; i++) {
    const x = x0 + ((i + 0.5) / n) * (x1 - x0);
    for (let j = 0; j < n; j++) {
      const z = z0 + ((j + 0.5) / n) * (z1 - z0);
      if (area.contains({ x, z })) inside++;
    }
  }
  return inside / (n * n);
}

/**
 * Whether a rectangle is covered under the rule. `centre` is one exact test. `half`/`any`
 * fast-path a rectangle wholly in or out by its corners and centre, and sample only the border.
 */
function rectCovered(
  area: PlanArea,
  x0: number, z0: number, x1: number, z1: number,
  rule: AtlasCellRule,
): boolean {
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  if (rule === 'centre') return area.contains({ x: cx, z: cz });
  const corners = [
    area.contains({ x: x0, z: z0 }), area.contains({ x: x1, z: z0 }),
    area.contains({ x: x1, z: z1 }), area.contains({ x: x0, z: z1 }),
  ];
  const centre = area.contains({ x: cx, z: cz });
  if (corners.every(Boolean) && centre) return true;
  if (corners.every((c) => !c) && !centre) return false;
  const fraction = sampledFraction(area, x0, z0, x1, z1);
  return rule === 'any' ? fraction > 0 : fraction >= 0.5;
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
// Cells an area covers
// ---------------------------------------------------------------------------
export interface AreaCellOptions {
  readonly map: BlockMap;
  readonly layout: Layout;
  readonly maxLayer?: number;
  readonly cellRule?: AtlasCellRule;
}

function cellsOnSegment(a: PlanPoint, b: PlanPoint, layout: Layout): PlanCell[] {
  const ax = a.x - layout.originX, az = a.z - layout.originZ;
  const bx = b.x - layout.originX, bz = b.z - layout.originZ;
  let cx = Math.floor(ax), cz = Math.floor(az);
  const endCx = Math.floor(bx), endCz = Math.floor(bz);
  const dx = bx - ax, dz = bz - az;
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
    if (Math.abs(tMaxX - tMaxZ) < 1e-9) { cx += stepX; cz += stepZ; tMaxX += tDeltaX; tMaxZ += tDeltaZ; }
    else if (tMaxX < tMaxZ) { cx += stepX; tMaxX += tDeltaX; }
    else { cz += stepZ; tMaxZ += tDeltaZ; }
    out.push({ cx, cz });
  }
  return out;
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
  const out: AreaCell[] = [];
  const taken = new Set<string>();
  const cover = (cx: number, cz: number, forced: boolean): void => {
    for (const surface of surfacesOfColumn(cx, cz, map, layout, maxLayer, flatAt)) {
      const width = surface.x1 - surface.x0;
      const depth = surface.z1 - surface.z0;
      if (!(width > 0) || !(depth > 0)) continue;
      if (!forced && !rectCovered(area, surface.x0, surface.z0, surface.x1, surface.z1, rule)) continue;
      const midX = (surface.x0 + surface.x1) / 2;
      const midZ = (surface.z0 + surface.z1) / 2;
      const y = surface.heightAt(midX, midZ);
      const key = `${cellKey(cx, cz)}@${heightKey(y)}`;
      if (taken.has(key)) continue;
      taken.add(key);
      out.push({
        cx, cz, y,
        x0: surface.x0, x1: surface.x1, z0: surface.z0, z1: surface.z1,
        ...(surface.slope !== undefined && { slope: surface.slope }),
      });
    }
  };
  for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) cover(cx, cz, false);
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
          cx, cz, y,
          x0: surface.x0, x1: surface.x1, z0: surface.z0, z1: surface.z1,
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

/** A token counts when its footprint touches the area, sampled the same way a cell is. */
export function tokensInArea(area: PlanArea, tokens: readonly AreaTokenTarget[]): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    const half = Math.max(1, token.diameter) / 2;
    const x0 = token.x - half, x1 = token.x + half, z0 = token.z - half, z1 = token.z + half;
    if (rectCovered(area, x0, z0, x1, z1, 'any')) out.push(token.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cells within a reach: ranges and auras (unchanged, already cell-first)
// ---------------------------------------------------------------------------
export function cellsWithinReach(
  stood: readonly PlanCell[],
  reach: number,
  rule: AtlasDiagonalRule,
  layout: Layout,
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

export function outlineOfCells(cells: readonly PlanCell[], layout: Layout): PlanRing[] {
  if (cells.length === 0) return [];
  const held = new Set(cells.map((c) => cellKey(c.cx, c.cz)));
  interface Edge { from: PlanPoint; to: PlanPoint; used: boolean }
  const cornerKey = (p: PlanPoint): string => `${Math.round(p.x * 1e6)},${Math.round(p.z * 1e6)}`;
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