import type {
  AtlasCellRule,
  AtlasConeEnd,
  AtlasDiagonalRule,
  AtlasMeasureMode as AtlasToolMode,
  AtlasMeasurementMode,
  AtlasMeasurementSettings,
  AtlasUnitType,
  MovementRules,
} from './measureRules';
// The two loose reader shapes the bridge still builds. They stay in the adapter until the
// bridge is rewritten (1.4) to use measureRules' readRangeBands / readMovementRules.
import type { MovementStepDef, RangeBandDef } from '../terrain/measure';

/**
 * Minimal, self-written views of the Atlas VTT data this plugin reads.
 *
 * Atlas publishes no strict TS contract across versions (0.12 - 0.16+), so every field
 * is treated as optional and checked at runtime by `bridge.ts` and `internals.ts`.
 *
 * The measurement shapes below were verified first-hand against atlas-vtt/atlas-vtt @ tag
 * 0.16.0: `measure/measureTypes.ts` (KeptMeasure, Measurement, MeasureInput, MeasureChanges,
 * MeasureToolOptions), `stores/measuresSlice.ts` (TokenAura and the five action signatures)
 * and `types/sceneLevelTypes.ts` (OnOneLevel).
 */

export const ATLAS_PLUGIN_ID = 'atlas-vtt';
export const ATLAS_VIEW_TYPE = 'atlas-vtt';

export type AtlasGridLineType = 'solid' | 'dashed' | 'dotted';

/** What the measure tool does with a press: one of the five shapes, or labelled rings. */
export type AtlasMeasureMode = AtlasToolMode;

/** A point in world pixels, as Atlas stores every measurement point. */
export interface AtlasPoint {
  x: number;
  y: number;
}

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
  /** Older spelling of `unitType`; Scene3D still reads it, the rules reader does not. */
  unit?: string;
  unitType?: string;
  /** `'units'` measures distances; anything else (or unset) names them by range band. */
  measurementType?: string;
  unitName?: string;
  unitDistance?: number;
  /** The scene's own distance per cell, where it sets one. Only applies in metric mode. */
  unitDistanceOverride?: number;
  /** The scene's own unit name ("ly"). Only applies in metric mode. */
  unitNameOverride?: string;
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
  /** Game units it moves per turn; unset falls back to the collection's own speed. */
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

/**
 * Where a kept measurement started: the tokens under its start, and whether the players did not
 * see one of them then. A measurement leaves the players' picture with those tokens.
 */
export interface AtlasMeasureOrigin {
  tokenIds: string[];
  unseenAtStart: boolean;
}

/**
 * A measurement that stays on the map (`objects.measures`), as Atlas 0.16 saves it.
 *
 * Two fields this interface used to carry do not exist in Atlas and are gone: `players`
 * (visibility is `hidden`) and `lineWidth` (the persisted width is `width`, in world pixels;
 * `lineWidth` is the tool's choice, in cells). Writing either would store a field Atlas's own
 * visibility and drawing logic never reads.
 */
export interface AtlasMeasure {
  id: string;
  /** Atlas always writes it; optional here as every probed field is. */
  kind?: 'measure';
  /** One of the five persisted shapes; `ranges` is a tool mode and is never stored. */
  shape: string;
  /** World pixels. A ruler: start, corners, end. An area: origin and end. */
  points: AtlasPoint[];
  /** A line's width, in world pixels. Unset: one cell wide. */
  width?: number;
  /** `#rrggbb`; unset is the theme's accent, as a measurement always was. Never null. */
  color?: string;
  /** Only the GM sees it. Unset: players see it. */
  hidden?: true;
  /** The online player who made it; unset is the GM. */
  by?: string;
  origin?: AtlasMeasureOrigin;
  /** An area that walls do not stop. Unset: it stops at walls. */
  walls?: false;
  /**
   * The token this circle follows: an aura. Its `points` are where it lay when last edited and
   * are never rewritten when the token moves, so the 3D geometry must come from `aura` and the
   * token's own space, never from these points.
   */
  follows?: string;
  /** How far an aura reaches from the edge of its token's space, in game units. Only with `follows`. */
  aura?: number;
  /** The light the area gives, in the lighting engine's own words; unset, none. */
  light?: Record<string, unknown>;
  /** The look the area is drawn with; unset, the plain wash. */
  effect?: string;
  /** Unset is the first level. */
  level?: string;
}

/** What `addMeasure` takes: a kept measurement without the id and kind Atlas assigns. */
export type AtlasMeasureInput = Omit<AtlasMeasure, 'id' | 'kind'>;

