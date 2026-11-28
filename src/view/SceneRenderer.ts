import * as THREE from 'three';
import type { AtlasMeasurementSettings, MovementRules } from '../atlas/measureRules';
import type { AreaTokenTarget } from '../terrain/measureGeometry';
import type { BlockMap } from '../terrain/blocks';
import { computeLayout, type Layout } from '../terrain/layout';
import { TokenLayer, type ScreenPoint, type TokenDragInfo, type TokenPlacementContext, type TokenSpec } from '../tokens/TokenLayer';
import { CameraController, type CameraKind, type PanDirection, type ViewPreset } from '../camera/CameraController';
import { GridLayer, type GridStyle } from '../grid/GridLayer';
import {
  TacticalOverlays,
  type LosDisplay,
  type MeasureDisplay,
  type MeasureResize,
  type TacticalOverlayContext,
} from './TacticalOverlays';
import { TerrainMeshes } from './TerrainMeshes';
import { ToolOverlays, type GhostSpec, type MoveTargetSpec } from './ToolOverlays';

export type Tool = 'orbit' | 'raise' | 'lower' | 'build' | 'move' | 'measure' | 'los';
export type {
  CameraKind,
  GhostSpec,
  LosDisplay,
  MeasureDisplay,
  MeasureResize,
  MoveTargetSpec,
  PanDirection,
  ScreenPoint,
  TacticalOverlayContext,
  TokenDragInfo,
  TokenSpec,
  ViewPreset,
};

/**
 * The WebGL scene orchestrator: TerrainMeshes, GridLayer, CameraController, TokenLayer,
 * ToolOverlays and TacticalOverlays, composed and drawn on invalidation.
 *
 * It is the one place the tactical layer's hooks are forwarded to the scene. The overlay draws
 * Atlas' own handles — the badge on a token's rim that opens Atlas' measurement popover, and the
 * far dot that resizes an area or an aura — but draws neither until the scene wires the matching
 * callback, because a control that does nothing is worse than no control:
 *
 *   onOpenMeasurePopover -> the scene calls Atlas' `openMeasurePopover(id)`
 *   onMeasureResize      -> the scene turns cells into what Atlas stores and writes it
 *
 * `MeasureContextData` carries the map's Snap (a dragged reach fits to whole cells or tenths) and
 * each token's LIFT — its elevation above its own floor in world units. The overlay composes
 * that with the terrain floor it already samples to tell a token inside an area's FOOTPRINT from
 * one its VOLUME actually reaches: a flier 15ft up is in a ground cube's footprint but out of its
 * effect, and only the lift can say so. Unset reads as every token standing on its floor.
 *
 * `setOpenMeasurePopover` lets the scene point the badge's accent ring at whichever measurement
 * Atlas itself has open (`binding.measurePopoverId()`), so the ring follows Atlas rather than our
 * own press — including when Atlas closes its popover on a store change we never saw.
 *
 * The view's azimuth is handed to `updateScreenLabels` every frame: a badge sits on its token's
 * rim, and the rim offset is turned by the camera so the badge stays at the lower left of the
 * token ON SCREEN at any orbit, as the token HUD's own widgets do.
 *
 * Rendering is by invalidation, never a loop of its own: `draw()` re-arms while the camera has
 * motion left or the tactical layer has a fade running.
 */

export interface TerrainSource {
  /** The terrain being shown; a getter, because it is replaced when the scene changes. */
  readonly map: BlockMap;
}

export interface GridSpec {
  size: number;
  offsetX: number;
  offsetY: number;
  lines: boolean;
  style: GridStyle;
}

/** The map image. The renderer takes ownership of the texture and disposes it when replaced. */
export interface MapSpec { widthPx: number; heightPx: number; texture: THREE.Texture | null }
export interface SurfaceHit { point: THREE.Vector3; normal: THREE.Vector3 }
export interface MoveSurfaceHit { point: THREE.Vector3; floorCeiling: number }

