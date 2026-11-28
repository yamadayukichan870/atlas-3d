import * as THREE from 'three';
import type { AreaCell, PlanRing } from '../../terrain/measureGeometry';
import type { MeasureRegion } from '../../terrain/measureRegion';
import { quarterOf, surfaceFraction } from '../../terrain/shapes';
import type { TacticalOverlayContext } from '../TacticalOverlays';

/**
 * The three-layer body of a measured area, and the stroke every ring wears.
 *
 * EXTRACTED FROM TacticalOverlays AS A PURE MOVE. That file did eleven jobs in ~1.850 lines, so
 * every change touched all of it — Repowise measured 99 % churn. The bodies here are the ones it
 * had, byte for byte; only the receiver changed: `this.trackMat` became `sink.trackMat`,
 * `this.surfaceY` became `body.surfaceY`. If anything looks different on screen, this move is wrong.
 *
 * WHAT A MODULE MAY NOT DO. It cannot reach the entries map, cannot decide whether to rebuild,
 * cannot touch the label layer and cannot read the host. That is what `BodySink` buys: the
 * orchestrator keeps the lifecycle, this file only draws.
 *
 * THE BODY IS ATLAS' AreaBody.draw(), layer for layer: wash 0.12 edge-to-edge, cell tint 0.16 inset
 * max(1px, cell×0.025), outline at max(2px, cell/28). With an effect the effect mesh REPLACES the
 * wash — `withEffect` is why that parameter exists, and dropping it doubles the fill.
 *
 * EVERY STROKE IS ONE MITRED BAND, OPAQUE, DRAWN ONCE. Walking it in prolonged pieces beaded a
 * circle (every edge shorter than the step, so every piece overlapped both neighbours and blended
 * twice) and spiked a cone's apex (the prolongations crossed outside the figure). Consecutive quads
 * here share exact vertices, so they tile without gap; the material is opaque, so a join disc over
 * the band never blends twice. Heights come from the nearest COVERED cell, per vertex, so a band
 * across a step tilts with the terrain instead of tearing — and the band is built once for the whole
 * ring, not per height group, which is what drew an unowned piece in every pass.
 *
 * THE SHARED QUAD IS NOT OURS TO DISPOSE. `body.cellQuad` is one unit quad, already rotated flat,
 * used by every cell of every measurement. Making a geometry per call is a leak; disposing this one
 * breaks every other measurement.
 */

/** What the body drawer may do to the entry it draws, and nothing else. */
export interface BodySink {
  readonly group: THREE.Group;
  trackMat<T extends THREE.Material>(mat: T, opacity: number): T;
  trackGeom<T extends THREE.BufferGeometry>(geom: T): T;
  addInst(inst: THREE.InstancedMesh): void;
}

/** What it needs besides the sink. `surfaceY` is injected: it depends on the slice and the layout. */
export interface BodyContext {
  readonly ctx: TacticalOverlayContext;
  readonly ceilingY: number;
  surfaceY(x: number, z: number): number;
  readonly cellQuad: THREE.BufferGeometry;
}

interface BorderEdge {
  readonly ax: number; readonly az: number; readonly bx: number; readonly bz: number;
  readonly cell: AreaCell; readonly nx: number; readonly nz: number;
}

// ---- the body, as Atlas' BODY constant holds it ------------------------------------------------
export const WASH_OPACITY = 0.12;
export const CELL_OPACITY = 0.16;
/** The accent stroke is OPAQUE, as Atlas' own is: overlaps then never blend twice. */
export const STROKE_OPACITY = 1;
const CELL_INSET = 0.025;
const MIN_CELL_INSET = 0.02;
const BORDER_WIDTH_SHARE = 1 / 28;
const MIN_BORDER_WIDTH = 0.04;
const WASH_ORDER = 2.4;
const FILL_ORDER = 2.5;
const RISER_ORDER = 2.55;
const BORDER_ORDER = 2.6;
/**
 * The layers are held well apart. They were 0.003 apart, which at the distance a camera preset
 * chooses is less than one depth step of a wide clipping range — so the wash and the cell tint
 * fought for the depth test in patches that moved with the camera.
 */
const WASH_LIFT = 0.018;
const FILL_LIFT = 0.034;
export const BORDER_LIFT = 0.052;
const RISER_INSET = 0.35;
const RISER_EPSILON = 0.02;
const RISER_OPACITY = 0.42;
const OWNER_REACH = 2;
export const MITRE_COS_FLOOR = 0.25;
/** Triangles in one round join or node disc. */
export const DISC_SEGMENTS = 16;

export const heightBucket = (y: number): number => Math.round(y * 1000);
export const cellKey = (cx: number, cz: number): string => `${cx},${cz}`;
const cornerKey = (x: number, z: number): string => `${Math.round(x * 1e6)},${Math.round(z * 1e6)}`;

