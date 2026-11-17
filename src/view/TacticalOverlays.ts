import * as THREE from 'three';
import type { BlockMap } from '../terrain/blocks';
import type { Layout } from '../terrain/layout';
import type { AoEShape } from '../terrain/raycast';
import { quarterOf, surfaceFraction, type Vec3 } from '../terrain/shapes';
import {
  cellsInArea,
  cellsWithinReach,
  outlineOfCells,
  shapedArea,
  stoodCells,
  tokensInArea,
  type AreaCell,
  type AreaTokenTarget,
  type PlanArea,
  type PlanCell,
  type PlanPoint,
  type PlanRing,
} from '../terrain/measureGeometry';
import {
  DEFAULT_AREA_CELL_RULE,
  DEFAULT_CONE_ANGLE,
  DEFAULT_CONE_END,
  DEFAULT_DIAGONAL_RULE,
  areaShapeRules,
  formatDistance,
  pathLengthInCells,
  rangeRings,
  type AtlasMeasureMode,
  type AtlasMeasureShape,
  type AtlasMeasurementSettings,
  type MovementRules,
  type RangeRing,
} from '../atlas/measureRules';
import { PILL_COLOR_VAR, resolveColorHex, resolveMeasureColor } from '../common/colors';

/**
 * Draws measured areas, rulers, range rings and auras on the terrain, and the LoS rays.
 *
 * Geometry comes from terrain/measureGeometry.ts and rules from atlas/measureRules.ts, both
 * verified against Atlas VTT 0.16.0. This file only turns their answers into meshes and pills.
 *
 * Compatibility: the old producers (MeasureTool, Scene3D) still build displays with the legacy
 * `shape` ('line' | 'sphere' | 'cone' | 'cube'), a numeric `color` and `radiusCells`. Those keep
 * working: `mode` wins when present, otherwise the legacy shape is mapped ('sphere'->'circle',
 * 'cube'->'square', 'line'->'ruler'). New producers set `mode` and `colorHex`. The legacy fields
 * go away when the last producer migrates.
 *
 * Decisions taken here (change them by editing the marked spots):
 *  - a ruler's height is folded into the diagonal rule, one label, as Atlas does; ΔH is a sub-line.
 *  - one cell of rise is one world unit (the world already adds `lift` in world units).
 *  - `circle` is a plan circle, Atlas parity. The sphere alternative is cellsInSphere, unused here.
 *
 * Render ladder (explicit, so fills never cover token art or grid numbers):
 *   terrain 0, water 1, grid lines 2, grid numbers 3, token base/art 3-5.
 *   Area/aura fills 2.5, outlines 3.2, ruler drop 13, ruler path 14, ruler nodes 15, LoS 14-16.
 */

export interface MeasureLeg {
  readonly label: string;
  readonly at: Vec3;
}