/** What the scene hands the tactical layer so areas, ranges and auras measure as Atlas does. */
export interface MeasureContextData {
  rules?: AtlasMeasurementSettings;
  movement?: MovementRules;
  tokens?: readonly AreaTokenTarget[];
  selectedIds?: readonly string[];
  speed?: number | null;
  /** Atlas' Snap: off, a token stands anywhere and a reach is sized freely, in tenths. */
  snapToGrid?: boolean;
  /**
   * Each token's elevation above its own floor, in world units (game units / unitDistance),
   * keyed by token id. The overlay adds it to the terrain floor it samples, to separate the
   * footprint (Atlas' cells) from the volume's reach (our spatial reading). Unset: every token
   * reads as standing on its floor, so no flier is told apart until the scene feeds this.
   */
  lifts?: Readonly<Record<string, number>>;
}

function sampleTextureLuminance(texture: THREE.Texture | null | undefined): number {
  const image = texture?.image as CanvasImageSource | undefined;
  if (!image) return 0.5;
  try {
    const canvas = createEl('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext('2d');
    if (!ctx) return 0.5;
    ctx.drawImage(image, 0, 0, 16, 16);
    const data = ctx.getImageData(0, 0, 16, 16).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += (0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0)) / 255;
    }
    return sum / (data.length / 4);
  } catch {
    return 0.5;
  }
}

export class SceneRenderer {
  readonly canvas: HTMLCanvasElement;
  onFrame: (() => void) | null = null;
  onUnpinMeasure: ((id: string) => void) | null = null;
  /** Called by a measurement pill's Select (N) button; the scene selects those tokens in Atlas. */
  onSelectTokens: ((ids: readonly string[]) => void) | null = null;
  /**
   * A measurement's origin badge was pressed. The scene opens Atlas' OWN options popover
   * (`openMeasurePopover(id)`); nothing of ours is drawn. Unset: no badge is drawn at all.
   */
  onOpenMeasurePopover: ((id: string) => void) | null = null;
  /**
   * A measurement's far handle was dragged to a new reach, in cells. The scene turns that into
   * what Atlas stores — an aura's game units and the points it then holds, or an area's moved
   * end — and writes it. Unset: no far handle is drawn at all.
   */
  onMeasureResize: ((change: MeasureResize) => void) | null = null;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly raycaster = new THREE.Raycaster();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly terrain = new TerrainMeshes();
  private readonly gridLayer = new GridLayer();
  private readonly tokens = new TokenLayer();
  private readonly overlays = new ToolOverlays();
  private readonly tactical: TacticalOverlays;
  private readonly cameraRig: CameraController;
  private readonly forward = new THREE.Vector3();
  private map: MapSpec | null = null;
  private mapLuminance = 0.5;
  private grid: GridSpec | null = null;
  private layout: Layout | null = null;
  private maxLayer: number | null = null;
  private frame = 0;
  private disposed = false;
  private readonly center = new THREE.Vector3();
  private measureCtx: MeasureContextData = {};

