import type { App, EventRef, WorkspaceLeaf } from 'obsidian';
import {
  field,
  hideStatblockPreview,
  mapCollectionIdOf,
  openTokenEditModal,
  previewPinFor,
  readCollectionSettings,
  readConditionDefs,
  readResourceDefs,
  showStatblockPreview,
  showTokenMenu,
  type PreviewPin,
} from './internals';
import {
  ATLAS_MEASURE_SHAPES,
  DEFAULT_LINE_WIDTH_CELLS,
  MAX_AURA,
  MAX_LINE_WIDTH_CELLS,
  MAX_ORIGIN_TOKENS,
  MAX_RULER_POINTS,
  NO_MOVEMENT_RULES,
  movementSpeedFor,
  readMovementRules,
  resolveMeasurementSettings,
  type AtlasMeasureShape,
} from './measureRules';
import { parseDefs, stepValue } from './resources';
import {
  ATLAS_PLUGIN_ID,
  ATLAS_VIEW_TYPE,
  type AtlasCollectionMeasureSettings,
  type AtlasConditionDef,
  type AtlasGrid,
  type AtlasMeasure,
  type AtlasMeasureChanges,
  type AtlasMeasureMode,
  type AtlasMeasureOrigin,
  type AtlasMeasureToolState,
  type AtlasPoint,
  type AtlasResourceDef,
  type AtlasSceneRules,
  type AtlasSceneState,
  type AtlasSceneStore,
  type AtlasToken,
  type AtlasTokenAura,
  type SceneSnapshot,
} from './types';

/**
 * The one place that reads and writes an Atlas map tab's store.
 *
 * Measurement rules are not re-implemented here: they are resolved by `measureRules.ts`, which
 * was verified against atlas-vtt/atlas-vtt @ tag 0.16.0 (`grid/measurementFormat.ts`,
 * `measure/movementRules.ts`, `measure/measureTypes.ts`, `stores/measuresSlice.ts`). This file
 * only hands it what Atlas stored and passes the answer on.
 *
 * Four things it used to say differently from Atlas, all corrected here:
 *   - a movement step's factor is `multiple`, not `multiplier`;
 *   - `countPerTurn` is on only when stored as true, not by default;
 *   - a cone's end defaults to `round`, not `flat`;
 *   - a map outside a collection measures in range bands unless its grid says 'units'.
 */

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isStore(value: unknown): value is AtlasSceneStore {
  return typeof field(value, 'getState') === 'function' && typeof field(value, 'subscribe') === 'function';
}

/** The Atlas plugin instance Obsidian keeps by id, or undefined when it is not loaded. */
export function atlasPlugin(app: App): unknown {
  return field(field(field(app, 'plugins'), 'plugins'), ATLAS_PLUGIN_ID);
}

export function atlasVersion(app: App): string | null {
  const version = field(field(atlasPlugin(app), 'manifest'), 'version');
  return typeof version === 'string' ? version : null;
}

/**
 * The store of an Atlas map tab, or null for any other leaf. Deferred (not yet loaded) leaves
 * have the right view type but no `atlasStore`, so they read as null until Obsidian loads them.
 */
export function sceneStoreOf(leaf: WorkspaceLeaf): AtlasSceneStore | null {
  if (leaf.view.getViewType() !== ATLAS_VIEW_TYPE) return null;
  const view = leaf.view as unknown;
  const store = field(view, 'atlasStore') ?? (typeof field(view, 'getStore') === 'function' ? (view as { getStore(): unknown }).getStore() : null);
  return isStore(store) ? store : null;
}

export function atlasLeaves(app: App): WorkspaceLeaf[] {
  return app.workspace.getLeavesOfType(ATLAS_VIEW_TYPE).filter((leaf) => sceneStoreOf(leaf) !== null);
}

/** Keeps following `current` while it exists, else the most recent Atlas tab, else the first. */
export function pickAtlasLeaf(app: App, current: WorkspaceLeaf | null): WorkspaceLeaf | null {
  const leaves = atlasLeaves(app);
  if (current && leaves.includes(current)) return current;
  const recent = app.workspace.getMostRecentLeaf();
  if (recent && leaves.includes(recent)) return recent;
  return leaves[0] ?? null;
}

