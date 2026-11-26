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
 * THE COLOUR IS THE MEASUREMENT'S, AND NULL MEANS THE THEME'S ACCENT — WITH AN EFFECT TOO.
 * `MEASURE_EFFECT_STARTS` says whether a look gives LIGHT or DARKNESS; its `color` is what Atlas'
 * picker writes when the effect is chosen, not what the renderer imposes. Substituting it for a
 * null colour made every effect burn orange while the 2D, on "Predeterminado", burned in the
 * theme's accent. A null colour now reaches `resolveMeasureColor`, which reads Obsidian's accent.
 *
 * THE BODY IS ATLAS' AreaBody.draw(), layer for layer: wash 0.12 edge-to-edge, cell tint 0.16
 * inset max(1px, cell×0.025), outline at max(2px, cell/28). With an effect the effect mesh REPLACES
 * the wash and lies UNDER the tint and the outline, which still draw on top. The layers are held
 * well apart: they were 0.003 apart, which at the distance a camera preset chooses is less than
 * one depth step, so the wash and the tint fought for the depth test in patches that moved.
 *
 * EVERY STROKE IS ONE MITRED BAND, OPAQUE, DRAWN ONCE. The outline used to be walked in short
 * pieces, each prolonged half a width past its ends so two edges meeting at a corner would overlap
 * instead of leaving a notch. On a circle every edge is shorter than the walk step, so EVERY piece
 * was prolonged at both ends and overlapped both neighbours; being translucent, the overlap blended
 * twice and the ring read as a chain of darker beads. At a cone's apex the prolongations crossed
 * outside the figure and drew spikes.
 *
 * Here each ring is offset to either side with a MITRE at every vertex, one quad per edge, plus a
 * round disc at each vertex for the join. Consecutive quads share exact vertices, so they tile
 * without gap; and the material is OPAQUE, as Atlas' own accent is, so even where a join disc
 * overlaps the band nothing blends twice. Heights are taken per VERTEX from the nearest covered
 * cell, so a band across a step tilts with the terrain instead of tearing, and it is built ONCE for
 * the whole ring — per height group, a piece with no owner was skipped by none of them and drawn
 * by all of them.
 *
 * THE RULER IS DRAWN IN SCREEN PIXELS, at the border's own width turned into pixels once per frame,
 * so it reads as thick as the areas' outlines and the same at both ends. It writes its OWN projected
 * depth, so terrain occludes it exactly as it occludes an area: a ruler that ignored the depth test
 * slid over walls as the camera turned and read as detached from the floor. An END of its path has
 * one segment and takes that segment's normal at the full half width: the mitre formula there
 * divides by a zero cosine, clamps to the floor, and made the last point four times wider.
 *
 * THE HANDLES SIT ON THE MEASUREMENT'S OWN POINTS. The origin badge shares the ink's first vertex
 * (`measureHandlePoint`), at that point's own height, lifted exactly as the ink is — it used to take
 * the highest surface the region covers, a different point from where the line starts, and the two
 * drifted apart with the camera's angle and zoom. The far dot stands at the second point
 * (`measureEndHandlePoint`), not at a vertex of the outline: a 32-sided circle has a vertex every
 * 11.25°, so picking one made the handle jump around the rim instead of following the pointer. An
 * aura's badge still rides its token's rim, turned by the view's azimuth so it stays lower-left.
 *
 * THE HANDLES ARE ATLAS' OWN, drawn as MeasureHandles.draw() draws them: hairline at R+0.5, plate
 * at R in the theme's badge colour at 0.95, ring stroke 1.5px centred at R−1.25 in the measure's
 * colour at 0.9, accent ring 2px at R+3 while its popover is open. The turn dot's ring is 1px at
 * R−0.75 and two arrows chase each other round it (measureTurnHandle.ts). Hover ×1.12, drag ×1.2.
 *
 * A TOKEN'S POSITION IS NOT IN THE CONTEXT KEY. It was, and that made dropping one token rebuild
 * every measurement on the map: the key changed, so every signature changed, so `apply` disposed
 * and rebuilt every entry — geometry, materials and the DOM pills and handles, which is what read
 * as a blink. Where a position genuinely matters it is already in the per-region signature: an
 * aura's cells and anchors move with its bearer, a drawn area's `tokenIds` change when a token
 * enters or leaves it, and a badge that sits on a token carries that anchor.
 *
 * EVERY LABEL AND HANDLE IS BORN HIDDEN. A new element has no left/top until `updateScreenLabels`
 * places it, so visible before that it paints one frame at the layer's static origin — the corner.
 * `place` reveals it the moment it is projected, which is the same frame or the next.
 *
 * RISERS BELONG TO A STEPPED OUTLINE — an aura or a range ring, whose area IS grown cells. A beam is
 * a drawn rectangle, not a grown region, so it is not among them.
 *
 * NO 3D SHELLS. The volume of a figure is to become a per-measurement choice in its options, not
 * something every area wears: an extruded box over a beam read as a slab standing on the map, and an
 * aura's cylinder was a disc larger than its stepped footprint whose bottom cap fought the floor.
 * `terrain/measureVolume.ts` still supplies the origin, reach and direction the effect fill needs;
 * `view/measureShells.ts` is kept for when that toggle lands, with no caller today.
 *
 * A DRAG SURVIVES A REBUILD and carries its own geometry. The far dot emits reach AND direction; the
 * turn dot emits direction alone, keeping the reach.
 *
 * Render ladder: terrain 0, water 1, grid 2, numbers 3, token art 3-5.
 * Glow 2.2, effect 2.4, wash 2.4, cells 2.5, riser 2.55, border 2.6,
 * ruler drop 13, ruler stroke 14, ruler nodes 15, LoS 14-16.
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
  /** Where the pointer lies from the anchor, one unit long: the handle is MOVED, not just sized. */
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

