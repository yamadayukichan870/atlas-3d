import { Component, Notice, type WorkspaceLeaf } from 'obsidian';
import * as THREE from 'three';
import { AtlasBinding, atlasPlugin, pickAtlasLeaf, sceneStoreOf } from '../atlas/bridge';
import { ATLAS_CHROME_SELECTORS } from '../atlas/internals';
import {
  MAX_AURA,
  MAX_LINE_WIDTH_CELLS,
  formatGameUnits,
  unitLabelFor,
  type AtlasMeasureMode,
  type AtlasMeasurementSettings,
} from '../atlas/measureRules';
import { inferDefs, resourcesOf } from '../atlas/resources';
import type {
  AtlasConditionDef,
  AtlasGrid,
  AtlasMeasure,
  AtlasPoint,
  AtlasResourceDef,
  AtlasToken,
  SceneSnapshot,
} from '../atlas/types';
import type { PanDirection } from '../camera/CameraController';
import { resolveColorHex } from '../common/colors';
import type { CellNumberMode } from '../grid/cellNumbers';
import type { GridLineType } from '../grid/gridGeometry';
import type { GridStyle } from '../grid/GridLayer';
import type Atlas3DPlugin from '../main';
import { BlockMap, normalizeRotation, type BlockChange, type FacingAngle, type Rotation, type Surface } from '../terrain/blocks';
import type { AreaTokenTarget } from '../terrain/measureGeometry';
import type { AoEShape } from '../terrain/raycast';
import { TokenHud, type HudCondition, type HudToken } from '../tokens/TokenHud';
import { Interaction } from '../tools/Interaction';
import type { BuildState, MeasureState } from '../tools/ToolController';
import { BuildDock } from '../ui/BuildDock';
import { TerrainInfoWidget } from '../ui/TerrainInfoWidget';
import { Toolbar } from '../ui/Toolbar';
import { SceneRenderer, type GridSpec, type MeasureResize, type Tool, type TokenSpec } from './SceneRenderer';
import { TextureLoader } from './textures';

/**
 * One 3D map of one Atlas scene: links AtlasBinding, TerrainStore, SceneRenderer, Interaction and UI.
 *
 * This is the file that closes the circuit. Everything downstream already speaks Atlas — the rules
 * module, the geometry, the region engine, the measure tool and the overlay — but none of it could
 * reach Atlas until the scene handed it over:
 *
 *   - `measures()`      : the kept measurements and auras Atlas holds, so a measurement drawn with
 *                         Atlas' own 2D tools appears here as the same figure.
 *   - `onAddMeasure` …  : Keep writes into Atlas, the × removes it there, Clear empties the level.
 *   - `tokenTargets()`  : tokens' LOGICAL footprints, never the TileShare-offset drawing position,
 *                         so a diagonal counts whole cells however the art is nudged.
 *   - `rules()`         : the collection's rules as Atlas resolves them, cached per snapshot.
 *
 * TWO HANDLES, both Atlas' own, wired here:
 *
 *   the badge on a token's rim  -> `binding.openMeasurePopover(id)`, Atlas' store action, so the
 *                                  panel that opens is Atlas' own. The accent ring around that
 *                                  badge is fed back from `binding.measurePopoverId()` on every
 *                                  snapshot, so it follows Atlas even when Atlas closes the panel
 *                                  on a store change we never saw.
 *   the dot on the outline      -> a reach in cells AND the way the pointer lies from the anchor.
 *                                  The direction is what lets the handle be carried AROUND the
 *                                  area, and the turn dot turn it, instead of only sliding along
 *                                  the way it already lay.
 *
 * `lifts` travels with the measure context: each token's elevation above its own floor, in world
 * units, the same conversion `applyTokens` uses. It is what will let the view tell a token inside
 * an area's FOOTPRINT from one its VOLUME actually reaches — a flier 15ft up is in a ground cube's
 * footprint but out of its effect, and only the lift can say so.
 *
 * Selection is a set, not a single id: the Select (N) button of a measured area selects every token
 * inside it, in Atlas itself. The first of the set is what the camera and the HUD follow.
 *
 * Guards (`lastAtlasMode`, `lastAtlasKeep`) keep our own writes to Atlas from being read back as
 * changes from Atlas, which would loop.
 */

