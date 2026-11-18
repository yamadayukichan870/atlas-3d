/**
 * The one engine that turns Atlas VTT's measurements into 3D regions.
 *
 * Atlas is the source of truth. A kept measurement (`objects.measures`) — a ruler, an area, a
 * range, or a token aura — is read here and turned into a set of terrain cells plus the stepped
 * outline of exactly that set. The 3D view draws what this returns; it never invents geometry.
 *
 * The rule that fixes the fill/outline mismatch: the outline is DERIVED FROM THE FILLED CELLS
 * (`outlineOfCells`), never from the analytic polygon. A cell straddling the shape's edge is
 * painted whole, and the border runs around that whole cell — so fill and border are the same
 * figure by construction and cannot disagree. This is how Atlas draws an aura and how Foundry's
 * grid templates read: the region is a set of squares, its edge a staircase.
 *
 * Two doors in, one shape out:
 *   - `regionFromKept`  : a measurement Atlas already holds (the 2D tools made it).
 *   - `regionFromActive`: the measurement the 3D tool is drawing right now.
 * Both produce the same `MeasureRegion`, so a pinned measurement and the live preview render
 * identically, and keeping a measurement is just handing its points to Atlas.
 *
 * World convention: x/z are the plan, y is up, one grid cell spans one world unit. Atlas stores
 * points in world pixels (y down); they are divided by the grid size to reach world units here.
 * Areas are plan figures projected onto every exposed terrain surface under the slice, so one
 * area can cover a floor and a balcony above it.
 *
 * Pure: no three.js, no DOM. Tested in Node.
 */
import type { BlockMap } from './blocks';
import type { Layout } from './layout';
import {
  cellsInArea,
  cellsWithinReach,
  outlineOfCells,
  shapedArea,
  stoodCells,
  tokensInArea,
  type AreaCell,
  type AreaTokenTarget,
  type PlanCell,
  type PlanPoint,
  type PlanRing,
} from './measureGeometry';
import {
  ATLAS_MEASURE_SHAPES,
  DEFAULT_LINE_WIDTH_CELLS,
  areaShapeRules,
  formatDistance,
  formatGameUnits,
  formatReach,
  pathLengthInCells,
  rangeRings,
  type AtlasMeasureMode,
  type AtlasMeasureShape,
  type AtlasMeasurementSettings,
  type MovementRules,
} from '../atlas/measureRules';
import type { AtlasMeasure } from '../atlas/types';

/** A point in world units, x/z the plan and y up. */
export type WorldPoint = [number, number, number];

/** One labelled boundary of a range: a movement step or a distance band. */
export interface RegionRing {
  readonly label: string;
  readonly color: string | null;
  readonly outline: readonly PlanRing[];
  readonly labelAt: WorldPoint;
}

/**
 * A measurement as the 3D view draws it: a set of cells, the stepped outline of exactly that
 * set, and the labels and tokens that go with it. Fill and outline come from the same cells.
 */
export interface MeasureRegion {
  readonly id: string;
  readonly mode: AtlasMeasureMode;
  /** The cells to fill, on every surface they cover under the slice. */
  readonly cells: readonly AreaCell[];
  /** The stepped outline of `cells` — the border, derived from the fill. */
  readonly outline: readonly PlanRing[];
  /** A ruler's path in world units; areas and ranges have none. */
  readonly path: readonly WorldPoint[] | null;
  readonly label: string;
  readonly subLabel?: string;
  /** Per-leg labels of a multi-corner ruler. */
  readonly legs: readonly { readonly label: string; readonly at: WorldPoint }[];
  /** Concentric boundaries of a range, inner to outer. */
  readonly rings: readonly RegionRing[];
  readonly tokenIds: readonly string[];
  /** '#rrggbb', or null for the theme's accent. */
  readonly color: string | null;
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly follows?: string;
  readonly aura?: number;
}