/** One screen-space drawable: its NDC buffer is refilled from world points every frame. */
interface InkPart {
  readonly mesh: THREE.Mesh;
  readonly attr: THREE.BufferAttribute;
  readonly mat: THREE.ShaderMaterial;
}

/** A ruler's ink: the ribbon, the point dots, and the white middle of the origin's hollow one. */
interface RulerInk {
  readonly path: readonly WorldPoint[];
  /** The stroke's width in world units, turned into pixels each frame at the current zoom. */
  readonly widthWorld: number;
  readonly ribbon: InkPart;
  readonly nodes: InkPart;
  readonly hollow: InkPart | null;
}

interface Entry {
  id: string; group: THREE.Group;
  pills: PillEntry[]; handles: HandleEntry[];
  geoms: THREE.BufferGeometry[]; mats: THREE.Material[]; insts: THREE.InstancedMesh[];
  fx: EffectFill | null; glow: GlowState | null; ruler: RulerInk | null;
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
  /** The height of the measurement's own first point; null when the badge rides a token's rim. */
  readonly configY: number | null;
  readonly end: { x: number; z: number } | null;
  readonly centre: { x: number; z: number };
  readonly direction: { x: number; z: number };
  readonly bearer: AreaTokenTarget | null;
  readonly rim: { x: number; z: number } | null;
  readonly offset: number; readonly reach: number;
  readonly resizable: boolean; readonly turnable: boolean;
}

// ---- the body, as Atlas' BODY constant holds it ------------------------------------------------
const WASH_OPACITY = 0.12;
const CELL_OPACITY = 0.16;
/** The accent stroke is OPAQUE, as Atlas' own is: overlaps then never blend twice. */
const STROKE_OPACITY = 1;
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
/**
 * The layers are held well apart. They were 0.003 apart, which at the distance a camera preset
 * chooses is less than one depth step of a wide clipping range — so the wash and the cell tint
 * fought for the depth test in patches that moved with the camera.
 */
const WASH_LIFT = 0.018;
const FILL_LIFT = 0.034;
const BORDER_LIFT = 0.052;
const PATH_LIFT = 0.07;
const RISER_INSET = 0.35;
const RISER_EPSILON = 0.02;
const RISER_OPACITY = 0.42;
const FADE_MS = 2000;
const OWNER_REACH = 2;
const GLOW_SPREAD = 2.4;
const GLOW_OPACITY = 0.55;
const MITRE_COS_FLOOR = 0.25;
/** Triangles in one round join or node disc. */
const DISC_SEGMENTS = 16;

// ---- the ruler, in screen pixels ---------------------------------------------------------------
const INK_DOT_PX = 4;
const MIN_STROKE_PX = 2;
const HOLLOW_MIDDLE = '#ffffff';
const FALLBACK_PX_PER_UNIT = 40;
const SCREEN_VERTEX = `
void main(){ gl_Position = vec4(position.xy, position.z, 1.0); }`;
const SCREEN_FRAGMENT = `
precision mediump float;
uniform vec3 uColor;
uniform float uOpacity;
void main(){ gl_FragColor = vec4(uColor, uOpacity); }`;

// ---- the handles, as Atlas' measureHandle.ts holds them ----------------------------------------
const HANDLE_RADIUS = 10;
const HANDLE_GLYPH = 12;
const HANDLE_HIT = 12;
const END_RADIUS = 6;
const END_HIT = 9;
const TURN_RADIUS = 6;
const TURN_HIT = 9;
/** Every handle's size, as a multiple of Atlas' own. 1 is parity; raise it if they read small. */
const HANDLE_SCALE = 1;
const RING_INSET = 1.25;
const RING_WIDTH = 1.5;
const TURN_RING_INSET = 0.75;
const TURN_RING_WIDTH = 1;
const RING_ALPHA = 0.9;
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
/** measureTurnHandle.ts: two arrows chasing each other round the dot, in the badge's ink. */
const TURN_ARC_RADIUS = 2.5;
const TURN_ARC_WIDTH = 1;
const TURN_HEAD = 1.5;
const TURN_ARCS: readonly (readonly [number, number])[] = [[-2.97, -0.5], [0.17, 2.64]];

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

