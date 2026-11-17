import type { BlockMap } from './blocks';
import type { Layout } from './layout';
import type { Vec3 } from './shapes';

export type MeasureShape = 'ruler' | 'circle' | 'cone' | 'square' | 'line' | 'ranges';
export type DiagonalRule = 'alternating' | '5e' | 'exact';
export type MeasurementMode = 'metric' | 'abstract';
export type ConeEndMode = 'flat' | 'round';

export interface RangeBandDef {
  name: string;
  squares?: number;
  maxSquares?: number;
  distance?: number;
}

export interface MovementStepDef {
  name: string;
  color?: string;
  multiplier?: number;
}

export interface MeasureRuleOptions {
  diagonalRule: DiagonalRule;
  measurementMode: MeasurementMode;
  unitDistance: number;
  unitLabel: string;
  rangeBands: readonly RangeBandDef[];
  coneEnd: ConeEndMode;
}

export interface LegMeasurement {
  from: Vec3;
  to: Vec3;
  horizCells: number;
  dist3dCells: number;
  deltaYCells: number;
  label: string;
}

export interface PathMeasurement {
  legs: LegMeasurement[];
  totalHorizCells: number;
  total3dCells: number;
  netDeltaYCells: number;
  totalLabel: string;
  subLabel?: string;
  rangeBand?: string;
}

export interface AoECell {
  cx: number;
  cz: number;
  y: number;
}

export interface MeasureTokenTarget {
  id: string;
  x: number;
  y: number;
  z: number;
  radiusCells: number;
}

/** 5e standard 53.13° cone (width = length at end). */
export const CONE_HALF_ANGLE_5E = Math.atan(0.5);

export function normalizeDiagonalRule(raw: unknown): DiagonalRule {
  if (typeof raw !== 'string') return '5e';
  const v = raw.trim().toLowerCase();
  if (v === 'alternating' || v === '5-10-5' || v === '1-2-1' || v === 'pf2e') return 'alternating';
  if (v === 'exact' || v === 'euclidean' || v === 'true') return 'exact';
  return '5e';
}

export function formatMeasureNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function resolveRangeBand(
  cells: number,
  unitDistance: number,
  bands: readonly RangeBandDef[],
): string | undefined {
  if (bands.length === 0) return undefined;
  const sorted = [...bands].sort((a, b) => bandLimitCells(a, unitDistance) - bandLimitCells(b, unitDistance));
  for (const band of sorted) {
    if (cells <= bandLimitCells(band, unitDistance) + 1e-4) return band.name;
  }
  return sorted[sorted.length - 1]?.name;
}

function bandLimitCells(band: RangeBandDef, unitDistance: number): number {
  if (typeof band.maxSquares === 'number') return band.maxSquares;
  if (typeof band.squares === 'number') return band.squares;
  if (typeof band.distance === 'number' && unitDistance > 0) return band.distance / unitDistance;
  return Infinity;
}

/**
 * Measures a multi-segment 3D path following Atlas VTT's diagonal rule, unit scale and range bands.
 */
