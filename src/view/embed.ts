import type { WorkspaceLeaf } from 'obsidian';
import { sceneStoreOf } from '../atlas/bridge';
import { viewContainer } from '../atlas/internals';
import type Atlas3DPlugin from '../main';
import { Scene3D } from './Scene3D';

interface Embedded {
  scene: Scene3D;
  host: HTMLElement;
  /** What was hidden or changed in Atlas's view, to put back. */
  hidden: Array<{ el: HTMLElement; display: string }>;
  observer: MutationObserver;
  position: string | null;
  container: HTMLElement;
}

const isCanvasElement = (node: Node): node is HTMLElement =>
  node.nodeType === 1 && (node as HTMLElement).nodeName === 'CANVAS';

/**
 * The 3D map inside an Atlas tab, in place of its 2D canvas.
 *
 * Atlas builds its view in one element: the PIXI canvas, then its interface in a layer above it
 * (absolute, `z-index: 1000`, ignoring the pointer where it is empty). The 3D map goes in that same
 * element with a lower `z-index`, and the canvas is hidden. So Atlas's own interface (toolbars, scene
 * tabs, initiative, dice, its menus) stays on top and works, and the clicks it does not use reach the 3D map.
 *
 * Nothing of Atlas is changed or patched; what was hidden is put back when the map is closed.
 */
export class EmbeddedModes {
  private readonly active = new Map<WorkspaceLeaf, Embedded>();

  constructor(private readonly plugin: Atlas3DPlugin) {}

  has(leaf: WorkspaceLeaf): boolean {
    return this.active.has(leaf);
  }

  /** Switches the tab between 2D and 3D; returns whether it is 3D now. */
  toggle(leaf: WorkspaceLeaf): boolean {
    if (this.active.has(leaf)) {
      this.disable(leaf);
      return false;
    }
    return this.enable(leaf);
  }

  enable(leaf: WorkspaceLeaf): boolean {
    if (this.active.has(leaf) || sceneStoreOf(leaf) === null) return this.active.has(leaf);
    const container = viewContainer(leaf);
    if (container === null) return false;

    const hidden: Embedded['hidden'] = [];
    const hideCanvas = (el: HTMLElement): void => {
      if (el.classList.contains('atlas3d-canvas')) return;
      if (hidden.some((entry) => entry.el === el)) return;
      hidden.push({ el, display: el.style.display });
      el.style.display = 'none';
    };

    // Atlas's own canvases (the map's), hidden while the 3D map is shown.
    for (const child of Array.from(container.children)) {
      if (isCanvasElement(child)) hideCanvas(child);
    }

    // Atlas's view is already positioned; if some version is not, the 3D map still needs a frame to fill.
    let position: string | null = null;
    if (container.win.getComputedStyle(container).position === 'static') {
      position = container.style.position;
      container.style.position = 'relative';
    }

    const host = container.createDiv({ cls: 'atlas3d-embedded' });
    container.insertBefore(host, container.firstChild);

    // Watch for Atlas recreating its 2D canvas (e.g. scene load, Mosaic canvas, floor switches).
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of Array.from(m.addedNodes)) {
          if (isCanvasElement(node)) hideCanvas(node);
        }
      }
    });
    observer.observe(container, { childList: true });

    const scene = new Scene3D(this.plugin, {
      host, embedded: true, leaf, selfLeaf: null,
      onExit: () => this.disable(leaf),
    });
    this.active.set(leaf, { scene, host, hidden, observer, position, container });
    this.plugin.addChild(scene);
    return true;
  }

  disable(leaf: WorkspaceLeaf): void {
    const entry = this.active.get(leaf);
    if (!entry) return;
    this.active.delete(leaf);
    entry.observer.disconnect();
    this.plugin.removeChild(entry.scene);
    entry.host.remove();
    for (const { el, display } of entry.hidden) el.style.display = display;
    if (entry.position !== null) entry.container.style.position = entry.position;
  }

  /** Closes the maps of tabs that are gone or are no longer Atlas maps. */
  prune(): void {
    for (const [leaf, entry] of [...this.active]) {
      if (!entry.container.isConnected || sceneStoreOf(leaf) === null) this.disable(leaf);
    }
  }

  disposeAll(): void {
    for (const leaf of [...this.active.keys()]) this.disable(leaf);
  }
}