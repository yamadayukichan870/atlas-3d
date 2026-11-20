/**
 * The handles of a kept measurement, and the gestures that move or resize it.
 *
 * Semantics verified first-hand against atlas-vtt/atlas-vtt @ tag 0.16.0:
 *   src/app/measure/auraArea.ts     -> auraCells, auraOfCells, steppedAura, auraBadgePoint,
 *                                      auraDirection, auraPoints, fitted, auraCellsDragged,
 *                                      auraCellsOfCircle, BADGE_DIRECTION, BADGE_STEP,
 *                                      LEAST_FREE_REACH, RIGHT
 *   src/app/measure/handleSpots.ts  -> tokenHolding, rimSpots, RIM_ROOM
 *   src/app/measure/measureMove.ts  -> measureMovedBy, areaResizedBy
 *   src/app/measure/tokenHeight.ts  -> tokenHeight, riseInCells, steppedHeight, heightField,
 *                                      signedHeight, heightChipText, MAX_TOKEN_HEIGHT
 *   src/app/measure/reachSteps.ts   -> bandReachChoices, bandReachOf, steppedReach
 *   src/app/measure/tokenDistance.ts-> spaceRadius, countsCells
 *
 * Why the badge sits on the RIM and not in the middle: a measurement that starts on a token
 * would put its readout over the token's own face, and take the presses meant for the token.
 * Atlas puts it on the edge of the token's space, lower-left, and each further measurement of
 * the same token a step along the rim, so ten of them fit without overlapping. That is the
 * whole of `rimSpots`, and it is what stops our pills covering the art.
 *
 * Why the far handle drags by PROJECTION: the handle is grabbed wherever it lies, so the
 * pointer's delta is projected onto the direction the handle lies from the token. Adding the
 * raw distance instead would make the handle jump the moment it is grabbed off-axis.
 *
 * World convention is Atlas 3D's: x/z are the plan, y is up, one grid cell spans one world
 * unit. Atlas works in world pixels with y down; both second axes point the same way on
 * screen (Atlas' +y is down, our +z is south), so directions carry over unchanged and only
 * the scale differs — `cellSize` replaces Atlas' grid.size.
 *
 * `diameter` is already in cells (1, 2, 3, 4), as `AreaTokenTarget` carries it, so it is not
 * converted from Atlas' `size` a second time here.
 *
 * Pure: no three.js, no DOM. Tested in Node.
 */

import {
  MAX_AURA,
  formatDistance,
  formatGameUnits,
  snapAreaEnd,
  snapAreaOrigin,
  snapRulerPoint,
  type AtlasMeasurementSettings,
} from '../atlas/measureRules';
import type { PlanPoint } from './measureGeometry';
import type { Vec3 } from './shapes';

// ---------------------------------------------------------------------------
// What the handles read
// ---------------------------------------------------------------------------

/** The grid a handle snaps to. `cellSize` is 1 in world units; kept explicit for callers in pixels. */
export interface HandleGrid {
  readonly cellSize: number;
  readonly originX: number;
  readonly originZ: number;
  /** Atlas' Snap: off, a token stands anywhere and its aura is a circle rather than cells. */
  readonly snapToGrid?: boolean;
}

/** What a handle reads of a token: where it stands and how much room it takes. */
export interface HandleToken {
  readonly id: string;
  /** Centre of its footprint, in world units over the plan. */
  readonly x: number;
  readonly z: number;
  /** Footprint in cells: 1, 2, 3, 4. */
  readonly diameter: number;
  /** Its place in the pile; unset is 0. The one on top is the one a press picks. */
  readonly layer?: number;
}

/** A kept measurement as the handles read it: what it follows, and where it starts. */
export interface HandleBearer {
  readonly id: string;
  readonly follows?: string;
  /** Its points in world units over the plan. A ruler's first point is its start. */
  readonly points: readonly PlanPoint[];
}

/** What a stepped reach is told by: whether the map names its reaches, and which. */
export type ReachSettings = Pick<AtlasMeasurementSettings, 'mode' | 'rangeBands'>;

/** What a height is read from. */
export interface HasHeight {
  readonly elevation?: unknown;
}

// ---------------------------------------------------------------------------
// Constants, exactly as Atlas holds them
// ---------------------------------------------------------------------------

