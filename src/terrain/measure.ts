/**
 * The measurement vocabulary of Atlas 3D, now sourced from the verified Atlas rules module.
 *
 * This file used to hold a hand-rolled measurement engine (measurePath, collectAoECells,
 * tokensInMeasure, isPointInsideArea, resolveRangeBand, formatMeasureNumber, CONE_HALF_ANGLE_5E
 * and their interfaces). None of it had a consumer: the only imports of this module were the
 * six type names below (atlas/types.ts) and normalizeDiagonalRule (atlas/bridge.ts). The drawing
 * path goes through terrain/raycast.ts and view/TacticalOverlays.ts, not through this engine.
 * So the dead engine is removed and this module becomes a thin adapter over atlas/measureRules.ts.
 *
 * The diagonal normaliser now delegates to Atlas' own four-name rule, which fixes the default:
 * a collection that never chose a rule measures `equidistant`, not the old `5e` literal (whose
 * branch in the old engine happened to compute equidistant anyway, while the name lied).
 *
 * RangeBandDef and MovementStepDef keep their loose reader shape until atlas/bridge.ts is
 * rewritten (Fase 1.4) to use measureRules' readRangeBands / readMovementRules. Changing them
 * here would break bridge.ts before its turn.
 *
 * Pure: the only import is the rules module, which is itself pure. No three.js, no DOM.
 */
import {
  normalizeAtlasDiagonalRule,
  type AtlasConeEnd,
  type AtlasDiagonalRule,
  type AtlasMeasureMode,
  type AtlasMeasurementMode,
} from '../atlas/measureRules';

/** What the measure tool draws: the five persisted shapes plus the `ranges` tool mode. */
export type MeasureShape = AtlasMeasureMode;

/** How a square grid prices a diagonal step, in Atlas' own four names. */
export type DiagonalRule = AtlasDiagonalRule;

/** `metric` measures distances; `abstract` names them by range band. */
export type MeasurementMode = AtlasMeasurementMode;

/** How a measured cone ends: on the arc, or straight across the drag. */
export type ConeEndMode = AtlasConeEnd;

/** A range band as the bridge's reader hands it over; validated properly in Fase 1.4. */
export interface RangeBandDef {
  name: string;
  squares?: number;
  maxSquares?: number;
  distance?: number;
}

/** A movement step as the bridge's reader hands it over; validated properly in Fase 1.4. */
export interface MovementStepDef {
  name: string;
  color?: string;
  multiplier?: number;
}

/**
 * The diagonal rule a collection measures with, delegating to Atlas' normaliser. Accepts the
 * four Atlas names ('equidistant', 'alternating', 'manhattan', 'euclidean') and the aliases this
 * plugin wrote before ('5e', '5-10-5', '1-2-1', 'pf2e' → alternating; 'exact'/'euclidean' →
 * euclidean). Anything absent or unrecognised is `equidistant`, Atlas' default.
 */
export function normalizeDiagonalRule(raw: unknown): DiagonalRule {
  return normalizeAtlasDiagonalRule(raw);
}