export function measurePath(points: readonly Vec3[], opts: MeasureRuleOptions): PathMeasurement {
  const legs: LegMeasurement[] = [];
  let totalHorizCells = 0;
  let total3dCells = 0;
  let diagAcc = 0;

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dx = Math.abs(b[0] - a[0]);
    const dy = b[1] - a[1];
    const dz = Math.abs(b[2] - a[2]);

    let legHoriz: number;
    if (opts.diagonalRule === 'exact') {
      legHoriz = Math.hypot(dx, dz);
    } else if (opts.diagonalRule === 'alternating') {
      const diag = Math.min(dx, dz);
      const straight = Math.max(dx, dz) - diag;
      const prevHalf = Math.floor((diagAcc + 1e-4) / 2);
      diagAcc += diag;
      const nextHalf = Math.floor((diagAcc + 1e-4) / 2);
      legHoriz = straight + diag + (nextHalf - prevHalf);
    } else {
      legHoriz = Math.max(dx, dz);
    }

    const leg3d = opts.diagonalRule === 'exact'
      ? Math.hypot(dx, dy, dz)
      : Math.hypot(legHoriz, dy);

    totalHorizCells += legHoriz;
    total3dCells += leg3d;

    const legUnits = legHoriz * opts.unitDistance;
    const leg3dUnits = leg3d * opts.unitDistance;
    const hasHeight = Math.abs(dy) >= 0.08;
    const label = hasHeight
      ? `${formatMeasureNumber(legUnits)} ${opts.unitLabel} (3D: ${formatMeasureNumber(leg3dUnits)})`
      : `${formatMeasureNumber(legUnits)} ${opts.unitLabel}`;

    legs.push({
      from: a,
      to: b,
      horizCells: legHoriz,
      dist3dCells: leg3d,
      deltaYCells: dy,
      label,
    });
  }

  const origin = points[0] ?? ([0, 0, 0] as const);
  const tip = points[points.length - 1] ?? origin;
  const netDeltaYCells = tip[1] - origin[1];
  const horizUnits = totalHorizCells * opts.unitDistance;
  const dist3dUnits = total3dCells * opts.unitDistance;
  const deltaYUnits = netDeltaYCells * opts.unitDistance;
  const hasHeight = Math.abs(netDeltaYCells) >= 0.08;

  const rangeBand = opts.measurementMode === 'abstract'
    ? resolveRangeBand(totalHorizCells, opts.unitDistance, opts.rangeBands)
    : undefined;

  let totalLabel: string;
  if (rangeBand) {
    totalLabel = hasHeight
      ? `${rangeBand} (${formatMeasureNumber(dist3dUnits)} ${opts.unitLabel})`
      : rangeBand;
  } else if (hasHeight) {
    totalLabel = `${formatMeasureNumber(horizUnits)} ${opts.unitLabel} (3D: ${formatMeasureNumber(dist3dUnits)} ${opts.unitLabel})`;
  } else {
    totalLabel = `${formatMeasureNumber(horizUnits)} ${opts.unitLabel}`;
  }

  const subParts: string[] = [];
  if (hasHeight) subParts.push(`ΔH ${deltaYUnits >= 0 ? '+' : ''}${formatMeasureNumber(deltaYUnits)} ${opts.unitLabel}`);
  if (legs.length > 1) subParts.push(`${legs.length} legs`);

  return {
    legs,
    totalHorizCells,
    total3dCells,
    netDeltaYCells,
    totalLabel,
    subLabel: subParts.length > 0 ? subParts.join(' · ') : undefined,
    rangeBand,
  };
}

function pointToSegmentDist3D(p: Vec3, a: Vec3, b: Vec3): { dist: number; t: number } {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const vz = b[2] - a[2];
  const lenSq = vx * vx + vy * vy + vz * vz;
  if (lenSq < 1e-8) return { dist: Math.hypot(p[0] - a[0], p[1] - a[1], p[2] - a[2]), t: 0 };
  const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy + (p[2] - a[2]) * vz) / lenSq));
  const px = a[0] + vx * t;
  const py = a[1] + vy * t;
  const pz = a[2] + vz * t;
  return { dist: Math.hypot(p[0] - px, p[1] - py, p[2] - pz), t };
}

export function isPointInsideArea(
  shape: Exclude<MeasureShape, 'ruler' | 'ranges'>,
  p: Vec3,
  origin: Vec3,
  tip: Vec3,
  coneEnd: ConeEndMode = 'flat',
  paddingCells: number = 0,
): boolean {
  if (shape === 'circle') {
    const r = Math.hypot(tip[0] - origin[0], tip[1] - origin[1], tip[2] - origin[2]);
    const d = Math.hypot(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]);
    return d <= r + paddingCells;
  }

  if (shape === 'square') {
    const half = Math.max(Math.abs(tip[0] - origin[0]), Math.abs(tip[2] - origin[2]), 0.5);
    return (
      Math.abs(p[0] - origin[0]) <= half + paddingCells
      && Math.abs(p[2] - origin[2]) <= half + paddingCells
      && Math.abs(p[1] - origin[1]) <= half + 0.75 + paddingCells
    );
  }

  if (shape === 'line') {
    const { dist } = pointToSegmentDist3D(p, origin, tip);
    return dist <= 0.5 + paddingCells;
  }

  // Cone
  const dx = tip[0] - origin[0];
  const dy = tip[1] - origin[1];
  const dz = tip[2] - origin[2];
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-4) return false;

  const vx = p[0] - origin[0];
  const vy = p[1] - origin[1];
  const vz = p[2] - origin[2];
  const vLen = Math.hypot(vx, vy, vz);
  if (vLen < 0.35 + paddingCells) return true;

  const ux = dx / len;
  const uy = dy / len;
  const uz = dz / len;
  const along = vx * ux + vy * uy + vz * uz;
  if (along < -paddingCells) return false;

  if (coneEnd === 'flat') {
    if (along > len + paddingCells) return false;
  } else if (vLen > len + paddingCells) {
    return false;
  }

  const cosAngle = (vx * ux + vy * uy + vz * uz) / vLen;
  const maxSlope = Math.tan(CONE_HALF_ANGLE_5E);
  const perp = Math.sqrt(Math.max(0, vLen * vLen - along * along));
  return cosAngle >= Math.cos(CONE_HALF_ANGLE_5E) || perp <= Math.max(0, along) * maxSlope + paddingCells;
}

