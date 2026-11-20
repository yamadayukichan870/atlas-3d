import {
  volumeOfArea, volumeOfAura, volumeContains, tokenInVolume, tokensInVolume,
  type VolumeTarget,
} from '../src/terrain/measureVolume';
import type { AtlasMeasurementSettings } from '../src/atlas/measureRules';
import type { Vec3 } from '../src/terrain/shapes';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`);
  if (!ok) failures++;
};
const rules: AtlasMeasurementSettings = {
  mode: 'metric', unitType: 'feet', unitDistance: 5, ruleDistance: 5,
  diagonalRule: 'equidistant', difficultTerrain: 'none', rangeBands: [],
  coneAngle: 90, areaCellRule: 'half', coneEnd: 'round',
};
const at = (x: number, z: number): Vec3[] => [[x, 0, z], [x + 4, 0, z]];

// circle -> dome centred at the floor
{
  const v = volumeOfArea('circle', at(0, 0), 1, rules, 0)!;
  check('circle is a dome', v.kind === 'dome');
  check('dome centre at floor', v.kind === 'dome' && v.centre[1] === 0);
  check('dome radius = drag', v.kind === 'dome' && v.radius === 4);
  check('point on ground inside', volumeContains(v, [3, 0, 0]));
  check('point above radius out', !volumeContains(v, [0, 5, 0]));
  check('point at radius up inside', volumeContains(v, [0, 4, 0]));
}
// square -> cube L×L×L
{
  const v = volumeOfArea('square', at(0, 0), 1, rules, 0)!;
  check('square is a box', v.kind === 'box');
  check('cube height = length', v.kind === 'box' && v.height === 4);
  check('inside at mid height', volumeContains(v, [2, 2, 0]));
  check('above the cube out', !volumeContains(v, [2, 5, 0]));
}
// line -> box as tall as wide
{
  const v = volumeOfArea('line', at(0, 0), 2, rules, 0)!;
  check('line is a box', v.kind === 'box');
  check('line height = width', v.kind === 'box' && v.height === 2);
  check('line width honoured', v.kind === 'box' && v.width === 2);
}
// cone -> real cone, 3D angle
{
  const v = volumeOfArea('cone', at(0, 0), 1, rules, 0)!;
  check('cone is a cone', v.kind === 'cone');
  check('on axis inside', volumeContains(v, [3, 0, 0]));
  check('above axis within angle inside', volumeContains(v, [3, 2, 0]));
  check('behind apex out', !volumeContains(v, [-1, 0, 0]));
}
// aura -> cylinder from the space edge
{
  const v = volumeOfAura({ id: 't', x: 0, z: 0, diameter: 1 }, 10, rules, 0)!;
  check('aura is a cylinder', v.kind === 'cylinder');
  check('radius = space + reach', v.kind === 'cylinder' && Math.abs(v.radius - 2.5) < 1e-9);
  check('height = reach (min 1)', v.kind === 'cylinder' && v.height === 2);
}
// footprint vs effect: a flier above a ground cube
{
  const cube = volumeOfArea('square', at(0, 0), 1, rules, 0)!;
  const ground: VolumeTarget = { id: 'g', x: 2, z: 0, diameter: 1, floorY: 0, lift: 0 };
  const flier: VolumeTarget = { id: 'f', x: 2, z: 0, diameter: 1, floorY: 0, lift: 6 };
  check('ground token in volume', tokenInVolume(cube, ground));
  check('flier above cube out of volume', !tokenInVolume(cube, flier));
  check('tokensInVolume picks only the ground one',
    JSON.stringify(tokensInVolume(cube, [ground, flier])) === '["g"]');
}
// overrides
{
  const lifted = volumeOfArea('circle', at(0, 0), 1, rules, 0, { liftCells: 3 })!;
  check('lift raises the dome centre', lifted.kind === 'dome' && lifted.centre[1] === 3);
  const tall = volumeOfArea('line', at(0, 0), 1, rules, 0, { heightCells: 6 })!;
  check('height override honoured', tall.kind === 'box' && tall.height === 6);
  check('ruler has no volume', volumeOfArea('ruler', at(0, 0), 1, rules, 0) === null);
}
console.log(failures === 0 ? '\nAll volume checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);