/** The stroke width every figure wears, in world units: the area border's own. */
export const strokeWidth = (): number => Math.max(MIN_BORDER_WIDTH, BORDER_WIDTH_SHARE);

/** The unit left normal of a plan direction; zero for a direction that is none. */
function leftOf(dx: number, dz: number): { x: number; z: number } {
  const len = Math.hypot(dx, dz);
  return len > 1e-9 ? { x: -dz / len, z: dx / len } : { x: 0, z: 0 };
}

/** The height of a covered cell at a world x/z: flat, or draped over its slope. */
function cellY(body: BodyContext, c: AreaCell, x: number, z: number): number {
  if (c.slope === undefined) return c.y;
  const ctx = body.ctx;
  const q = quarterOf(c.slope.rot);
  const baseX = ctx.layout.originX + c.cx, baseZ = ctx.layout.originZ + c.cz;
  const u = Math.min(1, Math.max(0, x - baseX)), v = Math.min(1, Math.max(0, z - baseZ));
  const midF = surfaceFraction(c.slope.shape, q, (c.x0 + c.x1) / 2 - baseX, (c.z0 + c.z1) / 2 - baseZ);
  return c.y + (surfaceFraction(c.slope.shape, q, u, v) - midF) * ctx.map.layerHeight;
}

function borderEdgesOf(cells: readonly AreaCell[]): BorderEdge[] {
  const held = new Set(cells.map((c) => cellKey(c.cx, c.cz)));
  const out: BorderEdge[] = [];
  for (const c of cells) {
    const { x0, x1, z0, z1, cx, cz } = c;
    if (!held.has(cellKey(cx, cz - 1))) out.push({ ax: x0, az: z0, bx: x1, bz: z0, cell: c, nx: cx, nz: cz - 1 });
    if (!held.has(cellKey(cx + 1, cz))) out.push({ ax: x1, az: z0, bx: x1, bz: z1, cell: c, nx: cx + 1, nz: cz });
    if (!held.has(cellKey(cx, cz + 1))) out.push({ ax: x1, az: z1, bx: x0, bz: z1, cell: c, nx: cx, nz: cz + 1 });
    if (!held.has(cellKey(cx - 1, cz))) out.push({ ax: x0, az: z1, bx: x0, bz: z0, cell: c, nx: cx - 1, nz: cz });
  }
  return out;
}

function insetOf(c: AreaCell): number {
  const span = Math.min(c.x1 - c.x0, c.z1 - c.z0);
  return Math.min(Math.max(MIN_CELL_INSET, span * CELL_INSET), span * 0.4);
}

/**
 * The three layers, and the outline once. Returns the highest covered height at each cell corner,
 * which a range ring's stroke then stands on.
 */
