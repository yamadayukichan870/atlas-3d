import * as THREE from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { BlockMap } from '../terrain/blocks';
import { CHUNK_SIZE, chunkOf, chunkRange, chunksToBuild } from '../terrain/flatSurface';
import type { Layout } from '../terrain/layout';
import { buildCellNumbers, GLYPH_ATLAS_COLS, GLYPH_ATLAS_ROWS, GLYPH_CHARS, type CellNumberMode } from './cellNumbers';
import { buildGridLines, type GridLineType } from './gridGeometry';

export interface GridStyle {
  color: string;
  opacity: number;
  lineType: GridLineType;
  lineWidth: number;
  cellNumbers: CellNumberMode;
  numberOpacity: number;
}

export interface GridBuildOptions {
  map: BlockMap;
  layout: Layout;
  gridLines: boolean;
  lineType: GridLineType;
  cellNumbers: CellNumberMode;
  maxLayer?: number;
}

interface GridChunkMeshes {
  lines?: THREE.LineSegments | LineSegments2;
  numbers?: THREE.Mesh;
}

function createGlyphAtlas(): THREE.CanvasTexture {
  const cellW = 64;
  const cellH = 80;
  const canvas = createEl('canvas');
  canvas.width = cellW * GLYPH_ATLAS_COLS;
  canvas.height = cellH * GLYPH_ATLAS_ROWS;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 52px system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < GLYPH_CHARS.length; i++) {
      const col = i % GLYPH_ATLAS_COLS;
      const row = Math.floor(i / GLYPH_ATLAS_COLS);
      ctx.fillText(GLYPH_CHARS[i] as string, col * cellW + cellW / 2, row * cellH + cellH / 2 + 2);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 8;
  return texture;
}

/**
 * Renders the 3D grid lines (`LineSegments` at 1px, `LineSegments2` above 1px) and cell number labels
 * per 16x16 chunk, synced to Atlas VTT's Grid Settings.
 */
export class GridLayer {
  readonly group = new THREE.Group();