/** The least an aura reaches where it is sized freely, in cells; on cells it reaches one at least. */
const LEAST_FREE_REACH = 0.5;
/** Where the first badge stands: lower left, clear of the token's own controls and marks. */
const BADGE_DIRECTION: PlanPoint = { x: -Math.SQRT1_2, z: Math.SQRT1_2 };
/** How far along the rim each further badge of one token stands, as an angle: ten go around it. */
const BADGE_STEP = Math.PI / 5;
/** Where the far handle of an aura lies when its points name no direction: to its token's right. */
const RIGHT: PlanPoint = { x: 1, z: 0 };
/**
 * How near the rim of a token's space a point lies and is no longer in it, in cells. Atlas holds
 * half a world pixel; at its usual fifty pixels to a cell that is this. An origin snapped to a
 * cell's edge lies on the rim of the token in that cell, where its badge covers nothing.
 */
const RIM_ROOM = 0.01;
/** The farthest from the floor a token is put, in game units either way. */
export const MAX_TOKEN_HEIGHT = 100_000;
/** Reaches are kept to thousandths, so steps of 1.5 m never add up to 4.499999. */
const thousandth = (value: number): number => Math.round(value * 1000) / 1000;

/** Whether tokens stand on whole cells of `grid`, which a reach then grows by; else they stand anywhere. */
export const countsCells = (grid: HandleGrid): boolean => grid.snapToGrid !== false && grid.cellSize > 0;

/** Half the width of the space a token takes up, in world units. */
export function spaceRadius(token: Pick<HandleToken, 'diameter'>, grid: Pick<HandleGrid, 'cellSize'>): number {
  return (Math.max(1, token.diameter) * grid.cellSize) / 2;
}

/** A length in world units as cells. The conversion Atlas' `measureGrid.lengthInCells` does. */
function lengthInCells(length: number, cellSize: number): number {
  return cellSize > 0 && Number.isFinite(cellSize) ? length / cellSize : length;
}

/** The grid points snap to, in the shape the rules module reads. */
function snapGridOf(grid: HandleGrid | null): { cellSize: number; originX: number; originZ: number } | null {
  if (!grid || !(grid.cellSize > 0) || !Number.isFinite(grid.cellSize)) return null;
  if (grid.snapToGrid === false) return null;
  return { cellSize: grid.cellSize, originX: grid.originX, originZ: grid.originZ };
}

const asVec3 = (p: PlanPoint): Vec3 => [p.x, 0, p.z];
const asPlan = (p: Vec3): PlanPoint => ({ x: p[0], z: p[2] });

// ---------------------------------------------------------------------------
// An aura's reach
// ---------------------------------------------------------------------------

/** An aura's reach in cells of a map on which one cell spans `unitDistance` game units. */
export function auraCells(aura: number, unitDistance: number): number {
  return unitDistance > 0 && Number.isFinite(unitDistance) ? lengthInCells(aura, unitDistance) : aura;
}

/** What an aura of `cells` cells holds as its reach: game units to the thousandth, within `MAX_AURA`. */
export function auraOfCells(cells: number, unitDistance: number): number {
  const units = cells * (unitDistance > 0 && Number.isFinite(unitDistance) ? unitDistance : 1);
  return units > 0 ? Math.min(MAX_AURA, thousandth(units)) : 0;
}

/**
 * A reach as an aura takes it: whole cells and one at least where the map counts cells, and to
 * the tenth of a cell where it does not or `free` says so. This is why an aura of 7 ft on a
 * 5 ft grid reaches one cell and not 1.4: Atlas fits it before it grows the token's cells.
 */
export function fittedReach(cells: number, grid: HandleGrid, free: boolean): number {
  if (free || !countsCells(grid)) return Math.max(LEAST_FREE_REACH, Math.round(cells * 10) / 10);
  return Math.max(1, Math.round(cells));
}

/**
 * How far an aura of `cells` cells reaches once its far handle was dragged `by` (world units):
 * what the drag adds ALONG `direction`, the way the handle lies from the token, so the handle
 * follows the pointer from wherever it was grabbed.
 */
export function auraCellsDragged(
  cells: number,
  by: PlanPoint,
  direction: PlanPoint,
  grid: HandleGrid,
  free = false,
): number {
  return fittedReach(cells + (by.x * direction.x + by.z * direction.z) / grid.cellSize, grid, free);
}