function tokensOnLevel(state: AtlasSceneState, shownId: string | undefined, firstId: string | undefined): AtlasToken[] {
  const all = Object.values(state.objects?.tokens ?? {});
  return all.filter((token) => {
    if (!token || token.offMap) return false;
    // Atlas: an object without a level stands on the first one.
    return shownId === undefined || (token.level ?? firstId) === shownId;
  });
}

/**
 * The kept measurements of the level shown, auras included.
 *
 * An aura's `points` are where it lay when it was last edited and are never rewritten when its
 * token moves, so an aura is kept whatever its points hold: its geometry comes from `aura` and
 * the token's own space. A drawn measurement needs two points to be anything.
 */
function measuresOnLevel(state: AtlasSceneState, shownId: string | undefined, firstId: string | undefined): AtlasMeasure[] {
  const all = Object.values(state.objects?.measures ?? {});
  const out: AtlasMeasure[] = [];
  for (const measure of all) {
    if (!measure || typeof measure.id !== 'string' || typeof measure.shape !== 'string') continue;
    const isAura = typeof measure.follows === 'string' && measure.follows !== ''
      && typeof measure.aura === 'number' && measure.aura > 0;
    const isDrawn = Array.isArray(measure.points) && measure.points.length >= 2;
    if (!isAura && !isDrawn) continue;
    if (shownId !== undefined && (measure.level ?? firstId) !== shownId) continue;
    out.push(measure);
  }
  return out;
}

export function normalizeMeasureMode(raw: unknown): AtlasMeasureMode | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (v === 'ruler') return 'ruler';
  if (v === 'circle' || v === 'sphere' || v === 'radius') return 'circle';
  if (v === 'cone') return 'cone';
  if (v === 'square' || v === 'cube' || v === 'box') return 'square';
  if (v === 'line' || v === 'beam') return 'line';
  if (v === 'ranges' || v === 'range') return 'ranges';
  return null;
}

function readMeasureTool(state: AtlasSceneState): AtlasMeasureToolState {
  return state.measureTool ?? state.measure ?? {};
}

/** The width the next line takes, in cells, as Atlas's tool holds it (1-20). */
function readLineWidth(tool: AtlasMeasureToolState): number | null {
  const raw = tool.lineWidth;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.min(MAX_LINE_WIDTH_CELLS, raw);
}

/** Narrows Atlas's state to what the 3D view draws: the level being shown, its tokens, measures, grid and view mode. */
export function snapshotOf(state: AtlasSceneState): SceneSnapshot {
  const levels = Array.isArray(state.levels) ? state.levels : [];
  const first = levels[0];
  const shownId = levels.length > 0 ? (state.viewedLevel ?? first?.id) : undefined;
  const shown = levels.find((level) => level.id === shownId);
  const isBase = shown === undefined || shown.id === first?.id;
  const isPlayerView = state.isPlayerView === true || state.isGMView === false;
  const activeTool = typeof state.activeTool === 'string'
    ? state.activeTool
    : (typeof state.tool === 'string' ? state.tool : null);

  const mt = readMeasureTool(state);
  const measureMode = normalizeMeasureMode(mt.mode ?? mt.shape ?? state.measureMode ?? state.measureShape);
  const measureKeep = typeof mt.keep === 'boolean'
    ? mt.keep
    : (typeof mt.persist === 'boolean' ? mt.persist : (typeof state.measureKeep === 'boolean' ? state.measureKeep : null));

  return {
    mapPath: state.mapPath ?? null,
    ready: state.mapLoaded === true && state.isMapLoading !== true,
    // Atlas: the first level's background is the scene's own `background`.
    background: isBase ? (state.background ?? null) : (shown.background ?? null),
    grid: state.grid ?? null,
    tokens: tokensOnLevel(state, shownId, first?.id),
    measures: measuresOnLevel(state, shownId, first?.id),
    selectedIds: state.selectedIds ?? [],
    levelId: isBase ? null : (shown?.id ?? null),
    isPlayerView,
    activeTool,
    measureMode,
    measureKeep,
    measurePlayers: typeof mt.players === 'boolean' ? mt.players : null,
    measureColor: typeof mt.color === 'string' ? mt.color : null,
    measureEffect: typeof mt.effect === 'string' ? mt.effect : null,
    measureLineWidth: readLineWidth(mt),
    tokenSettings: state.tokenSettings ?? null,
    turnMoves: state.turnMoves ?? {},
  };
}

