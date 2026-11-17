import * as THREE from 'three';
import { buildTerrainChunk, type TerrainBuildOptions, type TerrainChunkBuffers } from '../terrain/blockGeometry';
import { CHUNK_SIZE, chunkOf, chunkRange, chunksToBuild } from '../terrain/flatSurface';

interface ChunkMeshes {
  tops?: THREE.Mesh;
  solid?: THREE.Mesh;
  liquid?: THREE.Mesh;
  edges?: THREE.LineSegments;
}
type Slot = 'tops' | 'solid' | 'liquid' | 'edges';

const WATER_OPACITY = 0.93;

/**
 * The terrain as one set of meshes per 16x16 chunk of columns, up to four draw calls each.
 * `tops` uses MeshLambertMaterial so slopes and elevation changes shade naturally even in Map image mode.
 * Grid lines and cell numbers are managed separately in `GridLayer`.
 */
export class TerrainMeshes {
  readonly group = new THREE.Group();
  /** Shows the map image on up-facing faces with real directional lighting. */
  readonly imageMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });

  private readonly solidMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly liquidMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: WATER_OPACITY, depthWrite: false });
  private readonly edgeMaterial = new THREE.LineBasicMaterial({ color: 0x111114, transparent: true, opacity: 0.35 });

  private readonly chunks = new Map<string, ChunkMeshes>();
  private readonly dirty = new Set<string>();
  private options: TerrainBuildOptions | null = null;

  /** What to draw; null draws nothing (no grid yet). Call `rebuildAll` after changing it. */
  setOptions(options: TerrainBuildOptions | null): void {
    this.options = options;
  }

  /** Updates the vertical slice ceiling and rebuilds visible chunks without resetting camera bounds. */
  setMaxLayer(maxLayer: number | null): void {
    const next = maxLayer ?? undefined;
    if (!this.options || this.options.maxLayer === next) return;
    this.options = { ...this.options, maxLayer: next };
    this.rebuildAll();
  }

  rebuildAll(): void {
    for (const key of [...this.chunks.keys()]) this.clearChunk(key);
    this.dirty.clear();
    if (!this.options) return;
    for (const key of chunksToBuild(this.options.map, this.options.layout)) this.rebuild(key);
  }

  /** A block or the floor of this column changed. */
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

  /** Rebuilds what was marked; true when something was. */
  flush(): boolean {
    if (this.dirty.size === 0) return false;
    if (this.options) for (const key of this.dirty) this.rebuild(key);
    this.dirty.clear();
    return true;
  }

  /** What the pointer can hit. */
  pickTargets(): THREE.Object3D[] {
    const targets: THREE.Object3D[] = [];
    for (const meshes of this.chunks.values()) for (const m of [meshes.tops, meshes.solid, meshes.liquid]) if (m) targets.push(m);
    return targets;
  }

  dispose(): void {
    for (const key of [...this.chunks.keys()]) this.clearChunk(key);
    this.imageMaterial.map?.dispose();
    for (const m of [
      this.imageMaterial,
      this.solidMaterial,
      this.liquidMaterial,
      this.edgeMaterial,
    ]) m.dispose();
  }

  private rebuild(key: string): void {
    const options = this.options;
    if (!options) return;
    const [cx, cz] = key.split(',').map(Number) as [number, number];
    const buffers = buildTerrainChunk(options, chunkRange(cx, cz));
    const meshes = this.chunks.get(key) ?? {};
    this.set(meshes, 'tops', buffers.tops, this.imageMaterial);
    this.set(meshes, 'solid', buffers.solid, this.solidMaterial);
    this.set(meshes, 'liquid', buffers.liquid, this.liquidMaterial);
    this.set(meshes, 'edges', { positions: buffers.edges }, this.edgeMaterial);
    if (meshes.tops || meshes.solid || meshes.liquid || meshes.edges) this.chunks.set(key, meshes);
    else this.chunks.delete(key);
  }

  /** Puts a part's buffers on its mesh, creating the mesh if needed and removing it when the part is empty. */
  private set(
    meshes: ChunkMeshes,
    slot: Slot,
    part: Partial<TerrainChunkBuffers['solid'] & TerrainChunkBuffers['tops']>,
    material: THREE.Material,
  ): void {
    const old = meshes[slot];
    if (old) {
      this.group.remove(old);
      old.geometry.dispose();
      delete meshes[slot];
    }
    if (!part.positions || part.positions.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
    if (part.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(part.normals, 3));
    if (part.colors) geometry.setAttribute('color', new THREE.BufferAttribute(part.colors, 3));
    if (part.uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(part.uvs, 2));
    if (slot === 'edges') {
      const segs = new THREE.LineSegments(geometry, material);
      this.group.add(segs);
      meshes[slot] = segs;
      return;
    }
    const mesh = new THREE.Mesh(geometry, material);
    if (slot === 'liquid') mesh.renderOrder = 1;
    this.group.add(mesh);
    meshes[slot] = mesh;
  }

  private clearChunk(key: string): void {
    const meshes = this.chunks.get(key);
    if (!meshes) return;
    for (const m of [meshes.tops, meshes.solid, meshes.liquid, meshes.edges]) {
      if (!m) continue;
      this.group.remove(m);
      m.geometry.dispose();
    }
    this.chunks.delete(key);
  }
}