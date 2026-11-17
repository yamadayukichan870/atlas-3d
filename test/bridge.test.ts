import { AtlasBinding, sceneStoreOf, snapshotOf } from '../src/atlas/bridge';
import { field } from '../src/atlas/internals';
import { creatureForToken, type FsApi, type FsCreature } from '../src/atlas/statblocks';
import { snapCenter } from '../src/view/interaction';
import type { AtlasSceneState, AtlasToken } from '../src/atlas/types';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`);
  if (!ok) failures++;
};

const tok = (id: string, extra: Partial<AtlasToken> = {}): AtlasToken => ({ id, kind: 'character', x: 0, y: 0, imagePath: 'a.png', ...extra });
const state = (over: Partial<AtlasSceneState> = {}): AtlasSceneState => ({
  mapPath: 'atlas-vtt/collections/c/scenes/Tavern.atlasmap', mapLoaded: true, isMapLoading: false, background: 'maps/tavern.png',
  grid: { enabled: true, size: 70, offsetX: 0, offsetY: 0 }, objects: { tokens: {} }, ...over,
});

/** A store shaped like Atlas's: zustand's `create` result, a FUNCTION with the store methods on it. */
function fakeAtlasStore(initial: AtlasSceneState & { setTokenPositions?: (p: unknown[]) => void }) {
  let current = initial;
  const listeners = new Set<(s: AtlasSceneState) => void>();
  const store = Object.assign(() => current, {
    getState: () => current,
    subscribe: (l: (s: AtlasSceneState) => void) => { listeners.add(l); return () => listeners.delete(l); },
    set: (next: AtlasSceneState) => { current = next; listeners.forEach((l) => l(current)); },
    listenerCount: () => listeners.size,
  });
  return store;
}
const leafOf = (view: unknown) => ({ view }) as never;

// ---- finding the store -------------------------------------------------------------------------
{
  const store = fakeAtlasStore(state());
  check('sceneStoreOf: finds a store that is a function with methods', sceneStoreOf(leafOf({ getViewType: () => 'atlas-vtt', atlasStore: store })) !== null);
  check('sceneStoreOf: deferred leaf (right type, no atlasStore) reads as null', sceneStoreOf(leafOf({ getViewType: () => 'atlas-vtt' })) === null);
  check('sceneStoreOf: another view type reads as null', sceneStoreOf(leafOf({ getViewType: () => 'markdown', atlasStore: store })) === null);
  check('sceneStoreOf: junk atlasStore reads as null', sceneStoreOf(leafOf({ getViewType: () => 'atlas-vtt', atlasStore: { getState: 1 } })) === null);
  check('field: safe on null/undefined/primitives', field(null, 'a') === undefined && field(undefined, 'a') === undefined && field(3, 'a') === undefined);
}

// ---- snapshot: levels --------------------------------------------------------------------------
{
  const tokens = { a: tok('a'), b: tok('b', { level: 'up' }), c: tok('c', { level: 'ground' }), d: tok('d', { offMap: true }) };
  const levels = [{ id: 'ground', background: 'maps/ground.png' }, { id: 'up', background: 'maps/up.png' }];

  const noLevels = snapshotOf(state({ objects: { tokens } }));
  check('no levels: every on-map token, offMap excluded', noLevels.tokens.map((t) => t.id).sort().join() === 'a,b,c', noLevels.tokens.map((t) => t.id).join());
  check('no levels: levelId null', noLevels.levelId === null);

  const base = snapshotOf(state({ objects: { tokens }, levels, viewedLevel: 'ground' }));
  check('base level: unlevelled tokens + the ones tagged for it', base.tokens.map((t) => t.id).sort().join() === 'a,c', base.tokens.map((t) => t.id).join());
  check('base level: uses the scene background, levelId null', base.background === 'maps/tavern.png' && base.levelId === null);

  const upper = snapshotOf(state({ objects: { tokens }, levels, viewedLevel: 'up' }));
  check('upper level: only its tokens', upper.tokens.map((t) => t.id).join() === 'b', upper.tokens.map((t) => t.id).join());
  check('upper level: its own background and levelId', upper.background === 'maps/up.png' && upper.levelId === 'up');

  const dflt = snapshotOf(state({ objects: { tokens }, levels, viewedLevel: null }));
  check('viewedLevel null falls back to the first level', dflt.tokens.map((t) => t.id).sort().join() === 'a,c');

  const hostile = snapshotOf({ ...state(), objects: undefined as never, levels: 'x' as never });
  check('hostile state does not throw and yields no tokens', hostile.tokens.length === 0);
  check('ready is false mid-load', snapshotOf(state({ isMapLoading: true })).ready === false);
}

// ---- binding -------------------------------------------------------------------------------------
{
  const tokens = { a: tok('a') };
  const first = state({ objects: { tokens } });
  const store = fakeAtlasStore(first);
  const seen: number[] = [];
  const binding = new AtlasBinding((s) => seen.push(s.tokens.length));
  check('binding: attach reads the current state once', binding.attach(leafOf({ getViewType: () => 'atlas-vtt', atlasStore: store })) && seen.length === 1);

  store.set({ ...first, isDragging: true } as AtlasSceneState);
  check('binding: ignores changes to parts it does not watch', seen.length === 1, String(seen.length));

  store.set({ ...first, objects: { tokens: { a: tokens.a, b: tok('b') } } });
  check('binding: reports when the token record changes', seen.length === 2 && seen[1] === 2);

  const moved: unknown[] = [];
  store.set({ ...store.getState(), setTokenPositions(this: unknown, p: unknown[]) { moved.push(this === store.getState(), p); } } as never);
  check('binding: moveTokens calls the action as a method of the state', binding.moveTokens([{ id: 'a', x: 1, y: 2 }]) && moved[0] === true);

  const bare = new AtlasBinding(() => undefined);
  bare.attach(leafOf({ getViewType: () => 'atlas-vtt', atlasStore: fakeAtlasStore(state()) }));
  check('binding: moveTokens is false (and writes nothing) when Atlas has no such action', bare.moveTokens([{ id: 'a', x: 1, y: 2 }]) === false);

  binding.detach();
  const before = seen.length;
  store.set({ ...store.getState(), objects: { tokens: {} } } as never);
  check('binding: detach stops reporting and unsubscribes', seen.length === before && store.listenerCount() === 0);
  check('binding: attach to a non-Atlas leaf fails without side effects', new AtlasBinding(() => undefined).attach(leafOf({ getViewType: () => 'markdown' })) === false);
}

// ---- Fantasy Statblocks ---------------------------------------------------------------------------
{
  const goblin: FsCreature = { name: 'Goblin', path: 'Bestiary/Goblin.md' };
  const orc: FsCreature = { name: 'Orc' };
  const api = (over: Partial<FsApi> = {}): FsApi => ({
    render: () => ({}) as never, getBestiaryCreatures: () => [goblin, orc],
    hasCreature: (n) => [goblin, orc].some((c) => c.name === n), getCreatureFromBestiary: (n) => [goblin, orc].find((c) => c.name === n) ?? null,
    isResolved: () => true, ...over,
  });
  check('creature: found by note path', creatureForToken(api(), tok('t', { statblockPath: 'Bestiary/Goblin.md' })) === goblin);
  check('creature: falls back to the statblock name', creatureForToken(api(), tok('t', { statblockPath: 'Elsewhere/x.md', statblockName: 'Orc' })) === orc);
  check('creature: falls back to the note basename', creatureForToken(api(), tok('t', { notePath: 'Notes/Orc.md' })) === orc);
  check('creature: not read before the bestiary is resolved', creatureForToken(api({ isResolved: () => false }), tok('t', { statblockName: 'Orc' })) === null);
  check('creature: an older API without isResolved is read as resolved', creatureForToken(api({ isResolved: undefined }), tok('t', { name: 'Orc' })) === orc);
  check('creature: a throwing lookup yields null, not an exception', creatureForToken(api({ getCreatureFromBestiary: () => { throw new Error('not parsed'); } }), tok('t', { name: 'Orc' })) === null);
  check('creature: unknown token yields null', creatureForToken(api(), tok('t', { name: 'Dragon' })) === null);
}

// ---- snapping (mirrors Atlas's tokenCenterShift for square grids) ----------------------------------
{
  const grid = { size: 70, offsetX: 10, offsetY: 20 };
  // Cells start at (10,20) and are 70 px: cell (0,0) spans x 10..80, centre 45.
  const odd = snapCenter(60 / 70, 60 / 70, 1, grid); // pixel (60,60): well inside cell (0,0)
  check('snap: odd footprint centres on a cell', odd.x === 45 && odd.y === 55, JSON.stringify(odd));
  const second = snapCenter(100 / 70, 100 / 70, 1, grid); // pixel (100,100): inside cell (1,1), whose centre is (115,125)
  check('snap: next cell over', second.x === 115 && second.y === 125, JSON.stringify(second));
  const even = snapCenter(1.5, 1.5, 2, grid); // between corners; rounds to the nearest
  check('snap: even footprint lands on a grid corner, not a cell centre', (even.x - 10) % 70 === 0 && (even.y - 20) % 70 === 0 && even.x === 80 && even.y === 90, JSON.stringify(even));
  const negative = snapCenter(-0.2, -0.2, 1, { size: 70, offsetX: 0, offsetY: 0 });
  check('snap: left of the origin snaps to cell -1, not 0', negative.x === -35, String(negative.x));
}


// ---- the actions that write to Atlas ----------------------------------------------------------------------------
{
  const calls: unknown[][] = [];
  const base = state({ objects: { tokens: { a: tok('a', { resources: { hp: { current: 5, max: 10 } } }) } } });
  const rich = Object.assign({}, base, {
    updateToken: (...a: unknown[]) => calls.push(['update', ...a]),
    setSelection: (...a: unknown[]) => calls.push(['select', ...a]),
    clearSelection: (...a: unknown[]) => calls.push(['clear', ...a]),
  });
  const store = fakeAtlasStore(rich as never);
  const defs = [{ key: 'hp', name: 'HP', color: '#22c55e', direction: 'drains', slot: 0 }];
  const shown: unknown[][] = [];
  const view = {
    getViewType: () => 'atlas-vtt', atlasStore: store,
    renderer: { getTokenRenderer: () => ({ resourceDefsProvider: () => defs, interactionController: { showContextMenu(this: unknown, ...a: unknown[]) { shown.push([this !== undefined, ...a]); } } }) },
  };
  const b = new AtlasBinding(() => undefined);
  b.attach(leafOf(view));

  check('select: sets and clears Atlas\'s own selection', b.select(['a']) && b.select([]) && calls[0]?.[0] === 'select' && JSON.stringify(calls[0]?.[1]) === '["a"]' && calls[1]?.[0] === 'clear');
  check('resource: a step goes through Atlas\'s updateToken with the new value', b.stepResource('a', 'hp', 1) && calls[2]?.[0] === 'update' && calls[2]?.[1] === 'a'
    && JSON.stringify(calls[2]?.[2]) === '{"resources":{"hp":{"current":6,"max":10}}}', JSON.stringify(calls[2]));
  const n = calls.length;
  check('resource: a step past the limit writes nothing', b.stepResource('a', 'hp', -99) === true && calls.length === n + 1 && JSON.stringify(calls[n]?.[2]).includes('"current":0'));
  const before = calls.length;
  check('resource: an unknown token or resource is refused, writing nothing', !b.stepResource('zzz', 'hp', 1) && !b.stepResource('a', 'nope', 1) && calls.length === before);
  check('menu: Atlas\'s own token menu is opened at the screen position', b.openContextMenu('a', 120, 340) && shown.length === 1 && shown[0]?.[0] === true && (shown[0]?.[2] as { clientX: number }).clientX === 120 && (shown[0]?.[2] as { clientY: number }).clientY === 340);
  check('menu: the token Atlas receives is its own record', (shown[0]?.[1] as { id: string }).id === 'a');
  check('menu: an unknown token opens nothing', !b.openContextMenu('zzz', 1, 1) && shown.length === 1);
  check('defs: read from Atlas\'s token renderer', b.resourceDefs()?.[0]?.key === 'hp');

  // The same Atlas with the private parts missing, as a future version might be.
  const bare = new AtlasBinding(() => undefined);
  bare.attach(leafOf({ getViewType: () => 'atlas-vtt', atlasStore: fakeAtlasStore(base) }));
  check('missing parts: nothing throws, every answer is "not available"', bare.resourceDefs() === null && !bare.openContextMenu('a', 1, 1) && !bare.select(['a']) && !bare.stepResource('a', 'hp', 1));

  const throwing = new AtlasBinding(() => undefined);
  throwing.attach(leafOf({ getViewType: () => 'atlas-vtt', atlasStore: fakeAtlasStore(rich as never), get renderer(): never { throw new Error('boom'); } }));
  check('a view whose renderer getter throws is survived', throwing.resourceDefs() === null && !throwing.openContextMenu('a', 1, 1));

  const crashing = new AtlasBinding(() => undefined);
  crashing.attach(leafOf({ getViewType: () => 'atlas-vtt', atlasStore: store, renderer: { getTokenRenderer: () => ({ interactionController: { showContextMenu() { throw new Error('menu broke'); } } }) } }));
  const log = console.error; console.error = () => undefined;
  const crashed = crashing.openContextMenu('a', 1, 1);
  console.error = log;
  check('a menu that throws reports false instead of claiming success', crashed === false);
}


// ---- Atlas's statblock window -----------------------------------------------------------------------------------
{
  const events: Array<[string, Record<string, unknown>]> = [];
  const bus = { emit: (event: string, payload: Record<string, unknown>) => { events.push([event, payload]); } };
  const character = tok('c', { kind: 'character', statblockPath: 'Bestiary/Bulbasaur.md', name: 'Bulbasaur', x: 10, y: 20, resources: { hp: { current: 19, max: 19 } } });
  const plain = tok('p', { kind: 'token', statblockPath: 'Bestiary/Thing.md' });
  const noNote = tok('n', { kind: 'character' });
  const store = fakeAtlasStore(state({ objects: { tokens: { c: character, p: plain, n: noNote } } }));
  const source = leafOf({ id: 'atlas-tab' });
  const b = new AtlasBinding(() => undefined);
  b.attach(leafOf({ getViewType: () => 'atlas-vtt', atlasStore: store, serviceManager: { eventBus: bus } }));

  check('statblock: hovering a character with a note tells Atlas, at the pointer', b.showStatblock('c', 300, 400, source) && events.length === 1 && events[0]?.[0] === 'pin-hover-preview'
    && events[0]?.[1].screenX === 300 && events[0]?.[1].screenY === 400 && events[0]?.[1].sourceLeaf === source);
  const pin = events[0]?.[1].pin as { id: string; notePath: string; resources: unknown };
  check('statblock: the pin is built from the token as Atlas\'s store has it (note, and the very same vitals)', pin.id === 'c' && pin.notePath === 'Bestiary/Bulbasaur.md' && pin.resources === character.resources);

  b.hideStatblock();
  check('statblock: leaving tells Atlas, with the same pin', events.length === 2 && events[1]?.[0] === 'pin-hide-preview' && events[1]?.[1].pin === pin);
  b.hideStatblock();
  check('statblock: leaving twice tells Atlas once', events.length === 2);

  const before = events.length;
  check('statblock: a plain token, a character with no note and an unknown token tell Atlas nothing', !b.showStatblock('p', 1, 1, source) && !b.showStatblock('n', 1, 1, source) && !b.showStatblock('zzz', 1, 1, source) && events.length === before);

  b.showStatblock('c', 5, 5, source);
  b.detach();
  check('statblock: letting go of the tab closes a window we asked for', events[events.length - 1]?.[0] === 'pin-hide-preview');
  const after = events.length;
  b.detach();
  check('statblock: and only once', events.length === after);

  const bare = new AtlasBinding(() => undefined);
  bare.attach(leafOf({ getViewType: () => 'atlas-vtt', atlasStore: store }));
  check('statblock: with no event bus nothing is claimed and nothing breaks', !bare.showStatblock('c', 1, 1, source) && (bare.hideStatblock(), true));
  const log = console.error; console.error = () => undefined;
  const loud = new AtlasBinding(() => undefined);
  loud.attach(leafOf({ getViewType: () => 'atlas-vtt', atlasStore: store, serviceManager: { eventBus: { emit() { throw new Error('boom'); } } } }));
  const claimed = loud.showStatblock('c', 1, 1, source);
  console.error = log;
  check('statblock: a failed emit is not remembered as shown (so no hide is sent for a window that never opened)', !claimed && (loud.hideStatblock(), true));
}

console.log(failures === 0 ? '\nAll bridge checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
