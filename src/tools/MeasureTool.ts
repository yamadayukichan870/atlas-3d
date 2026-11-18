import {
  ATLAS_MEASURE_SHAPES,
  DEFAULT_LINE_WIDTH_CELLS,
  MAX_RULER_POINTS,
  areaShapeRules,
  formatDistance,
  formatGameUnits,
  formatReach,
  pathLengthInCells,
  rangeRings,
  snapAreaEnd,
  snapAreaOrigin,
  snapRulerPoint,
  type AtlasMeasureMode,
  type AtlasMeasureShape,
  type AtlasMeasurementSettings,
  type SnapGrid,
} from '../atlas/measureRules';
import type { AtlasMeasure, AtlasPoint } from '../atlas/types';
import { shapedArea, tokensInArea, type AreaTokenTarget, type PlanPoint } from '../terrain/measureGeometry';
import type { Vec3 } from '../terrain/shapes';
import type { MeasureDisplay, MeasureLeg, TacticalOverlayContext } from '../view/TacticalOverlays';
import { CLICK_SLOP_PX, type ToolContext, type ToolHandler } from './ToolController';

/**
 * The measure tool: the six modes Atlas's own Measure bar offers, measuring by the rules Atlas
 * resolves for this scene.
 *
 * Rules, token footprints, selection and speed are read from the tactical context the scene
 * feeds the renderer (`Scene3D.syncMeasureContext` -> `SceneRenderer.setMeasureContext`). No
 * distance is worked out here by hand any more: `measureRules` counts cells under the map's
 * diagonal rule with the climb folded in once, and writes the label; `measureGeometry` shapes
 * the area and says which tokens it covers.
 *
 * Snapping is Atlas's, in world units where a cell spans one unit: a ruler's point to a cell
 * centre, an area's origin to the nearest half cell, an area's end in magnitude so four cells
 * dragged is four cells long whichever way it points. The renderer's own pick is taken UNSNAPPED
 * so the two snaps never compose.
 *
 * What is kept goes to Atlas through `ctx.onAddMeasure` when the scene wires it, and comes back
 * through `ctx.measures()`; until then it stays a local pin. A released measurement with Keep off
 * fades over two seconds instead of vanishing.
 *
 * `clearPinned()` drops only what this tool drew locally: the scene calls it when the level
 * changes, and clearing Atlas's own measurements there would delete the user's work.
 */

const FADE_MS = 2000;
const ACTIVE_ID = 'active';

const LEGACY_MODE: Record<string, AtlasMeasureMode> = {
  line: 'ruler',
  sphere: 'circle',
  cone: 'cone',
  cube: 'square',
};

const planOf = (p: Vec3): PlanPoint => ({ x: p[0], z: p[2] });

export class MeasureTool implements ToolHandler {
  private points: Vec3[] = [];
  private active = false;
  private dragStart: { x: number; y: number } | null = null;
  private dragged = false;
  /** What this tool kept itself, for as long as Atlas is not holding it. */
  private localPins: MeasureDisplay[] = [];
  private nextPinId = 1;
  /** The measurement released with Keep off, on its way out. */
  private fading: MeasureDisplay | null = null;
  private fadingUntil = 0;
  /** The token a ranges measurement is drawn around. */
  private anchorId: string | null = null;
  /** The token the press landed on, so the pick is not made twice for one gesture. */
  private downToken: string | null = null;

  constructor(private readonly ctx: ToolContext) {}

  hasPinned(): boolean {
    return this.pinnedDisplays().length > 0;
  }

  unpin(id: string): void {
    const atlas = this.atlasMeasures().find((m) => m.id === id);
    if (atlas) {
      if (this.ctx.onDeleteMeasure?.(id)) return;
      return;
    }
    const next = this.localPins.filter((p) => p.id !== id);
    if (next.length === this.localPins.length) return;
    this.localPins = next;
    this.syncOverlay();
  }

  /** Drops what this tool drew locally. Atlas's own measurements of the level are left alone. */
  clearPinned(): void {
    if (this.localPins.length === 0 && this.fading === null) return;
    this.localPins = [];
    this.fading = null;
    this.syncOverlay();
  }

