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
 * The badge colours and `readableTint` at the bottom are Atlas' own, ported from
 * atlas-vtt/atlas-vtt @ tag 0.18.0 (identical in 0.19.0). They are the reason a handle's ring
 * reads as the same colour as the line it belongs to.
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

// ---- Atlas' canvas badge colours, and the tint its handle rings are drawn in -----------------
//
// Ported from atlas-vtt/atlas-vtt @ tag 0.18.0 (identical in 0.19.0):
//   pixi/utils/canvasBadgeColors.ts -> canvasBadgeColors / canvasBadgeTheme
//   pixi/lighting/lightMarker.ts    -> luminance / contrast / mix / readableTint / lightColorNumber
//
// WHY THIS EXISTS. The overlay lifted a handle's ring toward white with an invented luminance
// threshold, which is not what Atlas does and made the handle read as a different colour from the
// line it belongs to. Atlas asks for WCAG contrast 3 against the BADGE'S OWN PLATE — a fixed
// 0x2a2a2a on the dark theme, not the map and not --background-primary — and moves the colour the
// least it can, toward white on a dark plate and toward BLACK on a light one.
//
// Measured with these formulas: fire #ec7500 contrasts 4.86 on the dark plate, so Atlas leaves it
// exactly as it is; the old threshold lightened it by about a quarter. Lightning #086ddd and
// shadow #7852ee sit at 2.90, so Atlas lifts them by under two percent — which is why using the
// raw hex instead would be wrong for those two. On the light plate Atlas DARKENS fire to #cc6500.
//
// Pure arithmetic, no three.js and no DOM, so it is tested in Node. Only the two theme accessors
// touch the document, and they read the host's own so a popout gets its own window's theme.

/** Screen colours of a canvas badge, as Atlas holds them. */
export interface CanvasBadgeColors {
  /** The plate the badge is drawn on. */
  background: number;
  /** Border and text colour. */
  stroke: number;
}

/** The badge colours and the theme's accent: what a GM edits on the map is drawn in. */
export interface CanvasBadgeTheme extends CanvasBadgeColors {
  accent: number;
}

/** Atlas' warm fallback for a colour string it cannot read (FALLBACK_COLOR). */
const LIGHT_FALLBACK = 0xffcc66;
/** Colours below this contrast against the badge are moved toward black or white until they reach it. */
const MIN_GLYPH_CONTRAST = 3;

const channels = (color: number): [number, number, number] =>
  [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];

const numberHex = (color: number): string => `#${(color >>> 0).toString(16).padStart(6, '0')}`;

/** Relative luminance of an sRGB colour, as WCAG defines it. */
function luminance(color: number): number {
  const [r, g, b] = channels(color).map((channel) => {
    const v = channel / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two colours, 1 to 21. */
export function contrastRatio(a: number, b: number): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function mixChannels(color: number, towards: number, amount: number): number {
  const from = channels(color);
  const to = channels(towards);
  const [r, g, b] = from.map((c, i) => Math.round(c + (to[i]! - c) * amount)) as [number, number, number];
  return (r << 16) | (g << 8) | b;
}

/**
 * `color` as it reads on `background`: unchanged where it contrasts enough, else moved toward
 * black on a light plate and toward white on a dark one, NO FURTHER THAN NEEDED — twelve halvings
 * find the least mix that reaches the threshold, so a pale colour keeps its hue.
 */
export function readableTint(color: number, background: number): number {
  if (contrastRatio(color, background) >= MIN_GLYPH_CONTRAST) return color;
  const towards = luminance(background) > 0.5 ? 0x000000 : 0xffffff;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 12; i++) {
    const amount = (low + high) / 2;
    if (contrastRatio(mixChannels(color, towards, amount), background) >= MIN_GLYPH_CONTRAST) high = amount;
    else low = amount;
  }
  return mixChannels(color, towards, high);
}

/** '#rrggbb' as a number; Atlas' warm light colour for anything else. */
export function lightColorNumber(color: string): number {
  return isHexColor(color) ? Number.parseInt(color.slice(1), 16) : LIGHT_FALLBACK;
}

/** The host's own document, so a popout reads its own theme; dark where there is none to read. */
function isDarkTheme(host: HTMLElement | null): boolean {
  const body = host?.doc?.body ?? (typeof document !== 'undefined' ? document.body : null);
  return body ? body.classList.contains('theme-dark') : true;
}

/** The plate and ink of a canvas badge. Fixed values, not the theme's background variables. */
export function canvasBadgeColors(host: HTMLElement | null = null): CanvasBadgeColors {
  return isDarkTheme(host)
    ? { background: 0x2a2a2a, stroke: 0xffffff }
    : { background: 0xe3e3e3, stroke: 0x000000 };
}

/** The same plus the theme's accent, which a measurement naming no colour is drawn in. */
export function canvasBadgeTheme(host: HTMLElement | null = null): CanvasBadgeTheme {
  const accent = resolveColorHex(themeAccent(host), '#7852ee');
  return { ...canvasBadgeColors(host), accent: lightColorNumber(accent) };
}

/** The ink a badge's glyph is drawn in, as '#rrggbb'. */
export function badgeInk(host: HTMLElement | null = null): string {
  return numberHex(canvasBadgeColors(host).stroke);
}

/**
 * The ring colour of a measurement's handle: the measurement's own colour made readable on the
 * badge's plate, or the theme's accent where it names none. This is `measureHandleLook`'s
 * `ringColor`, and it is what makes the handle read as the same colour as the line it belongs to.
 *
 * A CSS colour name is resolved first, which Atlas does not need (its schema is always '#rrggbb')
 * but costs nothing here; anything unreadable lands on Atlas' own warm fallback either way.
 */
export function measureRingColor(
  color: string | null | undefined,
  host: HTMLElement | null,
): string {
  const theme = canvasBadgeTheme(host);
  const named = typeof color === 'string' && color.trim() !== '' ? color.trim() : null;
  const base = named !== null ? lightColorNumber(resolveColorHex(named, '#ffcc66')) : theme.accent;
  return numberHex(readableTint(base, theme.background));
}