/** Parts of the state whose identity decides whether the 3D view must update (Immer keeps references). */
function watched(state: AtlasSceneState): unknown[] {
  return [
    state.mapPath, state.mapLoaded, state.isMapLoading, state.background, state.grid,
    state.currentCollectionId, state.objects?.tokens, state.objects?.measures,
    state.selectedIds, state.levels, state.viewedLevel,
    state.isPlayerView, state.isGMView, state.activeTool, state.tool,
    state.measureMode, state.measureShape, state.measureKeep, state.measureTool, state.measure,
    state.tokenSettings, state.turnMoves,
  ];
}

function parseConditionDefs(raw: unknown): AtlasConditionDef[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: AtlasConditionDef[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const c = item as Record<string, unknown>;
    if (typeof c.id !== 'string' || c.id === '') continue;
    const glyph = typeof c.glyph === 'object' && c.glyph !== null ? (c.glyph as Record<string, unknown>) : null;
    const icon = typeof c.icon === 'string' ? c.icon : (typeof glyph?.icon === 'string' ? glyph.icon : 'skull');
    out.push({
      id: c.id,
      name: typeof c.name === 'string' ? c.name : c.id,
      color: typeof c.color === 'string' ? c.color : '#a855f7',
      icon,
    });
  }
  return out.length > 0 ? out : null;
}

/**
 * The rules the scene measures and moves by, resolved as Atlas resolves them: the collection's
 * grid defaults with the scene's own unit overrides, or the scene's grid when the map belongs to
 * no collection. `source` says which of the two answered, so a caller can tell "the collection
 * stores no defaults" from "there is no collection".
 */
function rulesOf(leaf: WorkspaceLeaf | null, grid: AtlasGrid | null): AtlasSceneRules {
  const collection = recordOf(readCollectionSettings(leaf));
  const defaults = recordOf(field(collection, 'gridDefaults'));
  return {
    measurement: resolveMeasurementSettings(defaults, grid),
    movement: readMovementRules(field(collection, 'movement')) ?? NO_MOVEMENT_RULES,
    source: collection !== null ? 'collection' : 'grid',
  };
}

/** A line's width in world pixels, which is what Atlas persists; cells are the tool's unit. */
function lineWidthPx(widthCells: number | undefined, gridSize: number | undefined): number | null {
  if (typeof gridSize !== 'number' || !(gridSize > 0) || !Number.isFinite(gridSize)) return null;
  const cells = typeof widthCells === 'number' && Number.isFinite(widthCells) && widthCells > 0
    ? Math.min(MAX_LINE_WIDTH_CELLS, widthCells)
    : DEFAULT_LINE_WIDTH_CELLS;
  return cells * gridSize;
}

/** What a measurement is created from. Points are world pixels, as Atlas stores them. */
export interface MeasurePayload {
  /** One of the five shapes Atlas persists; `ranges` is a tool mode and is never stored. */
  shape: AtlasMeasureShape;
  points: readonly AtlasPoint[];
  /** A line's width in CELLS; stored as `width` in world pixels. */
  widthCells?: number;
  /** `#rrggbb`; null or absent is the theme's accent, which Atlas stores as no colour at all. */
  color?: string | null;
  /** The tool's toggle. False means only the GM sees it, which Atlas stores as `hidden: true`. */
  players?: boolean;
  /** Only the GM sees it, said directly. Either this or `players: false` hides it. */
  hidden?: boolean;
  effect?: string | null;
  /** False for an area walls do not stop; absent stops at walls, as every area does. */
  walls?: boolean;
  /** The token this circle follows: an aura. Needs `aura`, and points are then only a snapshot. */
  follows?: string;
  /** How far an aura reaches from the edge of its token's space, in game units. */
  aura?: number;
  /** The level it stands on; absent is the level shown. */
  level?: string;
  origin?: AtlasMeasureOrigin;
}

