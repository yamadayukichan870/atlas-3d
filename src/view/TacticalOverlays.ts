import * as THREE from 'three';
import type { BlockMap } from '../terrain/blocks';
import type { Layout } from '../terrain/layout';
import { collectAoECells, type AoEShape } from '../terrain/raycast';
import type { Vec3 } from '../terrain/shapes';

export interface MeasureDisplay {
  id: string;
  shape: AoEShape;
  points: readonly Vec3[];
  radiusCells: number;
  label: string;
  subLabel?: string;
  color?: number;
  pinned?: boolean;
}

export interface LosRayDisplay {
  name: 'base' | 'torso' | 'head';
  start: Vec3;
  end: Vec3;
  blocked: boolean;
  hitPoint: Vec3 | null;
}

export interface LosDisplay {
  origin: Vec3;
  target: Vec3;
  status: 'clear' | 'partial' | 'blocked';
  rays: readonly [LosRayDisplay, LosRayDisplay, LosRayDisplay];
  label: string;
  locked: boolean;
}

export interface TacticalOverlayContext {
  layout: Layout;
  map: BlockMap;
  maxLayer: number;
}

interface PillEntry {
  el: HTMLElement;
  worldPos: THREE.Vector3;
}

const UP = new THREE.Vector3(0, 1, 0);
const DOWN_VEC = new THREE.Vector3(0, -1, 0);
const CONE_HALF_ANGLE = (53.13 * Math.PI) / 360;

function createUnitApexConeGeometry(): THREE.ConeGeometry {
  const geom = new THREE.ConeGeometry(1, 1, 28, 1, false);
  geom.translate(0, -0.5, 0);
  return geom;
}

