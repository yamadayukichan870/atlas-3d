import * as THREE from 'three';
import type { BlockMap } from '../terrain/blocks';
import type { Layout } from '../terrain/layout';
import type { AoEShape } from '../terrain/raycast';
import { quarterOf, surfaceFraction, type Vec3 } from '../terrain/shapes';
import { outlineOfCells, type AreaCell, type AreaTokenTarget, type PlanCell, type PlanRing } from '../terrain/measureGeometry';
import {
  regionFromActive,
  regionFromKept,
  type MeasureRegion,
  type RegionContext,
  type WorldPoint,
} from '../terrain/measureRegion';
import {
  DEFAULT_AREA_CELL_RULE,
  DEFAULT_CONE_ANGLE,
  DEFAULT_CONE_END,
  DEFAULT_DIAGONAL_RULE,
  DEFAULT_LINE_WIDTH_CELLS,
  NO_MOVEMENT_RULES,
  type AtlasMeasureMode,
  type AtlasMeasurementSettings,
  type MovementRules,
} from '../atlas/measureRules';
import type { AtlasMeasure } from '../atlas/types';
import { PILL_COLOR_VAR, resolveColorHex, resolveMeasureColor } from '../common/colors';

/**
 * Draws what the measurement engine returns, and nothing it does not.
 *
 * Every figure here is a `MeasureRegion`: a set of terrain cells, the stepped outline of exactly
 * that set, and the labels that go with it. The renderer never shapes an area, never counts a
 * cell and never decides a distance — `terrain/measureRegion.ts` does, from Atlas' own rules and
 * Atlas' own kept measurements. That is what makes the 2D and the 3D agree: they are two drawings
 * of one answer, not two answers.
 *
 * The border is derived from the filled cells (`outlineOfCells`), never from an analytic polygon.
 * A cell straddling the shape's edge is painted whole and the border runs around that whole cell,
 * so fill and border are the same figure by construction. This is how Atlas draws an aura and how
 * grid templates read elsewhere: the region is a set of squares, its edge a staircase.
 *
 * Two doors in, one drawing out:
 *   - `setRegions`  : regions the scene already built from Atlas' kept measurements.
 *   - `setMeasure`  : the older display contract the measure tool still speaks; each display is
 *                     turned into a region by the same engine before it is drawn.
 *
 * Render ladder: terrain 0, water 1, grid lines 2, grid numbers 3, token base/art 3-5.
 * Region fill 2.5, region border 2.6, ruler drop 13, ruler path 14, ruler nodes 15, LoS 14-16.
 * Fills and borders sit under the token art so a figure never hides what stands on it.
 */

export interface MeasureLeg {
  readonly label: string;
  readonly at: Vec3;
}

/**
 * The display contract the measure tool builds. Kept so it compiles unchanged; every display is
 * converted to a `MeasureRegion` before drawing. `mode` wins over the legacy `shape`.
 */
export interface MeasureDisplay {
  id: string;
  shape: AoEShape | AtlasMeasureMode;
  points: readonly Vec3[];
  radiusCells: number;
  label: string;
  subLabel?: string;
  color?: number;
  pinned?: boolean;
  mode?: AtlasMeasureMode;
  colorHex?: string | null;
  legs?: readonly MeasureLeg[];
  tokenIds?: readonly string[];
  rings?: readonly { readonly label: string; readonly reach: number; readonly color: string | null }[];
  widthCells?: number;
  follows?: string;
  aura?: number;
  fading?: boolean;
}

export interface LosRayDisplay {
  name: 'base' | 'torso' | 'head';
  start: Vec3;
  end: Vec3;
  blocked: boolean;
  hitPoint: Vec3 | null;
}

export interface LosDisplay {
  origin: Vec3;
  target: Vec3;
  status: 'clear' | 'partial' | 'blocked';
  rays: readonly [LosRayDisplay, LosRayDisplay, LosRayDisplay];
  label: string;
  locked: boolean;
}

