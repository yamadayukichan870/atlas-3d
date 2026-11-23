import * as THREE from 'three';
import type { BlockMap } from '../terrain/blocks';
import type { Layout } from '../terrain/layout';
import type { AoEShape } from '../terrain/raycast';
import { quarterOf, surfaceFraction, type Vec3 } from '../terrain/shapes';
import type { AreaCell, AreaTokenTarget, PlanPoint, PlanRing } from '../terrain/measureGeometry';
import {
  regionFromActive, regionFromKept,
  type MeasureRegion, type RegionContext, type WorldPoint,
} from '../terrain/measureRegion';
import { volumeOfArea, volumeOfAura, type VolumeSpec } from '../terrain/measureVolume';
import {
  buildEffectFill, readMeasureEffect, MEASURE_EFFECT_STARTS, EffectClock,
  type EffectFill, type MeasureEffect,
} from './measureEffects';
import {
  DEFAULT_AREA_CELL_RULE, DEFAULT_CONE_ANGLE, DEFAULT_CONE_END, DEFAULT_DIAGONAL_RULE,
  DEFAULT_LINE_WIDTH_CELLS, NO_MOVEMENT_RULES,
  type AtlasMeasureMode, type AtlasMeasurementSettings, type MovementRules,
} from '../atlas/measureRules';
import { atlasModeOf, atlasModeOfLegacy, isLegacyShape } from '../atlas/measureVocabulary';
import type { AtlasMeasure } from '../atlas/types';
import {
  PILL_COLOR_VAR, badgeInk, canvasBadgeTheme, measureRingColor,
  resolveColorHex, resolveMeasureColor,
} from '../common/colors';

/**
 * Draws what the measurement engine returns, and nothing it does not.
 *
 * THE BODY IS ATLAS' AreaBody.draw(), layer for layer: wash 0.12 edge-to-edge, cell tint 0.16
 * inset max(1px, cell×0.025), outline 0.9 at max(2px, cell/28). With an effect the effect mesh
 * REPLACES the wash and lies UNDER the tint and the outline, which still draw on top.
 *
 * ONE STROKE, ONE COLOUR, ONE PASS. There is no dark casing under anything, and the outline is
 * drawn ONCE for the whole ring — not once per height group. A piece with no covered cell under
 * it used to be skipped by no pass at all and so drawn by every one of them, blending twice.
 *
 * THE OUTLINE IS A CLOSED BAND OF CONSTANT WIDTH, mitred at each vertex. It used to be walked in
 * short pieces whose first and last were prolonged half a width so two edges meeting at a corner
 * would overlap instead of leaving a notch. On a circle every edge is shorter than the walk step,
 * so EVERY piece was prolonged at both ends and overlapped both neighbours; being transparent,
 * the overlap blended twice and the ring read as a chain of darker beads. At a cone's corners the
 * prolongations did not fill the outer wedge either, leaving a notch. A mitred band has neither
 * problem: consecutive pieces share exact vertices, so they tile without overlap or gap, and the
 * mitre closes the corner. Each piece takes the height of its OWNER (the nearest covered cell),
 * never a fresh sample of the column below, which used to stretch a ribbon from floor to roof.
 *
 * THE STROKE'S WIDTH IS ATLAS' OWN: max(2px, grid.size/28) in world pixels, which in cells is
 * max(2/grid.size, 1/28). A fixed 0.04 assumed fifty pixels to a cell; on a map whose cells are
 * larger that drew the outline thicker than Atlas does.
 *
 * THE RULER IS DRAWN IN SCREEN PIXELS, so its width does not change with distance. An END of its
 * path has only one segment and takes that segment's normal at the full half width: running the
 * mitre formula there divides by a zero cosine, clamps to the floor, and made the last point four
 * times wider than the first — the taper. Round caps stand in for its nodes.
 *
 * THE HANDLES ARE ATLAS' OWN: origin badge r10 glyph12 hit12 carrying the measurement's SHAPE;
 * far dot r6 hit9; turn dot r6 hit9 standing 16 screen pixels to the right of the far dot as seen
 * from the origin, and only for a cone, square or line, carrying a turn glyph. Plate in the theme's
 * badge colour, ring in the measurement's colour made readable ON THAT PLATE by WCAG contrast 3.
 *
 * A DRAG SURVIVES A REBUILD and carries its own geometry. THE BADGE FOLLOWS THE CAMERA.
 *
 * Render ladder: terrain 0, water 1, grid 2, numbers 3, token art 3-5.
 * Glow 2.2, effect 2.4, wash 2.4, cells 2.5, riser 2.55, border 2.6,
 * ruler drop 13, ruler stroke 14, LoS 14-16.
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

/** What a drag of a far handle asks for. */
export interface MeasureResize {
  readonly id: string;
  readonly cells: number;
  readonly free: boolean;
  readonly direction?: { x: number; z: number };
}

interface PillEntry { el: HTMLElement; worldPos: THREE.Vector3 }

interface HandleEntry {
  el: HTMLElement; ring: HTMLElement; worldPos: THREE.Vector3;
  part: 'origin' | 'end' | 'turn'; hex: string;
  bearer: { x: number; z: number } | null; rim: { x: number; z: number } | null;
  anchor: { x: number; z: number }; direction: { x: number; z: number };
  offset: number; planeY: number; start: number;
  anchorWorld: THREE.Vector3 | null;
}

interface DragState {
  readonly id: string;
  readonly mode: 'resize' | 'turn';
  readonly anchor: { x: number; z: number };
  direction: { x: number; z: number };
  readonly offset: number; readonly planeY: number;
  readonly heldReach: number;
  last: number; readonly hex: string;
  el: HTMLElement | null; ring: HTMLElement | null;
}

interface GlowState { mat: THREE.MeshBasicMaterial; blocked: boolean; flick: boolean }

