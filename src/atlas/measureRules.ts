/**
 * Atlas VTT 0.16.0 measurement rules, as Atlas applies them.
 *
 * Verified first-hand against atlas-vtt/atlas-vtt @ tag 0.16.0:
 *   src/app/grid/measurementFormat.ts   -> settings resolution, unit labels, range band names
 *   src/app/measure/areaRules.ts        -> cell rule and cone end defaults
 *   src/app/measure/measureTypes.ts     -> shapes, modes and limits
 *   src/app/measure/movementRules.ts    -> movement steps, countPerTurn, step colouring
 *   src/app/measure/measureGeometry.ts  -> EDGE_TOLERANCE
 *   src/app/measure/rangeOutline.ts     -> MAX_RANGE_CELLS
 *
 * Carried over from an earlier verified reading of the same tag, to be re-read before the
 * geometry and overlay phases lean on them:
 *   src/app/grid/gridDistance.ts        -> the four diagonal cases with a climb
 *   src/app/measure/rangeRings.ts       -> ring reaches and their tolerances
 *   src/app/measure/measureSnap.ts      -> the three snapping rules
 *   src/app/grid/unitDistance.ts        -> unit distance bounds
 *
 * World convention here is Atlas 3D's: x/z are the plan, y is up, and points are Vec3 tuples
 * in world units where one grid cell spans one unit. Atlas works in world pixels with y down;
 * only the plan axes carry over, and `cellSize` replaces Atlas' grid.size.
 *
 * Vertical distances arrive as `riseCells`, already converted to grid cells by the caller.
 * This module never guesses how many world units a cell of height spans: that is the
 * `layerHeight` decision, and it belongs to whoever hands the rise in.
 *
 * Pure: one type-only import, erased at compile time. No three.js, no DOM, tested in Node.
 */

import type { Vec3 } from '../terrain/shapes';

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

/** What a measurement is drawn as. A ruler is a path with corners; the others are areas. */
export type AtlasMeasureShape = 'ruler' | 'circle' | 'cone' | 'square' | 'line';

/** What the measure tool does with a press: a shape, or labelled rings around a point. */
export type AtlasMeasureMode = AtlasMeasureShape | 'ranges';

export const ATLAS_MEASURE_SHAPES: readonly AtlasMeasureShape[] = [
  'ruler', 'circle', 'cone', 'square', 'line',
];

export const ATLAS_MEASURE_MODES: readonly AtlasMeasureMode[] = [
  'ruler', 'circle', 'cone', 'square', 'line', 'ranges',
];

/** How a square grid prices a diagonal step. Atlas' own four names. */
export type AtlasDiagonalRule = 'equidistant' | 'alternating' | 'manhattan' | 'euclidean';

/** When an area covers a cell: half of it, its centre, or any part of it. */
export type AtlasCellRule = 'half' | 'centre' | 'any';

/** How a cone ends: on the arc as far as it is long, or straight across the drag. */
export type AtlasConeEnd = 'flat' | 'round';

export type AtlasUnitType = 'feet' | 'yards' | 'meters' | 'units' | 'custom';

/** `metric` measures distances; `abstract` names them by range band. */
export type AtlasMeasurementMode = 'metric' | 'abstract';

// ---------------------------------------------------------------------------
// Defaults, limits and tolerances, exactly as Atlas holds them
// ---------------------------------------------------------------------------

export const DEFAULT_DIAGONAL_RULE: AtlasDiagonalRule = 'equidistant';
export const DEFAULT_AREA_CELL_RULE: AtlasCellRule = 'half';
/** A cone was always drawn with a round end. */
export const DEFAULT_CONE_END: AtlasConeEnd = 'round';
/** Cone of a collection that never set one: a quarter circle. */
export const DEFAULT_CONE_ANGLE = 90;
/** A line that names no width is one cell wide. */
export const DEFAULT_LINE_WIDTH_CELLS = 1;
/** The widest a line is made with the tool or its popover, in cells. */
export const MAX_LINE_WIDTH_CELLS = 20;
/** The points a ruler may run through: its start, corners and end. */
export const MAX_RULER_POINTS = 64;
/** The kept measurements one level may hold. */
export const MAX_MEASURES = 256;
export const MAX_RANGE_RINGS = 8;
/** The most cells a range may hold for its cells to be counted; a longer one is a circle. */
export const MAX_RANGE_CELLS = 16_384;
export const MAX_ORIGIN_TOKENS = 64;
export const MAX_MEASURE_AUTHOR = 128;
/** The farthest an aura reaches from its token's space, in game units. */
export const MAX_AURA = 100_000;
export const MAX_UNIT_NAME = 12;
/** Below a millionth JavaScript writes a power of ten, which no field reads back. */
export const MIN_UNIT_DISTANCE = 0.000001;
export const MAX_UNIT_DISTANCE = 1_000_000;

