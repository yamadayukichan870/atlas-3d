import {
  ATLAS_MEASURE_MODES,
  ATLAS_MEASURE_SHAPES,
  type AtlasMeasureMode,
  type AtlasMeasureShape,
} from './measureRules';

/**
 * The two shape vocabularies of this plugin, and the one place they are translated.
 *
 * THERE ARE TWO, AND THEY DISAGREE ABOUT ONE NAME.
 *
 *   Atlas persists five shapes:  ruler  circle  cone  square  LINE
 *   The old toolbar spoke four:  LINE   sphere  cone  cube
 *
 * `line` means a RECTANGLE L×W in Atlas, and the MULTI-WAYPOINT RULER in the old toolbar. So the
 * map that translates the toolbar's names into Atlas' (`line -> ruler`) is correct in that
 * direction and catastrophic in the other: applied to a measurement read FROM Atlas, it turns
 * every kept rectangle into a ruler. A ruler has no cells and no outline, so the figure loses its
 * body, its border and its effect; its label becomes a bare distance ("2u" where Atlas writes
 * "2 × 1u"); and its badge shows the ruler's glyph. Drawing a line in 3D worked, and then the
 * next snapshot read it back as a ruler — the shape changed under the user's hand.
 *
 * That map lived in FOUR places (MeasureTool.keptDisplay, TacticalOverlays.modeOf,
 * Scene3D.legacyShapeOf, Scene3D.modeOfLegacyShape) with nothing to say which direction each was
 * for. Here the direction is in the NAME, so the wrong one cannot be picked by accident:
 *
 *   atlasShapeOf / atlasModeOf   <- data that came FROM Atlas. Never through the legacy map.
 *   legacyShapeOf                -> Atlas mode  -> the old toolbar's four names. Lossy.
 *   atlasModeOfLegacy            <- the old toolbar's four names -> Atlas mode.
 *
 * `atlasShapeOf` is STRICT on purpose: it accepts Atlas' five names and nothing else. Feeding it
 * a legacy name returns null — loud — instead of a plausible wrong answer. 'sphere' is not an
 * Atlas shape and never was: `MeasureShapeKind` has always been these five, and this plugin's own
 * writer sends one of them. Aliases for tool MODE strings (which an older writer may have stored
 * loosely) are the bridge's `normalizeMeasureMode`, a different door for a different field.
 *
 * `LegacyShape` is declared here rather than imported from terrain/raycast: it is structurally
 * identical to `AoEShape`, so it is assignable wherever that is expected, and `atlas/` stays free
 * of a dependency on `terrain/`. When the toolbar speaks Atlas modes directly, both go away.
 *
 * Pure: the only runtime import is measureRules, which is itself pure. Tested in Node.
 */

/** The four names the old toolbar and its fallback bar still speak. */
export type LegacyShape = 'line' | 'sphere' | 'cone' | 'cube';

export const LEGACY_SHAPES: readonly LegacyShape[] = ['line', 'sphere', 'cone', 'cube'];

/** Case and surrounding space are tolerated; NAMES are not translated. */
const canonical = (raw: unknown): string | null =>
  typeof raw === 'string' ? raw.trim().toLowerCase() : null;

/** Whether `raw` is one of the five shapes Atlas persists. */
export function isAtlasShape(raw: unknown): raw is AtlasMeasureShape {
  const name = canonical(raw);
  return name !== null && (ATLAS_MEASURE_SHAPES as readonly string[]).includes(name);
}

/**
 * A shape as Atlas wrote it, or null. THIS is the door for `objects.measures[].shape`.
 * A rectangle stays a rectangle: `atlasShapeOf('line') === 'line'`.
 */
export function atlasShapeOf(raw: unknown): AtlasMeasureShape | null {
  const name = canonical(raw);
  return isAtlasShape(name) ? name : null;
}

/** Whether `raw` is one of the six things the measure tool can do (the five, plus `ranges`). */
export function isAtlasMode(raw: unknown): raw is AtlasMeasureMode {
  const name = canonical(raw);
  return name !== null && (ATLAS_MEASURE_MODES as readonly string[]).includes(name);
}

/** A tool mode as Atlas holds it, or null. `ranges` is a mode, never a persisted shape. */
export function atlasModeOf(raw: unknown): AtlasMeasureMode | null {
  const name = canonical(raw);
  return isAtlasMode(name) ? name : null;
}

/**
 * The persisted shape a mode draws, or null for `ranges` — which is rings around a token and is
 * never kept. Use this instead of casting a mode to a shape and testing it against a list.
 */
export function shapeOfMode(mode: AtlasMeasureMode): AtlasMeasureShape | null {
  return mode === 'ranges' ? null : mode;
}

/** Whether `raw` is one of the old toolbar's four names. */
export function isLegacyShape(raw: unknown): raw is LegacyShape {
  const name = canonical(raw);
  return name !== null && (LEGACY_SHAPES as readonly string[]).includes(name);
}

/**
 * The old toolbar's name for an Atlas mode. LOSSY: `ruler` and `line` both land on 'line', because
 * the four-name union has no room for both. That is exactly why this map must never be used to
 * read Atlas data — the loss is only acceptable on the way OUT to a toolbar that has since gained
 * the six real names.
 */
export function legacyShapeOf(mode: AtlasMeasureMode): LegacyShape {
  switch (mode) {
    case 'circle': return 'sphere';
    case 'square': return 'cube';
    case 'cone': return 'cone';
    default: return 'line';
  }
}

/**
 * The Atlas mode a legacy toolbar name means. The old 'line' was the multi-waypoint ruler, so it
 * goes to `ruler` here — and ONLY here.
 */
export function atlasModeOfLegacy(shape: LegacyShape): AtlasMeasureMode {
  switch (shape) {
    case 'sphere': return 'circle';
    case 'cube': return 'square';
    case 'cone': return 'cone';
    case 'line': return 'ruler';
  }
}