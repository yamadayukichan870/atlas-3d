import * as THREE from 'three';
import { BlockMap, makeBlock } from '../src/terrain/blocks';
import { SceneRenderer, type TokenSpec } from '../src/view/SceneRenderer';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`);
  if (!ok) failures++;
};
const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps;

const canvas = { addEventListener() {}, removeEventListener() {}, remove() {}, style: {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) };
const frames: Array<() => void> = [];
const host = {
  clientWidth: 800, clientHeight: 600,
  win: { devicePixelRatio: 1, requestAnimationFrame: (cb: () => void) => frames.push(cb), cancelAnimationFrame() {} },
  createEl: () => canvas,
};
const spec = (over: Partial<TokenSpec> = {}): TokenSpec => ({
  id: 'a', x: 2.5 * 70, y: 2.5 * 70, diameter: 1, lift: 0, rotation: 0, texture: null, ring: '#ffffff', hidden: false, selected: false, ...over,
});

function make(setup: (map: BlockMap) => void, layerHeight = 1) {
  const map = new BlockMap();
  map.layerHeight = layerHeight; map.surface = 'colors'; map.extent = { cols: 8, rows: 8 };
  setup(map);
  const r = new SceneRenderer(host as never, { get map() { return map; } });
  r.setGrid({ size: 70, offsetX: 0, offsetY: 0, lines: false });
  const mesh = (id = 'a') => (r as unknown as { tokens: Map<string, { group: THREE.Group; disc: THREE.Mesh; skirt: THREE.Mesh; plane: THREE.Mesh }> }).tokens.get(id)!;
  const draw = (): void => (r as unknown as { draw(): void }).draw();
  return { r, map, mesh, draw };
}

// ---- where a token stands ------------------------------------------------------------------------
{
  const { r, mesh } = make(() => undefined);
  r.setTokens([spec()]);
  const t = mesh();
  check('flat ground: the token stands at 0, level, with no filler', near(t.group.position.y, 0) && t.disc.quaternion.angleTo(new THREE.Quaternion()) < 1e-9 && !t.skirt.visible);
  check('flat ground: placed at its cell centre', near(t.group.position.x, 2.5) && near(t.group.position.z, 2.5));
}
{
  const { r, mesh } = make((m) => m.place(makeBlock(2, 1, 2, 'Slope', 0)));
  r.setTokens([spec()]);
  const t = mesh();
  check('ramp: the token stands at the slope\'s height at its centre (0.5)', near(t.group.position.y, 0.5), String(t.group.position.y));
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(t.disc.quaternion);
  check('ramp: the base leans to the slope, exactly along its normal', near(up.x, 0) && near(up.y, Math.SQRT1_2) && near(up.z, -Math.SQRT1_2), JSON.stringify(up));
  check('ramp: no filler is needed, the base lies in the slope', !t.skirt.visible);
}
{
  const { r, mesh } = make((m) => m.place(makeBlock(2, 1, 2, 'Slope', 90)));
  r.setTokens([spec()]);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(mesh().disc.quaternion);
  check('ramp turned a quarter: the base leans the other way (towards -x)', up.x < -0.7 && near(up.z, 0), JSON.stringify(up));
}
{
  const { r, mesh } = make((m) => m.place(makeBlock(2, 1, 2, 'Steps', 0)));
  r.setTokens([spec({ diameter: 1 })]);
  const t = mesh();
  const size = t.group.scale.x;
  check('stairs: the base rests on the higher tread (1.0), so it never sinks in', near(t.group.position.y, 1), String(t.group.position.y));
  check('stairs: a filler reaches down to the lower tread (0.5), so it does not hang in the air', t.skirt.visible && near(t.skirt.scale.y * size, 0.5), `${t.skirt.visible} ${t.skirt.scale.y * size}`);
  check('stairs: the base itself stays level', t.disc.quaternion.angleTo(new THREE.Quaternion()) < 1e-9);
}
{
  const { r, mesh } = make((m) => { m.place(makeBlock(2, 1, 2)); m.place(makeBlock(3, 1, 2)); m.place(makeBlock(3, 2, 2)); });
  r.setTokens([spec({ id: 'big', x: 3 * 70, y: 3 * 70, diameter: 2 })]);
  const t = mesh('big');
  check('a two-cell token over uneven ground rests on its highest cell (2)', near(t.group.position.y, 2), String(t.group.position.y));
  // The ground under it spans 0..2, but the filler is capped (1.5): a big token must not stand on a giant pillar.
  check('... and its filler is capped at 1.5 cells rather than becoming a pillar', t.skirt.visible && near(t.skirt.scale.y * t.group.scale.x, 1.5), String(t.skirt.scale.y * t.group.scale.x));
}
{
  const { r, mesh } = make((m) => m.place(makeBlock(2, 1, 2, 'Slope', 0)));
  r.setTokens([spec({ lift: 1 })]);
  const t = mesh();
  // It floats a cell above the HIGHEST ground under its base (just under 1 on the ramp), so it never cuts into the slope.
  check('a flying token over a ramp floats a cell above the highest ground under it', t.group.position.y > 1.9 && t.group.position.y < 2, String(t.group.position.y));
  check('... and neither leans nor gets a filler', !t.skirt.visible && t.disc.quaternion.angleTo(new THREE.Quaternion()) < 1e-9);
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
  const { r, mesh, draw } = make(() => undefined);
  r.setTokens([spec(), spec({ id: 'b', x: 4 * 70, y: 4 * 70, rotation: 90 })]);
  r.applyPreset('iso');
  draw();
  const cam = (r as unknown as { camera: THREE.Camera }).camera;
  check('billboard: the art is parallel to the screen (same orientation as the camera)', mesh('a').plane.quaternion.angleTo(cam.quaternion) < 1e-6);
  check('billboard: art turned 90 degrees in Atlas is turned 90 degrees on the screen', near(mesh('b').plane.quaternion.angleTo(cam.quaternion), Math.PI / 2, 1e-6), String(mesh('b').plane.quaternion.angleTo(cam.quaternion)));
  const isoLift = mesh('a').plane.position.y;
  r.applyPreset('top');
  draw();
  const topLift = mesh('a').plane.position.y;
  check('billboard: its centre is higher in iso (half its height x cos of the elevation) and nearly on the ground from above', isoLift > 0.35 && topLift < 0.1, `${isoLift} ${topLift}`);
  const elevation = Math.PI / 2 - Math.acos(((r as unknown as { camera: THREE.Camera }).camera.position.y) / (r as unknown as { camera: THREE.Camera }).camera.position.length());
  check('billboard: from above, the camera looks almost straight down', elevation > 1.4, String(elevation));
}

// ---- the HUD's boxes ----------------------------------------------------------------------------------------------------
{
  const { r, draw } = make(() => undefined);
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
  const cam = (r as unknown as { camera: THREE.OrthographicCamera }).camera;
  const ground = new THREE.Vector3(2.5, 0, 2.5).project(cam);
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

// ---- lifecycle -------------------------------------------------------------------------------------------------------------------
{
  const { r } = make((m) => m.place(makeBlock(1, 1, 1)));
  r.setTokens([spec()]);
  let threw = false;
  try { r.dispose(); } catch { threw = true; }
  check('dispose: frees the tokens\' fillers as well, without throwing', !threw);
}


// ---- the base on a ramp, at the layer height that used to go wrong ---------------------------------------------------------
{
  for (const layer of [1, 0.5, 2]) {
    const { r, mesh } = make((m) => m.place(makeBlock(2, 1, 2, 'Slope', 0)), layer);
    r.setTokens([spec()]);
    const t = mesh();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(t.disc.quaternion);
    // The ground rises `layer` cells over one cell, so its slope angle is atan(layer).
    const leaned = (Math.acos(up.y) * 180) / Math.PI;
    const ground = (Math.atan(layer) * 180) / Math.PI;
    check(`ramp (layer ${layer}): the base leans ${ground.toFixed(1)} degrees, exactly the ground's slope`, Math.abs(leaned - ground) < 1e-6, `${leaned} vs ${ground}`);
    check(`ramp (layer ${layer}): and the token stands at the ground's height at its centre`, near(t.group.position.y, 0.5 * layer), String(t.group.position.y));
  }
}
console.log(failures === 0 ? '\nAll scene-renderer checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