export const MAX_MOVEMENT_STEPS = 4;
/** The longest name a movement step keeps; a longer one is cut there. */
export const MAX_STEP_NAME = 24;
export const MAX_STEP_MULTIPLE = 100;
/** The fastest a creature without a speed of its own is taken to move, in game units. */
export const MAX_MOVEMENT_SPEED = 100_000;

/**
 * How far outside its edge a point still lies in an area, in cells. Edges count as inside, and
 * snapped areas put their edges through cell centres: without it the rounding of a corner
 * would decide whether a row of cells is covered.
 */
export const EDGE_TOLERANCE = 1e-6;

/** How far from a whole number of cells a distance still is that number, in cells. */
const WHOLE_CELL_TOLERANCE = 1e-6;
/** How far a distance may pass a ring's reach and still lie in it, in cells. */
const REACH_TOLERANCE = 1e-6;
/**
 * How close to a step's end a move must be to lie in it, as a share of the token's speed.
 * A different space from REACH_TOLERANCE: this one compares multiples, not cells.
 */
const STEP_TOLERANCE = 1e-9;

/** '#rrggbb'. Nothing in the repo exports one, so this module keeps its own. */
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

// ---------------------------------------------------------------------------
// Reading what Atlas stored
// ---------------------------------------------------------------------------

/**
 * The diagonal rule a collection measures with. Accepts Atlas' four names and the aliases
 * this plugin wrote before ('5e', '5-10-5', '1-2-1', 'pf2e'), all of which mean alternating.
 * Anything else, and anything absent, is `equidistant`: Atlas' default, and the one a
 * collection that never chose a rule measures by.
 */
export function normalizeAtlasDiagonalRule(raw: unknown): AtlasDiagonalRule {
  if (typeof raw !== 'string') return DEFAULT_DIAGONAL_RULE;
  switch (raw.trim().toLowerCase()) {
    case 'equidistant': return 'equidistant';
    case 'alternating': return 'alternating';
    case 'manhattan': return 'manhattan';
    case 'euclidean': return 'euclidean';
    case '5e':
    case '5-10-5':
    case '1-2-1':
    case 'pf2e':
      return 'alternating';
    default:
      return DEFAULT_DIAGONAL_RULE;
  }
}

export function normalizeAtlasCellRule(raw: unknown): AtlasCellRule {
  if (typeof raw !== 'string') return DEFAULT_AREA_CELL_RULE;
  switch (raw.trim().toLowerCase()) {
    case 'half': return 'half';
    case 'centre':
    case 'center': return 'centre';
    case 'any': return 'any';
    default: return DEFAULT_AREA_CELL_RULE;
  }
}

export function normalizeAtlasConeEnd(raw: unknown): AtlasConeEnd {
  if (typeof raw !== 'string') return DEFAULT_CONE_END;
  switch (raw.trim().toLowerCase()) {
    case 'flat': return 'flat';
    case 'round':
    case 'rounded': return 'round';
    default: return DEFAULT_CONE_END;
  }
}

/**
 * The unit a map measures in. Atlas stores its own five names; the aliases are accepted
 * because earlier Atlas versions and this plugin's own reader wrote short forms.
 */
export function normalizeAtlasUnitType(raw: unknown): AtlasUnitType {
  if (typeof raw !== 'string') return 'feet';
  switch (raw.trim().toLowerCase()) {
    case 'feet':
    case 'foot':
    case 'ft': return 'feet';
    case 'yards':
    case 'yard':
    case 'yd': return 'yards';
    case 'meters':
    case 'metres':
    case 'meter':
    case 'metre':
    case 'm': return 'meters';
    case 'units':
    case 'unit':
    case 'u': return 'units';
    case 'custom': return 'custom';
    default: return 'feet';
  }
}

export function normalizeAtlasMeasurementMode(raw: unknown): AtlasMeasurementMode {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'abstract' ? 'abstract' : 'metric';
}

/** Whether `angle` can open a cone: more than 0 and at most a full turn, in degrees. */
export function isValidConeAngle(angle: unknown): angle is number {
  return typeof angle === 'number' && Number.isFinite(angle) && angle > 0 && angle <= 360;
}

