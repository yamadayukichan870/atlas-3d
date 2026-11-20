import * as THREE from 'three';
import type { VolumeSpec } from '../terrain/measureVolume';

/**
 * Draws the 3D body of a measurement as a subtle shell, from the SAME parameters that shape
 * its footprint (`terrain/measureVolume.ts`). The footprint stays the authority for coverage;
 * this is only a spatial reading, so it is drawn faint (BackSide, ~0.12) and never hides the
 * tokens standing inside it.
 *
 * BackSide shows only the far half of the surface, which is what keeps a volume with people
 * inside legible. depthWrite is off so shells never occlude each other or the terrain.
 *
 * The slice is respected with a horizontal clipping plane at `ceilingY`. For it to take effect
 * the renderer must have `localClippingEnabled = true` (a one-line addition in SceneRenderer's
 * constructor, done in the wiring pass). Without it the plane is ignored and the shell simply
 * draws whole — correct for Slice: All, the common case.
 *
 * Render order sits just above the region border (2.6) and below the ruler path (14), so a
 * shell reads over its own footprint but under paths and tokens' art.
 */
const SHELL_ORDER = 6;
const WIRE_ORDER = 7;
const SHELL_OPACITY = 0.12;
const WIRE_OPACITY = 0.3;

export interface ShellOptions {
  readonly ceilingY?: number;
  readonly opacity?: number;
  readonly wire?: boolean;
}

export interface Shell {
  readonly group: THREE.Group;
  dispose(): void;
}

/** A horizontal plane keeping everything at or below `ceilingY`. */
function ceilingPlane(ceilingY: number): THREE.Plane[] | undefined {
  if (!Number.isFinite(ceilingY)) return undefined;
  return [new THREE.Plane(new THREE.Vector3(0, -1, 0), ceilingY)];
}

/**
 * The shell of one volume, or null for a shape with no body. The caller adds `group` to the
 * scene and calls `dispose()` when the measurement is rebuilt or removed.
 */
export function buildShell(spec: VolumeSpec, color: THREE.Color, opts: ShellOptions = {}): Shell | null {
  const group = new THREE.Group();
  const geoms: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const planes = ceilingPlane(opts.ceilingY ?? Infinity);
  const opacity = opts.opacity ?? SHELL_OPACITY;

  const shellMat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, side: THREE.BackSide, depthWrite: false,
    ...(planes !== undefined && { clippingPlanes: planes }),
  });
  mats.push(shellMat);

  const add = (geom: THREE.BufferGeometry, pos: THREE.Vector3, quat?: THREE.Quaternion): void => {
    geoms.push(geom);
    const mesh = new THREE.Mesh(geom, shellMat);
    mesh.position.copy(pos);
    if (quat) mesh.quaternion.copy(quat);
    mesh.renderOrder = SHELL_ORDER;
    group.add(mesh);
    if (opts.wire !== false) {
      const eg = new THREE.EdgesGeometry(geom, 28);
      geoms.push(eg);
      const em = new THREE.LineBasicMaterial({
        color, transparent: true, opacity: WIRE_OPACITY, depthWrite: false,
        ...(planes !== undefined && { clippingPlanes: planes }),
      });
      mats.push(em);
      const wire = new THREE.LineSegments(eg, em);
      wire.position.copy(pos);
      if (quat) wire.quaternion.copy(quat);
      wire.renderOrder = WIRE_ORDER;
      group.add(wire);
    }
  };

  switch (spec.kind) {
    case 'dome': {
      // Upper half of a sphere centred at the floor: its ground cross-section is the footprint.
      const geom = new THREE.SphereGeometry(spec.radius, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
      add(geom, new THREE.Vector3(...spec.centre));
      break;
    }
    case 'cone': {
      const radius = Math.max(0.05, spec.length * Math.tan(spec.halfAngle));
      const geom = new THREE.ConeGeometry(radius, spec.length, 32, 1, false);
      geom.translate(0, -spec.length / 2, 0); // apex at origin, base along -Y
      const dir = new THREE.Vector3(spec.towards.x, 0, spec.towards.z);
      const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
      add(geom, new THREE.Vector3(...spec.apex), quat);
      break;
    }
    case 'box': {
      const geom = new THREE.BoxGeometry(spec.length, spec.height, spec.width);
      const cx = spec.origin.x + spec.towards.x * spec.length / 2;
      const cz = spec.origin.z + spec.towards.z * spec.length / 2;
      const quat = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0), -Math.atan2(spec.towards.z, spec.towards.x));
      add(geom, new THREE.Vector3(cx, spec.baseY + spec.height / 2, cz), quat);
      break;
    }
    case 'cylinder': {
      const geom = new THREE.CylinderGeometry(spec.radius, spec.radius, spec.height, 40, 1, false);
      add(geom, new THREE.Vector3(spec.centre.x, spec.baseY + spec.height / 2, spec.centre.z));
      break;
    }
  }

  return {
    group,
    dispose(): void {
      group.removeFromParent();
      for (const g of geoms) g.dispose();
      for (const m of mats) m.dispose();
      geoms.length = 0;
      mats.length = 0;
    },
  };
}