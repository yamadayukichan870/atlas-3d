import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export type CameraKind = 'ortho' | 'persp';
export type ViewPreset = 'iso' | 'top';
export type PanDirection = 'up' | 'down' | 'left' | 'right';

interface ThetaAnim {
  startTime: number;
  duration: number;
  fromTheta: number;
  toTheta: number;
  currentTheta: number;
}

interface FocusAnim {
  startTime: number;
  duration: number;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
}

const DEG = Math.PI / 180;
const ROTATE_DURATION_MS = 220;
const FOCUS_DURATION_MS = 260;

/**
 * Tactical camera rig (Ortho/Persp + OrbitControls + smooth relative 90° turns, WASD pan and focus).
 */
export class CameraController {
  readonly ortho = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 2000);
  readonly persp = new THREE.PerspectiveCamera(32, 1, 0.1, 2000);
  camera: THREE.OrthographicCamera | THREE.PerspectiveCamera = this.ortho;
  readonly controls: OrbitControls;

  private frustumHalf = 10;
  private aspect = 1;
  private thetaAnim: ThetaAnim | null = null;
  private focusAnim: FocusAnim | null = null;
  private readonly panKeys = new Set<PanDirection>();
  private lastPanTime = 0;
  private suppressChange = false;

  constructor(canvas: HTMLCanvasElement, private readonly onInvalidate: () => void) {
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false;
    this.controls.zoomToCursor = true;
    this.controls.minPolarAngle = 0.1 * DEG;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    this.controls.addEventListener('change', () => {
      if (!this.suppressChange) this.onInvalidate();
    });
    this.controls.addEventListener('start', () => {
      this.thetaAnim = null;
      this.focusAnim = null;
    });
  }

  get polarAngle(): number {
    return this.controls.getPolarAngle();
  }

  setOrbitEnabledButtons(orbitMode: boolean): void {
    const { MOUSE } = THREE;
    this.controls.mouseButtons = orbitMode
      ? { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN }
      : { LEFT: null as unknown as THREE.MOUSE, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.ROTATE };
  }

  setKind(kind: CameraKind): void {
    const next = kind === 'ortho' ? this.ortho : this.persp;
    if (next === this.camera) return;
    next.position.copy(this.camera.position);
    next.quaternion.copy(this.camera.quaternion);
    this.camera = next;
    this.controls.object = next;
    this.updateProjection();
    this.onInvalidate();
  }

  setBounds(frustumHalf: number): void {
    this.frustumHalf = frustumHalf;
    this.updateProjection();
  }

  resize(width: number, height: number): void {
    if (width === 0 || height === 0) return;
    this.aspect = width / height;
    this.updateProjection();
    this.onInvalidate();
  }

  applyPreset(preset: ViewPreset, center: THREE.Vector3): void {
    this.thetaAnim = null;
    this.focusAnim = null;
    const polar = (preset === 'top' ? 0.1 : 55) * DEG;
    const azimuth = (preset === 'top' ? 0 : 45) * DEG;
    const radius = this.frustumHalf * 3 + 20;
    this.camera.position.set(
      center.x + radius * Math.sin(polar) * Math.sin(azimuth),
      radius * Math.cos(polar),
      center.z + radius * Math.sin(polar) * Math.cos(azimuth),
    );
    this.camera.zoom = 1;
    this.controls.target.copy(center);
    this.controls.update();
    this.updateProjection();
    this.onInvalidate();
  }

  /** Smoothly rotates azimuth relative to the current camera angle, preserving pitch, distance and zoom. */
  rotateRelative(deltaDeg: number): void {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const fromTheta = this.thetaAnim
      ? this.thetaAnim.currentTheta
      : new THREE.Spherical().setFromVector3(offset).theta;
    const toTheta = (this.thetaAnim ? this.thetaAnim.toTheta : fromTheta) + deltaDeg * DEG;
    this.thetaAnim = {
      startTime: performance.now(),
      duration: ROTATE_DURATION_MS,
      fromTheta,
      toTheta,
      currentTheta: fromTheta,
    };
    this.onInvalidate();
  }

  /** Smoothly slides the camera pivot to `point` while keeping azimuth, pitch, distance and zoom unchanged. */
  focusOnPoint(point: THREE.Vector3): void {
    if (this.controls.target.distanceToSquared(point) < 1e-6) {
      this.focusAnim = null;
      return;
    }
    this.focusAnim = {
      startTime: performance.now(),
      duration: FOCUS_DURATION_MS,
      fromTarget: this.controls.target.clone(),
      toTarget: point.clone(),
    };
    this.onInvalidate();
  }

  setPanKey(dir: PanDirection, active: boolean): void {
    if (active) {
      if (this.panKeys.has(dir)) return;
      this.panKeys.add(dir);
      this.focusAnim = null;
      if (this.lastPanTime === 0) this.lastPanTime = performance.now();
      this.onInvalidate();
    } else {
      this.panKeys.delete(dir);
      if (this.panKeys.size === 0) this.lastPanTime = 0;
    }
  }

  clearPanKeys(): void {
    this.panKeys.clear();
    this.lastPanTime = 0;
  }

  /** Advances active camera tweens / WASD pan. Returns true if another frame must be scheduled. */
  stepMotion(): boolean {
    const now = performance.now();
    let active = false;
    let changed = false;

    if (this.focusAnim) {
      const t = Math.min(1, Math.max(0, (now - this.focusAnim.startTime) / this.focusAnim.duration));
      const ease = 1 - (1 - t) ** 3;
      const nextTarget = new THREE.Vector3().lerpVectors(this.focusAnim.fromTarget, this.focusAnim.toTarget, ease);
      const delta = nextTarget.clone().sub(this.controls.target);
      this.controls.target.copy(nextTarget);
      this.camera.position.add(delta);
      changed = true;
      if (t >= 1) this.focusAnim = null;
      else active = true;
    }

    if (this.panKeys.size > 0) {
      const dt = this.lastPanTime > 0 ? Math.min(0.05, Math.max(0.001, (now - this.lastPanTime) / 1000)) : 1 / 60;
      this.lastPanTime = now;
      const move = this.computePanStep(dt);
      if (move.lengthSq() > 0) {
        this.controls.target.add(move);
        this.camera.position.add(move);
        changed = true;
      }
      active = true;
    } else {
      this.lastPanTime = 0;
    }

    if (this.thetaAnim) {
      const t = Math.min(1, Math.max(0, (now - this.thetaAnim.startTime) / this.thetaAnim.duration));
      const ease = 1 - (1 - t) ** 3;
      const nextTheta = this.thetaAnim.fromTheta + (this.thetaAnim.toTheta - this.thetaAnim.fromTheta) * ease;
      this.thetaAnim.currentTheta = nextTheta;

      const offset = this.camera.position.clone().sub(this.controls.target);
      const spherical = new THREE.Spherical().setFromVector3(offset);
      spherical.theta = nextTheta;
      spherical.phi = Math.max(this.controls.minPolarAngle, Math.min(this.controls.maxPolarAngle, spherical.phi));
      offset.setFromSpherical(spherical);
      this.camera.position.copy(this.controls.target).add(offset);
      changed = true;
      if (t >= 1) this.thetaAnim = null;
      else active = true;
    }

    if (changed) {
      this.suppressChange = true;
      this.controls.update();
      this.suppressChange = false;
    }
    return active;
  }

  dispose(): void {
    this.controls.dispose();
  }

  private updateProjection(): void {
    this.ortho.left = -this.frustumHalf * this.aspect;
    this.ortho.right = this.frustumHalf * this.aspect;
    this.ortho.top = this.frustumHalf;
    this.ortho.bottom = -this.frustumHalf;
    this.persp.aspect = this.aspect;
    this.ortho.updateProjectionMatrix();
    this.persp.updateProjectionMatrix();
  }

  private computePanStep(dt: number): THREE.Vector3 {
    const mx = (this.panKeys.has('right') ? 1 : 0) - (this.panKeys.has('left') ? 1 : 0);
    const mz = (this.panKeys.has('up') ? 1 : 0) - (this.panKeys.has('down') ? 1 : 0);
    if (mx === 0 && mz === 0) return new THREE.Vector3();

    this.camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    right.y = 0;
    if (right.lengthSq() > 1e-6) right.normalize();
    else right.set(1, 0, 0);

    const forward = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 2).negate();
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) {
      forward.setFromMatrixColumn(this.camera.matrixWorld, 1);
      forward.y = 0;
    }
    if (forward.lengthSq() > 1e-6) forward.normalize();
    else forward.set(0, 0, -1);

    const dir = new THREE.Vector3().addScaledVector(right, mx).addScaledVector(forward, mz).normalize();
    const visibleHalf = this.camera === this.ortho
      ? this.frustumHalf / Math.max(0.05, this.ortho.zoom)
      : this.camera.position.distanceTo(this.controls.target) * Math.tan((this.persp.fov * DEG) / 2) / Math.max(0.05, this.persp.zoom);
    const speed = Math.max(2, visibleHalf * 1.35);
    return dir.multiplyScalar(speed * dt);
  }
}