/**
 * The cone angle a collection measures with: its own, else its game system preset's, else a
 * quarter circle. Collections set up before cone angles existed store none.
 */
export function resolveConeAngle(collectionConeAngle: unknown, presetConeAngle?: unknown): number {
  if (isValidConeAngle(collectionConeAngle)) return collectionConeAngle;
  if (isValidConeAngle(presetConeAngle)) return presetConeAngle;
  return DEFAULT_CONE_ANGLE;
}

/** Whether `value` is a distance a cell can span: a number a field can show and read back. */
export function isUnitDistance(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= MIN_UNIT_DISTANCE
    && value <= MAX_UNIT_DISTANCE;
}

/** A unit's name as typed: trimmed, at most `MAX_UNIT_NAME` long; text naming nothing is none. */
export function readUnitName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim().slice(0, MAX_UNIT_NAME).trim();
  return name === '' ? undefined : name;
}

/** A band threshold must be a whole number of at least one square. */
export function isValidRangeBandThreshold(maxSquares: unknown): maxSquares is number {
  return typeof maxSquares === 'number' && Number.isInteger(maxSquares) && maxSquares >= 1;
}

export function areRangeBandsValid(bands: readonly RangeBand[] | undefined): boolean {
  return (bands ?? []).every((band) => isValidRangeBandThreshold(band.maxSquares));
}

/** Whether `multiple` can be a step's: a number above 0 and no more than `MAX_STEP_MULTIPLE`. */
export function isStepMultiple(multiple: unknown): multiple is number {
  return typeof multiple === 'number' && Number.isFinite(multiple)
    && multiple > 0 && multiple <= MAX_STEP_MULTIPLE;
}

/** Whether `speed` can be a creature's: a number above 0 and no more than `MAX_MOVEMENT_SPEED`. */
export function isMovementSpeed(speed: unknown): speed is number {
  return typeof speed === 'number' && Number.isFinite(speed)
    && speed > 0 && speed <= MAX_MOVEMENT_SPEED;
}

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value);
}

// ---------------------------------------------------------------------------
// Grid distance
// ---------------------------------------------------------------------------

/** A flat path as the rules count it, in cells. */
export interface FlatCells {
  readonly straight: number;
  readonly diagonal: number;
  readonly euclidean: number;
}

/**
 * Snapped points lie whole cells apart, but their world distance divided by the cell size
 * misses the whole number by a rounding error that depends on where on the map they are, and
 * the alternating rule rounds diagonals down: two diagonals read as 1.9999999999999996 cost
 * one cell less. So a distance that close to whole cells is whole.
 */
function wholeIfClose(cells: number): number {
  const whole = Math.round(cells);
  return Math.abs(cells - whole) < WHOLE_CELL_TOLERANCE ? whole : cells;
}

function cellsBetween(from: number, to: number, cellSize: number): number {
  return wholeIfClose(Math.abs(to - from) / cellSize);
}

/**
 * The path through `points` as the rules count it, over the plan (x/z). Height is not part of
 * a flat path: it is handed to `cellsByRule` as `riseCells`.
 *
 * Hex grids are not covered. Atlas counts hex steps through its axial lattice; this plugin's
 * grid is square, and a hex port needs that lattice first.
 */
export function flatCells(points: readonly Vec3[], cellSize: number): FlatCells {
  let straight = 0;
  let diagonal = 0;
  let euclidean = 0;
  if (!(cellSize > 0) || !Number.isFinite(cellSize)) return { straight, diagonal, euclidean };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dx = cellsBetween(a[0], b[0], cellSize);
    const dz = cellsBetween(a[2], b[2], cellSize);
    straight += Math.abs(dx - dz);
    diagonal += Math.min(dx, dz);
    euclidean += Math.hypot(dx, dz);
  }
  return { straight, diagonal, euclidean };
}

/**
 * What a flat path costs by `rule`, in cells, when it also climbs `riseCells`. The height is a
 * third axis under the same rule, counted once over the whole path, so a path with corners
 * costs what one straight move does:
 *
 * - `equidistant`: a step that also climbs costs no more than one that does not.
 * - `alternating`: a step along two or three axes is a diagonal, and every second diagonal
 *   costs double. The climb is taken on steps that are diagonal already, then on straight
 *   ones (which become diagonals), then alone.
 * - `manhattan`: every axis is paid for.
 * - `euclidean`: the straight line through the air.
 */