  /** Clears the level: Atlas's kept measurements too. Destructive, and only for a Clear control. */
  clearLevel(): void {
    this.localPins = [];
    this.fading = null;
    this.ctx.onClearMeasures?.();
    this.syncOverlay();
  }

  refresh(): void {
    this.syncOverlay();
  }

  onDown(e: PointerEvent, tokenHit: string | null): void {
    this.downToken = tokenHit;
    const mode = this.mode();

    if (mode === 'ranges') {
      const point = this.pickPoint(e, tokenHit, false);
      if (!point) return;
      this.anchorId = tokenHit ?? this.nearestTokenId(point);
      this.points = [point, point];
      this.active = true;
      this.dragStart = { x: e.clientX, y: e.clientY };
      this.dragged = false;
      this.commit();
      return;
    }

    const point = this.pickPoint(e, tokenHit, false);
    if (!point) return;

    if (!this.active) {
      this.active = true;
      this.points = [point, point];
      this.dragStart = { x: e.clientX, y: e.clientY };
      this.dragged = false;
      this.syncOverlay();
      return;
    }

    // Shift+click closes a leg and opens the next one, as it already did; now only for a ruler.
    if (mode === 'ruler' && e.shiftKey && this.points.length < MAX_RULER_POINTS) {
      this.points[this.points.length - 1] = point;
      this.points.push(point);
      this.dragStart = { x: e.clientX, y: e.clientY };
      this.dragged = false;
      this.syncOverlay();
      return;
    }

    this.points[this.points.length - 1] = point;
    this.commit(e.shiftKey);
  }

  onMove(e: PointerEvent): void {
    if (!this.active) return;
    if (this.dragStart && Math.hypot(e.clientX - this.dragStart.x, e.clientY - this.dragStart.y) >= CLICK_SLOP_PX) {
      this.dragged = true;
    }
    const point = this.pickPoint(e, this.ctx.view.pickToken(e), true);
    if (!point) return;
    this.points[this.points.length - 1] = point;
    this.syncOverlay();
  }

  onUp(e: PointerEvent): void {
    if (!this.active) return;
    if (this.dragged) {
      const point = this.pickPoint(e, this.downToken, true);
      if (point) this.points[this.points.length - 1] = point;
      this.commit(e.shiftKey);
    }
    this.dragStart = null;
    this.downToken = null;
  }

  onRightClick(): boolean {
    if (!this.active) return false;
    if (this.points.length > 2) {
      this.points.pop();
      this.syncOverlay();
      return true;
    }
    this.cancelActive();
    return true;
  }

  /** Kept for the dispatcher's waypoint entry point; the gesture is Shift+click. */
  addWaypoint(): boolean {
    if (!this.active || this.mode() !== 'ruler' || this.points.length < 2) return false;
    if (this.points.length >= MAX_RULER_POINTS) return false;
    const tip = this.points[this.points.length - 1]!;
    this.points.push([tip[0], tip[1], tip[2]]);
    this.syncOverlay();
    return true;
  }

  onAltChange(_on: boolean, lastEvent: PointerEvent | null): void {
    if (!this.active || !lastEvent) return;
    const point = this.pickPoint(lastEvent, this.ctx.view.pickToken(lastEvent), true);
    if (!point) return;
    this.points[this.points.length - 1] = point;
    this.syncOverlay();
  }

  onCancel(): void {
    this.cancelActive();
  }

  onLeave(): void {
    this.downToken = null;
  }

  // ---- what the scene tells us ---------------------------------------------------------------

  private tactical(): TacticalOverlayContext | null {
    return this.ctx.view.tacticalContext();
  }

  /** The rules Atlas resolves for this scene; the tool's own unit pair where the scene feeds none. */
  private rules(): AtlasMeasurementSettings {
    const fromScene = this.tactical()?.rules;
    if (fromScene) return fromScene;
    const unit = this.ctx.unit();
    return {
      mode: 'metric',
      unitType: 'feet',
      unitDistance: unit.distance > 0 ? unit.distance : 5,
      ruleDistance: unit.distance > 0 ? unit.distance : 5,
      diagonalRule: 'equidistant',
      difficultTerrain: 'none',
      rangeBands: [],
      coneAngle: 90,
      areaCellRule: 'half',
      coneEnd: 'round',
    };
  }