export interface MeasureDisplay {
  id: string;
  /** Legacy shape or the Atlas mode; `mode` wins when present. */
  shape: AoEShape | AtlasMeasureMode;
  points: readonly Vec3[];
  /** Legacy radius/length hint; geometry is recomputed from the points, so this is only a fallback. */
  radiusCells: number;
  label: string;
  subLabel?: string;
  /** Legacy numeric colour; `colorHex` wins when present. */
  color?: number;
  pinned?: boolean;
  /** The Atlas mode this display is. New producers set it; legacy ones leave it unset. */
  mode?: AtlasMeasureMode;
  /** '#rrggbb', or null for the theme's accent. */
  colorHex?: string | null;
  legs?: readonly MeasureLeg[];
  tokenIds?: readonly string[];
  rings?: readonly RangeRing[];
  widthCells?: number;
  follows?: string;
  aura?: number;
  /** When set, the display fades out over two seconds instead of staying. */
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
  /** World units per cell; the plan is 1, kept explicit for callers that pass pixels. */
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

const UP = new THREE.Vector3(0, 1, 0);
const DOWN_VEC = new THREE.Vector3(0, -1, 0);

const FILL_ORDER = 2.5;
const OUTLINE_ORDER = 3.2;
const DROP_ORDER = 13;
const PATH_ORDER = 14;
const NODE_ORDER = 15;
const FILL_LIFT = 0.02;
const OUTLINE_LIFT = 0.026;
const PATH_LIFT = 0.04;
const CELL_INSET = 0.94;
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

function createUnitApexConeGeometry(): THREE.ConeGeometry {
  const geom = new THREE.ConeGeometry(1, 1, 28, 1, false);
  geom.translate(0, -0.5, 0);
  return geom;
}

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

const planOf = (p: Vec3): PlanPoint => ({ x: p[0], z: p[2] });

function displayColor(d: MeasureDisplay, host: HTMLElement): string {
  if (d.colorHex !== undefined) return resolveMeasureColor(d.colorHex, host);
  if (typeof d.color === 'number') return resolveColorHex(`#${d.color.toString(16).padStart(6, '0')}`);
  return resolveMeasureColor(null, host);
}

function signatureOf(d: MeasureDisplay, ctxKey: string): string {
  return JSON.stringify([
    ctxKey,
    modeOf(d),
    d.points,
    d.label,
    d.subLabel ?? null,
    d.colorHex ?? d.color ?? null,
    d.widthCells ?? null,
    d.tokenIds ?? null,
    d.rings?.map((r) => [r.label, r.reach, r.color]) ?? null,
    d.follows ?? null,
    d.aura ?? null,
    d.pinned === true,
    d.legs?.map((l) => [l.label, l.at]) ?? null,
  ]);
}

function contextKey(ctx: TacticalOverlayContext): string {
  const r = ctx.rules;
  return JSON.stringify([
    ctx.maxLayer,
    ctx.gridSize ?? 1,
    r ? [r.diagonalRule, r.areaCellRule, r.coneAngle, r.coneEnd, r.unitDistance, r.mode, r.rangeBands] : null,
    ctx.movement?.steps.map((s) => [s.name, s.multiple, s.color]) ?? null,
    ctx.speed ?? null,
    ctx.tokens?.map((t) => [t.id, t.x, t.z, t.diameter]) ?? null,
    ctx.selectedIds ?? null,
  ]);
}

/**
 * Renders 3D tactical measurements (ruler paths, plan areas, range rings, auras), 3D
 * Line-of-Sight rays and their screen-projected readout pills.
 */
export class TacticalOverlays {
  readonly group = new THREE.Group();
  /** Called by the Select (N) pill button; wired by the scene when it can select many. */
  onSelectTokens: ((ids: readonly string[]) => void) | null = null;

  private readonly measureGroup = new THREE.Group();
  private readonly losGroup = new THREE.Group();
  private readonly labelLayer: HTMLElement;
  private readonly host: HTMLElement;

  private readonly sphereGeom = new THREE.SphereGeometry(1, 24, 16);
  private readonly coneGeom = createUnitApexConeGeometry();
  private readonly boxGeom = new THREE.BoxGeometry(1, 1, 1);
  private readonly boxWireGeom = new THREE.EdgesGeometry(this.boxGeom);
  private readonly nodeGeom = new THREE.SphereGeometry(0.11, 12, 10);
  private readonly hitGeom = new THREE.SphereGeometry(0.13, 12, 10);
  private readonly cellQuadGeom = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  private readonly ringLineGeom = createCircleRingGeometry();

  private readonly entries = new Map<string, Entry>();
  private losPill: PillEntry | null = null;
  private onUnpin: ((id: string) => void) | null = null;
  private ctx: TacticalOverlayContext | null = null;
  private ctxKey = '';

  private readonly ownedGeometries: THREE.BufferGeometry[] = [];
  private readonly ownedMaterials: THREE.Material[] = [];

  constructor(host: HTMLElement, onUnpin?: (id: string) => void) {
    this.host = host;
    this.onUnpin = onUnpin ?? null;
    this.group.add(this.measureGroup, this.losGroup);
    this.labelLayer = host.createDiv({ cls: 'atlas3d-tactical-layer' });
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.group);
  }

  /** Whether a fade is still running, so the renderer keeps pumping frames for it. */
  isAnimating(): boolean {
    for (const entry of this.entries.values()) {
      if (entry.fadeStart !== null && performance.now() - entry.fadeStart < FADE_MS) return true;
    }
    return false;
  }