  private readonly lineBasicMaterial = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false });
  private readonly lineWideMaterial = new LineMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false, linewidth: 2, worldUnits: false });
  private readonly glyphTexture = createGlyphAtlas();
  private readonly numberMaterial = new THREE.MeshBasicMaterial({
    map: this.glyphTexture,
    color: 0x000000,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
    alphaTest: 0.02,
  });

  private style: GridStyle = {
    color: '#000000',
    opacity: 0.35,
    lineType: 'solid',
    lineWidth: 1,
    cellNumbers: 'off',
    numberOpacity: 0.8,
  };
  private readonly chunks = new Map<string, GridChunkMeshes>();
  private readonly dirty = new Set<string>();
  private options: GridBuildOptions | null = null;

  setOptions(options: GridBuildOptions | null): void {
    this.options = options;
  }

  setMaxLayer(maxLayer: number | null): void {
    const next = maxLayer ?? undefined;
    if (!this.options || this.options.maxLayer === next) return;
    this.options = { ...this.options, maxLayer: next };
    this.rebuildAll();
  }

  setResolution(width: number, height: number): void {
    if (width > 0 && height > 0) this.lineWideMaterial.resolution.set(width, height);
  }

  setGridStyle(style: GridStyle): void {
    const wasWide = this.isWideLine();
    this.style = style;
    const isWide = this.isWideLine();

    this.lineBasicMaterial.color.set(style.color);
    this.lineBasicMaterial.opacity = style.opacity;
    this.lineBasicMaterial.needsUpdate = true;

    this.lineWideMaterial.color.set(style.color);
    this.lineWideMaterial.opacity = style.opacity;
    this.lineWideMaterial.linewidth = style.lineWidth;
    this.lineWideMaterial.needsUpdate = true;

    this.numberMaterial.color.set(style.color);
    this.numberMaterial.opacity = style.numberOpacity;
    this.numberMaterial.needsUpdate = true;

    if (wasWide !== isWide && this.options) this.rebuildAll();
  }

  rebuildAll(): void {
    for (const key of [...this.chunks.keys()]) this.clearChunk(key);
    this.dirty.clear();
    if (!this.options || !this.options.gridLines) return;
    for (const key of chunksToBuild(this.options.map, this.options.layout)) this.rebuild(key);
  }

  markDirty(x: number, z: number): void {
    const cx = chunkOf(x);
    const cz = chunkOf(z);
    this.dirty.add(`${cx},${cz}`);
    const lx = x - cx * CHUNK_SIZE;
    const lz = z - cz * CHUNK_SIZE;
    if (lx === 0) this.dirty.add(`${cx - 1},${cz}`);
    if (lx === CHUNK_SIZE - 1) this.dirty.add(`${cx + 1},${cz}`);
    if (lz === 0) this.dirty.add(`${cx},${cz - 1}`);
    if (lz === CHUNK_SIZE - 1) this.dirty.add(`${cx},${cz + 1}`);
  }

  flush(): boolean {
    if (this.dirty.size === 0) return false;
    if (this.options && this.options.gridLines) {
      for (const key of this.dirty) this.rebuild(key);
    }
    this.dirty.clear();
    return true;
  }

  dispose(): void {
    for (const key of [...this.chunks.keys()]) this.clearChunk(key);
    this.glyphTexture.dispose();
    this.lineBasicMaterial.dispose();
    this.lineWideMaterial.dispose();
    this.numberMaterial.dispose();
  }

  private isWideLine(): boolean {
    return this.style.lineWidth > 1.05;
  }

  private rebuild(key: string): void {
    const options = this.options;
    if (!options || !options.gridLines) {
      this.clearChunk(key);
      return;
    }
    const [cx, cz] = key.split(',').map(Number) as [number, number];
    const range = chunkRange(cx, cz);
    const linePositions = buildGridLines(
      { map: options.map, layout: options.layout, lineType: options.lineType, maxLayer: options.maxLayer },
      range,
    );
    const numBuffers = buildCellNumbers(
      { map: options.map, layout: options.layout, mode: options.cellNumbers, maxLayer: options.maxLayer },
      range,
    );

    const meshes = this.chunks.get(key) ?? {};
    this.setLines(meshes, linePositions);
    this.setNumbers(meshes, numBuffers.positions, numBuffers.uvs);
    if (meshes.lines || meshes.numbers) this.chunks.set(key, meshes);
    else this.chunks.delete(key);
  }

  private setLines(meshes: GridChunkMeshes, positions: Float32Array): void {
    const old = meshes.lines;
    if (old) {
      this.group.remove(old);
      old.geometry.dispose();
      delete meshes.lines;
    }
    if (positions.length === 0) return;

    if (this.isWideLine()) {
      const geometry = new LineSegmentsGeometry();
      geometry.setPositions(positions);
      const wide = new LineSegments2(geometry, this.lineWideMaterial);
      wide.renderOrder = 2;
      this.group.add(wide);
      meshes.lines = wide;
      return;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const segs = new THREE.LineSegments(geometry, this.lineBasicMaterial);
    segs.renderOrder = 2;
    this.group.add(segs);
    meshes.lines = segs;
  }

  private setNumbers(meshes: GridChunkMeshes, positions: Float32Array, uvs: Float32Array): void {
    const old = meshes.numbers;
    if (old) {
      this.group.remove(old);
      old.geometry.dispose();
      delete meshes.numbers;
    }
    if (positions.length === 0) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    const mesh = new THREE.Mesh(geometry, this.numberMaterial);
    mesh.renderOrder = 3;
    this.group.add(mesh);
    meshes.numbers = mesh;
  }

  private clearChunk(key: string): void {
    const meshes = this.chunks.get(key);
    if (!meshes) return;
    for (const m of [meshes.lines, meshes.numbers]) {
      if (!m) continue;
      this.group.remove(m);
      m.geometry.dispose();
    }
    this.chunks.delete(key);
  }
}