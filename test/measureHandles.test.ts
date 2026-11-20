import {
  auraBadgePoint,
  auraCells,
  auraCellsDragged,
  auraCellsOfCircle,
  auraDirection,
  auraOfCells,
  auraPoints,
  areaResizedBy,
  bandReachOf,
  countsCells,
  fittedReach,
  heightChipText,
  heightField,
  measureMovedBy,
  rimSpots,
  signedHeight,
  spaceRadius,
  steppedAura,
  steppedHeight,
  steppedReach,
  tokenHeight,
  tokenHolding,
  type HandleGrid,
  type HandleToken,
} from '../src/terrain/measureHandles';
import type { AtlasMeasurementSettings } from '../src/atlas/measureRules';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`);
  if (!ok) failures++;
};
const near = (a: number, b: number, tol = 1e-9): boolean => Math.abs(a - b) <= tol;
const at = (p: { x: number; z: number }, x: number, z: number, tol = 1e-9): boolean =>
  near(p.x, x, tol) && near(p.z, z, tol);
const show = (a: unknown): string => JSON.stringify(a);

const grid: HandleGrid = { cellSize: 1, originX: 0, originZ: 0 };
const freeGrid: HandleGrid = { cellSize: 1, originX: 0, originZ: 0, snapToGrid: false };

const metric: AtlasMeasurementSettings = {
  mode: 'metric', unitType: 'feet', unitDistance: 5, ruleDistance: 5,
  diagonalRule: 'equidistant', difficultTerrain: 'none', rangeBands: [],
  coneAngle: 90, areaCellRule: 'half', coneEnd: 'round',
};
const banded: AtlasMeasurementSettings = {
  ...metric, mode: 'abstract',
  rangeBands: [{ name: 'Close', maxSquares: 2 }, { name: 'Far', maxSquares: 6 }],
};

const one: HandleToken = { id: 'a', x: 5, z: 5, diameter: 1 };
const big: HandleToken = { id: 'b', x: 10, z: 10, diameter: 3 };

// ---- reach: game units to cells and back -----------------------------------------------------
{
  check('auraCells: 10ft on a 5ft grid is 2 cells', auraCells(10, 5) === 2);
  check('auraCells: 7ft on a 5ft grid is 1.4 cells', near(auraCells(7, 5), 1.4));
  check('auraOfCells: 2 cells is 10ft', auraOfCells(2, 5) === 10);
  check('auraOfCells: no reach is 0, never negative', auraOfCells(-3, 5) === 0);
  check('fittedReach: on cells, 1.4 fits to one whole cell', fittedReach(1.4, grid, false) === 1, show(fittedReach(1.4, grid, false)));
  check('fittedReach: on cells, nothing smaller than one', fittedReach(-4, grid, false) === 1);
  check('fittedReach: free keeps tenths', near(fittedReach(1.44, grid, true), 1.4));
  check('fittedReach: free never below half a cell', fittedReach(0.01, grid, true) === 0.5);
  check('fittedReach: Snap off is free even without the key', near(fittedReach(1.44, freeGrid, false), 1.4));
  check('countsCells: Snap off means no cells to grow', countsCells(freeGrid) === false);
}

// ---- the token's space -----------------------------------------------------------------------
{
  check('spaceRadius: a 1x1 takes half a cell either side', spaceRadius(one, grid) === 0.5);
  check('spaceRadius: a 3x3 takes one and a half', spaceRadius(big, grid) === 1.5);
  const held = tokenHolding({ x: 5, z: 5 }, [one], grid);
  check('tokenHolding: the middle is inside', held?.id === 'a');
  check('tokenHolding: the rim is NOT inside', tokenHolding({ x: 5.5, z: 5 }, [one], grid) === null);
  const pile: HandleToken[] = [{ ...one, id: 'under', layer: 0 }, { ...one, id: 'over', layer: 2 }];
  check('tokenHolding: the one on top is picked', tokenHolding({ x: 5, z: 5 }, pile, grid)?.id === 'over');
}

// ---- the badge on the rim --------------------------------------------------------------------
{
  const first = auraBadgePoint(one, grid, 0);
  check('badge 0: lower left of the token (x smaller, z larger)', first.x < 5 && first.z > 5, show(first));
  check('badge 0: exactly on the rim', near(Math.hypot(first.x - 5, first.z - 5), 0.5), show(first));
  check('badge 0: the direction Atlas names', at(first, 5 - Math.SQRT1_2 * 0.5, 5 + Math.SQRT1_2 * 0.5), show(first));
  const tenth = auraBadgePoint(one, grid, 10);
  check('badge 10: a full turn returns to the first place', at(tenth, first.x, first.z, 1e-9), show(tenth));
  const second = auraBadgePoint(one, grid, 1);
  check('badge 1: a step along the rim, not on the first', !at(second, first.x, first.z, 1e-6));
  check('badge 1: still on the rim', near(Math.hypot(second.x - 5, second.z - 5), 0.5));
}

// ---- several measurements on one token -------------------------------------------------------
{
  const measures = [
    { id: 'm1', follows: 'a', points: [] },
    { id: 'm2', follows: 'a', points: [] },
    { id: 'm3', points: [{ x: 10, z: 10 }] },
    { id: 'm4', points: [{ x: 40, z: 40 }] },
  ];
  const spots = rimSpots(measures, [one, big], grid);
  check('rimSpots: an aura is placed', spots.has('m1'));
  check('rimSpots: two auras of one token do not overlap', !at(spots.get('m1')!, spots.get('m2')!.x, spots.get('m2')!.z, 1e-6));
  check('rimSpots: a measurement starting on a token goes to its rim', spots.has('m3'));
  check('rimSpots: a measurement on no token is not among them', !spots.has('m4'));
  check('rimSpots: the third follows the big token, not the small one', near(Math.hypot(spots.get('m3')!.x - 10, spots.get('m3')!.z - 10), 1.5));
}

// ---- the far handle --------------------------------------------------------------------------
{
  check('auraDirection: the way its points lie', at(auraDirection([{ x: 0, z: 0 }, { x: 3, z: 0 }]), 1, 0));
  check('auraDirection: no direction is to the right', at(auraDirection([{ x: 2, z: 2 }, { x: 2, z: 2 }]), 1, 0));
  check('auraDirection: no points at all is to the right', at(auraDirection([]), 1, 0));
  const pts = auraPoints(one, 2, grid);
  check('auraPoints: from the token centre', at(pts[0], 5, 5));
  check('auraPoints: to the reach past the EDGE (0.5 + 2)', at(pts[1], 7.5, 5), show(pts[1]));
  check('auraCellsDragged: dragging one cell along the handle adds one', auraCellsDragged(2, { x: 1, z: 0 }, { x: 1, z: 0 }, grid) === 3);
  check('auraCellsDragged: dragging across it adds nothing', auraCellsDragged(2, { x: 0, z: 4 }, { x: 1, z: 0 }, grid) === 2);
  check('auraCellsDragged: dragging back never below one cell', auraCellsDragged(2, { x: -9, z: 0 }, { x: 1, z: 0 }, grid) === 1);
  check('auraCellsOfCircle: a circle of 2.5 around a 1x1 becomes a 2-cell aura', auraCellsOfCircle([{ x: 5, z: 5 }, { x: 7.5, z: 5 }], one, grid) === 2);
}

// ---- stepping a reach ------------------------------------------------------------------------
{
  check('steppedReach: by cells, one cell a step', steppedReach(2, 1, metric) === 3);
  check('steppedReach: by cells, below none is allowed (a height)', steppedReach(2, -3, metric) === -1);
  check('bandReachOf: 1 cell is Close', bandReachOf(1, banded)?.name === 'Close');
  check('bandReachOf: past them all is the farthest', bandReachOf(99, banded)?.name === 'Far');
  check('steppedReach: by bands, from none to the first', steppedReach(0, 1, banded) === 2);
  check('steppedReach: by bands, on to the second', steppedReach(0, 2, banded) === 6);
  check('steppedReach: by bands, past the farthest it stays', steppedReach(0, 5, banded) === 6);
  check('steppedReach: by bands, down through none to the other side', steppedReach(0, -1, banded) === -2);
  check('steppedAura: 0 + one step is one cell of reach', steppedAura(0, 1, metric) === 5, show(steppedAura(0, 1, metric)));
  check('steppedAura: on a banded map it jumps band to band', steppedAura(5, 1, banded) === 10, show(steppedAura(5, 1, banded)));
  check('steppedAura: never below none', steppedAura(5, -4, metric) === 0);
}

// ---- moving and resizing ---------------------------------------------------------------------
{
  const ruler = [{ x: 0.5, z: 0.5 }, { x: 3.5, z: 0.5 }];
  const moved = measureMovedBy('ruler', ruler, { x: 1, z: 0 }, grid);
  check('measureMovedBy: a ruler start snaps to a cell centre', at(moved[0]!, 1.5, 0.5), show(moved));
  check('measureMovedBy: the rest follow by the same delta', at(moved[1]!, 4.5, 0.5), show(moved));
  const nudged = measureMovedBy('ruler', ruler, { x: 0.2, z: 0 }, grid);
  check('measureMovedBy: a nudge inside the cell does not move it', at(nudged[0]!, 0.5, 0.5), show(nudged));
  check('measureMovedBy: no points is no path', measureMovedBy('ruler', [], { x: 1, z: 0 }, grid).length === 0);

  const area = [{ x: 0, z: 0 }, { x: 3, z: 0 }];
  check('areaResizedBy: a drag short of half a cell keeps the size', at(areaResizedBy(area, { x: 0.4, z: 0 }, grid)[1]!, 3, 0));
  check('areaResizedBy: past half a cell takes the next whole cell', at(areaResizedBy(area, { x: 0.6, z: 0 }, grid)[1]!, 4, 0));
  check('areaResizedBy: the origin never moves', at(areaResizedBy(area, { x: 5, z: 0 }, grid)[0]!, 0, 0));
  const collapsed = areaResizedBy([{ x: 0, z: 0 }, { x: 1, z: 0 }], { x: -1, z: 0 }, grid);
  check('areaResizedBy: an end that lands on the origin stays where it was', at(collapsed[1]!, 1, 0), show(collapsed));
}

// ---- a token's height ------------------------------------------------------------------------
{
  check('tokenHeight: below the floor is kept (a pit, a swimmer)', tokenHeight({ elevation: -10 }) === -10);
  check('tokenHeight: no height is the floor', tokenHeight({}) === 0);
  check('tokenHeight: a value that is no number is the floor', tokenHeight({ elevation: 'up' }) === 0);
  check('heightField: landing removes the field', heightField(0).elevation === undefined);
  check('heightField: a height is written', heightField(25).elevation === 25);
  check('heightChipText: nothing on the floor', heightChipText({ elevation: 0 }, metric) === '');
  check('heightChipText: above the floor', heightChipText({ elevation: 25 }, metric) === '↑ 25ft', heightChipText({ elevation: 25 }, metric));
  check('heightChipText: below the floor', heightChipText({ elevation: -10 }, metric) === '↓ 10ft', heightChipText({ elevation: -10 }, metric));
  check('heightChipText: a banded map names the band', heightChipText({ elevation: 5 }, banded) === '↑ Close', heightChipText({ elevation: 5 }, banded));
  check('signedHeight: a banded map writes a dash on the floor', signedHeight(0, banded) === '–');
  check('signedHeight: below the floor uses a real minus', signedHeight(-10, metric) === '−10ft', signedHeight(-10, metric));
  check('steppedHeight: by cells, one cell of game units', steppedHeight(0, 1, metric) === 5);
  check('steppedHeight: below the floor is reachable', steppedHeight(0, -2, metric) === -10);
  check('steppedHeight: by bands, to the next band', steppedHeight(0, 1, banded) === 10, show(steppedHeight(0, 1, banded)));
}

console.log(failures === 0 ? '\nAll measure-handle checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);