export function cellsByRule(flat: FlatCells, rule: AtlasDiagonalRule, riseCells = 0): number {
  const { straight, diagonal, euclidean } = flat;
  const climb = Number.isFinite(riseCells) ? wholeIfClose(Math.abs(riseCells)) : 0;
  const steps = straight + diagonal;
  switch (rule) {
    case 'euclidean':
      return climb === 0 ? euclidean : Math.hypot(euclidean, climb);
    case 'alternating': {
      const diagonals = climb <= steps ? Math.max(diagonal, climb) : steps;
      return Math.max(steps, climb) + Math.floor(diagonals / 2);
    }
    case 'manhattan':
      return straight + 2 * diagonal + climb;
    default:
      // equidistant, and anything the normaliser could not name.
      return Math.max(steps, climb);
  }
}

/** Length in cells of the path through `points`; `riseCells` is the height between its ends. */
export function pathLengthInCells(
  points: readonly Vec3[],
  cellSize: number,
  rule: AtlasDiagonalRule,
  riseCells = 0,
): number {
  return cellsByRule(flatCells(points, cellSize), rule, riseCells);
}

// ---------------------------------------------------------------------------
// Measurement settings, as Atlas resolves them
// ---------------------------------------------------------------------------

export interface RangeBand {
  readonly name: string;
  readonly maxSquares: number;
}

/** What a map measures in, with the defaults where its settings name none. */
export interface AtlasMeasurementSettings {
  readonly mode: AtlasMeasurementMode;
  readonly unitType: AtlasUnitType;
  /** Game units one cell of this map spans: the scene's own distance per cell where it sets one. */
  readonly unitDistance: number;
  /**
   * Game units one rules square spans: the collection's distance per cell, whatever the scene
   * sets. Distances written in squares (presets, statblocks) are converted with this one.
   */
  readonly ruleDistance: number;
  /** The unit's name as the GM typed it, shown in place of the unit type's own. */
  readonly unitName?: string;
  readonly diagonalRule: AtlasDiagonalRule;
  /**
   * What a cell of difficult terrain costs a token's movement. Atlas' own rule name; only
   * 'none' is resolved here. Its cost is applied where movement is counted, never to a
   * plain distance.
   */
  readonly difficultTerrain: string;
  readonly rangeBands: readonly RangeBand[];
  /** Full opening of the cone measurement, degrees. */
  readonly coneAngle: number;
  readonly areaCellRule: AtlasCellRule;
  readonly coneEnd: AtlasConeEnd;
}

/** The part of a collection's grid defaults a map measures by. */
export interface CollectionGridDefaultsSource {
  measurementMode?: unknown;
  unitType?: unknown;
  unitName?: unknown;
  unitDistance?: unknown;
  diagonalRule?: unknown;
  difficultTerrain?: unknown;
  abstractRangeBands?: unknown;
  coneAngle?: unknown;
  areaCellRule?: unknown;
  coneEnd?: unknown;
}

/** The part of a scene's own grid state that names units, and may override them. */
export interface SceneGridUnitsSource {
  measurementType?: unknown;
  unitType?: unknown;
  unitDistance?: unknown;
  unitDistanceOverride?: unknown;
  unitNameOverride?: unknown;
}

/**
 * Bands as a collection stores them. Atlas keeps the array as it came and validates it
 * separately; here a band with no name or no whole threshold is dropped at read, which is
 * what that validation would have rejected. A band without a threshold would otherwise
 * swallow every distance.
 */
export function readRangeBands(raw: unknown): RangeBand[] {
  if (!Array.isArray(raw)) return [];
  const out: RangeBand[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const band = item as Record<string, unknown>;
    if (typeof band.name !== 'string') continue;
    const name = band.name.trim();
    if (name === '' || !isValidRangeBandThreshold(band.maxSquares)) continue;
    out.push({ name, maxSquares: band.maxSquares });
  }
  return out;
}

/** The distance a scene's cells span by its own choice; a value that is no positive number is none. */
export function sceneUnitDistance(grid: SceneGridUnitsSource | null | undefined): number | undefined {
  const distance = grid?.unitDistanceOverride;
  return typeof distance === 'number' && Number.isFinite(distance) && distance > 0 ? distance : undefined;
}

/** The unit a scene names for its own distances, a galaxy map's "ly"; none where it names none. */
export function sceneUnitName(grid: SceneGridUnitsSource | null | undefined): string | undefined {
  return readUnitName(grid?.unitNameOverride);
}

