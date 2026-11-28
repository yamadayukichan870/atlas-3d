import { BlockMap, makeBlock } from '../src/terrain/blocks';
import { buildTerrainChunk, hexToLinear, type TerrainBuildOptions, type TerrainChunkBuffers } from '../src/terrain/blockGeometry';
import { chunkOf, chunkRange, chunksToBuild } from '../src/terrain/flatSurface';
import { computeLayout } from '../src/terrain/layout';
import { BLOCK_SHAPES } from '../src/terrain/shapes';

/**
 * The terrain vertex builder, against its real API.
 *
 * RENAMED, NOT REWRITTEN. Every assertion below is the one this file always had; only the names
 * changed: `buildChunk` is `buildTerrainChunk`, `BuildOptions` is `TerrainBuildOptions`,
 * `ChunkBuffers` is `TerrainChunkBuffers`, and the chunk helpers (`chunkOf`, `chunkRange`,
 * `chunksToBuild`) live in `terrain/flatSurface.ts`, which is where the builder imports them from.
 *
 * WHAT LEFT THIS FILE. The builder no longer draws grid lines — `gridLines` is not an option and
 * `ChunkBuffers.lines` is not a field. Grid lines belong to `grid/GridLayer.ts` now, and that
 * module has NO test: the eight assertions that used to live here (8 vertices per cell, an outline
 * that follows a ramp, stairs outlined tread by tread) are a coverage gap, recorded rather than
 * quietly dropped. What the builder emits instead is `edges`: deduplicated block outlines, pushed
 * out along the averaged face normal so they never z-fight. The block at the end tests those.
 */

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`);
  if (!ok) failures++;
};

const GRID = { size: 70, offsetX: 0, offsetY: 0 };
const flat = (cols: number, rows: number, layerHeight = 1): { map: BlockMap; opts: TerrainBuildOptions } => {
  const map = new BlockMap();
  map.layerHeight = layerHeight;
  map.surface = 'colors';
  map.extent = { cols, rows };
  const layout = computeLayout({ image: null, grid: GRID, extent: map.extent });
  return { map, opts: { map, layout, useImage: false, checker: false } };
};
/** Builds every chunk of a map and sums the vertex counts. */
function total(opts: TerrainBuildOptions): { top: number; solid: number; liquid: number; edges: number; all: TerrainChunkBuffers[] } {
  const all = [...chunksToBuild(opts.map, opts.layout)].map((k) => { const [cx, cz] = k.split(',').map(Number); return buildTerrainChunk(opts, chunkRange(cx as number, cz as number)); });
  const sum = (f: (c: TerrainChunkBuffers) => number): number => all.reduce((s, c) => s + f(c), 0);
  return { top: sum((c) => c.tops.positions.length / 3), solid: sum((c) => c.solid.positions.length / 3), liquid: sum((c) => c.liquid.positions.length / 3), edges: sum((c) => c.edges.length / 3), all };
}
const faces = (verts: number): number => verts / 6; // quads are 6 vertices; a slope's triangles would be 3

// ---- counts: what gets drawn and what is hidden -------------------------------------------------
{
  const { map, opts } = flat(4, 4);
  check('floor: an empty 4x4 map is 16 floor quads', total(opts).solid === 16 * 6);

  map.place(makeBlock(1, 1, 1));
  check('one cube: 5 faces (no underside on the ground) + the other 15 floor cells', faces(total(opts).solid) === 5 + 15);

  map.place(makeBlock(2, 1, 1));
  check('two cubes side by side: the shared faces are hidden', faces(total(opts).solid) === 8 + 14);

  map.place(makeBlock(2, 2, 1));
  // (1,1,1): 3 sides + top = 4. (2,1,1): 3 sides, its top is under the block above = 3. (2,2,1): 4 sides + top = 5.
  const t = total(opts);
  check('a cube on a cube: the touching top and bottom are hidden', faces(t.solid) === 4 + 3 + 5 + 14, String(faces(t.solid)));
}
{
  const { map, opts } = flat(4, 4);
  map.place(makeBlock(1, 1, 1, 'Slab'));
  map.place(makeBlock(1, 2, 1));
  // Slab: 4 sides + top (half height, inside the cell). Cube above: 4 sides + top + underside (the slab does not cover it).
  check('a cube over a slab: the gap keeps both the slab top and the cube underside', faces(total(opts).solid) === 5 + 6 + 15, String(faces(total(opts).solid)));
}
{
  const { map, opts } = flat(4, 4);
  map.place(makeBlock(1, 3, 1));
  check('a floating cube keeps its underside (it can be seen from the side)', faces(total(opts).solid) === 6 + 16);
}
{
  const { map, opts } = flat(4, 4);
  map.place(makeBlock(0, 1, 0, 'Liquid'));
  map.place(makeBlock(1, 1, 0, 'Liquid'));
  const t = total(opts);
  check('water: a pool shows no wall between its two blocks (6+6-2 faces, each keeps its underside)', faces(t.liquid) === 10, String(faces(t.liquid)));
  check('water goes to its own batch, apart from the opaque one', t.solid === 14 * 6);
}
{
  const { map, opts } = flat(4, 4);
  map.place(makeBlock(0, 1, 0, 'Solid'));
  map.place(makeBlock(1, 1, 0, 'Liquid'));
  const t = total(opts);
  check('water against a cube: the cube keeps its wall (seen through the water)', faces(t.solid) === 5 + 14);
  check('water against a cube: the water drops its wall against the cube (6-1 faces)', faces(t.liquid) === 5, String(faces(t.liquid)));
}

// ---- end to end: every triangle of the real buffers faces the way its normal says -------------------
{
  // Spread the shapes out so none touches another: one per cell on a spaced grid.
  const { opts } = flat(24, 12);
  const spread = opts.map;
  const o2 = opts;
  let i = 0;
  for (const shape of BLOCK_SHAPES) for (const rot of [0, 90, 180, 270] as const) { spread.place(makeBlock((i % 5) * 2 + 1, 1, Math.floor(i / 5) * 2 + 1, shape, rot, '#ff8800')); i++; }
  const t = total(o2);
  let bad = '', tris = 0;
  for (const c of t.all) for (const part of [c.solid, c.liquid]) {
    const p = part.positions, n = part.normals;
    for (let v = 0; v < p.length; v += 9) {
      tris++;
      const ux = p[v + 3]! - p[v]!, uy = p[v + 4]! - p[v + 1]!, uz = p[v + 5]! - p[v + 2]!;
      const wx = p[v + 6]! - p[v]!, wy = p[v + 7]! - p[v + 1]!, wz = p[v + 8]! - p[v + 2]!;
      const gx = uy * wz - uz * wy, gy = uz * wx - ux * wz, gz = ux * wy - uy * wx;
      const len = Math.hypot(gx, gy, gz);
      if (len < 1e-12) { bad = 'degenerate triangle'; continue; }
      if ((gx * n[v]! + gy * n[v + 1]! + gz * n[v + 2]!) / len < 0.999999) bad = `triangle at ${v / 9}: winds against its normal`;
    }
  }
  check(`end to end: all ${tris} triangles of 5 shapes x 4 rotations wind outward`, bad === '' && tris > 100, bad);
}

// ---- chunks must not change what is drawn --------------------------------------------------------------
{
  const { map, opts } = flat(40, 8);
  let seed = 7;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 400; i++) map.place(makeBlock(Math.floor(rnd() * 40), 1 + Math.floor(rnd() * 3), Math.floor(rnd() * 8), BLOCK_SHAPES[Math.floor(rnd() * 5)]!, ([0, 90, 180, 270] as const)[Math.floor(rnd() * 4)]!));
  const chunked = total(opts);
  const whole = buildTerrainChunk(opts, { cx0: -1, cx1: 41, cz0: -1, cz1: 9 });
  check('chunks: building in 16x16 pieces draws exactly what one big pass draws (solid)', chunked.solid === whole.solid.positions.length / 3, `${chunked.solid} vs ${whole.solid.positions.length / 3}`);
  check('chunks: ... and the same for water and the floor', chunked.liquid === whole.liquid.positions.length / 3 && chunked.top === whole.tops.positions.length / 3);
  check('chunks: 40 columns span 3 chunks along x', new Set([...chunksToBuild(map, opts.layout)].map((k) => k.split(',')[0])).size === 3);
  check('chunkOf handles negative cells', chunkOf(-1) === -1 && chunkOf(-16) === -1 && chunkOf(-17) === -2 && chunkOf(15) === 0 && chunkOf(16) === 1);
}

// ---- colours -------------------------------------------------------------------------------------------
{
  const red = hexToLinear('#ff0000'), grey = hexToLinear('#808080');
  check('colour: sRGB hex becomes linear (red stays 1,0,0; mid grey is about 0.216)', red[0] === 1 && red[1] === 0 && Math.abs(grey[0] - 0.2158605) < 1e-5);
  const { map, opts } = flat(2, 2);
  map.preset = { top: '#00ff00', side: '#0000ff' };
  map.place(makeBlock(0, 1, 0, 'Solid', 0, '#ff0000'));
  const c = buildTerrainChunk(opts, chunkRange(0, 0)).solid;
  let topOK = false, sideOK = false;
  for (let v = 0; v < c.positions.length / 3; v++) {
    const up = c.normals[v * 3 + 1] === 1, rgb = [c.colors[v * 3], c.colors[v * 3 + 1], c.colors[v * 3 + 2]];
    if (up && c.positions[v * 3 + 1]! > 0.5 && rgb[0] === 1 && rgb[1] === 0) topOK = true;       // the block's own top colour
    if (!up && c.normals[v * 3 + 1] === 0 && rgb[2] === 1 && rgb[0] === 0) sideOK = true;          // preset side colour
  }
  check('colour: a block uses its own top colour and the preset for what it has none of', topOK && sideOK);
  const dark = flat(2, 1); dark.opts.checker = true; dark.map.place(makeBlock(0, 1, 0)); dark.map.place(makeBlock(1, 1, 0));
  const cc = buildTerrainChunk(dark.opts, chunkRange(0, 0)).solid;
  const shades = new Set<number>(); for (let v = 0; v < cc.colors.length; v += 3) if (cc.colors[v + 1]! > 0) shades.add(+cc.colors[v + 1]!.toFixed(4));
  check('colour: the checker shades neighbouring blocks differently', shades.size >= 2);
}

// ---- image mode ------------------------------------------------------------------------------------------
{
  const map = new BlockMap(); map.layerHeight = 0.5;
  const layout = computeLayout({ image: { widthPx: 280, heightPx: 210 }, grid: GRID, extent: null });
  const opts: TerrainBuildOptions = { map, layout, useImage: true, checker: false };
  check('layout: an image of 280x210 at 70 px per cell is 4x3 cells', layout.bounds.x1 === 4 && layout.bounds.z1 === 3 && layout.range.cx1 === 3 && layout.range.cz1 === 2);
  let t = total(opts);
  check('image: the floor shows the map and has texture coordinates', t.top === 12 * 6 && t.solid === 0);
  const uvs = t.all.flatMap((c) => [...c.tops.uvs]);
  check('image: coordinates cover exactly 0..1, with v up', Math.min(...uvs) === 0 && Math.max(...uvs) === 1 && uvs.length === t.top * 2);
  const corner = t.all[0]!.tops; let topLeft = false;
  for (let v = 0; v < corner.positions.length / 3; v++) if (corner.positions[v * 3] === 0 && corner.positions[v * 3 + 2] === 0 && corner.uvs[v * 2] === 0 && corner.uvs[v * 2 + 1] === 1) topLeft = true;
  check('image: the map\'s top-left corner is (0, 1)', topLeft);

  map.place(makeBlock(1, 1, 1)); map.place(makeBlock(2, 1, 1, 'Slope')); map.place(makeBlock(0, 1, 0, 'Liquid'));
  t = total(opts);
  // Map 4x3 = 12 cells, 3 taken at layer 1 -> 9 floor quads (54) + the cube's top (6) + the ramp surface (6).
  check('image: floor, cube top and ramp surface show the map (9 floor quads + 2 faces = 66 vertices)', t.top === 66, String(t.top));
  // Cube: 4 sides (24). Slope: its left triangle touches the cube and is hidden; right triangle (3) + back wall (6).
  check('image: sides stay coloured and the hidden slope triangle is not drawn (24 + 9 = 33)', t.solid === 33, String(t.solid));
  check('image: water keeps its own batch, never textured with the map (6 faces = 36)', t.liquid === 36, String(t.liquid));

  const off = computeLayout({ image: { widthPx: 280, heightPx: 210 }, grid: { size: 70, offsetX: 21, offsetY: 49 }, extent: null });
  const m2 = new BlockMap();
  const o2: TerrainBuildOptions = { map: m2, layout: off, useImage: true, checker: false };
  const t2 = total(o2);
  let inside = true; for (const c of t2.all) for (let i = 0; i < c.tops.positions.length; i += 3) if (c.tops.positions[i]! < -1e-9 || c.tops.positions[i]! > 4 + 1e-9 || c.tops.positions[i + 2]! < -1e-9 || c.tops.positions[i + 2]! > 3 + 1e-9) inside = false;
  check('offset grid: cells cut by the image edge are clipped inside it', inside && off.range.cx0 === -1 && off.range.cz0 === -1, JSON.stringify(off.range));
}

// ---- water: it must hide what is behind it ---------------------------------------------------------------------------
{
  const { map, opts } = flat(4, 4);
  map.place(makeBlock(1, 1, 1, 'Liquid'));
  const t = total(opts);
  check('water: a single block has all six faces, underside included, so the background cannot show through', faces(t.liquid) === 6, String(faces(t.liquid)));
  let lowest = Infinity, bottomFaces = 0;
  for (const c of t.all) for (let v = 0; v < c.liquid.normals.length; v += 3) if (c.liquid.normals[v + 1] === -1) { bottomFaces++; lowest = Math.min(lowest, c.liquid.positions[v + 1]!); }
  check('water: the underside is at the ground (y = 0)', bottomFaces === 6 && lowest === 0);

  const stacked = flat(4, 4);
  stacked.map.place(makeBlock(1, 1, 1)); stacked.map.place(makeBlock(1, 2, 1, 'Liquid'));
  check('water on a cube: the underside is hidden by the cube (5 faces)', faces(total(stacked.opts).liquid) === 5);

  const colours = (hex?: string, side?: string): Set<string> => {
    const w = flat(4, 4); const b = makeBlock(1, 1, 1, 'Liquid', 0, hex); if (side) b.side = side; w.map.place(b);
    const out = new Set<string>(); for (const c of total(w.opts).all) for (let v = 0; v < c.liquid.colors.length; v += 3) out.add([...c.liquid.colors.slice(v, v + 3)].map((n) => n.toFixed(3)).join());
    return out;
  };
  check('water: with no colour it is water blue on every face, not the preset grass and soil', colours().size === 1);
  check('water: given a colour it is that colour on every face', colours('#ff0000').size === 1 && [...colours('#ff0000')][0] === '1.000,0.000,0.000');
  check('water: an explicit side colour is still honoured', colours('#ff0000', '#00ff00').size === 2);
}

// ---- block edges: what the builder outlines now ----------------------------------------------------------------------
{
  // `edges` replaced `lines`: not a per-cell grid, but the block's own outline, deduplicated across
  // faces and pushed out along the averaged normal. Only opaque blocks emit them.
  const { map, opts } = flat(4, 4);
  check('edges: an empty floor outlines nothing', total(opts).edges === 0);
  map.place(makeBlock(1, 1, 1));
  const one = total(opts);
  check('edges: a cube is outlined', one.edges > 0, String(one.edges));
  check('edges: two vertices of three floats per segment', one.edges % 2 === 0, String(one.edges));

  const wet = flat(4, 4);
  wet.map.place(makeBlock(1, 1, 1, 'Liquid'));
  check('edges: water is never outlined', total(wet.opts).edges === 0);

  // A shared edge is emitted once, not once per face: two cubes side by side have fewer than two
  // separate outlines' worth of segments.
  const pair = flat(4, 4);
  pair.map.place(makeBlock(1, 1, 1)); pair.map.place(makeBlock(2, 1, 1));
  check('edges: neighbours share their touching edge instead of drawing it twice', total(pair.opts).edges < one.edges * 2, `${total(pair.opts).edges} vs ${one.edges * 2}`);
}

// ---- lit normals must be the real geometry's normals at ANY layer height -----------------------------------------------
{
  for (const layerHeight of [1, 0.5, 2]) {
    const { opts } = flat(24, 12, layerHeight);
    let i = 0;
    for (const shape of BLOCK_SHAPES) for (const rot of [0, 90, 180, 270] as const) { opts.map.place(makeBlock((i % 5) * 2 + 1, 1, Math.floor(i / 5) * 2 + 1, shape, rot)); i++; }
    const t = total(opts);
    let bad = '', tris = 0;
    for (const c of t.all) for (const part of [c.solid, c.liquid]) {
      const p = part.positions, n = part.normals;
      for (let v = 0; v < p.length; v += 9) {
        tris++;
        const ux = p[v + 3]! - p[v]!, uy = p[v + 4]! - p[v + 1]!, uz = p[v + 5]! - p[v + 2]!;
        const wx = p[v + 6]! - p[v]!, wy = p[v + 7]! - p[v + 1]!, wz = p[v + 8]! - p[v + 2]!;
        const gx = uy * wz - uz * wy, gy = uz * wx - ux * wz, gz = ux * wy - uy * wx;
        const len = Math.hypot(gx, gy, gz);
        const dot = (gx * n[v]! + gy * n[v + 1]! + gz * n[v + 2]!) / len;
        if (dot < 0.999999) bad = `layer ${layerHeight}: a triangle's real normal differs from its lit normal (dot ${dot.toFixed(4)})`;
      }
    }
    check(`lit normals (layer ${layerHeight}): all ${tris} triangles are lit with the direction they really face`, bad === '' && tris > 100, bad);
  }
  const ramp = flat(1, 1, 0.5); ramp.map.place(makeBlock(0, 1, 0, 'Slope', 0));
  const r = total(ramp.opts).all[0]!.solid;
  let surface: number[] | null = null;
  for (let v = 0; v < r.normals.length; v += 3) if (r.normals[v + 1]! > 0.5 && r.normals[v + 1]! < 0.99) surface = [r.normals[v]!, r.normals[v + 1]!, r.normals[v + 2]!];
  check('ramp at half-cell layers: the surface is lit at its real 26.6 degree slope, not the 45 of a full cube', !!surface && Math.abs(surface[1]! - 2 / Math.sqrt(5)) < 1e-6 && Math.abs(surface[2]! + 1 / Math.sqrt(5)) < 1e-6, JSON.stringify(surface));
}
console.log(failures === 0 ? '\nAll geometry-builder checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);