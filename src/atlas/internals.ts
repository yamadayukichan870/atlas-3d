import type { WorkspaceLeaf } from 'obsidian';

/**
 * Every way this plugin reaches into Atlas VTT beyond what Atlas publishes, and nowhere else.
 * Besides `atlasStore`, everything here probes private/internal members of Atlas (`serviceManager`,
 * `renderer.getTokenRenderer()`, etc.). Each probe degrades gracefully to "not available" instead of
 * throwing, and is reported by `inspect` in the Diagnostics modal.
 */

/** A field of an object by name, unchecked; undefined for anything that has none or whose getter throws. */
export function field(target: unknown, name: string): unknown {
  try {
    return (typeof target === 'object' || typeof target === 'function') && target !== null && name in target
      ? (target as Record<string, unknown>)[name]
      : undefined;
  } catch {
    return undefined;
  }
}

/** Calls a method of an unknown object, or returns undefined when it is missing or throws. */
export function call(target: unknown, name: string, ...args: unknown[]): unknown {
  const fn = field(target, name);
  if (typeof fn !== 'function') return undefined;
  try {
    return (fn as (...a: unknown[]) => unknown).apply(target, args);
  } catch {
    return undefined;
  }
}

/** A plain record, or null for anything that is not one. Arrays are not records here. */
function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const viewOf = (leaf: WorkspaceLeaf | null): unknown => (leaf === null ? undefined : field(leaf, 'view'));

/** The element Atlas builds its view in (its canvas, then its interface above it), or null. */
export function viewContainer(leaf: WorkspaceLeaf | null): HTMLElement | null {
  const el = field(viewOf(leaf), 'containerEl');
  // Not `instanceof HTMLElement`: that is false for an element of another window (a popout).
  return typeof el === 'object' && el !== null && field(el, 'nodeType') === 1 ? (el as HTMLElement) : null;
}

/** Atlas's token renderer: `view.renderer.getTokenRenderer()`. */
function tokenRendererOf(leaf: WorkspaceLeaf | null): unknown {
  return call(field(viewOf(leaf), 'renderer'), 'getTokenRenderer') ?? null;
}

/**
 * Atlas's asset service for this view. `ServiceManager.getAssetService()` is the public accessor;
 * the private `assetService` field is the fallback (TypeScript `private` is compile-time only, so it
 * is readable at runtime). Null when the asset manager feature is off or the service is unreachable.
 */
function assetServiceOf(leaf: WorkspaceLeaf | null): unknown {
  const manager = field(viewOf(leaf), 'serviceManager');
  return call(manager, 'getAssetService') ?? field(manager, 'assetService') ?? null;
}

/** The store of the view, by its public getter or the `atlasStore` field. */
function storeOf(leaf: WorkspaceLeaf | null): unknown {
  const view = viewOf(leaf);
  const direct = field(view, 'atlasStore');
  if (direct !== undefined) return direct;
  return call(view, 'getStore') ?? null;
}

/**
 * The collection a map belongs to, resolved the way Atlas resolves its rules: from the map's path
 * (`AssetService.getCollectionForMap`), NOT from `state.currentCollectionId`. That field is a UI
 * convenience initialised to 'default' and never persisted; Atlas's own `rulesForMap` ignores it.
 * Null when the map lies outside every collection, or the service cannot be reached.
 */
