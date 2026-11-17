import { Component, Notice, type WorkspaceLeaf } from 'obsidian';
import * as THREE from 'three';
import { AtlasBinding, atlasPlugin, pickAtlasLeaf, sceneStoreOf } from '../atlas/bridge';
import { inferDefs, resourcesOf } from '../atlas/resources';
import type { AtlasConditionDef, AtlasGrid, AtlasResourceDef, AtlasToken, SceneSnapshot } from '../atlas/types';
import type { PanDirection } from '../camera/CameraController';
import type { CellNumberMode } from '../grid/cellNumbers';
import type { GridLineType } from '../grid/gridGeometry';
import type { GridStyle } from '../grid/GridLayer';
import type Atlas3DPlugin from '../main';
import { BlockMap, normalizeRotation, type BlockChange, type FacingAngle, type Rotation, type Surface } from '../terrain/blocks';
import type { AoEShape } from '../terrain/raycast';
import { TokenHud, type HudCondition, type HudToken } from '../tokens/TokenHud';
import { Interaction } from '../tools/Interaction';
import type { BuildState, MeasureState } from '../tools/ToolController';
import { BuildDock } from '../ui/BuildDock';
import { TerrainInfoWidget } from '../ui/TerrainInfoWidget';
import { Toolbar } from '../ui/Toolbar';
import { SceneRenderer, type GridSpec, type Tool, type TokenSpec } from './SceneRenderer';
import { TextureLoader } from './textures';

const HISTORY_LIMIT = 100;
const DEFAULT_UNIT = 5;

export interface Scene3DOptions {
  host: HTMLElement;
  embedded: boolean;
  leaf: WorkspaceLeaf | null;
  selfLeaf: WorkspaceLeaf | null;
  onExit?: () => void;
  onDock?: (followed: WorkspaceLeaf | null) => void;
}

const tokenName = (token: AtlasToken): string =>
  token.name?.trim() || token.statblockName?.trim() || token.imagePath.split('/').pop()?.replace(/\.[^.]+$/, '') || 'Token';

const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const scratchColor = new THREE.Color();

function normalizeColor(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  const lower = s.toLowerCase();
  if (lower === 'auto' || lower === 'contrast' || lower === '') return 'contrast';
  if (HEX_COLOR.test(s)) return s;
  try {
    scratchColor.set(s);
    return `#${scratchColor.getHexString()}`;
  } catch {
    return '#000000';
  }
}

function normalizeOpacity(raw: unknown, fallback: number): number {
  const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  return Math.min(1, Math.max(0.05, v > 1 ? v / 100 : v));
}

function resolveCellNumbers(raw: unknown): CellNumberMode {
  if (raw === true) return 'a1';
  if (typeof raw !== 'string') return 'off';
  const norm = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (norm === '' || norm === 'off' || norm === 'none' || norm === 'false') return 'off';
  if (norm.includes('seq') || norm.includes('123') || norm === 'number' || norm === 'numbers' || norm === 'count') return 'sequential';
  if (norm.includes('col') || norm.includes('0101') || norm.includes('coord') || norm.includes('row')) return 'col-row';
  return 'a1';
}

function resolveUnitLabel(grid: AtlasGrid | null | undefined): string {
  const custom = grid?.unitName?.trim();
  if (custom) return custom;
  const u = grid?.unit?.trim().toLowerCase() ?? '';
  if (u === 'feet' || u === 'foot' || u === 'ft') return 'ft';
  if (u === 'meters' || u === 'meter' || u === 'm') return 'm';
  if (u === 'squares' || u === 'square' || u === 'sq') return 'sq';
  if (u === 'units' || u === 'unit' || u === 'u' || u === '') {
    return (grid?.unitDistanceOverride ?? grid?.unitDistance ?? 1) === 5 ? 'ft' : 'u';
  }
  return u;
}

function resolveGridStyle(grid: AtlasGrid): GridStyle {
  const rawType = typeof grid.lineType === 'string' ? grid.lineType.toLowerCase() : 'solid';
  const lineType: GridLineType = rawType === 'dashed' || rawType === 'dotted' ? rawType : 'solid';
  const rawWidth = typeof grid.lineWidth === 'number' && Number.isFinite(grid.lineWidth) ? grid.lineWidth : 1;
  const lineWidth = Math.min(12, Math.max(0.5, rawWidth));
  const opacity = normalizeOpacity(grid.opacity, 0.35);
  const numberOpacity = normalizeOpacity(
    grid.numberOpacity ?? grid.cellNumberOpacity ?? grid.cellNumbersOpacity,
    Math.min(1, opacity + 0.3),
  );
  return {
    color: normalizeColor(grid.color),
    opacity,
    lineType,
    lineWidth,
    cellNumbers: resolveCellNumbers(grid.cellNumbers),
    numberOpacity,
  };
}

