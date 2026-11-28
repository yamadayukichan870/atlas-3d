import type { WorkspaceLeaf } from 'obsidian';

export function field(target: unknown, name: string): unknown {
  try {
    return (typeof target === 'object' || typeof target === 'function') && target !== null && name in target
      ? (target as Record<string, unknown>)[name]
      : undefined;
  } catch {
    return undefined;
  }
}

export function call(target: unknown, name: string, ...args: unknown[]): unknown {
  const fn = field(target, name);
  if (typeof fn !== 'function') return undefined;
  try {
    return (fn as (...a: unknown[]) => unknown).apply(target, args);
  } catch {
    return undefined;
  }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const viewOf = (leaf: WorkspaceLeaf | null): unknown => (leaf === null ? undefined : field(leaf, 'view'));

export function viewContainer(leaf: WorkspaceLeaf | null): HTMLElement | null {
  const el = field(viewOf(leaf), 'containerEl');
  return typeof el === 'object' && el !== null && field(el, 'nodeType') === 1 ? (el as HTMLElement) : null;
}

function tokenRendererOf(leaf: WorkspaceLeaf | null): unknown {
  return call(field(viewOf(leaf), 'renderer'), 'getTokenRenderer') ?? null;
}

export function readCollectionSettings(leaf: WorkspaceLeaf | null): unknown {
  const view = viewOf(leaf);
  const assetService = call(field(view, 'serviceManager'), 'getAssetService');
  const store = field(view, 'atlasStore');
  const state = call(store, 'getState');
  if (!assetService || !state) return null;
  const colIdField = field(state, 'currentCollectionId');
  const mapPath = field(state, 'mapPath');
  const colId = typeof colIdField === 'string' && colIdField !== ''
    ? colIdField
    : (typeof mapPath === 'string' ? call(assetService, 'getCollectionForMap', mapPath) : null);
  if (typeof colId !== 'string' || colId === '') return null;
  return call(assetService, 'getCollectionSettings', colId) ?? null;
}

export function mapCollectionIdOf(leaf: WorkspaceLeaf | null): string | null {
  const view = viewOf(leaf);
  const store = field(view, 'atlasStore');
  const state = call(store, 'getState');
  if (!state) return null;
  const colIdField = field(state, 'currentCollectionId');
  const mapPath = field(state, 'mapPath');
  if (typeof colIdField === 'string' && colIdField !== '') return colIdField;
  if (typeof mapPath !== 'string') return null;
  const assetService = call(field(view, 'serviceManager'), 'getAssetService');
  if (!assetService) return null;
  const found = call(assetService, 'getCollectionForMap', mapPath);
  return typeof found === 'string' && found !== '' ? found : null;
}

export function readResourceDefs(leaf: WorkspaceLeaf | null): unknown {
  return call(tokenRendererOf(leaf), 'resourceDefsProvider');
}

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

interface Emitter { emit(event: string, ...args: unknown[]): unknown }

function busOf(leaf: WorkspaceLeaf | null): Emitter | null {
  const bus = field(field(viewOf(leaf), 'serviceManager'), 'eventBus');
  return typeof field(bus, 'emit') === 'function' ? (bus as Emitter) : null;
}

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

export interface Capability {
  id: string;
  feature: string;
  ok: boolean;
  without: string;
}

const isFn = (target: unknown, name: string): boolean => typeof field(target, name) === 'function';

export const ATLAS_CHROME_SELECTORS: readonly string[] = [
  '.atlas-top-bar-start',
  '.atlas-top-bar-end',
  '.atlas-level-switcher',
];

function chromePresent(leaf: WorkspaceLeaf | null): boolean {
  const container = viewContainer(leaf);
  if (container === null) return false;
  try {
    return ATLAS_CHROME_SELECTORS.some((selector) => container.querySelector(selector) !== null);
  } catch {
    return false;
  }
}

export function inspect(leaf: WorkspaceLeaf | null): Capability[] {
  const view = viewOf(leaf);
  const store = field(view, 'atlasStore');
  const state = call(store, 'getState');
  const defs = readResourceDefs(leaf);
  const condDefs = readConditionDefs(leaf);
  const controller = field(tokenRendererOf(leaf), 'interactionController');
  const canMove = isFn(state, 'setTokenPositions') || isFn(state, 'dropTokens') || isFn(state, 'updateToken');
  const objects = recordOf(field(state, 'objects'));
  const hasMeasures = recordOf(field(objects, 'measures')) !== null || isFn(state, 'addMeasure') || isFn(state, 'addObject');
  const collection = recordOf(readCollectionSettings(leaf));
  const gridDefaults = recordOf(field(collection, 'gridDefaults'));
  const movement = recordOf(field(collection, 'movement'));
  // Atlas 0.21.2+: patchObject + removeObjects; 0.16.0-0.20.x: updateMeasure + deleteMeasure
  const canEditMeasure = isFn(state, 'patchObject') || isFn(state, 'updateMeasure');
  const canDeleteMeasure = isFn(state, 'removeObjects') || isFn(state, 'deleteMeasure');
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
      ok: isFn(state, 'addMeasure') || isFn(state, 'addObject'),
      without: 'Keep only pins the measurement inside the 3D map; Atlas does not save it',
    },
    {
      id: 'measureEdit',
      feature: 'Moving or editing a kept measurement',
      ok: canEditMeasure,
      without: 'a kept measurement cannot be changed, only removed and drawn again',
    },
    {
      id: 'measureDelete',
      feature: 'Removing one measurement (the × on its pill)',
      ok: canDeleteMeasure,
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
      id: 'measurePopover',
      feature: 'Atlas\'s own measurement options popover',
      ok: isFn(state, 'openMeasurePopover') && isFn(state, 'closeMeasurePopover'),
      without: 'the 3D badge cannot open Atlas\'s popover; a fallback panel would have to be drawn',
    },
    {
      id: 'auras',
      feature: 'Setting a token aura from 3D',
      ok: isFn(state, 'setTokenAuras'),
      without: 'auras can be read but not changed from the 3D map',
    },
    {
      id: 'collectionRules',
      feature: 'The collection measurement rules (diagonals, units, cone, bands)',
      ok: gridDefaults !== null,
      without: 'the 3D map measures by the map grid alone, which may differ from Atlas',
    },
    {
      id: 'movementRules',
      feature: 'Movement steps and per-turn counting',
      ok: movement !== null,
      without: 'a move is not coloured by step, and movement is not counted per turn',
    },
    {
      id: 'chrome',
      feature: 'Keeping the embedded toolbar clear of Atlas chrome',
      ok: chromePresent(leaf),
      without: 'inside an Atlas tab the 3D toolbar may sit over its buttons',
    },
  ];
}

export function formatReport(atlasVersion: string | null, capabilities: readonly Capability[]): string {
  const lines = [`Atlas VTT ${atlasVersion ?? '(version unknown)'}`, ''];
  for (const c of capabilities) {
    lines.push(c.ok ? `[ok] ${c.feature}` : `[MISSING] ${c.feature} - without it: ${c.without}`);
  }
  const present = capabilities.filter((c) => c.ok).length;
  lines.push('', `${present} of ${capabilities.length} hooks available`);
  return lines.join('\n');
}