  setMeasure(
    active: MeasureDisplay | null,
    pinned: readonly MeasureDisplay[],
    ctx: TacticalOverlayContext | null,
  ): void {
    this.ctx = ctx;
    this.ctxKey = ctx ? contextKey(ctx) : '';
    if (!ctx) {
      this.clearMeasure();
      return;
    }
    const all = active ? [...pinned, active] : [...pinned];
    const wanted = new Map<string, MeasureDisplay>();
    for (const d of all) wanted.set(d.id, d);

    for (const [id, entry] of [...this.entries]) {
      if (!wanted.has(id)) {
        this.disposeEntry(entry);
        this.entries.delete(id);
      }
    }
    for (const d of all) {
      const sig = signatureOf(d, this.ctxKey);
      const existing = this.entries.get(d.id);
      if (existing && existing.signature === sig) {
        this.applyFade(existing, d);
        continue;
      }
      if (existing) {
        this.disposeEntry(existing);
        this.entries.delete(d.id);
      }
      const entry = this.buildEntry(d, ctx);
      entry.signature = sig;
      this.applyFade(entry, d);
      this.entries.set(d.id, entry);
      this.measureGroup.add(entry.group);
    }
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
      const x = (projected.x * 0.5 + 0.5) * width;
      const y = (-projected.y * 0.5 + 0.5) * height;
      entry.el.style.left = `${x}px`;
      entry.el.style.top = `${y}px`;
    };

