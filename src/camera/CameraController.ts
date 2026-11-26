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

// ---- navigation belongs to the VIEW, not to a tool ---------------------------------------------
/**
 * THE LEFT BUTTON IS ALWAYS THE TOOL'S. Verified in both upstreams:
 *
 *   Atlas  `PixiAppManager.initViewport()` installs its drag plugin ONCE on the viewport —
 *          `new MouseDrag(viewport, { mouseButtons: 'right', pressDrag: true })` — with the
 *          comment "The right button pans, for a mouse alone". It does not depend on the active
 *          tool, so selecting and moving a token with the left button and navigating with the
 *          right are the SAME tool.
 *
 *   IsoCON `Viewport.cs` puts rotate on the right drag and pan on the middle, swapped by the
 *          `PanWithRight` preference; the left is free for tokens there too.
 *
 * HERE THE RIGHT BUTTON PANS, as Atlas does, so anyone coming from the 2D map navigates the 3D
 * one with the hand they already have. Rotating — which a flat map has no gesture for — goes on
 * the PRESSED WHEEL.
 *
 * THE SHIFT SWAP IS ORBITCONTROLS' OWN. Verified in three@0.180.0
 * `examples/jsm/controls/OrbitControls.js`, `onMouseDown`:
 *
 *   case MOUSE.ROTATE:
 *     if ( event.ctrlKey || event.metaKey || event.shiftKey ) { ... state = _STATE.PAN; }
 *   case MOUSE.PAN:
 *     if ( event.ctrlKey || event.metaKey || event.shiftKey ) { ... state = _STATE.ROTATE; }
 *
 * A button mapped to PAN rotates while Shift/Ctrl/Meta is held, and one mapped to ROTATE pans.
 * This file used to track Shift itself and remap the buttons on keydown — which inverted the
 * mapping A SECOND TIME: our remap said RIGHT = ROTATE, OrbitControls saw Shift and flipped it
 * back to PAN. Two swaps cancelled, and Shift+right kept panning. The fix is to map the buttons
 * ONCE, statically, and let the controls' own modifier handling do the swap:
 *
 *   right drag         -> pan    (Atlas 2D muscle memory)
 *   Shift+right drag   -> rotate (OrbitControls built-in; Ctrl/Cmd+right too)
 *   wheel-press drag   -> rotate
 *   Shift+wheel drag   -> pan    (the same built-in, the other way)
 *   left               -> the active tool, never the camera
 *
 * `setRightDragPans(false)` inverts the pair to IsoCON's default for the settings tab.
 * OrbitControls also prevents the context menu itself (`onContextMenu`), so right-drag never
 * opens one.
 */
const MIN_POLAR = 8 * DEG;
/**
 * The lowest useful look at a tactical map. The old limit was π/2 − 0.02 ≈ 88.85°, almost in the
 * ground plane: tokens read as slivers and near-coplanar surfaces fight the depth test worst.
 * IsoCON clamps its tilt to ±20° and never lets the view go edge-on or fully vertical.
 */
const MAX_POLAR = 72 * DEG;
/** IsoCON turns half a degree per pixel of drag; OrbitControls' default is twice that. */
const ROTATE_SPEED = 0.5;

// ---- zoom, with the floor lowered so any map can be seen whole ---------------------------------
/**
 * Atlas' own mechanism (`pixi/zoomRange.ts`): a fixed band, and a floor LOWERED to whatever shows
 * the whole map — `limits.minScale = Math.min(MIN_ZOOM, fitScale)` — so a map of any size can be
 * zoomed out to whole with the wheel. A fixed band alone cannot promise that on a large map.
 *
 * Atlas' numbers (0.1 … 5) are pixi-viewport scale, world pixels to screen. Ours are ortho `zoom`
 * over a frustum already sized from the map, a different unit — so the band below is ours and the
 * MECHANISM is theirs.
 */
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
/** Persp distance band, as multiples of the map's own half-span. */
const MIN_DISTANCE_SHARE = 0.35;
const MAX_DISTANCE_SHARE = 6;
const MIN_DISTANCE_FLOOR = 4;
const MAX_DISTANCE_PAD = 40;