/** The scene a measurement is read against: its grid, rules, terrain, tokens and slice. */
export interface RegionContext {
  readonly map: BlockMap;
  readonly layout: Layout;
  /** Atlas's grid size in world pixels; converts Atlas points to world units. */
  readonly gridSize: number;
  readonly maxLayer: number;
  readonly rules: AtlasMeasurementSettings;
  readonly movement: MovementRules;
  readonly tokens: readonly AreaTokenTarget[];
  readonly selectedIds: readonly string[];
  /** The speed of the token a range is drawn around, in game units; null for a bare point. */
  readonly speed: number | null;
}

const planOf = (p: WorldPoint): PlanPoint => ({ x: p[0], z: p[2] });

function surfaceY(ctx: RegionContext, x: number, z: number): number {
  const ceiling = Number.isFinite(ctx.maxLayer) ? ctx.maxLayer * ctx.map.layerHeight : Infinity;
  return ctx.map.surfaceHeightAt(x - ctx.layout.originX, z - ctx.layout.originZ, ceiling);
}

/** Lift a set of plan cells onto the terrain surface each one stands on. */
function cellsToSurface(cells: readonly PlanCell[], ctx: RegionContext): AreaCell[] {
  return cells.map((c) => {
    const x0 = ctx.layout.originX + c.cx;
    const z0 = ctx.layout.originZ + c.cz;
    return {
      cx: c.cx,
      cz: c.cz,
      y: surfaceY(ctx, x0 + 0.5, z0 + 0.5),
      x0,
      x1: x0 + 1,
      z0,
      z1: z0 + 1,
    };
  });
}

/** The farthest corner of an outline from a centre, where a range's label sits. */
function farthestPoint(rings: readonly PlanRing[], from: PlanPoint): PlanPoint | null {
  let best: PlanPoint | null = null;
  let bestDist = -1;
  for (const ring of rings) {
    for (const p of ring) {
      const dist = Math.hypot(p.x - from.x, p.z - from.z);
      if (dist > bestDist) {
        bestDist = dist;
        best = p;
      }
    }
  }
  return best;
}

function emptyRegion(id: string, mode: AtlasMeasureMode, pinned: boolean, color: string | null): MeasureRegion {
  return {
    id, mode, cells: [], outline: [], path: null, label: '', legs: [], rings: [],
    tokenIds: [], color, pinned, hidden: false,
  };
}

// ---------------------------------------------------------------------------
// The shape of a measurement: cells + outline + label, from its points
// ---------------------------------------------------------------------------

interface ShapedResult {
  readonly cells: AreaCell[];
  readonly outline: PlanRing[];
  readonly label: string;
  readonly subLabel?: string;
  readonly tokenIds: string[];
  readonly radiusCells: number;
}

function shapeRegion(
  mode: AtlasMeasureShape,
  worldPoints: readonly WorldPoint[],
  widthCells: number,
  ctx: RegionContext,
): ShapedResult | null {
  if (worldPoints.length < 2) return null;
  const origin = planOf(worldPoints[0]!);
  const end = planOf(worldPoints[worldPoints.length - 1]!);
  const area = shapedArea(mode, origin, end, areaShapeRules(ctx.rules, widthCells), widthCells);
  if (!area) return null;
  const cells = cellsInArea(area, {
    map: ctx.map,
    layout: ctx.layout,
    maxLayer: ctx.maxLayer,
    cellRule: ctx.rules.areaCellRule,
  });
  const outline = outlineOfCells(cells, ctx.layout);
  const tokenIds = tokensInArea(area, ctx.tokens);
  const length = Math.hypot(end.x - origin.x, end.z - origin.z);
  const rise = worldPoints[worldPoints.length - 1]![1] - worldPoints[0]![1];
  const subLabel = Math.abs(rise) >= 0.08
    ? `ΔH ${rise >= 0 ? '+' : ''}${formatGameUnits(rise * ctx.rules.unitDistance, ctx.rules)}`
    : undefined;

  let label: string;
  if (mode === 'square') {
    const side = formatDistance(length, ctx.rules);
    label = `${side} × ${side}`;
  } else if (mode === 'line') {
    label = `${formatDistance(length, ctx.rules)} × ${formatDistance(widthCells, ctx.rules)}`;
  } else {
    label = formatDistance(length, ctx.rules);
  }
  return { cells, outline, label, ...(subLabel !== undefined && { subLabel }), tokenIds, radiusCells: area.reach };
}

