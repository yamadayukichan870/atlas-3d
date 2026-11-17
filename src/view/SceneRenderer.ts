import * as THREE from 'three';
import { CameraController, type CameraKind, type PanDirection, type ViewPreset } from '../camera/CameraController';
import { GridLayer, type GridStyle } from '../grid/GridLayer';
import type { BlockMap } from '../terrain/blocks';
import { computeLayout, type Layout } from '../terrain/layout';
import { TokenLayer, type ScreenPoint, type TokenDragInfo, type TokenPlacementContext, type TokenSpec } from '../tokens/TokenLayer';
import {
  TacticalOverlays,
  type LosDisplay,
  type MeasureDisplay,
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
  MoveTargetSpec,
  PanDirection,
  ScreenPoint,
  TacticalOverlayContext,
  TokenDragInfo,
  TokenSpec,
  ViewPreset,
};

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

function sampleTextureLuminance(texture: THREE.Texture | null | undefined): number {
  const image = texture?.image as CanvasImageSource | undefined;
  if (!image) return 0.5;
  try {
    const sample = createEl('canvas');
    sample.width = 16;
    sample.height = 16;
    const ctx = sample.getContext('2d');
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

/**
 * Lightweight WebGL scene orchestrator composing TerrainMeshes, GridLayer, CameraController,
 * TokenLayer, ToolOverlays and TacticalOverlays.
 */
export class SceneRenderer {
  readonly canvas: HTMLCanvasElement;
  onFrame: (() => void) | null = null;
  onUnpinMeasure: ((id: string) => void) | null = null;

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

  private map: MapSpec | null = null;
  private mapLuminance = 0.5;
  private grid: GridSpec | null = null;
  private layout: Layout | null = null;
  private maxLayer: number | null = null;
  private frame = 0;
  private disposed = false;
  private readonly center = new THREE.Vector3();

  constructor(private readonly host: HTMLElement, private readonly source: TerrainSource) {
    this.canvas = host.createEl('canvas', { cls: 'atlas3d-canvas' });
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setClearColor(0x14161a);

    this.tactical = new TacticalOverlays(host, (id) => this.onUnpinMeasure?.(id));

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

  tacticalContext(): TacticalOverlayContext | null {
    if (!this.layout) return null;
    return {
      layout: this.layout,
      map: this.source.map,
      maxLayer: this.maxLayer ?? Infinity,
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

  /** Horizontal viewing direction in degrees (`0°` = -Z North, `90°` = +X East, `180°` = +Z South, `270°` = -X West). */
  cameraAzimuthDeg(): number {
    const forward = new THREE.Vector3();
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
    if (!planeHit) return null;
    if (!snap || !layout) return planeHit;
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
    this.terrain.dispose();
    this.gridLayer.dispose();
    this.tokens.dispose();
    this.overlays.dispose();
    this.tactical.dispose();
    this.map?.texture?.dispose();
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
    this.tactical.updateScreenLabels(this.cameraRig.camera, this.host.clientWidth, this.host.clientHeight);
    this.onFrame?.();
    if (animating) this.invalidate();
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