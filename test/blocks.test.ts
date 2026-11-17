import { BlockMap, makeBlock, normalizeRotation, parseBlock, parseTerrain, serializeBlock, MAX_LAYERS, type Block, type BlockChange } from '../src/terrain/blocks';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`);
  if (!ok) failures++;
};

// ---- the model -------------------------------------------------------------------------------
{
  const m = new BlockMap();
  m.layerHeight = 0.5;
  for (let y = 1; y <= 3; y++) m.place(makeBlock(2, y, 5));
  check('place: top layer follows the highest block', m.topLayer(2, 5) === 3 && m.count === 3);
  m.remove(2, 2, 5);
  check('remove: a block in the middle leaves the top alone', m.topLayer(2, 5) === 3 && m.get(2, 2, 5) === undefined);
  m.remove(2, 3, 5);
  check('remove: taking the top steps down to the next block below (skipping the hole)', m.topLayer(2, 5) === 1);
  m.remove(2, 1, 5);
  check('remove: an emptied column is flat ground again', m.topLayer(2, 5) === 0 && m.topBlock(2, 5) === undefined && m.surfaceHeight(2, 5) === 0);

  const f = new BlockMap();
  f.place(makeBlock(0, 5, 0));
  check('floating: a block with nothing below still sets the column top', f.topLayer(0, 0) === 5);
  f.remove(0, 5, 0);
  check('floating: removing it clears the column', f.topLayer(0, 0) === 0);

  const a = makeBlock(1, 1, 1, 'Slope', 90, '#ff0000');
  check('place: returns the change with before = null', m.place(a)?.before === null);
  check('place: the same block again changes nothing', m.place({ ...a }) === null);
  const swapped = m.place({ ...a, shape: 'Steps' });
  check('place: replacing reports what was there', swapped?.before?.shape === 'Slope' && swapped?.after?.shape === 'Steps');
  check('place: layer 0, above the maximum and fractions are refused', m.place(makeBlock(0, 0, 0)) === null && m.place(makeBlock(0, MAX_LAYERS + 1, 0)) === null && m.place(makeBlock(0.5, 1, 0)) === null);

  const g = new BlockMap();
  g.layerHeight = 0.5;
  g.place(makeBlock(0, 1, 0)); g.place(makeBlock(0, 2, 0));
  g.place(makeBlock(1, 1, 0, 'Slab'));
  g.place(makeBlock(2, 1, 0, 'Slope'));
  check('surfaceHeight: two half-cell layers of cube stand at 1.0', g.surfaceHeight(0, 0) === 1);
  check('surfaceHeight: a slab is half a layer', g.surfaceHeight(1, 0) === 0.25);
  check('surfaceHeight: a slope is read at its middle', g.surfaceHeight(2, 0) === 0.25);
  check('topPlaneHeight: a slope reaches its full layer', g.topPlaneHeight(2, 0) === 0.5);
}

// ---- history ---------------------------------------------------------------------------------
{
  const m = new BlockMap();
  m.place(makeBlock(0, 1, 0));
  const before = JSON.stringify(m.toData());
  const stroke: BlockChange[] = [];
  for (const c of [m.place(makeBlock(0, 2, 0)), m.place(makeBlock(1, 1, 0, 'Slab')), m.remove(0, 1, 0), m.place(makeBlock(0, 1, 0, 'Steps'))]) if (c) stroke.push(c);
  const after = JSON.stringify(m.toData());
  m.apply(stroke, 'undo');
  check('history: undo restores the exact earlier map, tops included', JSON.stringify(m.toData()) === before && m.topLayer(0, 0) === 1);
  m.apply(stroke, 'do');
  check('history: redo reproduces the edit', JSON.stringify(m.toData()) === after);
}

// ---- the file format ---------------------------------------------------------------------------
{
  const b: Block = { x: -3, y: 2, z: 7, rot: 270, shape: 'Slope', top: '#aabbcc', side: '#112233', destroyable: false, marks: 'A1' };
  check('line: serialises in IsoCON order x|z|y|rot|shape|destroyable|marks|top|side', serializeBlock(b) === '-3|7|2|270|Slope|false|A1|#aabbcc|#112233', serializeBlock(b));
  const rt = parseBlock(serializeBlock(b));
  const fields = ['x', 'y', 'z', 'rot', 'shape', 'top', 'side', 'destroyable', 'marks'] as const;
  check('line: round trip keeps every field', rt !== null && fields.every((k) => rt[k] === b[k]), JSON.stringify(rt));
  const plain = parseBlock('0|0|1|0|Solid|true||');
  check('line: empty colours mean "use the preset"', plain !== null && plain.top === undefined && plain.side === undefined);
  check('line: a bad line is null, not an exception', parseBlock('x') === null && parseBlock(5) === null && parseBlock('a|b|c|d|e') === null);
  const odd = parseBlock('1|2|2.4|450|Wobbly|true||notacolour|#12');
  check('line: odd fields fall back (y rounds, 450 -> 90, unknown shape -> Solid, bad colours dropped)', odd?.y === 2 && odd.rot === 90 && odd.shape === 'Solid' && odd.top === undefined && odd.side === undefined, JSON.stringify(odd));
  check('rotation: normalised to 0/90/180/270', normalizeRotation(-90) === 270 && normalizeRotation(360) === 0 && normalizeRotation(44) === 0 && normalizeRotation(46) === 90);

  const m = new BlockMap();
  m.layerHeight = 1; m.surface = 'colors'; m.extent = { cols: 9, rows: 7 }; m.preset = { top: '#010203', side: '#040506' };
  m.place(b); m.place(makeBlock(0, 1, 0)); m.place(makeBlock(0, 2, 0, 'Liquid'));
  const data = JSON.parse(JSON.stringify(m.toData()));
  const back = parseTerrain(data);
  check('v2: whole map round trips (settings and blocks)', back.migrated === false && back.map.layerHeight === 1 && back.map.surface === 'colors'
    && back.map.extent?.cols === 9 && back.map.extent?.rows === 7 && back.map.preset.top === '#010203' && back.map.count === 3 && back.map.get(0, 2, 0)?.shape === 'Liquid');
  check('v2: output is sorted, so saves diff cleanly', JSON.stringify(m.toData()) === JSON.stringify(parseTerrain(data).map.toData()));
}

// ---- older formats -----------------------------------------------------------------------------
{
  const v1 = parseTerrain({ version: 1, stepHeight: 0.5, heights: { '2,3': 2, '-1,0': 1, 'a,b': 3, '1,1': 'x', '4,4': 999 } });
  check('v1 (heights): becomes stacked cubes, with the old step as the layer height', v1.migrated && v1.map.layerHeight === 0.5 && v1.map.get(2, 1, 3) && v1.map.get(2, 2, 3) && !v1.map.get(2, 3, 3) ? true : false);
  check('v1: negative cells survive, junk is skipped, huge heights are capped', v1.map.get(-1, 1, 0) !== undefined && v1.map.topLayer(4, 4) === MAX_LAYERS && v1.map.count === 2 + 1 + MAX_LAYERS);
  check('v1: stays in image mode, like before', v1.map.surface === 'image' && v1.map.extent === null);

  const legacy = parseTerrain({
    version: '1.0', gridSize: 12, preset: { top: '#3E713E', side: '#5B442A' },
    blocks: ['0|0|1|0|Solid|true||#3E713E|#5B442A', '5|3|2|90|Slope|true||#ff0000|#5B442A', '7|7|1|0|Liquid|false||#0284c7|#0284c7', 'garbage'],
  });
  check('legacy satellite: read as a coloured 12x12 map, one layer per cell, no image', legacy.migrated && legacy.map.surface === 'colors' && legacy.map.layerHeight === 1
    && legacy.map.extent?.cols === 12 && legacy.map.extent?.rows === 12);
  check('legacy satellite: blocks, rotation and colours come through; garbage is skipped', legacy.map.count === 3 && legacy.map.get(5, 2, 3)?.rot === 90 && legacy.map.get(5, 2, 3)?.top === '#ff0000' && legacy.map.get(7, 1, 7)?.shape === 'Liquid');
  check('legacy satellite: a missing or silly gridSize falls back to 12', parseTerrain({ blocks: [], gridSize: -4 }).map.extent?.cols === 12);
}

// ---- hostile input ---------------------------------------------------------------------------
{
  let threw = false;
  const inputs: unknown[] = [null, undefined, 5, 'x', [], {}, { version: 2 }, { version: 2, blocks: 7 }, { version: 2, extent: { cols: -1, rows: 'a' } },
    { version: 2, layerHeight: -3, surface: 'nope', preset: { top: 5 } }, { heights: null }, { blocks: 'x' }];
  for (const i of inputs) { try { parseTerrain(i); } catch { threw = true; } }
  check('hostile data never throws', !threw);
  const odd = parseTerrain({ version: 2, layerHeight: -3, surface: 'nope', extent: { cols: -1, rows: 4 } }).map;
  check('hostile data falls back to defaults (a cube is one cell tall)', odd.layerHeight === 1 && odd.surface === 'image' && odd.extent === null);
}


// ---- the real surface under a point -----------------------------------------------------------------------------
{
  const m = new BlockMap();
  check('a cube is a true cube by default: layers are one cell tall', m.layerHeight === 1);
  m.place(makeBlock(2, 1, 3, 'Slope', 0));
  m.place(makeBlock(5, 1, 0, 'Steps', 0));
  m.place(makeBlock(7, 2, 0, 'Slab', 0));
  m.place(makeBlock(7, 1, 0));
  check('surface: a ramp is a straight slope (0.25 a quarter of the way up, 0.9 near the top)', m.surfaceHeightAt(2.5, 3.25) === 0.25 && Math.abs(m.surfaceHeightAt(2.5, 3.9) - 0.9) < 1e-9);
  check('surface: steps are two levels, 0.5 then 1', m.surfaceHeightAt(5.5, 0.25) === 0.5 && m.surfaceHeightAt(5.5, 0.75) === 1);
  check('surface: a slab on a cube stands at 1.5 and flat ground at 0', m.surfaceHeightAt(7.5, 0.5) === 1.5 && m.surfaceHeightAt(9.5, 9.5) === 0);
  check('surface: negative cells work', new BlockMap().surfaceHeightAt(-3.5, -0.5) === 0);
  m.layerHeight = 0.5;
  check('surface: scales with the layer height', m.surfaceHeightAt(5.5, 0.75) === 0.5);
  m.layerHeight = 1;

  const flat = m.sampleDisc(9.5, 9.5, 0.46);
  check('disc: flat ground has no spread', flat.min === 0 && flat.max === 0 && flat.center === 0);
  const onRamp = m.sampleDisc(2.5, 3.5, 0.4);
  check('disc: on a ramp the base spans from low to high, middle in between', onRamp.min < 0.2 && onRamp.max > 0.8 && Math.abs(onRamp.center - 0.5) < 1e-9, JSON.stringify(onRamp));
  const onStairs = m.sampleDisc(5.5, 0.5, 0.3);
  check('disc: on the boundary of a stair it spans both treads (0.5 .. 1)', onStairs.min === 0.5 && onStairs.max === 1, JSON.stringify(onStairs));
  const reach = m.sampleDisc(6.9, 0.5, 0.3);
  check('disc: ... and a base next to a cube column is lifted to its top', reach.max === 1.5, JSON.stringify(reach));

  const n = m.rampNormalAt(2.5, 3.5);
  check('ramp normal: a ramp leans up and towards its low side', !!n && Math.abs(n[1] - Math.SQRT1_2) < 1e-9 && Math.abs(n[2] + Math.SQRT1_2) < 1e-9);
  check('ramp normal: stairs, cubes and empty ground give none', m.rampNormalAt(5.5, 0.5) === null && m.rampNormalAt(7.5, 0.5) === null && m.rampNormalAt(9.5, 9.5) === null);
}

// ---- the ramp's lean follows the real slope ----------------------------------------------------------------------------------
{
  const m = new BlockMap();
  m.place(makeBlock(0, 1, 0, 'Slope', 0));
  const tilt = (L: number): number => { m.layerHeight = L; const n = m.rampNormalAt(0.5, 0.5)!; return (Math.acos(n[1]) * 180) / Math.PI; };
  check('ramp lean: 45 degrees with whole-cell layers', Math.abs(tilt(1) - 45) < 1e-9);
  check('ramp lean: 26.6 degrees with half-cell layers, the slope the ground really has', Math.abs(tilt(0.5) - 26.565051177) < 1e-6, String(tilt(0.5)));
  // The normal must be perpendicular to the ground's own slope, whatever the layer height.
  let perpendicular = true;
  for (const L of [0.25, 0.5, 1, 2]) {
    m.layerHeight = L;
    const n = m.rampNormalAt(0.5, 0.5)!;
    const rise = m.surfaceHeightAt(0.5, 0.75) - m.surfaceHeightAt(0.5, 0.25);       // along z, over 0.5 cells
    const along = [0, rise, 0.5];                                                      // a vector lying in the ground
    if (Math.abs(n[0] * along[0]! + n[1] * along[1]! + n[2] * along[2]!) > 1e-9) perpendicular = false;
  }
  check('ramp lean: always perpendicular to the ground (checked against the surface height itself)', perpendicular);
}
console.log(failures === 0 ? '\nAll block-model checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
