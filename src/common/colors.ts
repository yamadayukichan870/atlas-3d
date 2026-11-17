/**
 * Colours, resolved in one place for every layer that draws.
 *
 * Extracted from what the repo already did, so nothing is invented here:
 *   src/tokens/TokenLayer.ts  -> ATLAS_COLOR_MAP, resolveRingColor, applySafeColor
 *   src/view/Scene3D.ts       -> normalizeColor's hex handling
 *
 * Two real defects are fixed in the move:
 *
 * 1. `applySafeColor`'s try/catch never fired. `THREE.Color.set` does not throw on an
 *    unknown string: it warns on the console and leaves the colour as it was. The fallback
 *    was unreachable, so a bad colour silently kept whatever the material already had.
 * 2. `Scene3D.normalizeColor` used a module-level scratch `THREE.Color`. Because `set`
 *    leaves the colour untouched on failure, an invalid string returned the *previous
 *    valid colour's* hex — a different answer for the same input, depending on call order.
 *
 * Both come from the same cause: asking three.js to validate. Here the value is resolved
 * to a canonical `#rrggbb` first, and only a known-good string ever reaches `set`.
 *
 * No three.js import: `applySafeColor` takes anything with `set(value: string)`, which
 * `THREE.Color` satisfies, so this module stays pure and testable in Node. The one part
 * that needs a DOM is the CSS round-trip, and it degrades to the fallback when there is none.
 *
 * Not here, on purpose: `hexToLinear` stays in terrain/blockGeometry.ts. That is linear-space
 * vertex-colour maths with its own cache, a different concern from naming a colour.
 */

/** The custom property a measurement pill takes its colour from; the CSS falls back to the accent. */
export const PILL_COLOR_VAR = '--atlas3d-pill-color';

/** What a colour is set on. `THREE.Color` fits; nothing else about three is needed here. */
export interface ColorTarget {
  set(value: string): unknown;
}

/** Ring colours Atlas names, as TokenLayer has always resolved them. */
export const ATLAS_COLOR_MAP: Readonly<Record<string, string>> = Object.freeze({
  default: '#ffffff',
  blue: '#3b82f6',
  orange: '#f97316',
  red: '#ef4444',
  yellow: '#eab308',
  brown: '#78350f',
  purple: '#a855f7',
  green: '#22c55e',
  pink: '#ec4899',
  cyan: '#06b6d4',
  gray: '#6b7280',
  grey: '#6b7280',
  white: '#ffffff',
});

/** The colour a token ring takes when nothing names one. */
export const DEFAULT_RING_COLOR = '#ffffff';
/** The colour a measurement takes when the theme names no accent: the blue the overlay always used. */
export const DEFAULT_MEASURE_COLOR = '#38bdf8';

const STRICT_HEX = /^#[0-9a-f]{6}$/i;
const LOOSE_HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_CSS = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i;
const SRGB_CSS = /^color\(\s*srgb\s+([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i;

/** Whether `value` is `#rrggbb` exactly, as the terrain and resource readers require. */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && STRICT_HEX.test(value);
}

const clamp255 = (n: number): number => Math.min(255, Math.max(0, Math.round(n)));
const byteHex = (n: number): string => clamp255(n).toString(16).padStart(2, '0');
const rgbHex = (r: number, g: number, b: number): string => `#${byteHex(r)}${byteHex(g)}${byteHex(b)}`;

/**
 * `#rgb`, `#rrggbb`, or the same without the `#`, as canonical `#rrggbb`; null for anything
 * else. Three digits are doubled, which is what CSS means by them.
 */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = LOOSE_HEX.exec(value.trim());
  if (!match) return null;
  const body = (match[1] as string).toLowerCase();
  const full = body.length === 3
    ? `${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`
    : body;
  return `#${full}`;
}

/**
 * A colour Atlas names, or a hex, as `#rrggbb`; null when it is neither. Null means "this
 * module cannot resolve it purely", not "this is not a colour" — a CSS name like
 * `rebeccapurple` is one, and `resolveColorHex` below can still read it.
 */
export function resolveAtlasColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const named = ATLAS_COLOR_MAP[trimmed.toLowerCase()];
  if (named !== undefined) return named;
  return normalizeHex(trimmed);
}

/**
 * A token's ring colour, exactly as TokenLayer has always resolved it: a name or hex becomes
 * `#rrggbb`, any other non-empty string is handed on for the renderer to read, and nothing at
 * all is white. Kept so that moving the call site changes no behaviour.
 */
export function resolveRingColor(raw: string | undefined): string {
  const resolved = resolveAtlasColor(raw);
  if (resolved !== null) return resolved;
  const trimmed = raw?.trim() ?? '';
  return trimmed === '' ? DEFAULT_RING_COLOR : trimmed;
}

// ---- reading a CSS colour the pure path cannot name -----------------------------------------