    for (const entry of this.entries.values()) {
      if (entry.fadeStart !== null) {
        const t = Math.min(1, Math.max(0, (now - entry.fadeStart) / FADE_MS));
        const factor = 1 - t;
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
    this.sphereGeom.dispose();
    this.coneGeom.dispose();
    this.boxGeom.dispose();
    this.boxWireGeom.dispose();
    this.nodeGeom.dispose();
    this.hitGeom.dispose();
    this.cellQuadGeom.dispose();
    this.ringLineGeom.dispose();
  }

  // ---- measure entries -----------------------------------------------------------------------

  private applyFade(entry: Entry, d: MeasureDisplay): void {
    if (d.fading === true) {
      if (entry.fadeStart === null) entry.fadeStart = performance.now();
    } else {
      entry.fadeStart = null;
      entry.group.visible = true;
      for (const [mat, base] of entry.baseOpacity) {
        (mat as THREE.Material & { opacity: number }).opacity = base;
      }
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

  private buildEntry(d: MeasureDisplay, ctx: TacticalOverlayContext): Entry {
    const entry: Entry = {
      id: d.id,
      group: new THREE.Group(),
      pills: [],
      geoms: [],
      mats: [],
      insts: [],
      signature: '',
      fadeStart: null,
      baseOpacity: new Map(),
    };
    const color = new THREE.Color(displayColor(d, this.host));
    const mode = modeOf(d);
    const rules = ctx.rules ?? FALLBACK_RULES;
    const ceilingY = Number.isFinite(ctx.maxLayer) ? ctx.maxLayer * ctx.map.layerHeight : Infinity;

    if (mode === 'ruler') {
      this.buildRuler(entry, d, ctx, color, ceilingY, rules);
    } else if (mode === 'ranges') {
      this.buildRanges(entry, d, ctx, color, ceilingY, rules);
    } else if (d.follows !== undefined && d.aura !== undefined) {
      this.buildAura(entry, d, ctx, color, ceilingY, rules);
    } else {
      this.buildArea(entry, d, ctx, color, ceilingY, rules, mode);
    }

    this.buildPill(entry, d, color, mode);
    return entry;
  }

  private surfaceY(ctx: TacticalOverlayContext, x: number, z: number, ceilingY: number): number {
    return ctx.map.surfaceHeightAt(x - ctx.layout.originX, z - ctx.layout.originZ, ceilingY);
  }

  private buildRuler(
    entry: Entry,
    d: MeasureDisplay,
    ctx: TacticalOverlayContext,
    color: THREE.Color,
    ceilingY: number,
    rules: AtlasMeasurementSettings,
  ): void {
    if (d.points.length < 2) return;
    const pathMat = this.trackMat(entry, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false }), 0.95);
    const dropMat = this.trackMat(entry, new THREE.LineDashedMaterial({ color, transparent: true, opacity: 0.55, dashSize: 0.14, gapSize: 0.08, depthTest: false }), 0.55);
    const nodeMat = this.trackMat(entry, new THREE.MeshBasicMaterial({ color, depthTest: false }), 1);

    const linePts = d.points.map((p) => new THREE.Vector3(p[0], p[1] + PATH_LIFT, p[2]));
    const lineGeom = this.trackGeom(entry, new THREE.BufferGeometry().setFromPoints(linePts));
    const line = new THREE.Line(lineGeom, pathMat);
    line.renderOrder = PATH_ORDER;
    entry.group.add(line);

    for (const p of d.points) {
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

    // One label, height folded into the rule as Atlas does; ΔH only as a sub-line.
    const origin = d.points[0]!;
    const tip = d.points[d.points.length - 1]!;
    const rise = tip[1] - origin[1];
    const cells = pathLengthInCells(d.points, 1, rules.diagonalRule, rise);
    const main = d.label !== '' ? d.label : formatDistance(cells, rules);
    const sub = d.subLabel ?? (Math.abs(rise) >= 0.08
      ? `ΔH ${rise >= 0 ? '+' : ''}${formatDistance(Math.abs(rise), rules)}`
      : undefined);

    const legs = d.legs;
    if (legs && legs.length > 0) {
      for (const leg of legs) {
        this.addPill(entry, leg.at, leg.label, undefined, color, false, false);
      }
    }
    this.addPill(entry, tip, main, sub, color, d.pinned === true, false, d.tokenIds);
  }

  private buildArea(
    entry: Entry,
    d: MeasureDisplay,
    ctx: TacticalOverlayContext,
    color: THREE.Color,
    ceilingY: number,
    rules: AtlasMeasurementSettings,
    mode: AtlasMeasureMode,
  ): void {
    if (d.points.length < 2) return;
    const origin = planOf(d.points[0]!);
    const end = planOf(d.points[d.points.length - 1]!);
    const shapeRules = areaShapeRules(rules, d.widthCells);
    const area = shapedArea(mode as AtlasMeasureShape, origin, end, shapeRules, d.widthCells);
    if (!area) return;

    const cells = cellsInArea(area, {
      map: ctx.map,
      layout: ctx.layout,
      maxLayer: ctx.maxLayer,
      cellRule: rules.areaCellRule,
    });
    this.drawCells(entry, cells, ctx, color);
    this.drawRings(entry, area.rings, ctx, color, ceilingY);

    const tokenIds = d.tokenIds ?? (ctx.tokens ? tokensInArea(area, ctx.tokens) : []);
    const tip = d.points[d.points.length - 1]!;
    this.addPill(entry, tip, d.label, d.subLabel, color, d.pinned === true, false, tokenIds);
  }

  private buildRanges(
    entry: Entry,
    d: MeasureDisplay,
    ctx: TacticalOverlayContext,
    color: THREE.Color,
    ceilingY: number,
    rules: AtlasMeasurementSettings,
  ): void {
    const tokens = ctx.tokens ?? [];
    const anchorId = d.follows ?? ctx.selectedIds?.[0];
    const anchor = tokens.find((t) => t.id === anchorId) ?? tokens[0];
    const stood: PlanCell[] = anchor
      ? stoodCells(anchor.x, anchor.z, anchor.diameter, ctx.layout)
      : stoodCells(d.points[0]?.[0] ?? 0, d.points[0]?.[2] ?? 0, 1, ctx.layout);

    const rings = d.rings ?? rangeRings(rules, ctx.movement?.steps ?? [], ctx.speed ?? null);
    let last: PlanPoint | null = null;
    for (const ring of rings) {
      const ringColor = ring.color ? new THREE.Color(resolveColorHex(ring.color)) : color;
      const cells = cellsWithinReach(stood, ring.reach, rules.diagonalRule, ctx.layout);
      if (cells) {
        const outlines = outlineOfCells(cells, ctx.layout);
        this.drawRings(entry, outlines, ctx, ringColor, ceilingY);
        const far = farthestPoint(outlines);
        if (far) {
          last = far;
          this.addPill(entry, [far.x, this.surfaceY(ctx, far.x, far.z, ceilingY), far.z], ring.label, undefined, ringColor, false, false);
        }
      } else {
        const centre: PlanPoint = anchor ? { x: anchor.x, z: anchor.z } : planOf(d.points[0] ?? [0, 0, 0]);
        const ringGeom = this.trackGeom(entry, this.circleGeomAt(centre, ring.reach, ctx, ceilingY));
        const mat = this.trackMat(entry, new THREE.LineBasicMaterial({ color: ringColor, transparent: true, opacity: 0.8, depthTest: false }), 0.8);
        const loop = new THREE.LineLoop(ringGeom, mat);
        loop.renderOrder = OUTLINE_ORDER;
        entry.group.add(loop);
        last = { x: centre.x + ring.reach, z: centre.z };
        this.addPill(entry, [last.x, this.surfaceY(ctx, last.x, last.z, ceilingY), last.z], ring.label, undefined, ringColor, false, false);
      }
    }
    const tip = last ?? planOf(d.points[0] ?? [0, 0, 0]);
    this.addPill(entry, [tip.x, this.surfaceY(ctx, tip.x, tip.z, ceilingY), tip.z], d.label, d.subLabel, color, d.pinned === true, false, d.tokenIds);
  }

  private buildAura(
    entry: Entry,
    d: MeasureDisplay,
    ctx: TacticalOverlayContext,
    color: THREE.Color,
    ceilingY: number,
    rules: AtlasMeasurementSettings,
  ): void {
    const tokens = ctx.tokens ?? [];
    const anchor = tokens.find((t) => t.id === d.follows);
    if (!anchor || d.aura === undefined) return;
    const reach = d.aura / (rules.unitDistance > 0 ? rules.unitDistance : 1);
    const stood = stoodCells(anchor.x, anchor.z, anchor.diameter, ctx.layout);
    const cells = cellsWithinReach(stood, reach, rules.diagonalRule, ctx.layout);
    if (cells) {
      const outlines = outlineOfCells(cells, ctx.layout);
      this.drawCells(entry, cells.map((c) => this.areaCellOf(c, ctx, ceilingY)), ctx, color);
      this.drawRings(entry, outlines, ctx, color, ceilingY);
    } else {
      const ringGeom = this.trackGeom(entry, this.circleGeomAt({ x: anchor.x, z: anchor.z }, reach, ctx, ceilingY));
      const mat = this.trackMat(entry, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8, depthTest: false }), 0.8);
      const loop = new THREE.LineLoop(ringGeom, mat);
      loop.renderOrder = OUTLINE_ORDER;
      entry.group.add(loop);
    }
    this.addPill(entry, [anchor.x, this.surfaceY(ctx, anchor.x, anchor.z, ceilingY), anchor.z], d.label, d.subLabel, color, d.pinned === true, false);
  }