export function drawRegionBody(
  sink: BodySink, region: MeasureRegion, body: BodyContext,
  color: THREE.Color, withEffect: boolean,
): Map<string, number> {
  const cells = region.cells;
  const corners = new Map<string, number>();
  if (cells.length === 0) return corners;
  const ctx = body.ctx;
  const borderMat = sink.trackMat(new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: STROKE_OPACITY, depthWrite: false, side: THREE.DoubleSide,
  }), STROKE_OPACITY);
  const riserMat = sink.trackMat(new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: RISER_OPACITY, depthWrite: false, side: THREE.DoubleSide,
  }), RISER_OPACITY);
  const cellMat = sink.trackMat(new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: CELL_OPACITY, depthWrite: false, side: THREE.DoubleSide,
  }), CELL_OPACITY);
  const washMat = withEffect ? null : sink.trackMat(new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: WASH_OPACITY, depthWrite: false, side: THREE.DoubleSide,
  }), WASH_OPACITY);
  const groups = new Map<number, AreaCell[]>();
  for (const cell of cells) {
    const key = heightBucket(cell.y);
    const list = groups.get(key);
    if (list) list.push(cell); else groups.set(key, [cell]);
    for (const [x, z] of [[cell.x0, cell.z0], [cell.x1, cell.z0], [cell.x1, cell.z1], [cell.x0, cell.z1]] as const) {
      const ck = cornerKey(x, z);
      const y = cellY(body, cell, x, z);
      const held = corners.get(ck);
      if (held === undefined || y > held) corners.set(ck, y);
    }
  }
  const byKey = new Map<string, AreaCell[]>();
  for (const c of cells) {
    const k = cellKey(c.cx, c.cz);
    const list = byKey.get(k);
    if (list) list.push(c); else byKey.set(k, [c]);
  }
  const ownerAt = (x: number, z: number): AreaCell | null => {
    const gx = Math.floor(x - ctx.layout.originX);
    const gz = Math.floor(z - ctx.layout.originZ);
    for (let r = 0; r <= OWNER_REACH; r++) {
      let best: AreaCell | null = null;
      let bestD = Infinity;
      for (let oz = -r; oz <= r; oz++) {
        for (let ox = -r; ox <= r; ox++) {
          if (Math.max(Math.abs(ox), Math.abs(oz)) !== r) continue;
          const list = byKey.get(cellKey(gx + ox, gz + oz));
          if (!list) continue;
          for (const c of list) {
            const d = Math.hypot((c.x0 + c.x1) / 2 - x, (c.z0 + c.z1) / 2 - z);
            if (d < bestD) { bestD = d; best = c; }
          }
        }
      }
      if (best !== null) return best;
    }
    return null;
  };
  const washFlats: AreaCell[] = [];
  const tileFlats: AreaCell[] = [];
  const riserPts: number[] = [];
  const width = strokeWidth();
  // Risers belong to a GROWN cell set — an aura or a range ring — whose area is cells and whose
  // boundary therefore runs along cell edges at every step. A beam is a drawn rectangle: its
  // outline happens to be its cells' staircase, so treating it as stepped too stroked the same
  // boundary twice, once as the ring and once as risers.
  const stepped = (typeof region.follows === 'string' && region.follows !== '')
    || region.mode === 'ranges';
  for (const [, group] of groups) {
    for (const cell of group) {
      if (cell.slope === undefined) {
        if (washMat) washFlats.push(cell);
        tileFlats.push(cell);
      } else {
        if (washMat) drapeSlopeCell(sink, cell, body, washMat, 0, WASH_LIFT, WASH_ORDER);
        drapeSlopeCell(sink, cell, body, cellMat, insetOf(cell), FILL_LIFT, FILL_ORDER);
      }
    }
    if (stepped) {
      for (const edge of borderEdgesOf(group)) {
        pushRiser(riserPts, body, edge, width / 2);
      }
    }
  }
  if (washMat) instanceCells(sink, washFlats, body, washMat, 0, WASH_LIFT, WASH_ORDER);
  instanceCells(sink, tileFlats, body, cellMat, -1, FILL_LIFT, FILL_ORDER);
  if (riserPts.length > 0) {
    const g = sink.trackGeom(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.Float32BufferAttribute(riserPts, 3));
    const m = new THREE.Mesh(g, riserMat);
    m.renderOrder = RISER_ORDER;
    sink.group.add(m);
  }
  // ONE pass for the whole outline, heights per vertex from the nearest covered cell.
  const borderPts: number[] = [];
  pushRingStroke(borderPts, region.outline, width, (x, z) => {
    const owner = ownerAt(x, z);
    return (owner !== null ? cellY(body, owner, x, z) : body.surfaceY(x, z)) + BORDER_LIFT;
  });
  if (borderPts.length > 0) {
    const g = sink.trackGeom(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.Float32BufferAttribute(borderPts, 3));
    const m = new THREE.Mesh(g, borderMat);
    m.renderOrder = BORDER_ORDER;
    sink.group.add(m);
  }
  return corners;
}

/**
 * A closed ring stroked as ONE mitred band of constant width, with a round disc at every vertex
 * for the join. Consecutive quads share exact vertices, so they tile without gap; the material is
 * opaque, so a join disc overlapping the band never blends twice. No prolongations, no walking
 * step: those are what beaded a circle and spiked a cone's apex.
 *
 * Heights are taken per VERTEX, so a band crossing a step tilts with the terrain rather than
 * tearing between two edges that disagree about the height of their shared corner.
 */
export function pushRingStroke(
  pts: number[],
  rings: readonly PlanRing[],
  width: number,
  yAt: (x: number, z: number) => number,
): void {
  const half = width / 2;
  for (const ring of rings) {
    const n = ring.length;
    if (n < 3) continue;
    const lx: number[] = [], lz: number[] = [], rx: number[] = [], rz: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < n; i++) {
      const prev = ring[(i - 1 + n) % n]!;
      const v = ring[i]!;
      const next = ring[(i + 1) % n]!;
      const n1 = leftOf(v.x - prev.x, v.z - prev.z);
      const n2 = leftOf(next.x - v.x, next.z - v.z);
      let mx = n1.x + n2.x, mz = n1.z + n2.z;
      const ml = Math.hypot(mx, mz);
      let scale = half;
      if (ml > 1e-9) {
        mx /= ml; mz /= ml;
        scale = half / Math.max(MITRE_COS_FLOOR, mx * n2.x + mz * n2.z);
      } else { mx = n2.x; mz = n2.z; }
      lx.push(v.x + mx * scale); lz.push(v.z + mz * scale);
      rx.push(v.x - mx * scale); rz.push(v.z - mz * scale);
      ys.push(yAt(v.x, v.z));
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const y0 = ys[i]!, y1 = ys[j]!;
      pts.push(
        lx[i]!, y0, lz[i]!, rx[i]!, y0, rz[i]!, rx[j]!, y1, rz[j]!,
        lx[i]!, y0, lz[i]!, rx[j]!, y1, rz[j]!, lx[j]!, y1, lz[j]!,
      );
    }
    for (let i = 0; i < n; i++) {
      const v = ring[i]!, y = ys[i]!;
      for (let k = 0; k < DISC_SEGMENTS; k++) {
        const a0 = (k / DISC_SEGMENTS) * Math.PI * 2;
        const a1 = ((k + 1) / DISC_SEGMENTS) * Math.PI * 2;
        pts.push(
          v.x, y, v.z,
          v.x + Math.cos(a0) * half, y, v.z + Math.sin(a0) * half,
          v.x + Math.cos(a1) * half, y, v.z + Math.sin(a1) * half,
        );
      }
    }
  }
}

