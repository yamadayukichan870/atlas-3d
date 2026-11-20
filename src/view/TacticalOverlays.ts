import * as THREE from 'three';
import type { BlockMap } from '../terrain/blocks';
import type { Layout } from '../terrain/layout';
import type { AoEShape } from '../terrain/raycast';
import { quarterOf, surfaceFraction, type Vec3 } from '../terrain/shapes';
import type { AreaCell, AreaTokenTarget, PlanRing } from '../terrain/measureGeometry';
import {
  regionFromActive, regionFromKept,
  type MeasureRegion, type RegionContext, type WorldPoint,
} from '../terrain/measureRegion';
import { volumeOfArea, volumeOfAura, type VolumeSpec } from '../terrain/measureVolume';
import { buildShell, type Shell } from './measureShells';
import {
  buildEffectFill, readMeasureEffect, MEASURE_EFFECT_STARTS,
  type EffectFill, type MeasureEffect,
} from './measureEffects';
import {
  DEFAULT_AREA_CELL_RULE, DEFAULT_CONE_ANGLE, DEFAULT_CONE_END, DEFAULT_DIAGONAL_RULE,
  DEFAULT_LINE_WIDTH_CELLS, NO_MOVEMENT_RULES,
  type AtlasMeasureMode, type AtlasMeasurementSettings, type MovementRules,
} from '../atlas/measureRules';
import type { AtlasMeasure } from '../atlas/types';
import { PILL_COLOR_VAR, resolveColorHex, resolveMeasureColor } from '../common/colors';

/**
 * Draws what the measurement engine returns, and nothing it does not.
 *
 * THE BODY IS ATLAS' AreaBody.draw(), layer for layer (verified @ tag 0.16.0):
 *   - with NO effect: wash 0.12 over the whole area, cell tint 0.16 inset on each covered cell,
 *     outline 0.9 inside its edge.
 *   - WITH an effect: the effect mesh REPLACES the wash and lies UNDER the cell tint and the
 *     outline; the cell tint (0.16) and the outline (0.9) STILL draw on top, so the cells read as
 *     cells over the fire / ice / smoke. No wash, and no volume shell, while an effect is present.
 * The effect mesh is exactly the area's outline polygon (measureEffects.buildEffectFill), so it
 * cannot bleed past the border.
 *
 * THE HANDLES ARE ATLAS' OWN (measureHandle.ts): origin badge r10 glyph12 with the shape as glyph,
 * far dot r6; hover x1.12 drag x1.2; ring in the measure's readable colour; accent ring while its
 * popover is open. Origin opens Atlas' popover; the far end ONLY resizes.
 *
 * A DRAG SURVIVES A REBUILD: it carries its own geometry and re-points at the new knob.
 * THE BADGE FOLLOWS THE CAMERA: rim offset rotated by azimuth so it stays lower-left on screen.
 * THE BORDER IS CELL-LOCKED: each edge takes its own cell's height; risers on height steps.
 *
 * Render ladder: terrain 0, water 1, grid 2, numbers 3, token art 3-5.
 * Effect 2.4, wash 2.4, cells 2.5, riser 2.55, border 2.6, glow 2.2, shell 6, wire 7,
 * ruler drop 13, path 14, nodes 15, LoS 14-16.
 */
export interface MeasureLeg { readonly label: string; readonly at: Vec3 }
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
  effect?: string | null;
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
  start: Vec3; end: Vec3; blocked: boolean; hitPoint: Vec3 | null;
}
export interface LosDisplay {
  origin: Vec3; target: Vec3;
  status: 'clear' | 'partial' | 'blocked';
  rays: readonly [LosRayDisplay, LosRayDisplay, LosRayDisplay];
  label: string; locked: boolean;
}
export interface TacticalOverlayContext {
  layout: Layout; map: BlockMap; maxLayer: number;
  gridSize?: number;
  rules?: AtlasMeasurementSettings;
  movement?: MovementRules;
  tokens?: readonly AreaTokenTarget[];
  selectedIds?: readonly string[];
  speed?: number | null;
  snapToGrid?: boolean;
  lifts?: Readonly<Record<string, number>>;
}
export interface MeasureResize { readonly id: string; readonly cells: number; readonly free: boolean }

interface PillEntry { el: HTMLElement; worldPos: THREE.Vector3 }
interface HandleEntry {
  el: HTMLElement; ring: HTMLElement; worldPos: THREE.Vector3;
  part: 'origin' | 'end'; hex: string;
  bearer: { x: number; z: number } | null; rim: { x: number; z: number } | null;
  anchor: { x: number; z: number }; direction: { x: number; z: number };
  offset: number; planeY: number; start: number;
}
interface DragState {
  readonly id: string;
  readonly anchor: { x: number; z: number };
  readonly direction: { x: number; z: number };
  readonly offset: number; readonly planeY: number;
  last: number; readonly hex: string;
  el: HTMLElement | null; ring: HTMLElement | null;
}
interface GlowState { mat: THREE.MeshBasicMaterial; blocked: boolean; flick: boolean }
interface Entry {
  id: string; group: THREE.Group;
  pills: PillEntry[]; handles: HandleEntry[];
  geoms: THREE.BufferGeometry[]; mats: THREE.Material[]; insts: THREE.InstancedMesh[];
  shell: Shell | null; fx: EffectFill | null; glow: GlowState | null;
  signature: string; fadeStart: number | null;
  baseOpacity: Map<THREE.Material, number>;
}
interface BorderEdge {
  readonly ax: number; readonly az: number; readonly bx: number; readonly bz: number;
  readonly cell: AreaCell; readonly nx: number; readonly nz: number;
}
interface Anchors {
  readonly top: { x: number; z: number } | null;
  readonly config: { x: number; z: number } | null;
  readonly end: { x: number; z: number } | null;
  readonly centre: { x: number; z: number };
  readonly direction: { x: number; z: number };
  readonly bearer: AreaTokenTarget | null;
  readonly rim: { x: number; z: number } | null;
  readonly offset: number; readonly reach: number; readonly resizable: boolean;
}