/** The sRGB bytes a raw screen shader writes: it has no colourspace chunk of its own. */
function srgbVector(hex: string): THREE.Vector3 {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  if (!Number.isFinite(n)) return new THREE.Vector3(1, 1, 1);
  return new THREE.Vector3(((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255);
}

/**
 * The mode a display is. Every current producer sets `mode` and it wins. The fallbacks read an
 * Atlas name through Atlas' door and a legacy toolbar name through the legacy one: one map serving
 * both read Atlas' `line` — a rectangle — as `ruler`, which stripped a kept line of its body.
 */
const modeOf = (d: MeasureDisplay): AtlasMeasureMode =>
  d.mode ?? atlasModeOf(d.shape) ?? (isLegacyShape(d.shape) ? atlasModeOfLegacy(d.shape) : 'ruler');

const heightBucket = (y: number): number => Math.round(y * 1000);
const cellKey = (cx: number, cz: number): string => `${cx},${cz}`;
const cornerKey = (x: number, z: number): string => `${Math.round(x * 1e6)},${Math.round(z * 1e6)}`;
const spaceRadius = (t: Pick<AreaTokenTarget, 'diameter'>): number => Math.max(1, t.diameter) / 2;
const plateHex = (n: number): string => `#${(n >>> 0).toString(16).padStart(6, '0')}`;
const plateRgba = (n: number, alpha: number): string =>
  `rgba(${(n >> 16) & 0xff},${(n >> 8) & 0xff},${n & 0xff},${alpha})`;

/** The stroke width every figure wears, in world units: the area border's own. */
const strokeWidth = (): number => Math.max(MIN_BORDER_WIDTH, BORDER_WIDTH_SHARE);

/** The unit left normal of a plan direction; zero for a direction that is none. */
function leftOf(dx: number, dz: number): { x: number; z: number } {
  const len = Math.hypot(dx, dz);
  return len > 1e-9 ? { x: -dz / len, z: dx / len } : { x: 0, z: 0 };
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
    const d = (p.x - centre.x) * dir.x + (p.z - centre.z) * dir.z;
    if (d > bestDot) { bestDot = d; best = { x: p.x, z: p.z }; }
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

/** The turn dot's glyph, built from Atlas' own arcs and heads rather than a looked-out icon. */
function turnGlyphSvg(diameter: number, ink: string): string {
  const c = TURN_RADIUS;
  const f = (n: number): string => n.toFixed(2);
  const parts: string[] = [];
  for (const [from, to] of TURN_ARCS) {
    const x0 = c + TURN_ARC_RADIUS * Math.cos(from);
    const y0 = c + TURN_ARC_RADIUS * Math.sin(from);
    const x1 = c + TURN_ARC_RADIUS * Math.cos(to);
    const y1 = c + TURN_ARC_RADIUS * Math.sin(to);
    const large = to - from > Math.PI ? 1 : 0;
    // Screen y grows downward, so a rising angle is clockwise: SVG's sweep flag 1.
    parts.push(
      `<path d="M${f(x0)} ${f(y0)}A${TURN_ARC_RADIUS} ${TURN_ARC_RADIUS} 0 ${large} 1 ${f(x1)} ${f(y1)}"`
      + ` fill="none" stroke="${ink}" stroke-width="${TURN_ARC_WIDTH}"/>`,
    );
    const cos = Math.cos(to), sin = Math.sin(to);
    const head = [
      [x1 - sin * TURN_HEAD, y1 + cos * TURN_HEAD],
      [x1 + cos * TURN_HEAD * 0.7, y1 + sin * TURN_HEAD * 0.7],
      [x1 - cos * TURN_HEAD * 0.7, y1 - sin * TURN_HEAD * 0.7],
    ];
    parts.push(`<path d="M${head.map((p) => `${f(p[0]!)} ${f(p[1]!)}`).join('L')}Z" fill="${ink}"/>`);
  }
  const box = 2 * TURN_RADIUS;
  return `<svg width="${diameter}" height="${diameter}" viewBox="0 0 ${box} ${box}"`
    + ` xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
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

/**
 * What EVERY region's drawing depends on, keyed once per pass.
 *
 * TOKEN POSITIONS ARE NOT HERE. They were, and that made dropping one token rebuild every
 * measurement on the map: the key changed, so every signature changed, so `apply` disposed and
 * rebuilt every entry — geometry, materials and the DOM pills and handles, which is what read as
 * a blink. Where a position genuinely matters it is already in the per-region signature: an
 * aura's cells and anchors move with its bearer, a drawn area's `tokenIds` change when a token
 * enters or leaves it, and a badge that sits on a token carries that anchor. The token SET and
 * their sizes stay, which is what a rim offset and a footprint depend on.
 */
function contextKey(ctx: TacticalOverlayContext): string {
  const r = ctx.rules;
  return JSON.stringify([
    ctx.maxLayer, ctx.map.layerHeight, ctx.gridSize ?? 1, ctx.snapToGrid !== false,
    r ? [r.diagonalRule, r.areaCellRule, r.coneAngle, r.coneEnd, r.unitDistance, r.mode, r.rangeBands] : null,
    ctx.movement?.steps.map((s) => [s.name, s.multiple, s.color]) ?? null,
    ctx.speed ?? null,
    ctx.tokens?.map((t) => [t.id, t.diameter]) ?? null,
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
  private readonly pc = new THREE.Vector3();
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
      if (entry.fadeStart !== null) {
        const factor = 1 - Math.min(1, Math.max(0, (now - entry.fadeStart) / FADE_MS));
        for (const [mat, base] of entry.baseOpacity) {
          (mat as THREE.Material & { opacity: number }).opacity = base * factor;
        }
        this.fadeRuler(entry, factor);
        (entry.fx as FadeableFill | null)?.setFade?.(factor);
        entry.group.visible = factor > 0;
        if (factor <= 0) {
          for (const p of entry.pills) p.el.addClass('is-hidden');
          for (const h of entry.handles) h.el.addClass('is-hidden');
          continue;
        }
      }
      // The ruler's ink is rebuilt in pixels every frame: that is what keeps its width the same at
      // both ends, and as thick as the areas' borders, at any zoom or bearing.
      if (entry.ruler) this.fillRuler(entry.ruler, camera, width, height);
      for (const p of entry.pills) place(p.el, p.worldPos);
      for (const h of entry.handles) { this.turnBadge(h); place(h.el, h.worldPos); }
      this.placeTurnDot(entry, camera, width, height);
    }
    if (this.losPill) place(this.losPill.el, this.losPill.worldPos);
  }

  /** The origin badge rides its token's rim turned by the view, so it stays lower-left on screen. */
  private turnBadge(h: HandleEntry): void {
    if (h.part !== 'origin' || !h.bearer || !h.rim) return;
    const cos = Math.cos(this.azimuth), sin = Math.sin(this.azimuth);
    h.worldPos.x = h.bearer.x + h.rim.x * cos - h.rim.z * sin;
    h.worldPos.z = h.bearer.z + h.rim.x * sin + h.rim.z * cos;
  }

  /**
   * The turn dot stands a fixed distance ON SCREEN to the right of the far dot, as seen from the
   * origin — Atlas' own placement. Screen space is the only space where "16 pixels" means anything
   * under an orbiting perspective camera.
   */
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
    // Screen y grows downward: looking from the origin to the far end, the right hand is (-dy, dx).
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

  /**
   * The parameters of a figure, from the same ones that shape its footprint. No shell is drawn from
   * them today — the volume is to become a per-measurement choice — but the effect fill still needs
   * its origin, reach and direction, so this stays.
   */
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
        a?.top ?? null, a?.config ?? null, a?.configY ?? null, a?.end ?? null,
        a?.resizable ?? false, a?.turnable ?? false,
        this.onOpenMeasurePopover !== null, effect, this.volumes.get(region.id) ?? null,
      ]);
      const existing = this.entries.get(region.id);
      if (existing && existing.signature === sig) { this.applyFade(existing, fading.has(region.id)); continue; }
      if (existing) { this.disposeEntry(existing); this.entries.delete(region.id); }
      // One measurement that cannot be drawn is skipped, not allowed to take the whole pass down:
      // a throw here used to blank every measurement on the map, not just the one that failed.
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
    this.fadeRuler(entry, 1);
    (entry.fx as FadeableFill | null)?.setFade?.(1);
  }

  /** The ruler's ink fades through its own uniform: a raw shader has no `opacity` to set. */
  private fadeRuler(entry: Entry, factor: number): void {
    const ink = entry.ruler;
    if (!ink) return;
    ink.ribbon.mat.uniforms.uOpacity!.value = factor;
    ink.nodes.mat.uniforms.uOpacity!.value = factor;
    if (ink.hollow) ink.hollow.mat.uniforms.uOpacity!.value = factor;
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
    entry.ruler = null;
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
      geoms: [], mats: [], insts: [], fx: null, glow: null, ruler: null,
      signature: '', fadeStart: null, baseOpacity: new Map(),
    };
    const effect: MeasureEffect | undefined = readMeasureEffect(effectRaw);
    // NULL MEANS THE THEME'S ACCENT, with an effect too. MEASURE_EFFECT_STARTS tells whether the
    // look gives light or darkness; its colour is what the picker writes, not what we impose.
    const color = new THREE.Color(resolveMeasureColor(region.color ?? null, this.host));
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
        baseY,
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
        color: ringColor, transparent: true, opacity: STROKE_OPACITY, depthWrite: false, side: THREE.DoubleSide,
      }), STROKE_OPACITY);
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
      // Atlas puts a drawn area's far handle at its OWN second point, not at a vertex of the
      // outline: a 32-sided circle has a vertex every 11.25°, so picking one made the handle jump
      // around the rim instead of following the pointer. An aura's area IS grown cells, so its
      // handle stands on the staircase.
      const end = isAura
        ? (region.outline.length > 0 ? outlinePointAt(region.outline, direction, centre) : null)
        : (farPoint ? { x: farPoint[0], z: farPoint[2] } : null);
      // The badge shares the ink's own first vertex, so the two are coincident at any zoom or
      // bearing. A ruler's stroke is built from `region.path`, so that is the point it takes.
      const startPoint = region.path?.[0] ?? originPoint;
      const config = bearer && rim
        ? { x: bearer.x + rim.x, z: bearer.z + rim.z }
        : (startPoint ? { x: startPoint[0], z: startPoint[2] } : null);
      const configY = bearer ? null : (startPoint ? startPoint[1] : null);
      const resizable = this.onMeasureResize !== null && region.pinned && region.mode !== 'ruler'
        && region.mode !== 'ranges' && end !== null;
      // A circle looks the same at any angle, and a ruler's distance follows the diagonal rule, so
      // neither has a turn handle — Atlas' own rule.
      const turnable = resizable && region.mode !== 'circle' && reach > 1e-6;
      out.set(region.id, {
        top, config, configY, end, centre, direction, bearer, rim, offset, reach, resizable, turnable,
      });
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
      color, transparent: true, opacity: STROKE_OPACITY, depthWrite: false, side: THREE.DoubleSide,
    }), STROKE_OPACITY);
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
    const width = strokeWidth();
    // Risers belong to a GROWN cell set — an aura or a range ring — whose area is cells and whose
    // boundary therefore runs along cell edges at every step. A beam is a drawn rectangle: its
    // outline happens to be its cells' staircase, so treating it as stepped too stroked the same
    // boundary twice, once as the ring and once as risers.
    const stepped = (typeof region.follows === 'string' && region.follows !== '')
      || region.mode === 'ranges';
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
          this.pushRiser(riserPts, ctx, edge, ceilingY, width / 2);
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
    // ONE pass for the whole outline, heights per vertex from the nearest covered cell.
    const borderPts: number[] = [];
    this.pushRingStroke(borderPts, region.outline, width, (x, z) => {
      const owner = ownerAt(x, z);
      return (owner !== null ? this.cellY(ctx, owner, x, z) : this.surfaceY(ctx, x, z, ceilingY)) + BORDER_LIFT;
    });
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
   * A closed ring stroked as ONE mitred band of constant width, with a round disc at every vertex
   * for the join. Consecutive quads share exact vertices, so they tile without gap; the material is
   * opaque, so a join disc overlapping the band never blends twice. No prolongations, no walking
   * step: those are what beaded a circle and spiked a cone's apex.
   *
   * Heights are taken per VERTEX, so a band crossing a step tilts with the terrain rather than
   * tearing between two edges that disagree about the height of their shared corner.
   */
  private pushRingStroke(
    pts: number[],
    rings: readonly PlanRing[],
    width: number,
    yAt: (x: number, z: number) => number,
  ): void {
    const half = width / 2;
    for (const ring of rings) {
      const n = ring.length;
      if (n < 3) continue;
      const lx: number[] = [], lz: number[] = [], rx: number[] = [], rz: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i < n; i++) {
        const prev = ring[(i - 1 + n) % n]!;
        const v = ring[i]!;
        const next = ring[(i + 1) % n]!;
        const n1 = leftOf(v.x - prev.x, v.z - prev.z);
        const n2 = leftOf(next.x - v.x, next.z - v.z);
        let mx = n1.x + n2.x, mz = n1.z + n2.z;
        const ml = Math.hypot(mx, mz);
        let scale = half;
        if (ml > 1e-9) {
          mx /= ml; mz /= ml;
          scale = half / Math.max(MITRE_COS_FLOOR, mx * n2.x + mz * n2.z);
        } else { mx = n2.x; mz = n2.z; }
        lx.push(v.x + mx * scale); lz.push(v.z + mz * scale);
        rx.push(v.x - mx * scale); rz.push(v.z - mz * scale);
        ys.push(yAt(v.x, v.z));
      }
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const y0 = ys[i]!, y1 = ys[j]!;
        pts.push(
          lx[i]!, y0, lz[i]!, rx[i]!, y0, rz[i]!, rx[j]!, y1, rz[j]!,
          lx[i]!, y0, lz[i]!, rx[j]!, y1, rz[j]!, lx[j]!, y1, lz[j]!,
        );
      }
      for (let i = 0; i < n; i++) {
        const v = ring[i]!, y = ys[i]!;
        for (let k = 0; k < DISC_SEGMENTS; k++) {
          const a0 = (k / DISC_SEGMENTS) * Math.PI * 2;
          const a1 = ((k + 1) / DISC_SEGMENTS) * Math.PI * 2;
          pts.push(
            v.x, y, v.z,
            v.x + Math.cos(a0) * half, y, v.z + Math.sin(a0) * half,
            v.x + Math.cos(a1) * half, y, v.z + Math.sin(a1) * half,
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

  /** A range ring's outline, stroked as the body's is, on the surfaces the body covers. */
  private drawRingOutline(
    entry: Entry, rings: readonly PlanRing[], ctx: TacticalOverlayContext,
    mat: THREE.Material, ceilingY: number, covered: ReadonlyMap<string, number>,
  ): void {
    if (rings.length === 0) return;
    const pts: number[] = [];
    this.pushRingStroke(pts, rings, strokeWidth(), (x, z) => {
      const held = covered.get(cornerKey(x, z));
      return (held !== undefined ? held : this.surfaceY(ctx, x, z, ceilingY)) + BORDER_LIFT;
    });
    if (pts.length === 0) return;
    const g = this.trackGeom(entry, new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const m = new THREE.Mesh(g, mat);
    m.renderOrder = BORDER_ORDER;
    entry.group.add(m);
  }

  // ---- the ruler, in screen pixels --------------------------------------------------------------
  /**
   * A ruler: its path stroked with round joins, a dot at every point, and the origin's dot one
   * larger and hollow around a white middle — `drawMeasurement` and `drawMeasurePoint`. Plus our
   * own dashed drop wherever a corner stands above the ground, which Atlas has no need of on a flat
   * map. Three drawables, not one per node: a 64-corner ruler is still three draw calls.
   */
  private drawPath(
    entry: Entry, path: readonly WorldPoint[], ctx: TacticalOverlayContext,
    color: THREE.Color, ceilingY: number,
  ): void {
    if (path.length < 2) return;
    const hex = `#${color.getHexString()}`;
    const lifted = path.map((p) => [p[0], p[1] + PATH_LIFT, p[2]] as WorldPoint);
    const n = lifted.length;
    const ribbon = this.inkPart(entry, (n - 1) * 6 + n * DISC_SEGMENTS * 3, hex, PATH_ORDER);
    const nodes = this.inkPart(entry, n * DISC_SEGMENTS * 3, hex, NODE_ORDER);
    const hollow = this.inkPart(entry, DISC_SEGMENTS * 3, HOLLOW_MIDDLE, NODE_ORDER + 0.01);
    entry.ruler = { path: lifted, widthWorld: strokeWidth(), ribbon, nodes, hollow };
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

  /**
   * One screen-space drawable: its buffer is allocated once and refilled every frame. The depth test
   * is ON and each vertex carries its own projected depth, so terrain occludes the ruler exactly as
   * it occludes an area — a stroke that ignored depth slid over walls as the camera turned.
   */
  private inkPart(entry: Entry, verts: number, hex: string, order: number): InkPart {
    const attr = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    const geom = this.trackGeom(entry, new THREE.BufferGeometry());
    geom.setAttribute('position', attr);
    const mat = this.trackMat(entry, new THREE.ShaderMaterial({
      uniforms: { uColor: { value: srgbVector(hex) }, uOpacity: { value: 1 } },
      vertexShader: SCREEN_VERTEX, fragmentShader: SCREEN_FRAGMENT,
      transparent: true, depthTest: true, depthWrite: false, side: THREE.DoubleSide,
    }), 1);
    const mesh = new THREE.Mesh(geom, mat);
    // The positions are NDC, not world: a bounding sphere at the origin would be culled away.
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    entry.group.add(mesh);
    return { mesh, attr, mat };
  }

  /** Screen pixels per world unit at a point, read along the camera's own right axis. */
  private pxPerUnitAt(camera: THREE.Camera, at: WorldPoint, width: number, height: number): number {
    this.pa.set(at[0], at[1], at[2]).project(camera);
    const ax = (this.pa.x * 0.5 + 0.5) * width, ay = (-this.pa.y * 0.5 + 0.5) * height;
    this.pc.setFromMatrixColumn(camera.matrixWorld, 0);
    this.pb.set(at[0] + this.pc.x, at[1] + this.pc.y, at[2] + this.pc.z).project(camera);
    const bx = (this.pb.x * 0.5 + 0.5) * width, by = (-this.pb.y * 0.5 + 0.5) * height;
    const d = Math.hypot(bx - ax, by - ay);
    return Number.isFinite(d) && d > 1e-3 ? d : FALLBACK_PX_PER_UNIT;
  }

  /**
   * Refill the ruler's ink from the projected path, in pixels, written as NDC with each point's own
   * depth. The stroke's width is the AREA BORDER's world width turned into pixels at the current
   * zoom, so the ruler reads as thick as the other tools; the dots keep Atlas' proportions to it.
   *
   * An END of the path has only one segment and takes that segment's own normal at the full half
   * width. Running the mitre formula there divides by a zero cosine, clamps to the floor, and
   * offsets that point FOUR times as far as the other end — which is what made the ruler a wedge.
   */
  private fillRuler(ink: RulerInk, camera: THREE.Camera, width: number, height: number): void {
    const n = ink.path.length;
    const scale = this.pxPerUnitAt(camera, ink.path[0]!, width, height);
    const strokePx = Math.max(MIN_STROKE_PX, ink.widthWorld * scale);
    const half = strokePx / 2;
    const dotPx = Math.max(INK_DOT_PX, half * 4);
    const originPx = dotPx + Math.max(1, half);
    const innerPx = Math.max(half * 0.5, originPx - strokePx);
    const sx: number[] = [], sy: number[] = [], sz: number[] = [];
    let visible = true;
    for (const p of ink.path) {
      this.pa.set(p[0], p[1], p[2]).project(camera);
      if (this.pa.z <= -1 || this.pa.z >= 1) visible = false;
      sx.push((this.pa.x * 0.5 + 0.5) * width);
      sy.push((-this.pa.y * 0.5 + 0.5) * height);
      sz.push(this.pa.z);
    }
    ink.ribbon.mesh.visible = visible;
    ink.nodes.mesh.visible = visible;
    if (ink.hollow) ink.hollow.mesh.visible = visible;
    if (!visible) return;
    const lx: number[] = [], ly: number[] = [], rx: number[] = [], ry: number[] = [];
    for (let i = 0; i < n; i++) {
      const pi = i - 1, ni = i + 1;
      const d1x = pi >= 0 ? sx[i]! - sx[pi]! : 0;
      const d1y = pi >= 0 ? sy[i]! - sy[pi]! : 0;
      const d2x = ni < n ? sx[ni]! - sx[i]! : 0;
      const d2y = ni < n ? sy[ni]! - sy[i]! : 0;
      const l1 = Math.hypot(d1x, d1y), l2 = Math.hypot(d2x, d2y);
      const ok1 = l1 > 1e-6, ok2 = l2 > 1e-6;
      let ox = 0, oy = 0;
      if (ok1 && ok2) {
        const n1x = -d1y / l1, n1y = d1x / l1;
        const n2x = -d2y / l2, n2y = d2x / l2;
        let mx = n1x + n2x, my = n1y + n2y;
        const ml = Math.hypot(mx, my);
        if (ml > 1e-6) {
          mx /= ml; my /= ml;
          const cos = Math.max(MITRE_COS_FLOOR, mx * n2x + my * n2y);
          ox = mx / cos; oy = my / cos;
        } else { ox = n2x; oy = n2y; }
      } else if (ok2) { ox = -d2y / l2; oy = d2x / l2; }
      else if (ok1) { ox = -d1y / l1; oy = d1x / l1; }
      lx.push(sx[i]! + ox * half); ly.push(sy[i]! + oy * half);
      rx.push(sx[i]! - ox * half); ry.push(sy[i]! - oy * half);
    }
    const writer = (part: InkPart): ((x: number, y: number, z: number) => void) => {
      const arr = part.attr.array as Float32Array;
      let at = 0;
      return (x: number, y: number, z: number): void => {
        arr[at++] = (x / width) * 2 - 1;
        arr[at++] = 1 - (y / height) * 2;
        arr[at++] = z;
      };
    };
    const disc = (
      put: (x: number, y: number, z: number) => void,
      cx: number, cy: number, cz: number, r: number,
    ): void => {
      for (let k = 0; k < DISC_SEGMENTS; k++) {
        const a0 = (k / DISC_SEGMENTS) * Math.PI * 2;
        const a1 = ((k + 1) / DISC_SEGMENTS) * Math.PI * 2;
        put(cx, cy, cz);
        put(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, cz);
        put(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, cz);
      }
    };
    const wr = writer(ink.ribbon);
    for (let i = 0; i + 1 < n; i++) {
      const z0 = sz[i]!, z1 = sz[i + 1]!;
      wr(lx[i]!, ly[i]!, z0); wr(rx[i]!, ry[i]!, z0); wr(rx[i + 1]!, ry[i + 1]!, z1);
      wr(lx[i]!, ly[i]!, z0); wr(rx[i + 1]!, ry[i + 1]!, z1); wr(lx[i + 1]!, ly[i + 1]!, z1);
    }
    // A round disc at every vertex is both the round join and the round cap. The accent is opaque,
    // so where a disc overlaps the ribbon nothing blends twice.
    for (let i = 0; i < n; i++) disc(wr, sx[i]!, sy[i]!, sz[i]!, half);
    ink.ribbon.attr.needsUpdate = true;
    const wn = writer(ink.nodes);
    for (let i = 1; i < n; i++) disc(wn, sx[i]!, sy[i]!, sz[i]!, dotPx);
    disc(wn, sx[0]!, sy[0]!, sz[0]!, originPx);
    ink.nodes.attr.needsUpdate = true;
    if (ink.hollow) {
      const wh = writer(ink.hollow);
      disc(wh, sx[0]!, sy[0]!, sz[0]!, innerPx);
      ink.hollow.attr.needsUpdate = true;
    }
  }

  // ---- the label: text only, takes no pointer --------------------------------------------------
  private addLabel(entry: Entry, at: WorldPoint, main: string, sub: string | undefined, hex: string): void {
    if (main === '') return;
    const el = this.labelLayer.createDiv({ cls: 'atlas3d-tactical-pill atlas3d-measure-label' });
    // A new element has no left/top until updateScreenLabels places it. Visible before that, it
    // paints one frame at the layer's static origin — the corner — which is the blink on rebuild.
    el.addClass('is-hidden');
    el.style.setProperty(PILL_COLOR_VAR, hex);
    el.style.pointerEvents = 'none';
    el.style.display = 'inline-flex';
    el.style.alignItems = 'baseline';
    el.style.gap = '5px';
    el.style.padding = '2px 8px';
    el.style.borderRadius = '999px';
    el.style.background = plateRgba(canvasBadgeTheme(this.host).background, 0.95);
    el.style.border = `1px solid ${hex}`;
    el.style.boxShadow = '0 0 0 1px rgba(0,0,0,.35), 0 2px 8px -3px rgba(0,0,0,.8)';
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
  /**
   * The shared shell, as MeasureHandles.draw() draws it: a dark hairline outside the plate, the
   * theme's plate at 0.95, and the coloured ring stroked INSIDE the plate's edge — not flush with
   * it. Atlas leaves half a pixel of plate outside the ring, which is what makes the dot read as a
   * disc wearing a ring rather than a coloured circle. The ring's colour is `measureRingColor`:
   * WCAG contrast 3 against that plate, moved the least it can, so fire keeps its exact hue.
   */
  private handleShell(
    cls: string, radius: number, hit: number, hex: string, title: string,
    ringInset = RING_INSET, ringWidth = RING_WIDTH,
  ): { el: HTMLElement; ring: HTMLElement } {
    const theme = canvasBadgeTheme(this.host);
    const tint = measureRingColor(hex, this.host);
    const r = radius * HANDLE_SCALE;
    const size = Math.max(r, hit * HANDLE_SCALE) * 2;
    const el = this.labelLayer.createDiv({
      cls: `atlas3d-measure-handle ${cls}`,
      attr: { role: 'button', tabindex: '0', title, 'aria-label': title },
    });
    // Born hidden for the same reason a label is: no left/top until it is placed.
    el.addClass('is-hidden');
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
    ring.style.position = 'relative';
    ring.style.width = `${r * 2}px`;
    ring.style.height = `${r * 2}px`;
    ring.style.borderRadius = '50%';
    ring.style.boxSizing = 'border-box';
    ring.style.display = 'grid';
    ring.style.placeItems = 'center';
    ring.style.background = plateRgba(theme.background, 0.95);
    ring.style.boxShadow = '0 0 0 1px rgba(0,0,0,.35), 0 1px 5px -1px rgba(0,0,0,.85)';
    ring.style.outlineOffset = '2px';
    ring.style.transition = 'transform .12s';
    // The coloured band: a stroke of `ringWidth` centred `ringInset` inside the plate's edge.
    const band = ring.createDiv();
    const d = Math.max(2, 2 * (r - (ringInset - ringWidth / 2)));
    band.style.position = 'absolute';
    band.style.left = `${(r * 2 - d) / 2}px`;
    band.style.top = `${(r * 2 - d) / 2}px`;
    band.style.width = `${d}px`;
    band.style.height = `${d}px`;
    band.style.border = `${ringWidth}px solid ${tint}`;
    band.style.borderRadius = '50%';
    band.style.boxSizing = 'border-box';
    band.style.opacity = String(RING_ALPHA);
    band.style.pointerEvents = 'none';
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
    const size = HANDLE_GLYPH * HANDLE_SCALE;
    const glyph = ring.createDiv();
    glyph.style.width = `${size}px`;
    glyph.style.height = `${size}px`;
    glyph.style.color = badgeInk(this.host);
    glyph.style.display = 'grid';
    glyph.style.placeItems = 'center';
    glyph.style.pointerEvents = 'none';
    const paths = SHAPE_GLYPH[shape] ?? SHAPE_GLYPH.square!;
    const body = paths.map((d) => `<path d="${d}"/>`).join('');
    glyph.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
    // The measurement's OWN first point, at its own height, lifted exactly as the ink is: the badge
    // and the start of the line are then the same projected point at any zoom or bearing.
    const y = a.configY !== null ? a.configY : this.regionTop(region, ctx, a.config, ceilingY);
    const lift = region.path ? PATH_LIFT : BORDER_LIFT;
    const handle: HandleEntry = {
      el, ring, worldPos: new THREE.Vector3(a.config.x, y + lift, a.config.z),
      part: 'origin', hex,
      bearer: a.bearer ? { x: a.bearer.x, z: a.bearer.z } : null,
      rim: a.rim,
      anchor: a.bearer ? { x: a.bearer.x, z: a.bearer.z } : a.centre,
      direction: a.direction, offset: a.offset, planeY: y + lift, start: a.reach,
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

  /** The far dot. It resizes AND turns; a press on it never opens the popover. */
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

  /**
   * The turn dot: beside the far one, its ring thinner and tighter, and two arrows chasing each
   * other round it in the badge's ink — `drawTurnHandle`. It ONLY turns.
   */
  private addTurnHandle(
    entry: Entry, id: string, a: Anchors, hex: string,
    ceilingY: number, ctx: TacticalOverlayContext,
  ): void {
    if (!a.end) return;
    const { el, ring } = this.handleShell(
      'is-turn', TURN_RADIUS, TURN_HIT, hex, 'Drag to turn the area',
      TURN_RING_INSET, TURN_RING_WIDTH,
    );
    ring.style.cursor = 'grab';
    const size = TURN_RADIUS * 2 * HANDLE_SCALE;
    const glyph = ring.createDiv();
    glyph.style.width = `${size}px`;
    glyph.style.height = `${size}px`;
    glyph.style.display = 'grid';
    glyph.style.placeItems = 'center';
    glyph.style.pointerEvents = 'none';
    glyph.innerHTML = turnGlyphSvg(size, badgeInk(this.host));
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

  /**
   * The reach AND the way the pointer lies from the anchor. The far dot emits both, so it can be
   * carried around the area; the turn dot keeps the reach it was grabbed at and emits the way
   * alone, which is what turns a figure without resizing it.
   */
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
    // Same reason as a measurement's label: it has no place until it is projected.
    pill.addClass('is-hidden');
    pill.createSpan({ cls: 'atlas3d-tactical-main', text: spec.label });
    if (spec.locked) pill.createSpan({ cls: 'atlas3d-tactical-sub', text: 'Locked (click to reset)' });
    this.losPill = { el: pill, worldPos: new THREE.Vector3(spec.target[0], spec.target[1] + 1.28, spec.target[2]) };
  }
}