let probe: CanvasRenderingContext2D | null | undefined;

/**
 * One offscreen 2D context, never attached to the document. That is what makes it safe in a
 * popout: nothing here belongs to a window, so there is no wrong-document element to adopt.
 * Undefined until first asked; null where there is no DOM (a Node test) or no 2D context.
 */
function colorProbe(): CanvasRenderingContext2D | null {
  if (probe !== undefined) return probe;
  if (typeof document === 'undefined') { probe = null; return probe; }
  try {
    probe = document.createElement('canvas').getContext('2d');
  } catch {
    probe = null;
  }
  return probe;
}

/**
 * A CSS colour as `#rrggbb`, read by asking the browser to parse it.
 *
 * `fillStyle` keeps its previous value when handed something it cannot read, so one probe
 * cannot tell an invalid colour from a black one. Two probes from different starting colours
 * can: a colour that parses gives the same answer from both, and one that does not gives each
 * starting colour back.
 *
 * Alpha is dropped — a material's opacity is its own setting, not part of its colour. Colours
 * the browser serialises in a form this does not read (some wide-gamut ones) return null, and
 * the caller's fallback stands.
 */
export function cssColorToHex(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const ctx = colorProbe();
  if (!ctx) return null;
  try {
    ctx.fillStyle = '#000000';
    ctx.fillStyle = trimmed;
    const fromBlack = ctx.fillStyle;
    ctx.fillStyle = '#ffffff';
    ctx.fillStyle = trimmed;
    const fromWhite = ctx.fillStyle;
    if (fromBlack !== fromWhite) return null;
    const asHex = normalizeHex(fromBlack);
    if (asHex !== null) return asHex;
    const rgb = RGB_CSS.exec(fromBlack);
    if (rgb) return rgbHex(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
    const srgb = SRGB_CSS.exec(fromBlack);
    if (srgb) return rgbHex(Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255);
    return null;
  } catch {
    return null;
  }
}

const resolved = new Map<string, string>();
/** Colours are a palette plus what a GM types: a handful. A cap keeps a stray loop from growing it. */
const RESOLVED_LIMIT = 256;

/**
 * Any colour this plugin is handed, as `#rrggbb`, or `fallback` when it cannot be read.
 * Always a hex, so what reaches `THREE.Color.set` is never a string it would warn about and
 * leave unchanged — which is the defect this module exists to remove.
 */
export function resolveColorHex(raw: unknown, fallback: string = DEFAULT_RING_COLOR): string {
  const safeFallback = normalizeHex(fallback) ?? DEFAULT_RING_COLOR;
  if (typeof raw !== 'string') return safeFallback;
  const trimmed = raw.trim();
  if (trimmed === '') return safeFallback;
  const pure = resolveAtlasColor(trimmed);
  if (pure !== null) return pure;
  const key = trimmed.toLowerCase();
  const cached = resolved.get(key);
  if (cached !== undefined) return cached;
  const read = cssColorToHex(trimmed) ?? safeFallback;
  if (resolved.size >= RESOLVED_LIMIT) resolved.clear();
  resolved.set(key, read);
  return read;
}

/**
 * Sets a colour on a three.js `Color` (or anything shaped like one) from a value that may be
 * a name, a hex, or a CSS string. The value is resolved first, so an unreadable one lands on
 * `fallback` rather than on whatever the target already held.
 */
export function applySafeColor(
  target: ColorTarget,
  value: unknown,
  fallback: string = DEFAULT_RING_COLOR,
): void {
  target.set(resolveColorHex(value, fallback));
}

// ---- the theme's accent ---------------------------------------------------------------------

/**
 * Obsidian's accent as the theme wrote it, or '' when there is none to read. The raw string is
 * returned rather than a hex: CSS understands whatever the theme used, and `resolveColorHex`
 * reads it for the geometry. `el.win` is used so a popout reads its own window's styles.
 */
export function themeAccent(el: HTMLElement | null): string {
  if (!el) return '';
  try {
    const view = el.win;
    const styles = view?.getComputedStyle?.(el);
    return styles?.getPropertyValue('--interactive-accent').trim() ?? '';
  } catch {
    return '';
  }
}

/**
 * The colour a measurement draws with: its own when Atlas's Look names one, the theme's accent
 * when `color` is null — which is what null has always meant in Atlas. Always `#rrggbb`, so the
 * same string serves a material and the pill's custom property.
 */
export function resolveMeasureColor(color: string | null | undefined, el: HTMLElement | null): string {
  if (typeof color === 'string' && color.trim() !== '') {
    return resolveColorHex(color, DEFAULT_MEASURE_COLOR);
  }
  const accent = themeAccent(el);
  return accent === '' ? DEFAULT_MEASURE_COLOR : resolveColorHex(accent, DEFAULT_MEASURE_COLOR);
}