/** How far a circle drawn around `token` reaches past the edge of its space, as the aura it becomes. */
export function auraCellsOfCircle(
  points: readonly PlanPoint[],
  token: HandleToken,
  grid: HandleGrid,
): number {
  const centre = points[0];
  const end = points[1];
  const radius = centre && end ? Math.hypot(end.x - centre.x, end.z - centre.z) : 0;
  return fittedReach((radius - spaceRadius(token, grid)) / grid.cellSize, grid, false);
}

// ---------------------------------------------------------------------------
// Stepping a reach by hand: the + and − of an aura or a height
// ---------------------------------------------------------------------------

/** A reach a map with range bands names: the band, and how far it reaches in cells. */
export interface BandReach {
  readonly name: string;
  readonly cells: number;
}

/**
 * The reaches a map with range bands names, nearest first; none where it steps by cells. Of
 * bands that end at the same cell the first is the reach's name, as a distance is named.
 */
export function bandReachChoices(settings: ReachSettings): BandReach[] {
  if (settings.mode !== 'abstract') return [];
  const reaches = new Map<number, string>();
  for (const band of settings.rangeBands) {
    if (Number.isFinite(band.maxSquares) && band.maxSquares > 0 && !reaches.has(band.maxSquares)) {
      reaches.set(band.maxSquares, band.name);
    }
  }
  return [...reaches].map(([cells, name]) => ({ name, cells })).sort((a, b) => a.cells - b.cells);
}

/** The band a reach of `cells` is written as: the first that reaches as far, the farthest past them all. */
export function bandReachOf(cells: number, settings: ReachSettings): BandReach | undefined {
  const choices = bandReachChoices(settings);
  if (choices.length === 0) return undefined;
  const rounded = Math.round(cells);
  return choices.find((band) => rounded <= band.cells) ?? choices[choices.length - 1];
}

/**
 * `cells` after `steps` steps up or down. By cells: one cell a step. By bands: to the next
 * band's reach, through none (0) and on to the bands of the other side, which a height below
 * the floor has; past the farthest band it stays there.
 *
 * The descending walk is a reverse loop rather than `findLast`: this project's lib is ES2022.
 */
export function steppedReach(cells: number, steps: number, settings: ReachSettings): number {
  const reaches = bandReachChoices(settings).map((band) => band.cells);
  if (reaches.length === 0) return cells + steps;
  const stops = [...reaches.map((reach) => -reach).reverse(), 0, ...reaches];
  let at = cells;
  const up = steps > 0;
  for (let taken = 0; taken < Math.abs(steps); taken += 1) {
    let next: number | undefined;
    if (up) {
      next = stops.find((stop) => stop > at);
    } else {
      for (let i = stops.length - 1; i >= 0; i -= 1) {
        const stop = stops[i]!;
        if (stop < at) { next = stop; break; }
      }
    }
    if (next === undefined) break;
    at = next;
  }
  return at;
}

/**
 * An aura's reach after `steps` steps up or down, as the map steps a reach: what the token
 * menu's + and − do. Never below none, to the thousandth, within `MAX_AURA`.
 */
export function steppedAura(
  aura: number,
  steps: number,
  settings: Pick<AtlasMeasurementSettings, 'mode' | 'rangeBands' | 'unitDistance'>,
): number {
  const cells = steppedReach(auraCells(aura, settings.unitDistance), steps, settings);
  return Math.min(MAX_AURA, Math.max(0, thousandth(auraOfCells(cells, settings.unitDistance))));
}

// ---------------------------------------------------------------------------
// Where the badge stands
// ---------------------------------------------------------------------------

/**
 * Where a badge on `token` stands: on the rim of the token's space. The `place`-th of several
 * on one token stands that many steps along the rim, so they lie beside each other.
 */
export function auraBadgePoint(
  token: Pick<HandleToken, 'x' | 'z' | 'diameter'>,
  grid: Pick<HandleGrid, 'cellSize'>,
  place = 0,
): PlanPoint {
  const rim = spaceRadius(token, grid);
  const cos = Math.cos(place * BADGE_STEP);
  const sin = Math.sin(place * BADGE_STEP);
  return {
    x: token.x + (BADGE_DIRECTION.x * cos - BADGE_DIRECTION.z * sin) * rim,
    z: token.z + (BADGE_DIRECTION.x * sin + BADGE_DIRECTION.z * cos) * rim,
  };
}

