import { BLOCK_SHAPES, SHAPE_INFO, quarterOf, rampNormal, scaleNormal, surfaceFraction, type BlockShape, type Vec3 } from './shapes';

/**
 * The terrain as a stack of shaped blocks per grid column, the way IsoCON builds maps.
 *
 * Coordinates: x and z are grid cell indices counted from the grid origin (they can be negative);
 * y is the layer, starting at 1 for the one on the ground. One layer is `layerHeight` cells tall.
 */

export type Rotation = 0 | 90 | 180 | 270;
export type FacingAngle = 0 | 90 | 180 | 270;
export type Surface = 'image' | 'colors';

export interface TokenMeta {
  flipX?: boolean;
  facing?: FacingAngle;
  /** Recorded ground/floor height (world cells) when moved in 3D, so tokens under bridges stay below them. */
  floorY?: number;
}

export interface Block {
  x: number;
  y: number;
  z: number;
  rot: Rotation;
  shape: BlockShape;
  /** Colour of the top faces, `#rrggbb`; absent = the map's preset. */
  top?: string;
  /** Colour of the side faces; absent = the map's preset. */
  side?: string;
  /** Carried through from IsoCON-style maps; not used yet. */
  destroyable: boolean;
  marks: string;
}

export interface BlockChange {
  x: number;
  y: number;
  z: number;
  before: Block | null;
  after: Block | null;
}

export interface Preset { top: string; side: string }

export const DEFAULT_PRESET: Preset = { top: '#3E713E', side: '#5B442A' };
/** A cube is a true cube (one cell tall) and a slab is half of it; a map can choose half-cell layers instead. */
export const DEFAULT_LAYER_HEIGHT = 1;
export const MAX_LAYERS = 40;
const MAX_EXTENT = 500;

const HEX = /^#[0-9a-f]{6}$/i;
const bkey = (x: number, y: number, z: number): string => `${x},${y},${z}`;
const ckey = (x: number, z: number): string => `${x},${z}`;

export const normalizeRotation = (degrees: number): Rotation =>
  ((((Math.round(degrees / 90) % 4) + 4) % 4) * 90) as Rotation;

function sameBlock(a: Block, b: Block): boolean {
  return a.shape === b.shape && a.rot === b.rot && a.top === b.top && a.side === b.side
    && a.destroyable === b.destroyable && a.marks === b.marks;
}

export function makeBlock(x: number, y: number, z: number, shape: BlockShape = 'Solid', rot: Rotation = 0, top?: string): Block {
  const block: Block = { x, y, z, rot, shape, destroyable: true, marks: '' };
  if (top !== undefined) block.top = top;
  return block;
}

export class BlockMap {
  layerHeight = DEFAULT_LAYER_HEIGHT;
  surface: Surface = 'image';
  /** Fixed size in cells; null = follow the map image. */
  extent: { cols: number; rows: number } | null = null;
  preset: Preset = { ...DEFAULT_PRESET };

  private readonly blocks = new Map<string, Block>();
  /** Highest layer of each column. */
  private readonly tops = new Map<string, number>();
  /** Per-token 3D-only metadata (horizontal flip, 4-way facing, floor height) saved in sidecar. */
  private readonly tokenMeta = new Map<string, TokenMeta>();

  get count(): number {
    return this.blocks.size;
  }

  getTokenMeta(id: string): TokenMeta | undefined {
    return this.tokenMeta.get(id);
  }

  setTokenFlip(id: string, flipX: boolean): void {
    const next: TokenMeta = { ...(this.tokenMeta.get(id) ?? {}) };
    if (flipX) next.flipX = true;
    else delete next.flipX;
    this.writeTokenMeta(id, next);
  }

  setTokenFacing(id: string, facing: FacingAngle): void {
    const next: TokenMeta = { ...(this.tokenMeta.get(id) ?? {}), facing };
    this.writeTokenMeta(id, next);
  }

  setTokenFloorY(id: string, floorY: number | undefined): void {
    const next: TokenMeta = { ...(this.tokenMeta.get(id) ?? {}) };
    if (typeof floorY === 'number' && Number.isFinite(floorY) && floorY >= 0) next.floorY = Math.round(floorY * 1000) / 1000;
    else delete next.floorY;
    this.writeTokenMeta(id, next);
  }

  private writeTokenMeta(id: string, next: TokenMeta): void {
    if (next.flipX || next.facing !== undefined || next.floorY !== undefined) this.tokenMeta.set(id, next);
    else this.tokenMeta.delete(id);
  }

  get(x: number, y: number, z: number): Block | undefined {
    return this.blocks.get(bkey(x, y, z));
  }

  topLayer(x: number, z: number): number {
    return this.tops.get(ckey(x, z)) ?? 0;
  }

  topBlock(x: number, z: number): Block | undefined {
    const top = this.topLayer(x, z);
    return top > 0 ? this.get(x, top, z) : undefined;
  }