export interface TacticalOverlayContext {
  layout: Layout;
  map: BlockMap;
  maxLayer: number;
  gridSize?: number;
  rules?: AtlasMeasurementSettings;
  movement?: MovementRules;
  tokens?: readonly AreaTokenTarget[];
  selectedIds?: readonly string[];
  speed?: number | null;
}

interface PillEntry {
  el: HTMLElement;
  worldPos: THREE.Vector3;
}

interface Entry {
  id: string;
  group: THREE.Group;
  pills: PillEntry[];
  geoms: THREE.BufferGeometry[];
  mats: THREE.Material[];
  insts: THREE.InstancedMesh[];
  signature: string;
  fadeStart: number | null;
  baseOpacity: Map<THREE.Material, number>;
}

const FILL_ORDER = 2.5;
const BORDER_ORDER = 2.6;
const DROP_ORDER = 13;
const PATH_ORDER = 14;
const NODE_ORDER = 15;

const FILL_LIFT = 0.021;
const BORDER_LIFT = 0.028;
const PATH_LIFT = 0.04;
/** Half the border ribbon's width, in world units: a hair under a twentieth of a cell. */
const BORDER_HALF = 0.028;
const FILL_OPACITY = 0.26;
const BORDER_OPACITY = 0.95;
const FADE_MS = 2000;

const LEGACY_MODE: Record<AoEShape, AtlasMeasureMode> = {
  line: 'ruler',
  sphere: 'circle',
  cone: 'cone',
  cube: 'square',
};

const FALLBACK_RULES: AtlasMeasurementSettings = {
  mode: 'metric',
  unitType: 'feet',
  unitDistance: 5,
  ruleDistance: 5,
  diagonalRule: DEFAULT_DIAGONAL_RULE,
  difficultTerrain: 'none',
  rangeBands: [],
  coneAngle: DEFAULT_CONE_ANGLE,
  areaCellRule: DEFAULT_AREA_CELL_RULE,
  coneEnd: DEFAULT_CONE_END,
};

