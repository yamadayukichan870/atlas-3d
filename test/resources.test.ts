import { inferDefs, parseDefs, resourcesOf, slotResources, stepValue } from '../src/atlas/resources';
import type { AtlasResourceDef, AtlasToken } from '../src/atlas/types';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`);
  if (!ok) failures++;
};
const def = (key: string, slot?: number, direction: AtlasResourceDef['direction'] = 'drains'): AtlasResourceDef => {
  const d: AtlasResourceDef = { key, name: key, color: '#112233', direction };
  if (slot !== undefined) d.slot = slot;
  return d;
};
const keys = (list: { key: string }[]): string => list.map((v) => v.key).join();

// The layout seen in the screenshot: two bars under the token, two wheels each side.
const SCREENSHOT: AtlasResourceDef[] = [
  def('hp', 0), def('stress', 1, 'fills'), def('hp-markers', 2), def('barriers', 3), def('gauge', 4), def('fate-points', 5),
];
const token: AtlasToken = {
  id: 't', kind: 'character', x: 0, y: 0, imagePath: 'a.png',
  resources: { hp: { current: 19, max: 19 }, stress: { current: 0, max: 5 }, 'hp-markers': { current: 2, max: 2 }, barriers: { current: 4, max: 4 }, gauge: { current: 4, max: 4 }, 'fate-points': { current: 3, max: 3 } },
};

// ---- sockets -----------------------------------------------------------------------------------
{
  check('slots: stored sockets are kept in socket order', slotResources([def('b', 3), def('a', 0)]).map((s) => s.slot).join() === '0,3');
  check('slots: a resource without a socket takes the first free one, in list order', slotResources([def('a', 1), def('b'), def('c')]).map((s) => `${s.def.key}${s.slot}`).join() === 'b0,a1,c2');
  check('slots: the first claimant of a socket keeps it, the other waits for a free one', slotResources([def('a', 2), def('b', 2)]).map((s) => `${s.def.key}${s.slot}`).join() === 'b0,a2');
  check('slots: out-of-range or fractional sockets are treated as unset', slotResources([def('a', 9), def('b', 1.5), def('c', -1)]).map((s) => s.slot).join() === '0,1,2');
  check('slots: a token shows at most six', slotResources(Array.from({ length: 9 }, (_, i) => def('r' + i))).length === 6);
}

// ---- where each resource goes ------------------------------------------------------------------------
{
  const r = resourcesOf(token, SCREENSHOT);
  check('layout: sockets 0-1 are bars under the token', keys(r.bars) === 'hp,stress');
  check('layout: sockets 2-3 are the wheels on its right (purple, grey in the screenshot)', keys(r.right) === 'hp-markers,barriers');
  check('layout: sockets 4-5 are the wheels on its left (red, cyan in the screenshot)', keys(r.left) === 'gauge,fate-points');
  check('layout: values come through as the screenshot shows them (19/19, 0/5, 2, 4, 4, 3)', r.bars[0]?.current === 19 && r.bars[0]?.max === 19 && r.bars[1]?.current === 0 && r.bars[1]?.max === 5 && r.right[0]?.current === 2 && r.right[1]?.current === 4 && r.left[0]?.current === 4 && r.left[1]?.current === 3);

  const partial = resourcesOf({ ...token, resources: { hp: { current: 5, max: 10 } } }, SCREENSHOT);
  check('layout: a resource the token has no value for is not shown', keys(partial.bars) === 'hp' && partial.right.length === 0 && partial.left.length === 0);
  check('layout: a token with no resources shows nothing', resourcesOf({ ...token, resources: undefined }, SCREENSHOT).bars.length === 0);
  const fixed = resourcesOf({ ...token, resources: { ac: { current: 3, max: 15 } } }, [def('ac', 0, 'static')]);
  check('layout: a static value shows its maximum and cannot be stepped', fixed.bars[0]?.current === 15 && fixed.bars[0]?.fixed === true);
  const junk = resourcesOf({ ...token, resources: { hp: { current: 'x', max: 5 } as never } }, SCREENSHOT);
  check('layout: malformed values are skipped, not thrown on', junk.bars.length === 0);
}

// ---- stepping ------------------------------------------------------------------------------------------
{
  check('step: adds and takes away', stepValue(5, 10, 1) === 6 && stepValue(5, 10, -1) === 4);
  check('step: never below 0 or above the maximum', stepValue(0, 5, -1) === 0 && stepValue(5, 5, 1) === 5 && stepValue(3, 5, 99) === 5);
  check('step: a maximum of 0 stays at 0', stepValue(0, 0, 1) === 0);
}

// ---- reading what Atlas hands over --------------------------------------------------------------------------
{
  const good = parseDefs([{ key: 'hp', name: 'HP', color: '#22c55e', direction: 'drains', slot: 0, extra: 1 }, { key: 'x', color: '#abcdef', direction: 'nope' }]);
  check('parse: keeps well-formed definitions, defaulting what is odd', good?.length === 2 && good[0]?.slot === 0 && good[1]?.direction === 'drains' && good[1]?.name === 'x');
  check('parse: drops entries with no key or a bad colour', parseDefs([{ key: '', color: '#ffffff' }, { key: 'a', color: 'red' }, null, 5]) === null);
  check('parse: anything but a list is null', parseDefs(null) === null && parseDefs({}) === null && parseDefs('x') === null && parseDefs([]) === null);
}

// ---- making definitions up -------------------------------------------------------------------------------------
{
  const tokens: AtlasToken[] = [{ ...token, resources: { barriers: { current: 1, max: 2 }, stress: { current: 0, max: 5 }, hp: { current: 4, max: 4 }, gauge: { current: 1, max: 1 } } }];
  const inferred = inferDefs(tokens);
  const r = resourcesOf(tokens[0] as AtlasToken, inferred);
  check('infer: hp and stress take the bars, in that order', keys(r.bars) === 'hp,stress');
  check('infer: other resources become wheels', r.right.length + r.left.length === 2 && keys([...r.right, ...r.left]) === 'barriers,gauge');
  check('infer: hp is green and drains, stress is blue and fills', inferred[0]?.color === '#22c55e' && inferred[0]?.direction === 'drains' && inferred[1]?.direction === 'fills');
  check('infer: no tokens, no definitions', inferDefs([]).length === 0);
}

console.log(failures === 0 ? '\nAll resource checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