const HISTORY_LIMIT = 100;

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

/**
 * A grid line colour: 'auto'/'contrast' ask the renderer to pick by the map's luminance, anything
 * else is resolved to '#rrggbb' by the shared colour module. The module-level scratch THREE.Color
 * this used to keep is gone: `set` does not throw on an unknown string, it warns and leaves the
 * colour as it was, so an invalid value returned the previous valid colour's hex.
 */
function normalizeColor(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  const lower = s.toLowerCase();
  if (lower === 'auto' || lower === 'contrast' || lower === '') return 'contrast';
  return resolveColorHex(s, '#000000');
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
    case 'arrowup': return 'up';
    case 'arrowdown': return 'down';
    case 'arrowleft': return 'left';
    case 'arrowright': return 'right';
    default: return null;
  }
}

/**
 * Whether the keyboard belongs to a field rather than the map. Not `instanceof HTMLElement`:
 * that is false for an element of another window, so a popout's inputs would let shortcuts through.
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const el = target as { nodeType?: number; tagName?: string; isContentEditable?: boolean };
  if (el.nodeType !== 1) return false;
  const tag = (el.tagName ?? '').toUpperCase();
  return el.isContentEditable === true || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function isTokenDefeated(token: AtlasToken): boolean {
  const hp = token.resources?.hp ?? token.resources?.health;
  return hp !== undefined && hp.max > 0 && hp.current <= 0;
}

/** The legacy four-name shape the toolbar's fallback still speaks, for an Atlas mode. */
function legacyShapeOf(mode: AtlasMeasureMode): AoEShape {
  switch (mode) {
    case 'circle': return 'sphere';
    case 'square': return 'cube';
    case 'cone': return 'cone';
    default: return 'line';
  }
}

/** The Atlas mode a legacy toolbar shape means. The old 'line' was the multi-waypoint ruler. */
function modeOfLegacyShape(shape: AoEShape): AtlasMeasureMode {
  switch (shape) {
    case 'sphere': return 'circle';
    case 'cube': return 'square';
    case 'cone': return 'cone';
    default: return 'ruler';
  }
}

/**
 * The way a measurement's far end lies from its origin, one unit long, over the plan. Atlas'
 * `auraDirection`: the way its two points lie, and to the right where they say none. Atlas' y is
 * our z, both pointing the same way on screen, so the pair carries over unchanged.
 */
function directionOf(points: readonly AtlasPoint[]): { x: number; z: number } {
  const from = points[0];
  const to = points[1];
  if (!from || !to) return { x: 1, z: 0 };
  const dx = to.x - from.x;
  const dz = to.y - from.y;
  const length = Math.hypot(dx, dz);
  return length > 0 && Number.isFinite(length) ? { x: dx / length, z: dz / length } : { x: 1, z: 0 };
}

