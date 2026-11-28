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

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isStore(value: unknown): value is AtlasSceneStore {
  return typeof field(value, 'getState') === 'function' && typeof field(value, 'subscribe') === 'function';
}

export function atlasPlugin(app: App): unknown {
  return field(field(field(app, 'plugins'), 'plugins'), ATLAS_PLUGIN_ID);
}

export function atlasVersion(app: App): string | null {
  const version = field(field(atlasPlugin(app), 'manifest'), 'version');
  return typeof version === 'string' ? version : null;
}

export function sceneStoreOf(leaf: WorkspaceLeaf): AtlasSceneStore | null {
  if (leaf.view.getViewType() !== ATLAS_VIEW_TYPE) return null;
  const view = leaf.view as unknown;
  const store = field(view, 'atlasStore') ?? (typeof field(view, 'getStore') === 'function' ? (view as { getStore(): unknown }).getStore() : null);
  return isStore(store) ? store : null;
}

export function atlasLeaves(app: App): WorkspaceLeaf[] {
  return app.workspace.getLeavesOfType(ATLAS_VIEW_TYPE).filter((leaf) => sceneStoreOf(leaf) !== null);
}

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
    return shownId === undefined || (token.level ?? firstId) === shownId;
  });
}

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

function readLineWidth(tool: AtlasMeasureToolState): number | null {
  const raw = tool.lineWidth;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.min(MAX_LINE_WIDTH_CELLS, raw);
}

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
    background: isBase ? (state.background ?? null) : (shown?.background ?? null),
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

function rulesOf(leaf: WorkspaceLeaf | null, grid: AtlasGrid | null): AtlasSceneRules {
  const collection = recordOf(readCollectionSettings(leaf));
  const defaults = recordOf(field(collection, 'gridDefaults'));
  return {
    measurement: resolveMeasurementSettings(defaults, grid),
    movement: readMovementRules(field(collection, 'movement')) ?? NO_MOVEMENT_RULES,
    source: collection !== null ? 'collection' : 'grid',
  };
}

function lineWidthPx(widthCells: number | undefined, gridSize: number | undefined): number | null {
  if (typeof gridSize !== 'number' || !(gridSize > 0) || !Number.isFinite(gridSize)) return null;
  const cells = typeof widthCells === 'number' && Number.isFinite(widthCells) && widthCells > 0
    ? Math.min(MAX_LINE_WIDTH_CELLS, widthCells)
    : DEFAULT_LINE_WIDTH_CELLS;
  return cells * gridSize;
}

export interface MeasurePayload {
  shape: AtlasMeasureShape;
  points: readonly AtlasPoint[];
  widthCells?: number;
  color?: string | null;
  players?: boolean;
  hidden?: boolean;
  effect?: string | null;
  walls?: boolean;
  follows?: string;
  aura?: number;
  level?: string;
  origin?: AtlasMeasureOrigin;
}

interface PopoverEditState {
  readonly measurePopover?: unknown;
  readonly isGMView?: boolean;
  readonly isPlayerView?: boolean;
  readonly isMapLoading?: boolean;
}

export class AtlasBinding {
  private store: AtlasSceneStore | null = null;
  private leaf: WorkspaceLeaf | null = null;
  private hovered: PreviewPin | null = null;
  private unsubscribe: (() => void) | null = null;
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

  setTokenRotation(tokenId: string, rotation: number): boolean {
    const state = this.store?.getState();
    if (state === undefined || typeof state.updateToken !== 'function') return false;
    state.updateToken(tokenId, { rotation: ((rotation % 360) + 360) % 360 });
    return true;
  }

  setTokenElevation(tokenId: string, elevation: number): boolean {
    const state = this.store?.getState();
    if (state === undefined || typeof state.updateToken !== 'function') return false;
    state.updateToken(tokenId, { elevation });
    return true;
  }

  setTokenSize(tokenId: string, size: number): boolean {
    const state = this.store?.getState();
    if (state === undefined || typeof state.updateToken !== 'function') return false;
    state.updateToken(tokenId, { size });
    return true;
  }

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

  sceneRules(): AtlasSceneRules {
    return rulesOf(this.leaf, this.store?.getState().grid ?? null);
  }

  tokenSpeed(tokenId: string): number | null {
    const token = this.store?.getState().objects?.tokens?.[tokenId];
    return movementSpeedFor(token?.speed, this.sceneRules().movement);
  }