/** Follows one Atlas tab's store and reports a snapshot whenever something the 3D view draws changed. */
export class AtlasBinding {
  private store: AtlasSceneStore | null = null;
  private leaf: WorkspaceLeaf | null = null;
  /** The pin Atlas was last told about, so it can be told it is gone. */
  private hovered: PreviewPin | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Atlas's own signal that a collection's settings were saved; the store does not carry them. */
  private rulesRef: EventRef | null = null;
  private last: unknown[] = [];

  constructor(private readonly onChange: (snapshot: SceneSnapshot) => void) {}

  get attached(): boolean {
    return this.store !== null;
  }

  attach(leaf: WorkspaceLeaf): boolean {
    const store = sceneStoreOf(leaf);
    if (store === null) return false;
    this.detach();
    this.store = store;
    this.leaf = leaf;
    this.last = [];
    this.unsubscribe = store.subscribe((state) => this.consider(state));
    // Collection rules are read from the asset service, not from the store, so editing them
    // changes nothing the store watches. Atlas announces the save on the workspace.
    try {
      this.rulesRef = leaf.view.app.workspace.on('atlas-vtt:collection-settings-changed', (collectionId: unknown) => {
        this.onCollectionSettingsChanged(collectionId);
      });
    } catch {
      this.rulesRef = null;
    }
    this.consider(store.getState());
    return true;
  }

