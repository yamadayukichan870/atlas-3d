import { PluginSettingTab, Setting, type App } from 'obsidian';
import type Atlas3DPlugin from './main';

export interface Atlas3DSettings {
  /** Vault folder for terrain sidecar files. Must not be inside Atlas's own `atlas-vtt/` folder. */
  terrainFolder: string;
  /** Largest side, in pixels, of the map texture sent to the GPU. */
  maxMapTexture: number;
}

export const DEFAULT_SETTINGS: Atlas3DSettings = { terrainFolder: 'Atlas3D', maxMapTexture: 4096 };

export class Atlas3DSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: Atlas3DPlugin) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Terrain folder')
      .setDesc('Where terrain files are saved, one per scene. Keep it outside Atlas VTT\'s own folder: Atlas treats JSON files in its collections as its assets.')
      .addText((text) => text
        .setValue(this.plugin.settings.terrainFolder)
        .onChange(async (value) => {
          const folder = value.trim().replace(/^\/+|\/+$/g, '');
          if (folder === '' || folder.toLowerCase().startsWith('atlas-vtt')) return; // refuse Atlas's own folder
          this.plugin.settings.terrainFolder = folder;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Map texture size')
      .setDesc('Larger keeps more detail on big maps but uses more video memory. Takes effect when a scene is loaded again.')
      .addDropdown((dropdown) => dropdown
        .addOptions({ '2048': '2048 px', '4096': '4096 px', '8192': '8192 px' })
        .setValue(String(this.plugin.settings.maxMapTexture))
        .onChange(async (value) => {
          this.plugin.settings.maxMapTexture = Number(value);
          await this.plugin.saveSettings();
        }));
  }
}
