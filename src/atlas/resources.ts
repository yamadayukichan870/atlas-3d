import type { AtlasResourceDef, AtlasToken, ResourceDirection } from './types';

/**
 * How a token's resources are laid out around it, the way Atlas does it: each resource has a socket
 * 0-5; the first two are bars under the token, the next two are wheels on its right, the last two
 * wheels on its left. Pure, so it is tested in Node.
 */

export const MAX_RESOURCES = 6;
export const BAR_SLOTS = 2;

const HEX = /^#[0-9a-f]{6}$/i;
const DIRECTIONS: readonly ResourceDirection[] = ['drains', 'fills', 'static'];

export interface Slotted { def: AtlasResourceDef; slot: number }

/**
 * Each resource with its socket, in socket order. A stored socket holds (the first to claim it); a
 * resource without one, or whose socket is taken, gets the first free socket in list order. What finds
 * no socket is left out: a token has `MAX_RESOURCES` of them.
 */
export function slotResources(defs: readonly AtlasResourceDef[]): Slotted[] {
  const sockets = new Map<number, AtlasResourceDef>();
  const waiting: AtlasResourceDef[] = [];
  for (const def of defs) {
    const slot = def.slot;
    if (typeof slot === 'number' && Number.isInteger(slot) && slot >= 0 && slot < MAX_RESOURCES && !sockets.has(slot)) sockets.set(slot, def);
    else waiting.push(def);
  }
  for (let slot = 0; slot < MAX_RESOURCES && waiting.length > 0; slot++) {
    if (!sockets.has(slot)) sockets.set(slot, waiting.shift() as AtlasResourceDef);
  }
  return [...sockets].sort(([a], [b]) => a - b).map(([slot, def]) => ({ def, slot }));
}

export interface HudValue {
  key: string;
  name: string;
  color: string;
  current: number;
  max: number;
  /** A fixed number: shown as it is, with nothing to add or take. */
  fixed: boolean;
}

export interface TokenResources {
  bars: HudValue[];
  right: HudValue[];
  left: HudValue[];
}

/** What a token shows, by place. A resource the token has no value for is simply not shown. */
export function resourcesOf(token: AtlasToken, defs: readonly AtlasResourceDef[]): TokenResources {
  const out: TokenResources = { bars: [], right: [], left: [] };
  for (const { def, slot } of slotResources(defs)) {
    const value = token.resources?.[def.key];
    if (!value || typeof value.current !== 'number' || typeof value.max !== 'number') continue;
    const fixed = def.direction === 'static';
    const shown: HudValue = { key: def.key, name: def.name, color: def.color, current: fixed ? value.max : value.current, max: value.max, fixed };
    if (slot < BAR_SLOTS) out.bars.push(shown);
    else if (slot < BAR_SLOTS + 2) out.right.push(shown);
    else out.left.push(shown);
  }
  return out;
}

/** One step of a resource, kept between 0 and its maximum. */
export function stepValue(current: number, max: number, delta: number): number {
  return Math.min(Math.max(0, max), Math.max(0, current + delta));
}

/** Reads resource definitions from whatever Atlas hands over, keeping only well-formed ones; null when none are. */
export function parseDefs(raw: unknown): AtlasResourceDef[] | null {
  if (!Array.isArray(raw)) return null;
  const defs: AtlasResourceDef[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const d = item as Record<string, unknown>;
    if (typeof d.key !== 'string' || d.key === '' || typeof d.color !== 'string' || !HEX.test(d.color)) continue;
    const direction = DIRECTIONS.includes(d.direction as ResourceDirection) ? (d.direction as ResourceDirection) : 'drains';
    const def: AtlasResourceDef = { key: d.key, name: typeof d.name === 'string' ? d.name : d.key, color: d.color, direction };
    if (typeof d.slot === 'number') def.slot = d.slot;
    defs.push(def);
  }
  return defs.length > 0 ? defs : null;
}

const FALLBACK_COLORS = ['#d946ef', '#94a3b8', '#dc2626', '#06b6d4', '#f59e0b', '#a855f7'];

/**
 * Definitions made up from the resources tokens carry, for when Atlas will not say what its collection
 * defines: `hp` and `stress` get their usual place and colour, anything else becomes a wheel.
 */
export function inferDefs(tokens: readonly AtlasToken[]): AtlasResourceDef[] {
  const keys: string[] = [];
  for (const token of tokens) for (const key of Object.keys(token.resources ?? {})) if (!keys.includes(key)) keys.push(key);
  keys.sort((a, b) => Number(b === 'hp') - Number(a === 'hp') || Number(b === 'stress') - Number(a === 'stress'));
  let color = 0;
  return keys.slice(0, MAX_RESOURCES).map((key) => ({
    key,
    name: key.replace(/[-_]/g, ' '),
    color: key === 'hp' ? '#22c55e' : key === 'stress' ? '#3b82f6' : (FALLBACK_COLORS[color++ % FALLBACK_COLORS.length] as string),
    direction: key === 'stress' ? 'fills' : 'drains',
  }));
}