/** A ruler's stroke, held in NDC and refilled from the projected path every frame. */
interface RulerStroke {
  readonly path: readonly WorldPoint[];
  readonly mesh: THREE.Mesh;
  readonly attr: THREE.BufferAttribute;
  readonly halfPx: number;
  readonly capPx: number;
}

interface Entry {
  id: string; group: THREE.Group;
  pills: PillEntry[]; handles: HandleEntry[];
  strokes: RulerStroke[];
  geoms: THREE.BufferGeometry[]; mats: THREE.Material[]; insts: THREE.InstancedMesh[];
  fx: EffectFill | null; glow: GlowState | null;
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
  readonly offset: number; readonly reach: number;
  readonly resizable: boolean; readonly turnable: boolean;
}

// ---- the body, exactly as Atlas' BODY constant holds it ---------------------------------------
const WASH_OPACITY = 0.12;
const CELL_OPACITY = 0.16;
const BORDER_OPACITY = 0.9;
const CELL_INSET = 0.025;
const MIN_CELL_INSET = 0.02;
/** Atlas' outline width as a share of a cell, and its floor in world pixels. */
const BORDER_WIDTH_SHARE = 1 / 28;
const BORDER_MIN_PX = 2;
/** Where no grid size is known: Atlas' usual fifty pixels to a cell. */
const FALLBACK_GRID_PX = 50;
const WASH_ORDER = 2.4;
const FILL_ORDER = 2.5;
const RISER_ORDER = 2.55;
const BORDER_ORDER = 2.6;
const GLOW_ORDER = 2.2;
const DROP_ORDER = 13;
const PATH_ORDER = 14;
const FILL_LIFT = 0.021;
const WASH_LIFT = 0.018;
const BORDER_LIFT = 0.028;
const PATH_LIFT = 0.04;
const RISER_INSET = 0.35;
const RISER_EPSILON = 0.02;
const RISER_OPACITY = 0.42;
const FADE_MS = 2000;
/** How finely a band is walked so a height step is met where it happens. */
const BORDER_STEP = 0.25;
const OWNER_REACH = 2;
const GLOW_SPREAD = 2.4;
const GLOW_OPACITY = 0.55;
/** The least a mitre's cosine may be, so a sharp spike does not throw a vertex away. */
const MITRE_COS_FLOOR = 0.25;

// ---- the ruler, in screen pixels ---------------------------------------------------------------
const RULER_HALF_PX = 1;
const RULER_CAP_PX = 3.5;
const CAP_SEGMENTS = 12;

// ---- the handles, exactly as Atlas' measureHandle.ts holds them -------------------------------
const HANDLE_RADIUS = 10;
const HANDLE_GLYPH = 12;
const HANDLE_HIT = 12;
const END_RADIUS = 6;
const END_HIT = 9;
const TURN_RADIUS = 6;
const TURN_HIT = 9;
const TURN_GLYPH = 8;
const TURN_OFFSET = END_RADIUS + TURN_RADIUS + 4;
const HOVER_LIFT = 1.12;
const DRAG_LIFT = 1.2;
const BADGE_DIRECTION = { x: -Math.SQRT1_2, z: Math.SQRT1_2 };
const BADGE_STEP = Math.PI / 5;
const HANDLE_RIGHT = { x: 1, z: 0 };
const OUTLINE_UP = { x: 0, z: -1 };
const LEAST_FREE_REACH = 0.5;
const RIM_ROOM = 0.01;
const EFFECT_FPS = 30;

/** Lucide's own paths, exactly as Atlas' SHAPE_GLYPHS holds them. */
const SHAPE_GLYPH: Readonly<Record<string, readonly string[]>> = {
  ruler: [
    'M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z',
    'm14.5 12.5 2-2', 'm11.5 9.5 2-2', 'm8.5 6.5 2-2', 'm17.5 15.5 2-2',
  ],
  circle: ['M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z'],
  cone: ['M13.73 4a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z'],
  square: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z'],
  line: ['M22 2 2 22'],
  ranges: ['M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0', 'M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0'],
};

/** The turn dot's glyph: Lucide's rotate-cw, sized to fit a radius-6 dot. */
const TURN_GLYPH_PATHS: readonly string[] = [
  'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8',
  'M21 3v5h-5',
];

const FALLBACK_RULES: AtlasMeasurementSettings = {
  mode: 'metric', unitType: 'feet', unitDistance: 5, ruleDistance: 5,
  diagonalRule: DEFAULT_DIAGONAL_RULE, difficultTerrain: 'none', rangeBands: [],
  coneAngle: DEFAULT_CONE_ANGLE, areaCellRule: DEFAULT_AREA_CELL_RULE, coneEnd: DEFAULT_CONE_END,
};

// ---- a stroke held in NDC, so its width is pixels and nothing else -----------------------------
const SCREEN_VERTEX = `
void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const SCREEN_FRAGMENT = `
precision mediump float;
uniform vec3 uColor;
uniform float uOpacity;
void main(){ gl_FragColor = vec4(uColor, uOpacity); }`;

let glowTex: THREE.Texture | null = null;
function radialGlow(): THREE.Texture {
  if (glowTex) return glowTex;
  const N = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const g = cv.getContext('2d')!;
  const grd = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.18, 'rgba(255,246,222,.84)');
  grd.addColorStop(0.42, 'rgba(255,232,182,.44)');
  grd.addColorStop(0.72, 'rgba(255,214,152,.15)');
  grd.addColorStop(1, 'rgba(255,206,140,0)');
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
  d.mode ?? atlasModeOf(d.shape) ?? (isLegacyShape(d.shape) ? atlasModeOfLegacy(d.shape) : 'ruler');

const heightBucket = (y: number): number => Math.round(y * 1000);
const cellKey = (cx: number, cz: number): string => `${cx},${cz}`;
const cornerKey = (x: number, z: number): string => `${Math.round(x * 1e6)},${Math.round(z * 1e6)}`;
const spaceRadius = (t: Pick<AreaTokenTarget, 'diameter'>): number => Math.max(1, t.diameter) / 2;
const plateHex = (n: number): string => `#${(n >>> 0).toString(16).padStart(6, '0')}`;
const plateRgba = (n: number, alpha: number): string =>
  `rgba(${(n >> 16) & 0xff},${(n >> 8) & 0xff},${n & 0xff},${alpha})`;