/** Changes to a kept measurement: a field given as undefined is removed from it. */
export type AtlasMeasureChanges = {
  [Field in keyof AtlasMeasureInput]?: AtlasMeasureInput[Field] | undefined;
};

/** The aura a token is to have: reach in game units (0 removes it) and the points it then holds. */
export interface AtlasTokenAura {
  tokenId: string;
  aura: number;
  points: AtlasPoint[];
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

/**
 * The measure tool's choices (`state.measureTool`). `lineWidth` is in CELLS (1-20); the width a
 * kept line stores is `AtlasMeasure.width`, in world pixels. `color: null` is the theme's accent
 * here, while a kept measurement expresses the same thing by having no colour at all.
 */
export interface AtlasMeasureToolState {
  mode?: string;
  /** Older spelling of `mode`. */
  shape?: string;
  keep?: boolean;
  /** Older spelling of `keep`. */
  persist?: boolean;
  players?: boolean;
  color?: string | null;
  lineWidth?: number;
  effect?: string | null;
}

/**
 * The loose collection settings the bridge builds today.
 *
 * @deprecated Superseded by `AtlasSceneRules`, which carries the settings as Atlas resolves
 * them (scene overrides, preset fallbacks, validated bands and steps). Kept so the current
 * bridge compiles; it goes away once the last consumer reads `AtlasSceneRules`.
 */
export interface AtlasCollectionMeasureSettings {
  diagonalRule: AtlasDiagonalRule;
  measurementMode: AtlasMeasurementMode;
  abstractRangeBands: RangeBandDef[];
  coneEnd: AtlasConeEnd;
  movementSteps: MovementStepDef[];
  countPerTurn: boolean;
  /** Full opening of the cone in degrees; unset reads 90. */
  coneAngle?: number;
  areaCellRule?: AtlasCellRule;
  /** What a cell of difficult terrain costs movement; never changes a plain distance. */
  difficultTerrain?: string;
  unitType?: AtlasUnitType;
  /** Game units one cell of this scene spans. */
  unitDistance?: number;
  /** Game units one rules square spans; squares from presets convert with this one. */
  ruleDistance?: number;
  unitName?: string;
  /** The collection's speed for creatures that state none. */
  movementSpeed?: number;
}

/**
 * The rules a scene measures and moves by, resolved as Atlas resolves them: the collection's
 * grid defaults with the scene's own unit overrides, or the scene grid alone when the map
 * belongs to no collection. This is what the 3D view must measure with to agree with Atlas.
 */
export interface AtlasSceneRules {
  readonly measurement: AtlasMeasurementSettings;
  readonly movement: MovementRules;
  /** Where they came from: the map's collection, or the scene's grid without one. */
  readonly source: 'collection' | 'grid';
}

/** The part of an Atlas map tab's store this plugin reads. */
export interface AtlasSceneState {
  mapPath: string | null;
  mapLoaded: boolean;
  isMapLoading: boolean;
  background: string | null;
  grid: AtlasGrid | null;
  /**
   * A UI convenience Atlas initialises to 'default' and never persists. It is NOT the source of
   * a map's rules: those come from the collection `mapPath` lies in (see internals.ts).
   */
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
  /**
   * Keeps a measurement in one undo step and returns its id: on the level its data names, else
   * the level shown. Null, and nothing kept, where that level already holds 256. The payload is
   * an `AtlasMeasureInput`; it stays a record here so a probe can pass what it has and let Atlas
   * ignore what it does not know.
   */
  addMeasure?: (measure: Record<string, unknown>) => string | null;
  /** Changes a kept measurement; a field given as undefined is removed from it. */
  updateMeasure?: (id: string, changes: Record<string, unknown>) => void;
  deleteMeasure?: (id: string) => void;
  /** Removes every kept measurement of the level SHOWN, in one undo step; other levels keep theirs. */
  clearMeasures?: () => void;
  setMeasureTool?: (updates: Record<string, unknown>) => void;
  /**
   * Gives tokens their auras in one undo step: each token's first aura takes the reach given,
   * goes where that is 0, and is made (on the token's level, with `look`) where it has none.
   * False where a level holds 256 and an aura could not be made.
   */
  setTokenAuras?: (
    auras: readonly AtlasTokenAura[],
    look?: Pick<AtlasMeasureInput, 'color' | 'hidden'>,
  ) => boolean;
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
  /** Kept measurements AND token auras (`follows`) of the level shown, as Atlas holds them. */
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
  /** Width the next line takes, in CELLS (1-20). Optional until the bridge fills it (1.4). */
  measureLineWidth?: number | null;
  tokenSettings: AtlasTokenSettings | null;
  turnMoves: Record<string, number>;
}