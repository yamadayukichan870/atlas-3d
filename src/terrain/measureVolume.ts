/**
 * The 3D body of a measured area, and which tokens it actually reaches.
 *
 * This is Atlas 3D's OWN spatial reading, not Atlas parity: Atlas is a plan tool and has no
 * volume. The footprint (the cells Atlas marks) stays the authority for coverage; the volume
 * is a second layer drawn from the SAME parameters, so the two can never disagree about where
 * the area is — only about height, which the plan cannot express.
 *
 * What it answers:
 *   - `volumeOfArea` / `volumeOfAura`: the shell a renderer draws (dome, cone, box, cylinder).
 *   - `tokenInVolume`: whether a token's body is inside that shell, given the floor it stands on
 *     and its elevation. A flier 15ft up is in a ground cube's FOOTPRINT but out of its EFFECT;
 *     this is the test that tells them apart, so the view can dash its ring and offer
 *     `In volume (M)` beside `Select (N)`.
 *
 * Heights are composed by the caller as terrain-floor + token-elevation (the exact analogue of
 * Atlas' tokenHeight + floorOf), and passed in already in world units. This module never reads
 * the map, so it stays pure and testable.
 *
 * Defaults (all overridable through VolumeSettings, and later by the per-measure sidecar):
 *   circle -> dome: a sphere centred AT the floor, so its ground cross-section is exactly the
 *             footprint circle. (Lifting the centre by R would make the ground cross-section a
 *             point, contradicting the footprint — so the centre stays at the floor.)
 *   cone   -> a real cone from the apex along the drag, opening coneAngle; round end caps on the
 *             arc, flat end on a straight lid. Its plan silhouette is the 2D sector.
 *   square -> a cube L×L×L resting on the floor.
 *   line   -> a box L×W×H, as tall as it is wide by default (a beam or a wall).
 *   aura   -> a cylinder of radius spaceRadius + reach, as tall as it reaches (min one cell).
 *
 * Pure: no three.js, no DOM. Tested in Node.
 */
import {
  EDGE_TOLERANCE,
  MAX_AURA,
  areaShapeRules,
  type AtlasMeasureMode,
  type AtlasMeasureShape,
  type AtlasMeasurementSettings,
} from '../atlas/measureRules';
import { shapedArea, type AreaTokenTarget, type PlanPoint } from './measureGeometry';
import type { Vec3 } from './shapes';

// ---------------------------------------------------------------------------
// What a volume is
// ---------------------------------------------------------------------------
/** A dome: a sphere whose centre sits at the floor, so only the upper half stands above it. */
export interface DomeVolume {
  readonly kind: 'dome';
  readonly centre: Vec3;
  readonly radius: number;
}
/** A cone from its apex along a plan direction, opening `halfAngle` (radians) in all. */
export interface ConeVolume {
  readonly kind: 'cone';
  readonly apex: Vec3;
  readonly towards: PlanPoint;
  readonly length: number;
  readonly halfAngle: number;
  readonly end: 'flat' | 'round';
}
/** A box from the middle of its near side, `length` along `towards`, `width` across, `height` up. */
export interface BoxVolume {
  readonly kind: 'box';
  readonly origin: PlanPoint;
  readonly towards: PlanPoint;
  readonly baseY: number;
  readonly length: number;
  readonly width: number;
  readonly height: number;
}
/** A cylinder around a plan centre, from `baseY` up `height`. */
export interface CylinderVolume {
  readonly kind: 'cylinder';
  readonly centre: PlanPoint;
  readonly baseY: number;
  readonly radius: number;
  readonly height: number;
}
export type VolumeSpec = DomeVolume | ConeVolume | BoxVolume | CylinderVolume;

/** Per-measure overrides, as the sidecar will hold them. Unset fields take the kind's default. */
export interface VolumeSettings {
  /** Whether the shell is drawn at all. The footprint is drawn regardless. */
  readonly show?: boolean;
  /** Overrides the height of a box or cylinder, in cells. */
  readonly heightCells?: number;
  /** Lifts the whole body off the floor, in cells (a burst detonating above the ground). */
  readonly liftCells?: number;
}

/** A token as the volume test reads it: its footprint, the floor under it, and its elevation. */
export interface VolumeTarget extends AreaTokenTarget {
  /** Height of the terrain surface it stands on, world units, under the slice. */
  readonly floorY: number;
  /** Elevation above that floor, world units (game units / unitDistance). May be negative. */
  readonly lift: number;
  /** How tall its body is, in cells; unset is one (a Medium creature). */
  readonly bodyCells?: number;
}

const TOL = EDGE_TOLERANCE;
const planDist = (a: PlanPoint, b: PlanPoint): number => Math.hypot(a.x - b.x, a.z - b.z);

// ---------------------------------------------------------------------------
// Building a volume from the same parameters that shape the footprint
// ---------------------------------------------------------------------------
/**
 * The shell of a drawn area. `points` are in world units with the height the picker gave them;
 * `baseY` is the floor at the origin. Returns null for a ruler or ranges (they have no body),
 * and for an area without a size.
 */