function createCircleRingGeometry(): THREE.BufferGeometry {
  const pts: number[] = [];
  const segs = 48;
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    pts.push(Math.cos(a0), 0, Math.sin(a0), Math.cos(a1), 0, Math.sin(a1));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

/**
 * Renders 3D tactical measurements (line/waypoints, sphere, cone, cube, pinned templates),
 * 3D Line-of-Sight rays (clear/partial/blocked) and their screen-projected readout pills.
 */
export class TacticalOverlays {
  readonly group = new THREE.Group();

  private readonly measureGroup = new THREE.Group();
  private readonly losGroup = new THREE.Group();
  private readonly labelLayer: HTMLElement;

  private readonly sphereGeom = new THREE.SphereGeometry(1, 24, 16);
  private readonly coneGeom = createUnitApexConeGeometry();
  private readonly boxGeom = new THREE.BoxGeometry(1, 1, 1);
  private readonly boxWireGeom = new THREE.EdgesGeometry(this.boxGeom);
  private readonly nodeGeom = new THREE.SphereGeometry(0.11, 12, 10);
  private readonly hitGeom = new THREE.SphereGeometry(0.13, 12, 10);
  private readonly cellQuadGeom = new THREE.PlaneGeometry(0.92, 0.92).rotateX(-Math.PI / 2);
  private readonly ringLineGeom = createCircleRingGeometry();

  private readonly measurePills: PillEntry[] = [];
  private losPill: PillEntry | null = null;
  private onUnpin: ((id: string) => void) | null = null;

  private readonly ownedGeometries: THREE.BufferGeometry[] = [];
  private readonly ownedMaterials: THREE.Material[] = [];

  constructor(host: HTMLElement, onUnpin?: (id: string) => void) {
    this.onUnpin = onUnpin ?? null;
    this.group.add(this.measureGroup, this.losGroup);
    this.labelLayer = host.createDiv({ cls: 'atlas3d-tactical-layer' });
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.group);
  }

  setMeasure(
    active: MeasureDisplay | null,
    pinned: readonly MeasureDisplay[],
    ctx: TacticalOverlayContext | null,
  ): void {
    this.clearMeasure();
    if (!ctx) return;
    const all = active ? [...pinned, active] : [...pinned];
    for (const item of all) this.buildMeasure(item, ctx);
  }

  setLos(spec: LosDisplay | null): void {
    this.clearLos();
    if (!spec) return;
    this.buildLos(spec);
  }

  updateScreenLabels(camera: THREE.Camera, width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    const projected = new THREE.Vector3();

    const positionPill = (entry: PillEntry): void => {
      projected.copy(entry.worldPos).project(camera);
      if (projected.z <= -1 || projected.z >= 1) {
        entry.el.addClass('is-hidden');
        return;
      }
      entry.el.removeClass('is-hidden');
      const x = (projected.x * 0.5 + 0.5) * width;
      const y = (-projected.y * 0.5 + 0.5) * height;
      entry.el.style.left = `${x}px`;
      entry.el.style.top = `${y}px`;
    };

    for (const entry of this.measurePills) positionPill(entry);
    if (this.losPill) positionPill(this.losPill);
  }

  dispose(): void {
    this.clearMeasure();
    this.clearLos();
    this.labelLayer.remove();
    this.sphereGeom.dispose();
    this.coneGeom.dispose();
    this.boxGeom.dispose();
    this.boxWireGeom.dispose();
    this.nodeGeom.dispose();
    this.hitGeom.dispose();
    this.cellQuadGeom.dispose();
    this.ringLineGeom.dispose();
  }

  // ---- measure builder -----------------------------------------------------------------------

  private clearMeasure(): void {
    this.measureGroup.clear();
    for (const g of this.ownedGeometries.splice(0)) g.dispose();
    for (const m of this.ownedMaterials.splice(0)) m.dispose();
    for (const p of this.measurePills.splice(0)) p.el.remove();
  }

  private trackMat<T extends THREE.Material>(mat: T): T {
    this.ownedMaterials.push(mat);
    return mat;
  }

  private trackGeom<T extends THREE.BufferGeometry>(geom: T): T {
    this.ownedGeometries.push(geom);
    return geom;
  }

  private buildMeasure(item: MeasureDisplay, ctx: TacticalOverlayContext): void {
    if (item.points.length < 2) return;
    const color = item.color ?? (item.pinned ? 0xf59e0b : 0x38bdf8);
    const origin = item.points[0]!;
    const tip = item.points[item.points.length - 1]!;
    const ceilingY = Number.isFinite(ctx.maxLayer) ? ctx.maxLayer * ctx.map.layerHeight : Infinity;

    // 1. Primary 3D path + waypoint nodes + vertical ground drop lines
    const lineMat = this.trackMat(new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false }));
    const dropMat = this.trackMat(new THREE.LineDashedMaterial({ color, transparent: true, opacity: 0.55, dashSize: 0.14, gapSize: 0.08, depthTest: false }));
    const nodeMat = this.trackMat(new THREE.MeshBasicMaterial({ color, depthTest: false }));

    const linePts = item.points.map((p) => new THREE.Vector3(p[0], p[1] + 0.04, p[2]));
    const lineGeom = this.trackGeom(new THREE.BufferGeometry().setFromPoints(linePts));
    const line = new THREE.Line(lineGeom, lineMat);
    line.renderOrder = 14;
    this.measureGroup.add(line);

    for (const p of item.points) {
      const node = new THREE.Mesh(this.nodeGeom, nodeMat);
      node.position.set(p[0], p[1] + 0.04, p[2]);
      node.renderOrder = 15;
      this.measureGroup.add(node);

      const groundY = ctx.map.surfaceHeightAt(p[0] - ctx.layout.originX, p[2] - ctx.layout.originZ, ceilingY);
      if (Math.abs(p[1] - groundY) > 0.08) {
        const dropGeom = this.trackGeom(new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(p[0], p[1] + 0.04, p[2]),
          new THREE.Vector3(p[0], groundY + 0.02, p[2]),
        ]));
        const drop = new THREE.Line(dropGeom, dropMat);
        drop.computeLineDistances();
        drop.renderOrder = 13;
        this.measureGroup.add(drop);
      }
    }

    // 2. AoE 3D volumes + terrain cell projection
    if (item.shape !== 'line' && item.radiusCells > 0.05) {
      const volMat = this.trackMat(new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
        depthWrite: false,
      }));
      const wireMat = this.trackMat(new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.72,
        depthWrite: false,
      }));

      if (item.shape === 'sphere') {
        const sphere = new THREE.Mesh(this.sphereGeom, volMat);
        sphere.position.set(origin[0], origin[1] + 0.04, origin[2]);
        sphere.scale.setScalar(item.radiusCells);
        sphere.renderOrder = 11;
        this.measureGroup.add(sphere);

        const ring = new THREE.LineSegments(this.ringLineGeom, wireMat);
        ring.position.set(origin[0], origin[1] + 0.04, origin[2]);
        ring.scale.setScalar(item.radiusCells);
        ring.renderOrder = 12;
        this.measureGroup.add(ring);
      } else if (item.shape === 'cone') {
        const dir = new THREE.Vector3(tip[0] - origin[0], tip[1] - origin[1], tip[2] - origin[2]);
        const len = dir.length();
        if (len > 1e-4) {
          dir.normalize();
          const coneRadius = len * Math.tan(CONE_HALF_ANGLE);
          const cone = new THREE.Mesh(this.coneGeom, volMat);
          cone.position.set(origin[0], origin[1] + 0.04, origin[2]);
          cone.quaternion.setFromUnitVectors(DOWN_VEC, dir);
          cone.scale.set(coneRadius, len, coneRadius);
          cone.renderOrder = 11;
          this.measureGroup.add(cone);

          const ring = new THREE.LineSegments(this.ringLineGeom, wireMat);
          ring.position.set(tip[0], tip[1] + 0.04, tip[2]);
          ring.quaternion.setFromUnitVectors(UP, dir);
          ring.scale.setScalar(coneRadius);
          ring.renderOrder = 12;
          this.measureGroup.add(ring);
        }
      } else if (item.shape === 'cube') {
        const size = item.radiusCells;
        const box = new THREE.Mesh(this.boxGeom, volMat);
        box.position.set(tip[0], tip[1] + size * 0.5 + 0.02, tip[2]);
        box.scale.setScalar(size);
        box.renderOrder = 11;
        this.measureGroup.add(box);

        const wire = new THREE.LineSegments(this.boxWireGeom, wireMat);
        wire.position.copy(box.position);
        wire.scale.setScalar(size);
        wire.renderOrder = 12;
        this.measureGroup.add(wire);
      }

      const cells = collectAoECells(item.shape, origin, tip, item.radiusCells, ctx.map, ctx.layout, ctx.maxLayer, CONE_HALF_ANGLE);
      if (cells.length > 0) {
        const cellMat = this.trackMat(new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.28,
          depthWrite: false,
        }));
        const inst = new THREE.InstancedMesh(this.cellQuadGeom, cellMat, cells.length);
        const dummy = new THREE.Object3D();
        for (let i = 0; i < cells.length; i++) {
          const c = cells[i]!;
          dummy.position.set(ctx.layout.originX + c.cx + 0.5, c.y + 0.025, ctx.layout.originZ + c.cz + 0.5);
          dummy.updateMatrix();
          inst.setMatrixAt(i, dummy.matrix);
        }
        inst.instanceMatrix.needsUpdate = true;
        inst.renderOrder = 10;
        this.measureGroup.add(inst);
      }
    }

    // 3. Screen-projected floating readout pill
    const pill = this.labelLayer.createDiv({ cls: item.pinned ? 'atlas3d-tactical-pill is-pinned' : 'atlas3d-tactical-pill' });
    pill.createSpan({ cls: 'atlas3d-tactical-main', text: item.label });
    if (item.subLabel) pill.createSpan({ cls: 'atlas3d-tactical-sub', text: item.subLabel });
    if (item.pinned && this.onUnpin) {
      const close = pill.createEl('button', { cls: 'atlas3d-tactical-close', text: '×', attr: { title: 'Remove measurement' } });
      close.addEventListener('pointerdown', (e) => e.stopPropagation());
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onUnpin?.(item.id);
      });
    }
    this.measurePills.push({
      el: pill,
      worldPos: new THREE.Vector3(tip[0], tip[1] + 0.35, tip[2]),
    });
  }

  // ---- LoS builder ---------------------------------------------------------------------------

  private clearLos(): void {
    for (const child of this.losGroup.children) {
      if (child instanceof THREE.Line || child instanceof THREE.Mesh) {
        if (child.geometry !== this.nodeGeom && child.geometry !== this.hitGeom && child.geometry !== this.ringLineGeom) {
          child.geometry.dispose();
        }
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
        else child.material.dispose();
      }
    }
    this.losGroup.clear();
    if (this.losPill) {
      this.losPill.el.remove();
      this.losPill = null;
    }
  }

  private buildLos(spec: LosDisplay): void {
    const overallColor = spec.status === 'clear' ? 0x22c55e : spec.status === 'partial' ? 0xfacc15 : 0xef4444;

    const addPole = (p: Vec3, color: number): void => {
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(p[0], p[1] + 0.02, p[2]),
        new THREE.Vector3(p[0], p[1] + 1.0, p[2]),
      ]);
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.75, depthTest: false }));
      line.renderOrder = 14;
      this.losGroup.add(line);

      const ring = new THREE.LineSegments(
        this.ringLineGeom,
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false }),
      );
      ring.position.set(p[0], p[1] + 0.03, p[2]);
      ring.scale.setScalar(0.36);
      ring.renderOrder = 14;
      this.losGroup.add(ring);
    };

    addPole(spec.origin, 0x38bdf8);
    addPole(spec.target, overallColor);

    for (const ray of spec.rays) {
      const startVec = new THREE.Vector3(...ray.start);
      const endVec = new THREE.Vector3(...ray.end);

      if (!ray.blocked || !ray.hitPoint) {
        const rayColor = spec.status === 'clear' ? 0x22c55e : 0xfacc15;
        const g = new THREE.BufferGeometry().setFromPoints([startVec, endVec]);
        const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: rayColor, transparent: true, opacity: 0.95, depthTest: false }));
        line.renderOrder = 15;
        this.losGroup.add(line);
      } else {
        const hitVec = new THREE.Vector3(...ray.hitPoint);
        const clearPart = new THREE.BufferGeometry().setFromPoints([startVec, hitVec]);
        const clearLine = new THREE.Line(clearPart, new THREE.LineBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.85, depthTest: false }));
        clearLine.renderOrder = 15;
        this.losGroup.add(clearLine);

        const blockedPart = new THREE.BufferGeometry().setFromPoints([hitVec, endVec]);
        const blockedLine = new THREE.Line(
          blockedPart,
          new THREE.LineDashedMaterial({ color: 0xef4444, transparent: true, opacity: 0.75, dashSize: 0.14, gapSize: 0.08, depthTest: false }),
        );
        blockedLine.computeLineDistances();
        blockedLine.renderOrder = 15;
        this.losGroup.add(blockedLine);

        const marker = new THREE.Mesh(
          this.hitGeom,
          new THREE.MeshBasicMaterial({ color: 0xef4444, depthTest: false }),
        );
        marker.position.copy(hitVec);
        marker.renderOrder = 16;
        this.losGroup.add(marker);
      }
    }

    const pill = this.labelLayer.createDiv({ cls: `atlas3d-tactical-pill atlas3d-los-pill is-${spec.status}` });
    pill.createSpan({ cls: 'atlas3d-tactical-main', text: spec.label });
    if (spec.locked) pill.createSpan({ cls: 'atlas3d-tactical-sub', text: 'Locked (click to reset)' });
    this.losPill = {
      el: pill,
      worldPos: new THREE.Vector3(spec.target[0], spec.target[1] + 1.28, spec.target[2]),
    };
  }
}