  detach(): void {
    this.hideStatblock();
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.rulesRef !== null) {
      try {
        this.leaf?.view.app.workspace.offref(this.rulesRef);
      } catch {
        // The view is going away; the reference goes with it.
      }
      this.rulesRef = null;
    }
    this.store = null;
    this.leaf = null;
  }

  /** Selects tokens in Atlas itself, so its own interface reacts. False when this Atlas has no such action. */
  select(ids: readonly string[]): boolean {
    const state = this.store?.getState();
    if (state === undefined) return false;
    if (ids.length === 0) {
      if (typeof state.clearSelection !== 'function') return false;
      state.clearSelection();
      return true;
    }
    if (typeof state.setSelection !== 'function') return false;
    state.setSelection([...ids]);
    return true;
  }

  /**
   * One step of a token's resource, through Atlas's own `updateToken`, so Atlas saves it and records the
   * undo step. A resource the token does not have is left alone. False when nothing could be written.
   */
  stepResource(tokenId: string, key: string, delta: number): boolean {
    const state = this.store?.getState();
    const token = state?.objects?.tokens?.[tokenId];
    const value = token?.resources?.[key];
    if (state === undefined || !token || !value || typeof state.updateToken !== 'function') return false;
    const next = stepValue(value.current, value.max, delta);
    if (next === value.current) return true;
    state.updateToken(tokenId, { resources: { ...token.resources, [key]: { ...value, current: next } } });
    return true;
  }

  /** Writes a token's rotation (degrees) into Atlas. */
  setTokenRotation(tokenId: string, rotation: number): boolean {
    const state = this.store?.getState();
    if (state === undefined || typeof state.updateToken !== 'function') return false;
    state.updateToken(tokenId, { rotation: ((rotation % 360) + 360) % 360 });
    return true;
  }

  /** Writes a token's elevation (in game units) into Atlas. */
  setTokenElevation(tokenId: string, elevation: number): boolean {
    const state = this.store?.getState();
    if (state === undefined || typeof state.updateToken !== 'function') return false;
    state.updateToken(tokenId, { elevation });
    return true;
  }

  /** Writes a token's grid size into Atlas (1 = 1x1, 1.5 = 2x2, 2 = 3x3). */
  setTokenSize(tokenId: string, size: number): boolean {
    const state = this.store?.getState();
    if (state === undefined || typeof state.updateToken !== 'function') return false;
    state.updateToken(tokenId, { size });
    return true;
  }

  /** Toggles a condition on a token through Atlas's action or token update fallback. */
  toggleCondition(tokenId: string, conditionId: string): boolean {
    const state = this.store?.getState();
    const token = state?.objects?.tokens?.[tokenId];
    if (state === undefined || !token) return false;
    const current = token.conditions ?? [];
    const active = current.includes(conditionId);
    if (typeof state.setTokensCondition === 'function') {
      state.setTokensCondition([tokenId], conditionId, !active);
      return true;
    }
    if (typeof state.updateToken === 'function') {
      const next = active ? current.filter((c) => c !== conditionId) : [...current, conditionId];
      state.updateToken(tokenId, { conditions: next });
      return true;
    }
    return false;
  }

  /** The rules this scene measures and moves by, as Atlas resolves them. Always answers. */
  sceneRules(): AtlasSceneRules {
    return rulesOf(this.leaf, this.store?.getState().grid ?? null);
  }

  /**
   * How far a token moves: its own speed where it states one, else the collection's for creatures
   * that state none. Null where neither says, and such a token moves without steps.
   */
  tokenSpeed(tokenId: string): number | null {
    const token = this.store?.getState().objects?.tokens?.[tokenId];
    return movementSpeedFor(token?.speed, this.sceneRules().movement);
  }

  /**
   * The collection's measurement settings in the loose shape earlier callers read.
   *
   * @deprecated Read `sceneRules()` instead: it carries the resolved settings and the movement
   * rules as Atlas holds them. This projection goes away with its last consumer.
   */
  collectionMeasureSettings(): AtlasCollectionMeasureSettings {
    const rules = this.sceneRules();
    const s = rules.measurement;
    return {
      diagonalRule: s.diagonalRule,
      measurementMode: s.mode,
      abstractRangeBands: s.rangeBands.map((band) => ({ name: band.name, maxSquares: band.maxSquares })),
      coneEnd: s.coneEnd,
      movementSteps: rules.movement.steps.map((step) => ({
        name: step.name,
        color: step.color,
        multiplier: step.multiple,
      })),
      countPerTurn: rules.movement.countPerTurn,
      coneAngle: s.coneAngle,
      areaCellRule: s.areaCellRule,
      difficultTerrain: s.difficultTerrain,
      unitType: s.unitType,
      unitDistance: s.unitDistance,
      ruleDistance: s.ruleDistance,
      ...(s.unitName !== undefined && { unitName: s.unitName }),
      ...(rules.movement.speed !== undefined && { movementSpeed: rules.movement.speed }),
    };
  }

  /**
   * Keeps a measurement in Atlas, so 2D and 3D show the same thing and Atlas saves it. Returns the
   * id Atlas gave it, or null when nothing was kept — which is also what Atlas answers when the
   * level already holds its 256.
   *
   * Only fields Atlas reads are sent. `players` is translated to `hidden`, a line's width from
   * cells to world pixels, and the accent colour is sent as no colour at all: a field Atlas does
   * not know would be stored and never read.
   */
  addMeasure(payload: MeasurePayload): string | null {
    const state = this.store?.getState();
    if (state === undefined || typeof state.addMeasure !== 'function') return null;
    if (!ATLAS_MEASURE_SHAPES.includes(payload.shape)) return null;

    const follows = typeof payload.follows === 'string' && payload.follows !== '' ? payload.follows : null;
    if (follows !== null && (typeof payload.aura !== 'number' || !(payload.aura > 0))) return null;

    const points: AtlasPoint[] = [];
    for (const point of payload.points) {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
      points.push({ x: point.x, y: point.y });
      if (points.length >= MAX_RULER_POINTS) break;
    }
    if (points.length < 2 && follows === null) return null;

    const levels = Array.isArray(state.levels) ? state.levels : [];
    const level = payload.level ?? (levels.length > 0 ? (state.viewedLevel ?? levels[0]?.id) : undefined);
    const width = payload.shape === 'line' ? lineWidthPx(payload.widthCells, state.grid?.size) : null;

    const data: Record<string, unknown> = { shape: payload.shape, points };
    if (typeof level === 'string' && level !== '') data.level = level;
    if (typeof payload.color === 'string' && payload.color.trim() !== '') data.color = payload.color;
    if (payload.hidden === true || payload.players === false) data.hidden = true;
    if (typeof payload.effect === 'string' && payload.effect !== '') data.effect = payload.effect;
    if (payload.walls === false) data.walls = false;
    if (width !== null) data.width = width;
    if (follows !== null && typeof payload.aura === 'number') {
      data.follows = follows;
      data.aura = Math.min(MAX_AURA, payload.aura);
    }
    const origin = payload.origin;
    if (origin && Array.isArray(origin.tokenIds) && origin.tokenIds.length > 0) {
      data.origin = {
        tokenIds: origin.tokenIds.filter((id) => typeof id === 'string' && id !== '').slice(0, MAX_ORIGIN_TOKENS),
        unseenAtStart: origin.unseenAtStart === true,
      };
    }

    try {
      const id = state.addMeasure(data);
      return typeof id === 'string' && id !== '' ? id : null;
    } catch (error) {
      console.error('[Atlas 3D] Atlas could not keep the measurement', error);
      return null;
    }
  }

  /**
   * Changes a kept measurement. A field given as undefined is removed from it, which is how a
   * measurement goes back to the theme's accent (`color: undefined`) or loses its effect.
   */
  updateMeasure(id: string, changes: AtlasMeasureChanges): boolean {
    const state = this.store?.getState();
    if (state === undefined || typeof state.updateMeasure !== 'function') return false;
    if (!state.objects?.measures?.[id]) return false;
    const record: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(changes)) record[key] = value;
    try {
      state.updateMeasure(id, record);
      return true;
    } catch (error) {
      console.error('[Atlas 3D] Atlas could not change the measurement', error);
      return false;
    }
  }

  deleteMeasure(id: string): boolean {
    const state = this.store?.getState();
    if (state === undefined || typeof state.deleteMeasure !== 'function') return false;
    state.deleteMeasure(id);
    return true;
  }

  /** Removes every kept measurement of the level SHOWN. Other levels keep theirs. */
  clearMeasures(): boolean {
    const state = this.store?.getState();
    if (state === undefined || typeof state.clearMeasures !== 'function') return false;
    state.clearMeasures();
    return true;
  }

  /**
   * Gives tokens their auras in one undo step: a reach of 0 takes the aura away, a token that has
   * none gets one on its own level. Points are where the aura lies now; Atlas does not rewrite
   * them when the token moves, so the 3D geometry must come from the reach and the token's space.
   */
  setTokenAuras(auras: readonly AtlasTokenAura[], look?: { color?: string | null; hidden?: boolean }): boolean {
    const state = this.store?.getState();
    if (state === undefined || typeof state.setTokenAuras !== 'function') return false;
    const list: AtlasTokenAura[] = [];
    for (const entry of auras) {
      if (!entry || typeof entry.tokenId !== 'string' || entry.tokenId === '') continue;
      if (!Number.isFinite(entry.aura) || entry.aura < 0) continue;
      const points: AtlasPoint[] = Array.isArray(entry.points)
        ? entry.points.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)).map((p) => ({ x: p.x, y: p.y }))
        : [];
      list.push({ tokenId: entry.tokenId, aura: Math.min(MAX_AURA, entry.aura), points });
    }
    if (list.length === 0) return false;
    const appearance: { color?: string; hidden?: true } = {};
    if (typeof look?.color === 'string' && look.color.trim() !== '') appearance.color = look.color;
    if (look?.hidden === true) appearance.hidden = true;
    try {
      return state.setTokenAuras(list, appearance) === true;
    } catch (error) {
      console.error('[Atlas 3D] Atlas could not set the token auras', error);
      return false;
    }
  }

  setMeasureTool(updates: Partial<AtlasMeasureToolState>): boolean {
    const state = this.store?.getState();
    if (state === undefined || typeof state.setMeasureTool !== 'function') return false;
    state.setMeasureTool(updates as Record<string, unknown>);
    return true;
  }

  /** Opens Atlas's own right-click menu for a token at a screen position. False when Atlas will not. */
  openContextMenu(tokenId: string, clientX: number, clientY: number): boolean {
    const token = this.store?.getState().objects?.tokens?.[tokenId];
    return token ? showTokenMenu(this.leaf, token, clientX, clientY) : false;
  }

  /** Opens Atlas's native Edit Token modal when reachable. */
  openEditModal(tokenId: string): boolean {
    const token = this.store?.getState().objects?.tokens?.[tokenId];
    return token ? openTokenEditModal(this.leaf, token) : false;
  }

  /** The resources of the scene's collection as Atlas defines them, or null when it will not say. */
  resourceDefs(): AtlasResourceDef[] | null {
    return parseDefs(readResourceDefs(this.leaf));
  }

  /** The condition definitions of the scene's collection, or null when Atlas will not say. */
  conditionDefs(): AtlasConditionDef[] | null {
    return parseConditionDefs(readConditionDefs(this.leaf));
  }

  /**
   * Tells Atlas the pointer is over a token, so Atlas shows its own statblock window (with Ctrl held, as on its
   * own map). Only a character with a statblock note has one. `sourceLeaf` is the Atlas tab the pointer is in,
   * which decides the window it opens in. False when there is nothing to show or Atlas cannot be reached.
   */
  showStatblock(tokenId: string, clientX: number, clientY: number, sourceLeaf: WorkspaceLeaf | null): boolean {
    const token = this.store?.getState().objects?.tokens?.[tokenId];
    const pin = token ? previewPinFor(token) : null;
    if (!pin || !showStatblockPreview(this.leaf, pin, clientX, clientY, sourceLeaf)) return false;
    this.hovered = pin;
    return true;
  }

  /** Tells Atlas the pointer left the token it was over, if there was one. */
  hideStatblock(): void {
    const pin = this.hovered;
    this.hovered = null;
    if (pin) hideStatblockPreview(this.leaf, pin);
  }

  /**
   * Moves tokens through Atlas's own store action (`setTokenPositions`, `dropTokens`, or `updateToken`),
   * wrapped in a temporal undo transaction when available.
   */
  moveTokens(positions: Array<{ id: string; x: number; y: number }>): boolean {
    const state = this.store?.getState();
    if (state === undefined) return false;
    const temporal = this.store?.temporal?.getState?.();
    temporal?.beginTransaction?.();
    try {
      if (typeof state.setTokenPositions === 'function') {
        state.setTokenPositions(positions);
        return true;
      }
      if (typeof state.dropTokens === 'function') {
        state.dropTokens(positions);
        return true;
      }
      if (typeof state.updateToken === 'function') {
        for (const p of positions) state.updateToken(p.id, { x: p.x, y: p.y });
        return true;
      }
      return false;
    } finally {
      temporal?.endTransaction?.();
    }
  }

  /** A collection's rules were saved: report again, but only when they are this map's own. */
  private onCollectionSettingsChanged(collectionId: unknown): void {
    const store = this.store;
    if (store === null) return;
    if (typeof collectionId === 'string' && collectionId !== '') {
      const own = mapCollectionIdOf(this.leaf);
      if (own !== null && own !== collectionId) return;
    }
    this.last = [];
    this.consider(store.getState());
  }

  private consider(state: AtlasSceneState): void {
    const now = watched(state);
    if (now.length === this.last.length && now.every((value, i) => Object.is(value, this.last[i]))) return;
    this.last = now;
    this.onChange(snapshotOf(state));
  }
}