  private tokens(): readonly AreaTokenTarget[] {
    return this.tactical()?.tokens ?? [];
  }

  private mode(): AtlasMeasureMode {
    const state = this.ctx.measure();
    if (state.mode) return state.mode;
    return LEGACY_MODE[state.shape] ?? 'ruler';
  }

  private widthCells(): number {
    const raw = this.ctx.measure().lineWidth;
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LINE_WIDTH_CELLS;
  }

  private atlasMeasures(): readonly AtlasMeasure[] {
    return this.ctx.measures?.() ?? [];
  }

  /** The grid points snap to, in world units: a cell spans one unit, the layout holds the origin. */
  private snapGrid(): SnapGrid | null {
    const ctx = this.tactical();
    if (!ctx) return null;
    const grid = this.ctx.grid();
    if (grid?.snapToGrid === false) return null;
    return { cellSize: 1, originX: ctx.layout.originX, originZ: ctx.layout.originZ };
  }

  private nearestTokenId(point: Vec3): string | null {
    let best: string | null = null;
    let bestDistance = Infinity;
    for (const token of this.tokens()) {
      const distance = Math.hypot(token.x - point[0], token.z - point[2]);
      if (distance < bestDistance && distance <= Math.max(1, token.diameter) / 2 + 0.5) {
        bestDistance = distance;
        best = token.id;
      }
    }
    return best;
  }

  // ---- picking --------------------------------------------------------------------------------

  /**
   * A point in world units. A token hit gives its LOGICAL centre — never the TileShare-offset
   * drawing position, which would put half-cell errors into every diagonal — at the height the
   * token layer says it stands at. Otherwise it is the terrain pick, taken unsnapped and snapped
   * here by Atlas's own three rules.
   */
  private pickPoint(e: MouseEvent, tokenHit: string | null, isEnd: boolean): Vec3 | null {
    const free = this.ctx.altRemove();
    const grid = this.snapGrid();
    const mode = this.mode();

    if (tokenHit) {
      const target = this.tokens().find((t) => t.id === tokenHit);
      const info = this.ctx.view.tokenDragInfo(tokenHit);
      if (target && info) {
        const point: Vec3 = [target.x, info.groundY + info.lift, target.z];
        if (isEnd && mode !== 'ruler' && mode !== 'ranges' && this.points.length > 0) {
          return snapAreaEnd(free ? null : grid, this.points[0]!, point, false);
        }
        return point;
      }
      if (info) return [info.x, info.groundY + info.lift, info.z];
    }

    const raw = this.ctx.view.pickMeasurePoint(e, false);
    if (!raw) return null;
    const point: Vec3 = [raw.x, raw.y, raw.z];
    const snap = free ? null : grid;
    if (mode === 'ruler' || mode === 'ranges') return snapRulerPoint(snap, point);
    if (!isEnd || this.points.length === 0) return snapAreaOrigin(snap, point);
    return snapAreaEnd(snap, this.points[0]!, point);
  }

  // ---- describing a measurement ---------------------------------------------------------------