/** The name a collection's unit shows: the one typed for a `custom` unit; none for the rest. */
export function collectionUnitName(
  collection: Pick<CollectionGridDefaultsSource, 'unitType' | 'unitName'> | null | undefined,
): string | undefined {
  return normalizeAtlasUnitType(collection?.unitType) === 'custom'
    ? readUnitName(collection?.unitName)
    : undefined;
}

type RuleUnits = Omit<AtlasMeasurementSettings, 'unitDistance'>;

function collectionUnits(collection: CollectionGridDefaultsSource): RuleUnits {
  const unitName = collectionUnitName(collection);
  const ruleDistance = isUnitDistance(collection.unitDistance) ? collection.unitDistance : 5;
  return {
    mode: normalizeAtlasMeasurementMode(collection.measurementMode),
    unitType: normalizeAtlasUnitType(collection.unitType),
    ...(unitName !== undefined && { unitName }),
    ruleDistance,
    diagonalRule: normalizeAtlasDiagonalRule(collection.diagonalRule),
    difficultTerrain: typeof collection.difficultTerrain === 'string' ? collection.difficultTerrain : 'none',
    rangeBands: readRangeBands(collection.abstractRangeBands),
    coneAngle: resolveConeAngle(collection.coneAngle),
    areaCellRule: normalizeAtlasCellRule(collection.areaCellRule),
    coneEnd: normalizeAtlasConeEnd(collection.coneEnd),
  };
}

/**
 * A map outside a collection. Older maps may store 'daggerheart' or nothing; both measure in
 * range bands, so only an explicit 'units' makes a map measure distances.
 */
function gridUnits(grid: SceneGridUnitsSource | null | undefined): RuleUnits {
  return {
    mode: grid?.measurementType === 'units' ? 'metric' : 'abstract',
    unitType: normalizeAtlasUnitType(grid?.unitType),
    ruleDistance: isUnitDistance(grid?.unitDistance) ? grid.unitDistance : 5,
    diagonalRule: DEFAULT_DIAGONAL_RULE,
    difficultTerrain: 'none',
    rangeBands: [],
    coneAngle: DEFAULT_CONE_ANGLE,
    areaCellRule: DEFAULT_AREA_CELL_RULE,
    coneEnd: DEFAULT_CONE_END,
  };
}

/**
 * What a map measures in. Collection grid defaults win; a map without a collection falls back
 * to its grid state. A scene's own distance per cell changes only `unitDistance`, and its own
 * unit name only `unitName`, and only where distances are measured: range bands have no
 * distance per cell, so there both are kept but unused.
 */
export function resolveMeasurementSettings(
  collection: CollectionGridDefaultsSource | null | undefined,
  grid: SceneGridUnitsSource | null | undefined,
): AtlasMeasurementSettings {
  const { unitName: ruleName, ...rules } = collection ? collectionUnits(collection) : gridUnits(grid);
  const metric = rules.mode !== 'abstract';
  const override = metric ? sceneUnitDistance(grid) : undefined;
  const unitName = (metric ? sceneUnitName(grid) : undefined) ?? ruleName;
  return {
    ...rules,
    unitDistance: override ?? rules.ruleDistance,
    ...(unitName !== undefined && { unitName }),
  };
}

// ---------------------------------------------------------------------------
// Area rules
// ---------------------------------------------------------------------------

/** The rules that shape a map's measured areas, with the defaults where the settings name none. */
export function areaRulesOf(
  settings: Pick<AtlasMeasurementSettings, 'areaCellRule' | 'coneEnd'> | null | undefined,
): { cellRule: AtlasCellRule; coneEnd: AtlasConeEnd } {
  return {
    cellRule: settings?.areaCellRule ?? DEFAULT_AREA_CELL_RULE,
    coneEnd: settings?.coneEnd ?? DEFAULT_CONE_END,
  };
}

/** What shapes an area besides its two points, as the geometry phase reads it. */
export interface AtlasAreaShapeRules {
  /** The full opening of a cone, degrees. */
  readonly coneAngle: number;
  readonly coneEnd: AtlasConeEnd;
  readonly cellRule: AtlasCellRule;
  /** The width of a line that names none, in cells. */
  readonly lineWidthCells: number;
}

export function areaShapeRules(
  settings: AtlasMeasurementSettings,
  lineWidthCells: number = DEFAULT_LINE_WIDTH_CELLS,
): AtlasAreaShapeRules {
  const { cellRule, coneEnd } = areaRulesOf(settings);
  const width = Number.isFinite(lineWidthCells) && lineWidthCells > 0
    ? Math.min(MAX_LINE_WIDTH_CELLS, lineWidthCells)
    : DEFAULT_LINE_WIDTH_CELLS;
  return { coneAngle: settings.coneAngle, coneEnd, cellRule, lineWidthCells: width };
}

