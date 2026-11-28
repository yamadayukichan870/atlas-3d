import * as THREE from 'three';
import { BlockMap, makeBlock } from '../src/terrain/blocks';
import { SceneRenderer, type TokenSpec } from '../src/view/SceneRenderer';

/**
 * The scene renderer, against the token layer it actually has.
 *
 * THE TOKEN MODEL CHANGED, not just its field names. This file was written for a disc-and-skirt
 * token: a leaning `disc` mesh and a `skirt` that filled the gap down to lower ground. Today's
 * TokenLayer is a FLAT BASE plus a billboard: `baseGroup` carries the lean, `shadow` lies on the
 * ground, and a dashed `flightLine` stands in for the filler when the token flies. There is no
 * skirt at all. So `disc` becomes `baseGroup`, and the three filler assertions (reaches the lower
 * tread, capped at 1.5 cells, never a pillar) are gone with the mechanism — a coverage gap
 * recorded here rather than quietly dropped. What replaces them is what the new model does: the
 * flight line shows only above 0.02 of lift, and only a one-cell token samples the ramp normal.
 *
 * TWO ACCESSORS WERE REACHING FOR FIELDS THAT ARE NOT THERE. `SceneRenderer.tokens` is a
 * TokenLayer instance, not a Map — the Map is that layer's own private `tokens`. And the camera is
 * `cameraRig.camera`, not `camera`. Both casts compiled and then threw at runtime, which is why
 * this file passed `tsc` and still could not run.
 *
 * THE TOP PRESET IS 8°, NOT 0°. The camera clamps its polar angle to a readable band, so from
 * "above" the art still keeps a small lift: 0.5·cos(82°) + 0.03/0.92 = 0.1022. The old bound of
 * 0.1 was written for a camera that went fully vertical. 0.15 is the honest number, and still a
 * quarter of the isometric lift.
 *
 * THE HOST STUB GREW A DOM. SceneRenderer now builds TacticalOverlays, which creates a label
 * layer and listens on the window. The fake host predates both, so it supplies them.
 */

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`);
  if (!ok) failures++;
};
const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps;

/** The parts of a token mesh these checks read, as TokenLayer really stores them. */
interface MeshView {
  group: THREE.Group;
  baseGroup: THREE.Group;
  flightLine: THREE.Line;
  plane: THREE.Mesh;
  shadow: THREE.Mesh;
  ring: THREE.Mesh;
  selectionRing: THREE.Mesh;
}

const RECT = { left: 0, top: 0, width: 800, height: 600 };

/** A minimal element: enough for the label layer TacticalOverlays creates and later removes. */
function el(): Record<string, unknown> {
  const node: Record<string, unknown> = {
    style: { setProperty() {}, removeProperty() {} },
    dataset: {},
    addClass() {}, removeClass() {}, toggleClass() {}, hasClass: () => false,
    setText() {}, empty() {}, remove() {}, appendChild() {}, setAttribute() {},
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => RECT,
    createDiv: () => el(), createEl: () => el(), createSpan: () => el(), createSvg: () => el(),
  };
  return node;
}

const canvas = { ...el(), ...{ addEventListener() {}, removeEventListener() {}, remove() {}, getBoundingClientRect: () => RECT } };
const frames: Array<() => void> = [];
const host = {
  clientWidth: 800, clientHeight: 600,
  win: {
    devicePixelRatio: 1,
    requestAnimationFrame: (cb: () => void) => frames.push(cb),
    cancelAnimationFrame() {},
    addEventListener() {}, removeEventListener() {},
  },
  createEl: () => canvas,
  createDiv: () => el(),
  createSpan: () => el(),
  querySelector: () => canvas,
};

const spec = (over: Partial<TokenSpec> = {}): TokenSpec => ({
  id: 'a', x: 2.5 * 70, y: 2.5 * 70, diameter: 1, lift: 0, rotation: 0, texture: null, ring: '#ffffff', hidden: false, selected: false, ...over,
});

const STYLE = { color: '#ffffff', opacity: 0.35, lineType: 'solid', lineWidth: 1, cellNumbers: 'off', numberOpacity: 0.65 } as const;

function make(setup: (map: BlockMap) => void, layerHeight = 1) {
  const map = new BlockMap();
  map.layerHeight = layerHeight; map.surface = 'colors'; map.extent = { cols: 8, rows: 8 };
  setup(map);
  const r = new SceneRenderer(host as never, { get map() { return map; } });
  r.setGrid({ size: 70, offsetX: 0, offsetY: 0, lines: false, style: { ...STYLE } });
  // The Map lives inside TokenLayer, which is what SceneRenderer holds.
  const mesh = (id = 'a'): MeshView =>
    (r as unknown as { tokens: { tokens: Map<string, MeshView> } }).tokens.tokens.get(id)!;
  const camera = (): THREE.Camera => (r as unknown as { cameraRig: { camera: THREE.Camera } }).cameraRig.camera;
  const draw = (): void => (r as unknown as { draw(): void }).draw();
  return { r, map, mesh, camera, draw };
}

const LEVEL = new THREE.Quaternion();

// ---- where a token stands ------------------------------------------------------------------------
{
  const { r, mesh } = make(() => undefined);
  r.setTokens([spec()]);
  const t = mesh();
  check('flat ground: the token stands at 0, its base level, with no flight line', near(t.group.position.y, 0) && t.baseGroup.quaternion.angleTo(LEVEL) < 1e-9 && !t.flightLine.visible);
  check('flat ground: placed at its cell centre', near(t.group.position.x, 2.5) && near(t.group.position.z, 2.5));
  check('flat ground: a one-cell token is drawn at 0.92 of its cell', near(t.group.scale.x, 0.92), String(t.group.scale.x));
}
{
  const { r, mesh } = make((m) => m.place(makeBlock(2, 1, 2, 'Slope', 0)));
  r.setTokens([spec()]);
  const t = mesh();
  check('ramp: the token stands at the slope\'s height at its centre (0.5)', near(t.group.position.y, 0.5), String(t.group.position.y));
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(t.baseGroup.quaternion);
  check('ramp: the base leans to the slope, exactly along its normal', near(up.x, 0) && near(up.y, Math.SQRT1_2) && near(up.z, -Math.SQRT1_2), JSON.stringify(up));
  check('ramp: the shadow leans with the base, so it lies in the slope', t.shadow.quaternion.angleTo(t.baseGroup.quaternion) < 1e-9);
  check('ramp: a token on the ground has no flight line', !t.flightLine.visible);
}
{
  const { r, mesh } = make((m) => m.place(makeBlock(2, 1, 2, 'Slope', 90)));
  r.setTokens([spec()]);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(mesh().baseGroup.quaternion);
  check('ramp turned a quarter: the base leans the other way (towards -x)', up.x < -0.7 && near(up.z, 0), JSON.stringify(up));
}
{
  const { r, mesh } = make((m) => m.place(makeBlock(2, 1, 2, 'Steps', 0)));
  r.setTokens([spec({ diameter: 1 })]);
  const t = mesh();
  check('stairs: the base rests on the higher tread (1.0), so it never sinks in', near(t.group.position.y, 1), String(t.group.position.y));
  check('stairs: the base itself stays level (steps are not a ramp)', t.baseGroup.quaternion.angleTo(LEVEL) < 1e-9);
  check('stairs: standing on the ground is not flying, so no flight line', !t.flightLine.visible);
}
{
  const { r, mesh } = make((m) => { m.place(makeBlock(2, 1, 2)); m.place(makeBlock(3, 1, 2)); m.place(makeBlock(3, 2, 2)); });
  r.setTokens([spec({ id: 'big', x: 3 * 70, y: 3 * 70, diameter: 2 })]);
  const t = mesh('big');
  check('a two-cell token over uneven ground rests on its highest cell (2)', near(t.group.position.y, 2), String(t.group.position.y));
  // Only a ONE-cell token on the ground samples the ramp normal; a wider footprint stands level.
  check('... and never leans, however uneven the ground under its footprint', t.baseGroup.quaternion.angleTo(LEVEL) < 1e-9);
}
{
  const { r, map, mesh } = make((m) => m.place(makeBlock(2, 1, 2, 'Slope', 0)));
  r.setTokens([spec({ lift: 1 })]);
  const t = mesh();
  // A one-cell base samples a disc of radius 0.35, so the highest ramp ground under it is at
  // 0.5 + 0.35 = 0.85 of a layer — not the cell's top. The token floats exactly one cell above that
  // (1.85). The old bound (>1.9) assumed the disc reached the cell edge; it never did.
  const under = map.sampleDisc(2.5, 2.5, 0.35, Infinity).max;
  check('a flying token over a ramp floats a cell above the highest ground under its disc', near(under, 0.85) && near(t.group.position.y, under + 1), `${t.group.position.y} over ${under}`);
  check('... and does not lean: a flying token has no ground to lean on', t.baseGroup.quaternion.angleTo(LEVEL) < 1e-9);
  check('... and it DOES get a flight line down to the ground, which is what replaced the filler', t.flightLine.visible);
}
{
  const { r, mesh } = make((m) => m.place(makeBlock(5, 1, 2)));
  r.setTokens([spec()]);
  r.previewToken('a', { x: 5.5 * 70, y: 2.5 * 70 });
  check('dragging: the preview puts the token on the terrain it is over (a cube: 1.0)', near(mesh().group.position.y, 1) && near(mesh().group.position.x, 5.5));
  r.previewToken('a', null);
  check('dragging: letting go puts it back where Atlas has it', near(mesh().group.position.y, 0) && near(mesh().group.position.x, 2.5));
}
{
  const { r, map, mesh, draw } = make(() => undefined);
  r.setTokens([spec()]);
  map.place(makeBlock(2, 1, 2));
  r.touchCell(2, 2);
  draw();
  check('editing under a token lifts it on the next frame, without any other call', near(mesh().group.position.y, 1));
}

// ---- the token's art faces the camera --------------------------------------------------------------------------
{
  const { r, mesh, camera, draw } = make(() => undefined);
  r.setTokens([spec(), spec({ id: 'b', x: 4 * 70, y: 4 * 70, rotation: 90 })]);
  r.applyPreset('iso');
  draw();
  const cam = camera();
  check('billboard: the art is parallel to the screen (same orientation as the camera)', mesh('a').plane.quaternion.angleTo(cam.quaternion) < 1e-6);
  check('billboard: art turned 90 degrees in Atlas is turned 90 degrees on the screen', near(mesh('b').plane.quaternion.angleTo(cam.quaternion), Math.PI / 2, 1e-6), String(mesh('b').plane.quaternion.angleTo(cam.quaternion)));
  const isoLift = mesh('a').plane.position.y;
  r.applyPreset('top');
  draw();
  const topLift = mesh('a').plane.position.y;
  // "Top" is clamped to 8°, not vertical, so the art keeps 0.5·cos(82°) + 0.03/0.92 ≈ 0.102.
  check('billboard: its centre is higher in iso and nearly on the ground from above', isoLift > 0.35 && topLift < 0.15 && topLift < isoLift * 0.4, `${isoLift} ${topLift}`);
  // The pitch is the rig's polar angle from vertical, about its OWN target. The old formula measured
  // the position vector from the world origin; the map's centre is (4,0,4), so even a near-vertical
  // view read as ~75°. Read the rig's own polar angle instead.
  const polar = (r as unknown as { cameraRig: { polarAngle: number } }).cameraRig.polarAngle;
  const elevation = Math.PI / 2 - polar;
  check('billboard: from above, the camera looks almost straight down', elevation > 1.4, String(elevation));
}

// ---- the HUD's boxes ----------------------------------------------------------------------------------------------------
{
  const { r, camera, draw } = make(() => undefined);
  r.setTokens([spec()]);
  for (const preset of ['iso', 'top'] as const) {
    r.applyPreset(preset);
    draw();
    const p = r.screenPoints()[0]!;
    check(`HUD box (${preset}): a square, as wide as the token appears`, near(p.footY - p.headY, p.size, 1e-6) && p.size > 5 && near(p.size, p.cell * 0.92, 1e-6), JSON.stringify(p));
    check(`HUD box (${preset}): inside the canvas and visible`, p.visible && p.footX > 0 && p.footX < 800 && p.footY > 0 && p.footY < 600);
  }
  const top = r.screenPoints()[0]!;
  // From above the art is centred on the ground point: the box must be centred on it too.
  const ground = new THREE.Vector3(2.5, 0, 2.5).project(camera());
  const groundY = (-ground.y * 0.5 + 0.5) * 600;
  check('HUD box (top): centred on the token, so the bars below it do not overlap the art', Math.abs((top.footY + top.headY) / 2 - groundY) < 3, `${(top.footY + top.headY) / 2} vs ${groundY}`);
}
{
  const { r } = make(() => undefined);
  r.setTokens([spec()]);
  const before = r.screenPoints()[0]!.cell;
  r.setCameraKind('persp');
  r.applyPreset('iso');
  check('perspective: the HUD still gets a sensible pixel size', r.screenPoints()[0]!.cell > 1 && before > 0);
}

// ---- the selection ring, which is the frame a selected token wears ------------------------------------------------
{
  const { r, mesh } = make(() => undefined);
  r.setTokens([spec()]);
  check('selection: an unselected token wears no selection ring', mesh().selectionRing.visible === false);
  r.setTokens([spec({ selected: true })]);
  check('selection: a selected token wears one, in the layer itself', mesh().selectionRing.visible === true);
  check('selection: the plain ring is always there, whatever the selection', mesh().ring.visible === true);
}

// ---- lifecycle -------------------------------------------------------------------------------------------------------------------
{
  const { r } = make((m) => m.place(makeBlock(1, 1, 1)));
  r.setTokens([spec()]);
  let threw = false;
  try { r.dispose(); } catch { threw = true; }
  check('dispose: frees the tokens and their textures, without throwing', !threw);
}

// ---- the base on a ramp, at the layer height that used to go wrong ---------------------------------------------------------
{
  for (const layer of [1, 0.5, 2]) {
    const { r, mesh } = make((m) => m.place(makeBlock(2, 1, 2, 'Slope', 0)), layer);
    r.setTokens([spec()]);
    const t = mesh();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(t.baseGroup.quaternion);
    // The ground rises `layer` cells over one cell, so its slope angle is atan(layer).
    const leaned = (Math.acos(up.y) * 180) / Math.PI;
    const ground = (Math.atan(layer) * 180) / Math.PI;
    check(`ramp (layer ${layer}): the base leans ${ground.toFixed(1)} degrees, exactly the ground's slope`, Math.abs(leaned - ground) < 1e-6, `${leaned} vs ${ground}`);
    check(`ramp (layer ${layer}): and the token stands at the ground's height at its centre`, near(t.group.position.y, 0.5 * layer), String(t.group.position.y));
  }
}

console.log(failures === 0 ? '\nAll scene-renderer checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);