  private describe(
    points: readonly Vec3[],
    mode: AtlasMeasureMode,
    widthCells: number,
  ): { label: string; subLabel?: string; radiusCells: number; tokenIds: string[]; legs: MeasureLeg[] } {
    const rules = this.rules();
    const origin = points[0]!;
    const tip = points[points.length - 1]!;
    const rise = tip[1] - origin[1];
    const heightSub = Math.abs(rise) >= 0.08
      ? `ΔH ${rise >= 0 ? '+' : ''}${formatGameUnits(rise * rules.unitDistance, rules)}`
      : undefined;

    if (mode === 'ruler') {
      const cells = pathLengthInCells(points, 1, rules.diagonalRule, rise);
      const legs: MeasureLeg[] = [];
      if (points.length > 2) {
        for (let i = 1; i < points.length; i++) {
          const a = points[i - 1]!;
          const b = points[i]!;
          const legCells = pathLengthInCells([a, b], 1, rules.diagonalRule, b[1] - a[1]);
          legs.push({
            label: formatDistance(legCells, rules),
            at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
          });
        }
      }
      const parts: string[] = [];
      if (heightSub) parts.push(heightSub);
      if (points.length > 2) parts.push(`${points.length - 1} legs`);
      return {
        label: formatDistance(cells, rules),
        ...(parts.length > 0 && { subLabel: parts.join(' · ') }),
        radiusCells: cells,
        tokenIds: [],
        legs,
      };
    }

    if (mode === 'ranges') {
      const rings = rangeRings(rules, this.tactical()?.movement?.steps ?? [], this.tactical()?.speed ?? null);
      const outer = rings[rings.length - 1];
      return {
        label: outer ? outer.label : formatReach(0, rules),
        radiusCells: outer?.reach ?? 0,
        tokenIds: [],
        legs: [],
      };
    }

    const shape = mode as AtlasMeasureShape;
    const area = shapedArea(shape, planOf(origin), planOf(tip), areaShapeRules(rules, widthCells), widthCells);
    const length = Math.hypot(tip[0] - origin[0], tip[2] - origin[2]);
    let label: string;
    if (shape === 'square') {
      const side = formatDistance(length, rules);
      label = `${side} × ${side}`;
    } else if (shape === 'line') {
      label = `${formatDistance(length, rules)} × ${formatDistance(widthCells, rules)}`;
    } else {
      label = formatDistance(length, rules);
    }
    return {
      label,
      ...(heightSub !== undefined && { subLabel: heightSub }),
      radiusCells: area?.reach ?? length,
      tokenIds: area ? tokensInArea(area, this.tokens()) : [],
      legs: [],
    };
  }

  private buildDisplay(mode: AtlasMeasureMode): MeasureDisplay | null {
    if (this.points.length < 2 && mode !== 'ranges') return null;
    const state = this.ctx.measure();
    const widthCells = this.widthCells();
    const described = this.describe(this.points, mode, widthCells);
    const rules = this.rules();
    const rings = mode === 'ranges'
      ? rangeRings(rules, this.tactical()?.movement?.steps ?? [], this.tactical()?.speed ?? null)
      : undefined;
    return {
      id: ACTIVE_ID,
      shape: mode,
      mode,
      points: this.points.map((p) => [p[0], p[1], p[2]] as Vec3),
      radiusCells: described.radiusCells,
      label: described.label,
      ...(described.subLabel !== undefined && { subLabel: described.subLabel }),
      colorHex: state.color ?? null,
      pinned: false,
      tokenIds: described.tokenIds,
      legs: described.legs,
      widthCells,
      ...(rings !== undefined && { rings }),
      ...(mode === 'ranges' && this.anchorId !== null && { follows: this.anchorId }),
    };
  }

  // ---- keeping --------------------------------------------------------------------------------

  private cancelActive(): void {
    if (!this.active) return;
    this.active = false;
    this.points = [];
    this.dragStart = null;
    this.dragged = false;
    this.downToken = null;
    this.syncOverlay();
  }

  /** Shift on release reverses Keep, as Atlas's own tool does. */
  private commit(shiftOnRelease = false): void {
    const state = this.ctx.measure();
    const mode = this.mode();
    const keep = shiftOnRelease ? !state.keep : state.keep;
    const built = this.buildDisplay(mode);
    this.active = false;
    const points = this.points.map((p) => [p[0], p[1], p[2]] as Vec3);
    this.points = [];
    this.dragStart = null;
    this.dragged = false;
    this.downToken = null;

    if (!built || built.radiusCells <= 0.05) {
      this.syncOverlay();
      return;
    }

    if (!keep) {
      this.fading = { ...built, id: `fade-${this.nextPinId++}`, fading: true };
      this.fadingUntil = Date.now() + FADE_MS;
      this.syncOverlay();
      return;
    }

    const stored = this.store(mode, points, built);
    if (!stored) {
      this.localPins = [...this.localPins, { ...built, id: `pin-${this.nextPinId++}`, pinned: true }];
    }
    this.syncOverlay();
  }