// ---- the clipping range, fitted to where the camera actually is --------------------------------
/**
 * A fixed 0.1…2000 spends almost all its depth resolution on empty space in front of the map.
 * The step of a perspective depth buffer is about z²/(near·2²⁴): at the distance `applyPreset`
 * chooses (~110 units on a 40-cell map) that was 7.2·10⁻³, WIDER than the 0.003 gap between the
 * region's wash and its cell tint — so the two fought for the depth test in patches that moved
 * with the camera. Fitting `near` to a share of the distance keeps tens of steps between layers
 * a hair apart, at every zoom.
 */
const NEAR_SHARE = 0.05;
const NEAR_FLOOR = 0.25;
const FAR_PAD = 60;

/**
 * Tactical camera rig (Ortho/Persp + OrbitControls + smooth relative 90° turns, arrow pan, focus).
 *
 * Rendering stays by invalidation: `stepMotion()` reports whether another frame is needed, and
 * damping is OFF on purpose — a damped glide would keep moving after `stepMotion` said it was done.
 */
export class CameraController {
  readonly ortho = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.25, 400);
  readonly persp = new THREE.PerspectiveCamera(32, 1, 0.25, 400);
  camera: THREE.OrthographicCamera | THREE.PerspectiveCamera = this.ortho;
  readonly controls: OrbitControls;

  private frustumHalf = 10;
  /** Half the map's own span, for the zoom floor; the frustum until the scene names it. */
  private fitHalf = 10;
  private aspect = 1;
  private thetaAnim: ThetaAnim | null = null;
  private focusAnim: FocusAnim | null = null;
  private readonly panKeys = new Set<PanDirection>();
  private lastPanTime = 0;
  private suppressChange = false;
  /** The pivot is kept on the map: panning off into empty space loses the scene. */
  private targetLimit = 40;
  /** Right PANS by default, as Atlas' own map does. True is the muscle memory people arrive with. */
  private rightPans = true;
  private readonly life = new AbortController();

  constructor(canvas: HTMLCanvasElement, private readonly onInvalidate: () => void) {
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false;
    this.controls.zoomToCursor = true;
    // Pan stays in the ground plane, as a map should; screen-space panning drifts off the floor.
    this.controls.screenSpacePanning = false;
    this.controls.rotateSpeed = ROTATE_SPEED;
    this.controls.panSpeed = 1;
    this.controls.zoomSpeed = 0.9;
    this.controls.minPolarAngle = MIN_POLAR;
    this.controls.maxPolarAngle = MAX_POLAR;
    this.applyButtons();
    this.applyLimits();

    this.controls.addEventListener('change', () => {
      this.clampTarget();
      this.updateClipping();
      if (!this.suppressChange) this.onInvalidate();
    });
    this.controls.addEventListener('start', () => {
      this.thetaAnim = null;
      this.focusAnim = null;
    });

    // The pressed wheel is the rotate gesture, and a browser's own middle-click default
    // (autoscroll on Windows, primary paste on X11) would steal it. A canvas has no use for either.
    canvas.addEventListener('mousedown', (ev) => {
      if (ev.button === 1) ev.preventDefault();
    }, { signal: this.life.signal });
  }

  get polarAngle(): number {
    return this.controls.getPolarAngle();
  }

  /**
   * Kept so the renderer's per-tool call still compiles, and deliberately IGNORES it: navigation
   * is a property of the view, the same in every tool. The left button belongs to the tool.
   */
  setOrbitEnabledButtons(_orbitMode: boolean): void {
    this.applyButtons();
  }

  /** Inverts the pair to IsoCON's default: right drags rotate, the middle pans, Shift+right pans. */
  setRightDragPans(on: boolean): void {
    if (this.rightPans === on) return;
    this.rightPans = on;
    this.applyButtons();
  }

  setKind(kind: CameraKind): void {
    const next = kind === 'ortho' ? this.ortho : this.persp;
    if (next === this.camera) return;
    next.position.copy(this.camera.position);
    next.quaternion.copy(this.camera.quaternion);
    next.zoom = this.camera.zoom;
    this.camera = next;
    this.controls.object = next;
    this.applyLimits();
    this.updateProjection();
    this.onInvalidate();
  }

  /**
   * The map's frustum half-span, and optionally half its own extent. Given the second, the zoom
   * floor is lowered to whatever shows the whole map — Atlas' `setMapZoomFloor` — so a map of any
   * size can be zoomed out to whole. Without it the frustum stands in, which already has margin.
   */
  setBounds(frustumHalf: number, fitHalf?: number): void {
    this.frustumHalf = Number.isFinite(frustumHalf) && frustumHalf > 1 ? frustumHalf : 10;
    this.fitHalf = Number.isFinite(fitHalf) && (fitHalf as number) > 0
      ? (fitHalf as number)
      : this.frustumHalf;
    this.targetLimit = this.frustumHalf * 1.5 + 8;
    this.applyLimits();
    this.updateProjection();
  }

  resize(width: number, height: number): void {
    if (width === 0 || height === 0) return;
    this.aspect = width / height;
    this.applyLimits();
    this.updateProjection();
    this.onInvalidate();
  }

  applyPreset(preset: ViewPreset, center: THREE.Vector3): void {
    this.thetaAnim = null;
    this.focusAnim = null;
    // IsoCON's own two views: iso at azimuth 315° (our 45° reads the same corner), overhead near
    // vertical. The polar angle is clamped to the band, so "top" is a readable near-top, not 0°.
    const polar = Math.max(MIN_POLAR, Math.min(MAX_POLAR, (preset === 'top' ? 8 : 55) * DEG));
    const azimuth = (preset === 'top' ? 0 : 45) * DEG;
    const radius = this.clampDistance(this.frustumHalf * 3 + 20);
    this.camera.position.set(
      center.x + radius * Math.sin(polar) * Math.sin(azimuth),
      center.y + radius * Math.cos(polar),
      center.z + radius * Math.sin(polar) * Math.cos(azimuth),
    );
    this.camera.zoom = 1;
    this.controls.target.copy(center);
    this.controls.update();
    this.updateProjection();
    this.onInvalidate();
  }

  /** Smoothly rotates azimuth relative to the current angle, preserving pitch, distance and zoom. */
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

  /** Smoothly slides the pivot to `point`, keeping azimuth, pitch, distance and zoom unchanged. */
  focusOnPoint(point: THREE.Vector3): void {
    if (this.controls.target.distanceToSquared(point) < 1e-6) {
      this.focusAnim = null;
      return;
    }
    this.focusAnim = {
      startTime: performance.now(),
      duration: FOCUS_DURATION_MS,
      fromTarget: this.controls.target.clone(),
      toTarget: this.clampedPoint(point.clone()),
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

  /** Advances camera tweens / arrow pan. Returns true if another frame must be scheduled. */
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
      spherical.phi = Math.max(MIN_POLAR, Math.min(MAX_POLAR, spherical.phi));
      offset.setFromSpherical(spherical);
      this.camera.position.copy(this.controls.target).add(offset);
      changed = true;
      if (t >= 1) this.thetaAnim = null;
      else active = true;
    }

    if (changed) {
      this.clampTarget();
      this.suppressChange = true;
      this.controls.update();
      this.suppressChange = false;
      this.updateClipping();
    }
    return active;
  }

  dispose(): void {
    this.life.abort();
    this.controls.dispose();
  }

  // ---- internals -----------------------------------------------------------------------

  /**
   * The one button mapping, for every tool, set ONCE. The left is NEVER the camera's. The
   * Shift/Ctrl/Meta swap is OrbitControls' own (see the header): remapping here on keydown as
   * well inverted it twice and cancelled it, which is why Shift+right used to keep panning.
   */
  private applyButtons(): void {
    const { MOUSE } = THREE;
    this.controls.mouseButtons = {
      LEFT: null as unknown as THREE.MOUSE,
      MIDDLE: this.rightPans ? MOUSE.ROTATE : MOUSE.PAN,
      RIGHT: this.rightPans ? MOUSE.PAN : MOUSE.ROTATE,
    };
  }

  /**
   * Zoom and distance limits, re-derived whenever the map's span or the pane's aspect changes.
   * The ortho floor is lowered to whatever shows the whole map on the narrower axis, so a large
   * map can still be zoomed out to whole — Atlas' own mechanism.
   */
  private applyLimits(): void {
    const fitZoom = this.fitHalf > 0
      ? Math.min(1, this.frustumHalf / this.fitHalf, (this.frustumHalf * this.aspect) / this.fitHalf)
      : 1;
    this.controls.minZoom = Math.min(MIN_ZOOM, fitZoom);
    this.controls.maxZoom = MAX_ZOOM;
    this.controls.minDistance = Math.max(MIN_DISTANCE_FLOOR, this.frustumHalf * MIN_DISTANCE_SHARE);
    this.controls.maxDistance = this.frustumHalf * MAX_DISTANCE_SHARE + MAX_DISTANCE_PAD;
    const lo = this.controls.minZoom;
    this.ortho.zoom = Math.max(lo, Math.min(MAX_ZOOM, this.ortho.zoom));
    this.persp.zoom = Math.max(lo, Math.min(MAX_ZOOM, this.persp.zoom));
  }

  private clampDistance(radius: number): number {
    const min = Math.max(MIN_DISTANCE_FLOOR, this.frustumHalf * MIN_DISTANCE_SHARE);
    const max = this.frustumHalf * MAX_DISTANCE_SHARE + MAX_DISTANCE_PAD;
    return Math.max(min, Math.min(max, radius));
  }

  private clampedPoint(point: THREE.Vector3): THREE.Vector3 {
    const limit = this.targetLimit;
    point.x = Math.max(-limit, Math.min(limit, point.x));
    point.z = Math.max(-limit, Math.min(limit, point.z));
    point.y = Math.max(-2, Math.min(this.frustumHalf + 8, point.y));
    return point;
  }

  /** Keeps the pivot on the map, moving the camera by the same correction so the view does not jump. */
  private clampTarget(): void {
    const before = this.controls.target.clone();
    const after = this.clampedPoint(this.controls.target.clone());
    if (before.distanceToSquared(after) < 1e-9) return;
    const delta = after.clone().sub(before);
    this.controls.target.copy(after);
    this.camera.position.add(delta);
  }

  /** The clipping range fitted to where the camera is, so depth resolution lands on the map. */
  private updateClipping(): void {
    const distance = Math.max(1, this.camera.position.distanceTo(this.controls.target));
    const extent = this.frustumHalf * 2 + 24;
    const near = Math.max(NEAR_FLOOR, distance * NEAR_SHARE);
    const far = distance + extent + FAR_PAD;
    if (Math.abs(this.ortho.near - near) > 1e-3 || Math.abs(this.ortho.far - far) > 1e-3) {
      this.ortho.near = near;
      this.ortho.far = far;
      this.ortho.updateProjectionMatrix();
    }
    if (Math.abs(this.persp.near - near) > 1e-3 || Math.abs(this.persp.far - far) > 1e-3) {
      this.persp.near = near;
      this.persp.far = far;
      this.persp.updateProjectionMatrix();
    }
  }

  private updateProjection(): void {
    this.ortho.left = -this.frustumHalf * this.aspect;
    this.ortho.right = this.frustumHalf * this.aspect;
    this.ortho.top = this.frustumHalf;
    this.ortho.bottom = -this.frustumHalf;
    this.persp.aspect = this.aspect;
    this.updateClipping();
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
      ? this.frustumHalf / Math.max(this.controls.minZoom, this.ortho.zoom)
      : this.camera.position.distanceTo(this.controls.target)
        * Math.tan((this.persp.fov * DEG) / 2) / Math.max(this.controls.minZoom, this.persp.zoom);
    const speed = Math.max(2, visibleHalf * 1.35);
    return dir.multiplyScalar(speed * dt);
  }
}