function instanceCells(
  sink: BodySink, cells: readonly AreaCell[], body: BodyContext, mat: THREE.Material,
  inset: number, lift: number, order: number,
): void {
  if (cells.length === 0) return;
  const inst = new THREE.InstancedMesh(body.cellQuad, mat, cells.length);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!;
    const by = inset < 0 ? insetOf(c) : inset;
    dummy.position.set((c.x0 + c.x1) / 2, c.y + lift, (c.z0 + c.z1) / 2);
    dummy.scale.set(Math.max(0.02, (c.x1 - c.x0) - 2 * by), 1, Math.max(0.02, (c.z1 - c.z0) - 2 * by));
    dummy.updateMatrix();
    inst.setMatrixAt(i, dummy.matrix);
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.renderOrder = order;
  sink.addInst(inst);
}

function pushRiser(pts: number[], body: BodyContext, edge: BorderEdge, half: number): void {
  const ctx = body.ctx;
  const c = edge.cell;
  const base = cellY(body, c, (edge.ax + edge.bx) / 2, (edge.az + edge.bz) / 2);
  const across = body.surfaceY(ctx.layout.originX + edge.nx + 0.5, ctx.layout.originZ + edge.nz + 0.5);
  const delta = across - base;
  if (Math.abs(delta) <= RISER_EPSILON) return;
  const dx = edge.bx - edge.ax, dz = edge.bz - edge.az;
  const len = Math.hypot(dx, dz);
  if (!(len > 1e-6)) return;
  const inx = (dz / len) * half * RISER_INSET, inz = (-dx / len) * half * RISER_INSET;
  const ax = edge.ax + inx, az = edge.az + inz, bx = edge.bx + inx, bz = edge.bz + inz;
  const y0 = base + BORDER_LIFT * 0.5, y1 = across + BORDER_LIFT * 0.5;
  if (delta > 0) pts.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y0, az, bx, y1, bz, ax, y1, az);
  else pts.push(ax, y0, az, bx, y1, bz, bx, y0, bz, ax, y0, az, ax, y1, az, bx, y1, bz);
}

function drapeSlopeCell(
  sink: BodySink, c: AreaCell, body: BodyContext, mat: THREE.Material,
  inset: number, lift: number, order: number,
): void {
  const x0 = c.x0 + inset, x1 = c.x1 - inset, z0 = c.z0 + inset, z1 = c.z1 - inset;
  if (!(x1 > x0) || !(z1 > z0)) return;
  const corner = (x: number, z: number): THREE.Vector3 => new THREE.Vector3(x, cellY(body, c, x, z) + lift, z);
  const a = corner(x0, z0), b = corner(x1, z0), d = corner(x1, z1), e = corner(x0, z1);
  const g = sink.trackGeom(new THREE.BufferGeometry());
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    a.x, a.y, a.z, b.x, b.y, b.z, d.x, d.y, d.z,
    a.x, a.y, a.z, d.x, d.y, d.z, e.x, e.y, e.z,
  ], 3));
  const m = new THREE.Mesh(g, mat);
  m.renderOrder = order;
  sink.group.add(m);
}

/** A range ring's outline, stroked as the body's is, on the surfaces the body covers. */
export function drawRingOutline(
  sink: BodySink, rings: readonly PlanRing[], body: BodyContext,
  mat: THREE.Material, covered: ReadonlyMap<string, number>,
): void {
  if (rings.length === 0) return;
  const pts: number[] = [];
  pushRingStroke(pts, rings, strokeWidth(), (x, z) => {
    const held = covered.get(cornerKey(x, z));
    return (held !== undefined ? held : body.surfaceY(x, z)) + BORDER_LIFT;
  });
  if (pts.length === 0) return;
  const g = sink.trackGeom(new THREE.BufferGeometry());
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const m = new THREE.Mesh(g, mat);
  m.renderOrder = BORDER_ORDER;
  sink.group.add(m);
}