  /**
   * Highest block in column (x, z) whose top surface lies at or below `ceilingY` (in world cells).
   * Allows tokens and interactions to resolve floors under bridges or roofs.
   */
  walkableBlockAt(x: number, z: number, ceilingY: number = Infinity): Block | undefined {
    const top = this.topLayer(x, z);
    if (top <= 0) return undefined;
    if (!Number.isFinite(ceilingY)) return this.get(x, top, z);
    const maxLayer = Math.min(top, Math.floor((ceilingY + 1e-4) / this.layerHeight) + 1);
    for (let y = maxLayer; y >= 1; y--) {
      const b = this.get(x, y, z);
      if (!b) continue;
      const surfaceTop = (b.y - 1 + SHAPE_INFO[b.shape].topPlane) * this.layerHeight;
      if (surfaceTop <= ceilingY + 1e-4) return b;
    }
    return undefined;
  }

  /** Height, in cells, a token stands at in the middle of a column (0 for flat ground). */
  surfaceHeight(x: number, z: number, ceilingY: number = Infinity): number {
    const block = this.walkableBlockAt(x, z, ceilingY);
    return block ? this.layerHeight * (block.y - 1 + SHAPE_INFO[block.shape].walk) : 0;
  }

  /** Height, in cells, of the highest point of a column's top block. */
  topPlaneHeight(x: number, z: number): number {
    const block = this.topBlock(x, z);
    return block ? this.layerHeight * (block.y - 1 + SHAPE_INFO[block.shape].topPlane) : 0;
  }

  /**
   * The real height of the ground at a point, in cells: x and z are in grid cells from the grid origin and
   * may fall anywhere in a cell, so a ramp reads as a slope and steps as two levels. 0 over flat ground.
   */
  surfaceHeightAt(gx: number, gz: number, ceilingY: number = Infinity): number {
    const cx = Math.floor(gx);
    const cz = Math.floor(gz);
    const block = this.walkableBlockAt(cx, cz, ceilingY);
    if (!block) return 0;
    return this.layerHeight * (block.y - 1 + surfaceFraction(block.shape, quarterOf(block.rot), gx - cx, gz - cz));
  }

  /** The highest, lowest and middle ground under a disc, which is what a token's base has to rest on. */
  sampleDisc(gx: number, gz: number, radius: number, ceilingY: number = Infinity): { min: number; max: number; center: number } {
    const center = this.surfaceHeightAt(gx, gz, ceilingY);
    let min = center;
    let max = center;
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      const h = this.surfaceHeightAt(gx + Math.cos(a) * radius, gz + Math.sin(a) * radius, ceilingY);
      if (h < min) min = h;
      if (h > max) max = h;
    }
    return { min, max, center };
  }

  /** The tilt of the ground at a point when it is a ramp (a token leans to it), else null. */
  rampNormalAt(gx: number, gz: number, ceilingY: number = Infinity): Vec3 | null {
    const block = this.walkableBlockAt(Math.floor(gx), Math.floor(gz), ceilingY);
    return block && block.shape === 'Slope' ? scaleNormal(rampNormal(quarterOf(block.rot)), this.layerHeight) : null;
  }

  forEach(visit: (block: Block) => void): void {
    for (const block of this.blocks.values()) visit(block);
  }

  /** Puts a block at its own position, replacing what was there. Null when it would change nothing or is out of range. */
  place(block: Block): BlockChange | null {
    const { x, y, z } = block;
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z) || y < 1 || y > MAX_LAYERS) return null;
    const before = this.get(x, y, z) ?? null;
    if (before && sameBlock(before, block)) return null;
    const after: Block = { ...block };
    this.setRaw(x, y, z, after);
    return { x, y, z, before, after };
  }

  remove(x: number, y: number, z: number): BlockChange | null {
    const before = this.get(x, y, z) ?? null;
    if (!before) return null;
    this.setRaw(x, y, z, null);
    return { x, y, z, before, after: null };
  }

  apply(changes: readonly BlockChange[], direction: 'do' | 'undo'): void {
    const ordered = direction === 'do' ? changes : [...changes].reverse();
    for (const c of ordered) this.setRaw(c.x, c.y, c.z, direction === 'do' ? c.after : c.before);
  }

  toData(): TerrainData {
    const lines = [...this.blocks.values()]
      .sort((a, b) => a.x - b.x || a.z - b.z || a.y - b.y)
      .map(serializeBlock);
    const data: TerrainData = { version: 2, layerHeight: this.layerHeight, surface: this.surface, preset: { ...this.preset }, blocks: lines };
    if (this.extent) data.extent = { ...this.extent };
    if (this.tokenMeta.size > 0) {
      const tokens: Record<string, TokenMeta> = {};
      for (const [id, meta] of this.tokenMeta) {
        if (meta.flipX || meta.facing !== undefined || meta.floorY !== undefined) tokens[id] = { ...meta };
      }
      if (Object.keys(tokens).length > 0) data.tokens = tokens;
    }
    return data;
  }

  private setRaw(x: number, y: number, z: number, block: Block | null): void {
    const column = ckey(x, z);
    if (block) {
      this.blocks.set(bkey(x, y, z), block);
      if (y > (this.tops.get(column) ?? 0)) this.tops.set(column, y);
      return;
    }
    this.blocks.delete(bkey(x, y, z));
    if (y !== this.tops.get(column)) return;
    let next = y - 1;
    while (next > 0 && !this.blocks.has(bkey(x, next, z))) next--;
    if (next > 0) this.tops.set(column, next);
    else this.tops.delete(column);
  }
}