/**
 * The token whose space holds `point`, its rim not counted: the one lying on top where several
 * do (the highest `layer`, the last of those, as a click picks it); null where none does.
 */
export function tokenHolding(
  point: PlanPoint,
  tokens: Iterable<HandleToken>,
  grid: Pick<HandleGrid, 'cellSize'>,
): HandleToken | null {
  let top: HandleToken | null = null;
  for (const token of tokens) {
    if (!Number.isFinite(token.x) || !Number.isFinite(token.z)) continue;
    if (top && (token.layer ?? 0) < (top.layer ?? 0)) continue;
    const reach = spaceRadius(token, grid) - RIM_ROOM;
    const dx = point.x - token.x;
    const dz = point.z - token.z;
    if (reach > 0 && dx * dx + dz * dz < reach * reach) top = token;
  }
  return top;
}

/** The token a kept measurement lies on: the one an aura follows, else the one holding its origin. */
function bearerOf(
  measure: HandleBearer,
  tokens: readonly HandleToken[],
  grid: Pick<HandleGrid, 'cellSize'>,
): HandleToken | null {
  if (typeof measure.follows === 'string' && measure.follows !== '') {
    return tokens.find((token) => token.id === measure.follows) ?? null;
  }
  const origin = measure.points[0];
  return origin ? tokenHolding(origin, tokens, grid) : null;
}

/**
 * Where the badges of the measurements that lie on a token stand: on the token's rim, the first
 * where an aura's always stood and each further one of the same token a step along the rim, in
 * the order they were kept, so none lies on another.
 *
 * A measurement on no token is not among them: its badge stands on its own region, as it does
 * today. No memo here, unlike Atlas': our caller already gates on a signature, so the array it
 * passes is fresh each time it asks and a cache keyed by its identity would never hit.
 */
export function rimSpots(
  measures: readonly HandleBearer[],
  tokens: readonly HandleToken[],
  grid: Pick<HandleGrid, 'cellSize'>,
): Map<string, PlanPoint> {
  const spots = new Map<string, PlanPoint>();
  const taken = new Map<string, number>();
  for (const measure of measures) {
    const token = bearerOf(measure, tokens, grid);
    if (!token || !Number.isFinite(token.x) || !Number.isFinite(token.z)) continue;
    const place = taken.get(token.id) ?? 0;
    taken.set(token.id, place + 1);
    spots.set(measure.id, auraBadgePoint(token, grid, place));
  }
  return spots;
}

// ---------------------------------------------------------------------------
// Where the far handle stands, and the two points an aura holds
// ---------------------------------------------------------------------------

/**
 * The way an aura's far handle lies from its token, one unit long: the way its two points lie,
 * and to the right where they say none.
 */
export function auraDirection(points: readonly PlanPoint[]): PlanPoint {
  const from = points[0];
  const to = points[1];
  const x = (to?.x ?? 0) - (from?.x ?? 0);
  const z = (to?.z ?? 0) - (from?.z ?? 0);
  const length = Math.hypot(x, z);
  return length > 0 && Number.isFinite(length) ? { x: x / length, z: z / length } : RIGHT;
}

/**
 * The two points an aura holds, for whoever reads it without knowing auras: its token's centre
 * and the point `cells` cells past the edge of its space, the way `direction` lies. Written
 * whenever the aura itself is edited; a token that moves leaves them where they are, which is
 * why the 3D geometry must come from the reach and the token's space, never from these points.
 */
export function auraPoints(
  token: Pick<HandleToken, 'x' | 'z' | 'diameter'>,
  cells: number,
  grid: Pick<HandleGrid, 'cellSize'>,
  direction: PlanPoint = RIGHT,
): [PlanPoint, PlanPoint] {
  const radius = spaceRadius(token, grid) + cells * grid.cellSize;
  return [
    { x: token.x, z: token.z },
    { x: token.x + direction.x * radius, z: token.z + direction.z * radius },
  ];
}

// ---------------------------------------------------------------------------
// Moving and resizing a kept measurement
// ---------------------------------------------------------------------------

/**
 * `points` moved by `by`. Its first point then snaps as the start of a new measurement of
 * `mode` would (a ruler's to the cell's centre, an area's to the places areas are measured
 * from), and the others follow it by the same delta, so its shape and size stay.
 */