// ---------------------------------------------------------------------------
// Snapping, over the plan
// ---------------------------------------------------------------------------

/** The grid points snap to; null where the map has none or its Snap is off. */
export interface SnapGrid {
  readonly cellSize: number;
  readonly originX: number;
  readonly originZ: number;
}

function snaps(grid: SnapGrid | null, free: boolean): grid is SnapGrid {
  return !!grid && !free && grid.cellSize > 0 && Number.isFinite(grid.cellSize);
}

/** A ruler's point: the centre of the cell it lies in. Height is left where it was. */
export function snapRulerPoint(grid: SnapGrid | null, point: Vec3, free = false): Vec3 {
  if (!snaps(grid, free)) return [point[0], point[1], point[2]];
  const s = grid.cellSize;
  return [
    grid.originX + Math.floor((point[0] - grid.originX) / s) * s + s / 2,
    point[1],
    grid.originZ + Math.floor((point[2] - grid.originZ) / s) * s + s / 2,
  ];
}

/**
 * An area's origin: the nearest of a cell's centre, its corners and the middles of its edges —
 * the places rulebooks measure areas from. Together those are every point half a cell apart.
 */
export function snapAreaOrigin(grid: SnapGrid | null, point: Vec3, free = false): Vec3 {
  if (!snaps(grid, free)) return [point[0], point[1], point[2]];
  const half = grid.cellSize / 2;
  return [
    grid.originX + Math.round((point[0] - grid.originX) / half) * half,
    point[1],
    grid.originZ + Math.round((point[2] - grid.originZ) / half) * half,
  ];
}

/**
 * An area's end: where the pointer points, at a whole number of cells from the origin and at
 * least one. The size snaps, not the pointer to a cell, so an area of four cells is four cells
 * long in every direction. A pointer on the origin gives no direction and stays there.
 *
 * The length is taken over the plan, as Atlas takes it: height does not shrink an area's reach.
 * `spanHeight` snaps the 3D distance instead, which is what a sphere sized by its radius wants.
 */
export function snapAreaEnd(
  grid: SnapGrid | null,
  origin: Vec3,
  pointer: Vec3,
  free = false,
  spanHeight = false,
): Vec3 {
  const x = pointer[0] - origin[0];
  const y = pointer[1] - origin[1];
  const z = pointer[2] - origin[2];
  const length = spanHeight ? Math.hypot(x, y, z) : Math.hypot(x, z);
  if (!snaps(grid, free) || !(length > 0)) return [pointer[0], pointer[1], pointer[2]];
  const scale = (Math.max(1, Math.round(length / grid.cellSize)) * grid.cellSize) / length;
  return [origin[0] + x * scale, origin[1] + y * scale, origin[2] + z * scale];
}

// ---------------------------------------------------------------------------
// Units and labels
// ---------------------------------------------------------------------------

const UNIT_SUFFIX: Record<AtlasUnitType, string> = {
  feet: 'ft', yards: 'yd', meters: 'm', units: 'u', custom: '',
};

const tenths = (value: number): number => Math.round(value * 10) / 10;

/**
 * Unit shown next to a distance input; none for generic units. Maps without a unit use feet.
 * Note this is not what a label appends: a label writes 'u' for generic units, an input hints none.
 */
export function unitLabelFor(unitType: AtlasUnitType | undefined, unitName?: string): string {
  if (unitName) return unitName;
  if (unitType === 'units' || unitType === 'custom') return '';
  return UNIT_SUFFIX[unitType ?? 'feet'];
}

/** What follows a distance's number: the short form right after it, a typed name after a space. */
function unitSuffix(settings: Pick<AtlasMeasurementSettings, 'unitType' | 'unitName'>): string {
  return settings.unitName ? ` ${settings.unitName}` : UNIT_SUFFIX[settings.unitType];
}

/** A distance's number as labels write it: one decimal where the distance has one. */
export function distanceNumber(units: number): string {
  return `${tenths(units)}`;
}

/** Label for a distance already in game units, e.g. "30ft" or "30 mi". */
export function formatGameUnits(
  units: number,
  settings: Pick<AtlasMeasurementSettings, 'unitType' | 'unitName'>,
): string {
  return `${distanceNumber(units)}${unitSuffix(settings)}`;
}

