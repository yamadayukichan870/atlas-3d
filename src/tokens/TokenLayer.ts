import * as THREE from 'three';
import type { BlockMap, FacingAngle } from '../terrain/blocks';
import type { Layout } from '../terrain/layout';
import { WIDGET_ICON_PATHS } from './WidgetIcons';

export interface TokenSpec {
  id: string;
  /** Centre in map pixels. */
  x: number;
  y: number;
  /** Footprint in cells. */
  diameter: number;
  /** Height above the ground under it, in cells (flying). */
  lift: number;
  /** Degrees, as Atlas turns the token's art. */
  rotation: number;
  /** Horizontal mirror (3D-only, independent from Atlas rotation). */
  flipX?: boolean;
  /** 4-way facing direction on the ground ring (independent from Atlas rotation). */
  facing?: FacingAngle;
  texture: THREE.Texture | null;
  ring: string;
  showRing?: boolean;
  hidden: boolean;
  defeated?: boolean;
  selected: boolean;
  /** Recorded floor height (world cells) when moved in 3D, so tokens under bridges stay below them. */
  floorY?: number;
}

/** Where a token's art is on screen, in CSS pixels of the canvas: its lower edge, upper edge, middle and NDC depth. */
export interface ScreenPoint {
  id: string;
  footX: number;
  footY: number;
  headY: number;
  cell: number;
  size: number;
  depth: number;
  visible: boolean;
}

export interface TokenPlacementContext {
  gridSize: number;
  layout: Layout;
  map: BlockMap;
  ceilingY: number;
}

export interface TokenDragInfo {
  x: number;
  z: number;
  groundY: number;
  lift: number;
}

interface TokenMesh {
  group: THREE.Group;
  baseGroup: THREE.Group;
  facingGroup: THREE.Group;
  shadow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  selectionRing: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  facingTip: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  flightLine: THREE.Line<THREE.BufferGeometry, THREE.LineDashedMaterial>;
  plane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  xray: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  downedEmblem: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  hiddenIcon: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  spec: TokenSpec;
  override: { x: number; y: number; ceilingY?: number } | null;
  shareOffset: { dx: number; dz: number };
}

const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);

const ATLAS_COLOR_MAP: Record<string, string> = {
  default: '#ffffff',
  blue: '#3b82f6',
  orange: '#f97316',
  red: '#ef4444',
  yellow: '#eab308',
  brown: '#78350f',
  purple: '#a855f7',
  green: '#22c55e',
  pink: '#ec4899',
  cyan: '#06b6d4',
  gray: '#6b7280',
  grey: '#6b7280',
  white: '#ffffff',
};

export function resolveRingColor(raw: string | undefined): string {
  if (!raw) return '#ffffff';
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (ATLAS_COLOR_MAP[lower]) return ATLAS_COLOR_MAP[lower]!;
  if (/^[0-9a-f]{6}$/i.test(trimmed) || /^[0-9a-f]{3}$/i.test(trimmed)) return `#${trimmed}`;
  return trimmed;
}

function applySafeColor(target: THREE.Color, value: string, fallback = '#ffffff'): void {
  try {
    target.set(value);
  } catch {
    target.set(fallback);
  }
}

function createShadowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = createEl('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const r = size / 2;
    const grad = ctx.createRadialGradient(r, r, r * 0.45, r, r, r);
    grad.addColorStop(0, 'rgba(0, 0, 0, 0.62)');
    grad.addColorStop(0.65, 'rgba(0, 0, 0, 0.44)');
    grad.addColorStop(0.88, 'rgba(0, 0, 0, 0.12)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createDownedEmblemTexture(): THREE.CanvasTexture {
  const size = 384;
  const canvas = createEl('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const centre = size / 2;
    const vignette = ctx.createRadialGradient(centre, centre, 0, centre, centre, centre);
    vignette.addColorStop(0, 'rgba(10, 5, 5, 0.45)');
    vignette.addColorStop(0.6, 'rgba(10, 5, 5, 0.2)');
    vignette.addColorStop(1, 'rgba(10, 5, 5, 0)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, size, size);

    const iconSpace = 512;
    const skullShare = 0.52;
    const scale = (size * skullShare) / iconSpace;
    ctx.save();
    ctx.translate(size / 2 - (iconSpace / 2) * scale, size / 2 - (iconSpace / 2) * scale);
    ctx.scale(scale, scale);

    const skull = new Path2D(WIDGET_ICON_PATHS.skull);
    for (const [x, y] of [[166, 256], [346, 256]] as const) {
      const ember = ctx.createRadialGradient(x, y, 0, x, y, 70);
      ember.addColorStop(0, 'rgba(230, 95, 55, 0.8)');
      ember.addColorStop(0.45, 'rgba(150, 28, 18, 0.5)');
      ember.addColorStop(1, 'rgba(120, 10, 10, 0)');
      ctx.fillStyle = ember;
      ctx.fillRect(x - 70, y - 70, 140, 140);
    }

    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
    ctx.shadowBlur = size * 0.05;
    ctx.shadowOffsetY = size * 0.015;
    ctx.lineJoin = 'round';
    ctx.lineWidth = 28;
    ctx.strokeStyle = '#120c0a';
    ctx.fillStyle = '#120c0a';
    ctx.stroke(skull);
    ctx.fill(skull);
    ctx.restore();

    const bone = ctx.createLinearGradient(0, 16, 0, iconSpace - 16);
    bone.addColorStop(0, '#d6cebd');
    bone.addColorStop(0.5, '#b3a892');
    bone.addColorStop(1, '#7c705c');
    ctx.fillStyle = bone;
    ctx.fill(skull);

    ctx.save();
    ctx.clip(skull);
    const highlight = ctx.createRadialGradient(200, 90, 0, 200, 90, 260);
    highlight.addColorStop(0, 'rgba(255, 255, 255, 0.22)');
    highlight.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = highlight;
    ctx.fillRect(0, 0, iconSpace, iconSpace);
    ctx.lineWidth = 10;
    ctx.strokeStyle = 'rgba(60, 40, 30, 0.35)';
    ctx.stroke(skull);
    ctx.restore();
    ctx.restore();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createHiddenIconTexture(): THREE.CanvasTexture {
  const size = 192;
  const canvas = createEl('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const cx = size / 2;
    const cy = size / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.44, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    ctx.save();
    const iconScale = (size * 0.5) / 24;
    ctx.translate(cx - 12 * iconScale, cy - 12 * iconScale);
    ctx.scale(iconScale, iconScale);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#ffffff';
    ctx.stroke(new Path2D('M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49'));
    ctx.stroke(new Path2D('M14.084 14.158a3 3 0 0 1-4.242-4.242'));
    ctx.stroke(new Path2D('M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143'));
    ctx.stroke(new Path2D('m2 2 20 20'));
    ctx.restore();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Triangle pointing North (-Z) with +Y upward normal. */
function createArrowGeometry(tipZ: number, baseZ: number, halfWidth: number): THREE.BufferGeometry {
  const positions = new Float32Array([
    0, 0, tipZ,
    -halfWidth, 0, baseZ,
    halfWidth, 0, baseZ,
  ]);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.computeVertexNormals();
  return geom;
}

function createXrayMaterial(ringColor: string, texture: THREE.Texture | null): THREE.ShaderMaterial {
  const color = new THREE.Color();
  applySafeColor(color, resolveRingColor(ringColor));
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: texture },
      uHasMap: { value: texture ? 1 : 0 },
      uColor: { value: color },
      uOpacity: { value: 0.42 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform float uHasMap;
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        float a = uHasMap > 0.5 ? texture2D(uMap, vUv).a : 1.0;
        if (a < 0.05) discard;
        gl_FragColor = vec4(uColor, a * uOpacity);
      }
    `,
    transparent: true,
    depthTest: true,
    depthFunc: THREE.GreaterDepth,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/**
 * Flat-base 3D token layer: crisp ground shadow, flat ring preserving Atlas `ringColor`,
 * independent 4-way facing tip, horizontal flip, Atlas rotation, Atlas downed/hidden emblems,
 * flight line, X-Ray and TileShare.
 */
export class TokenLayer {
  readonly group = new THREE.Group();

  private readonly shadowTexture = createShadowTexture();
  private readonly downedTexture = createDownedEmblemTexture();
  private readonly hiddenTexture = createHiddenIconTexture();
  private readonly planeGeometry = new THREE.PlaneGeometry(1, 1);
  private readonly emblemGeometry = new THREE.PlaneGeometry(0.82, 0.82);
  private readonly hiddenGeometry = new THREE.PlaneGeometry(0.45, 0.45);
  private readonly shadowGeometry = new THREE.PlaneGeometry(1.04, 1.04).rotateX(-Math.PI / 2);
  private readonly ringGeometry = new THREE.RingGeometry(0.43, 0.5, 48).rotateX(-Math.PI / 2);
  private readonly selectionRingGeometry = new THREE.RingGeometry(0.515, 0.56, 48).rotateX(-Math.PI / 2);
  private readonly facingGeometry = createArrowGeometry(-0.62, -0.49, 0.09);

  private readonly tokens = new Map<string, TokenMesh>();

  setTokens(specs: readonly TokenSpec[], ctx: TokenPlacementContext | null): void {
    const wanted = new Set(specs.map((spec) => spec.id));
    for (const [id, mesh] of this.tokens) {
      if (wanted.has(id)) continue;
      this.disposeTokenMesh(mesh);
      this.tokens.delete(id);
    }

    for (const spec of specs) {
      let mesh = this.tokens.get(spec.id);
      if (!mesh) {
        mesh = this.createToken(spec);
        this.tokens.set(spec.id, mesh);
        this.group.add(mesh.group);
      }
      mesh.spec = spec;
      this.applyAppearance(mesh);
    }

    this.computeTileShareOffsets(ctx);
    if (ctx) this.placeAll(ctx);
  }

  previewToken(
    id: string,
    position: { x: number; y: number } | null,
    ctx: TokenPlacementContext | null,
    ceilingY?: number,
  ): boolean {
    const mesh = this.tokens.get(id);
    if (!mesh) return false;
    mesh.override = position ? { ...position, ceilingY } : null;
    if (ctx) this.placeToken(mesh, ctx);
    return true;
  }

  placeAll(ctx: TokenPlacementContext | null): void {
    if (!ctx) return;
    for (const mesh of this.tokens.values()) this.placeToken(mesh, ctx);
  }

  updateBillboards(camera: THREE.Camera, polarAngle: number): void {
    const lift = Math.cos(Math.PI / 2 - polarAngle);
    for (const mesh of this.tokens.values()) {
      const size = mesh.group.scale.x || 1;
      const y = 0.5 * lift + 0.03 / size;
      const sx = mesh.spec.flipX ? -1 : 1;

      mesh.plane.quaternion.copy(camera.quaternion);
      if (mesh.spec.rotation) mesh.plane.rotateZ(-mesh.spec.rotation * DEG);
      mesh.plane.scale.set(sx, 1, 1);
      mesh.plane.position.y = y;

      mesh.xray.quaternion.copy(mesh.plane.quaternion);
      mesh.xray.scale.set(sx, 1, 1);
      mesh.xray.position.y = y;

      mesh.downedEmblem.quaternion.copy(camera.quaternion);
      mesh.downedEmblem.position.y = y;

      mesh.hiddenIcon.quaternion.copy(camera.quaternion);
      mesh.hiddenIcon.position.y = y;
    }
  }

  pick(raycaster: THREE.Raycaster): string | null {
    for (const hit of raycaster.intersectObjects(this.group.children, true)) {
      for (let node: THREE.Object3D | null = hit.object; node; node = node.parent) {
        if (!node.visible) break;
        const id: unknown = node.userData.tokenId;
        if (typeof id === 'string') return id;
      }
    }
    return null;
  }

  positionOf(id: string, ctx: TokenPlacementContext | null): THREE.Vector3 | null {
    const mesh = this.tokens.get(id);
    if (!mesh) return null;
    if (ctx) this.placeToken(mesh, ctx);
    return mesh.group.position.clone();
  }

  dragInfoOf(id: string, ctx: TokenPlacementContext | null): TokenDragInfo | null {
    const mesh = this.tokens.get(id);
    if (!mesh) return null;
    if (ctx) this.placeToken(mesh, ctx);
    return {
      x: mesh.group.position.x,
      z: mesh.group.position.z,
      groundY: mesh.group.position.y - mesh.spec.lift,
      lift: mesh.spec.lift,
    };
  }

  screenPoints(camera: THREE.Camera, width: number, height: number): ScreenPoint[] {
    const centre = new THREE.Vector3();
    const side = new THREE.Vector3();
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const points: ScreenPoint[] = [];
    for (const [id, mesh] of this.tokens) {
      if (!mesh.group.visible) {
        points.push({ id, footX: 0, footY: 0, headY: 0, cell: 0, size: 0, depth: 1, visible: false });
        continue;
      }
      const scale = mesh.group.scale.x || 1;
      centre.copy(mesh.group.position);
      centre.y += mesh.plane.position.y * scale;
      side.copy(centre).add(right);
      centre.project(camera);
      side.project(camera);
      const cell = Math.abs(side.x - centre.x) * 0.5 * width;
      const size = cell * scale;
      const centreY = (-centre.y * 0.5 + 0.5) * height;
      points.push({
        id,
        cell,
        size,
        depth: centre.z,
        footX: (centre.x * 0.5 + 0.5) * width,
        footY: centreY + size / 2,
        headY: centreY - size / 2,
        visible: centre.z > -1 && centre.z < 1,
      });
    }
    return points;
  }

  dispose(): void {
    for (const mesh of this.tokens.values()) this.disposeTokenMesh(mesh);
    this.tokens.clear();
    this.shadowTexture.dispose();
    this.downedTexture.dispose();
    this.hiddenTexture.dispose();
    this.planeGeometry.dispose();
    this.emblemGeometry.dispose();
    this.hiddenGeometry.dispose();
    this.shadowGeometry.dispose();
    this.ringGeometry.dispose();
    this.selectionRingGeometry.dispose();
    this.facingGeometry.dispose();
  }

  private createToken(spec: TokenSpec): TokenMesh {
    const group = new THREE.Group();
    group.userData.tokenId = spec.id;

    const shadow = new THREE.Mesh(
      this.shadowGeometry,
      new THREE.MeshBasicMaterial({ map: this.shadowTexture, transparent: true, depthWrite: false }),
    );
    shadow.renderOrder = 3;

    const flightGeom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, -1, 0),
    ]);
    const flightLine = new THREE.Line(
      flightGeom,
      new THREE.LineDashedMaterial({ color: 0xe2e8f0, transparent: true, opacity: 0.75, dashSize: 0.14, gapSize: 0.09, depthWrite: false }),
    );
    flightLine.renderOrder = 3;
    flightLine.visible = false;

    const baseGroup = new THREE.Group();
    const ring = new THREE.Mesh(
      this.ringGeometry,
      new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false }),
    );
    ring.renderOrder = 3;

    const selectionRing = new THREE.Mesh(
      this.selectionRingGeometry,
      new THREE.MeshBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
    );
    selectionRing.renderOrder = 3;
    selectionRing.visible = false;

    const facingGroup = new THREE.Group();
    const facingTip = new THREE.Mesh(
      this.facingGeometry,
      new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false }),
    );
    facingTip.renderOrder = 3;
    facingGroup.add(facingTip);

    baseGroup.add(ring, selectionRing, facingGroup);

    const xray = new THREE.Mesh(
      this.planeGeometry,
      createXrayMaterial(spec.ring, spec.texture),
    );
    xray.renderOrder = 4;

    const plane = new THREE.Mesh(
      this.planeGeometry,
      new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.02, side: THREE.DoubleSide }),
    );
    plane.renderOrder = 5;

    const downedEmblem = new THREE.Mesh(
      this.emblemGeometry,
      new THREE.MeshBasicMaterial({ map: this.downedTexture, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, side: THREE.DoubleSide }),
    );
    downedEmblem.renderOrder = 6;
    downedEmblem.visible = false;

    const hiddenIcon = new THREE.Mesh(
      this.hiddenGeometry,
      new THREE.MeshBasicMaterial({ map: this.hiddenTexture, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, side: THREE.DoubleSide }),
    );
    hiddenIcon.renderOrder = 7;
    hiddenIcon.visible = false;

    group.add(shadow, flightLine, baseGroup, xray, plane, downedEmblem, hiddenIcon);
    return {
      group,
      baseGroup,
      facingGroup,
      shadow,
      ring,
      selectionRing,
      facingTip,
      flightLine,
      plane,
      xray,
      downedEmblem,
      hiddenIcon,
      spec,
      override: null,
      shareOffset: { dx: 0, dz: 0 },
    };
  }

  private applyAppearance(mesh: TokenMesh): void {
    const { spec } = mesh;
    const defeated = spec.defeated === true;
    const baseOpacity = spec.hidden ? 0.5 : defeated ? 0.78 : 1;

    const mat = mesh.plane.material;
    mat.map = spec.texture;
    mat.color.set(defeated ? 0x75757d : (spec.texture ? 0xffffff : 0x9ca3af));
    mat.opacity = baseOpacity;
    mat.needsUpdate = true;

    mesh.downedEmblem.visible = defeated;
    mesh.hiddenIcon.visible = spec.hidden && !defeated;

    const resolvedRing = resolveRingColor(spec.ring);
    const ringColor = defeated ? '#6b7280' : resolvedRing;
    mesh.ring.visible = true;
    applySafeColor(mesh.ring.material.color, ringColor);
    mesh.ring.material.opacity = spec.hidden ? 0.45 : 0.88;

    mesh.selectionRing.visible = spec.selected;
    mesh.facingTip.visible = true;
    applySafeColor(mesh.facingTip.material.color, ringColor);
    mesh.facingTip.material.opacity = mesh.ring.material.opacity;
    mesh.facingGroup.rotation.y = -(spec.facing ?? 0) * DEG;

    const xrayUniforms = mesh.xray.material.uniforms;
    xrayUniforms.uMap!.value = spec.texture;
    xrayUniforms.uHasMap!.value = spec.texture ? 1 : 0;
    applySafeColor(xrayUniforms.uColor!.value as THREE.Color, resolvedRing);
    xrayUniforms.uOpacity!.value = spec.hidden ? 0.22 : (defeated ? 0.28 : 0.42);

    mesh.shadow.material.opacity = spec.hidden ? 0.4 : 0.92;
    mesh.group.scale.setScalar(Math.max(spec.diameter * 0.92, 0.3));
  }

  private computeTileShareOffsets(ctx: TokenPlacementContext | null): void {
    for (const mesh of this.tokens.values()) mesh.shareOffset = { dx: 0, dz: 0 };
    if (!ctx || ctx.gridSize <= 0) return;

    const buckets = new Map<string, TokenMesh[]>();
    for (const mesh of this.tokens.values()) {
      if (mesh.override) continue;
      const cx = Math.floor(mesh.spec.x / ctx.gridSize - ctx.layout.originX);
      const cz = Math.floor(mesh.spec.y / ctx.gridSize - ctx.layout.originZ);
      const bucketKey = `${cx},${cz},${Math.round(mesh.spec.lift * 2)}`;
      let list = buckets.get(bucketKey);
      if (!list) { list = []; buckets.set(bucketKey, list); }
      list.push(mesh);
    }

    for (const list of buckets.values()) {
      if (list.length <= 1) continue;
      const radius = Math.min(0.28, 0.13 + list.length * 0.03);
      for (let i = 0; i < list.length; i++) {
        const theta = (i * 2 * Math.PI) / list.length;
        list[i]!.shareOffset = { dx: Math.cos(theta) * radius, dz: Math.sin(theta) * radius };
      }
    }
  }

  private placeToken(mesh: TokenMesh, ctx: TokenPlacementContext): void {
    const { gridSize, layout, map, ceilingY } = ctx;
    if (gridSize <= 0) return;
    const spec = mesh.spec;
    const at = mesh.override ?? spec;
    const shareX = mesh.override ? 0 : mesh.shareOffset.dx;
    const shareZ = mesh.override ? 0 : mesh.shareOffset.dz;

    const realX = at.x / gridSize;
    const realZ = at.y / gridSize;
    const realGx = realX - layout.originX;
    const realGz = realZ - layout.originZ;

    const x = realX + shareX;
    const z = realZ + shareZ;
    const size = mesh.group.scale.x || 1;
    const sampleRadius = spec.diameter <= 1 ? 0.35 : Math.max(0.2, spec.diameter * 0.44);

    const fullGround = map.sampleDisc(realGx, realGz, sampleRadius, Infinity).max;
    const storedFloor = mesh.override ? mesh.override.ceilingY : spec.floorY;
    const effCeiling = Math.min(ceilingY, storedFloor ?? Infinity);

    const normal = spec.diameter <= 1 && spec.lift === 0 ? map.rampNormalAt(realGx, realGz, effCeiling) : null;
    let ground: number;
    if (normal) {
      ground = map.surfaceHeightAt(realGx, realGz, effCeiling);
      mesh.baseGroup.quaternion.setFromUnitVectors(UP, new THREE.Vector3(normal[0], normal[1], normal[2]));
      mesh.shadow.quaternion.copy(mesh.baseGroup.quaternion);
    } else {
      ground = map.sampleDisc(realGx, realGz, sampleRadius, effCeiling).max;
      mesh.baseGroup.quaternion.identity();
      mesh.shadow.quaternion.identity();
    }

    const effectiveFloor = storedFloor !== undefined ? Math.min(storedFloor, fullGround) : fullGround;
    const slicedAway = !mesh.override && Number.isFinite(ceilingY) && (
      effectiveFloor + spec.lift > ceilingY + 0.05
      || ground + spec.lift > ceilingY + 0.05
    );
    mesh.group.visible = !slicedAway;

    const liftLocal = spec.lift / size;
    mesh.baseGroup.position.y = 0.02 / size;
    mesh.shadow.position.y = (-spec.lift + 0.016) / size;

    if (spec.lift > 0.02) {
      mesh.flightLine.visible = true;
      const posAttr = mesh.flightLine.geometry.getAttribute('position') as THREE.BufferAttribute;
      posAttr.setY(1, -liftLocal);
      posAttr.needsUpdate = true;
      mesh.flightLine.computeLineDistances();
    } else {
      mesh.flightLine.visible = false;
    }

    mesh.group.position.set(x, ground + spec.lift, z);
  }

  private disposeTokenMesh(mesh: TokenMesh): void {
    this.group.remove(mesh.group);
    mesh.shadow.material.dispose();
    mesh.ring.material.dispose();
    mesh.selectionRing.material.dispose();
    mesh.facingTip.material.dispose();
    mesh.flightLine.geometry.dispose();
    mesh.flightLine.material.dispose();
    mesh.plane.material.dispose();
    mesh.xray.material.dispose();
    mesh.downedEmblem.material.dispose();
    mesh.hiddenIcon.material.dispose();
  }
}