/** The unit left normal of a plan direction; zero for a direction that is none. */
function leftOf(dx: number, dz: number): { x: number; z: number } {
  const len = Math.hypot(dx, dz);
  return len > 1e-9 ? { x: -dz / len, z: dx / len } : { x: 0, z: 0 };
}

const lerpP = (a: PlanPoint, b: PlanPoint, t: number): PlanPoint =>
  ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });

/**
 * A closed ring's two offset chains, mitred at every vertex, `half` to either side.
 *
 * This is what replaces prolonging each walked piece past its ends. Consecutive pieces of the
 * band share exact vertices, so they tile without overlap and without gap: a transparent stroke
 * never blends twice, and the mitre closes each corner instead of leaving a notch. The cosine is
 * floored so a very sharp spike offsets by at most four half-widths rather than flying away.
 */
function ringBand(ring: PlanRing, half: number): { outer: PlanPoint[]; inner: PlanPoint[] } {
  const n = ring.length;
  const outer: PlanPoint[] = [];
  const inner: PlanPoint[] = [];
  for (let i = 0; i < n; i++) {
    const prev = ring[(i - 1 + n) % n]!;
    const v = ring[i]!;
    const next = ring[(i + 1) % n]!;
    const n1 = leftOf(v.x - prev.x, v.z - prev.z);
    const n2 = leftOf(next.x - v.x, next.z - v.z);
    let mx = n1.x + n2.x, mz = n1.z + n2.z;
    const ml = Math.hypot(mx, mz);
    if (ml > 1e-9) { mx /= ml; mz /= ml; } else { mx = n2.x; mz = n2.z; }
    const cos = Math.max(MITRE_COS_FLOOR, mx * n2.x + mz * n2.z);
    const s = half / cos;
    outer.push({ x: v.x + mx * s, z: v.z + mz * s });
    inner.push({ x: v.x - mx * s, z: v.z - mz * s });
  }
  return { outer, inner };
}

/** Atlas' outline width in cells: max(2px, grid.size/28) world pixels, over the cell's own size. */
function borderWidthOf(gridSize: number | undefined): number {
  const size = typeof gridSize === 'number' && gridSize > 1 ? gridSize : FALLBACK_GRID_PX;
  return Math.max(BORDER_MIN_PX / size, BORDER_WIDTH_SHARE);
}

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