  private areaCellOf(cell: PlanCell, ctx: TacticalOverlayContext, ceilingY: number): AreaCell {
    const x0 = ctx.layout.originX + cell.cx;
    const z0 = ctx.layout.originZ + cell.cz;
    const y = this.surfaceY(ctx, x0 + 0.5, z0 + 0.5, ceilingY);
    return { cx: cell.cx, cz: cell.cz, y, x0, x1: x0 + 1, z0, z1: z0 + 1 };
  }

  private circleGeomAt(centre: PlanPoint, reach: number, ctx: TacticalOverlayContext, ceilingY: number): THREE.BufferGeometry {
    const pts: THREE.Vector3[] = [];
    const segs = 64;
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const x = centre.x + Math.cos(a) * reach;
      const z = centre.z + Math.sin(a) * reach;
      pts.push(new THREE.Vector3(x, this.surfaceY(ctx, x, z, ceilingY) + OUTLINE_LIFT, z));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  }

  private drawCells(entry: Entry, cells: readonly AreaCell[], ctx: TacticalOverlayContext, color: THREE.Color): void {
    if (cells.length === 0) return;
    const fillMat = this.trackMat(entry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }), 0.28);
    const flats = cells.filter((c) => c.slope === undefined);
    const slopes = cells.filter((c) => c.slope !== undefined);

    if (flats.length > 0) {
      const inst = new THREE.InstancedMesh(this.cellQuadGeom, fillMat, flats.length);
      const dummy = new THREE.Object3D();
      for (let i = 0; i < flats.length; i++) {
        const c = flats[i]!;
        dummy.position.set((c.x0 + c.x1) / 2, c.y + FILL_LIFT, (c.z0 + c.z1) / 2);
        dummy.scale.set((c.x1 - c.x0) * CELL_INSET, 1, (c.z1 - c.z0) * CELL_INSET);
        dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);
      }
      inst.instanceMatrix.needsUpdate = true;
      inst.renderOrder = FILL_ORDER;
      entry.insts.push(inst);
      entry.group.add(inst);
    }

    for (const c of slopes) {
      const slope = c.slope!;
      const q = quarterOf(slope.rot);
      const midU = ((c.x0 + c.x1) / 2) - (ctx.layout.originX + c.cx);
      const midV = ((c.z0 + c.z1) / 2) - (ctx.layout.originZ + c.cz);
      const midF = surfaceFraction(slope.shape, q, midU, midV);
      const corner = (x: number, z: number): THREE.Vector3 => {
        const u = x - (ctx.layout.originX + c.cx);
        const v = z - (ctx.layout.originZ + c.cz);
        const y = c.y + (surfaceFraction(slope.shape, q, u, v) - midF) * ctx.map.layerHeight;
        return new THREE.Vector3(x, y + FILL_LIFT, z);
      };
      const ix0 = c.x0 + (1 - CELL_INSET) / 2 * (c.x1 - c.x0);
      const ix1 = c.x1 - (1 - CELL_INSET) / 2 * (c.x1 - c.x0);
      const iz0 = c.z0 + (1 - CELL_INSET) / 2 * (c.z1 - c.z0);
      const iz1 = c.z1 - (1 - CELL_INSET) / 2 * (c.z1 - c.z0);
      const a = corner(ix0, iz0);
      const b = corner(ix1, iz0);
      const cc = corner(ix1, iz1);
      const dd = corner(ix0, iz1);
      const geom = this.trackGeom(entry, new THREE.BufferGeometry());
      geom.setAttribute('position', new THREE.Float32BufferAttribute([
        a.x, a.y, a.z, b.x, b.y, b.z, cc.x, cc.y, cc.z,
        a.x, a.y, a.z, cc.x, cc.y, cc.z, dd.x, dd.y, dd.z,
      ], 3));
      const mesh = new THREE.Mesh(geom, fillMat);
      mesh.renderOrder = FILL_ORDER;
      entry.group.add(mesh);
    }
  }

  private drawRings(entry: Entry, rings: readonly PlanRing[], ctx: TacticalOverlayContext, color: THREE.Color, ceilingY: number): void {
    if (rings.length === 0) return;
    const mat = this.trackMat(entry, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false }), 0.85);
    const pts: number[] = [];
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!;
        const b = ring[(i + 1) % ring.length]!;
        pts.push(a.x, this.surfaceY(ctx, a.x, a.z, ceilingY) + OUTLINE_LIFT, a.z);
        pts.push(b.x, this.surfaceY(ctx, b.x, b.z, ceilingY) + OUTLINE_LIFT, b.z);
      }
    }
    const geom = this.trackGeom(entry, new THREE.BufferGeometry());
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const lines = new THREE.LineSegments(geom, mat);
    lines.renderOrder = OUTLINE_ORDER;
    entry.group.add(lines);
  }

  private buildPill(entry: Entry, d: MeasureDisplay, color: THREE.Color, mode: AtlasMeasureMode): void {
    // Area/ranges/aura pills are added by their builders; the ruler adds its own.
    // This hook exists so a display with no geometry still gets a readout.
    if (entry.pills.length > 0) return;
    const tip = d.points[d.points.length - 1] ?? d.points[0] ?? [0, 0, 0];
    this.addPill(entry, tip, d.label, d.subLabel, color, d.pinned === true, mode === 'ranges', d.tokenIds);
  }

  private addPill(
    entry: Entry,
    at: Vec3,
    main: string,
    sub: string | undefined,
    color: THREE.Color,
    pinned: boolean,
    isRanges: boolean,
    tokenIds?: readonly string[],
  ): void {
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
    if (pinned && this.onUnpin && !isRanges) {
      const close = pill.createEl('button', { cls: 'atlas3d-tactical-close', text: '×', attr: { title: 'Remove measurement' } });
      close.addEventListener('pointerdown', (e) => e.stopPropagation());
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onUnpin?.(entry.id);
      });
    }
    entry.pills.push({ el: pill, worldPos: new THREE.Vector3(at[0], at[1] + 0.35, at[2]) });
  }

  // ---- LoS builder ---------------------------------------------------------------------------

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
    const overallColor = spec.status === 'clear' ? 0x22c55e : spec.status === 'partial' ? 0xfacc15 : 0xef4444;

    const addPole = (p: Vec3, color: number): void => {
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(p[0], p[1] + 0.02, p[2]),
        new THREE.Vector3(p[0], p[1] + 1.0, p[2]),
      ]);
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.75, depthTest: false }));
      line.renderOrder = 14;
      this.losGroup.add(line);

      const ring = new THREE.LineSegments(
        this.ringLineGeom,
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false }),
      );
      ring.position.set(p[0], p[1] + 0.03, p[2]);
      ring.scale.setScalar(0.36);
      ring.renderOrder = 14;
      this.losGroup.add(ring);
    };

    addPole(spec.origin, 0x38bdf8);
    addPole(spec.target, overallColor);

    for (const ray of spec.rays) {
      const startVec = new THREE.Vector3(...ray.start);
      const endVec = new THREE.Vector3(...ray.end);

      if (!ray.blocked || !ray.hitPoint) {
        const rayColor = spec.status === 'clear' ? 0x22c55e : 0xfacc15;
        const g = new THREE.BufferGeometry().setFromPoints([startVec, endVec]);
        const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: rayColor, transparent: true, opacity: 0.95, depthTest: false }));
        line.renderOrder = 15;
        this.losGroup.add(line);
      } else {
        const hitVec = new THREE.Vector3(...ray.hitPoint);
        const clearPart = new THREE.BufferGeometry().setFromPoints([startVec, hitVec]);
        const clearLine = new THREE.Line(clearPart, new THREE.LineBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.85, depthTest: false }));
        clearLine.renderOrder = 15;
        this.losGroup.add(clearLine);

        const blockedPart = new THREE.BufferGeometry().setFromPoints([hitVec, endVec]);
        const blockedLine = new THREE.Line(
          blockedPart,
          new THREE.LineDashedMaterial({ color: 0xef4444, transparent: true, opacity: 0.75, dashSize: 0.14, gapSize: 0.08, depthTest: false }),
        );
        blockedLine.computeLineDistances();
        blockedLine.renderOrder = 15;
        this.losGroup.add(blockedLine);

        const marker = new THREE.Mesh(
          this.hitGeom,
          new THREE.MeshBasicMaterial({ color: 0xef4444, depthTest: false }),
        );
        marker.position.copy(hitVec);
        marker.renderOrder = 16;
        this.losGroup.add(marker);
      }
    }

    const pill = this.labelLayer.createDiv({ cls: `atlas3d-tactical-pill atlas3d-los-pill is-${spec.status}` });
    pill.createSpan({ cls: 'atlas3d-tactical-main', text: spec.label });
    if (spec.locked) pill.createSpan({ cls: 'atlas3d-tactical-sub', text: 'Locked (click to reset)' });
    this.losPill = {
      el: pill,
      worldPos: new THREE.Vector3(spec.target[0], spec.target[1] + 1.28, spec.target[2]),
    };
  }
}

function farthestPoint(rings: readonly PlanRing[]): PlanPoint | null {
  let best: PlanPoint | null = null;
  let bestDist = -1;
  for (const ring of rings) {
    for (const p of ring) {
      const dist = Math.hypot(p.x, p.z);
      if (dist > bestDist) {
        bestDist = dist;
        best = p;
      }
    }
  }
  return best;
}