export function mapCollectionIdOf(leaf: WorkspaceLeaf | null): string | null {
  const service = assetServiceOf(leaf);
  const state = call(storeOf(leaf), 'getState');
  if (!service || !state) return null;
  const mapPath = field(state, 'mapPath');
  if (typeof mapPath !== 'string' || mapPath === '') return null;
  const id = call(service, 'getCollectionForMap', mapPath);
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * The scene's collection settings object, read from the collection Atlas measures the map by.
 *
 * Null when the map belongs to no collection: Atlas measures such a map by its own grid state,
 * not by a collection called "Default". Resolving by `mapPath` (as `rulesForMap` does) is what
 * fixes reading the stale `currentCollectionId` ('default') instead of the map's real collection.
 *
 * Note: a campaign's played system wins over the collection in Atlas (`rulesForMap`); that override
 * is not probed here yet. A returned object may legitimately hold no `gridDefaults`/`movement`
 * (the collection then takes its game-system preset's or the built-in defaults).
 */
export function readCollectionSettings(leaf: WorkspaceLeaf | null): unknown {
  const service = assetServiceOf(leaf);
  if (!service) return null;
  const id = mapCollectionIdOf(leaf);
  if (id === null) return null;
  return call(service, 'getCollectionSettings', id) ?? null;
}

/** The resource definitions of the scene's collection, exactly as Atlas hands them over (unvalidated). */
export function readResourceDefs(leaf: WorkspaceLeaf | null): unknown {
  return call(tokenRendererOf(leaf), 'resourceDefsProvider');
}

/**
 * The condition definitions of the scene's collection, probed across known Atlas layouts (0.12 - 0.16+).
 * Returns raw items or null when Atlas does not expose them.
 */
export function readConditionDefs(leaf: WorkspaceLeaf | null): unknown {
  const tokenRenderer = tokenRendererOf(leaf);
  const controller = field(tokenRenderer, 'interactionController');
  const fromController = call(controller, 'getConditionDefs');
  if (Array.isArray(fromController) && fromController.length > 0) return fromController;
  const fromSync = call(field(tokenRenderer, 'collectionSync'), 'conditions');
  if (Array.isArray(fromSync) && fromSync.length > 0) return fromSync;
  const settings = readCollectionSettings(leaf);
  const rawConditions = field(settings, 'conditions');
  if (Array.isArray(rawConditions) && rawConditions.length > 0) return rawConditions;
  return null;
}

/**
 * Opens Atlas's own right-click menu for a token at a screen position. It lives in the token interaction
 * controller, which only needs `clientX` and `clientY` from the event. False when it cannot be reached.
 */
export function showTokenMenu(leaf: WorkspaceLeaf | null, token: unknown, clientX: number, clientY: number): boolean {
  const controller = field(tokenRendererOf(leaf), 'interactionController');
  const show = field(controller, 'showContextMenu');
  if (typeof show !== 'function') return false;
  try {
    (show as (token: unknown, event: { clientX: number; clientY: number }) => void).call(controller, token, { clientX, clientY });
    return true;
  } catch (error) {
    console.error('[Atlas 3D] Atlas could not open its token menu', error);
    return false;
  }
}

/** Opens Atlas's native Edit Token modal for a token when reachable. */
export function openTokenEditModal(leaf: WorkspaceLeaf | null, token: unknown): boolean {
  const controller = field(tokenRendererOf(leaf), 'interactionController');
  const show = field(controller, 'showEditTokenModal');
  if (typeof show !== 'function') return false;
  try {
    (show as (token: unknown) => void).call(controller, token);
    return true;
  } catch (error) {
    console.error('[Atlas 3D] Atlas could not open its token editor', error);
    return false;
  }
}

// ---- the statblock window ---------------------------------------------------------------------

/** What the view's event bus carries. */
interface Emitter { emit(event: string, ...args: unknown[]): unknown }

function busOf(leaf: WorkspaceLeaf | null): Emitter | null {
  const bus = field(field(viewOf(leaf), 'serviceManager'), 'eventBus');
  return typeof field(bus, 'emit') === 'function' ? (bus as Emitter) : null;
}

/** The fields of a token that Atlas's own hover builds its preview from. */
export interface PinnableToken {
  id: string;
  kind: string;
  x: number;
  y: number;
  statblockPath?: string;
  name?: string;
  resources?: Record<string, { current: number; max: number }>;
  imagePath?: string;
  ringColor?: string;
  showRing?: boolean;
}

/** What Atlas's preview windows call a hovered element. */
export interface PreviewPin {
  id: string;
  notePath: string;
  x: number;
  y: number;
  type: 'token';
  name?: string;
  resources?: Record<string, { current: number; max: number }>;
  imagePath?: string;
  ringColor?: string;
  showRing?: boolean;
}

/**
 * The hover pin of a token, built as Atlas builds it when the pointer is over a token on its own map: only a
 * character with a statblock note gets one, and the vitals travel with it so the window can mirror them.
 */
export function previewPinFor(token: PinnableToken): PreviewPin | null {
  if (token.kind !== 'character' || !token.statblockPath?.trim()) return null;
  return {
    id: token.id,
    notePath: token.statblockPath,
    x: token.x,
    y: token.y,
    type: 'token',
    name: token.name,
    resources: token.resources,
    imagePath: token.imagePath,
    ringColor: token.ringColor,
    showRing: token.showRing,
  };
}

/**
 * Tells Atlas the pointer is over a token, as its own map does. Atlas then does the rest: it opens its
 * statblock window while Ctrl/Cmd is held (also if it is pressed after pointing), with its pin button, dice
 * rolls and the vitals, and rolls for the right scene.
 */
export function showStatblockPreview(
  leaf: WorkspaceLeaf | null,
  pin: PreviewPin,
  clientX: number,
  clientY: number,
  sourceLeaf: WorkspaceLeaf | null,
): boolean {
  const bus = busOf(leaf);
  if (bus === null) return false;
  try {
    bus.emit('pin-hover-preview', { pin, screenX: clientX, screenY: clientY, sourceLeaf });
    return true;
  } catch (error) {
    console.error('[Atlas 3D] Atlas could not show its statblock window', error);
    return false;
  }
}

/** Tells Atlas the pointer left the token. Atlas keeps the window while Ctrl is still held, or while it is pinned. */
export function hideStatblockPreview(leaf: WorkspaceLeaf | null, pin: PreviewPin): boolean {
  const bus = busOf(leaf);
  if (bus === null) return false;
  try {
    bus.emit('pin-hide-preview', { pin });
    return true;
  } catch (error) {
    console.error('[Atlas 3D] Atlas could not hide its statblock window', error);
    return false;
  }
}

// ---- what is available ------------------------------------------------------------------------

export interface Capability {
  id: string;
  /** What works when this hook is there. */
  feature: string;
  ok: boolean;
  /** What happens instead when it is not. */
  without: string;
  /** Optional context (e.g. which collection was resolved), shown after the feature in the report. */
  detail?: string;
}

const isFn = (target: unknown, name: string): boolean => typeof field(target, name) === 'function';

/**
 * The parts of Atlas's own chrome the embedded 3D map measures to keep its toolbar clear of them.
 * They are class names, not an API: a release that renames them moves the toolbar over Atlas's
 * buttons in silence, so `inspect` reports whether they are still there.
 */
export const ATLAS_CHROME_SELECTORS: readonly string[] = [
  '.atlas-top-bar-start',
  '.atlas-top-bar-end',
  '.atlas-level-switcher',
];

/** Whether Atlas's view still holds the chrome the embedded toolbar makes room for. */
function chromePresent(leaf: WorkspaceLeaf | null): boolean {
  const container = viewContainer(leaf);
  if (container === null) return false;
  try {
    return ATLAS_CHROME_SELECTORS.some((selector) => container.querySelector(selector) !== null);
  } catch {
    return false;
  }
}

/**
 * Which of the hooks this plugin uses are present in this Atlas tab. For the diagnostic command: after an
 * Atlas update it says which feature stopped working, instead of it failing silently.
 */
export function inspect(leaf: WorkspaceLeaf | null): Capability[] {
  const view = viewOf(leaf);
  const store = field(view, 'atlasStore');
  const state = call(store, 'getState');
  const defs = readResourceDefs(leaf);
  const condDefs = readConditionDefs(leaf);
  const controller = field(tokenRendererOf(leaf), 'interactionController');
  const canMove = isFn(state, 'setTokenPositions') || isFn(state, 'dropTokens') || isFn(state, 'updateToken');

  const objects = recordOf(field(state, 'objects'));
  // A scene with nothing measured yet may hold no `measures` record at all; the action's presence
  // is what says this Atlas has the kept-measurement model.
  const hasMeasures = recordOf(field(objects, 'measures')) !== null || isFn(state, 'addMeasure');

  // The collection is resolved by mapPath, as Atlas's own rulesForMap does. `serviceOk` says the
  // probe itself works; `collectionId` says which collection (null = the map is outside them all).
  const service = assetServiceOf(leaf);
  const serviceOk = service !== null && isFn(service, 'getCollectionForMap') && isFn(service, 'getCollectionSettings');
  const collectionId = serviceOk ? mapCollectionIdOf(leaf) : null;
  const collection = recordOf(readCollectionSettings(leaf));
  const gridDefaults = recordOf(field(collection, 'gridDefaults'));
  const movement = recordOf(field(collection, 'movement'));

  const collectionDetail = !serviceOk
    ? 'asset service not reachable'
    : collectionId !== null
      ? `collection "${collectionId}"`
      : 'map belongs to no collection (measures by its grid)';

  return [
    {
      id: 'store',
      feature: 'Following the scene (tokens, grid, level)',
      ok: isFn(store, 'getState') && isFn(store, 'subscribe'),
      without: 'the 3D map cannot show the scene at all',
    },
    {
      id: 'container',
      feature: 'Showing the 3D map inside the Atlas view',
      ok: viewContainer(leaf) !== null,
      without: 'only the separate 3D pane works',
    },
    {
      id: 'move',
      feature: 'Moving tokens from 3D',
      ok: canMove,
      without: 'tokens cannot be dragged in 3D',
    },
    {
      id: 'resources',
      feature: 'Editing resources, facing and elevation',
      ok: isFn(state, 'updateToken'),
      without: 'token edits (+/-/facing/flight) do nothing',
    },
    {
      id: 'selection',
      feature: 'Selecting tokens in Atlas itself',
      ok: isFn(state, 'setSelection') && isFn(state, 'clearSelection'),
      without: 'selection stays inside the 3D map',
    },
    {
      id: 'defs',
      feature: 'The collection resource colours and places',
      ok: Array.isArray(defs) && defs.length > 0,
      without: 'they are inferred from the tokens own resources',
    },
    {
      id: 'conditions',
      feature: 'The collection condition icons and colours',
      ok: Array.isArray(condDefs) && condDefs.length > 0,
      without: 'fallback condition icons are used',
    },
    {
      id: 'menu',
      feature: 'Atlas right-click token menu',
      ok: isFn(controller, 'showContextMenu'),
      without: 'a right click on a token opens nothing',
    },
    {
      id: 'editModal',
      feature: 'Atlas token editor modal',
      ok: isFn(controller, 'showEditTokenModal'),
      without: 'clicking a resource wheel will not open the Atlas editor',
    },
    {
      id: 'statblock',
      feature: 'Atlas statblock window on Ctrl + hover',
      ok: busOf(leaf) !== null,
      without: 'hovering a token shows no statblock',
    },
    {
      id: 'measureRead',
      feature: 'Reading kept measurements and token auras',
      ok: hasMeasures,
      without: 'measurements pinned in Atlas and token auras never reach the 3D map',
    },
    {
      id: 'measureKeep',
      feature: 'Keeping a measurement from 3D, saved by Atlas',
      ok: isFn(state, 'addMeasure'),
      without: 'Keep only pins the measurement inside the 3D map; Atlas does not save it',
    },
    {
      id: 'measureEdit',
      feature: 'Moving or editing a kept measurement',
      ok: isFn(state, 'updateMeasure'),
      without: 'a kept measurement cannot be changed, only removed and drawn again',
    },
    {
      id: 'measureDelete',
      feature: 'Removing one measurement (the × on its pill)',
      ok: isFn(state, 'deleteMeasure'),
      without: 'the × cannot remove a measurement Atlas holds',
    },
    {
      id: 'measureClear',
      feature: 'Clearing every measurement of the level shown',
      ok: isFn(state, 'clearMeasures'),
      without: 'Clear only empties the 3D map, not the level',
    },
    {
      id: 'measureTool',
      feature: 'Following the Atlas Measure toolbar (mode, Keep, Look)',
      ok: isFn(state, 'setMeasureTool'),
      without: 'choosing a mode in 3D does not move the Atlas toolbar',
    },
    {
      id: 'auras',
      feature: 'Setting a token aura from 3D',
      ok: isFn(state, 'setTokenAuras'),
      without: 'auras can be read but not changed from the 3D map',
    },
    {
      id: 'collection',
      feature: 'Finding the collection a map belongs to (the source of its rules)',
      ok: serviceOk,
      without: 'the 3D map cannot read collection rules and measures by the map grid alone',
      detail: collectionDetail,
    },
    {
      id: 'collectionRules',
      feature: 'The collection measurement rules (diagonals, units, cone, bands)',
      ok: gridDefaults !== null,
      without: 'the collection stores no grid defaults; both views measure by the map grid and built-in defaults',
      ...(gridDefaults === null && serviceOk && collectionId !== null
        ? { detail: 'no stored gridDefaults; Atlas uses defaults / the game-system preset' }
        : {}),
    },
    {
      id: 'movementRules',
      feature: 'Movement steps and per-turn counting',
      ok: movement !== null,
      without: 'a move is not coloured by step, and movement is not counted per turn',
      ...(movement === null && serviceOk && collectionId !== null
        ? { detail: 'no stored movement; Atlas uses the game-system preset' }
        : {}),
    },
    {
      id: 'chrome',
      feature: 'Keeping the embedded toolbar clear of Atlas chrome',
      ok: chromePresent(leaf),
      without: 'inside an Atlas tab the 3D toolbar may sit over its buttons',
    },
  ];
}

/** The report as plain text, for the diagnostic window and to paste into a bug report. */
export function formatReport(atlasVersion: string | null, capabilities: readonly Capability[]): string {
  const lines = [`Atlas VTT ${atlasVersion ?? '(version unknown)'}`, ''];
  for (const c of capabilities) {
    const suffix = c.detail !== undefined ? `  (${c.detail})` : '';
    lines.push(c.ok ? `[ok] ${c.feature}${suffix}` : `[MISSING] ${c.feature} - without it: ${c.without}${suffix}`);
  }
  const present = capabilities.filter((c) => c.ok).length;
  lines.push('', `${present} of ${capabilities.length} hooks available`);
  return lines.join('\n');
}