export function volumeOfArea(
  mode: AtlasMeasureMode,
  points: readonly Vec3[],
  widthCells: number,
  rules: AtlasMeasurementSettings,
  baseY: number,
  settings?: VolumeSettings,
): VolumeSpec | null {
  if (mode === 'ruler' || mode === 'ranges') return null;
  if (points.length < 2) return null;
  const o = points[0]!;
  const e = points[points.length - 1]!;
  const origin: PlanPoint = { x: o[0], z: o[2] };
  const end: PlanPoint = { x: e[0], z: e[2] };
  const area = shapedArea(mode as AtlasMeasureShape, origin, end, areaShapeRules(rules, widthCells), widthCells);
  if (!area) return null;
  const lift = (settings?.liftCells ?? 0);
  const base = baseY + lift;
  const overrideH = settings?.heightCells;

  if (mode === 'circle' || rules.coneAngle >= 360 && mode === 'cone') {
    return { kind: 'dome', centre: [origin.x, base, origin.z], radius: area.length };
  }
  if (mode === 'cone') {
    const halfAngle = (rules.coneAngle * Math.PI) / 360;
    const end = rules.coneEnd === 'flat' && rules.coneAngle < 180 ? 'flat' : 'round';
    return { kind: 'cone', apex: [origin.x, base, origin.z], towards: area.towards, length: area.length, halfAngle, end };
  }
  const width = mode === 'square' ? area.length : widthCells;
  const height = overrideH !== undefined && overrideH > 0 ? overrideH : (mode === 'square' ? area.length : width);
  return { kind: 'box', origin, towards: area.towards, baseY: base, length: area.length, width, height };
}

/**
 * The shell of an aura: a cylinder grown from the edge of the token's space, as tall as it
 * reaches (min one cell). `aura` is in game units; `baseY` the floor at the token.
 */
export function volumeOfAura(
  token: AreaTokenTarget,
  aura: number,
  rules: AtlasMeasurementSettings,
  baseY: number,
  settings?: VolumeSettings,
): VolumeSpec | null {
  if (!(aura > 0)) return null;
  const unit = rules.unitDistance > 0 ? rules.unitDistance : 1;
  const reach = Math.min(MAX_AURA, aura) / unit;
  const radius = Math.max(1, token.diameter) / 2 + reach;
  const base = baseY + (settings?.liftCells ?? 0);
  const height = settings?.heightCells !== undefined && settings.heightCells > 0
    ? settings.heightCells
    : Math.max(1, reach);
  return { kind: 'cylinder', centre: { x: token.x, z: token.z }, baseY: base, radius, height };
}

// ---------------------------------------------------------------------------
// The containment test, consistent with the shell it was built from
// ---------------------------------------------------------------------------
/** Whether a world point lies inside the volume, its surface included. */
export function volumeContains(spec: VolumeSpec, p: Vec3): boolean {
  switch (spec.kind) {
    case 'dome': {
      const dx = p[0] - spec.centre[0];
      const dy = p[1] - spec.centre[1];
      const dz = p[2] - spec.centre[2];
      return Math.hypot(dx, dy, dz) <= spec.radius + TOL;
    }
    case 'cone': {
      const dx = p[0] - spec.apex[0];
      const dy = p[1] - spec.apex[1];
      const dz = p[2] - spec.apex[2];
      const dist = Math.hypot(dx, dy, dz);
      if (dist <= TOL) return true;
      const along = dx * spec.towards.x + dz * spec.towards.z;
      if (along + TOL < dist * Math.cos(spec.halfAngle)) return false;
      return spec.end === 'flat' ? along <= spec.length + TOL : dist <= spec.length + TOL;
    }
    case 'box': {
      const dx = p[0] - spec.origin.x;
      const dz = p[2] - spec.origin.z;
      const along = dx * spec.towards.x + dz * spec.towards.z;
      const side = dx * spec.towards.z - dz * spec.towards.x;
      const up = p[1] - spec.baseY;
      return along >= -TOL && along <= spec.length + TOL
        && Math.abs(side) <= spec.width / 2 + TOL
        && up >= -TOL && up <= spec.height + TOL;
    }
    case 'cylinder': {
      const up = p[1] - spec.baseY;
      return planDist({ x: p[0], z: p[2] }, spec.centre) <= spec.radius + TOL
        && up >= -TOL && up <= spec.height + TOL;
    }
  }
}

/**
 * Whether a token's body is inside the volume. Its footprint corners and centre are tested at
 * its feet, middle and head, so a flier above the body reads out while one standing in it reads
 * in. An approximation on purpose: the volume is a reading, the footprint remains the authority.
 */
export function tokenInVolume(spec: VolumeSpec, t: VolumeTarget): boolean {
  const half = Math.max(1, t.diameter) / 2;
  const feet = t.floorY + t.lift;
  const body = Math.max(0.1, t.bodyCells ?? 1);
  const heights = [feet, feet + body / 2, feet + body];
  const plan: PlanPoint[] = [
    { x: t.x, z: t.z },
    { x: t.x - half, z: t.z - half },
    { x: t.x + half, z: t.z - half },
    { x: t.x + half, z: t.z + half },
    { x: t.x - half, z: t.z + half },
  ];
  for (const y of heights) {
    for (const c of plan) {
      if (volumeContains(spec, [c.x, y, c.z])) return true;
    }
  }
  return false;
}

/** The ids of the targets whose body the volume reaches, in the order given. */
export function tokensInVolume(spec: VolumeSpec, targets: readonly VolumeTarget[]): string[] {
  const out: string[] = [];
  for (const t of targets) if (tokenInVolume(spec, t)) out.push(t.id);
  return out;
}