const WASH_OPACITY = 0.12;
const CELL_OPACITY = 0.16;
const BORDER_OPACITY = 0.9;
const CELL_INSET = 0.025;
const MIN_CELL_INSET = 0.02;
const BORDER_WIDTH_SHARE = 1 / 28;
const MIN_BORDER_WIDTH = 0.04;
const WASH_ORDER = 2.4;
const FILL_ORDER = 2.5;
const RISER_ORDER = 2.55;
const BORDER_ORDER = 2.6;
const GLOW_ORDER = 2.2;
const DROP_ORDER = 13;
const PATH_ORDER = 14;
const NODE_ORDER = 15;
const FILL_LIFT = 0.021;
const WASH_LIFT = 0.018;
const BORDER_LIFT = 0.028;
const PATH_LIFT = 0.04;
const RISER_INSET = 0.35;
const RISER_EPSILON = 0.02;
const RISER_OPACITY = 0.42;
const FADE_MS = 2000;
const HANDLE_RADIUS = 10;
const HANDLE_GLYPH = 12;
const HANDLE_HIT = 12;
const END_RADIUS = 6;
const END_HIT = 9;
const HOVER_LIFT = 1.12;
const DRAG_LIFT = 1.2;
const BADGE_DIRECTION = { x: -Math.SQRT1_2, z: Math.SQRT1_2 };
const BADGE_STEP = Math.PI / 5;
const HANDLE_RIGHT = { x: 1, z: 0 };
const OUTLINE_UP = { x: 0, z: -1 };
const LEAST_FREE_REACH = 0.5;
const RIM_ROOM = 0.01;
const SHAPE_GLYPH: Record<string, string> = {
  ruler: 'M4 18 18 4M6 16l2 2M9 13l2 2M12 10l2 2M15 7l2 2',
  circle: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z',
  cone: 'M12 4 20 19H4L12 4Z',
  square: 'M5 5h14v14H5z',
  line: 'M4 9h16v6H4z',
  ranges: 'M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0',
};
const LEGACY_MODE: Record<AoEShape, AtlasMeasureMode> = {
  line: 'ruler', sphere: 'circle', cone: 'cone', cube: 'square',
};
const FALLBACK_RULES: AtlasMeasurementSettings = {
  mode: 'metric', unitType: 'feet', unitDistance: 5, ruleDistance: 5,
  diagonalRule: DEFAULT_DIAGONAL_RULE, difficultTerrain: 'none', rangeBands: [],
  coneAngle: DEFAULT_CONE_ANGLE, areaCellRule: DEFAULT_AREA_CELL_RULE, coneEnd: DEFAULT_CONE_END,
};

let glowTex: THREE.Texture | null = null;
function radialGlow(): THREE.Texture {
  if (glowTex) return glowTex;
  const N = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const g = cv.getContext('2d')!;
  const grd = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.22, 'rgba(255,244,214,.72)');
  grd.addColorStop(0.55, 'rgba(255,226,168,.26)');
  grd.addColorStop(1, 'rgba(255,210,140,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, N, N);
  glowTex = new THREE.CanvasTexture(cv);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}
function flickerVal(on: boolean, t: number): number {
  if (!on) return 1;
  return 0.82 + 0.18 * Math.sin(t * 11.3) + 0.1 * Math.sin(t * 23.7);
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
const heightBucket = (y: number): number => Math.round(y * 1000);
const cellKey = (cx: number, cz: number): string => `${cx},${cz}`;
const cornerKey = (x: number, z: number): string => `${Math.round(x * 1e6)},${Math.round(z * 1e6)}`;
const spaceRadius = (t: Pick<AreaTokenTarget, 'diameter'>): number => Math.max(1, t.diameter) / 2;
function fittedReach(cells: number, free: boolean): number {
  if (free) return Math.max(LEAST_FREE_REACH, Math.round(cells * 10) / 10);
  return Math.max(1, Math.round(cells));
}
function rimOffset(diameter: number, place: number): { x: number; z: number } {
  const rim = Math.max(1, diameter) / 2;
  const cos = Math.cos(place * BADGE_STEP);
  const sin = Math.sin(place * BADGE_STEP);
  return {
    x: (BADGE_DIRECTION.x * cos - BADGE_DIRECTION.z * sin) * rim,
    z: (BADGE_DIRECTION.x * sin + BADGE_DIRECTION.z * cos) * rim,
  };
}
function tokenHolding(p: { x: number; z: number }, tokens: readonly AreaTokenTarget[]): AreaTokenTarget | null {
  for (const t of tokens) {
    if (!Number.isFinite(t.x) || !Number.isFinite(t.z)) continue;
    const reach = spaceRadius(t) - RIM_ROOM;
    const dx = p.x - t.x, dz = p.z - t.z;
    if (reach > 0 && dx * dx + dz * dz < reach * reach) return t;
  }
  return null;
}
function handleDirection(points: readonly WorldPoint[] | undefined): { x: number; z: number } {
  const from = points?.[0], to = points?.[1];
  if (!from || !to) return HANDLE_RIGHT;
  const x = to[0] - from[0], z = to[2] - from[2];
  const len = Math.hypot(x, z);
  return len > 0 && Number.isFinite(len) ? { x: x / len, z: z / len } : HANDLE_RIGHT;
}
function outlinePointAt(rings: readonly PlanRing[], dir: { x: number; z: number }, centre: { x: number; z: number }): { x: number; z: number } | null {
  let best: { x: number; z: number } | null = null;
  let bestDot = -Infinity;
  for (const ring of rings) for (const p of ring) {
    const dot = (p.x - centre.x) * dir.x + (p.z - centre.z) * dir.z;
    if (dot > bestDot) { bestDot = dot; best = { x: p.x, z: p.z }; }
  }
  return best;
}
function ringsCentre(rings: readonly PlanRing[]): { x: number; z: number } {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const r of rings) for (const p of r) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.z < z0) z0 = p.z;
    if (p.z > z1) z1 = p.z;
  }
  if (!Number.isFinite(x0)) return { x: 0, z: 0 };
  return { x: (x0 + x1) / 2, z: (z0 + z1) / 2 };
}
function readableTint(hex: string): string {
  const c = new THREE.Color(hex);
  const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  if (lum >= 0.42) return hex;
  c.lerp(new THREE.Color(0xffffff), 0.42 - lum + 0.18);
  return `#${c.getHexString()}`;
}
function rawColorOf(d: MeasureDisplay): string | null {
  if (d.colorHex !== undefined) return d.colorHex;
  if (typeof d.color === 'number') return `#${d.color.toString(16).padStart(6, '0')}`;
  return null;
}
function regionSignature(region: MeasureRegion, ctxKey: string): string {
  return JSON.stringify([
    ctxKey, region.mode, region.label, region.subLabel ?? null, region.color,
    region.pinned, region.hidden, region.cells.length,
    region.cells.map((c) => [c.cx, c.cz, heightBucket(c.y)]),
    region.path, region.rings.map((r) => [r.label, r.color, r.outline.length]),
    region.tokenIds, region.legs.map((l) => [l.label, l.at]),
    region.follows ?? null, region.aura ?? null,
  ]);
}
function contextKey(ctx: TacticalOverlayContext): string {
  const r = ctx.rules;
  return JSON.stringify([
    ctx.maxLayer, ctx.map.layerHeight, ctx.gridSize ?? 1, ctx.snapToGrid !== false,
    r ? [r.diagonalRule, r.areaCellRule, r.coneAngle, r.coneEnd, r.unitDistance, r.mode, r.rangeBands] : null,
    ctx.movement?.steps.map((s) => [s.name, s.multiple, s.color]) ?? null,
    ctx.speed ?? null,
    ctx.tokens?.map((t) => [t.id, t.x, t.z, t.diameter]) ?? null,
    ctx.selectedIds ?? null,
  ]);
}

