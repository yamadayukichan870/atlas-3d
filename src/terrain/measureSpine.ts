import type { Layout } from './layout';
import type { PlanCell, PlanPoint } from './measureGeometry';
import { EDGE_TOLERANCE } from '../atlas/measureRules';

/**
 * The cells a line's middle line makes its own, as Atlas decides them.
 *
 * Ported from atlas-vtt/atlas-vtt `measure/measureCells.ts`: `depthAtSide`, `meetingOf` and
 * `cellsOnSpine`, whose own words are:
 *
 *   "those it runs through the INSIDE of, and with them those it runs along a side of ...
 *    A spine that runs through no cell (along a square grid's line) makes none."
 *   "a corner or a point of a side is no meeting"
 *
 * THIS REPLACES A DDA. A digital-line walk marks every cell the segment touches, and its corner
 * tie-break steps both axes at once, so a spine lying on a grid line forced the cells of BOTH
 * rows — the beam marked two cells where Atlas marks only the one its body reaches into. Atlas
 * instead clips the segment against each cell and asks where the middle of the clipped part lies:
 * strictly off every side is `inside`, on a side is `beside`, no length at all is `none`. Only
 * `inside` cells are forced; `beside` ones join them ONLY if some cell was entered, which is what
 * keeps a hex chain together and leaves a square grid's boundary line forcing nothing.
 *
 * Work is in GRID coordinates (one cell spans one unit), so a cell's corners are the same four
 * numbers for every cell and the classification is exact at any map offset.
 */

/** A cell's corners around its centre, wound so `depthAtSide` is positive inside. */
const CORNERS: readonly number[] = [-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5];
/** From a cell's centre to its corners: every cell the segment touches is within this of it. */
const REACH = Math.SQRT1_2;

type Meeting = 'none' | 'beside' | 'inside';

/** How far inside the side of a cell from corner `c` the point (`px`, `pz`) lies. */
function depthAtSide(c: number, cx: number, cz: number, px: number, pz: number): number {
  const ex = CORNERS[(c + 2) % CORNERS.length]! - CORNERS[c]!;
  const ez = CORNERS[(c + 3) % CORNERS.length]! - CORNERS[c + 1]!;
  return (ex * (pz - cz - CORNERS[c + 1]!) - ez * (px - cx - CORNERS[c]!)) / Math.hypot(ex, ez);
}

/**
 * How the way from a to b meets the cell around (`cx`, `cz`): the part of it within the cell must
 * have a length, and runs through the inside where its middle lies off every side.
 */
function meetingOf(cx: number, cz: number, ax: number, az: number, bx: number, bz: number): Meeting {
  let enters = 0;
  let leaves = 1;
  for (let c = 0; c < CORNERS.length; c += 2) {
    const from = depthAtSide(c, cx, cz, ax, az);
    const gain = depthAtSide(c, cx, cz, bx, bz) - from;
    // Along this side's direction the whole way: it lies on the cell's side of it, or misses it.
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
  for (let c = 0; c < CORNERS.length; c += 2) {
    if (!(depthAtSide(c, cx, cz, mx, mz) > EDGE_TOLERANCE)) return 'beside';
  }
  return 'inside';
}

/** Distance from a point to the segment, for choosing the cells worth classifying. */
function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / l2));
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

/**
 * The cells the spine from `from` to `to` forces, whatever the area's cell rule. Empty for a spine
 * that runs along a grid line without entering any cell — which is Atlas' own answer, and what
 * stops a beam placed between two cells from marking both.
 */
export function cellsOnSpine(from: PlanPoint, to: PlanPoint, layout: Layout): PlanCell[] {
  if (!Number.isFinite(from.x) || !Number.isFinite(from.z)) return [];
  if (!Number.isFinite(to.x) || !Number.isFinite(to.z)) return [];
  const ax = from.x - layout.originX, az = from.z - layout.originZ;
  const bx = to.x - layout.originX, bz = to.z - layout.originZ;
  if (!(Math.hypot(bx - ax, bz - az) > EDGE_TOLERANCE)) return [];
  const cx0 = Math.max(layout.range.cx0, Math.floor(Math.min(ax, bx) - REACH));
  const cx1 = Math.min(layout.range.cx1, Math.ceil(Math.max(ax, bx) + REACH));
  const cz0 = Math.max(layout.range.cz0, Math.floor(Math.min(az, bz) - REACH));
  const cz1 = Math.min(layout.range.cz1, Math.ceil(Math.max(az, bz) + REACH));
  const inside: PlanCell[] = [];
  const beside: PlanCell[] = [];
  for (let cz = cz0; cz <= cz1; cz++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const mx = cx + 0.5, mz = cz + 0.5;
      if (distToSegment(mx, mz, ax, az, bx, bz) > REACH) continue;
      const meeting = meetingOf(mx, mz, ax, az, bx, bz);
      if (meeting === 'inside') inside.push({ cx, cz });
      else if (meeting === 'beside') beside.push({ cx, cz });
    }
  }
  // A spine that entered no cell forces none: along a square grid's line it lies beside two rows
  // and belongs to neither. The cell rule alone decides those.
  if (inside.length === 0) return [];
  return [...inside, ...beside];
}