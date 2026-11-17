import { TFile, type App } from 'obsidian';
import * as THREE from 'three';

export interface LoadedImage {
  texture: THREE.CanvasTexture;
  /** The image's own size in pixels (the texture may be smaller). */
  width: number;
  height: number;
}

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
}

async function decode(buffer: ArrayBuffer, path: string): Promise<Decoded> {
  const isSvg = path.toLowerCase().endsWith('.svg');
  const blob = new Blob([buffer], isSvg ? { type: 'image/svg+xml' } : {});
  try {
    const bitmap = await createImageBitmap(blob);
    return { source: bitmap, width: bitmap.width, height: bitmap.height };
  } catch {
    // SVG and a few odd formats: let an <img> decode them.
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { source: img, width: img.naturalWidth || 512, height: img.naturalHeight || 512 };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/**
 * Reads vault images as bytes and draws them into a canvas no larger than `maxSize`, which three.js
 * then uploads. Atlas does the same for its own art: a `fetch` of an `app://` URL fails on some
 * Obsidian installers, while the vault always gives the bytes.
 */
export class TextureLoader {
  private readonly tokens = new Map<string, Promise<LoadedImage | null>>();

  constructor(private readonly app: App) {}

  /** A token's art, shared between tokens that use the same file; never disposed until the view closes. */
  token(path: string): Promise<LoadedImage | null> {
    let loading = this.tokens.get(path);
    if (!loading) {
      loading = this.load(path, 512);
      this.tokens.set(path, loading);
    }
    return loading;
  }

  /** The map image: not cached, since the renderer owns and disposes it. */
  map(path: string, maxSize: number): Promise<LoadedImage | null> {
    return this.load(path, maxSize);
  }

  async dispose(): Promise<void> {
    for (const loading of this.tokens.values()) (await loading)?.texture.dispose();
    this.tokens.clear();
  }

  private async read(path: string): Promise<ArrayBuffer | null> {
    try {
      const file = this.app.vault.getAbstractFileByPath(path);
      return file instanceof TFile ? await this.app.vault.readBinary(file) : await this.app.vault.adapter.readBinary(path);
    } catch {
      return null;
    }
  }

  private async load(path: string, maxSize: number): Promise<LoadedImage | null> {
    try {
      const buffer = await this.read(path);
      if (!buffer) return null;
      const image = await decode(buffer, path);
      const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
      const canvas = createEl('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext('2d')?.drawImage(image.source, 0, 0, canvas.width, canvas.height);
      if ('close' in image.source) image.source.close();
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 8;
      return { texture, width: image.width, height: image.height };
    } catch (error) {
      console.error('[Atlas 3D] Could not load image', path, error);
      return null;
    }
  }
}
