import { normalizePath, type App } from 'obsidian';
import { BlockMap, parseTerrain, type Parsed } from './blocks';

/** Characters that cannot go in a file name, or that separate a scene's path from its level. */
const sanitize = (key: string): string => key.replace(/[\\/:]/g, '__');

/**
 * One sidecar JSON per Atlas scene level, in a vault folder of this plugin's own. Keys are opaque
 * strings: the scene file's path, plus `::levelId` for levels above the first.
 *
 * Never inside `atlas-vtt/`: that folder is Atlas's, and it reads JSON files placed there as its own
 * records. Visible folder rather than a dot folder, so sync tools carry it, like Atlas's own library.
 */
export class TerrainStore {
  private readonly timers = new Map<string, number>();
  private readonly pending = new Map<string, BlockMap>();

  constructor(private readonly app: App, private readonly folder: () => string) {}

  pathFor(key: string): string {
    return normalizePath(`${this.folder()}/${sanitize(key)}.json`);
  }

  /**
   * The scene's terrain: its sidecar if there is one, else the "Tactical 3D" satellite next to the
   * scene file (read, never changed), else an empty map. `migrated` tells the caller to save it in
   * the current format.
   */
  async load(key: string): Promise<Parsed> {
    const adapter = this.app.vault.adapter;
    const path = this.pathFor(key);
    try {
      if (await adapter.exists(path)) {
        try {
          return parseTerrain(JSON.parse(await adapter.read(path)));
        } catch (error) {
          // Never let the next edit overwrite a file that could not be read: keep a copy first.
          console.error('[Atlas 3D] Terrain file is unreadable, keeping a copy as .broken', path, error);
          await adapter.copy(path, `${path}.broken`).catch(() => undefined);
          return { map: new BlockMap(), migrated: false };
        }
      }
      if (!key.includes('::')) {
        const satellite = normalizePath(`${key}.3d.json`);
        if (await adapter.exists(satellite)) {
          const { map } = parseTerrain(JSON.parse(await adapter.read(satellite)));
          return { map, migrated: true };
        }
      }
    } catch (error) {
      console.error('[Atlas 3D] Could not read terrain for', key, error);
    }
    return { map: new BlockMap(), migrated: false };
  }

  /** Writes soon, not on every brush stroke. */
  schedule(key: string, map: BlockMap): void {
    this.pending.set(key, map);
    window.clearTimeout(this.timers.get(key));
    this.timers.set(key, window.setTimeout(() => void this.flushOne(key), 800));
  }

  async flush(): Promise<void> {
    for (const key of [...this.pending.keys()]) await this.flushOne(key);
  }

  /**
   * Follows a renamed or moved scene file, or a renamed folder of scenes, so terrain stays with its
   * scene. Matches by prefix: the scene's own file, its levels, and everything below a folder.
   */
  async renamePath(oldPath: string, newPath: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const folder = normalizePath(this.folder());
    const from = sanitize(oldPath);
    const to = sanitize(newPath);
    if (from === to) return;
    try {
      if (!(await adapter.exists(folder))) return;
      const { files } = await adapter.list(folder);
      for (const file of files) {
        const name = file.split('/').pop() ?? '';
        if (name !== `${from}.json` && !name.startsWith(`${from}__`)) continue;
        const target = normalizePath(`${folder}/${to}${name.slice(from.length)}`);
        if (!(await adapter.exists(target))) await adapter.rename(file, target);
      }
    } catch (error) {
      console.error('[Atlas 3D] Could not follow a renamed scene', oldPath, error);
    }
  }

  private async flushOne(key: string): Promise<void> {
    const map = this.pending.get(key);
    window.clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    if (!map) return;
    this.pending.delete(key);
    const adapter = this.app.vault.adapter;
    try {
      const folder = normalizePath(this.folder());
      if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
      // One block per line: sync tools and diffs see small changes as small changes.
      await adapter.write(this.pathFor(key), JSON.stringify(map.toData(), null, 1));
    } catch (error) {
      console.error('[Atlas 3D] Could not save terrain for', key, error);
    }
  }
}
