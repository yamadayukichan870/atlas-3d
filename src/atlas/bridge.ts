import type { App, WorkspaceLeaf } from 'obsidian';
import { normalizeDiagonalRule, type ConeEndMode, type MeasureShape, type MovementStepDef, type RangeBandDef } from '../terrain/measure';
import {
  field,
  hideStatblockPreview,
  openTokenEditModal,
  previewPinFor,
  readCollectionSettings,
  readConditionDefs,
  readResourceDefs,
  showStatblockPreview,
  showTokenMenu,
  type PreviewPin,
} from './internals';
import { parseDefs, stepValue } from './resources';
import {
  ATLAS_PLUGIN_ID,
  ATLAS_VIEW_TYPE,
  type AtlasCollectionMeasureSettings,
  type AtlasConditionDef,
  type AtlasMeasure,
  type AtlasMeasureMode,
  type AtlasMeasureToolState,
  type AtlasResourceDef,
  type AtlasSceneState,
  type AtlasSceneStore,
  type AtlasToken,
  type SceneSnapshot,
} from './types';

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
    if (token.offMap) return false;
    // Atlas: an object without a level stands on the first one.
    return shownId === undefined || (token.level ?? firstId) === shownId;
  });
}

function measuresOnLevel(state: AtlasSceneState, shownId: string | undefined, firstId: string | undefined): AtlasMeasure[] {
  const all = Object.values(state.objects?.measures ?? {});
  return all.filter((m) => {
    if (!m || !Array.isArray(m.points) || m.points.length < 2) return false;
    return shownId === undefined || (m.level ?? firstId) === shownId;
  });
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

function parseRangeBands(raw: unknown): RangeBandDef[] {
  if (!Array.isArray(raw)) return [];
  const out: RangeBandDef[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const b = item as Record<string, unknown>;
    if (typeof b.name !== 'string' || !b.name.trim()) continue;
    out.push({
      name: b.name.trim(),
      squares: typeof b.squares === 'number' ? b.squares : undefined,
      maxSquares: typeof b.maxSquares === 'number' ? b.maxSquares : undefined,
      distance: typeof b.distance === 'number' ? b.distance : undefined,
    });
  }
  return out;
}

function parseMovementSteps(raw: unknown): MovementStepDef[] {
  if (!Array.isArray(raw)) return [];
  const out: MovementStepDef[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const s = item as Record<string, unknown>;
    if (typeof s.name !== 'string' || !s.name.trim()) continue;
    out.push({
      name: s.name.trim(),
      color: typeof s.color === 'string' ? s.color : undefined,
      multiplier: typeof s.multiplier === 'number' ? s.multiplier : undefined,
    });
  }
  return out;
}

/** Follows one Atlas tab's store and reports a snapshot whenever something the 3D view draws changed. */
export class AtlasBinding {
  private store: AtlasSceneStore | null = null;
  private leaf: WorkspaceLeaf | null = null;
  /** The pin Atlas was last told about, so it can be told it is gone. */
  private hovered: PreviewPin | null = null;
  private unsubscribe: (() => void) | null = null;
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
    this.consider(store.getState());
    return true;
  }

  detach(): void {
    this.hideStatblock();
    this.unsubscribe?.();
    this.unsubscribe = null;
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

  /** Creates a kept measurement or aura in Atlas so 2D and 3D stay in sync. */
  addMeasure(payload: {
    shape: MeasureShape;
    points: Array<{ x: number; y: number }>;
    color?: string | null;
    players?: boolean;
    effect?: string | null;
    follows?: string;
    aura?: number;
  }): boolean {
    const state = this.store?.getState();
    if (state === undefined || typeof state.addMeasure !== 'function') return false;
    const levels = Array.isArray(state.levels) ? state.levels : [];
    const level = levels.length > 0 ? (state.viewedLevel ?? levels[0]?.id) : undefined;
    try {
      state.addMeasure({
        shape: payload.shape,
        points: payload.points,
        ...(level ? { level } : {}),
        ...(payload.color ? { color: payload.color } : {}),
        ...(payload.players !== undefined ? { players: payload.players } : {}),
        ...(payload.effect ? { effect: payload.effect } : {}),
        ...(payload.follows ? { follows: payload.follows, aura: payload.aura ?? 1 } : {}),
      });
      return true;
    } catch {
      return false;
    }
  }

  deleteMeasure(id: string): boolean {
    const state = this.store?.getState();
    if (state === undefined || typeof state.deleteMeasure !== 'function') return false;
    state.deleteMeasure(id);
    return true;
  }

  clearMeasures(): boolean {
    const state = this.store?.getState();
    if (state === undefined || typeof state.clearMeasures !== 'function') return false;
    state.clearMeasures();
    return true;
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

  /** Diagonal, range band, cone and movement settings of the scene's collection. */
  collectionMeasureSettings(): AtlasCollectionMeasureSettings {
    const raw = readCollectionSettings(this.leaf);
    const gd = (typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).gridDefaults : null) as Record<string, unknown> | null;
    const mv = (typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).movement : null) as Record<string, unknown> | null;

    const rawMode = typeof gd?.measurementMode === 'string' ? gd.measurementMode.toLowerCase() : 'metric';
    const rawCone = typeof gd?.coneEnd === 'string' ? gd.coneEnd.toLowerCase() : 'flat';
    const coneEnd: ConeEndMode = rawCone === 'round' ? 'round' : 'flat';

    return {
      diagonalRule: normalizeDiagonalRule(gd?.diagonalRule),
      measurementMode: rawMode === 'abstract' ? 'abstract' : 'metric',
      abstractRangeBands: parseRangeBands(gd?.abstractRangeBands),
      coneEnd,
      movementSteps: parseMovementSteps(mv?.steps),
      countPerTurn: mv?.countPerTurn !== false,
    };
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

  private consider(state: AtlasSceneState): void {
    const now = watched(state);
    if (now.length === this.last.length && now.every((value, i) => Object.is(value, this.last[i]))) return;
    this.last = now;
    this.onChange(snapshotOf(state));
  }
}