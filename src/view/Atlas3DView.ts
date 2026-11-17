import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type Atlas3DPlugin from '../main';
import { Scene3D } from './Scene3D';

export const VIEW_TYPE = 'atlas-3d';

/** The 3D map in a pane of its own, beside Atlas. All the work is in `Scene3D`. */
export class Atlas3DView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private readonly plugin: Atlas3DPlugin) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return 'Atlas 3D'; }
  override getIcon(): string { return 'box'; }

  override async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass('atlas3d-view');
    this.addChild(new Scene3D(this.plugin, {
      host: root,
      embedded: false,
      leaf: null,
      selfLeaf: this.leaf,
      onDock: (followed) => this.plugin.dockIntoAtlas(followed, this.leaf),
    }));
  }
}