/** The first band whose threshold covers the distance; the last band beyond all of them. */
export function rangeBandName(cells: number, bands: readonly RangeBand[]): string {
  const squares = Math.round(cells);
  if (bands.length === 0) return `${squares} sq`;
  return (bands.find((band) => squares <= band.maxSquares) ?? bands[bands.length - 1]!).name;
}

/** Label for a distance of `cells` grid cells: "30ft", or a range band name. */
export function formatDistance(cells: number, settings: AtlasMeasurementSettings): string {
  if (settings.mode === 'abstract') return rangeBandName(cells, settings.rangeBands);
  return formatGameUnits(cells * settings.unitDistance, settings);
}

/** Label for a distance already in game units on a map that may name distances. */
export function formatGameDistance(units: number, settings: AtlasMeasurementSettings): string {
  if (settings.mode === 'abstract') {
    return rangeBandName(units / settings.unitDistance, settings.rangeBands);
  }
  return formatGameUnits(units, settings);
}

/** Label for a reach that is set rather than measured (a sense's range, an aura). */
export function formatReach(cells: number, settings: AtlasMeasurementSettings): string {
  if (settings.mode === 'abstract') {
    return settings.rangeBands.length > 0
      ? rangeBandName(cells, settings.rangeBands)
      : `${tenths(cells)} sq`;
  }
  return formatGameUnits(cells * settings.unitDistance, settings);
}

// ---------------------------------------------------------------------------
// Movement rules
// ---------------------------------------------------------------------------

/**
 * One step of movement: every distance up to `multiple` times the token's speed, past the step
 * before. The colour is required and '#rrggbb'; a ring with no colour of its own is a band's,
 * not a step's.
 *
 * A multiple need not be whole: a third is a step like any other, so `speed * multiple` can be
 * fractional (a speed of 120 and a step of a third reach 40).
 */
export interface MovementStep {
  readonly name: string;
  readonly multiple: number;
  readonly color: string;
}

export interface MovementRules {
  /** The steps in rising order, at most `MAX_MOVEMENT_STEPS`; none switches the rules off. */
  readonly steps: readonly MovementStep[];
  /** Whether what a token moves adds up over a turn while a fight runs. */
  readonly countPerTurn: boolean;
  /**
   * How far a creature that states no speed moves, in game units. Unset: such a creature moves
   * without steps.
   */
  readonly speed?: number;
}

/** Movement of a system without steps: a move looks as it always did. */
export const NO_MOVEMENT_RULES: Readonly<MovementRules> = Object.freeze({
  steps: Object.freeze([]) as readonly MovementStep[],
  countPerTurn: false,
});

/**
 * Stored movement rules, or undefined where `raw` holds none. A step that cannot be used — no
 * name, no multiple above the step before, no colour — is dropped, as are steps past the fourth.
 * Rules without steps are rules too: a collection that removed its system's steps moves
 * without any.
 *
 * `multiple` is the field Atlas writes; `multiplier` is accepted because this plugin's earlier
 * reader looked for that name.
 */
export function readMovementRules(raw: unknown): MovementRules | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const { steps, countPerTurn, speed } = raw as Record<string, unknown>;
  const kept: MovementStep[] = [];
  for (const entry of Array.isArray(steps) ? (steps as unknown[]) : []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const step = entry as Record<string, unknown>;
    if (typeof step.name !== 'string') continue;
    const multiple = isStepMultiple(step.multiple) ? step.multiple : step.multiplier;
    if (!isStepMultiple(multiple) || !isHexColor(step.color)) continue;
    const name = step.name.trim().slice(0, MAX_STEP_NAME).trim();
    if (name === '') continue;
    if (kept.length >= MAX_MOVEMENT_STEPS) continue;
    if (!(multiple > (kept[kept.length - 1]?.multiple ?? 0))) continue;
    kept.push({ name, multiple, color: step.color });
  }
  return {
    steps: kept,
    countPerTurn: countPerTurn === true,
    ...(isMovementSpeed(speed) && { speed }),
  };
}

/** Whether the rules say anything: they name a step or a speed, or count movement per turn. */
export function hasMovementRules(rules: MovementRules | undefined): rules is MovementRules {
  return rules !== undefined
    && (rules.steps.length > 0 || rules.countPerTurn || rules.speed !== undefined);
}

/**
 * The speed a token moves at: its own where it states one, else the collection's for creatures
 * that state none. Null where neither says, and such a token moves without steps.
 */