  constructor(private readonly host: HTMLElement, private readonly source: TerrainSource) {
    this.canvas = host.createEl('canvas', { cls: 'atlas3d-canvas' });
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setClearColor(0x14161a);
    this.tactical = new TacticalOverlays(host, (id) => this.onUnpinMeasure?.(id));
    this.tactical.onSelectTokens = (ids) => this.onSelectTokens?.(ids);
    this.tactical.onOpenMeasurePopover = (id) => this.onOpenMeasurePopover?.(id);
    this.tactical.onMeasureResize = (change) => this.onMeasureResize?.(change);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x6a6f7a, 1.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-8, 14, 6);
    this.scene.add(sun, this.terrain.group, this.gridLayer.group, this.tokens.group);
    this.overlays.addTo(this.scene);
    this.tactical.addTo(this.scene);
    this.cameraRig = new CameraController(this.canvas, () => this.invalidate());
    this.setTool('orbit');
    this.resize();
  }

  get maxTextureSize(): number {
    return this.renderer.capabilities.maxTextureSize;
  }

  get showsImage(): boolean {
    return this.source.map.surface === 'image' && this.map?.texture != null;
  }

  get hasImage(): boolean {
    return this.map?.texture != null;
  }

  get placementGrid(): { originX: number; originZ: number; layerHeight: number } {
    return { originX: this.layout?.originX ?? 0, originZ: this.layout?.originZ ?? 0, layerHeight: this.source.map.layerHeight };
  }

  layoutRef(): Layout | null {
    return this.layout;
  }

  currentCeilingY(): number {
    return this.ceilingY();
  }

  /** The scene feeds rules, token footprints, selection, Snap and lifts so the tactical layer measures as Atlas. */
  setMeasureContext(data: MeasureContextData): void {
    this.measureCtx = data;
  }

  /**
   * Which measurement's options Atlas has open, so the origin badge's accent ring follows Atlas
   * rather than our own press. The scene reads it from `binding.measurePopoverId()` on every
   * snapshot; a null clears the ring. Cheap to call unchanged: the overlay ignores a same-id set.
   */
  setOpenMeasurePopover(id: string | null): void {
    this.tactical.setOpenMeasurePopover(id);
  }

  tacticalContext(): TacticalOverlayContext | null {
    if (!this.layout) return null;
    return {
      layout: this.layout,
      map: this.source.map,
      maxLayer: this.maxLayer ?? Infinity,
      gridSize: this.grid?.size ?? 1,
      ...this.measureCtx,
    };
  }

  // ---- scene content -------------------------------------------------------------------

  setMap(map: MapSpec | null): void {
    if (this.map?.texture && this.map.texture !== map?.texture) this.map.texture.dispose();
    this.map = map;
    this.mapLuminance = map?.texture ? sampleTextureLuminance(map.texture) : 0.5;
    this.rebuildTerrain();
  }

  setGrid(grid: GridSpec | null): void {
    const old = this.grid;
    const sameGeom = old === grid || (old !== null && grid !== null
      && old.size === grid.size
      && old.offsetX === grid.offsetX
      && old.offsetY === grid.offsetY
      && old.lines === grid.lines
      && old.style.lineType === grid.style.lineType
      && old.style.cellNumbers === grid.style.cellNumbers);
    const sameStyle = old?.style.color === grid?.style.color
      && old?.style.opacity === grid?.style.opacity
      && old?.style.lineType === grid?.style.lineType
      && old?.style.lineWidth === grid?.style.lineWidth
      && old?.style.cellNumbers === grid?.style.cellNumbers
      && old?.style.numberOpacity === grid?.style.numberOpacity;
    this.grid = grid;
    if (grid && !sameStyle) {
      this.gridLayer.setGridStyle(this.resolveGridStyle(grid.style));
      this.invalidate();
    }
    if (!sameGeom) this.rebuildTerrain();
  }

  setMaxLayer(maxLayer: number | null): void {
    const normalized = maxLayer === null ? null : Math.max(0, Math.round(maxLayer));
    if (this.maxLayer === normalized) return;
    this.maxLayer = normalized;
    this.terrain.setMaxLayer(normalized);
    this.gridLayer.setMaxLayer(normalized);
    this.tokens.placeAll(this.tokenContext());
    this.invalidate();
  }

  rebuildTerrain(): void {
    const grid = this.grid;
    if (!grid || grid.size <= 0) {
      this.layout = null;
      this.terrain.setOptions(null);
      this.terrain.rebuildAll();
      this.gridLayer.setOptions(null);
      this.gridLayer.rebuildAll();
      this.tokens.placeAll(null);
      this.invalidate();
      return;
    }
    const bm = this.source.map;
    const layout = computeLayout({ image: this.map, grid, extent: bm.extent });
    const useImage = this.showsImage;
    this.layout = layout;
    this.terrain.imageMaterial.map = useImage ? (this.map?.texture ?? null) : null;
    this.terrain.imageMaterial.color.set(useImage ? 0xffffff : 0x6b7280);
    this.terrain.imageMaterial.needsUpdate = true;
    this.terrain.setOptions({
      map: bm,
      layout,
      useImage,
      checker: !useImage,
      maxLayer: this.maxLayer ?? undefined,
    });
    this.gridLayer.setOptions({
      map: bm,
      layout,
      gridLines: grid.lines,
      lineType: grid.style.lineType,
      cellNumbers: grid.style.cellNumbers,
      maxLayer: this.maxLayer ?? undefined,
    });
    this.gridLayer.setGridStyle(this.resolveGridStyle(grid.style));
    this.terrain.rebuildAll();
    this.gridLayer.rebuildAll();
    const { x0, x1, z0, z1 } = layout.bounds;
    this.center.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
    this.cameraRig.setBounds(Math.max(x1 - x0, z1 - z0) * 0.75);
    this.tokens.placeAll(this.tokenContext());
    this.invalidate();
  }

  touchCell(x: number, z: number): void {
    this.terrain.markDirty(x, z);
    this.gridLayer.markDirty(x, z);
    this.invalidate();
  }

  inBounds(cx: number, cz: number): boolean {
    const r = this.layout?.range;
    return r !== undefined && cx >= r.cx0 && cx <= r.cx1 && cz >= r.cz0 && cz <= r.cz1;
  }

  // ---- tokens & overlays ---------------------------------------------------------------

  setTokens(specs: readonly TokenSpec[]): void {
    this.tokens.setTokens(specs, this.tokenContext());
    this.invalidate();
  }

  tokenDragInfo(id: string): TokenDragInfo | null {
    return this.tokens.dragInfoOf(id, this.tokenContext());
  }

  previewToken(id: string, position: { x: number; y: number } | null, ceilingY?: number): void {
    if (this.tokens.previewToken(id, position, this.tokenContext(), ceilingY)) this.invalidate();
  }

  setMoveTarget(spec: MoveTargetSpec | null): void {
    if (this.overlays.setMoveTarget(spec, this.layout, this.source.map, this.ceilingY())) this.invalidate();
  }

  setCursor(cell: { cx: number; cy: number } | null, brush: number, tool: Tool): void {
    const mode = tool === 'raise' || tool === 'lower' ? tool : null;
    if (this.overlays.setCursor(cell, brush, mode, this.layout, this.source.map, this.ceilingY())) {
      this.invalidate();
    }
  }

  setGhost(spec: GhostSpec | null): void {
    if (this.overlays.setGhost(spec, this.layout, this.source.map.layerHeight)) this.invalidate();
  }

  setMeasure(active: MeasureDisplay | null, pinned: readonly MeasureDisplay[]): void {
    this.tactical.setMeasure(active, pinned, this.tacticalContext());
    this.invalidate();
  }

  setLos(spec: LosDisplay | null): void {
    this.tactical.setLos(spec);
    this.invalidate();
  }

  // ---- camera --------------------------------------------------------------------------

  setTool(tool: Tool): void {
    this.cameraRig.setOrbitEnabledButtons(tool === 'orbit');
  }

  setCameraKind(kind: CameraKind): void {
    this.cameraRig.setKind(kind);
  }

  applyPreset(preset: ViewPreset): void {
    this.cameraRig.applyPreset(preset, this.center);
  }

  rotateRelative(deltaDeg: number): void {
    this.cameraRig.rotateRelative(deltaDeg);
  }

  focusOnPoint(point: THREE.Vector3): void {
    this.cameraRig.focusOnPoint(point);
  }

  focusOnToken(id: string): boolean {
    const pos = this.tokens.positionOf(id, this.tokenContext());
    if (!pos) return false;
    this.cameraRig.focusOnPoint(pos);
    return true;
  }

  focusOnCenter(): void {
    this.cameraRig.focusOnPoint(this.center);
  }

  setPanKey(dir: PanDirection, active: boolean): void {
    this.cameraRig.setPanKey(dir, active);
  }

  clearPanKeys(): void {
    this.cameraRig.clearPanKeys();
  }

  /**
   * Horizontal viewing direction in degrees (`0°` = -Z North, `90°` = +X East, `180°` = +Z South,
   * `270°` = -X West). Read every frame, so the scratch vector is reused rather than allocated.
   */
  cameraAzimuthDeg(): number {
    const forward = this.forward;
    this.cameraRig.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) {
      forward.setFromMatrixColumn(this.cameraRig.camera.matrixWorld, 1);
      forward.y = 0;
    }
    if (forward.lengthSq() < 1e-6) return 0;
    const rad = Math.atan2(forward.x, -forward.z);
    return ((rad * 180) / Math.PI + 360) % 360;
  }

  resize(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (width === 0 || height === 0) return;
    this.renderer.setPixelRatio(this.host.win.devicePixelRatio || 1);
    this.renderer.setSize(width, height, false);
    this.gridLayer.setResolution(width, height);
    this.cameraRig.resize(width, height);
  }

  // ---- picking & projection ------------------------------------------------------------

  pickToken(event: MouseEvent): string | null {
    this.aim(event);
    return this.tokens.pick(this.raycaster);
  }

  pickSurface(event: MouseEvent): SurfaceHit | null {
    this.aim(event);
    const hit = this.raycaster.intersectObjects(this.terrain.pickTargets(), false)[0];
    if (!hit?.face) return null;
    return { point: hit.point.clone(), normal: hit.face.normal.clone() };
  }

  pickGround(event: MouseEvent): THREE.Vector3 | null {
    const hit = this.pickSurface(event);
    return hit ? hit.point.addScaledVector(hit.normal, -0.02) : null;
  }

  pickPlane(event: MouseEvent, planeY: number): THREE.Vector3 | null {
    return this.pickPlaneAt(event.clientX, event.clientY, planeY);
  }

  pickPlaneAt(clientX: number, clientY: number, planeY: number): THREE.Vector3 | null {
    if (!this.aimAt(clientX, clientY)) return null;
    this.groundPlane.constant = -planeY;
    const hit = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.groundPlane, hit) ? hit : null;
  }

  pickGroundOrPlane(event: MouseEvent, planeY: number = 0): THREE.Vector3 | null {
    const terrainPoint = this.pickGround(event);
    if (terrainPoint) return terrainPoint;
    return this.pickPlane(event, planeY);
  }

  /** Picks a 3D point for Measure / LoS, snapping XZ to cell center and surface height when `snap` is true. */
  pickMeasurePoint(event: MouseEvent, snap: boolean): THREE.Vector3 | null {
    const hit = this.pickSurface(event);
    const layout = this.layout;
    if (hit) {
      const p = hit.point.clone().addScaledVector(hit.normal, -0.005);
      if (!snap || !layout) return p;
      const cx = Math.floor(p.x - layout.originX);
      const cz = Math.floor(p.z - layout.originZ);
      const cap = hit.normal.y > 0.35
        ? Math.min(this.ceilingY(), p.y + 0.3)
        : Math.min(this.ceilingY(), p.y + 0.05);
      const sy = this.source.map.surfaceHeightAt(cx + 0.5, cz + 0.5, cap);
      return new THREE.Vector3(layout.originX + cx + 0.5, sy, layout.originZ + cz + 0.5);
    }
    const planeHit = this.pickPlane(event, 0);
    if (!planeHit || !layout) return planeHit;
    if (!snap) return planeHit;
    const cx = Math.floor(planeHit.x - layout.originX);
    const cz = Math.floor(planeHit.z - layout.originZ);
    return new THREE.Vector3(layout.originX + cx + 0.5, 0, layout.originZ + cz + 0.5);
  }

  /**
   * Resolves a surface point for smooth token dragging: walkable top faces track their exact height,
   * while grazing vertical side walls projects onto `fallbackPlaneY` so tokens don't jump onto roofs.
   */
  pickMoveSurface(event: MouseEvent, fallbackPlaneY: number): MoveSurfaceHit | null {
    return this.pickMoveSurfaceAt(event.clientX, event.clientY, fallbackPlaneY);
  }

  pickMoveSurfaceAt(clientX: number, clientY: number, fallbackPlaneY: number): MoveSurfaceHit | null {
    if (!this.aimAt(clientX, clientY)) return null;
    const hit = this.raycaster.intersectObjects(this.terrain.pickTargets(), false)[0];
    if (hit?.face) {
      if (hit.face.normal.y > 0.35) {
        return {
          point: hit.point.clone(),
          floorCeiling: Math.min(this.ceilingY(), hit.point.y),
        };
      }
      this.groundPlane.constant = -fallbackPlaneY;
      const planeHit = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(this.groundPlane, planeHit)) {
        return { point: planeHit, floorCeiling: Math.min(this.ceilingY(), fallbackPlaneY) };
      }
      const nudged = hit.point.clone().addScaledVector(hit.face.normal, 0.15);
      return { point: nudged, floorCeiling: Math.min(this.ceilingY(), fallbackPlaneY) };
    }
    this.groundPlane.constant = -fallbackPlaneY;
    const outHit = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.groundPlane, outHit)
      ? { point: outHit, floorCeiling: Math.min(this.ceilingY(), fallbackPlaneY) }
      : null;
  }

  projectToClient(x: number, y: number, z: number): { x: number; y: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const v = new THREE.Vector3(x, y, z).project(this.cameraRig.camera);
    if (v.z <= -1 || v.z >= 1) return null;
    return {
      x: rect.left + (v.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-v.y * 0.5 + 0.5) * rect.height,
    };
  }

  pickCell(event: MouseEvent): { cx: number; cy: number } | null {
    const point = this.pickGround(event);
    return point ? this.cellAt(point.x, point.z) : null;
  }

  cellAt(x: number, z: number): { cx: number; cy: number } | null {
    const layout = this.layout;
    if (!layout) return null;
    return { cx: Math.floor(x - layout.originX), cy: Math.floor(z - layout.originZ) };
  }

  screenPoints(): ScreenPoint[] {
    return this.tokens.screenPoints(this.cameraRig.camera, this.host.clientWidth, this.host.clientHeight);
  }

  // ---- lifecycle -----------------------------------------------------------------------

  invalidate(): void {
    if (this.frame !== 0 || this.disposed) return;
    this.frame = this.host.win.requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame !== 0) this.host.win.cancelAnimationFrame(this.frame);
    this.cameraRig.dispose();
    // The map texture is this file's to dispose: TerrainMeshes.dispose() disposes whatever its
    // image material still points at, which is the SAME texture. Letting go of it first is what
    // keeps it from being disposed twice.
    this.terrain.imageMaterial.map = null;
    this.terrain.dispose();
    this.gridLayer.dispose();
    this.tokens.dispose();
    this.overlays.dispose();
    this.tactical.dispose();
    this.map?.texture?.dispose();
    this.map = null;
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }

  // ---- internals -----------------------------------------------------------------------

  private tokenContext(): TokenPlacementContext | null {
    if (!this.grid || this.grid.size <= 0 || !this.layout) return null;
    return {
      gridSize: this.grid.size,
      layout: this.layout,
      map: this.source.map,
      ceilingY: this.ceilingY(),
    };
  }

  private resolveGridStyle(style: GridStyle): GridStyle {
    const raw = style.color.trim().toLowerCase();
    if (raw === 'auto' || raw === 'contrast' || raw === '') {
      const autoColor = this.showsImage ? (this.mapLuminance > 0.5 ? '#000000' : '#ffffff') : '#ffffff';
      return { ...style, color: autoColor };
    }
    return style;
  }

  private ceilingY(): number {
    return this.maxLayer === null ? Infinity : this.maxLayer * this.source.map.layerHeight;
  }

  private draw(): void {
    if (this.disposed) return;
    const animating = this.cameraRig.stepMotion();
    this.terrain.flush();
    this.gridLayer.flush();
    this.tokens.placeAll(this.tokenContext());
    this.tokens.updateBillboards(this.cameraRig.camera, this.cameraRig.polarAngle);
    this.renderer.render(this.scene, this.cameraRig.camera);
    // After the render, so the camera's world matrix is the one just drawn: a badge's rim offset
    // is turned by this bearing, and reading a stale one would put it a frame behind the orbit.
    this.tactical.updateScreenLabels(
      this.cameraRig.camera,
      this.host.clientWidth,
      this.host.clientHeight,
      this.cameraAzimuthDeg(),
    );
    this.onFrame?.();
    if (animating || this.tactical.isAnimating()) this.invalidate();
  }

  private aim(event: MouseEvent): boolean {
    return this.aimAt(event.clientX, event.clientY);
  }

  private aimAt(clientX: number, clientY: number): boolean {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.cameraRig.camera);
    return true;
  }
}