// ---- file format ----------------------------------------------------------------------------

export interface TerrainData {
  version: 2;
  /** Height of one layer, in grid cells. */
  layerHeight: number;
  surface: Surface;
  extent?: { cols: number; rows: number };
  preset: Preset;
  /** One block per line: `x|z|y|rotation|shape|destroyable|marks|topColour|sideColour` (IsoCON's layout). */
  blocks: string[];
  /** Optional 3D-only token metadata (horizontal flip, 4-way facing & floor height). */
  tokens?: Record<string, TokenMeta>;
}

export function serializeBlock(b: Block): string {
  return [b.x, b.z, b.y, b.rot, b.shape, b.destroyable, b.marks, b.top ?? '', b.side ?? ''].join('|');
}

/** Reads one block line leniently: a bad line is null, an odd field falls back to a default. */
export function parseBlock(line: unknown): Block | null {
  if (typeof line !== 'string') return null;
  const p = line.split('|');
  if (p.length < 5) return null;
  const x = Number(p[0]);
  const z = Number(p[1]);
  const y = Math.round(Number(p[2]));
  if (!Number.isInteger(x) || !Number.isInteger(z) || !Number.isFinite(y)) return null;
  const rot = Number(p[3]);
  const shape = (BLOCK_SHAPES as readonly string[]).includes(p[4] as string) ? (p[4] as BlockShape) : 'Solid';
  const block: Block = {
    x, y, z, shape,
    rot: Number.isFinite(rot) ? normalizeRotation(rot) : 0,
    destroyable: p[5] !== 'false',
    marks: p[6] ?? '',
  };
  if (HEX.test(p[7] ?? '')) block.top = p[7] as string;
  if (HEX.test(p[8] ?? '')) block.side = p[8] as string;
  return block;
}

const validHex = (value: unknown): value is string => typeof value === 'string' && HEX.test(value);
const validExtent = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_EXTENT;

function readPreset(value: unknown, into: Preset): void {
  const { top, side } = (typeof value === 'object' && value !== null ? value : {}) as Partial<Preset>;
  if (validHex(top)) into.top = top;
  if (validHex(side)) into.side = side;
}

export interface Parsed {
  map: BlockMap;
  /** True when the data came from an older format: the caller should save it in the current one. */
  migrated: boolean;
}

export function parseTerrain(data: unknown): Parsed {
  const map = new BlockMap();
  if (typeof data !== 'object' || data === null) return { map, migrated: false };
  const d = data as Record<string, unknown>;

  if (d.version === 2) {
    if (typeof d.layerHeight === 'number' && d.layerHeight > 0 && d.layerHeight <= 4) map.layerHeight = d.layerHeight;
    if (d.surface === 'image' || d.surface === 'colors') map.surface = d.surface;
    const e = d.extent as { cols?: unknown; rows?: unknown } | undefined;
    if (e && validExtent(e.cols) && validExtent(e.rows)) map.extent = { cols: e.cols, rows: e.rows };
    readPreset(d.preset, map.preset);
    for (const line of Array.isArray(d.blocks) ? d.blocks : []) {
      const block = parseBlock(line);
      if (block) map.place(block);
    }
    if (typeof d.tokens === 'object' && d.tokens !== null) {
      for (const [id, raw] of Object.entries(d.tokens as Record<string, unknown>)) {
        if (!id || typeof raw !== 'object' || raw === null) continue;
        const r = raw as Record<string, unknown>;
        if (r.flipX === true) map.setTokenFlip(id, true);
        if (r.facing === 0 || r.facing === 90 || r.facing === 180 || r.facing === 270) {
          map.setTokenFacing(id, r.facing);
        }
        if (typeof r.floorY === 'number' && Number.isFinite(r.floorY) && r.floorY >= 0) {
          map.setTokenFloorY(id, r.floorY);
        }
      }
    }
    return { map, migrated: false };
  }

  if (typeof d.heights === 'object' && d.heights !== null) {
    const step = d.stepHeight;
    if (typeof step === 'number' && step > 0 && step <= 4) map.layerHeight = step;
    for (const [key, steps] of Object.entries(d.heights)) {
      const [x, z] = key.split(',').map(Number);
      if (!Number.isInteger(x) || !Number.isInteger(z) || typeof steps !== 'number') continue;
      for (let y = 1; y <= Math.min(Math.round(steps), MAX_LAYERS); y++) map.place(makeBlock(x as number, y, z as number));
    }
    return { map, migrated: true };
  }

  if (Array.isArray(d.blocks)) {
    map.layerHeight = 1;
    map.surface = 'colors';
    const size = validExtent(d.gridSize) ? d.gridSize : 12;
    map.extent = { cols: size, rows: size };
    readPreset(d.preset, map.preset);
    for (const line of d.blocks) {
      const block = parseBlock(line);
      if (block) map.place(block);
    }
    return { map, migrated: true };
  }

  return { map, migrated: false };
}