function panDirectionOf(key: string): PanDirection | null {
  switch (key.toLowerCase()) {
    case 'arrowup':
      return 'up';
    case 'arrowdown':
      return 'down';
    case 'arrowleft':
      return 'left';
    case 'arrowright':
      return 'right';
    default:
      return null;
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
}

function isTokenDefeated(token: AtlasToken): boolean {
  const hp = token.resources?.hp ?? token.resources?.health;
  return hp !== undefined && hp.max > 0 && hp.current <= 0;
}

/**
 * One 3D map of one Atlas scene: links AtlasBinding, TerrainStore, SceneRenderer, Interaction and UI.
 */
export class Scene3D extends Component {
  private stage!: HTMLElement;
  private renderer!: SceneRenderer;
  private toolbar!: Toolbar;
  private buildDock!: BuildDock;
  private tokenHud!: TokenHud;
  private terrainInfo!: TerrainInfoWidget;
  private interaction!: Interaction;
  private readonly binding = new AtlasBinding((snapshot) => this.onScene(snapshot));
  private readonly textures: TextureLoader;
  private followed: WorkspaceLeaf | null = null;

  private terrain = new BlockMap();
  private sceneKey: string | null = null;
  private background: string | null = null;
  private snapshot: SceneSnapshot | null = null;
  private tokensById = new Map<string, AtlasToken>();
  private defs: AtlasResourceDef[] = [];
  private conditionDefs = new Map<string, AtlasConditionDef>();
  private readonly tokenTextures = new Map<string, THREE.Texture>();
  private readonly tokenLoading = new Set<string>();
  private history: BlockChange[][] = [];
  private build: BuildState = { mode: 'add', shape: 'Solid', rot: 0, top: null };
  private measure: MeasureState = { shape: 'line', keep: false };
  private measurePinCount = 0;
  private selectedId: string | null = null;
  private lastAtlasSelection: string | null = null;
  private lastAtlasTool: string | null = null;
  private showGrid = true;
  private tool: Tool = 'orbit';
  private sliceLayer: number | null = null;
  private lastSliceLayer: number | null = null;
  private sceneLoad = 0;
  private mapLoad = 0;
  private hoverId: string | null = null;
  private warnedMenu = false;
  private closed = false;
  private safeAreaFrame = 0;

  constructor(private readonly plugin: Atlas3DPlugin, private readonly opts: Scene3DOptions) {
    super();
    this.textures = new TextureLoader(plugin.app);
  }

  override onload(): void {
    const { host, embedded } = this.opts;
    this.stage = host.createDiv({ cls: embedded ? 'atlas3d-stage is-embedded' : 'atlas3d-stage' });
    this.stage.tabIndex = -1;

    const scene = this;
    this.renderer = new SceneRenderer(this.stage, {
      get map() { return scene.terrain; },
    });
    this.renderer.onUnpinMeasure = (id) => this.interaction.unpinMeasure(id);

    this.toolbar = new Toolbar(this.stage, {
      onTool: (tool) => this.setTool(tool),
      onBrush: (size) => { this.interaction.brush = size; this.toolbar.setBrush(size); },
      onMeasureShape: (shape) => this.setMeasureShape(shape),
      onMeasureKeep: () => this.toggleMeasureKeep(),
      onMeasureClear: () => this.interaction.clearPinnedMeasures(),
      onPreset: (preset) => this.renderer.applyPreset(preset),
      onRotateView: (deltaDeg) => this.renderer.rotateRelative(deltaDeg),
      onCenter: () => this.centerCamera(),
      onCamera: (kind) => this.renderer.setCameraKind(kind),
      onGrid: (on) => { this.showGrid = on; this.applyGrid(); },
      onUndo: () => this.undo(),
      onSurface: (surface) => this.setSurface(surface),
      onLayer: () => this.toggleLayer(),
      onSliceToggle: () => this.toggleSlice(),
      onSliceStep: (delta) => this.stepSlice(delta),
      onExit: this.opts.onExit,
      onDock: this.opts.onDock ? () => this.opts.onDock?.(this.followed) : undefined,
    });

    this.buildDock = new BuildDock(this.stage, {
      onMode: (mode) => this.setBuild({ mode }),
      onShape: (shape) => this.setBuild({ shape }),
      onRotate: () => this.turnPiece(1),
      onColor: (top) => this.setBuild({ top }),
    });

    this.tokenHud = new TokenHud(this.stage, {
      onStepResource: (id, key, delta) => { this.binding.stepResource(id, key, delta); },
      onStepElevation: (id, delta) => this.stepTokenElevation(id, delta),
      onToggleCondition: (id, conditionId) => { this.binding.toggleCondition(id, conditionId); },
      onOpenEditor: (id) => { this.binding.openEditModal(id); },
      onRotateToken: (id, rotation) => { this.binding.setTokenRotation(id, rotation); },
      onResizeToken: (id, size) => { this.binding.setTokenSize(id, size); },
      onToggleFlip: (id) => this.toggleTokenFlip(id),
      onSetFacing: (id, facing) => this.setTokenFacing(id, facing),
    });

    this.terrainInfo = new TerrainInfoWidget(this.stage);

    this.interaction = new Interaction(this.renderer, {
      map: () => this.terrain,
      build: () => this.build,
      measure: () => this.measure,
      unit: () => this.measureUnit(),
      canEdit: () => this.canEdit(),
      onStrokeEnd: (changes) => this.recordStroke(changes),
      onSelect: (id) => this.select(id),
      onHover: (id, x, y) => this.hover(id, x, y),
      onHoverTerrain: (point) => this.updateTerrainInfo(point),
      onContextMenu: (id, x, y) => this.contextMenu(id, x, y),
      diameterOf: (id) => { const t = this.tokensById.get(id); return t ? 2 * (t.size ?? 1) - 1 : null; },
      onMoveToken: (id, x, y, floorCeiling) => this.moveToken(id, x, y, floorCeiling),
      onMeasurePinCountChange: (count) => {
        this.measurePinCount = count;
        this.toolbar.setMeasureState(this.measure, count);
      },
      canMove: () => this.canEdit(),
      grid: () => this.snapshot?.grid ?? null,
    });

    this.buildDock.setBuild(this.build);
    this.toolbar.setMeasureState(this.measure, this.measurePinCount);
    this.syncTerrainUi();
    this.renderer.onFrame = () => this.refreshHud();

    const observer = new ResizeObserver(() => {
      this.renderer.resize();
      if (embedded) this.scheduleSafeAreaSync();
    });
    observer.observe(this.stage);
    this.register(() => observer.disconnect());

    if (embedded) this.setupChromeSafeArea(host);

    this.registerDomEvent(this.stage, 'pointerdown', () => this.stage.focus({ preventScroll: true }));
    this.registerDomEvent(this.stage, 'keydown', (event: KeyboardEvent) => this.onKey(event));
    this.registerDomEvent(this.stage, 'keyup', (event: KeyboardEvent) => this.onKeyUp(event));
    this.registerDomEvent(this.stage, 'blur', () => this.clearInputState());
    this.registerDomEvent(this.stage.win, 'blur', () => this.clearInputState());

    if (this.opts.embedded) {
      this.follow(this.opts.leaf);
    } else {
      this.registerEvent(this.plugin.app.workspace.on('active-leaf-change', (leaf) => {
        if (leaf && leaf !== this.opts.selfLeaf && sceneStoreOf(leaf) !== null) this.follow(leaf);
      }));
      this.registerEvent(this.plugin.app.workspace.on('layout-change', () => {
        if (!this.binding.attached) this.follow(pickAtlasLeaf(this.plugin.app, null));
      }));
      this.follow(pickAtlasLeaf(this.plugin.app, null));
    }
  }

  override onunload(): void {
    this.closed = true;
    if (this.safeAreaFrame !== 0) this.stage.win.cancelAnimationFrame(this.safeAreaFrame);
    this.binding.detach();
    this.interaction.dispose();
    this.terrainInfo.dispose();
    this.renderer.dispose();
    this.stage.remove();
    void this.textures.dispose();
    void this.plugin.terrain.flush();
  }

  // ---- embedded safe area --------------------------------------------------------------------

  private setupChromeSafeArea(host: HTMLElement): void {
    const viewEl = host.parentElement;
    if (!viewEl) return;

    const mutation = new MutationObserver(() => this.scheduleSafeAreaSync());
    mutation.observe(viewEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    this.register(() => mutation.disconnect());
    this.scheduleSafeAreaSync();
  }

  private scheduleSafeAreaSync(): void {
    if (this.safeAreaFrame !== 0 || this.closed) return;
    this.safeAreaFrame = this.stage.win.requestAnimationFrame(() => {
      this.safeAreaFrame = 0;
      if (!this.closed) this.syncChromeSafeArea();
    });
  }

  private syncChromeSafeArea(): void {
    const viewEl = this.opts.host.parentElement;
    if (!viewEl) return;
    const frame = viewEl.getBoundingClientRect();
    if (frame.width === 0) return;

    const startEl = viewEl.querySelector('.atlas-top-bar-start') as HTMLElement | null;
    const endEl = viewEl.querySelector('.atlas-top-bar-end') as HTMLElement | null;
    const levelEl = viewEl.querySelector('.atlas-level-switcher') as HTMLElement | null;

    const startRect = startEl ? startEl.getBoundingClientRect() : null;
    const endRect = endEl ? endEl.getBoundingClientRect() : null;
    const leftReserve = startRect && startRect.width > 0 ? Math.max(8, Math.ceil(startRect.right - frame.left + 8)) : 8;
    const rightReserve = endRect && endRect.width > 0 ? Math.max(8, Math.ceil(frame.right - endEl.getBoundingClientRect().left + 8)) : 8;

    const firstGroup = this.toolbar.el.firstElementChild as HTMLElement | null;
    const groupsWidth = Array.from(this.toolbar.el.children)
      .filter((el) => !el.hasClass('is-hidden') && el !== this.toolbar.el.lastElementChild)
      .reduce((sum, el) => sum + (el as HTMLElement).offsetWidth + 8, 0) || (firstGroup?.offsetWidth ?? 420);
    const availableMiddle = frame.width - leftReserve - rightReserve;

    if (availableMiddle >= groupsWidth || !startRect || startRect.height === 0) {
      this.stage.style.setProperty('--atlas3d-tb-top', '8px');
      this.stage.style.setProperty('--atlas3d-tb-left', `${leftReserve}px`);
      this.stage.style.setProperty('--atlas3d-tb-right', `${rightReserve}px`);
    } else {
      const belowStart = Math.ceil(startRect.bottom - frame.top + 8);
      this.stage.style.setProperty('--atlas3d-tb-top', `${belowStart}px`);
      this.stage.style.setProperty('--atlas3d-tb-left', '8px');
      this.stage.style.setProperty('--atlas3d-tb-right', `${rightReserve}px`);
    }

    const levelRect = levelEl ? levelEl.getBoundingClientRect() : null;
    const dockLeft = levelRect && levelRect.width > 0 ? Math.ceil(levelRect.right - frame.left + 10) : 8;
    const tbBottom = Math.ceil(this.toolbar.el.getBoundingClientRect().bottom - frame.top + 8);
    this.stage.style.setProperty('--atlas3d-dock-left', `${dockLeft}px`);
    this.stage.style.setProperty('--atlas3d-dock-top', `${Math.max(52, tbBottom)}px`);
  }

  // ---- following Atlas -----------------------------------------------------------------------

  private follow(leaf: WorkspaceLeaf | null): void {
    if (leaf === null) {
      this.binding.detach();
      this.toolbar.say(atlasPlugin(this.plugin.app) === undefined
        ? 'Atlas VTT is not installed or enabled.'
        : 'Open a scene in Atlas VTT to see it here.', this.tool);
      return;
    }
    if (leaf === this.followed && this.binding.attached) return;
    this.followed = leaf;
    this.binding.attach(leaf);
  }

  private isSquare(): boolean {
    const type = this.snapshot?.grid?.type;
    return type === undefined || type === 'square';
  }

  private canEdit(): boolean {
    const grid = this.snapshot?.grid;
    return grid !== null && grid !== undefined && grid.size > 0 && this.isSquare();
  }

  private measureUnit(): { distance: number; label: string } {
    const grid = this.snapshot?.grid;
    const distance = grid?.unitDistanceOverride ?? grid?.unitDistance ?? DEFAULT_UNIT;
    return { distance: distance > 0 ? distance : DEFAULT_UNIT, label: resolveUnitLabel(grid) };
  }

  private onScene(snapshot: SceneSnapshot): void {
    this.snapshot = snapshot;
    if (!snapshot.ready || snapshot.mapPath === null) {
      this.toolbar.say('Waiting for Atlas to load the scene…', this.tool);
      return;
    }
    const key = snapshot.levelId ? `${snapshot.mapPath}::${snapshot.levelId}` : snapshot.mapPath;
    const sceneChanged = key !== this.sceneKey;
    if (sceneChanged) {
      this.clearHover();
      this.interaction.clearPinnedMeasures();
      void this.switchScene(key);
    }
    if (sceneChanged || snapshot.background !== this.background) void this.loadMap(snapshot.background, sceneChanged);

    const editable = this.canEdit();
    this.toolbar.setCanEdit(editable);
    if (!editable && this.tool !== 'orbit' && this.tool !== 'measure' && this.tool !== 'los') {
      this.setTool('orbit');
    }

    // Sync Measure tool & shape with Atlas VTT's Measure (M) when exposed
    if (snapshot.activeTool !== this.lastAtlasTool) {
      this.lastAtlasTool = snapshot.activeTool;
      if (snapshot.activeTool === 'measure' && this.tool !== 'measure') this.setTool('measure');
      else if (this.tool === 'measure' && snapshot.activeTool !== null && snapshot.activeTool !== 'measure') this.setTool('orbit');
    }
    if (snapshot.measureMode !== null && snapshot.measureMode !== this.measure.shape) {
      this.setMeasureShape(snapshot.measureMode);
    }
    if (snapshot.measureKeep !== null && snapshot.measureKeep !== this.measure.keep) {
      this.measure = { ...this.measure, keep: snapshot.measureKeep };
      this.toolbar.setMeasureState(this.measure, this.measurePinCount);
    }

    this.toolbar.say(this.warning(snapshot), this.tool);

    const visibleTokens = snapshot.isPlayerView
      ? snapshot.tokens.filter((token) => token.isHidden !== true)
      : snapshot.tokens;

    this.tokensById = new Map(visibleTokens.map((token) => [token.id, token]));
    if (this.hoverId !== null && !this.tokensById.has(this.hoverId)) this.clearHover();
    this.defs = this.binding.resourceDefs() ?? inferDefs(visibleTokens);
    this.conditionDefs = new Map((this.binding.conditionDefs() ?? []).map((c) => [c.id, c]));

    const atlasSelection = snapshot.selectedIds[0] ?? null;
    if (atlasSelection !== this.lastAtlasSelection) {
      this.lastAtlasSelection = atlasSelection;
      if (atlasSelection !== null) this.selectedId = atlasSelection;
    }
    if (this.selectedId !== null && !this.tokensById.has(this.selectedId)) this.selectedId = null;
    this.applyGrid();
    this.applyTokens();
    this.interaction.refreshTactical();
    if (this.opts.embedded) this.scheduleSafeAreaSync();
  }

  private warning(snapshot: SceneSnapshot): string | null {
    const grid = snapshot.grid;
    if (!grid || grid.size <= 0) return 'This scene has no grid, which 3D needs to place tokens and terrain.';
    if (!this.isSquare()) return 'Hex grids are not supported yet: the map and tokens show, terrain editing and moving tokens are off.';
    return null;
  }

  private async switchScene(key: string): Promise<void> {
    const mine = ++this.sceneLoad;
    await this.plugin.terrain.flush();
    this.sceneKey = key;
    this.history = [];
    this.sliceLayer = null;
    this.lastSliceLayer = null;
    this.renderer.setMaxLayer(null);
    const { map, migrated } = await this.plugin.terrain.load(key);
    if (mine !== this.sceneLoad || this.closed) return;
    this.terrain = map;
    if (migrated) this.saveTerrain();
    this.renderer.rebuildTerrain();
    this.syncTerrainUi();
    this.applyTokens();
    this.interaction.refreshTactical();
  }

  private async loadMap(path: string | null, frame: boolean): Promise<void> {
    const mine = ++this.mapLoad;
    this.background = path;
    if (path === null) { this.renderer.setMap(null); this.syncTerrainUi(); return; }
    const size = Math.min(this.renderer.maxTextureSize, this.plugin.settings.maxMapTexture);
    const image = await this.textures.map(path, size);
    if (mine !== this.mapLoad || this.closed) { image?.texture.dispose(); return; }
    if (!image) {
      this.renderer.setMap(null);
      this.syncTerrainUi();
      new Notice(`Atlas 3D could not read the map image: ${path}`);
      return;
    }
    this.renderer.setMap({ widthPx: image.width, heightPx: image.height, texture: image.texture });
    this.syncTerrainUi();
    if (frame) this.renderer.applyPreset('iso');
  }

  private applyGrid(): void {
    const grid = this.snapshot?.grid;
    if (!grid || grid.size <= 0) { this.renderer.setGrid(null); return; }
    const spec: GridSpec = {
      size: grid.size,
      offsetX: grid.offsetX,
      offsetY: grid.offsetY,
      lines: this.showGrid && grid.enabled && grid.visible !== false && this.isSquare(),
      style: resolveGridStyle(grid),
    };
    this.renderer.setGrid(spec);
  }

  private applyTokens(): void {
    const snapshot = this.snapshot;
    const grid = snapshot?.grid;
    if (!snapshot || !grid) return;
    const unit = grid.unitDistanceOverride ?? grid.unitDistance ?? DEFAULT_UNIT;
    const specs: TokenSpec[] = [...this.tokensById.values()].map((token) => {
      const meta = this.terrain.getTokenMeta(token.id);
      return {
        id: token.id,
        x: token.x,
        y: token.y,
        diameter: 2 * (token.size ?? 1) - 1,
        lift: unit > 0 ? (token.elevation ?? 0) / unit : 0,
        rotation: token.rotation ?? 0,
        flipX: meta?.flipX === true,
        facing: meta?.facing ?? 0,
        floorY: meta?.floorY,
        texture: this.tokenTexture(token.imagePath),
        ring: token.ringColor ?? '#ffffff',
        showRing: token.showRing !== false,
        hidden: token.isHidden === true,
        defeated: isTokenDefeated(token),
        selected: token.id === this.selectedId,
      };
    });
    this.renderer.setTokens(specs);
  }

  private tokenTexture(path: string): THREE.Texture | null {
    const ready = this.tokenTextures.get(path);
    if (ready) return ready;
    if (!this.tokenLoading.has(path)) {
      this.tokenLoading.add(path);
      void this.textures.token(path).then((image) => {
        if (!image || this.closed) return;
        this.tokenTextures.set(path, image.texture);
        this.applyTokens();
      });
    }
    return null;
  }

  // ---- camera & vertical cutaway --------------------------------------------------------------

  private centerCamera(): void {
    if (this.selectedId !== null && this.renderer.focusOnToken(this.selectedId)) return;
    this.renderer.focusOnCenter();
  }

  private maxOccupiedLayer(): number {
    let max = 0;
    this.terrain.forEach((b) => { if (b.y > max) max = b.y; });
    return max;
  }

  private toggleSlice(): void {
    const max = this.maxOccupiedLayer();
    if (this.sliceLayer !== null) {
      this.lastSliceLayer = this.sliceLayer;
      this.setSlice(null);
      return;
    }
    if (max <= 0) return;
    const target = this.lastSliceLayer !== null ? Math.min(this.lastSliceLayer, max) : Math.max(0, max - 1);
    this.setSlice(target);
  }

  private stepSlice(delta: -1 | 1): void {
    const max = this.maxOccupiedLayer();
    if (this.sliceLayer === null) {
      if (delta < 0 && max > 0) this.setSlice(Math.max(0, max - 1));
      return;
    }
    const next = this.sliceLayer + delta;
    if (next < 0) this.setSlice(0);
    else if (next > max) this.setSlice(null);
    else this.setSlice(next);
  }

  private setSlice(layer: number | null): void {
    this.sliceLayer = layer;
    this.renderer.setMaxLayer(layer);
    this.syncTerrainUi();
    this.interaction.refreshTactical();
  }

  // ---- editing & keyboard ---------------------------------------------------------------------

  private onKey(event: KeyboardEvent): void {
    if (isEditableTarget(event.target)) return;
    const key = event.key.toLowerCase();
    const command = event.ctrlKey || event.metaKey;

    if (event.key === 'Escape' && (this.tool === 'measure' || this.tool === 'los')) {
      event.preventDefault();
      event.stopPropagation();
      this.interaction.cancelActiveTool();
      return;
    }
    if (event.code === 'Space' && this.tool === 'measure' && this.interaction.addMeasureWaypoint()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (command && !event.shiftKey && key === 'z') {
      if (this.history.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      this.undo();
      return;
    }
    if (event.key === 'Alt') {
      this.interaction.setAlt(true);
      return;
    }
    if (!command && event.altKey) {
      if (key === 'q' || key === 'e') {
        event.preventDefault();
        event.stopPropagation();
        this.renderer.rotateRelative(key === 'q' ? -90 : 90);
        return;
      }
      if (key === 'h') {
        event.preventDefault();
        event.stopPropagation();
        this.centerCamera();
        return;
      }
    }
    if (command || event.altKey) return;

    if (key === '[' || key === ']') {
      event.preventDefault();
      event.stopPropagation();
      this.renderer.rotateRelative(key === '[' ? -90 : 90);
      return;
    }
    if (key === 'home') {
      event.preventDefault();
      event.stopPropagation();
      this.centerCamera();
      return;
    }
    if (key === 'pageup' || key === 'pagedown') {
      event.preventDefault();
      event.stopPropagation();
      this.stepSlice(key === 'pageup' ? 1 : -1);
      return;
    }
    if (key === 'r' && this.tool === 'build') {
      event.preventDefault();
      event.stopPropagation();
      this.turnPiece(event.shiftKey ? -1 : 1);
      return;
    }
    const pan = panDirectionOf(event.key);
    if (pan && (this.stage.doc.activeElement === this.stage || this.stage.contains(this.stage.doc.activeElement))) {
      event.preventDefault();
      event.stopPropagation();
      this.renderer.setPanKey(pan, true);
    }
  }

  private onKeyUp(event: KeyboardEvent): void {
    if (event.key === 'Alt') this.interaction.setAlt(false);
    const pan = panDirectionOf(event.key);
    if (pan) this.renderer.setPanKey(pan, false);
  }

  private clearInputState(): void {
    this.interaction.setAlt(false);
    this.renderer.clearPanKeys();
  }

  private setTool(tool: Tool): void {
    this.tool = tool;
    this.interaction.setTool(tool);
    this.toolbar.setTool(tool);
    this.buildDock.setVisible(tool === 'build');
    const lockTokens = tool === 'build' || tool === 'raise' || tool === 'lower' || tool === 'measure' || tool === 'los';
    this.stage.toggleClass('is-editing-terrain', lockTokens);
    if (lockTokens) this.clearHover();
    this.toolbar.say(this.snapshot ? this.warning(this.snapshot) : null, tool);
    if (this.opts.embedded) this.scheduleSafeAreaSync();
  }

  private setMeasureShape(shape: AoEShape): void {
    this.measure = { ...this.measure, shape };
    this.toolbar.setMeasureState(this.measure, this.measurePinCount);
    this.interaction.refreshTactical();
  }

  private toggleMeasureKeep(): void {
    this.measure = { ...this.measure, keep: !this.measure.keep };
    this.toolbar.setMeasureState(this.measure, this.measurePinCount);
  }

  private recordStroke(changes: BlockChange[]): void {
    this.history.push(changes);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.saveTerrain();
    this.syncTerrainUi();
  }

  private undo(): void {
    const changes = this.history.pop();
    if (!changes) return;
    this.terrain.apply(changes, 'undo');
    for (const c of changes) this.renderer.touchCell(c.x, c.z);
    this.saveTerrain();
    this.syncTerrainUi();
    this.interaction.refreshTactical();
  }

  private setBuild(change: Partial<BuildState>): void {
    this.build = { ...this.build, ...change };
    this.buildDock.setBuild(this.build);
    this.interaction.refreshGhost();
  }

  private turnPiece(steps: number): void {
    const rot = normalizeRotation(this.build.rot + steps * 90) as Rotation;
    this.setBuild({ rot });
  }

  private setSurface(surface: Surface): void {
    this.terrain.surface = surface;
    this.saveTerrain();
    this.renderer.rebuildTerrain();
    this.syncTerrainUi();
  }

  private toggleLayer(): void {
    this.terrain.layerHeight = this.terrain.layerHeight === 1 ? 0.5 : 1;
    this.saveTerrain();
    this.renderer.rebuildTerrain();
    this.syncTerrainUi();
    this.interaction.refreshTactical();
  }

  private syncTerrainUi(): void {
    this.toolbar.setSurface(this.terrain.surface, this.renderer.hasImage);
    this.toolbar.setLayer(this.terrain.layerHeight);
    this.toolbar.setSlice(this.sliceLayer, this.maxOccupiedLayer());
  }

  private saveTerrain(): void {
    if (this.sceneKey !== null) this.plugin.terrain.schedule(this.sceneKey, this.terrain);
  }

  private moveToken(id: string, x: number, y: number, floorCeiling?: number): void {
    const grid = this.snapshot?.grid;
    if (grid && grid.size > 0) {
      const pg = this.renderer.placementGrid;
      const gx = x / grid.size - pg.originX;
      const gz = y / grid.size - pg.originZ;
      const sliceCap = this.sliceLayer !== null ? this.sliceLayer * pg.layerHeight : Infinity;
      const ceiling = floorCeiling !== undefined ? Math.min(sliceCap, floorCeiling) : sliceCap;
      const floorY = this.terrain.surfaceHeightAt(gx, gz, ceiling);
      this.terrain.setTokenFloorY(id, floorY);
      this.saveTerrain();
    }
    if (!this.binding.moveTokens([{ id, x, y }])) new Notice('This version of Atlas VTT does not let other plugins move tokens.');
  }

  private stepTokenElevation(id: string, delta: number): void {
    const token = this.tokensById.get(id);
    const grid = this.snapshot?.grid;
    if (!token || !grid) return;
    const step = grid.unitDistanceOverride ?? grid.unitDistance ?? DEFAULT_UNIT;
    const next = Math.max(0, (token.elevation ?? 0) + delta * step);
    this.binding.setTokenElevation(id, next);
  }

  private toggleTokenFlip(id: string): void {
    const current = this.terrain.getTokenMeta(id)?.flipX === true;
    this.terrain.setTokenFlip(id, !current);
    this.saveTerrain();
    this.applyTokens();
  }

  private setTokenFacing(id: string, facing: FacingAngle): void {
    this.terrain.setTokenFacing(id, facing);
    this.saveTerrain();
    this.applyTokens();
  }

  private updateTerrainInfo(point: { x: number; y: number; z: number } | null): void {
    const layout = this.renderer.layoutRef();
    const grid = this.snapshot?.grid;
    if (!point || !layout || !grid || grid.size <= 0) {
      this.terrainInfo.update(null);
      return;
    }
    const cx = Math.floor(point.x - layout.originX);
    const cz = Math.floor(point.z - layout.originZ);
    if (!this.renderer.inBounds(cx, cz) && !this.terrain.topBlock(cx, cz)) {
      this.terrainInfo.update(null);
      return;
    }
    const unit = this.measureUnit();
    this.terrainInfo.update({
      cx,
      cz,
      y: point.y,
      map: this.terrain,
      layout,
      cellNumberMode: resolveCellNumbers(grid.cellNumbers),
      unitDistance: unit.distance,
      unitLabel: unit.label,
      ceilingY: this.renderer.currentCeilingY(),
    });
  }

  // ---- tokens: selection, menu, resources, statblock ----------------------------------------------

  private select(id: string | null): void {
    this.selectedId = id;
    this.lastAtlasSelection = id;
    this.binding.select(id === null ? [] : [id]);
    this.applyTokens();
  }

  private contextMenu(id: string, x: number, y: number): void {
    this.select(id);
    if (this.binding.openContextMenu(id, x, y) || this.warnedMenu) return;
    this.warnedMenu = true;
    new Notice('Atlas VTT\'s token menu cannot be reached from the 3D map in this version of Atlas.');
  }

  private hover(id: string | null, clientX: number, clientY: number): void {
    if (id === this.hoverId) return;
    this.clearHover();
    this.hoverId = id;
    if (id !== null) this.binding.showStatblock(id, clientX, clientY, this.followed);
  }

  private clearHover(): void {
    this.hoverId = null;
    this.binding.hideStatblock();
  }

  private resolveConditions(token: AtlasToken): HudCondition[] {
    const out: HudCondition[] = [];
    for (const id of token.conditions ?? []) {
      const def = this.conditionDefs.get(id);
      out.push({
        id,
        name: def?.name ?? id.replace(/[-_]/g, ' '),
        color: def?.color ?? '#a855f7',
        icon: def?.icon ?? id,
        value: token.conditionValues?.[id],
      });
    }
    return out;
  }

  private refreshHud(): void {
    const grid = this.snapshot?.grid;
    const unitName = resolveUnitLabel(grid);
    const ts = this.snapshot?.tokenSettings;
    const items: HudToken[] = [];

    for (const point of this.renderer.screenPoints()) {
      const token = this.tokensById.get(point.id);
      if (!token) continue;
      const selected = token.id === this.selectedId;
      const shown = resourcesOf(token, this.defs);
      const bars = selected
        ? shown.bars
        : shown.bars.filter((_, i) => (i === 0 ? ts?.showHpBars !== false : ts?.showSecondaryResourceBars !== false));

      const elev = token.elevation ?? 0;
      const elevationText = elev > 0 ? `+${elev} ${unitName}` : `0 ${unitName}`;
      const meta = this.terrain.getTokenMeta(token.id);

      items.push({
        ...point,
        name: tokenName(token),
        instanceNumber: token.instanceNumber ?? null,
        hidden: token.isHidden === true,
        defeated: isTokenDefeated(token),
        selected,
        rotation: token.rotation ?? 0,
        flipX: meta?.flipX === true,
        facing: meta?.facing ?? 0,
        atlasSize: token.size ?? 1,
        elevationText,
        showNameplate: selected || (ts?.showNameplates === true && Boolean(token.name?.trim())),
        showInstanceBadge: ts?.showInstanceBadges !== false,
        conditions: this.resolveConditions(token),
        bars,
        right: shown.right,
        left: shown.left,
      });
    }
    this.tokenHud.update(items, this.renderer.cameraAzimuthDeg());
  }
}