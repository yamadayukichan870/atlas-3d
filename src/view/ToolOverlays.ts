import * as THREE from 'three';
import type { BlockMap, Rotation } from '../terrain/blocks';
import type { Layout } from '../terrain/layout';
import { facesOf, quarterOf, SHAPE_INFO, type BlockShape } from '../terrain/shapes';

export interface GhostSpec {
  x: number;
  y: number;
  z: number;
  shape: BlockShape;
  rot: Rotation;
  color: number;
}

export interface MoveTargetSpec {
  /** World coordinates (cells) of the landing center. */
  x: number;
  z: number;
  diameter: number;
  snap: boolean;
  floorCeiling: number;
}

/** One selected token's logical footprint, in world units over the plan. */
export interface SelectionFrameSpec {
  x: number;
  z: number;
  diameter: number;
}

function createSquareBorderGeometry(): THREE.BufferGeometry {
  const h = 0.48;
  const positions = new Float32Array([
    -h, 0, -h,  h, 0, -h,
     h, 0, -h,  h, 0,  h,
     h, 0,  h, -h, 0,  h,
    -h, 0,  h, -h, 0, -h,
  ]);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geom;
}

/**
 * Translucent brush cursor (Raise/Lower), block placement ghost (Build),
 * FFT-style landing tile highlight while dragging tokens, and the ground frame
 * a selected token's footprint wears.
 *
 * THE SELECTION FRAME IS THE FOOTPRINT, not the art. TokenLayer already draws a yellow ring
 * around a selected token's billboard; this draws the cells it OCCUPIES on the floor, which is
 * what Atlas' 2D map shows and what tells a 3x3's reach from a 1x1's at a glance. It reuses the
 * landing tile's square border, pooled so a hundred selected tokens are a hundred LineSegments
 * sharing one geometry and one material, never a rebuild.
 */
export class ToolOverlays {
  readonly cursor: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  readonly ghost: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  readonly moveTileGroup = new THREE.Group();
  readonly selectionGroup = new THREE.Group();
  private readonly moveFill: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly moveBorder: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private readonly moveFreeRing: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly ghostGeometries = new Map<string, THREE.BufferGeometry>();
  private readonly selectionBorderGeometry = createSquareBorderGeometry();
  private readonly selectionMaterial = new THREE.LineBasicMaterial({
    color: 0xffd24a, transparent: true, opacity: 0.85, depthTest: false,
  });
  private readonly selectionFrames: THREE.LineSegments[] = [];