export function measureMovedBy(
  mode: string,
  points: readonly PlanPoint[],
  by: PlanPoint,
  grid: HandleGrid | null,
  free = false,
): PlanPoint[] {
  const first = points[0];
  if (!first) return [];
  const moved: PlanPoint = { x: first.x + by.x, z: first.z + by.z };
  const snap = snapGridOf(grid);
  const start = asPlan(mode === 'ruler'
    ? snapRulerPoint(snap, asVec3(moved), free)
    : snapAreaOrigin(snap, asVec3(moved), free));
  const dx = start.x - first.x;
  const dz = start.z - first.z;
  return points.map((point) => ({ x: point.x + dx, z: point.z + dz }));
}

/**
 * An area's two points with its far end moved by `by`, its origin staying: the area is resized
 * and turned. The end then snaps as a new area's would (its size to whole cells). An end that
 * would land on the origin stays where it was, since an area has a size.
 */
export function areaResizedBy(
  points: readonly PlanPoint[],
  by: PlanPoint,
  grid: HandleGrid | null,
  free = false,
): PlanPoint[] {
  const origin = points[0];
  const end = points[1];
  if (!origin || !end) return points.map((point) => ({ x: point.x, z: point.z }));
  const moved = asPlan(snapAreaEnd(
    snapGridOf(grid),
    asVec3(origin),
    asVec3({ x: end.x + by.x, z: end.z + by.z }),
    free,
  ));
  const sized = Math.hypot(moved.x - origin.x, moved.z - origin.z) > 0;
  return [{ x: origin.x, z: origin.z }, sized ? moved : { x: end.x, z: end.z }];
}

// ---------------------------------------------------------------------------
// A token's height: the same stepped reach, and the chip that names it
// ---------------------------------------------------------------------------

/** `token`'s height in game units: 0 on the floor, and for a value that is no height. Below 0 is a swimmer or a creature in a pit. */
export function tokenHeight(token: HasHeight | null | undefined): number {
  const height = token?.elevation;
  if (typeof height !== 'number' || !Number.isFinite(height)) return 0;
  return Math.max(-MAX_TOKEN_HEIGHT, Math.min(MAX_TOKEN_HEIGHT, height));
}

/** A difference in height of `gameUnits`, either way, in cells. */
export function riseInCells(gameUnits: number, unitDistance: number): number {
  if (!(unitDistance > 0) || !Number.isFinite(unitDistance) || !Number.isFinite(gameUnits)) return 0;
  return lengthInCells(Math.abs(gameUnits), unitDistance);
}

/**
 * `height` after `steps` steps up or down, as the map steps a reach: a cell's distance, or the
 * next range band. Kept to thousandths and within `MAX_TOKEN_HEIGHT`, either side of the floor.
 */
export function steppedHeight(
  height: number,
  steps: number,
  settings: Pick<AtlasMeasurementSettings, 'mode' | 'rangeBands' | 'unitDistance'>,
): number {
  const cells = steppedReach(height / settings.unitDistance, steps, settings);
  const next = thousandth(cells * settings.unitDistance);
  return Math.max(-MAX_TOKEN_HEIGHT, Math.min(MAX_TOKEN_HEIGHT, next));
}

/** The field a token holds for `height`: none on the floor, so a token that lands is as it was before it rose. */
export function heightField(height: number): { elevation: number | undefined } {
  return { elevation: height === 0 ? undefined : height };
}

/** A height as a menu writes it: "30ft", and "−10ft" below the floor. On the floor a map with range bands writes a dash. */
export function signedHeight(gameUnits: number, settings: AtlasMeasurementSettings): string {
  if (gameUnits === 0 && settings.mode === 'abstract') return '–';
  const magnitude = formatDistance(Math.abs(gameUnits) / settings.unitDistance, settings);
  return `${gameUnits < 0 ? '−' : ''}${magnitude}`;
}

/**
 * What a token's chip says: "↑ 30ft" above the floor, "↓ 10ft" below it, "↑ Close" where the map
 * measures in range bands; nothing on the floor.
 */
export function heightChipText(token: HasHeight, settings: AtlasMeasurementSettings): string {
  const height = tokenHeight(token);
  if (height === 0 || !(settings.unitDistance > 0)) return '';
  const named = settings.mode === 'abstract'
    ? formatDistance(Math.abs(height) / settings.unitDistance, settings)
    : formatGameUnits(Math.abs(height), settings);
  return `${height > 0 ? '↑' : '↓'} ${named}`;
}