export function movementSpeedFor(tokenSpeed: unknown, rules: MovementRules | undefined): number | null {
  if (isMovementSpeed(tokenSpeed)) return tokenSpeed;
  if (isMovementSpeed(rules?.speed)) return rules.speed;
  return null;
}

/**
 * The step a move of `distance` lies in for a token of `speed` (both in the same unit): the
 * first step that reaches as far, `'beyond'` past the last one. Null where no step can be told:
 * rules without steps, a token without a speed, or a distance that is no number.
 *
 * The tolerance is a share of the speed, not a distance: 30 worked out as 30.000000001 is 30.
 */
export function movementStepFor(
  distance: number,
  speed: number | null | undefined,
  rules: MovementRules | undefined,
): MovementStep | 'beyond' | null {
  if (!rules || rules.steps.length === 0) return null;
  if (typeof speed !== 'number' || !(speed > 0) || !Number.isFinite(speed)) return null;
  if (!Number.isFinite(distance)) return null;
  const moved = Math.max(0, distance) / speed;
  return rules.steps.find((step) => moved <= step.multiple + STEP_TOLERANCE) ?? 'beyond';
}

/**
 * How far the step a move lies in lets a token of `speed` go, in the speed's unit: the step's
 * multiple of the speed, and the last step's for a move beyond them all. Null where
 * `movementStepFor` tells no step.
 */
export function stepReach(
  step: MovementStep | 'beyond' | null,
  speed: number,
  rules: MovementRules,
): number | null {
  const reached = step === 'beyond' ? rules.steps[rules.steps.length - 1] : step;
  return reached ? speed * reached.multiple : null;
}

// ---------------------------------------------------------------------------
// Ranges mode
// ---------------------------------------------------------------------------

/** One ring: everything within its reach of what it is drawn around. */
export interface RangeRing {
  readonly name: string;
  /** A band's name, or a step's name with how far it reaches ("Dash · 60ft"). */
  readonly label: string;
  /** The farthest a distance in cells may be and still lie in the ring. */
  readonly reach: number;
  /** A step's colour, '#rrggbb'; null for a band, which takes the theme's accent. */
  readonly color: string | null;
}

/**
 * A ring per band that ends somewhere. A distance is named by the first band whose threshold
 * its rounded cells do not pass, so a band reaches half a cell past its threshold; the last
 * band names every longer distance and has no ring, and neither has a band an earlier one
 * already covers.
 */
export function bandRings(bands: readonly RangeBand[]): RangeRing[] {
  const rings: RangeRing[] = [];
  let covered = 0;
  for (const band of bands.slice(0, -1)) {
    if (rings.length >= MAX_RANGE_RINGS) break;
    if (!isValidRangeBandThreshold(band.maxSquares) || band.maxSquares <= covered) continue;
    covered = band.maxSquares;
    rings.push({
      name: band.name,
      label: band.name,
      reach: band.maxSquares + 0.5 - REACH_TOLERANCE,
      color: null,
    });
  }
  return rings;
}

/** A ring per movement step of a token that moves `speed` game units, in its colour. */
export function stepRings(
  speed: number,
  steps: readonly MovementStep[],
  settings: AtlasMeasurementSettings,
): RangeRing[] {
  if (!(speed > 0) || !Number.isFinite(speed) || !(settings.unitDistance > 0)) return [];
  return steps.slice(0, MAX_RANGE_RINGS).map((step) => {
    const distance = speed * step.multiple;
    return {
      name: step.name,
      label: `${step.name} · ${formatGameUnits(distance, settings)}`,
      reach: distance / settings.unitDistance + REACH_TOLERANCE,
      color: step.color,
    };
  });
}

/**
 * The rings around a place: its bands, or the steps of a token of `speed`. Null speed is a point
 * rather than a token, and a point on a map that measures distances has no rings.
 */
export function rangeRings(
  settings: AtlasMeasurementSettings,
  steps: readonly MovementStep[],
  speed: number | null,
): RangeRing[] {
  if (settings.mode === 'abstract') return bandRings(settings.rangeBands);
  return speed === null ? [] : stepRings(speed, steps, settings);
}

/** Whether a map has rings to show at all. */
export function rangesOffered(
  settings: AtlasMeasurementSettings,
  steps: readonly MovementStep[],
): boolean {
  if (settings.mode === 'abstract') return bandRings(settings.rangeBands).length > 0;
  return steps.length > 0 && settings.unitDistance > 0;
}