export class TacticalOverlays {
  readonly group = new THREE.Group();
  onSelectTokens: ((ids: readonly string[]) => void) | null = null;
  onMeasureResize: ((change: MeasureResize) => void) | null = null;
  onOpenMeasurePopover: ((id: string) => void) | null = null;
  private readonly measureGroup = new THREE.Group();
  private readonly losGroup = new THREE.Group();
  private readonly labelLayer: HTMLElement;
  private readonly host: HTMLElement;
  private readonly nodeGeom = new THREE.SphereGeometry(0.1, 12, 10);
  private readonly hitGeom = new THREE.SphereGeometry(0.13, 12, 10);
  private readonly cellQuadGeom = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  private readonly glowQuadGeom = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  private readonly ringLineGeom = createCircleRingGeometry();
  private readonly entries = new Map<string, Entry>();
  private losPill: PillEntry | null = null;
  private onUnpin: ((id: string) => void) | null = null;
  private camera: THREE.Camera | null = null;
  private azimuth = 0;
  private readonly ray = new THREE.Raycaster();
  private readonly dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly ndc = new THREE.Vector2();
  private readonly scratch = new THREE.Vector3();
  private drag: DragState | null = null;
  private dragAbort: AbortController | null = null;
  private readonly life = new AbortController();
  private openId: string | null = null;
  private snapToGrid = true;
  private readonly shapes = new Map<string, string>();
  private readonly effects = new Map<string, string | null>();
  private readonly volumes = new Map<string, VolumeSpec>();