  /** Hands the measurement to Atlas. False when it could not be kept, and a local pin stands in. */
  private store(mode: AtlasMeasureMode, points: readonly Vec3[], built: MeasureDisplay): boolean {
    const add = this.ctx.onAddMeasure;
    const size = this.ctx.grid()?.size ?? 0;
    if (!add || !(size > 0)) return false;
    // `ranges` is a tool mode, not a shape Atlas persists; it stays a local pin.
    if (!ATLAS_MEASURE_SHAPES.includes(mode as AtlasMeasureShape)) return false;
    const state = this.ctx.measure();
    const payload: AtlasPoint[] = points.map((p) => ({ x: p[0] * size, y: p[2] * size }));
    const id = add({
      shape: mode as AtlasMeasureShape,
      points: payload,
      widthCells: this.widthCells(),
      color: state.color ?? null,
      ...(state.players !== undefined && { players: state.players }),
      ...(state.effect != null && { effect: state.effect }),
    });
    if (id === null) return false;
    void built;
    return true;
  }

  // ---- what Atlas already holds ---------------------------------------------------------------

  private surfaceAt(x: number, z: number): number {
    const ctx = this.tactical();
    if (!ctx) return 0;
    const ceiling = Number.isFinite(ctx.maxLayer) ? ctx.maxLayer * ctx.map.layerHeight : Infinity;
    return ctx.map.surfaceHeightAt(x - ctx.layout.originX, z - ctx.layout.originZ, ceiling);
  }

  /** One kept measurement of Atlas, as the overlay draws it. An aura's geometry comes from its reach. */
  private keptDisplay(measure: AtlasMeasure): MeasureDisplay | null {
    const size = this.ctx.grid()?.size ?? 0;
    if (!(size > 0)) return null;
    const mode = LEGACY_MODE[measure.shape] ?? (measure.shape as AtlasMeasureMode);
    if (!ATLAS_MEASURE_SHAPES.includes(mode as AtlasMeasureShape) && mode !== 'ranges') return null;
    const rules = this.rules();
    const widthCells = typeof measure.width === 'number' && measure.width > 0
      ? measure.width / size
      : DEFAULT_LINE_WIDTH_CELLS;

    if (typeof measure.follows === 'string' && typeof measure.aura === 'number' && measure.aura > 0) {
      const anchor = this.tokens().find((t) => t.id === measure.follows);
      if (!anchor) return null;
      const y = this.surfaceAt(anchor.x, anchor.z) + 0.02;
      return {
        id: measure.id,
        shape: 'circle',
        mode: 'circle',
        points: [[anchor.x, y, anchor.z], [anchor.x + measure.aura / rules.unitDistance, y, anchor.z]],
        radiusCells: measure.aura / rules.unitDistance,
        label: formatReach(measure.aura / rules.unitDistance, rules),
        colorHex: measure.color ?? null,
        pinned: true,
        follows: measure.follows,
        aura: measure.aura,
        tokenIds: [],
        legs: [],
      };
    }

    if (!Array.isArray(measure.points) || measure.points.length < 2) return null;
    const points: Vec3[] = measure.points.map((p) => {
      const x = p.x / size;
      const z = p.y / size;
      return [x, this.surfaceAt(x, z), z] as Vec3;
    });
    const described = this.describe(points, mode, widthCells);
    return {
      id: measure.id,
      shape: mode,
      mode,
      points,
      radiusCells: described.radiusCells,
      label: described.label,
      ...(described.subLabel !== undefined && { subLabel: described.subLabel }),
      colorHex: measure.color ?? null,
      pinned: true,
      tokenIds: described.tokenIds,
      legs: described.legs,
      widthCells,
    };
  }

  private pinnedDisplays(): MeasureDisplay[] {
    const out: MeasureDisplay[] = [];
    const seen = new Set<string>();
    for (const measure of this.atlasMeasures()) {
      const display = this.keptDisplay(measure);
      if (!display || seen.has(display.id)) continue;
      seen.add(display.id);
      out.push(display);
    }
    for (const pin of this.localPins) {
      if (seen.has(pin.id)) continue;
      seen.add(pin.id);
      out.push(pin);
    }
    return out;
  }

  private syncOverlay(): void {
    if (this.fading !== null && Date.now() >= this.fadingUntil) this.fading = null;
    const pinned = this.pinnedDisplays();
    if (this.fading !== null) pinned.push(this.fading);
    const active = this.active ? this.buildDisplay(this.mode()) : null;
    this.ctx.view.setMeasure(active, pinned);
    this.ctx.onMeasurePinCountChange?.(pinned.length);
  }
}