function rulerRegion(
  worldPoints: readonly WorldPoint[],
  ctx: RegionContext,
): { label: string; subLabel?: string; legs: { label: string; at: WorldPoint }[]; radiusCells: number } {
  const origin = worldPoints[0]!;
  const tip = worldPoints[worldPoints.length - 1]!;
  const rise = tip[1] - origin[1];
  const cells = pathLengthInCells(worldPoints, 1, ctx.rules.diagonalRule, rise);
  const legs: { label: string; at: WorldPoint }[] = [];
  if (worldPoints.length > 2) {
    for (let i = 1; i < worldPoints.length; i++) {
      const a = worldPoints[i - 1]!;
      const b = worldPoints[i]!;
      const legCells = pathLengthInCells([a, b], 1, ctx.rules.diagonalRule, b[1] - a[1]);
      legs.push({
        label: formatDistance(legCells, ctx.rules),
        at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
      });
    }
  }
  const parts: string[] = [];
  if (Math.abs(rise) >= 0.08) {
    parts.push(`ΔH ${rise >= 0 ? '+' : ''}${formatGameUnits(rise * ctx.rules.unitDistance, ctx.rules)}`);
  }
  if (worldPoints.length > 2) parts.push(`${worldPoints.length - 1} legs`);
  return {
    label: formatDistance(cells, ctx.rules),
    ...(parts.length > 0 && { subLabel: parts.join(' · ') }),
    legs,
    radiusCells: cells,
  };
}

// ---------------------------------------------------------------------------
// Door 1: a measurement Atlas already holds
// ---------------------------------------------------------------------------

/**
 * A kept measurement of Atlas, as a 3D region. An aura's geometry comes from its reach and the
 * token's own space — never from its stored points, which are a stale snapshot by design.
 */
export function regionFromKept(measure: AtlasMeasure, ctx: RegionContext): MeasureRegion | null {
  if (!(ctx.gridSize > 0)) return null;
  const color = measure.color ?? null;
  const hidden = measure.hidden === true;
  const widthCells = typeof measure.width === 'number' && measure.width > 0
    ? measure.width / ctx.gridSize
    : DEFAULT_LINE_WIDTH_CELLS;

  // An aura: a circle that follows a token, grown from the cells it stands on.
  if (typeof measure.follows === 'string' && typeof measure.aura === 'number' && measure.aura > 0) {
    const anchor = ctx.tokens.find((t) => t.id === measure.follows);
    if (!anchor) return null;
    const reach = measure.aura / (ctx.rules.unitDistance > 0 ? ctx.rules.unitDistance : 1);
    const stood = stoodCells(anchor.x, anchor.z, anchor.diameter, ctx.layout);
    const cells = cellsWithinReach(stood, reach, ctx.rules.diagonalRule, ctx.layout);
    const surface = cells ? cellsToSurface(cells, ctx) : [];
    return {
      id: measure.id,
      mode: 'circle',
      cells: surface,
      outline: outlineOfCells(surface, ctx.layout),
      path: null,
      label: formatReach(reach, ctx.rules),
      legs: [],
      rings: [],
      tokenIds: [],
      color,
      pinned: true,
      hidden,
      follows: measure.follows,
      aura: measure.aura,
    };
  }

  const mode = measure.shape as AtlasMeasureMode;
  if (!ATLAS_MEASURE_SHAPES.includes(mode as AtlasMeasureShape)) return null;
  if (!Array.isArray(measure.points) || measure.points.length < 2) return null;

  const worldPoints: WorldPoint[] = measure.points.map((p) => {
    const x = p.x / ctx.gridSize;
    const z = p.y / ctx.gridSize;
    return [x, surfaceY(ctx, x, z), z];
  });

  if (mode === 'ruler') {
    const ruler = rulerRegion(worldPoints, ctx);
    return {
      id: measure.id,
      mode: 'ruler',
      cells: [],
      outline: [],
      path: worldPoints,
      label: ruler.label,
      ...(ruler.subLabel !== undefined && { subLabel: ruler.subLabel }),
      legs: ruler.legs,
      rings: [],
      tokenIds: [],
      color,
      pinned: true,
      hidden,
    };
  }

  const shaped = shapeRegion(mode as AtlasMeasureShape, worldPoints, widthCells, ctx);
  if (!shaped) return null;
  return {
    id: measure.id,
    mode,
    cells: shaped.cells,
    outline: shaped.outline,
    path: null,
    label: shaped.label,
    ...(shaped.subLabel !== undefined && { subLabel: shaped.subLabel }),
    legs: [],
    rings: [],
    tokenIds: shaped.tokenIds,
    color,
    pinned: true,
    hidden,
  };
}

