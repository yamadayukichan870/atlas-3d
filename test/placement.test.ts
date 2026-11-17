import { blockAtHit, placementCell } from '../src/terrain/placement';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`);
  if (!ok) failures++;
};
const same = (a: { x: number; y: number; z: number }, x: number, y: number, z: number): boolean => a.x === x && a.y === y && a.z === z;
const show = (a: unknown): string => JSON.stringify(a);

const flat = { originX: 0, originZ: 0, layerHeight: 1 };
const half = { originX: 0, originZ: 0, layerHeight: 0.5 };

// The floor: layer 0 is "the ground", so adding there puts a block on layer 1.
{
  const hit = blockAtHit([2.5, 0, 3.5], [0, 1, 0], flat);
  check('floor hit: owner is layer 0 (ground), not a block', same(hit, 2, 0, 3), show(hit));
  check('floor hit: "add" places on layer 1 of that cell', same(placementCell([2.5, 0, 3.5], [0, 1, 0], flat), 2, 1, 3));
}
// Top of a block at layer 2 with half-cell layers: layer 2 spans y 0.5..1.0.
{
  check('top hit: owner is the block at layer 2', same(blockAtHit([4.5, 1.0, 1.5], [0, 1, 0], half), 4, 2, 1));
  check('top hit: "add" stacks on layer 3', same(placementCell([4.5, 1.0, 1.5], [0, 1, 0], half), 4, 3, 1));
}
// Side of a block: the new block goes next to it, at the same height.
{
  const p: [number, number, number] = [4, 0.25, 3.5];
  check('side hit (+x): owner is the cell inside the face', same(blockAtHit(p, [1, 0, 0], half), 3, 1, 3), show(blockAtHit(p, [1, 0, 0], half)));
  check('side hit (+x): "add" goes to the next cell over, same layer', same(placementCell(p, [1, 0, 0], half), 4, 1, 3));
  check('side hit (-z): "add" goes to z - 1', same(placementCell([3.5, 0.25, 3], [0, 0, -1], half), 3, 1, 2));
}
// A ramp's tilted face places on top rather than beside.
{
  const n: [number, number, number] = [0, Math.SQRT1_2, -Math.SQRT1_2];
  const hit = placementCell([2.5, 0.5, 2.5], n, flat);
  check('ramp hit: the tilted face places above (tie goes to vertical)', hit.y === blockAtHit([2.5, 0.5, 2.5], n, flat).y + 1 && hit.x === 2 && hit.z === 2, show(hit));
}
// A grid whose origin is not at the map corner, and cells left of / above the origin.
{
  const off = { originX: 0.3, originZ: 0.7, layerHeight: 1 };
  check('offset grid: cell index is counted from the grid origin', same(blockAtHit([1.4, 0, 2.0], [0, 1, 0], off), 1, 0, 1), show(blockAtHit([1.4, 0, 2.0], [0, 1, 0], off)));
  check('negative cells: just left of the origin is cell -1', same(blockAtHit([-0.5, 0, -0.5], [0, 1, 0], flat), -1, 0, -1));
}
// A hit exactly on a boundary between two blocks is resolved by the face it hit, not by rounding luck.
{
  check('boundary: a hit on the +x face of cell 3 belongs to 3, not 4', blockAtHit([4, 0.5, 0.5], [1, 0, 0], flat).x === 3);
  check('boundary: a hit on the -x face of cell 4 belongs to 4, not 3', blockAtHit([4, 0.5, 0.5], [-1, 0, 0], flat).x === 4);
}

console.log(failures === 0 ? '\nAll placement checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