  constructor() {
    this.cursor = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.4, depthTest: false }),
    );
    this.cursor.renderOrder = 10;
    this.cursor.visible = false;

    this.ghost = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    );
    this.ghost.renderOrder = 9;
    this.ghost.visible = false;

    this.moveFill = new THREE.Mesh(
      new THREE.PlaneGeometry(0.94, 0.94).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.28, depthWrite: false }),
    );
    this.moveFill.renderOrder = 6;

    this.moveBorder = new THREE.LineSegments(
      createSquareBorderGeometry(),
      new THREE.LineBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.95, depthTest: false }),
    );
    this.moveBorder.renderOrder = 11;

    this.moveFreeRing = new THREE.Mesh(
      new THREE.RingGeometry(0.38, 0.47, 36).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthTest: false }),
    );
    this.moveFreeRing.renderOrder = 11;

    this.moveTileGroup.add(this.moveFill, this.moveBorder, this.moveFreeRing);
    this.moveTileGroup.visible = false;
    this.selectionGroup.visible = false;
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.cursor, this.ghost, this.moveTileGroup, this.selectionGroup);
  }

  setCursor(
    cell: { cx: number; cy: number } | null,
    brush: number,
    mode: 'raise' | 'lower' | null,
    layout: Layout | null,
    map: BlockMap,
    ceilingY: number,
  ): boolean {
    if (!cell || !layout || mode === null) {
      if (!this.cursor.visible) return false;
      this.cursor.visible = false;
      return true;
    }
    const first = -Math.floor((brush - 1) / 2);
    const block = map.walkableBlockAt(cell.cx, cell.cy, ceilingY);
    const surfaceY = block ? (block.y - 1 + SHAPE_INFO[block.shape].topPlane) * map.layerHeight : 0;
    this.cursor.position.set(
      layout.originX + cell.cx + first + brush / 2,
      surfaceY + 0.03,
      layout.originZ + cell.cy + first + brush / 2,
    );
    this.cursor.scale.set(brush, 1, brush);
    this.cursor.material.color.set(mode === 'raise' ? 0x4ade80 : 0xf87171);
    this.cursor.visible = true;
    return true;
  }

  setGhost(spec: GhostSpec | null, layout: Layout | null, layerHeight: number): boolean {
    if (!spec || !layout) {
      if (!this.ghost.visible) return false;
      this.ghost.visible = false;
      return true;
    }
    this.ghost.geometry = this.ghostGeometry(spec.shape, spec.rot);
    this.ghost.material.color.set(spec.color);
    this.ghost.position.set(layout.originX + spec.x, (spec.y - 1) * layerHeight, layout.originZ + spec.z);
    this.ghost.scale.set(1, layerHeight, 1);
    this.ghost.visible = true;
    return true;
  }

  setMoveTarget(
    spec: MoveTargetSpec | null,
    layout: Layout | null,
    map: BlockMap,
    sliceCeilingY: number,
  ): boolean {
    if (!spec || !layout) {
      if (!this.moveTileGroup.visible) return false;
      this.moveTileGroup.visible = false;
      return true;
    }
    const gx = spec.x - layout.originX;
    const gz = spec.z - layout.originZ;
    const effCeiling = Math.min(sliceCeilingY, spec.floorCeiling);
    const radius = spec.diameter <= 1 ? 0.35 : Math.max(0.2, spec.diameter * 0.44);
    const groundY = map.sampleDisc(gx, gz, radius, effCeiling).max;

    const scale = Math.max(1, spec.diameter);
    this.moveTileGroup.position.set(spec.x, groundY + 0.025, spec.z);
    this.moveTileGroup.scale.set(scale, 1, scale);
    this.moveFill.visible = spec.snap;
    this.moveBorder.visible = spec.snap;
    this.moveFreeRing.visible = !spec.snap;
    this.moveTileGroup.visible = true;
    return true;
  }

  /**
   * The ground frame under each selected token's footprint. Called every frame with the current
   * selection, so it follows terrain edits and the slice without a separate invalidation path.
   * The pool grows to the most tokens ever selected at once and never shrinks; extra frames hide.
   */
  setSelection(
    frames: readonly SelectionFrameSpec[],
    layout: Layout | null,
    map: BlockMap,
    ceilingY: number,
  ): boolean {
    if (!layout || frames.length === 0) {
      const had = this.selectionGroup.visible;
      this.selectionGroup.visible = false;
      return had;
    }
    for (let i = 0; i < frames.length; i++) {
      let line = this.selectionFrames[i];
      if (!line) {
        line = new THREE.LineSegments(this.selectionBorderGeometry, this.selectionMaterial);
        line.renderOrder = 3;
        this.selectionFrames.push(line);
        this.selectionGroup.add(line);
      }
      const f = frames[i]!;
      const gx = f.x - layout.originX;
      const gz = f.z - layout.originZ;
      const radius = f.diameter <= 1 ? 0.35 : Math.max(0.2, f.diameter * 0.44);
      const ground = map.sampleDisc(gx, gz, radius, ceilingY).max;
      const scale = Math.max(1, f.diameter);
      line.position.set(f.x, ground + 0.02, f.z);
      line.scale.set(scale, 1, scale);
      line.visible = true;
    }
    for (let i = frames.length; i < this.selectionFrames.length; i++) {
      this.selectionFrames[i]!.visible = false;
    }
    this.selectionGroup.visible = true;
    return true;
  }

  dispose(): void {
    for (const g of this.ghostGeometries.values()) g.dispose();
    this.ghostGeometries.clear();
    this.cursor.material.dispose();
    this.cursor.geometry.dispose();
    this.ghost.material.dispose();
    this.ghost.geometry.dispose();
    this.moveFill.material.dispose();
    this.moveFill.geometry.dispose();
    this.moveBorder.material.dispose();
    this.moveBorder.geometry.dispose();
    this.moveFreeRing.material.dispose();
    this.moveFreeRing.geometry.dispose();
    // Every selection frame shares these two; dispose once, not per frame.
    this.selectionMaterial.dispose();
    this.selectionBorderGeometry.dispose();
  }

  private ghostGeometry(shape: BlockShape, rot: Rotation): THREE.BufferGeometry {
    const key = `${shape}:${rot}`;
    let geometry = this.ghostGeometries.get(key);
    if (!geometry) {
      const positions: number[] = [];
      for (const f of facesOf(shape, quarterOf(rot))) {
        for (const i of f.verts.length === 4 ? [0, 1, 2, 0, 2, 3] : [0, 1, 2]) {
          positions.push(...(f.verts[i] as readonly [number, number, number]));
        }
      }
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      this.ghostGeometries.set(key, geometry);
    }
    return geometry;
  }
}