  /** @deprecated Use `sceneRules()` instead. */
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
   * Keeps a measurement in Atlas. Returns the id Atlas gave it, or null when nothing was kept.
   * Compatible with both 0.16.0 (addMeasure) and 0.21.2+ (addObject).
   */
  addMeasure(payload: MeasurePayload): string | null {
    const state = this.store?.getState();
    if (state === undefined) return null;
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
      // Atlas 0.21.2+: addObject
      if (typeof (state as any).addObject === 'function') {
        const id = (state as any).addObject('measures', data);
        return typeof id === 'string' && id !== '' ? id : null;
      }
      // Atlas 0.16.0-0.20.x: addMeasure
      if (typeof state.addMeasure === 'function') {
        const id = state.addMeasure(data);
        return typeof id === 'string' && id !== '' ? id : null;
      }
      return null;
    } catch (error) {
      console.error('[Atlas 3D] Atlas could not keep the measurement', error);
      return null;
    }
  }

  /**
   * Changes a kept measurement. Compatible with both 0.16.0 (updateMeasure) and 0.21.2+ (patchObject).
   */
  updateMeasure(id: string, changes: AtlasMeasureChanges): boolean {
    const state = this.store?.getState();
    if (state === undefined) return false;
    if (!state.objects?.measures?.[id]) return false;
    const record: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(changes)) record[key] = value;
    try {
      // Atlas 0.21.2+: patchObject
      if (typeof (state as any).patchObject === 'function') {
        (state as any).patchObject('measures', id, record);
        return true;
      }
      // Atlas 0.16.0-0.20.x: updateMeasure
      if (typeof state.updateMeasure === 'function') {
        state.updateMeasure(id, record);
        return true;
      }
      return false;
    } catch (error) {
      console.error('[Atlas 3D] Atlas could not change the measurement', error);
      return false;
    }
  }

  /**
   * Removes a kept measurement. Compatible with both 0.16.0 (deleteMeasure) and 0.21.2+ (removeObjects).
   */
  deleteMeasure(id: string): boolean {
    const state = this.store?.getState();
    if (state === undefined) return false;
    try {
      // Atlas 0.21.2+: removeObjects
      if (typeof (state as any).removeObjects === 'function') {
        (state as any).removeObjects([id]);
        return true;
      }
      // Atlas 0.16.0-0.20.x: deleteMeasure
      if (typeof state.deleteMeasure === 'function') {
        state.deleteMeasure(id);
        return true;
      }
      return false;
    } catch (error) {
      console.error('[Atlas 3D] Atlas could not remove the measurement', error);
      return false;
    }
  }

  clearMeasures(): boolean {
    const state = this.store?.getState();
    if (state === undefined || typeof state.clearMeasures !== 'function') return false;
    state.clearMeasures();
    return true;
  }

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

  openMeasurePopover(id: string): boolean {
    const store = this.store;
    if (store === null || typeof id !== 'string' || id === '') return false;
    const state = store.getState();
    const open = field(state, 'openMeasurePopover');
    if (typeof open !== 'function') return false;
    if (!state.objects?.measures?.[id]) return false;
    const view = state as PopoverEditState;
    if (view.isGMView === false || view.isPlayerView === true || view.isMapLoading === true) return false;
    try {
      (open as (measureId: string) => void).call(state, id);
    } catch (error) {
      console.error('[Atlas 3D] Atlas could not open its measurement options', error);
      return false;
    }
    return (store.getState() as PopoverEditState).measurePopover === id;
  }

  closeMeasurePopover(): boolean {
    const store = this.store;
    if (store === null) return false;
    const state = store.getState();
    const close = field(state, 'closeMeasurePopover');
    if (typeof close !== 'function') return false;
    const open = (state as PopoverEditState).measurePopover;
    if (typeof open !== 'string' || open === '') return false;
    try {
      (close as () => void).call(state);
      return true;
    } catch (error) {
      console.error('[Atlas 3D] Atlas could not close its measurement options', error);
      return false;
    }
  }

  measurePopoverId(): string | null {
    const open = (this.store?.getState() as PopoverEditState | undefined)?.measurePopover;
    return typeof open === 'string' && open !== '' ? open : null;
  }

  openContextMenu(tokenId: string, clientX: number, clientY: number): boolean {
    const token = this.store?.getState().objects?.tokens?.[tokenId];
    return token ? showTokenMenu(this.leaf, token, clientX, clientY) : false;
  }

  openEditModal(tokenId: string): boolean {
    const token = this.store?.getState().objects?.tokens?.[tokenId];
    return token ? openTokenEditModal(this.leaf, token) : false;
  }

  resourceDefs(): AtlasResourceDef[] | null {
    return parseDefs(readResourceDefs(this.leaf));
  }

  conditionDefs(): AtlasConditionDef[] | null {
    return parseConditionDefs(readConditionDefs(this.leaf));
  }

  showStatblock(tokenId: string, clientX: number, clientY: number, sourceLeaf: WorkspaceLeaf | null): boolean {
    const token = this.store?.getState().objects?.tokens?.[tokenId];
    const pin = token ? previewPinFor(token) : null;
    if (!pin || !showStatblockPreview(this.leaf, pin, clientX, clientY, sourceLeaf)) return false;
    this.hovered = pin;
    return true;
  }

  hideStatblock(): void {
    const pin = this.hovered;
    this.hovered = null;
    if (pin) hideStatblockPreview(this.leaf, pin);
  }

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