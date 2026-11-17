import { Notice, Plugin, TFolder, type WorkspaceLeaf } from 'obsidian';
import { atlasPlugin, atlasVersion, pickAtlasLeaf } from './atlas/bridge';
import { DEFAULT_SETTINGS, Atlas3DSettingTab, type Atlas3DSettings } from './settings';
import { TerrainStore } from './terrain/terrain';
import { DiagnosticsModal } from './ui/DiagnosticsModal';
import { Atlas3DView, VIEW_TYPE } from './view/Atlas3DView';
import { EmbeddedModes } from './view/embed';

export default class Atlas3DPlugin extends Plugin {
  override settings: Atlas3DSettings = { ...DEFAULT_SETTINGS };
  terrain!: TerrainStore;
  embedded!: EmbeddedModes;

  override async onload(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData() as Partial<Atlas3DSettings> | null) };
    this.terrain = new TerrainStore(this.app, () => this.settings.terrainFolder);
    this.embedded = new EmbeddedModes(this);

    this.registerView(VIEW_TYPE, (leaf) => new Atlas3DView(leaf, this));
    this.addRibbonIcon('box', 'Open Atlas 3D map', () => void this.openView());
    this.addCommand({ id: 'open-3d-map', name: 'Open 3D map of the active Atlas scene', callback: () => void this.openView() });
    this.addCommand({ id: 'toggle-3d-in-atlas', name: 'Toggle the 3D map inside the active Atlas scene', callback: () => this.toggleInAtlas() });
    this.addCommand({
      id: 'check-atlas-compatibility',
      name: 'Check compatibility with Atlas VTT',
      callback: () => new DiagnosticsModal(this.app, pickAtlasLeaf(this.app, null)).open(),
    });
    this.addSettingTab(new Atlas3DSettingTab(this.app, this));
    // An embedded map goes when its Atlas tab does.
    this.registerEvent(this.app.workspace.on('layout-change', () => this.embedded.prune()));

    // Terrain belongs to a scene file: when Obsidian renames or moves it (or its folder), the terrain follows.
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (file instanceof TFolder || file.path.endsWith('.atlasmap')) void this.terrain.renamePath(oldPath, file.path);
    }));
  }

  override onunload(): void {
    this.embedded.disposeAll();
    void this.terrain.flush();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async openView(): Promise<void> {
    if (atlasPlugin(this.app) === undefined) {
      new Notice('Atlas 3D needs the Atlas VTT plugin installed and enabled.');
      return;
    }
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      return;
    }
    // Beside Atlas, not over it: the 2D map stays visible and keeps working.
    const leaf = this.app.workspace.getLeaf('split', 'vertical');
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
    if (atlasVersion(this.app) === null) new Notice('Atlas 3D could not read the Atlas VTT version; some features may not work.');
  }

  /** Shows the 3D map inside the active Atlas tab, under Atlas's own interface, or goes back to 2D. */
  toggleInAtlas(): void {
    if (atlasPlugin(this.app) === undefined) {
      new Notice('Atlas 3D needs the Atlas VTT plugin installed and enabled.');
      return;
    }
    const leaf = pickAtlasLeaf(this.app, null);
    if (leaf === null) {
      new Notice('Open a scene in Atlas VTT first.');
      return;
    }
    this.embedded.toggle(leaf);
  }

  /** Moves a 3D map from its own pane into the Atlas tab it was following, and closes the pane. */
  dockIntoAtlas(atlasLeaf: WorkspaceLeaf | null, pane: WorkspaceLeaf | null): void {
    if (atlasLeaf === null || !this.embedded.enable(atlasLeaf)) {
      new Notice('Open a scene in Atlas VTT first.');
      return;
    }
    pane?.detach();
  }
}