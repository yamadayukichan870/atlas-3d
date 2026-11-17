import type { ConeEndMode, DiagonalRule, MeasureShape, MeasurementMode, MovementStepDef, RangeBandDef } from '../terrain/measure';

/**
 * Minimal, self-written views of the Atlas VTT data this plugin reads.
 *
 * Atlas publishes no strict TS contract across versions (0.12 - 0.16+), so every field
 * is treated as optional and checked at runtime by `bridge.ts` and `internals.ts`.
 */

export const ATLAS_PLUGIN_ID = 'atlas-vtt';
export const ATLAS_VIEW_TYPE = 'atlas-vtt';

export type AtlasGridLineType = 'solid' | 'dashed' | 'dotted';
export type AtlasMeasureMode = MeasureShape;

export interface AtlasGrid {
  enabled: boolean;
  visible?: boolean;
  snapToGrid?: boolean;
  type?: 'square' | 'hex-horizontal' | 'hex-vertical';
  /** Pixels per cell (flat-to-flat on hex grids). */
  size: number;
  offsetX: number;
  offsetY: number;
  /** `#rrggbb`, `'auto'`, `'contrast'`, or CSS color string depending on Atlas version. */
  color?: string;
  opacity?: number;
  lineWidth?: number;
  lineType?: AtlasGridLineType | string;
  cellNumbers?: string | boolean;
  numberOpacity?: number;
  cellNumberOpacity?: number;
  cellNumbersOpacity?: number;
  unit?: string;
  unitType?: string;
  measurementType?: string;
  unitName?: string;
  unitDistance?: number;
  unitDistanceOverride?: number;
}

export interface AtlasResource {
  current: number;
  max: number;
}

/** `drains`: `current` is what is left (hit points); `fills`: what is used (stress); `static`: a fixed number. */
export type ResourceDirection = 'drains' | 'fills' | 'static';

/** A resource a collection defines for its tokens (HP, stress, ...): how it is called, coloured and where it sits. */
export interface AtlasResourceDef {
  key: string;
  name: string;
  /** `#rrggbb`. */
  color: string;
  direction: ResourceDirection;
  /** 0-1 are bars under the token, 2-3 wheels on its right, 4-5 wheels on its left. */
  slot?: number;
}

export interface AtlasConditionDef {
  id: string;
  name: string;
  color: string;
  icon: string;
}

export interface AtlasToken {
  id: string;
  kind: 'token' | 'character';
  /** Centre of the token, in map pixels. */
  x: number;
  y: number;
  imagePath: string;
  /** 1 = 1x1, 1.5 = 2x2, 2 = 3x3 ... (diameter in cells is `2 * size - 1`). */
  size?: number;
  rotation?: number;
  /** Height above its level's floor, in game units. */
  elevation?: number;
  speed?: number;
  level?: string;
  isHidden?: boolean;
  offMap?: true;
  ringColor?: string;
  showRing?: boolean;
  name?: string;
  instanceNumber?: number;
  statblockName?: string | null;
  statblockPath?: string;
  notePath?: string;
  resources?: Record<string, AtlasResource>;
  conditions?: string[];
  conditionValues?: Record<string, number | string>;
}

export interface AtlasMeasure {
  id: string;
  kind?: 'measure';
  shape: string;
  points: Array<{ x: number; y: number }>;
  level?: string;
  color?: string | null;
  players?: boolean;
  lineWidth?: number;
  effect?: string | null;
  follows?: string;
  aura?: number | boolean;
}

export interface AtlasLevel {
  id: string;
  background: string | null;
  elevation?: { bottom: number; top: number };
}

export interface AtlasInitiativeEntry {
  id?: string;
  tokenId?: string;
  hasTurn?: boolean;
}

export interface AtlasInitiativeState {
  isActive?: boolean;
  round?: number;
  currentTurn?: number;
  entries?: AtlasInitiativeEntry[];
}

export interface AtlasTokenSettings {
  showNameplates?: boolean;
  showInstanceBadges?: boolean;
  showHpBars?: boolean;
  showSecondaryResourceBars?: boolean;
}

export interface AtlasMeasureToolState {
  mode?: string;
  shape?: string;
  keep?: boolean;
  persist?: boolean;
  players?: boolean;
  color?: string | null;
  lineWidth?: number;
  effect?: string | null;
}

