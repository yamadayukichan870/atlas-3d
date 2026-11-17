import * as THREE from 'three';
import { BlockMap, makeBlock } from '../src/terrain/blocks';
import { computeLayout } from '../src/terrain/layout';
import { blockAtHit, placementCell } from '../src/terrain/placement';
import { TerrainMeshes } from '../src/view/TerrainMeshes';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`);
  if (!ok) failures++;
};

const GRID = { size: 70, offsetX: 0, offsetY: 0 };
function scene(cols = 40, rows = 4, layerHeight = 1): { map: BlockMap; meshes: TerrainMeshes; rebuild: () => void } {
  const map = new BlockMap();
  map.layerHeight = layerHeight;
  map.surface = 'colors';
  map.extent = { cols, rows };
  const meshes = new TerrainMeshes();
  const layout = computeLayout({ image: null, grid: GRID, extent: map.extent });
  meshes.setOptions({ map, layout, useImage: false, gridLines: false, checker: false });
  return { map, meshes, rebuild: () => meshes.rebuildAll() };
}
const ray = new THREE.Raycaster();
function shoot(meshes: TerrainMeshes, from: [number, number, number], dir: [number, number, number]) {
  ray.set(new THREE.Vector3(...from), new THREE.Vector3(...dir).normalize());
  const hit = ray.intersectObjects(meshes.pickTargets(), false)[0];
  return hit && hit.face ? { point: hit.point, normal: hit.face.normal } : null;
}
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;
const grid = { originX: 0, originZ: 0, layerHeight: 1 };
const arr = (v: THREE.Vector3): [number, number, number] => [v.x, v.y, v.z];

// ---- chunk meshes -----------------------------------------------------------------------------------
{
  const { meshes, rebuild } = scene();
  rebuild();
  check('chunks: a 40x4 floor makes one solid mesh per chunk (3 chunks along x)', meshes.pickTargets().length === 3, String(meshes.pickTargets().length));
  check('chunks: every mesh is parented to the terrain group', meshes.group.children.length === 3);
}

// ---- picking with the real raycaster ---------------------------------------------------------------------
{
  const { map, meshes, rebuild } = scene();
  map.place(makeBlock(5, 1, 2));
  rebuild();

  const top = shoot(meshes, [5.5, 10, 2.5], [0, -1, 0]);
  check('ray from above hits the cube top, normal up', !!top && near(top.point.y, 1) && near(top.normal.y, 1), JSON.stringify(top));
  if (top) {
    const hit = blockAtHit(arr(top.point), arr(top.normal), grid);
    const add = placementCell(arr(top.point), arr(top.normal), grid);
    check('pipeline: the hit belongs to the cube, "add" stacks on layer 2', hit.x === 5 && hit.y === 1 && hit.z === 2 && add.y === 2 && add.x === 5 && add.z === 2, JSON.stringify([hit, add]));
  }
  const side = shoot(meshes, [20, 0.5, 2.5], [-1, 0, 0]);
  check('ray from the +x side hits the cube wall, normal +x', !!side && near(side.point.x, 6) && near(side.normal.x, 1), JSON.stringify(side));
  if (side) check('pipeline: "add" on that wall goes to the next cell over', placementCell(arr(side.point), arr(side.normal), grid).x === 6);

  const floor = shoot(meshes, [10.5, 10, 2.5], [0, -1, 0]);
  check('ray at empty ground hits the floor; "add" puts a block on layer 1', !!floor && near(floor.point.y, 0) && placementCell(arr(floor.point), arr(floor.normal), grid).y === 1);

  // The old Slope/Steps wound inward and only DoubleSide hid it. With FrontSide, a ray from INSIDE must not hit its own faces.
  const inside = shoot(meshes, [5.5, 0.5, 2.5], [0, 1, 0]);
  check('backface culling: a ray starting inside the cube does not hit its top from within', inside === null, JSON.stringify(inside));
}

// ---- the shapes that used to wind inward -----------------------------------------------------------------
{
  const { map, meshes, rebuild } = scene(40, 4, 1);
  map.place(makeBlock(3, 1, 1, 'Slope', 0));
  map.place(makeBlock(8, 1, 1, 'Steps', 0));
  map.place(makeBlock(12, 1, 1, 'Slope', 90));
  rebuild();

  const ramp = shoot(meshes, [3.5, 10, 1.5], [0, -1, 0]);
  check('slope: a ray from above hits the ramp surface at mid height (0.5)', !!ramp && near(ramp.point.y, 0.5), JSON.stringify(ramp));
  check('slope: the hit normal tilts up and towards the low side (-z)', !!ramp && near(ramp.normal.y, Math.SQRT1_2) && near(ramp.normal.z, -Math.SQRT1_2), JSON.stringify(ramp?.normal));
  if (ramp) check('slope: "add" on the ramp goes above it, not beside', placementCell(arr(ramp.point), arr(ramp.normal), grid).y === 2);

  const back = shoot(meshes, [3.5, 0.5, 10], [0, 0, -1]);
  check('slope: the back wall (z = 2) is hit from outside, normal +z', !!back && near(back.point.z, 2) && near(back.normal.z, 1), JSON.stringify(back));

  const lowTread = shoot(meshes, [8.5, 10, 1.25], [0, -1, 0]);
  const highTread = shoot(meshes, [8.5, 10, 1.75], [0, -1, 0]);
  check('steps: the low tread is at half a layer, the high one at a full layer', !!lowTread && !!highTread && near(lowTread.point.y, 0.5) && near(highTread.point.y, 1), `${lowTread?.point.y} ${highTread?.point.y}`);
  check('steps: both treads face up (the two that used to wind inward)', !!lowTread && !!highTread && near(lowTread.normal.y, 1) && near(highTread.normal.y, 1));
  const riser = shoot(meshes, [8.5, 0.75, -5], [0, 0, 1]);
  check('steps: the middle riser (z = 1.5) faces -z and is reachable from the low side', !!riser && near(riser.point.z, 1.5) && near(riser.normal.z, -1), JSON.stringify(riser));

  const turned = shoot(meshes, [12.5, 10, 1.5], [0, -1, 0]);
  check('rotation: a slope turned 90 degrees now tilts towards -x', !!turned && turned.normal.x < -0.7 && near(turned.normal.z, 0), JSON.stringify(turned?.normal));
}

// ---- editing: dirty chunks, including across a chunk border ---------------------------------------------------
{
  const { map, meshes, rebuild } = scene(40, 4, 1);
  map.place(makeBlock(5, 1, 1));
  rebuild();
  check('flush: nothing dirty yet', meshes.flush() === false);

  const c = map.place(makeBlock(7, 1, 1));
  check('edit: not visible until the chunk is rebuilt', c !== null && shoot(meshes, [7.5, 10, 1.5], [0, -1, 0])?.point.y === 0);
  meshes.markDirty(7, 1);
  check('flush: reports it rebuilt something, then nothing', meshes.flush() === true && meshes.flush() === false);
  check('edit: the new block is hit after the flush', near(shoot(meshes, [7.5, 10, 1.5], [0, -1, 0])?.point.y ?? -1, 1));

  // Blocks 15 and 16 sit on either side of a chunk border: their touching walls are hidden.
  map.place(makeBlock(15, 1, 1)); map.place(makeBlock(16, 1, 1));
  meshes.markDirty(15, 1); meshes.markDirty(16, 1); meshes.flush();
  check('border: the wall between blocks 15 and 16 is hidden (a ray from +x hits block 16, not 15)', near(shoot(meshes, [30, 0.5, 1.5], [-1, 0, 0])?.point.x ?? -1, 17));
  const removal = map.remove(16, 1, 1);
  meshes.markDirty(16, 1); meshes.flush();
  const after = shoot(meshes, [30, 0.5, 1.5], [-1, 0, 0]);
  check('border: removing 16 brings back the wall of 15, which lives in the OTHER chunk', removal !== null && !!after && near(after.point.x, 16) && near(after.normal.x, 1), JSON.stringify(after));
}

// ---- cleanup ------------------------------------------------------------------------------------------------------
{
  const { map, meshes, rebuild } = scene();
  map.place(makeBlock(1, 1, 1)); rebuild();
  let threw = false;
  try { meshes.dispose(); meshes.dispose(); } catch { threw = true; }
  check('dispose: safe, and twice', !threw);
}

console.log(failures === 0 ? '\nAll terrain-mesh checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