  constructor(host: HTMLElement, onUnpin?: (id: string) => void) {
    this.host = host;
    this.onUnpin = onUnpin ?? null;
    this.group.add(this.measureGroup, this.losGroup);
    this.labelLayer = host.createDiv({ cls: 'atlas3d-tactical-layer' });
    const { signal } = this.life;
    host.win.addEventListener('pointerdown', () => this.setOpenPopover(null), { signal });
    host.win.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') this.setOpenPopover(null); }, { signal });
  }
  addTo(scene: THREE.Scene): void { scene.add(this.group); }
  isAnimating(): boolean {
    const now = performance.now();
    for (const e of this.entries.values()) {
      if (e.fx !== null || e.glow !== null) return true;
      if (e.fadeStart !== null && now - e.fadeStart < FADE_MS) return true;
    }
    return false;
  }
  setRegions(active: MeasureRegion | null, pinned: readonly MeasureRegion[], ctx: TacticalOverlayContext | null): void {
    this.volumes.clear(); this.effects.clear();
    this.apply(active, pinned, ctx, new Set(), null);
  }
  setMeasure(active: MeasureDisplay | null, pinned: readonly MeasureDisplay[], ctx: TacticalOverlayContext | null): void {
    if (!ctx) { this.apply(null, [], null, new Set(), null); return; }
    const rctx = this.regionContext(ctx);
    const fading = new Set<string>();
    const points = new Map<string, readonly WorldPoint[]>();
    this.shapes.clear(); this.effects.clear(); this.volumes.clear();
    const convert = (d: MeasureDisplay): MeasureRegion | null => {
      if (d.fading === true) fading.add(d.id);
      const region = this.regionOf(d, rctx);
      if (region) {
        points.set(region.id, d.points as readonly WorldPoint[]);
        this.shapes.set(region.id, modeOf(d));
        this.effects.set(region.id, d.effect ?? null);
        const spec = this.volumeSpecOf(d, region, rctx);
        if (spec) this.volumes.set(region.id, spec);
      }
      return region;
    };
    const pinnedRegions: MeasureRegion[] = [];
    for (const d of pinned) { const r = convert(d); if (r) pinnedRegions.push(r); }
    this.apply(active ? convert(active) : null, pinnedRegions, ctx, fading, points);
  }
  setOpenMeasurePopover(id: string | null): void { this.setOpenPopover(id); }
  setLos(spec: LosDisplay | null): void { this.clearLos(); if (spec) this.buildLos(spec); }
  updateScreenLabels(camera: THREE.Camera, width: number, height: number, azimuthDeg = 0): void {
    this.camera = camera;
    this.azimuth = (azimuthDeg * Math.PI) / 180;
    const t = performance.now() / 1000;
    for (const e of this.entries.values()) {
      if (e.fx) e.fx.setTime(t);
      if (e.glow) e.glow.mat.opacity = e.glow.blocked ? 0 : 0.42 + 0.2 * flickerVal(e.glow.flick, t);
    }
    if (width <= 0 || height <= 0) return;
    const projected = new THREE.Vector3();
    const now = performance.now();
    const place = (el: HTMLElement, worldPos: THREE.Vector3): void => {
      projected.copy(worldPos).project(camera);
      if (projected.z <= -1 || projected.z >= 1) { el.addClass('is-hidden'); return; }
      el.removeClass('is-hidden');
      el.style.left = `${(projected.x * 0.5 + 0.5) * width}px`;
      el.style.top = `${(-projected.y * 0.5 + 0.5) * height}px`;
    };
    for (const entry of this.entries.values()) {
      if (entry.fadeStart !== null) {
        const factor = 1 - Math.min(1, Math.max(0, (now - entry.fadeStart) / FADE_MS));
        for (const [mat, base] of entry.baseOpacity) {
          (mat as THREE.Material & { opacity: number }).opacity = base * factor;
        }
        entry.group.visible = factor > 0;
        if (factor <= 0) {
          for (const p of entry.pills) p.el.addClass('is-hidden');
          for (const h of entry.handles) h.el.addClass('is-hidden');
          continue;
        }
      }
      for (const p of entry.pills) place(p.el, p.worldPos);
      for (const h of entry.handles) { this.turnBadge(h); place(h.el, h.worldPos); }
    }
    if (this.losPill) place(this.losPill.el, this.losPill.worldPos);
  }
  private turnBadge(h: HandleEntry): void {
    if (h.part !== 'origin' || !h.bearer || !h.rim) return;
    const cos = Math.cos(this.azimuth), sin = Math.sin(this.azimuth);
    h.worldPos.x = h.bearer.x + h.rim.x * cos - h.rim.z * sin;
    h.worldPos.z = h.bearer.z + h.rim.x * sin + h.rim.z * cos;
  }
  dispose(): void {
    this.endDrag(); this.life.abort();
    this.clearMeasure(); this.clearLos();
    this.labelLayer.remove();
    this.nodeGeom.dispose(); this.hitGeom.dispose();
    this.cellQuadGeom.dispose(); this.glowQuadGeom.dispose(); this.ringLineGeom.dispose();
  }
  private regionContext(ctx: TacticalOverlayContext): RegionContext {
    return {
      map: ctx.map, layout: ctx.layout, gridSize: ctx.gridSize ?? 1, maxLayer: ctx.maxLayer,
      rules: ctx.rules ?? FALLBACK_RULES, movement: ctx.movement ?? NO_MOVEMENT_RULES,
      tokens: ctx.tokens ?? [], selectedIds: ctx.selectedIds ?? [], speed: ctx.speed ?? null,
    };
  }
  private regionOf(d: MeasureDisplay, rctx: RegionContext): MeasureRegion | null {
    const color = rawColorOf(d);
    const pinned = d.pinned === true;
    if (typeof d.follows === 'string' && d.follows !== '' && typeof d.aura === 'number' && d.aura > 0) {
      const kept: AtlasMeasure = {
        id: d.id, kind: 'measure', shape: 'circle', points: [],
        follows: d.follows, aura: d.aura, ...(color !== null && { color }),
        ...(d.effect != null && { effect: d.effect }),
      };
      const region = regionFromKept(kept, rctx);
      return region && { ...region, pinned };
    }
    const width = typeof d.widthCells === 'number' && d.widthCells > 0 ? d.widthCells : DEFAULT_LINE_WIDTH_CELLS;
    const region = regionFromActive(d.id, modeOf(d), d.points as readonly WorldPoint[], width, color, rctx, d.follows ?? null);
    return region && { ...region, pinned };
  }
  private volumeSpecOf(d: MeasureDisplay, region: MeasureRegion, rctx: RegionContext): VolumeSpec | null {
    const rules = rctx.rules;
    const ceiling = Number.isFinite(rctx.maxLayer) ? rctx.maxLayer * rctx.map.layerHeight : Infinity;
    const yAt = (x: number, z: number): number =>
      rctx.map.surfaceHeightAt(x - rctx.layout.originX, z - rctx.layout.originZ, ceiling);
    if (typeof region.follows === 'string' && region.follows !== '' && typeof region.aura === 'number' && region.aura > 0) {
      const bearer = rctx.tokens.find((t) => t.id === region.follows);
      if (!bearer) return null;
      return volumeOfAura(bearer, region.aura, rules, yAt(bearer.x, bearer.z));
    }
    const mode = modeOf(d);
    if (mode === 'ruler' || mode === 'ranges') return null;
    const pts = d.points as readonly WorldPoint[];
    if (pts.length < 2) return null;
    const width = typeof d.widthCells === 'number' && d.widthCells > 0 ? d.widthCells : DEFAULT_LINE_WIDTH_CELLS;
    const o = pts[0]!;
    return volumeOfArea(mode, pts, width, rules, yAt(o[0], o[2]));
  }
  private apply(
    active: MeasureRegion | null, pinned: readonly MeasureRegion[],
    ctx: TacticalOverlayContext | null, fading: ReadonlySet<string>,
    points: ReadonlyMap<string, readonly WorldPoint[]> | null,
  ): void {
    if (!ctx) { this.clearMeasure(); return; }
    this.snapToGrid = ctx.snapToGrid !== false;
    const ctxKey = contextKey(ctx);
    const all = active ? [...pinned, active] : [...pinned];
    const wanted = new Set(all.map((r) => r.id));
    for (const [id, entry] of [...this.entries]) {
      if (!wanted.has(id)) {
        if (this.drag?.id === id) this.endDrag();
        if (this.openId === id) this.openId = null;
        this.disposeEntry(entry);
        this.entries.delete(id);
      }
    }
    const darkCells = new Set<string>();
    for (const r of all) {
      if ((this.effects.get(r.id) ?? null) === 'shadow') {
        for (const c of r.cells) darkCells.add(cellKey(c.cx, c.cz));
      }
    }
    const anchors = this.anchorsFor(all, ctx, points);
    for (const region of all) {
      const a = anchors.get(region.id) ?? null;
      const effect = this.effects.get(region.id) ?? null;
      const sig = regionSignature(region, ctxKey) + JSON.stringify([
        a?.top ?? null, a?.config ?? null, a?.end ?? null, a?.resizable ?? false,
        this.onOpenMeasurePopover !== null, effect, this.volumes.get(region.id) ?? null,
      ]);
      const existing = this.entries.get(region.id);
      if (existing && existing.signature === sig) { this.applyFade(existing, fading.has(region.id)); continue; }
      if (existing) { this.disposeEntry(existing); this.entries.delete(region.id); }
      const entry = this.buildEntry(region, ctx, a, effect, darkCells);
      entry.signature = sig;
      this.applyFade(entry, fading.has(region.id));
      this.entries.set(region.id, entry);
      this.measureGroup.add(entry.group);
      if (this.drag?.id === region.id) this.reattachDrag(entry);
      if (this.openId === region.id) this.lightBadge(entry, true);
    }
  }
  private reattachDrag(entry: Entry): void {
    const drag = this.drag;
    if (!drag) return;
    const knob = entry.handles.find((h) => h.part === 'end');
    if (!knob) { this.endDrag(); return; }
    drag.el = knob.el; drag.ring = knob.ring;
    knob.ring.style.cursor = 'grabbing';
    this.liftHandle(knob.ring, DRAG_LIFT, drag.hex, false);
  }
  private applyFade(entry: Entry, fading: boolean): void {
    if (fading) { if (entry.fadeStart === null) entry.fadeStart = performance.now(); return; }
    entry.fadeStart = null;
    entry.group.visible = true;
    for (const [mat, base] of entry.baseOpacity) {
      (mat as THREE.Material & { opacity: number }).opacity = base;
    }
  }
  private clearMeasure(): void {
    this.endDrag(); this.openId = null;
    this.volumes.clear(); this.effects.clear();
    for (const e of this.entries.values()) this.disposeEntry(e);
    this.entries.clear();
    this.measureGroup.clear();
  }
  private disposeEntry(entry: Entry): void {
    entry.group.removeFromParent();
    entry.shell?.dispose(); entry.shell = null;
    entry.fx?.dispose(); entry.fx = null;
    entry.glow = null;
    for (const g of entry.geoms) g.dispose();
    for (const m of entry.mats) m.dispose();
    for (const i of entry.insts) i.dispose();
    for (const p of entry.pills) p.el.remove();
    for (const h of entry.handles) h.el.remove();
    entry.geoms.length = 0; entry.mats.length = 0; entry.insts.length = 0;
    entry.pills.length = 0; entry.handles.length = 0;
  }
  private trackMat<T extends THREE.Material>(entry: Entry, mat: T, opacity: number): T {
    entry.mats.push(mat); entry.baseOpacity.set(mat, opacity);
    return mat;
  }
  private trackGeom<T extends THREE.BufferGeometry>(entry: Entry, geom: T): T {
    entry.geoms.push(geom); return geom;
  }
  private ceilingOf(ctx: TacticalOverlayContext): number {
    return Number.isFinite(ctx.maxLayer) ? ctx.maxLayer * ctx.map.layerHeight : Infinity;
  }
  private surfaceY(ctx: TacticalOverlayContext, x: number, z: number, ceilingY: number): number {
    return ctx.map.surfaceHeightAt(x - ctx.layout.originX, z - ctx.layout.originZ, ceilingY);
  }
  private buildEntry(
    region: MeasureRegion, ctx: TacticalOverlayContext, a: Anchors | null,
    effectRaw: string | null, darkCells: ReadonlySet<string>,
  ): Entry {
    const entry: Entry = {
      id: region.id, group: new THREE.Group(), pills: [], handles: [],
      geoms: [], mats: [], insts: [], shell: null, fx: null, glow: null,
      signature: '', fadeStart: null, baseOpacity: new Map(),
    };
    const effect: MeasureEffect | undefined = readMeasureEffect(effectRaw);
    const baseColor = region.color ?? (effect ? MEASURE_EFFECT_STARTS[effect].color : null);
    const color = new THREE.Color(resolveMeasureColor(baseColor, this.host));
    const hex = `#${color.getHexString()}`;
    const ceilingY = this.ceilingOf(ctx);

    // The effect mesh replaces the wash and lies UNDER the cell tint and outline (AreaBody).
    const spec = this.volumes.get(region.id) ?? null;
    if (effect && region.outline.length > 0) {
      const origin = spec
        ? (spec.kind === 'dome' ? { x: spec.centre[0], z: spec.centre[2] }
          : spec.kind === 'cone' ? { x: spec.apex[0], z: spec.apex[2] }
          : spec.kind === 'box' ? spec.origin : spec.centre)
        : (a?.centre ?? { x: 0, z: 0 });
      const reach = spec
        ? (spec.kind === 'dome' ? spec.radius : spec.kind === 'cylinder' ? spec.radius : spec.length)
        : (a?.reach ?? 2);
      const towards = spec && (spec.kind === 'cone' || spec.kind === 'box') ? spec.towards : HANDLE_RIGHT;
      let top = -Infinity;
      for (const c of region.cells) if (c.y > top) top = c.y;
      const baseY = Number.isFinite(top) ? top : this.surfaceY(ctx, origin.x, origin.z, ceilingY);
      const fx = buildEffectFill(region.outline, {
        effect, color: hex, layout: ctx.layout, origin, reach, towards, baseY: baseY + FILL_LIFT,
      });
      if (fx) { entry.fx = fx; entry.group.add(fx.group); }
    }

    // Cell tint + outline always; wash only without an effect. No shell while an effect shows.
    const covered = this.drawRegionBody(entry, region, ctx, color, ceilingY, effect !== undefined);

    if (effect && MEASURE_EFFECT_STARTS[effect].light !== null && a) {
      const ox = a.centre.x, oz = a.centre.z;
      const ocx = Math.floor(ox - ctx.layout.originX), ocz = Math.floor(oz - ctx.layout.originZ);
      const blocked = darkCells.has(cellKey(ocx, ocz));
      const gm = this.trackMat(entry, new THREE.MeshBasicMaterial({
        map: radialGlow(), color, transparent: true, opacity: blocked ? 0 : 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }), blocked ? 0 : 0.5);
      const glow = new THREE.Mesh(this.glowQuadGeom, gm);
      const reach = Math.max(1, a.reach || 2);
      glow.scale.set(reach * 2.6, 1, reach * 2.6);
      glow.position.set(ox, this.surfaceY(ctx, ox, oz, ceilingY) + 0.03, oz);
      glow.renderOrder = GLOW_ORDER;
      entry.group.add(glow);
      entry.glow = { mat: gm, blocked, flick: MEASURE_EFFECT_STARTS[effect].light === 'flicker' };
    }

    if (!effect && spec && region.cells.length > 0) {
      const shell = buildShell(spec, color, { ceilingY });
      if (shell) { entry.shell = shell; entry.group.add(shell.group); }
    }
    if (region.path) this.drawPath(entry, region.path, ctx, color, ceilingY);
    for (const ring of region.rings) {
      const ringColor = ring.color ? new THREE.Color(resolveColorHex(ring.color)) : color;
      const mat = this.trackMat(entry, new THREE.MeshBasicMaterial({
        color: ringColor, transparent: true, opacity: BORDER_OPACITY, depthWrite: false, side: THREE.DoubleSide,
      }), BORDER_OPACITY);
      this.drawRingOutline(entry, ring.outline, ctx, mat, ceilingY, covered);
      this.addLabel(entry, ring.labelAt, ring.label, undefined, `#${ringColor.getHexString()}`);
    }
    for (const leg of region.legs) this.addLabel(entry, leg.at, leg.label, undefined, hex);
    let labelAt: WorldPoint;
    if (region.path && region.path.length > 0) labelAt = region.path[region.path.length - 1]!;
    else if (a?.top) labelAt = [a.top.x, this.regionTop(region, ctx, a.top, ceilingY), a.top.z];
    else labelAt = this.fallbackAnchor(region, ctx, ceilingY);
    this.addLabel(entry, labelAt, region.label, region.subLabel, hex);
    if (region.pinned && a?.config && this.onOpenMeasurePopover) {
      this.addOriginBadge(entry, region, a, hex, ceilingY, ctx);
    }
    if (a?.resizable && a.end) this.addEndHandle(entry, region.id, a, hex, ceilingY, ctx);
    return entry;
  }
  private regionTop(region: MeasureRegion, ctx: TacticalOverlayContext, at: { x: number; z: number }, ceilingY: number): number {
    let top = -Infinity;
    for (const c of region.cells) if (c.y > top) top = c.y;
    const ground = this.surfaceY(ctx, at.x, at.z, ceilingY);
    return Number.isFinite(top) ? Math.max(top, ground) : ground;
  }
  private fallbackAnchor(region: MeasureRegion, ctx: TacticalOverlayContext, ceilingY: number): WorldPoint {
    const outer = region.rings[region.rings.length - 1];
    if (outer) return outer.labelAt;
    if (region.cells.length === 0) return [0, 0, 0];
    let sx = 0, sz = 0, top = -Infinity;
    for (const c of region.cells) {
      sx += (c.x0 + c.x1) / 2; sz += (c.z0 + c.z1) / 2;
      if (c.y > top) top = c.y;
    }
    const x = sx / region.cells.length, z = sz / region.cells.length;
    return [x, Math.max(top, this.surfaceY(ctx, x, z, ceilingY)), z];
  }
  private anchorsFor(
    regions: readonly MeasureRegion[], ctx: TacticalOverlayContext,
    points: ReadonlyMap<string, readonly WorldPoint[]> | null,
  ): Map<string, Anchors> {
    const out = new Map<string, Anchors>();
    const tokens = ctx.tokens ?? [];
    const taken = new Map<string, number>();
    const unit = ctx.rules?.unitDistance ?? FALLBACK_RULES.unitDistance;
    for (const region of regions) {
      const path = points?.get(region.id);
      const isAura = typeof region.follows === 'string' && region.follows !== ''
        && typeof region.aura === 'number' && region.aura > 0;
      const originPoint = path?.[0] ?? region.path?.[0] ?? null;
      const bearer = isAura
        ? tokens.find((t) => t.id === region.follows) ?? null
        : (originPoint ? tokenHolding({ x: originPoint[0], z: originPoint[2] }, tokens) : null);
      let place = 0;
      if (bearer) { place = taken.get(bearer.id) ?? 0; taken.set(bearer.id, place + 1); }
      const rim = bearer ? rimOffset(bearer.diameter, place) : null;
      const centre = region.outline.length > 0
        ? ringsCentre(region.outline)
        : (bearer ? { x: bearer.x, z: bearer.z } : { x: originPoint?.[0] ?? 0, z: originPoint?.[2] ?? 0 });
      const direction = handleDirection(path);
      const offset = isAura && bearer ? spaceRadius(bearer) : 0;
      const farPoint = path?.[path.length - 1];
      const areaLength = originPoint && farPoint
        ? Math.hypot(farPoint[0] - originPoint[0], farPoint[2] - originPoint[2]) : 0;
      const reach = isAura ? (region.aura as number) / (unit > 0 ? unit : 1) : areaLength;
      const top = region.outline.length > 0 ? outlinePointAt(region.outline, OUTLINE_UP, centre) : null;
      const end = region.outline.length > 0 ? outlinePointAt(region.outline, direction, centre) : null;
      const config = bearer && rim
        ? { x: bearer.x + rim.x, z: bearer.z + rim.z }
        : (originPoint ? { x: originPoint[0], z: originPoint[2] } : null);
      const resizable = this.onMeasureResize !== null && region.pinned && region.mode !== 'ruler'
        && region.mode !== 'ranges' && end !== null;
      out.set(region.id, { top, config, end, centre, direction, bearer, rim, offset, reach, resizable });
    }
    return out;
  }
  private cellY(ctx: TacticalOverlayContext, c: AreaCell, x: number, z: number): number {
    if (c.slope === undefined) return c.y;
    const q = quarterOf(c.slope.rot);
    const baseX = ctx.layout.originX + c.cx, baseZ = ctx.layout.originZ + c.cz;
    const u = Math.min(1, Math.max(0, x - baseX)), v = Math.min(1, Math.max(0, z - baseZ));
    const midF = surfaceFraction(c.slope.shape, q, (c.x0 + c.x1) / 2 - baseX, (c.z0 + c.z1) / 2 - baseZ);
    return c.y + (surfaceFraction(c.slope.shape, q, u, v) - midF) * ctx.map.layerHeight;
  }
  private borderEdgesOf(cells: readonly AreaCell[]): BorderEdge[] {
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
  /**
   * The body as Atlas' AreaBody.draw(): with an effect the wash is omitted (the effect mesh is
   * already under us) but the cell tint and the outline STILL draw; without one, wash + tint +
   * outline. Risers on height steps either way.
   */
  private drawRegionBody(
    entry: Entry, region: MeasureRegion, ctx: TacticalOverlayContext,
    color: THREE.Color, ceilingY: number, withEffect: boolean,
  ): Map<string, number> {
    const cells = region.cells;
    const corners = new Map<string, number>();
    if (cells.length === 0) return corners;
    const borderMat = this.trackMat(entry, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: BORDER_OPACITY, depthWrite: false, side: THREE.DoubleSide,
    }), BORDER_OPACITY);
    const riserMat = this.trackMat(entry, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: RISER_OPACITY, depthWrite: false, side: THREE.DoubleSide,
    }), RISER_OPACITY);
    const cellMat = this.trackMat(entry, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: CELL_OPACITY, depthWrite: false, side: THREE.DoubleSide,
    }), CELL_OPACITY);
    const washMat = withEffect ? null : this.trackMat(entry, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: WASH_OPACITY, depthWrite: false, side: THREE.DoubleSide,
    }), WASH_OPACITY);
    const groups = new Map<number, AreaCell[]>();
    for (const cell of cells) {
      const key = heightBucket(cell.y);
      const list = groups.get(key);
      if (list) list.push(cell); else groups.set(key, [cell]);
      for (const [x, z] of [[cell.x0, cell.z0], [cell.x1, cell.z0], [cell.x1, cell.z1], [cell.x0, cell.z1]] as const) {
        const ck = cornerKey(x, z);
        const y = this.cellY(ctx, cell, x, z);
        const held = corners.get(ck);
        if (held === undefined || y > held) corners.set(ck, y);
      }
    }
    const washFlats: AreaCell[] = [];
    const tileFlats: AreaCell[] = [];
    const borderPts: number[] = [];
    const riserPts: number[] = [];
    const halfBorder = Math.max(MIN_BORDER_WIDTH, BORDER_WIDTH_SHARE) / 2;
    for (const [, group] of groups) {
      for (const cell of group) {
        if (cell.slope === undefined) {
          if (washMat) washFlats.push(cell);
          tileFlats.push(cell);
        } else {
          if (washMat) this.drapeSlopeCell(entry, cell, ctx, washMat, 0, WASH_LIFT, WASH_ORDER);
          this.drapeSlopeCell(entry, cell, ctx, cellMat, this.insetOf(cell), FILL_LIFT, FILL_ORDER);
        }
      }
      for (const edge of this.borderEdgesOf(group)) {
        this.pushRibbon(borderPts, ctx, edge, halfBorder);
        this.pushRiser(riserPts, ctx, edge, ceilingY, halfBorder);
      }
    }
    if (washMat) this.instanceCells(entry, washFlats, washMat, 0, WASH_LIFT, WASH_ORDER);
    this.instanceCells(entry, tileFlats, cellMat, -1, FILL_LIFT, FILL_ORDER);
    if (riserPts.length > 0) {
      const g = this.trackGeom(entry, new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(riserPts, 3));
      const m = new THREE.Mesh(g, riserMat);
      m.renderOrder = RISER_ORDER;
      entry.group.add(m);
    }
    if (borderPts.length > 0) {
      const g = this.trackGeom(entry, new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(borderPts, 3));
      const m = new THREE.Mesh(g, borderMat);
      m.renderOrder = BORDER_ORDER;
      entry.group.add(m);
    }
    return corners;
  }
  private insetOf(c: AreaCell): number {
    const span = Math.min(c.x1 - c.x0, c.z1 - c.z0);
    return Math.min(Math.max(MIN_CELL_INSET, span * CELL_INSET), span * 0.4);
  }
  private instanceCells(entry: Entry, cells: readonly AreaCell[], mat: THREE.Material, inset: number, lift: number, order: number): void {
    if (cells.length === 0) return;
    const inst = new THREE.InstancedMesh(this.cellQuadGeom, mat, cells.length);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      const by = inset < 0 ? this.insetOf(c) : inset;
      dummy.position.set((c.x0 + c.x1) / 2, c.y + lift, (c.z0 + c.z1) / 2);
      dummy.scale.set(Math.max(0.02, (c.x1 - c.x0) - 2 * by), 1, Math.max(0.02, (c.z1 - c.z0) - 2 * by));
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.renderOrder = order;
    entry.insts.push(inst);
    entry.group.add(inst);
  }
  private pushRibbon(pts: number[], ctx: TacticalOverlayContext, edge: BorderEdge, half: number): void {
    const dx = edge.bx - edge.ax, dz = edge.bz - edge.az;
    const len = Math.hypot(dx, dz);
    if (!(len > 1e-6)) return;
    const ux = dx / len, uz = dz / len;
    const px = -uz * half, pz = ux * half;
    const ax = edge.ax - ux * half, az = edge.az - uz * half;
    const bx = edge.bx + ux * half, bz = edge.bz + uz * half;
    const c = edge.cell;
    const y = (x: number, z: number): number => this.cellY(ctx, c, x, z) + BORDER_LIFT;
    pts.push(
      ax, y(ax, az), az,
      ax + 2 * px, y(ax + 2 * px, az + 2 * pz), az + 2 * pz,
      bx + 2 * px, y(bx + 2 * px, bz + 2 * pz), bz + 2 * pz,
      ax, y(ax, az), az,
      bx + 2 * px, y(bx + 2 * px, bz + 2 * pz), bz + 2 * pz,
      bx, y(bx, bz), bz,
    );
  }
  private pushRiser(pts: number[], ctx: TacticalOverlayContext, edge: BorderEdge, ceilingY: number, half: number): void {
    const c = edge.cell;
    const base = this.cellY(ctx, c, (edge.ax + edge.bx) / 2, (edge.az + edge.bz) / 2);
    const across = this.surfaceY(ctx, ctx.layout.originX + edge.nx + 0.5, ctx.layout.originZ + edge.nz + 0.5, ceilingY);
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
  private drapeSlopeCell(entry: Entry, c: AreaCell, ctx: TacticalOverlayContext, mat: THREE.Material, inset: number, lift: number, order: number): void {
    const x0 = c.x0 + inset, x1 = c.x1 - inset, z0 = c.z0 + inset, z1 = c.z1 - inset;
    if (!(x1 > x0) || !(z1 > z0)) return;
    const corner = (x: number, z: number): THREE.Vector3 => new THREE.Vector3(x, this.cellY(ctx, c, x, z) + lift, z);
    const a = corner(x0, z0), b = corner(x1, z0), d = corner(x1, z1), e = corner(x0, z1);
    const g = this.trackGeom(entry, new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.Float32BufferAttribute([
      a.x, a.y, a.z, b.x, b.y, b.z, d.x, d.y, d.z,
      a.x, a.y, a.z, d.x, d.y, d.z, e.x, e.y, e.z,
    ], 3));
    const m = new THREE.Mesh(g, mat);
    m.renderOrder = order;
    entry.group.add(m);
  }
  private drawRingOutline(entry: Entry, rings: readonly PlanRing[], ctx: TacticalOverlayContext, mat: THREE.Material, ceilingY: number, covered: ReadonlyMap<string, number>): void {
    if (rings.length === 0) return;
    const pts: number[] = [];
    const half = Math.max(MIN_BORDER_WIDTH, BORDER_WIDTH_SHARE) / 2;
    const yAt = (x: number, z: number): number => {
      const held = covered.get(cornerKey(x, z));
      return (held !== undefined ? held : this.surfaceY(ctx, x, z, ceilingY)) + BORDER_LIFT;
    };
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
        const dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        if (!(len > 1e-6)) continue;
        const ux = dx / len, uz = dz / len;
        const px = -uz * half, pz = ux * half;
        pts.push(
          a.x, yAt(a.x, a.z), a.z,
          a.x + 2 * px, yAt(a.x, a.z), a.z + 2 * pz,
          b.x + 2 * px, yAt(b.x, b.z), b.z + 2 * pz,
          a.x, yAt(a.x, a.z), a.z,
          b.x + 2 * px, yAt(b.x, b.z), b.z + 2 * pz,
          b.x, yAt(b.x, b.z), b.z,
        );
      }
    }
    if (pts.length === 0) return;
    const g = this.trackGeom(entry, new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const m = new THREE.Mesh(g, mat);
    m.renderOrder = BORDER_ORDER;
    entry.group.add(m);
  }
  private drawPath(entry: Entry, path: readonly WorldPoint[], ctx: TacticalOverlayContext, color: THREE.Color, ceilingY: number): void {
    if (path.length < 2) return;
    const pathMat = this.trackMat(entry, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false }), 0.95);
    const dropMat = this.trackMat(entry, new THREE.LineDashedMaterial({ color, transparent: true, opacity: 0.5, dashSize: 0.14, gapSize: 0.08, depthTest: false }), 0.5);
    const nodeMat = this.trackMat(entry, new THREE.MeshBasicMaterial({ color, depthTest: false }), 1);
    const g = this.trackGeom(entry, new THREE.BufferGeometry().setFromPoints(path.map((p) => new THREE.Vector3(p[0], p[1] + PATH_LIFT, p[2]))));
    const line = new THREE.Line(g, pathMat);
    line.renderOrder = PATH_ORDER;
    entry.group.add(line);
    for (const p of path) {
      const node = new THREE.Mesh(this.nodeGeom, nodeMat);
      node.position.set(p[0], p[1] + PATH_LIFT, p[2]);
      node.renderOrder = NODE_ORDER;
      entry.group.add(node);
      const groundY = this.surfaceY(ctx, p[0], p[2], ceilingY);
      if (Math.abs(p[1] - groundY) > 0.08) {
        const dg = this.trackGeom(entry, new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(p[0], p[1] + PATH_LIFT, p[2]),
          new THREE.Vector3(p[0], groundY + 0.02, p[2]),
        ]));
        const drop = new THREE.Line(dg, dropMat);
        drop.computeLineDistances();
        drop.renderOrder = DROP_ORDER;
        entry.group.add(drop);
      }
    }
  }
  private addLabel(entry: Entry, at: WorldPoint, main: string, sub: string | undefined, hex: string): void {
    if (main === '') return;
    const el = this.labelLayer.createDiv({ cls: 'atlas3d-tactical-pill atlas3d-measure-label' });
    el.style.setProperty(PILL_COLOR_VAR, hex);
    el.style.pointerEvents = 'none';
    el.style.display = 'inline-flex';
    el.style.alignItems = 'baseline';
    el.style.gap = '5px';
    el.style.padding = '2px 8px';
    el.style.borderRadius = '999px';
    el.style.background = 'var(--background-primary, #1e1e1e)';
    el.style.border = `1px solid ${hex}`;
    el.style.boxShadow = '0 2px 8px -3px rgba(0,0,0,.8)';
    el.style.fontFamily = 'var(--font-monospace, ui-monospace, monospace)';
    el.style.fontSize = '11px';
    el.style.fontWeight = '700';
    el.style.lineHeight = '1.35';
    el.style.color = 'var(--text-normal, #e8e8e8)';
    el.style.whiteSpace = 'nowrap';
    el.createSpan({ cls: 'atlas3d-tactical-main', text: main });
    if (sub) {
      const s = el.createSpan({ cls: 'atlas3d-tactical-sub', text: sub });
      s.style.fontWeight = '400';
      s.style.fontSize = '10px';
      s.style.color = 'var(--text-muted, #9a9a9a)';
    }
    entry.pills.push({ el, worldPos: new THREE.Vector3(at[0], at[1] + 0.06, at[2]) });
  }
  private handleShell(cls: string, radius: number, hit: number, hex: string, title: string): { el: HTMLElement; ring: HTMLElement } {
    const tint = readableTint(hex);
    const el = this.labelLayer.createDiv({
      cls: `atlas3d-measure-handle ${cls}`,
      attr: { role: 'button', tabindex: '0', title, 'aria-label': title },
    });
    const size = Math.max(radius, hit) * 2;
    el.style.pointerEvents = 'auto';
    el.style.position = 'absolute';
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.marginLeft = `${-size / 2}px`;
    el.style.marginTop = `${-size / 2}px`;
    el.style.display = 'grid';
    el.style.placeItems = 'center';
    el.style.background = 'transparent';
    el.style.border = '0';
    el.style.padding = '0';
    const ring = el.createDiv();
    ring.style.width = `${radius * 2}px`;
    ring.style.height = `${radius * 2}px`;
    ring.style.borderRadius = '50%';
    ring.style.boxSizing = 'border-box';
    ring.style.display = 'grid';
    ring.style.placeItems = 'center';
    ring.style.background = 'var(--background-primary, #1e1e1e)';
    ring.style.border = `2px solid ${tint}`;
    ring.style.boxShadow = '0 1px 5px -1px rgba(0,0,0,.85)';
    ring.style.transition = 'transform .12s, box-shadow .12s';
    return { el, ring };
  }
  private liftHandle(ring: HTMLElement, scale: number, hex: string, open: boolean): void {
    ring.style.transform = `scale(${scale})`;
    ring.style.boxShadow = open
      ? `0 1px 5px -1px rgba(0,0,0,.85), 0 0 0 2px var(--interactive-accent, ${hex})`
      : '0 1px 5px -1px rgba(0,0,0,.85)';
  }
  private lightBadge(entry: Entry, open: boolean): void {
    const badge = entry.handles.find((h) => h.part === 'origin');
    if (badge) this.liftHandle(badge.ring, 1, badge.hex, open);
  }
  private setOpenPopover(id: string | null): void {
    if (this.openId === id) return;
    const previous = this.openId;
    this.openId = id;
    if (previous !== null) { const before = this.entries.get(previous); if (before) this.lightBadge(before, false); }
    if (id !== null) { const now = this.entries.get(id); if (now) this.lightBadge(now, true); }
  }
  private addOriginBadge(entry: Entry, region: MeasureRegion, a: Anchors, hex: string, ceilingY: number, ctx: TacticalOverlayContext): void {
    if (!a.config) return;
    const shape = this.shapes.get(region.id) ?? region.mode;
    const { el, ring } = this.handleShell('is-origin', HANDLE_RADIUS, HANDLE_HIT, hex, 'Measurement options');
    ring.style.cursor = 'pointer';
    const glyph = ring.createDiv();
    glyph.style.width = `${HANDLE_GLYPH}px`;
    glyph.style.height = `${HANDLE_GLYPH}px`;
    glyph.style.color = 'var(--text-normal, #e8e8e8)';
    glyph.style.display = 'grid';
    glyph.style.placeItems = 'center';
    glyph.innerHTML = `<svg width="${HANDLE_GLYPH}" height="${HANDLE_GLYPH}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="${SHAPE_GLYPH[shape] ?? SHAPE_GLYPH.square}"/></svg>`;
    const y = this.regionTop(region, ctx, a.config, ceilingY);
    const handle: HandleEntry = {
      el, ring, worldPos: new THREE.Vector3(a.config.x, y + BORDER_LIFT, a.config.z),
      part: 'origin', hex,
      bearer: a.bearer ? { x: a.bearer.x, z: a.bearer.z } : null,
      rim: a.rim,
      anchor: a.bearer ? { x: a.bearer.x, z: a.bearer.z } : a.centre,
      direction: a.direction, offset: a.offset, planeY: y + BORDER_LIFT, start: a.reach,
    };
    const open = (e: Event): void => {
      e.stopPropagation(); e.preventDefault();
      this.setOpenPopover(region.id);
      this.onOpenMeasurePopover?.(region.id);
    };
    el.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => { const ke = e as KeyboardEvent; if (ke.key === 'Enter' || ke.key === ' ') open(e); });
    el.addEventListener('pointerenter', () => { if (this.openId !== region.id) this.liftHandle(ring, HOVER_LIFT, hex, false); });
    el.addEventListener('pointerleave', () => { this.liftHandle(ring, 1, hex, this.openId === region.id); });
    entry.handles.push(handle);
  }
  private addEndHandle(entry: Entry, id: string, a: Anchors, hex: string, ceilingY: number, ctx: TacticalOverlayContext): void {
    if (!a.end) return;
    const { el, ring } = this.handleShell('is-end', END_RADIUS, END_HIT, hex, 'Drag to resize (Alt: free size)');
    ring.style.cursor = 'grab';
    const y = this.surfaceY(ctx, a.end.x, a.end.z, ceilingY);
    const handle: HandleEntry = {
      el, ring, worldPos: new THREE.Vector3(a.end.x, y + BORDER_LIFT, a.end.z),
      part: 'end', hex, bearer: null, rim: null,
      anchor: a.bearer ? { x: a.bearer.x, z: a.bearer.z } : a.centre,
      direction: a.direction, offset: a.offset, planeY: y + BORDER_LIFT, start: a.reach,
    };
    el.addEventListener('pointerdown', (e) => this.beginDrag(e, id, handle, hex));
    el.addEventListener('pointerenter', () => { if (this.drag?.el !== el) this.liftHandle(ring, HOVER_LIFT, hex, false); });
    el.addEventListener('pointerleave', () => { if (this.drag?.el !== el) this.liftHandle(ring, 1, hex, false); });
    entry.handles.push(handle);
  }
  private pointerOnPlane(clientX: number, clientY: number, planeY: number): THREE.Vector3 | null {
    const camera = this.camera;
    if (!camera) return null;
    const canvas = this.host.querySelector('canvas.atlas3d-canvas');
    const rect = (canvas ?? this.host).getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, camera);
    this.dragPlane.constant = -planeY;
    return this.ray.ray.intersectPlane(this.dragPlane, this.scratch) ? this.scratch : null;
  }
  private beginDrag(e: PointerEvent, id: string, handle: HandleEntry, hex: string): void {
    if (e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    this.endDrag();
    this.setOpenPopover(null);
    if (!this.pointerOnPlane(e.clientX, e.clientY, handle.planeY)) return;
    this.drag = {
      id, anchor: { x: handle.anchor.x, z: handle.anchor.z },
      direction: { x: handle.direction.x, z: handle.direction.z },
      offset: handle.offset, planeY: handle.planeY, last: handle.start, hex,
      el: handle.el, ring: handle.ring,
    };
    handle.ring.style.cursor = 'grabbing';
    this.liftHandle(handle.ring, DRAG_LIFT, hex, false);
    const win = handle.el.win;
    const abort = new AbortController();
    this.dragAbort = abort;
    const { signal } = abort;
    win.addEventListener('pointermove', (ev) => this.moveDrag(ev), { signal });
    win.addEventListener('pointerup', () => this.endDrag(), { signal });
    win.addEventListener('pointercancel', () => this.endDrag(), { signal });
    win.addEventListener('blur', () => this.endDrag(), { signal });
  }
  private moveDrag(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    e.stopPropagation();
    const world = this.pointerOnPlane(e.clientX, e.clientY, drag.planeY);
    if (!world) return;
    const along = (world.x - drag.anchor.x) * drag.direction.x + (world.z - drag.anchor.z) * drag.direction.z;
    const free = e.altKey || !this.snapToGrid;
    const cells = fittedReach(along - drag.offset, free);
    if (cells === drag.last) return;
    drag.last = cells;
    this.onMeasureResize?.({ id: drag.id, cells, free });
  }
  private endDrag(): void {
    const drag = this.drag;
    if (drag?.ring) { drag.ring.style.cursor = 'grab'; this.liftHandle(drag.ring, 1, drag.hex, false); }
    this.dragAbort?.abort();
    this.dragAbort = null;
    this.drag = null;
  }
  private clearLos(): void {
    for (const child of this.losGroup.children) {
      if (child instanceof THREE.Line || child instanceof THREE.Mesh) {
        if (child.geometry !== this.nodeGeom && child.geometry !== this.hitGeom && child.geometry !== this.ringLineGeom) child.geometry.dispose();
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
        else child.material.dispose();
      }
    }
    this.losGroup.clear();
    if (this.losPill) { this.losPill.el.remove(); this.losPill = null; }
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
      const cg = new THREE.BufferGeometry().setFromPoints([start, hit]);
      const cl = new THREE.Line(cg, new THREE.LineBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.85, depthTest: false }));
      cl.renderOrder = 15;
      this.losGroup.add(cl);
      const bg = new THREE.BufferGeometry().setFromPoints([hit, end]);
      const bl = new THREE.Line(bg, new THREE.LineDashedMaterial({ color: 0xef4444, transparent: true, opacity: 0.75, dashSize: 0.14, gapSize: 0.08, depthTest: false }));
      bl.computeLineDistances();
      bl.renderOrder = 15;
      this.losGroup.add(bl);
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