function createCircleRingGeometry(): THREE.BufferGeometry {
  const pts: number[] = [];
  const segs = 48;
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    pts.push(Math.cos(a0), 0, Math.sin(a0), Math.cos(a1), 0, Math.sin(a1));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

const modeOf = (d: MeasureDisplay): AtlasMeasureMode =>
  d.mode ?? LEGACY_MODE[d.shape as AoEShape] ?? (d.shape as AtlasMeasureMode);

const heightBucket = (y: number): number => Math.round(y * 1000);

/** The colour a display names, before the theme's accent is asked for one. */
function rawColorOf(d: MeasureDisplay): string | null {
  if (d.colorHex !== undefined) return d.colorHex;
  if (typeof d.color === 'number') return `#${d.color.toString(16).padStart(6, '0')}`;
  return null;
}

function regionSignature(region: MeasureRegion, ctxKey: string): string {
  return JSON.stringify([
    ctxKey,
    region.mode,
    region.label,
    region.subLabel ?? null,
    region.color,
    region.pinned,
    region.hidden,
    region.cells.length,
    region.cells.map((c) => [c.cx, c.cz, heightBucket(c.y)]),
    region.path,
    region.rings.map((r) => [r.label, r.color, r.outline.length]),
    region.tokenIds,
    region.legs.map((l) => [l.label, l.at]),
  ]);
}

function contextKey(ctx: TacticalOverlayContext): string {
  const r = ctx.rules;
  return JSON.stringify([
    ctx.maxLayer,
    ctx.map.layerHeight,
    ctx.gridSize ?? 1,
    r ? [r.diagonalRule, r.areaCellRule, r.coneAngle, r.coneEnd, r.unitDistance, r.mode, r.rangeBands] : null,
    ctx.movement?.steps.map((s) => [s.name, s.multiple, s.color]) ?? null,
    ctx.speed ?? null,
    ctx.tokens?.map((t) => [t.id, t.x, t.z, t.diameter]) ?? null,
    ctx.selectedIds ?? null,
  ]);
}

/**
 * Renders measured regions (areas, range rings, token auras), ruler paths, 3D Line-of-Sight
 * rays and their screen-projected readout pills.
 */
export class TacticalOverlays {
  readonly group = new THREE.Group();
  onSelectTokens: ((ids: readonly string[]) => void) | null = null;

  private readonly measureGroup = new THREE.Group();
  private readonly losGroup = new THREE.Group();
  private readonly labelLayer: HTMLElement;
  private readonly host: HTMLElement;

  private readonly nodeGeom = new THREE.SphereGeometry(0.1, 12, 10);
  private readonly hitGeom = new THREE.SphereGeometry(0.13, 12, 10);
  private readonly cellQuadGeom = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  private readonly ringLineGeom = createCircleRingGeometry();

  private readonly entries = new Map<string, Entry>();
  private losPill: PillEntry | null = null;
  private onUnpin: ((id: string) => void) | null = null;

  constructor(host: HTMLElement, onUnpin?: (id: string) => void) {
    this.host = host;
    this.onUnpin = onUnpin ?? null;
    this.group.add(this.measureGroup, this.losGroup);
    this.labelLayer = host.createDiv({ cls: 'atlas3d-tactical-layer' });
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.group);
  }

  isAnimating(): boolean {
    const now = performance.now();
    for (const entry of this.entries.values()) {
      if (entry.fadeStart !== null && now - entry.fadeStart < FADE_MS) return true;
    }
    return false;
  }

  /** Regions the scene built from Atlas' own kept measurements, plus the live one. */
  setRegions(
    active: MeasureRegion | null,
    pinned: readonly MeasureRegion[],
    ctx: TacticalOverlayContext | null,
  ): void {
    this.apply(active, pinned, ctx, new Set());
  }

  /** The display contract the measure tool speaks; each display becomes a region first. */
  setMeasure(
    active: MeasureDisplay | null,
    pinned: readonly MeasureDisplay[],
    ctx: TacticalOverlayContext | null,
  ): void {
    if (!ctx) {
      this.apply(null, [], null, new Set());
      return;
    }
    const rctx = this.regionContext(ctx);
    const fading = new Set<string>();
    const convert = (d: MeasureDisplay): MeasureRegion | null => {
      if (d.fading === true) fading.add(d.id);
      return this.regionOf(d, rctx);
    };
    const pinnedRegions: MeasureRegion[] = [];
    for (const d of pinned) {
      const region = convert(d);
      if (region) pinnedRegions.push(region);
    }
    const activeRegion = active ? convert(active) : null;
    this.apply(activeRegion, pinnedRegions, ctx, fading);
  }

  setLos(spec: LosDisplay | null): void {
    this.clearLos();
    if (!spec) return;
    this.buildLos(spec);
  }

  updateScreenLabels(camera: THREE.Camera, width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    const projected = new THREE.Vector3();
    const now = performance.now();

    const positionPill = (entry: PillEntry): void => {
      projected.copy(entry.worldPos).project(camera);
      if (projected.z <= -1 || projected.z >= 1) {
        entry.el.addClass('is-hidden');
        return;
      }
      entry.el.removeClass('is-hidden');
      entry.el.style.left = `${(projected.x * 0.5 + 0.5) * width}px`;
      entry.el.style.top = `${(-projected.y * 0.5 + 0.5) * height}px`;
    };

    for (const entry of this.entries.values()) {
      if (entry.fadeStart !== null) {
        const factor = 1 - Math.min(1, Math.max(0, (now - entry.fadeStart) / FADE_MS));
        for (const [mat, base] of entry.baseOpacity) {
          (mat as THREE.Material & { opacity: number }).opacity = base * factor;
        }
        entry.group.visible = factor > 0;
        if (factor <= 0) {
          for (const pill of entry.pills) pill.el.addClass('is-hidden');
          continue;
        }
      }
      for (const pill of entry.pills) positionPill(pill);
    }
    if (this.losPill) positionPill(this.losPill);
  }

  dispose(): void {
    this.clearMeasure();
    this.clearLos();
    this.labelLayer.remove();
    this.nodeGeom.dispose();
    this.hitGeom.dispose();
    this.cellQuadGeom.dispose();
    this.ringLineGeom.dispose();
  }

  // ---- from displays to regions ---------------------------------------------------------------

  private regionContext(ctx: TacticalOverlayContext): RegionContext {
    return {
      map: ctx.map,
      layout: ctx.layout,
      gridSize: ctx.gridSize ?? 1,
      maxLayer: ctx.maxLayer,
      rules: ctx.rules ?? FALLBACK_RULES,
      movement: ctx.movement ?? NO_MOVEMENT_RULES,
      tokens: ctx.tokens ?? [],
      selectedIds: ctx.selectedIds ?? [],
      speed: ctx.speed ?? null,
    };
  }

  /**
   * One display as a region, through the engine. An aura goes through the kept-measurement door
   * so its geometry comes from its reach and the token's space, exactly as Atlas' own aura does;
   * everything else goes through the live door.
   */
  private regionOf(d: MeasureDisplay, rctx: RegionContext): MeasureRegion | null {
    const color = rawColorOf(d);
    const pinned = d.pinned === true;

    if (typeof d.follows === 'string' && d.follows !== '' && typeof d.aura === 'number' && d.aura > 0) {
      const kept: AtlasMeasure = {
        id: d.id,
        kind: 'measure',
        shape: 'circle',
        points: [],
        follows: d.follows,
        aura: d.aura,
        ...(color !== null && { color }),
      };
      const region = regionFromKept(kept, rctx);
      return region && { ...region, pinned };
    }

    const width = typeof d.widthCells === 'number' && d.widthCells > 0 ? d.widthCells : DEFAULT_LINE_WIDTH_CELLS;
    const region = regionFromActive(
      d.id,
      modeOf(d),
      d.points as readonly WorldPoint[],
      width,
      color,
      rctx,
      d.follows ?? null,
    );
    return region && { ...region, pinned };
  }

  // ---- entries -------------------------------------------------------------------------------

  private apply(
    active: MeasureRegion | null,
    pinned: readonly MeasureRegion[],
    ctx: TacticalOverlayContext | null,
    fading: ReadonlySet<string>,
  ): void {
    if (!ctx) {
      this.clearMeasure();
      return;
    }
    const ctxKey = contextKey(ctx);
    const all = active ? [...pinned, active] : [...pinned];
    const wanted = new Set(all.map((r) => r.id));

    for (const [id, entry] of [...this.entries]) {
      if (!wanted.has(id)) {
        this.disposeEntry(entry);
        this.entries.delete(id);
      }
    }
    for (const region of all) {
      if (region.hidden && ctx.selectedIds !== undefined && false) continue;
      const sig = regionSignature(region, ctxKey);
      const existing = this.entries.get(region.id);
      if (existing && existing.signature === sig) {
        this.applyFade(existing, fading.has(region.id));
        continue;
      }
      if (existing) {
        this.disposeEntry(existing);
        this.entries.delete(region.id);
      }
      const entry = this.buildEntry(region, ctx);
      entry.signature = sig;
      this.applyFade(entry, fading.has(region.id));
      this.entries.set(region.id, entry);
      this.measureGroup.add(entry.group);
    }
  }

  private applyFade(entry: Entry, fading: boolean): void {
    if (fading) {
      if (entry.fadeStart === null) entry.fadeStart = performance.now();
      return;
    }
    entry.fadeStart = null;
    entry.group.visible = true;
    for (const [mat, base] of entry.baseOpacity) {
      (mat as THREE.Material & { opacity: number }).opacity = base;
    }
  }

  private clearMeasure(): void {
    for (const entry of this.entries.values()) this.disposeEntry(entry);
    this.entries.clear();
    this.measureGroup.clear();
  }

  private disposeEntry(entry: Entry): void {
    entry.group.removeFromParent();
    for (const g of entry.geoms) g.dispose();
    for (const m of entry.mats) m.dispose();
    for (const inst of entry.insts) inst.dispose();
    for (const pill of entry.pills) pill.el.remove();
    entry.geoms.length = 0;
    entry.mats.length = 0;
    entry.insts.length = 0;
    entry.pills.length = 0;
  }

  private trackMat<T extends THREE.Material>(entry: Entry, mat: T, opacity: number): T {
    entry.mats.push(mat);
    entry.baseOpacity.set(mat, opacity);
    return mat;
  }

  private trackGeom<T extends THREE.BufferGeometry>(entry: Entry, geom: T): T {
    entry.geoms.push(geom);
    return geom;
  }

  private ceilingOf(ctx: TacticalOverlayContext): number {
    return Number.isFinite(ctx.maxLayer) ? ctx.maxLayer * ctx.map.layerHeight : Infinity;
  }

  private surfaceY(ctx: TacticalOverlayContext, x: number, z: number, ceilingY: number): number {
    return ctx.map.surfaceHeightAt(x - ctx.layout.originX, z - ctx.layout.originZ, ceilingY);
  }

  private buildEntry(region: MeasureRegion, ctx: TacticalOverlayContext): Entry {
    const entry: Entry = {
      id: region.id,
      group: new THREE.Group(),
      pills: [],
      geoms: [],
      mats: [],
      insts: [],
      signature: '',
      fadeStart: null,
      baseOpacity: new Map(),
    };
    const color = new THREE.Color(resolveMeasureColor(region.color, this.host));
    const ceilingY = this.ceilingOf(ctx);

    this.drawCells(entry, region.cells, ctx, color);
    this.drawBorder(entry, region.outline, ctx, color, ceilingY);
    if (region.path) this.drawPath(entry, region.path, ctx, color, ceilingY);

    for (const ring of region.rings) {
      const ringColor = ring.color ? new THREE.Color(resolveColorHex(ring.color)) : color;
      const mat = this.trackMat(entry, new THREE.MeshBasicMaterial({
        color: ringColor, transparent: true, opacity: BORDER_OPACITY, depthWrite: false, side: THREE.DoubleSide,
      }), BORDER_OPACITY);
      this.drawBorderWith(entry, ring.outline, ctx, mat, ceilingY);
      this.addPill(entry, ring.labelAt, ring.label, undefined, ringColor, false);
    }

    for (const leg of region.legs) {
      this.addPill(entry, leg.at, leg.label, undefined, color, false);
    }

    this.addPill(
      entry,
      this.anchorOf(region, ctx, ceilingY),
      region.label,
      region.subLabel,
      color,
      region.pinned,
      region.tokenIds,
    );
    return entry;
  }

  /** Where the readout floats: a ruler's end, a range's outer edge, else the middle of the region. */
  private anchorOf(region: MeasureRegion, ctx: TacticalOverlayContext, ceilingY: number): WorldPoint {
    if (region.path && region.path.length > 0) return region.path[region.path.length - 1]!;
    const outer = region.rings[region.rings.length - 1];
    if (outer) return outer.labelAt;
    if (region.cells.length === 0) return [0, 0, 0];
    let sx = 0;
    let sz = 0;
    let top = -Infinity;
    for (const c of region.cells) {
      sx += (c.x0 + c.x1) / 2;
      sz += (c.z0 + c.z1) / 2;
      if (c.y > top) top = c.y;
    }
    const x = sx / region.cells.length;
    const z = sz / region.cells.length;
    return [x, Math.max(top, this.surfaceY(ctx, x, z, ceilingY)), z];
  }

  // ---- the one region drawing -----------------------------------------------------------------

  /**
   * A set of cells as one body: every cell filled edge to edge so neighbours merge, and a border
   * around the outline of exactly that set. Cells on different surfaces (a floor and a balcony
   * above it) are grouped by height so each gets its own outline; a ramp's cells are draped
   * corner by corner over its slope.
   */
  private drawCells(
    entry: Entry,
    cells: readonly AreaCell[],
    ctx: TacticalOverlayContext,
    color: THREE.Color,
  ): void {
    if (cells.length === 0) return;
    const fillMat = this.trackMat(entry, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: FILL_OPACITY, depthWrite: false, side: THREE.DoubleSide,
    }), FILL_OPACITY);

    const flats: AreaCell[] = [];
    for (const cell of cells) {
      if (cell.slope === undefined) flats.push(cell);
      else this.drapeSlopeCell(entry, cell, ctx, fillMat);
    }
    if (flats.length === 0) return;

    const inst = new THREE.InstancedMesh(this.cellQuadGeom, fillMat, flats.length);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < flats.length; i++) {
      const c = flats[i]!;
      dummy.position.set((c.x0 + c.x1) / 2, c.y + FILL_LIFT, (c.z0 + c.z1) / 2);
      dummy.scale.set(c.x1 - c.x0, 1, c.z1 - c.z0);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.renderOrder = FILL_ORDER;
    entry.insts.push(inst);
    entry.group.add(inst);
  }

  /** One ramp or steps cell, its four corners lifted to the surface they stand on. */
  private drapeSlopeCell(entry: Entry, c: AreaCell, ctx: TacticalOverlayContext, mat: THREE.Material): void {
    const slope = c.slope!;
    const q = quarterOf(slope.rot);
    const baseX = ctx.layout.originX + c.cx;
    const baseZ = ctx.layout.originZ + c.cz;
    const midF = surfaceFraction(slope.shape, q, (c.x0 + c.x1) / 2 - baseX, (c.z0 + c.z1) / 2 - baseZ);
    const corner = (x: number, z: number): THREE.Vector3 => {
      const f = surfaceFraction(slope.shape, q, x - baseX, z - baseZ);
      return new THREE.Vector3(x, c.y + (f - midF) * ctx.map.layerHeight + FILL_LIFT, z);
    };
    const a = corner(c.x0, c.z0);
    const b = corner(c.x1, c.z0);
    const d = corner(c.x1, c.z1);
    const e = corner(c.x0, c.z1);
    const geom = this.trackGeom(entry, new THREE.BufferGeometry());
    geom.setAttribute('position', new THREE.Float32BufferAttribute([
      a.x, a.y, a.z, b.x, b.y, b.z, d.x, d.y, d.z,
      a.x, a.y, a.z, d.x, d.y, d.z, e.x, e.y, e.z,
    ], 3));
    const mesh = new THREE.Mesh(geom, mat);
    mesh.renderOrder = FILL_ORDER;
    entry.group.add(mesh);
  }

  private drawBorder(
    entry: Entry,
    rings: readonly PlanRing[],
    ctx: TacticalOverlayContext,
    color: THREE.Color,
    ceilingY: number,
  ): void {
    if (rings.length === 0) return;
    const mat = this.trackMat(entry, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: BORDER_OPACITY, depthWrite: false, side: THREE.DoubleSide,
    }), BORDER_OPACITY);
    this.drawBorderWith(entry, rings, ctx, mat, ceilingY);
  }

  /**
   * The region's edge as a ribbon of real width, draped on the terrain. A WebGL line is always
   * one pixel whatever `linewidth` says, which is why a hairline border read poorly against a
   * solid fill; a ribbon has a width in the world and stays legible at every zoom.
   */
  private drawBorderWith(
    entry: Entry,
    rings: readonly PlanRing[],
    ctx: TacticalOverlayContext,
    mat: THREE.Material,
    ceilingY: number,
  ): void {
    if (rings.length === 0) return;
    const pts: number[] = [];
    const push = (x: number, z: number): void => {
      pts.push(x, this.surfaceY(ctx, x, z, ceilingY) + BORDER_LIFT, z);
    };
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!;
        const b = ring[(i + 1) % ring.length]!;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        if (!(len > 1e-6)) continue;
        const px = (-dz / len) * BORDER_HALF;
        const pz = (dx / len) * BORDER_HALF;
        push(a.x + px, a.z + pz);
        push(a.x - px, a.z - pz);
        push(b.x - px, b.z - pz);
        push(a.x + px, a.z + pz);
        push(b.x - px, b.z - pz);
        push(b.x + px, b.z + pz);
      }
    }
    if (pts.length === 0) return;
    const geom = this.trackGeom(entry, new THREE.BufferGeometry());
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const mesh = new THREE.Mesh(geom, mat);
    mesh.renderOrder = BORDER_ORDER;
    entry.group.add(mesh);
  }

  /** A ruler: its path, its corners, and a dashed drop wherever a corner stands above the ground. */
  private drawPath(
    entry: Entry,
    path: readonly WorldPoint[],
    ctx: TacticalOverlayContext,
    color: THREE.Color,
    ceilingY: number,
  ): void {
    if (path.length < 2) return;
    const pathMat = this.trackMat(entry, new THREE.LineBasicMaterial({
      color, transparent: true, opacity: 0.95, depthTest: false,
    }), 0.95);
    const dropMat = this.trackMat(entry, new THREE.LineDashedMaterial({
      color, transparent: true, opacity: 0.5, dashSize: 0.14, gapSize: 0.08, depthTest: false,
    }), 0.5);
    const nodeMat = this.trackMat(entry, new THREE.MeshBasicMaterial({ color, depthTest: false }), 1);

    const lineGeom = this.trackGeom(entry, new THREE.BufferGeometry().setFromPoints(
      path.map((p) => new THREE.Vector3(p[0], p[1] + PATH_LIFT, p[2])),
    ));
    const line = new THREE.Line(lineGeom, pathMat);
    line.renderOrder = PATH_ORDER;
    entry.group.add(line);

    for (const p of path) {
      const node = new THREE.Mesh(this.nodeGeom, nodeMat);
      node.position.set(p[0], p[1] + PATH_LIFT, p[2]);
      node.renderOrder = NODE_ORDER;
      entry.group.add(node);
      const groundY = this.surfaceY(ctx, p[0], p[2], ceilingY);
      if (Math.abs(p[1] - groundY) > 0.08) {
        const dropGeom = this.trackGeom(entry, new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(p[0], p[1] + PATH_LIFT, p[2]),
          new THREE.Vector3(p[0], groundY + 0.02, p[2]),
        ]));
        const drop = new THREE.Line(dropGeom, dropMat);
        drop.computeLineDistances();
        drop.renderOrder = DROP_ORDER;
        entry.group.add(drop);
      }
    }
  }

  // ---- pills ---------------------------------------------------------------------------------

  private addPill(
    entry: Entry,
    at: WorldPoint,
    main: string,
    sub: string | undefined,
    color: THREE.Color,
    pinned: boolean,
    tokenIds?: readonly string[],
  ): void {
    if (main === '') return;
    const pill = this.labelLayer.createDiv({ cls: pinned ? 'atlas3d-tactical-pill is-pinned' : 'atlas3d-tactical-pill' });
    pill.style.setProperty(PILL_COLOR_VAR, `#${color.getHexString()}`);
    pill.createSpan({ cls: 'atlas3d-tactical-main', text: main });
    if (sub) pill.createSpan({ cls: 'atlas3d-tactical-sub', text: sub });

    if (tokenIds && tokenIds.length > 0 && this.onSelectTokens) {
      const select = pill.createEl('button', {
        cls: 'atlas3d-tactical-select',
        text: `Select (${tokenIds.length})`,
        attr: { title: 'Select the tokens inside' },
      });
      select.style.pointerEvents = 'auto';
      select.addEventListener('pointerdown', (e) => e.stopPropagation());
      select.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onSelectTokens?.(tokenIds);
      });
    }
    if (pinned && this.onUnpin) {
      const close = pill.createEl('button', { cls: 'atlas3d-tactical-close', text: '×', attr: { title: 'Remove measurement' } });
      close.addEventListener('pointerdown', (e) => e.stopPropagation());
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onUnpin?.(entry.id);
      });
    }
    entry.pills.push({ el: pill, worldPos: new THREE.Vector3(at[0], at[1] + 0.35, at[2]) });
  }

  // ---- LoS -----------------------------------------------------------------------------------

  private clearLos(): void {
    for (const child of this.losGroup.children) {
      if (child instanceof THREE.Line || child instanceof THREE.Mesh) {
        if (child.geometry !== this.nodeGeom && child.geometry !== this.hitGeom && child.geometry !== this.ringLineGeom) {
          child.geometry.dispose();
        }
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
        else child.material.dispose();
      }
    }
    this.losGroup.clear();
    if (this.losPill) {
      this.losPill.el.remove();
      this.losPill = null;
    }
  }

  private buildLos(spec: LosDisplay): void {
    const overall = spec.status === 'clear' ? 0x22c55e : spec.status === 'partial' ? 0xfacc15 : 0xef4444;

    const addPole = (p: Vec3, color: number): void => {
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(p[0], p[1] + 0.02, p[2]),
        new THREE.Vector3(p[0], p[1] + 1.0, p[2]),
      ]);
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.75, depthTest: false }));
      line.renderOrder = 14;
      this.losGroup.add(line);
      const ring = new THREE.LineSegments(this.ringLineGeom, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false }));
      ring.position.set(p[0], p[1] + 0.03, p[2]);
      ring.scale.setScalar(0.36);
      ring.renderOrder = 14;
      this.losGroup.add(ring);
    };

    addPole(spec.origin, 0x38bdf8);
    addPole(spec.target, overall);

    for (const ray of spec.rays) {
      const start = new THREE.Vector3(...ray.start);
      const end = new THREE.Vector3(...ray.end);
      if (!ray.blocked || !ray.hitPoint) {
        const color = spec.status === 'clear' ? 0x22c55e : 0xfacc15;
        const g = new THREE.BufferGeometry().setFromPoints([start, end]);
        const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false }));
        line.renderOrder = 15;
        this.losGroup.add(line);
        continue;
      }
      const hit = new THREE.Vector3(...ray.hitPoint);
      const clearGeom = new THREE.BufferGeometry().setFromPoints([start, hit]);
      const clearLine = new THREE.Line(clearGeom, new THREE.LineBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.85, depthTest: false }));
      clearLine.renderOrder = 15;
      this.losGroup.add(clearLine);

      const blockedGeom = new THREE.BufferGeometry().setFromPoints([hit, end]);
      const blockedLine = new THREE.Line(blockedGeom, new THREE.LineDashedMaterial({
        color: 0xef4444, transparent: true, opacity: 0.75, dashSize: 0.14, gapSize: 0.08, depthTest: false,
      }));
      blockedLine.computeLineDistances();
      blockedLine.renderOrder = 15;
      this.losGroup.add(blockedLine);

      const marker = new THREE.Mesh(this.hitGeom, new THREE.MeshBasicMaterial({ color: 0xef4444, depthTest: false }));
      marker.position.copy(hit);
      marker.renderOrder = 16;
      this.losGroup.add(marker);
    }

    const pill = this.labelLayer.createDiv({ cls: `atlas3d-tactical-pill atlas3d-los-pill is-${spec.status}` });
    pill.createSpan({ cls: 'atlas3d-tactical-main', text: spec.label });
    if (spec.locked) pill.createSpan({ cls: 'atlas3d-tactical-sub', text: 'Locked (click to reset)' });
    this.losPill = { el: pill, worldPos: new THREE.Vector3(spec.target[0], spec.target[1] + 1.28, spec.target[2]) };
  }
}