export interface AtlasCollectionMeasureSettings {
  diagonalRule: DiagonalRule;
  measurementMode: MeasurementMode;
  abstractRangeBands: RangeBandDef[];
  coneEnd: ConeEndMode;
  movementSteps: MovementStepDef[];
  countPerTurn: boolean;
}

/** The part of an Atlas map tab's store this plugin reads. */
export interface AtlasSceneState {
  mapPath: string | null;
  mapLoaded: boolean;
  isMapLoading: boolean;
  background: string | null;
  grid: AtlasGrid | null;
  currentCollectionId?: string;
  objects: {
    tokens: Record<string, AtlasToken>;
    measures?: Record<string, AtlasMeasure>;
  };
  selectedIds?: string[];
  levels?: AtlasLevel[];
  viewedLevel?: string | null;
  /** Session View / Player Preview flags (Atlas versions expose one or both). */
  isPlayerView?: boolean;
  isGMView?: boolean;
  activeTool?: string;
  tool?: string;
  measureMode?: string;
  measureShape?: string;
  measureKeep?: boolean;
  measureTool?: AtlasMeasureToolState;
  measure?: AtlasMeasureToolState;
  tokenSettings?: AtlasTokenSettings;
  initiative?: AtlasInitiativeState;
  turnMoves?: Record<string, number>;
}

/** Actions Atlas's store carries; optional because another Atlas version may not have them. */
export interface AtlasSceneActions {
  setTokenPositions?: (positions: Array<{ id: string; x: number; y: number }>) => void;
  dropTokens?: (positions: Array<{ id: string; x: number; y: number }>) => void;
  moveToken?: (id: string, x: number, y: number) => void;
  updateToken?: (id: string, updates: Record<string, unknown>) => void;
  setSelection?: (ids: string[]) => void;
  clearSelection?: () => void;
  setTokensCondition?: (ids: string[], conditionId: string, active: boolean) => void;
  addMeasure?: (measure: Record<string, unknown>) => unknown;
  updateMeasure?: (id: string, updates: Record<string, unknown>) => void;
  deleteMeasure?: (id: string) => void;
  clearMeasures?: () => void;
  setMeasureTool?: (updates: Record<string, unknown>) => void;
  setTokenAuras?: (tokenId: string, auras: unknown) => void;
}

export interface AtlasTemporalStore {
  getState?: () => {
    beginTransaction?: () => void;
    endTransaction?: () => void;
  };
}

/** Atlas's store is zustand's `create` result: a function with the store methods on it. */
export interface AtlasSceneStore {
  getState(): AtlasSceneState & AtlasSceneActions;
  subscribe(listener: (state: AtlasSceneState) => void): () => void;
  temporal?: AtlasTemporalStore;
}

/** What the 3D view needs, already narrowed to the level being shown. */
export interface SceneSnapshot {
  mapPath: string | null;
  /** Map loaded and not mid-load: safe to read. */
  ready: boolean;
  background: string | null;
  grid: AtlasGrid | null;
  tokens: AtlasToken[];
  measures: AtlasMeasure[];
  selectedIds: string[];
  /** The shown level's id; null for the first level and for scenes without levels. Terrain is kept per level. */
  levelId: string | null;
  /** True when Atlas is previewing/showing the Player View (hidden tokens/GM measures must be invisible). */
  isPlayerView: boolean;
  /** Current active tool id in Atlas if exposed (e.g. 'select', 'measure', 'fog'). */
  activeTool: string | null;
  /** Active measure shape in Atlas's Measure secondary toolbar, if exposed. */
  measureMode: AtlasMeasureMode | null;
  /** Whether Atlas's Measure Keep toggle is enabled, if exposed. */
  measureKeep: boolean | null;
  /** Whether new measurements are visible to players. */
  measurePlayers: boolean | null;
  /** Selected color in Atlas's Measure Look popover (null = Obsidian accent). */
  measureColor: string | null;
  /** Selected effect in Atlas's Measure Look popover. */
  measureEffect: string | null;
  tokenSettings: AtlasTokenSettings | null;
  turnMoves: Record<string, number>;
}