/**
 * Collects walkable terrain cells covered by a 3D AoE (`circle`, `cone`, `square`, or 1-cell `line`),
 * respecting vertical slice `maxLayer`.
 */
export function collectAoECells(
  shape: Exclude<MeasureShape, 'ruler' | 'ranges'>,
  origin: Vec3,
  tip: Vec3,
  map: BlockMap,
  layout: Layout,
  maxLayer: number = Infinity,
  coneEnd: ConeEndMode = 'flat',
): AoECell[] {
  const radius = shape === 'square'
    ? Math.max(Math.abs(tip[0] - origin[0]), Math.abs(tip[2] - origin[2]), 0.5)
    : Math.hypot(tip[0] - origin[0], tip[1] - origin[1], tip[2] - origin[2]);
  if (radius <= 0.05) return [];

  const ceilingY = Number.isFinite(maxLayer) ? maxLayer * map.layerHeight : Infinity;
  const minX = shape === 'line' ? Math.min(origin[0], tip[0]) - 1 : origin[0] - radius - 1;
  const maxX = shape === 'line' ? Math.max(origin[0], tip[0]) + 1 : origin[0] + radius + 1;
  const minZ = shape === 'line' ? Math.min(origin[2], tip[2]) - 1 : origin[2] - radius - 1;
  const maxZ = shape === 'line' ? Math.max(origin[2], tip[2]) + 1 : origin[2] + radius + 1;

  const minCx = Math.max(layout.range.cx0, Math.floor(minX - layout.originX));
  const maxCx = Math.min(layout.range.cx1, Math.ceil(maxX - layout.originX));
  const minCz = Math.max(layout.range.cz0, Math.floor(minZ - layout.originZ));
  const maxCz = Math.min(layout.range.cz1, Math.ceil(maxZ - layout.originZ));

  const out: AoECell[] = [];
  for (let cz = minCz; cz <= maxCz; cz++) {
    for (let cx = minCx; cx <= maxCx; cx++) {
      const wx = layout.originX + cx + 0.5;
      const wz = layout.originZ + cz + 0.5;
      const y = map.surfaceHeightAt(cx + 0.5, cz + 0.5, ceilingY);
      if (isPointInsideArea(shape, [wx, y, wz], origin, tip, coneEnd, 0.12)) {
        out.push({ cx, cz, y });
      }
    }
  }
  return out;
}

/**
 * Returns IDs of tokens whose 3D center/footprint overlaps the given measurement volume.
 */
export function tokensInMeasure(
  shape: MeasureShape,
  points: readonly Vec3[],
  tokens: readonly MeasureTokenTarget[],
  coneEnd: ConeEndMode = 'flat',
): string[] {
  if (shape === 'ruler' || shape === 'ranges' || points.length < 2) return [];
  const origin = points[0]!;
  const tip = points[points.length - 1]!;
  const inside: string[] = [];
  for (const tok of tokens) {
    if (isPointInsideArea(shape, [tok.x, tok.y, tok.z], origin, tip, coneEnd, Math.max(0.15, tok.radiusCells * 0.75))) {
      inside.push(tok.id);
    }
  }
  return inside;
}