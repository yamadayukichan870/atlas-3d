import { call, field, formatReport, hideStatblockPreview, inspect, previewPinFor, showStatblockPreview, showTokenMenu, viewContainer, type PinnableToken } from '../src/atlas/internals';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`);
  if (!ok) failures++;
};
const quiet = <T,>(fn: () => T): T => { const log = console.error; console.error = () => undefined; try { return fn(); } finally { console.error = log; } };
const leafOf = (view: unknown) => ({ view }) as never;

// ---- safe probing ------------------------------------------------------------------------------------
{
  check('field: nothing on null, undefined and primitives', field(null, 'a') === undefined && field(undefined, 'a') === undefined && field(3, 'a') === undefined && field('x', 'a') === undefined);
  check('field: reads objects and functions', field({ a: 1 }, 'a') === 1 && field(Object.assign(() => 0, { a: 2 }), 'a') === 2);
  check('field: a getter that throws reads as missing, not as an exception', field({ get boom(): never { throw new Error('x'); } }, 'boom') === undefined);
  const obj = { n: 5, add(this: { n: number }, k: number) { return this.n + k; }, boom() { throw new Error('x'); } };
  check('call: runs a method with its own object as `this`', call(obj, 'add', 2) === 7);
  check('call: a missing method or one that throws gives undefined', call(obj, 'nope') === undefined && call(obj, 'boom') === undefined && call(null, 'add') === undefined);
}

// ---- the view's container -----------------------------------------------------------------------------------
{
  const el = { nodeType: 1, createDiv() {} };
  check('container: found as the view\'s containerEl', viewContainer(leafOf({ containerEl: el })) === (el as unknown));
  check('container: an element from another window (a popout) is accepted, as it is not `instanceof` ours', viewContainer(leafOf({ containerEl: { nodeType: 1 } })) !== null);
  check('container: anything that is not an element, or no leaf, is null', viewContainer(leafOf({ containerEl: { nodeType: 3 } })) === null && viewContainer(leafOf({})) === null && viewContainer(null) === null && viewContainer(leafOf({ containerEl: 'x' })) === null);
}

// ---- the pin Atlas's own hover builds -----------------------------------------------------------------------
{
  const token: PinnableToken = {
    id: 't1', kind: 'character', x: 140, y: 210, statblockPath: 'Bestiary/Bulbasaur.md', name: 'Bulbasaur',
    resources: { hp: { current: 19, max: 19 } }, imagePath: 'tokens/b.png', ringColor: '#ff0000', showRing: true,
  };
  const pin = previewPinFor(token);
  check('pin: a character with a statblock note gets one', pin !== null);
  check('pin: it carries what Atlas\'s hover carries (note, place, name, vitals, art, ring)', JSON.stringify(pin) === JSON.stringify({
    id: 't1', notePath: 'Bestiary/Bulbasaur.md', x: 140, y: 210, type: 'token', name: 'Bulbasaur',
    resources: { hp: { current: 19, max: 19 } }, imagePath: 'tokens/b.png', ringColor: '#ff0000', showRing: true,
  }), JSON.stringify(pin));
  check('pin: the vitals are the token\'s own object, so the window mirrors them', pin?.resources === token.resources);
  check('pin: a plain token (not a character) has none, as in Atlas', previewPinFor({ ...token, kind: 'token' }) === null);
  check('pin: no statblock note, an empty one or a blank one: none', previewPinFor({ ...token, statblockPath: undefined }) === null && previewPinFor({ ...token, statblockPath: '' }) === null && previewPinFor({ ...token, statblockPath: '   ' }) === null);
}

// ---- telling Atlas about the pointer -------------------------------------------------------------------------------
{
  const events: Array<[string, Record<string, unknown>]> = [];
  const bus = { emit: (event: string, payload: Record<string, unknown>) => { events.push([event, payload]); return true; } };
  const leaf = leafOf({ serviceManager: { eventBus: bus } });
  const source = leafOf({}) as never;
  const pin = previewPinFor({ id: 't1', kind: 'character', x: 1, y: 2, statblockPath: 'a.md' })!;

  check('show: emits Atlas\'s own hover event', showStatblockPreview(leaf, pin, 300, 400, source) && events[0]?.[0] === 'pin-hover-preview');
  const payload = events[0]![1];
  check('show: with the pin, the screen position and the leaf to open in', payload.pin === pin && payload.screenX === 300 && payload.screenY === 400 && payload.sourceLeaf === source);
  check('show: no pixiEvent, so Atlas reads Ctrl from the keyboard (it is optional there)', !('pixiEvent' in payload));
  check('hide: emits Atlas\'s hide event with the same pin', hideStatblockPreview(leaf, pin) && events[1]?.[0] === 'pin-hide-preview' && events[1]?.[1].pin === pin);

  check('no bus: false, and nothing thrown', !showStatblockPreview(leafOf({ serviceManager: {} }), pin, 1, 1, null) && !hideStatblockPreview(leafOf({}), pin) && !showStatblockPreview(null, pin, 1, 1, null));
  check('a bus without emit is not a bus', !showStatblockPreview(leafOf({ serviceManager: { eventBus: {} } }), pin, 1, 1, null));
  const throwing = leafOf({ serviceManager: { eventBus: { emit() { throw new Error('listener broke'); } } } });
  check('a listener that throws is survived and reported as failure', quiet(() => !showStatblockPreview(throwing, pin, 1, 1, null) && !hideStatblockPreview(throwing, pin)));
  check('a serviceManager getter that throws is survived', !showStatblockPreview(leafOf({ get serviceManager(): never { throw new Error('x'); } }), pin, 1, 1, null));
}

// ---- the token menu ----------------------------------------------------------------------------------------------------
{
  const shown: unknown[][] = [];
  const view = { renderer: { getTokenRenderer: () => ({ interactionController: { showContextMenu(this: unknown, ...a: unknown[]) { shown.push([this !== undefined, ...a]); } } }) } };
  check('menu: opened with the token and only the screen position', showTokenMenu(leafOf(view), { id: 'a' }, 10, 20) && JSON.stringify(shown[0]?.slice(1)) === '[{"id":"a"},{"clientX":10,"clientY":20}]');
  check('menu: the controller is its own `this`', shown[0]?.[0] === true);
  check('menu: not reachable gives false', !showTokenMenu(leafOf({}), {}, 1, 1) && !showTokenMenu(null, {}, 1, 1));
  const broken = { renderer: { getTokenRenderer: () => ({ interactionController: { showContextMenu() { throw new Error('menu'); } } }) } };
  check('menu: one that throws gives false', quiet(() => !showTokenMenu(leafOf(broken), {}, 1, 1)));
}

// ---- the diagnostic ------------------------------------------------------------------------------------------------------
{
  // A fake Atlas with EVERY hook the current inspect() probes, so "all present" can be true. The
  // old fake was from the eight-hook era; inspect() now reports twenty-one. Several probes share a
  // path (the token renderer carries the menu, the editor AND the condition defs; the container
  // carries the chrome check), so a removal loses exactly the capabilities that read that path.
  const collection = {
    gridDefaults: { unitDistance: 5, diagonalRule: 'equidistant' },
    movement: { steps: [], countPerTurn: false },
    conditions: [{ id: 'prone', name: 'Prone' }],
  };
  const assetService = { getCollectionForMap: () => 'col', getCollectionSettings: () => collection };
  const state = {
    currentCollectionId: 'col',
    objects: { measures: {} },
    setTokenPositions() {}, updateToken() {}, setSelection() {}, clearSelection() {},
    addMeasure() {}, updateMeasure() {}, deleteMeasure() {}, clearMeasures() {},
    setMeasureTool() {}, setTokenAuras() {}, openMeasurePopover() {}, closeMeasurePopover() {},
  };
  const store = Object.assign(() => state, { getState: () => state, subscribe: () => () => undefined });
  const full = {
    atlasStore: store,
    containerEl: { nodeType: 1, querySelector: () => ({}) },
    serviceManager: { eventBus: { emit() {} }, getAssetService: () => assetService },
    renderer: { getTokenRenderer: () => ({
      resourceDefsProvider: () => [{ key: 'hp' }],
      interactionController: { showContextMenu() {}, showEditTokenModal() {}, getConditionDefs: () => [{ id: 'prone', name: 'Prone' }] },
    }) },
  };
  const ok = (view: unknown): Record<string, boolean> => Object.fromEntries(inspect(leafOf(view)).map((c) => [c.id, c.ok]));

  const all = inspect(leafOf(full));
  check('diagnostic: every hook is reported present when Atlas has them all', all.length === 21 && all.every((c) => c.ok), JSON.stringify(ok(full)));
  check('diagnostic: each entry says what it gives and what happens without it', all.every((c) => c.feature.length > 5 && c.without.length > 5));
  check('diagnostic: ids are unique', new Set(all.map((c) => c.id)).size === all.length);

  /** Every capability except the ones named is present. */
  const onlyMissing = (r: Record<string, boolean>, ...missing: string[]): boolean =>
    Object.entries(r).every(([id, present]) => (missing.includes(id) ? !present : present));
  // Only the event bus goes; the asset service stays, so the collection rules still read.
  check('diagnostic: no event bus loses only the statblock window', onlyMissing(ok({ ...full, serviceManager: { getAssetService: () => assetService } }), 'statblock'));
  // The renderer carries the menu, the editor and the condition defs; the conditions fall back to
  // the collection, so they survive — the menu, the colours and the editor do not.
  check('diagnostic: no token renderer loses the menu, the colours and the editor', onlyMissing(ok({ ...full, renderer: {} }), 'menu', 'defs', 'editModal'));
  check('diagnostic: a store without updateToken loses only the + and - buttons', (() => {
    const noUpdate = Object.assign(() => 0, { getState: () => ({ ...state, updateToken: undefined }), subscribe: () => () => undefined });
    return onlyMissing(ok({ ...full, atlasStore: noUpdate }), 'resources');
  })());
  check('diagnostic: a store without setSelection loses only selection in Atlas', (() => {
    const noSelect = Object.assign(() => 0, { getState: () => ({ ...state, setSelection: undefined }), subscribe: () => () => undefined });
    return onlyMissing(ok({ ...full, atlasStore: noSelect }), 'selection');
  })());
  // The chrome check reads the container too, so losing it takes both.
  check('diagnostic: no container loses the embedded mode and the chrome check', onlyMissing(ok({ ...full, containerEl: null }), 'container', 'chrome'));
  check('diagnostic: no resource definitions (an empty list) is reported, as they are then inferred', !ok({ ...full, renderer: { getTokenRenderer: () => ({ resourceDefsProvider: () => [], interactionController: { showContextMenu() {} } }) } }).defs);
  check('diagnostic: no Atlas tab at all reports everything missing without throwing', inspect(null).every((c) => !c.ok) && inspect(leafOf({})).every((c) => !c.ok));
}

// ---- the report ------------------------------------------------------------------------------------------------------------
{
  const caps = [
    { id: 'a', feature: 'Following the scene', ok: true, without: 'nothing shows' },
    { id: 'b', feature: 'Atlas\'s right-click token menu', ok: false, without: 'a right click opens nothing' },
  ];
  const text = formatReport('0.12.1', caps);
  const lines = text.split('\n');
  check('report: starts with the Atlas version', lines[0] === 'Atlas VTT 0.12.1');
  check('report: present hooks are marked ok, missing ones say what is lost', lines.includes('[ok] Following the scene') && lines.includes('[MISSING] Atlas\'s right-click token menu - without it: a right click opens nothing'));
  check('report: ends with the count', lines[lines.length - 1] === '1 of 2 hooks available');
  check('report: an unknown version is said so, and an empty list still reads', formatReport(null, []).startsWith('Atlas VTT (version unknown)') && formatReport(null, []).endsWith('0 of 0 hooks available'));
}

console.log(failures === 0 ? '\nAll Atlas-internals checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);