function outlinePointAt(
  rings: readonly PlanRing[], dir: { x: number; z: number }, centre: { x: number; z: number },
): { x: number; z: number } | null {
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
    region.outline.map((r) => r.length),
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

type FadeableFill = EffectFill & { setFade?: (factor: number) => void };

export class TacticalOverlays {
  readonly group = new THREE.Group();
  onSelectTokens: ((ids: readonly string[]) => void) | null = null;
  onMeasureResize: ((change: MeasureResize) => void) | null = null;
  onOpenMeasurePopover: ((id: string) => void) | null = null;

  private readonly measureGroup = new THREE.Group();
  private readonly losGroup = new THREE.Group();
  private readonly labelLayer: HTMLElement;
  private readonly host: HTMLElement;
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
  private readonly pa = new THREE.Vector3();
  private readonly pb = new THREE.Vector3();
  private drag: DragState | null = null;
  private dragAbort: AbortController | null = null;
  private readonly life = new AbortController();
  private openId: string | null = null;
  private snapToGrid = true;
  private readonly shapes = new Map<string, string>();
  private readonly effects = new Map<string, string | null>();
  private readonly volumes = new Map<string, VolumeSpec>();
  private readonly clock = new EffectClock();
  private still = false;

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
      if ((e.fx !== null || e.glow !== null) && !this.still) return true;
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

    const due = this.clock.tick(performance.now(), this.still ? 0 : EFFECT_FPS);
    if (this.still) {
      for (const e of this.entries.values()) e.fx?.setStill(true);
    } else if (due) {
      const t = this.clock.seconds;
      for (const e of this.entries.values()) {
        e.fx?.setTime(t);
        if (e.glow) e.glow.mat.opacity = e.glow.blocked ? 0 : GLOW_OPACITY * (0.84 + 0.16 * flickerVal(e.glow.flick, t));
      }
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
      for (const stroke of entry.strokes) this.fillRulerStroke(stroke, camera, width, height);
      if (entry.fadeStart !== null) {
        const factor = 1 - Math.min(1, Math.max(0, (now - entry.fadeStart) / FADE_MS));
        for (const [mat, base] of entry.baseOpacity) {
          (mat as THREE.Material & { opacity: number }).opacity = base * factor;
        }
        for (const s of entry.strokes) {
          const m = s.mesh.material as THREE.ShaderMaterial;
          const base = entry.baseOpacity.get(m);
          if (base !== undefined) m.uniforms.uOpacity!.value = base * factor;
        }
        (entry.fx as FadeableFill | null)?.setFade?.(factor);
        entry.group.visible = factor > 0;
        if (factor <= 0) {
          for (const p of entry.pills) p.el.addClass('is-hidden');
          for (const h of entry.handles) h.el.addClass('is-hidden');
          continue;
        }
      }
      for (const p of entry.pills) place(p.el, p.worldPos);
      for (const h of entry.handles) { this.turnBadge(h); place(h.el, h.worldPos); }
      this.placeTurnDot(entry, camera, width, height);
    }
    if (this.losPill) place(this.losPill.el, this.losPill.worldPos);
  }

  private turnBadge(h: HandleEntry): void {
    if (h.part !== 'origin' || !h.bearer || !h.rim) return;
    const cos = Math.cos(this.azimuth), sin = Math.sin(this.azimuth);
    h.worldPos.x = h.bearer.x + h.rim.x * cos - h.rim.z * sin;
    h.worldPos.z = h.bearer.z + h.rim.x * sin + h.rim.z * cos;
  }

  private placeTurnDot(entry: Entry, camera: THREE.Camera, width: number, height: number): void {
    const end = entry.handles.find((h) => h.part === 'end');
    const turn = entry.handles.find((h) => h.part === 'turn');
    if (!end || !turn || !turn.anchorWorld) return;
    if (end.el.hasClass('is-hidden')) { turn.el.addClass('is-hidden'); return; }
    this.pa.copy(turn.anchorWorld).project(camera);
    this.pb.copy(end.worldPos).project(camera);
    if (this.pa.z <= -1 || this.pa.z >= 1 || this.pb.z <= -1 || this.pb.z >= 1) {
      turn.el.addClass('is-hidden');
      return;
    }
    const ax = (this.pa.x * 0.5 + 0.5) * width, ay = (-this.pa.y * 0.5 + 0.5) * height;
    const bx = (this.pb.x * 0.5 + 0.5) * width, by = (-this.pb.y * 0.5 + 0.5) * height;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-3)) { turn.el.addClass('is-hidden'); return; }
    turn.el.removeClass('is-hidden');
    turn.el.style.left = `${bx - (dy / len) * TURN_OFFSET}px`;
    turn.el.style.top = `${by + (dx / len) * TURN_OFFSET}px`;
  }

  dispose(): void {
    this.endDrag(); this.life.abort();
    this.clearMeasure(); this.clearLos();
    this.labelLayer.remove();
    this.hitGeom.dispose();
    this.cellQuadGeom.dispose(); this.glowQuadGeom.dispose(); this.ringLineGeom.dispose();
  }

  // ---- displays to regions --------------------------------------------------------------------
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
        follows: d.follows, aura: d.aura,
        ...(color !== null && { color }),
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

  // ---- entries --------------------------------------------------------------------------------
  private apply(
    active: MeasureRegion | null, pinned: readonly MeasureRegion[],
    ctx: TacticalOverlayContext | null, fading: ReadonlySet<string>,
    points: ReadonlyMap<string, readonly WorldPoint[]> | null,
  ): void {
    if (!ctx) { this.clearMeasure(); return; }
    this.snapToGrid = ctx.snapToGrid !== false;
    try {
      this.still = this.host.win.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch { this.still = false; }

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
        a?.top ?? null, a?.config ?? null, a?.end ?? null,
        a?.resizable ?? false, a?.turnable ?? false,
        this.onOpenMeasurePopover !== null, effect, this.volumes.get(region.id) ?? null,
      ]);
      const existing = this.entries.get(region.id);
      if (existing && existing.signature === sig) { this.applyFade(existing, fading.has(region.id)); continue; }
      if (existing) { this.disposeEntry(existing); this.entries.delete(region.id); }

      let entry: Entry;
      try {
        entry = this.buildEntry(region, ctx, a, effect, darkCells);
      } catch (error) {
        console.error('[Atlas 3D] a measurement could not be drawn:', region.id, error);
        continue;
      }
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
    const knob = entry.handles.find((h) => h.part === (drag.mode === 'turn' ? 'turn' : 'end'));
    if (!knob) { this.endDrag(); return; }
    drag.el = knob.el; drag.ring = knob.ring;
    knob.ring.style.cursor = 'grabbing';
    this.liftHandle(knob.ring, DRAG_LIFT, false);
  }

  private applyFade(entry: Entry, fading: boolean): void {
    if (fading) { if (entry.fadeStart === null) entry.fadeStart = performance.now(); return; }
    entry.fadeStart = null;
    entry.group.visible = true;
    for (const [mat, base] of entry.baseOpacity) {
      (mat as THREE.Material & { opacity: number }).opacity = base;
    }
    for (const s of entry.strokes) {
      const m = s.mesh.material as THREE.ShaderMaterial;
      const base = entry.baseOpacity.get(m);
      if (base !== undefined) m.uniforms.uOpacity!.value = base;
    }
    (entry.fx as FadeableFill | null)?.setFade?.(1);
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
    entry.fx?.dispose(); entry.fx = null;
    entry.glow = null;
    entry.strokes.length = 0;
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
      id: region.id, group: new THREE.Group(), pills: [], handles: [], strokes: [],
      geoms: [], mats: [], insts: [], fx: null, glow: null,
      signature: '', fadeStart: null, baseOpacity: new Map(),
    };
    const effect: MeasureEffect | undefined = readMeasureEffect(effectRaw);
    const baseColor = region.color ?? (effect ? MEASURE_EFFECT_STARTS[effect].color : null);
    const color = new THREE.Color(resolveMeasureColor(baseColor, this.host));
    const hex = `#${color.getHexString()}`;
    const ceilingY = this.ceilingOf(ctx);
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
        effect, color: hex, layout: ctx.layout, origin, reach, towards,
        baseY: baseY + FILL_LIFT,
        cells: region.cells,
        layerHeight: ctx.map.layerHeight,
        seed: region.id,
        heightAt: (x, z) => this.surfaceY(ctx, x, z, ceilingY),
      });
      if (fx) {
        entry.fx = fx;
        entry.group.add(fx.group);
        if (this.still) fx.setStill(true); else fx.setTime(this.clock.seconds);
      }
    }

    const covered = this.drawRegionBody(entry, region, ctx, color, ceilingY, effect !== undefined);

    if (effect && MEASURE_EFFECT_STARTS[effect].light !== null && a) {
      const ox = a.centre.x, oz = a.centre.z;
      const ocx = Math.floor(ox - ctx.layout.originX), ocz = Math.floor(oz - ctx.layout.originZ);
      const blocked = darkCells.has(cellKey(ocx, ocz));
      const gm = this.trackMat(entry, new THREE.MeshBasicMaterial({
        map: radialGlow(), color, transparent: true, opacity: blocked ? 0 : GLOW_OPACITY,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }), blocked ? 0 : GLOW_OPACITY);
      const glow = new THREE.Mesh(this.glowQuadGeom, gm);
      const span = Math.max(1, a.reach || 2) * GLOW_SPREAD * 2;
      glow.scale.set(span, 1, span);
      glow.position.set(ox, this.surfaceY(ctx, ox, oz, ceilingY) + 0.03, oz);
      glow.renderOrder = GLOW_ORDER;
      entry.group.add(glow);
      entry.glow = { mat: gm, blocked, flick: MEASURE_EFFECT_STARTS[effect].light === 'flicker' };
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
    if (a?.resizable && a.end) {
      this.addEndHandle(entry, region.id, a, hex, ceilingY, ctx);
      if (a.turnable) this.addTurnHandle(entry, region.id, a, hex, ceilingY, ctx);
    }
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
      const turnable = resizable && region.mode !== 'circle' && reach > 1e-6;
      out.set(region.id, { top, config, end, centre, direction, bearer, rim, offset, reach, resizable, turnable });
    }
    return out;
  }

  // ---- the three-layer body -------------------------------------------------------------------
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

    // The owner of a stroke piece is the NEAREST covered cell, by index and a two-cell spiral:
    // an analytic ring bulges past the cells the rule covers, so the cell under a piece may be
    // none. Its height is what the stroke takes, never the column's highest surface.
    const byKey = new Map<string, AreaCell[]>();
    for (const c of cells) {
      const k = cellKey(c.cx, c.cz);
      const list = byKey.get(k);
      if (list) list.push(c); else byKey.set(k, [c]);
    }
    const ownerAt = (x: number, z: number): AreaCell | null => {
      const gx = Math.floor(x - ctx.layout.originX);
      const gz = Math.floor(z - ctx.layout.originZ);
      for (let r = 0; r <= OWNER_REACH; r++) {
        let best: AreaCell | null = null;
        let bestD = Infinity;
        for (let oz = -r; oz <= r; oz++) {
          for (let ox = -r; ox <= r; ox++) {
            if (Math.max(Math.abs(ox), Math.abs(oz)) !== r) continue;
            const list = byKey.get(cellKey(gx + ox, gz + oz));
            if (!list) continue;
            for (const c of list) {
              const d = Math.hypot((c.x0 + c.x1) / 2 - x, (c.z0 + c.z1) / 2 - z);
              if (d < bestD) { bestD = d; best = c; }
            }
          }
        }
        if (best !== null) return best;
      }
      return null;
    };

    const washFlats: AreaCell[] = [];
    const tileFlats: AreaCell[] = [];
    const riserPts: number[] = [];
    const halfBorder = borderWidthOf(ctx.gridSize) / 2;
    const stepped = (typeof region.follows === 'string' && region.follows !== '')
      || region.mode === 'ranges' || region.mode === 'line';

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
      if (stepped) {
        for (const edge of this.borderEdgesOf(group)) {
          this.pushRiser(riserPts, ctx, edge, ceilingY, halfBorder);
        }
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

    // ONE pass for the whole outline. Per height group, a piece with no owner was skipped by
    // none of them and so drawn by all of them, blending twice and reading thicker.
    const borderPts: number[] = [];
    this.pushShapeBorder(borderPts, ctx, region.outline, ownerAt, ceilingY, halfBorder);
    if (borderPts.length > 0) {
      const g = this.trackGeom(entry, new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(borderPts, 3));
      const m = new THREE.Mesh(g, borderMat);
      m.renderOrder = BORDER_ORDER;
      entry.group.add(m);
    }
    return corners;
  }

  /**
   * The area's outline as a closed band of constant width, mitred at each corner and walked in
   * short pieces so a height step is met where it happens. Consecutive pieces share exact
   * vertices: they tile without overlap and without gap, so a transparent stroke never blends
   * twice and no corner is left with a notch. Each piece is flat at its owner's height.
   */
  private pushShapeBorder(
    pts: number[],
    ctx: TacticalOverlayContext,
    rings: readonly PlanRing[],
    ownerAt: (x: number, z: number) => AreaCell | null,
    ceilingY: number,
    half: number,
  ): void {
    for (const ring of rings) {
      if (ring.length < 3) continue;
      const { outer, inner } = ringBand(ring, half);
      for (let i = 0; i < ring.length; i++) {
        const j = (i + 1) % ring.length;
        const o0 = outer[i]!, o1 = outer[j]!;
        const n0 = inner[i]!, n1 = inner[j]!;
        const span = Math.hypot(o1.x - o0.x, o1.z - o0.z);
        const steps = Math.max(1, Math.ceil(span / BORDER_STEP));
        for (let s = 0; s < steps; s++) {
          const t0 = s / steps, t1 = (s + 1) / steps;
          const oa = lerpP(o0, o1, t0), ob = lerpP(o0, o1, t1);
          const ia = lerpP(n0, n1, t0), ib = lerpP(n0, n1, t1);
          const mx = (oa.x + ob.x + ia.x + ib.x) / 4;
          const mz = (oa.z + ob.z + ia.z + ib.z) / 4;
          const owner = ownerAt(mx, mz);
          const y = (owner !== null
            ? this.cellY(ctx, owner, mx, mz)
            : this.surfaceY(ctx, mx, mz, ceilingY)) + BORDER_LIFT;
          pts.push(
            oa.x, y, oa.z,
            ia.x, y, ia.z,
            ib.x, y, ib.z,
            oa.x, y, oa.z,
            ib.x, y, ib.z,
            ob.x, y, ob.z,
          );
        }
      }
    }
  }

  private insetOf(c: AreaCell): number {
    const span = Math.min(c.x1 - c.x0, c.z1 - c.z0);
    return Math.min(Math.max(MIN_CELL_INSET, span * CELL_INSET), span * 0.4);
  }

  private instanceCells(
    entry: Entry, cells: readonly AreaCell[], mat: THREE.Material,
    inset: number, lift: number, order: number,
  ): void {
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

  private drapeSlopeCell(
    entry: Entry, c: AreaCell, ctx: TacticalOverlayContext, mat: THREE.Material,
    inset: number, lift: number, order: number,
  ): void {
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

  /** A range ring's outline, the same mitred band, on the surfaces the body covers. */
  private drawRingOutline(
    entry: Entry, rings: readonly PlanRing[], ctx: TacticalOverlayContext,
    mat: THREE.Material, ceilingY: number, covered: ReadonlyMap<string, number>,
  ): void {
    if (rings.length === 0) return;
    const half = borderWidthOf(ctx.gridSize) / 2;
    const pts: number[] = [];
    const yAt = (x: number, z: number): number => {
      const held = covered.get(cornerKey(x, z));
      return (held !== undefined ? held : this.surfaceY(ctx, x, z, ceilingY)) + BORDER_LIFT;
    };
    for (const ring of rings) {
      if (ring.length < 3) continue;
      const { outer, inner } = ringBand(ring, half);
      for (let i = 0; i < ring.length; i++) {
        const j = (i + 1) % ring.length;
        const o0 = outer[i]!, o1 = outer[j]!;
        const n0 = inner[i]!, n1 = inner[j]!;
        const y0 = yAt(ring[i]!.x, ring[i]!.z), y1 = yAt(ring[j]!.x, ring[j]!.z);
        pts.push(
          o0.x, y0, o0.z, n0.x, y0, n0.z, n1.x, y1, n1.z,
          o0.x, y0, o0.z, n1.x, y1, n1.z, o1.x, y1, o1.z,
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

  // ---- the ruler, in screen pixels --------------------------------------------------------------
  /**
   * A ruler: one coloured stroke of constant width IN PIXELS, with round caps that stand in for
   * its nodes; and a dashed drop wherever a corner stands above the ground. No casing.
   */
  private drawPath(
    entry: Entry, path: readonly WorldPoint[], ctx: TacticalOverlayContext,
    color: THREE.Color, ceilingY: number,
  ): void {
    if (path.length < 2) return;
    const lifted = path.map((p) => [p[0], p[1] + PATH_LIFT, p[2]] as WorldPoint);
    this.addRulerStroke(entry, lifted, RULER_HALF_PX, RULER_CAP_PX, color, BORDER_OPACITY, PATH_ORDER);

    const dropMat = this.trackMat(entry, new THREE.LineDashedMaterial({
      color, transparent: true, opacity: 0.5, dashSize: 0.14, gapSize: 0.08, depthTest: false,
    }), 0.5);
    for (const p of path) {
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

  private addRulerStroke(
    entry: Entry, path: readonly WorldPoint[], halfPx: number, capPx: number,
    color: THREE.Color, opacity: number, order: number,
  ): void {
    const segments = path.length - 1;
    const verts = segments * 6 + 2 * CAP_SEGMENTS * 3;
    const arr = new Float32Array(verts * 3);
    const attr = new THREE.BufferAttribute(arr, 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    const geom = this.trackGeom(entry, new THREE.BufferGeometry());
    geom.setAttribute('position', attr);
    const mat = this.trackMat(entry, new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Vector3(color.r, color.g, color.b) },
        uOpacity: { value: opacity },
      },
      vertexShader: SCREEN_VERTEX, fragmentShader: SCREEN_FRAGMENT,
      transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    }), opacity);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    entry.group.add(mesh);
    entry.strokes.push({ path, mesh, attr, halfPx, capPx });
  }

  /**
   * Refill one stroke from the projected path, in pixels, written as NDC. There is no perspective
   * term here, so the width is the same at both ends at any zoom, bearing or depth.
   *
   * An END of the path has only one segment and takes that segment's own normal at the full half
   * width. Running the mitre formula there divides by a zero cosine, clamps to the floor, and
   * offsets that point FOUR times as far as the other end — which is what made the ruler a wedge.
   */
  private fillRulerStroke(s: RulerStroke, camera: THREE.Camera, width: number, height: number): void {
    const n = s.path.length;
    const sx: number[] = [];
    const sy: number[] = [];
    let visible = true;
    for (const p of s.path) {
      this.pa.set(p[0], p[1], p[2]).project(camera);
      if (this.pa.z <= -1 || this.pa.z >= 1) visible = false;
      sx.push((this.pa.x * 0.5 + 0.5) * width);
      sy.push((-this.pa.y * 0.5 + 0.5) * height);
    }
    s.mesh.visible = visible;
    if (!visible) return;

    const arr = s.attr.array as Float32Array;
    let at = 0;
    const put = (x: number, y: number): void => {
      arr[at++] = (x / width) * 2 - 1;
      arr[at++] = 1 - (y / height) * 2;
      arr[at++] = 0;
    };

    const lx: number[] = [], ly: number[] = [], rx: number[] = [], ry: number[] = [];
    for (let i = 0; i < n; i++) {
      const pi = Math.max(0, i - 1), ni = Math.min(n - 1, i + 1);
      const d1x = sx[i]! - sx[pi]!, d1y = sy[i]! - sy[pi]!;
      const d2x = sx[ni]! - sx[i]!, d2y = sy[ni]! - sy[i]!;
      const l1 = Math.hypot(d1x, d1y), l2 = Math.hypot(d2x, d2y);
      const has1 = l1 > 1e-6, has2 = l2 > 1e-6;
      let ox = 0, oy = 0;
      if (has1 && has2) {
        const n1x = -d1y / l1, n1y = d1x / l1;
        const n2x = -d2y / l2, n2y = d2x / l2;
        let mx = n1x + n2x, my = n1y + n2y;
        const ml = Math.hypot(mx, my);
        if (ml > 1e-6) {
          mx /= ml; my /= ml;
          const cos = Math.max(MITRE_COS_FLOOR, mx * n2x + my * n2y);
          ox = mx / cos; oy = my / cos;
        } else { ox = n2x; oy = n2y; }
      } else if (has2) {
        ox = -d2y / l2; oy = d2x / l2;
      } else if (has1) {
        ox = -d1y / l1; oy = d1x / l1;
      }
      lx.push(sx[i]! + ox * s.halfPx); ly.push(sy[i]! + oy * s.halfPx);
      rx.push(sx[i]! - ox * s.halfPx); ry.push(sy[i]! - oy * s.halfPx);
    }
    for (let i = 0; i + 1 < n; i++) {
      put(lx[i]!, ly[i]!); put(rx[i]!, ry[i]!); put(rx[i + 1]!, ry[i + 1]!);
      put(lx[i]!, ly[i]!); put(rx[i + 1]!, ry[i + 1]!); put(lx[i + 1]!, ly[i + 1]!);
    }
    for (const end of [0, n - 1]) {
      const cx = sx[end]!, cy = sy[end]!;
      for (let k = 0; k < CAP_SEGMENTS; k++) {
        const a0 = (k / CAP_SEGMENTS) * Math.PI * 2;
        const a1 = ((k + 1) / CAP_SEGMENTS) * Math.PI * 2;
        put(cx, cy);
        put(cx + Math.cos(a0) * s.capPx, cy + Math.sin(a0) * s.capPx);
        put(cx + Math.cos(a1) * s.capPx, cy + Math.sin(a1) * s.capPx);
      }
    }
    s.attr.needsUpdate = true;
  }

  // ---- the label: text only, takes no pointer --------------------------------------------------
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
    el.style.background = plateRgba(canvasBadgeTheme(this.host).background, 0.95);
    el.style.border = `1px solid ${hex}`;
    el.style.boxShadow = '0 2px 8px -3px rgba(0,0,0,.8)';
    el.style.fontFamily = 'var(--font-monospace, ui-monospace, monospace)';
    el.style.fontSize = '11px';
    el.style.fontWeight = '700';
    el.style.lineHeight = '1.35';
    el.style.color = badgeInk(this.host);
    el.style.whiteSpace = 'nowrap';
    el.createSpan({ cls: 'atlas3d-tactical-main', text: main });
    if (sub) {
      const s = el.createSpan({ cls: 'atlas3d-tactical-sub', text: sub });
      s.style.fontWeight = '400';
      s.style.fontSize = '10px';
      s.style.opacity = '.72';
    }
    entry.pills.push({ el, worldPos: new THREE.Vector3(at[0], at[1] + 0.06, at[2]) });
  }

  // ---- the three handles -----------------------------------------------------------------------
  private handleShell(cls: string, radius: number, hit: number, hex: string, title: string): { el: HTMLElement; ring: HTMLElement } {
    const theme = canvasBadgeTheme(this.host);
    const tint = measureRingColor(hex, this.host);
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
    ring.style.background = plateRgba(theme.background, 0.95);
    ring.style.border = `1.5px solid ${tint}`;
    ring.style.boxShadow = '0 1px 5px -1px rgba(0,0,0,.85)';
    ring.style.outlineOffset = '2px';
    ring.style.transition = 'transform .12s';
    return { el, ring };
  }

  private liftHandle(ring: HTMLElement, scale: number, open: boolean): void {
    ring.style.transform = `scale(${scale})`;
    ring.style.outline = open ? `2px solid ${plateHex(canvasBadgeTheme(this.host).accent)}` : 'none';
  }

  private lightBadge(entry: Entry, open: boolean): void {
    const badge = entry.handles.find((h) => h.part === 'origin');
    if (badge) this.liftHandle(badge.ring, 1, open);
  }

  private setOpenPopover(id: string | null): void {
    if (this.openId === id) return;
    const previous = this.openId;
    this.openId = id;
    if (previous !== null) { const before = this.entries.get(previous); if (before) this.lightBadge(before, false); }
    if (id !== null) { const now = this.entries.get(id); if (now) this.lightBadge(now, true); }
  }

  private addOriginBadge(
    entry: Entry, region: MeasureRegion, a: Anchors, hex: string,
    ceilingY: number, ctx: TacticalOverlayContext,
  ): void {
    if (!a.config) return;
    const shape = this.shapes.get(region.id) ?? region.mode;
    const { el, ring } = this.handleShell('is-origin', HANDLE_RADIUS, HANDLE_HIT, hex, 'Measurement options');
    ring.style.cursor = 'pointer';
    const glyph = ring.createDiv();
    glyph.style.width = `${HANDLE_GLYPH}px`;
    glyph.style.height = `${HANDLE_GLYPH}px`;
    glyph.style.color = badgeInk(this.host);
    glyph.style.display = 'grid';
    glyph.style.placeItems = 'center';
    const paths = SHAPE_GLYPH[shape] ?? SHAPE_GLYPH.square!;
    const body = paths.map((d) => `<path d="${d}"/>`).join('');
    glyph.innerHTML = `<svg width="${HANDLE_GLYPH}" height="${HANDLE_GLYPH}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

    const y = this.regionTop(region, ctx, a.config, ceilingY);
    const handle: HandleEntry = {
      el, ring, worldPos: new THREE.Vector3(a.config.x, y + BORDER_LIFT, a.config.z),
      part: 'origin', hex,
      bearer: a.bearer ? { x: a.bearer.x, z: a.bearer.z } : null,
      rim: a.rim,
      anchor: a.bearer ? { x: a.bearer.x, z: a.bearer.z } : a.centre,
      direction: a.direction, offset: a.offset, planeY: y + BORDER_LIFT, start: a.reach,
      anchorWorld: null,
    };
    const open = (e: Event): void => {
      e.stopPropagation(); e.preventDefault();
      this.setOpenPopover(region.id);
      this.onOpenMeasurePopover?.(region.id);
    };
    el.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => { const ke = e as KeyboardEvent; if (ke.key === 'Enter' || ke.key === ' ') open(e); });
    el.addEventListener('pointerenter', () => { if (this.openId !== region.id) this.liftHandle(ring, HOVER_LIFT, false); });
    el.addEventListener('pointerleave', () => { this.liftHandle(ring, 1, this.openId === region.id); });
    entry.handles.push(handle);
  }

  private addEndHandle(
    entry: Entry, id: string, a: Anchors, hex: string,
    ceilingY: number, ctx: TacticalOverlayContext,
  ): void {
    if (!a.end) return;
    const { el, ring } = this.handleShell('is-end', END_RADIUS, END_HIT, hex, 'Drag to resize or turn (Alt: free size)');
    ring.style.cursor = 'grab';
    const y = this.surfaceY(ctx, a.end.x, a.end.z, ceilingY);
    const handle: HandleEntry = {
      el, ring, worldPos: new THREE.Vector3(a.end.x, y + BORDER_LIFT, a.end.z),
      part: 'end', hex, bearer: null, rim: null,
      anchor: a.bearer ? { x: a.bearer.x, z: a.bearer.z } : a.centre,
      direction: a.direction, offset: a.offset, planeY: y + BORDER_LIFT, start: a.reach,
      anchorWorld: null,
    };
    el.addEventListener('pointerdown', (e) => this.beginDrag(e, id, handle, 'resize'));
    el.addEventListener('pointerenter', () => { if (this.drag?.el !== el) this.liftHandle(ring, HOVER_LIFT, false); });
    el.addEventListener('pointerleave', () => { if (this.drag?.el !== el) this.liftHandle(ring, 1, false); });
    entry.handles.push(handle);
  }

  private addTurnHandle(
    entry: Entry, id: string, a: Anchors, hex: string,
    ceilingY: number, ctx: TacticalOverlayContext,
  ): void {
    if (!a.end) return;
    const { el, ring } = this.handleShell('is-turn', TURN_RADIUS, TURN_HIT, hex, 'Drag to turn the area');
    ring.style.cursor = 'grab';
    const glyph = ring.createDiv();
    glyph.style.width = `${TURN_GLYPH}px`;
    glyph.style.height = `${TURN_GLYPH}px`;
    glyph.style.color = badgeInk(this.host);
    glyph.style.display = 'grid';
    glyph.style.placeItems = 'center';
    glyph.style.pointerEvents = 'none';
    const body = TURN_GLYPH_PATHS.map((d) => `<path d="${d}"/>`).join('');
    glyph.innerHTML = `<svg width="${TURN_GLYPH}" height="${TURN_GLYPH}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

    const y = this.surfaceY(ctx, a.end.x, a.end.z, ceilingY);
    const anchor = a.bearer ? { x: a.bearer.x, z: a.bearer.z } : a.centre;
    const handle: HandleEntry = {
      el, ring, worldPos: new THREE.Vector3(a.end.x, y + BORDER_LIFT, a.end.z),
      part: 'turn', hex, bearer: null, rim: null,
      anchor, direction: a.direction, offset: a.offset,
      planeY: y + BORDER_LIFT, start: a.reach,
      anchorWorld: new THREE.Vector3(anchor.x, y + BORDER_LIFT, anchor.z),
    };
    el.addEventListener('pointerdown', (e) => this.beginDrag(e, id, handle, 'turn'));
    el.addEventListener('pointerenter', () => { if (this.drag?.el !== el) this.liftHandle(ring, HOVER_LIFT, false); });
    el.addEventListener('pointerleave', () => { if (this.drag?.el !== el) this.liftHandle(ring, 1, false); });
    entry.handles.push(handle);
  }

  // ---- dragging a far handle -------------------------------------------------------------------
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

  private beginDrag(e: PointerEvent, id: string, handle: HandleEntry, mode: 'resize' | 'turn'): void {
    if (e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    this.endDrag();
    this.setOpenPopover(null);
    if (!this.pointerOnPlane(e.clientX, e.clientY, handle.planeY)) return;
    this.drag = {
      id, mode,
      anchor: { x: handle.anchor.x, z: handle.anchor.z },
      direction: { x: handle.direction.x, z: handle.direction.z },
      offset: handle.offset, planeY: handle.planeY,
      heldReach: handle.start, last: handle.start, hex: handle.hex,
      el: handle.el, ring: handle.ring,
    };
    handle.ring.style.cursor = 'grabbing';
    this.liftHandle(handle.ring, DRAG_LIFT, false);
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
    const dx = world.x - drag.anchor.x;
    const dz = world.z - drag.anchor.z;
    const span = Math.hypot(dx, dz);
    const direction = span > 1e-6
      ? { x: dx / span, z: dz / span }
      : { x: drag.direction.x, z: drag.direction.z };
    const turned = Math.abs(direction.x - drag.direction.x) > 1e-3
      || Math.abs(direction.z - drag.direction.z) > 1e-3;
    const free = e.altKey || !this.snapToGrid;
    const cells = drag.mode === 'turn'
      ? drag.heldReach
      : fittedReach(dx * drag.direction.x + dz * drag.direction.z - drag.offset, free);
    if (cells === drag.last && !turned) return;
    drag.last = cells;
    drag.direction = direction;
    this.onMeasureResize?.({ id: drag.id, cells, free, direction });
  }

  private endDrag(): void {
    const drag = this.drag;
    if (drag?.ring) { drag.ring.style.cursor = 'grab'; this.liftHandle(drag.ring, 1, false); }
    this.dragAbort?.abort();
    this.dragAbort = null;
    this.drag = null;
  }

  // ---- LoS ------------------------------------------------------------------------------------
  private clearLos(): void {
    for (const child of this.losGroup.children) {
      if (child instanceof THREE.Line || child instanceof THREE.Mesh) {
        if (child.geometry !== this.hitGeom && child.geometry !== this.ringLineGeom) child.geometry.dispose();
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
      const bl = new THREE.Line(bg, new THREE.LineDashedMaterial({
        color: 0xef4444, transparent: true, opacity: 0.75, dashSize: 0.14, gapSize: 0.08, depthTest: false,
      }));
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