// ---------------------------------------------------------------------------
// Door 2: the measurement the 3D tool is drawing right now
// ---------------------------------------------------------------------------

/**
 * The live measurement, as a 3D region. Same shape as a kept one, so the preview and the pinned
 * result render identically. `points` are in world units with the height the picker gave them.
 */
export function regionFromActive(
  id: string,
  mode: AtlasMeasureMode,
  points: readonly WorldPoint[],
  widthCells: number,
  color: string | null,
  ctx: RegionContext,
  anchorId?: string | null,
): MeasureRegion | null {
  if (mode === 'ruler') {
    if (points.length < 2) return null;
    const ruler = rulerRegion(points, ctx);
    return {
      id, mode: 'ruler', cells: [], outline: [], path: points,
      label: ruler.label,
      ...(ruler.subLabel !== undefined && { subLabel: ruler.subLabel }),
      legs: ruler.legs, rings: [], tokenIds: [], color, pinned: false, hidden: false,
    };
  }

  if (mode === 'ranges') {
    const anchor = ctx.tokens.find((t) => t.id === (anchorId ?? ctx.selectedIds[0]));
    const centre: PlanPoint = anchor ? { x: anchor.x, z: anchor.z } : planOf(points[0] ?? [0, 0, 0]);
    const stood = stoodCells(centre.x, centre.z, anchor?.diameter ?? 1, ctx.layout);
    const rings = rangeRings(ctx.rules, ctx.movement.steps, ctx.speed);
    const regionRings: RegionRing[] = [];
    let outerCells: AreaCell[] = [];
    let outerOutline: PlanRing[] = [];
    for (const ring of rings) {
      const cells = cellsWithinReach(stood, ring.reach, ctx.rules.diagonalRule, ctx.layout);
      if (!cells) continue;
      const outline = outlineOfCells(cells, ctx.layout);
      const far = farthestPoint(outline, centre);
      const labelAt: WorldPoint = far
        ? [far.x, surfaceY(ctx, far.x, far.z), far.z]
        : [centre.x, surfaceY(ctx, centre.x, centre.z), centre.z];
      regionRings.push({ label: ring.label, color: ring.color, outline, labelAt });
      outerCells = cellsToSurface(cells, ctx);
      outerOutline = outline;
    }
    const outer = regionRings[regionRings.length - 1];
    return {
      id, mode: 'ranges', cells: outerCells, outline: outerOutline, path: null,
      label: outer?.label ?? formatReach(0, ctx.rules),
      legs: [], rings: regionRings, tokenIds: [], color, pinned: false, hidden: false,
      ...(anchorId != null && { follows: anchorId }),
    };
  }

  const shaped = shapeRegion(mode as AtlasMeasureShape, points, widthCells, ctx);
  if (!shaped) return null;
  return {
    id, mode, cells: shaped.cells, outline: shaped.outline, path: null,
    label: shaped.label,
    ...(shaped.subLabel !== undefined && { subLabel: shaped.subLabel }),
    legs: [], rings: [], tokenIds: shaped.tokenIds, color, pinned: false, hidden: false,
  };
}

/** Every kept measurement of the level, as regions. Auras and areas and rulers alike. */
export function regionsFromKept(measures: readonly AtlasMeasure[], ctx: RegionContext): MeasureRegion[] {
  const out: MeasureRegion[] = [];
  for (const measure of measures) {
    const region = regionFromKept(measure, ctx);
    if (region) out.push(region);
  }
  return out;
}