/** Reaches are kept to thousandths, so steps of 1.5 m never add up to 4.499999. */
const thousandth = (value: number): number => Math.round(value * 1000) / 1000;

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
  private measure: MeasureState = { shape: 'line', keep: false, mode: 'ruler' };
  private measurePinCount = 0;
  /** Every selected token; the first is the one the camera and the single-select HUD follow. */
  private selectedIds = new Set<string>();
  private selectedId: string | null = null;
  private lastAtlasSelection: string | null = null;
  private lastAtlasTool: string | null = null;
  /** Guards so a change we pushed to Atlas is not read back as a change from Atlas. */
  private lastAtlasMode: AtlasMeasureMode | null = null;
  private lastAtlasKeep: boolean | null = null;
  /** Rules are pulled from Atlas's asset service, so they are cached per snapshot, not per frame. */
  private rulesCache: ReturnType<AtlasBinding['sceneRules']> | null = null;
  private showGrid = true;
  private tool: Tool = 'orbit';
  private sliceLayer: number | null = null;
  private lastSliceLayer: number | null = null;
  private sceneLoad = 0;
  private mapLoad = 0;
  private hoverId: string | null = null;
  private warnedMenu = false;
  private warnedPopover = false;
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
    this.renderer.onSelectTokens = (ids) => this.selectMany(ids);
    this.renderer.onOpenMeasurePopover = (id) => this.openMeasureOptions(id);
    this.renderer.onMeasureResize = (change) => this.resizeMeasure(change);
    this.toolbar = new Toolbar(this.stage, {
      onTool: (tool) => this.setTool(tool),
      onBrush: (size) => { this.interaction.brush = size; this.toolbar.setBrush(size); },
      onMeasureShape: (shape) => this.setMeasureShape(shape),
      // The six-name Atlas bar: mode, Players and line width all write Atlas' own tool state.
      onMeasureMode: (mode) => this.setMeasureMode(mode),
      onMeasurePlayers: (players) => this.setMeasurePlayers(players),
      onMeasureLineWidth: (cells) => this.setMeasureLineWidth(cells),
      onMeasureKeep: () => this.toggleMeasureKeep(),
      // Clear empties the LEVEL, as Atlas's own Clear does. Local pins go with it.
      onMeasureClear: () => this.interaction.clearMeasureLevel(),
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
      // ---- Atlas, through this scene ---------------------------------------------------------
      rules: () => this.binding.sceneRules(),
      measures: () => this.visibleMeasures(),
      selectedIds: () => [...this.selectedIds],
      tokenTargets: () => this.tokenTargets(),
      isPlayerView: () => this.snapshot?.isPlayerView === true,
      onAddMeasure: (payload) => this.binding.addMeasure(payload),
      onUpdateMeasure: (id, changes) => this.binding.updateMeasure(id, changes),
      onDeleteMeasure: (id) => this.binding.deleteMeasure(id),
      onClearMeasures: () => this.binding.clearMeasures(),
      onSelectMany: (ids) => this.selectMany(ids),
      onMeasureTool: (updates) => this.binding.setMeasureTool(updates),
      onSetTokenAuras: (auras, look) => this.binding.setTokenAuras(auras, look),
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
    // The three class names are Atlas's own chrome, read from the one list the diagnostic watches:
    // a release that renames them is reported there instead of silently moving the toolbar.
    const [startSel, endSel, levelSel] = ATLAS_CHROME_SELECTORS;
    const startEl = startSel ? viewEl.querySelector(startSel) as HTMLElement | null : null;
    const endEl = endSel ? viewEl.querySelector(endSel) as HTMLElement | null : null;
    const levelEl = levelSel ? viewEl.querySelector(levelSel) as HTMLElement | null : null;
    const startRect = startEl ? startEl.getBoundingClientRect() : null;
    const endRect = endEl ? endEl.getBoundingClientRect() : null;
    const leftReserve = startRect && startRect.width > 0 ? Math.max(8, Math.ceil(startRect.right - frame.left + 8)) : 8;
    const rightReserve = endRect && endRect.width > 0 ? Math.max(8, Math.ceil(frame.right - endRect.left + 8)) : 8;
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

  /** The rules this scene measures by, cached per snapshot: they are pulled, not pushed. */
  private rules(): AtlasMeasurementSettings {
    return (this.rulesCache ??= this.binding.sceneRules()).measurement;
  }

  /** Distance and unit name as Atlas resolves them, for the tools that still take the pair. */
  private measureUnit(): { distance: number; label: string } {
    const rules = this.rules();
    return { distance: rules.unitDistance, label: unitLabelFor(rules.unitType, rules.unitName) };
  }

  /**
   * The kept measurements the view may draw. In the Player View a GM-only measurement is not
   * there, exactly as Atlas hides it on its own map. An aura whose token is hidden goes with it:
   * the region engine finds no anchor for it and draws nothing.
   */
  private visibleMeasures(): readonly AtlasMeasure[] {
    const snapshot = this.snapshot;
    if (!snapshot) return [];
    if (!snapshot.isPlayerView) return snapshot.measures;
    return snapshot.measures.filter((measure) => measure.hidden !== true);
  }

  /**
   * The tokens' LOGICAL footprints: their stored x/y over the grid, never the TileShare-offset
   * position the art is drawn at. A diagonal must count whole cells even when two tokens share
   * a cell and the drawing nudges them apart.
   */
  private tokenTargets(): AreaTokenTarget[] {
    const size = this.snapshot?.grid?.size ?? 0;
    if (!(size > 0)) return [];
    const out: AreaTokenTarget[] = [];
    for (const token of this.tokensById.values()) {
      out.push({
        id: token.id,
        x: token.x / size,
        z: token.y / size,
        diameter: 2 * (token.size ?? 1) - 1,
      });
    }
    return out;
  }

  /**
   * Each token's elevation above its own floor, in world units — the same conversion `applyTokens`
   * uses. The overlay adds it to the terrain floor it samples to separate the footprint (Atlas'
   * cells) from the volume's reach (our spatial reading).
   */
  private tokenLifts(): Record<string, number> {
    const unit = this.rules().unitDistance;
    const distance = unit > 0 ? unit : 1;
    const out: Record<string, number> = {};
    for (const token of this.tokensById.values()) {
      out[token.id] = (token.elevation ?? 0) / distance;
    }
    return out;
  }

  /**
   * Feeds the tactical layer what it needs to measure as Atlas does: the collection's rules, the
   * logical footprints, the selection, the map's Snap, each token's lift, and the speed of the
   * token the ranges would be drawn around.
   */
  private syncMeasureContext(): void {
    const rules = this.rulesCache ??= this.binding.sceneRules();
    this.renderer.setMeasureContext({
      rules: rules.measurement,
      movement: rules.movement,
      tokens: this.tokenTargets(),
      selectedIds: [...this.selectedIds],
      speed: this.selectedId !== null ? this.binding.tokenSpeed(this.selectedId) : null,
      snapToGrid: this.snapshot?.grid?.snapToGrid !== false,
      lifts: this.tokenLifts(),
    });
  }

  // ---- Atlas' own measurement handles ---------------------------------------------------------
  /**
   * The badge on a token's rim was pressed: open Atlas' OWN options popover. Nothing of ours is
   * drawn — the panel is Atlas', so it looks like the rest of Atlas and keeps up with its releases.
   *
   * Where the panel appears is Atlas's choice: it anchors it to the measurement's handle in ITS OWN
   * view. Inside an Atlas tab that is the same window; in the separate 3D pane it is the Atlas tab.
   */
  private openMeasureOptions(id: string): void {
    if (this.binding.openMeasurePopover(id)) return;
    if (this.warnedPopover) return;
    this.warnedPopover = true;
    new Notice(
      'Atlas could not open its measurement options here. They need the GM view of a loaded scene, '
      + 'and the measurement on the level shown. In the separate 3D pane the panel opens in the Atlas tab.',
    );
  }

  /**
   * A far handle was dragged to a new reach, in cells, and possibly to a new way round. Turned into
   * what Atlas stores by Atlas' own formulas and written through `updateMeasure`, so 2D and 3D move
   * together and Atlas saves it.
   *
   * The handle's own DIRECTION is used when the drag named one: that is what lets the far dot be
   * carried around the area, and the turn dot turn it, instead of only sliding along the way it
   * already lay. Where the drag named none, the measurement's stored way stands.
   *
   * An aura's reach is game units from the EDGE of its token's space, and the two points it holds
   * are a snapshot of where it then lies — Atlas never rewrites them when the token moves, which is
   * why the geometry always comes from the reach and the token's space, never from those points.
   */
  private resizeMeasure(change: MeasureResize): void {
    const snapshot = this.snapshot;
    const grid = snapshot?.grid;
    if (!snapshot || !grid || !(grid.size > 0)) return;
    // A player's picture is not edited from here, as Atlas' own guard refuses it.
    if (snapshot.isPlayerView) return;
    const measure = snapshot.measures.find((m) => m.id === change.id);
    // A local pin (Atlas refused the keep) has nothing to write to; it stays as it was drawn.
    if (!measure) return;
    const cells = Number.isFinite(change.cells) ? change.cells : 0;
    if (!(cells > 0)) return;
    const unit = this.rules().unitDistance;
    const distance = unit > 0 ? unit : 1;
    const direction = change.direction ?? directionOf(measure.points);
    const isAura = typeof measure.follows === 'string' && measure.follows !== ''
      && typeof measure.aura === 'number' && measure.aura > 0;

    if (isAura) {
      const token = this.tokensById.get(measure.follows as string);
      if (!token) return;
      const aura = Math.min(MAX_AURA, thousandth(cells * distance));
      if (!(aura > 0)) return;
      // Atlas' auraPoints, in world pixels: half the token's space, plus the reach in cells.
      const diameter = 2 * (token.size ?? 1) - 1;
      const radiusPx = (Math.max(1, diameter) * grid.size) / 2 + cells * grid.size;
      const points: AtlasPoint[] = [
        { x: token.x, y: token.y },
        { x: token.x + direction.x * radiusPx, y: token.y + direction.z * radiusPx },
      ];
      this.binding.updateMeasure(measure.id, { aura, points });
      return;
    }

    const origin = measure.points[0];
    if (!origin) return;
    const lengthPx = cells * grid.size;
    const end: AtlasPoint = {
      x: origin.x + direction.x * lengthPx,
      y: origin.y + direction.z * lengthPx,
    };
    // A ruler keeps its corners and only its end moves; an area has exactly two points.
    const points: AtlasPoint[] = measure.points.map((p, i) =>
      i === measure.points.length - 1 ? end : { x: p.x, y: p.y });
    if (points.length < 2) return;
    this.binding.updateMeasure(measure.id, { points });
  }

  private onScene(snapshot: SceneSnapshot): void {
    this.snapshot = snapshot;
    if (!snapshot.ready || snapshot.mapPath === null) {
      this.toolbar.say('Waiting for Atlas to load the scene…', this.tool);
      return;
    }
    this.rulesCache = this.binding.sceneRules();
    const key = snapshot.levelId ? `${snapshot.mapPath}::${snapshot.levelId}` : snapshot.mapPath;
    const sceneChanged = key !== this.sceneKey;
    if (sceneChanged) {
      this.clearHover();
      // Only what the 3D tool drew locally. Clearing Atlas's own measurements here would
      // delete the user's work every time they changed level.
      this.interaction.clearPinnedMeasures();
      void this.switchScene(key);
    }
    if (sceneChanged || snapshot.background !== this.background) void this.loadMap(snapshot.background, sceneChanged);
    const editable = this.canEdit();
    this.toolbar.setCanEdit(editable);
    if (!editable && this.tool !== 'orbit' && this.tool !== 'measure' && this.tool !== 'los') {
      this.setTool('orbit');
    }
    // Sync the active tool with Atlas's own, once per change so our own writes do not loop.
    if (snapshot.activeTool !== this.lastAtlasTool) {
      this.lastAtlasTool = snapshot.activeTool;
      if (snapshot.activeTool === 'measure' && this.tool !== 'measure') this.setTool('measure');
      else if (this.tool === 'measure' && snapshot.activeTool !== null && snapshot.activeTool !== 'measure') this.setTool('orbit');
    }
    if (snapshot.measureMode !== null && snapshot.measureMode !== this.lastAtlasMode) {
      this.lastAtlasMode = snapshot.measureMode;
      if (snapshot.measureMode !== this.measure.mode) {
        this.measure = { ...this.measure, mode: snapshot.measureMode, shape: legacyShapeOf(snapshot.measureMode) };
        this.toolbar.setMeasureState(this.measure, this.measurePinCount);
        this.interaction.refreshTactical();
      }
    }
    if (snapshot.measureKeep !== null && snapshot.measureKeep !== this.lastAtlasKeep) {
      this.lastAtlasKeep = snapshot.measureKeep;
      if (snapshot.measureKeep !== this.measure.keep) {
        this.measure = { ...this.measure, keep: snapshot.measureKeep };
        this.toolbar.setMeasureState(this.measure, this.measurePinCount);
      }
    }
    // The Look Atlas holds. The bar's Players toggle and width stepper read these; the tool reads
    // them when it creates a measure.
    this.measure = {
      ...this.measure,
      players: snapshot.measurePlayers ?? this.measure.players,
      color: snapshot.measureColor,
      effect: snapshot.measureEffect,
      lineWidth: snapshot.measureLineWidth ?? this.measure.lineWidth,
    };
    this.toolbar.setMeasureState(this.measure, this.measurePinCount);
    this.toolbar.say(this.warning(snapshot), this.tool);
    const visibleTokens = snapshot.isPlayerView
      ? snapshot.tokens.filter((token) => token.isHidden !== true)
      : snapshot.tokens;
    this.tokensById = new Map(visibleTokens.map((token) => [token.id, token]));
    if (this.hoverId !== null && !this.tokensById.has(this.hoverId)) this.clearHover();
    this.defs = this.binding.resourceDefs() ?? inferDefs(visibleTokens);
    this.conditionDefs = new Map((this.binding.conditionDefs() ?? []).map((c) => [c.id, c]));
    const atlasSelection = snapshot.selectedIds.join('|');
    if (atlasSelection !== this.lastAtlasSelection) {
      this.lastAtlasSelection = atlasSelection;
      this.selectedIds = new Set(snapshot.selectedIds.filter((id) => this.tokensById.has(id)));
      this.selectedId = [...this.selectedIds][0] ?? null;
    }
    for (const id of [...this.selectedIds]) {
      if (!this.tokensById.has(id)) this.selectedIds.delete(id);
    }
    if (this.selectedId !== null && !this.tokensById.has(this.selectedId)) {
      this.selectedId = [...this.selectedIds][0] ?? null;
    }
    this.applyGrid();
    this.applyTokens();
    this.syncMeasureContext();
    // The accent ring around an origin badge follows whichever measurement ATLAS has open, not
    // our own press: Atlas closes a stale popover on any store change, and we would never see it.
    this.renderer.setOpenMeasurePopover(this.binding.measurePopoverId());
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
    this.syncMeasureContext();
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
    if (!grid || grid.size <= 0) {
      this.renderer.setGrid(null);
      this.toolbar.setGrid(false);
      return;
    }
    const spec: GridSpec = {
      size: grid.size,
      offsetX: grid.offsetX,
      offsetY: grid.offsetY,
      lines: this.showGrid && grid.enabled && grid.visible !== false && this.isSquare(),
      style: resolveGridStyle(grid),
    };
    this.renderer.setGrid(spec);
    // The button reflects what is actually drawn, not just our toggle: Atlas may have the grid
    // disabled, and a button claiming "on" over an invisible grid is the desync this fixes.
    this.toolbar.setGrid(spec.lines);
  }

  private applyTokens(): void {
    const snapshot = this.snapshot;
    const grid = snapshot?.grid;
    if (!snapshot || !grid) return;
    const unit = this.rules().unitDistance;
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
        selected: this.selectedIds.has(token.id),
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
    this.syncMeasureContext();
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
    // No Space: Atlas owns it. Waypoints are Shift+click, which the measure tool already handles.
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
      // Alt+R turns the piece: bare R is Atlas's.
      if (key === 'r' && this.tool === 'build') {
        event.preventDefault();
        event.stopPropagation();
        this.turnPiece(event.shiftKey ? -1 : 1);
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

  /** A legacy shape chosen in the toolbar's fallback bar; pushed to Atlas so its Measure bar follows. */
  private setMeasureShape(shape: AoEShape): void {
    this.setMeasureMode(modeOfLegacyShape(shape));
  }

  /** One of the six Atlas modes, chosen in the 3D bar; pushed to Atlas so its own Measure bar follows. */
  private setMeasureMode(mode: AtlasMeasureMode): void {
    this.measure = { ...this.measure, mode, shape: legacyShapeOf(mode) };
    this.lastAtlasMode = mode;
    this.toolbar.setMeasureState(this.measure, this.measurePinCount);
    this.binding.setMeasureTool({ mode });
    this.interaction.refreshTactical();
  }

  /** The "Players see it" toggle; Atlas stores the inverse as `hidden` when a measure is kept. */
  private setMeasurePlayers(players: boolean): void {
    this.measure = { ...this.measure, players };
    this.toolbar.setMeasureState(this.measure, this.measurePinCount);
    this.binding.setMeasureTool({ players });
  }

  /** The next line's width in cells (1-20), as Atlas' tool holds it. */
  private setMeasureLineWidth(cells: number): void {
    const width = Math.min(MAX_LINE_WIDTH_CELLS, Math.max(1, Math.round(cells)));
    this.measure = { ...this.measure, lineWidth: width };
    this.toolbar.setMeasureState(this.measure, this.measurePinCount);
    this.binding.setMeasureTool({ lineWidth: width });
    this.interaction.refreshTactical();
  }

  private toggleMeasureKeep(): void {
    const keep = !this.measure.keep;
    this.measure = { ...this.measure, keep };
    this.lastAtlasKeep = keep;
    this.toolbar.setMeasureState(this.measure, this.measurePinCount);
    this.binding.setMeasureTool({ keep });
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
    this.syncMeasureContext();
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
    this.syncMeasureContext();
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
    if (!token) return;
    const step = this.rules().unitDistance;
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
    const rules = this.rules();
    this.terrainInfo.update({
      cx,
      cz,
      y: point.y,
      map: this.terrain,
      layout,
      cellNumberMode: resolveCellNumbers(grid.cellNumbers),
      unitDistance: rules.unitDistance,
      unitLabel: unitLabelFor(rules.unitType, rules.unitName),
      ceilingY: this.renderer.currentCeilingY(),
    });
  }

  // ---- tokens: selection, menu, resources, statblock ----------------------------------------------
  private select(id: string | null): void {
    this.selectedIds = id === null ? new Set() : new Set([id]);
    this.selectedId = id;
    this.lastAtlasSelection = id ?? '';
    this.binding.select(id === null ? [] : [id]);
    this.applyTokens();
    this.syncMeasureContext();
    this.interaction.refreshTactical();
  }

  /** The Select (N) button of a measured area: Atlas's own selection takes every token inside. */
  private selectMany(ids: readonly string[]): void {
    const kept = ids.filter((id) => this.tokensById.has(id));
    this.selectedIds = new Set(kept);
    this.selectedId = kept[0] ?? null;
    this.lastAtlasSelection = kept.join('|');
    this.binding.select(kept);
    this.applyTokens();
    this.syncMeasureContext();
    this.interaction.refreshTactical();
  }

  private contextMenu(id: string, x: number, y: number): void {
    this.select(id);
    if (this.binding.openContextMenu(id, x, y) || this.warnedMenu) return;
    this.warnedMenu = true;
    new Notice("Atlas VTT's token menu cannot be reached from the 3D map in this version of Atlas.");
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
    const rules = this.rules();
    const ts = this.snapshot?.tokenSettings;
    const items: HudToken[] = [];
    for (const point of this.renderer.screenPoints()) {
      const token = this.tokensById.get(point.id);
      if (!token) continue;
      const selected = this.selectedIds.has(token.id);
      const shown = resourcesOf(token, this.defs);
      const bars = selected
        ? shown.bars
        : shown.bars.filter((_, i) => (i === 0 ? ts?.showHpBars !== false : ts?.showSecondaryResourceBars !== false));
      const elev = token.elevation ?? 0;
      // Atlas writes the unit right after the number ("25ft"), a typed name after a space.
      const elevationText = elev > 0 ? `+${formatGameUnits(elev, rules)}` : formatGameUnits(0, rules);
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