import { BLOCK_SHAPES, SHAPE_INFO, facesOf, occludes, polygonArea, quarterOf, rampNormal, scaleNormal, surfaceFraction, type BlockShape, type Dir, type Quarter, type Vec3 } from '../src/terrain/shapes';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`);
  if (!ok) failures++;
};
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const QS: Quarter[] = [0, 1, 2, 3];
const DIRS: Dir[] = [0, 1, 2, 3, 4, 5];
const NAMES = ['+x', '-x', '+y', '-y', '+z', '-z'];

// 1. Every face of every shape at every rotation winds the way its normal says (the bug in the old Slope/Steps).
for (const shape of BLOCK_SHAPES) {
  let bad = '';
  for (const q of QS) {
    for (const f of facesOf(shape, q)) {
      const v = f.verts;
      const g = cross(sub(v[1] as Vec3, v[0] as Vec3), sub(v[2] as Vec3, v[0] as Vec3));
      const len = Math.hypot(...g);
      if (dot(g, f.normal) / len < 0.999999) bad = `${shape} q${q}: geometric ${g.map((n) => +n.toFixed(2))} vs ${f.normal.map((n) => +n.toFixed(2))}`;
      if (v.length === 4) { // planar quad: the 4th vertex lies in the plane of the first three
        const off = Math.abs(dot(sub(v[3] as Vec3, v[0] as Vec3), f.normal));
        if (off > 1e-9) bad = `${shape} q${q}: non-planar quad (${off})`;
      }
      for (const p of v) if (p.some((c) => c < -1e-9 || c > 1 + 1e-9)) bad = `${shape} q${q}: vertex outside the cell`;
    }
  }
  check(`winding: ${shape} x4 rotations, all faces outward and planar`, bad === '', bad);
}

// 2. Closed shapes: the signed volume (divergence theorem) is positive and exact only if every face points out.
const VOLUME: Partial<Record<BlockShape, number>> = { Solid: 1, Slab: 0.5, Slope: 0.5, Steps: 0.75, Liquid: 0.85 };
for (const [shape, expected] of Object.entries(VOLUME) as [BlockShape, number][]) {
  let ok = true, got = 0;
  for (const q of QS) {
    let vol = 0;
    for (const f of facesOf(shape, q)) {
      for (let i = 1; i + 1 < f.verts.length; i++) vol += dot(f.verts[0] as Vec3, cross(f.verts[i] as Vec3, f.verts[i + 1] as Vec3)) / 6;
    }
    got = vol;
    if (Math.abs(vol - expected) > 1e-9) ok = false;
  }
  check(`volume: ${shape} encloses exactly ${expected} at every rotation`, ok, String(got));
}

// 3. Which boundary each face lies on, derived from geometry.
const edges = (shape: BlockShape, q: Quarter = 0): string => facesOf(shape, q).map((f) => (f.edge === null ? '·' : NAMES[f.edge])).join(' ');
check('edges: Solid lies on all six boundaries', DIRS.every((d) => facesOf('Solid', 0).some((f) => f.edge === d)));
check('edges: Slab top (half height) is inside the cell', facesOf('Slab', 0).find((f) => f.role === 'top')?.edge === null);
check('edges: Slope ramp is inside the cell', facesOf('Slope', 0).find((f) => f.normal[1] > 0 && f.normal[1] < 1)?.edge === null, edges('Slope'));
{
  const steps = facesOf('Steps', 0);
  const tops = steps.filter((f) => f.role === 'top');
  check('edges: Steps has two treads, only the upper one on the boundary', tops.length === 2 && tops.filter((f) => f.edge === 2).length === 1);
  const mid = steps.filter((f) => f.normal[2] === -1 && f.verts.every((v) => v[2] === 0.5));
  check('edges: the middle riser (z = 0.5) is inside the cell', mid.length === 1 && mid[0]?.edge === null);
}

// 4. Occlusion is computed from face areas.
const occ = (shape: BlockShape, q: Quarter = 0): string => DIRS.filter((d) => occludes(shape, q, d)).map((d) => NAMES[d]).join(' ');
check('occludes: Solid hides all six', occ('Solid') === '+x -x +y -y +z -z', occ('Solid'));
check('occludes: Slab only covers its underside', occ('Slab') === '-y', occ('Slab'));
check('occludes: Liquid hides nothing', occ('Liquid') === '', occ('Liquid'));
check('occludes: Slope covers its back wall and underside', occ('Slope') === '-y +z', occ('Slope'));
check('occludes: Steps covers its back wall and underside, not its L-shaped sides', occ('Steps') === '-y +z', occ('Steps'));
check('occludes: area of the Steps side is 0.75 (L shape), not 1', Math.abs(facesOf('Steps', 0).filter((f) => f.edge === 1).reduce((s, f) => s + polygonArea(f.verts), 0) - 0.75) < 1e-9);

// 5. Rotation matches three.js rotation.y: +90 degrees turns +z into +x.
check('rotation: Slope back wall faces +x after a quarter turn', occ('Slope', 1) === '+x -y', occ('Slope', 1));
check('rotation: ... -x after three', occ('Slope', 3) === '-x -y', occ('Slope', 3));
check('rotation: two quarter turns put the Steps back wall at -z', occ('Steps', 2) === '-y -z', occ('Steps', 2));
check('quarterOf: normalises any multiple of 90', quarterOf(0) === 0 && quarterOf(90) === 1 && quarterOf(-90) === 3 && quarterOf(450) === 1 && quarterOf(360) === 0);
check('info: every shape has info', BLOCK_SHAPES.every((s) => SHAPE_INFO[s].walk > 0 && SHAPE_INFO[s].topPlane >= SHAPE_INFO[s].walk - 0.5));


// ---- the surface the shapes expose, checked against their real faces ----------------------------------------------
{
  // For every shape, turn and sample point: surfaceFraction must equal the height of the top face over that point.
  let bad = '', checked = 0;
  const SAMPLES = [0.1, 0.3, 0.45, 0.55, 0.7, 0.9];
  for (const shape of BLOCK_SHAPES) {
    for (const q of QS) {
      const tops = facesOf(shape, q).filter((f) => f.role === 'top');
      // Sample points avoid 0.5 exactly: that is the edge between two treads, where both answers are right.
      for (const u of SAMPLES) {
        for (const v of SAMPLES) {
          const over = tops.find((f) => {
            const xs = f.verts.map((p) => p[0]), zs = f.verts.map((p) => p[2]);
            return u >= Math.min(...xs) - 1e-9 && u <= Math.max(...xs) + 1e-9 && v >= Math.min(...zs) - 1e-9 && v <= Math.max(...zs) + 1e-9;
          });
          if (!over) continue;
          // Height of the face's plane at (u, v): solve n . (p - p0) = 0 for y.
          const n = over.normal, p0 = over.verts[0] as Vec3;
          const y = p0[1] - (n[0] * (u - p0[0]) + n[2] * (v - p0[2])) / n[1];
          const got = surfaceFraction(shape, q, u, v);
          checked++;
          if (Math.abs(got - y) > 1e-9) bad = `${shape} q${q} at (${u.toFixed(1)}, ${v.toFixed(1)}): surfaceFraction ${got} vs face ${y}`;
        }
      }
    }
  }
  check(`surface: surfaceFraction matches the real top faces (${checked} points, 5 shapes x 4 turns)`, bad === '' && checked > 400, bad);
  check('surface: a ramp turned a quarter rises towards +x', Math.abs(surfaceFraction('Slope', 1, 0.75, 0.5) - 0.75) < 1e-9 && Math.abs(surfaceFraction('Slope', 1, 0.25, 0.5) - 0.25) < 1e-9);
  check('surface: ... half a turn towards -z, three quarters towards -x', Math.abs(surfaceFraction('Slope', 2, 0.5, 0.25) - 0.75) < 1e-9 && Math.abs(surfaceFraction('Slope', 3, 0.25, 0.5) - 0.75) < 1e-9);
  const n0 = rampNormal(0), n1 = rampNormal(1);
  check('ramp normal: faces up and towards -z, and turns with the block', Math.abs(n0[2] + Math.SQRT1_2) < 1e-9 && Math.abs(n1[0] + Math.SQRT1_2) < 1e-9 && Math.abs(n1[1] - Math.SQRT1_2) < 1e-9);
}

// ---- normals when a layer is not one cell tall -----------------------------------------------------------------------------
{
  const ramp = rampNormal(0);
  const full = scaleNormal(ramp, 1);
  check('scaleNormal: a full-height layer leaves the ramp at 45 degrees', Math.abs(full[1] - Math.SQRT1_2) < 1e-12 && Math.abs(full[2] + Math.SQRT1_2) < 1e-12);
  const half = scaleNormal(ramp, 0.5);
  check('scaleNormal: half-height layers give a 26.6 degree slope (normal 0, 2/sqrt5, -1/sqrt5)', Math.abs(half[1] - 2 / Math.sqrt(5)) < 1e-12 && Math.abs(half[2] + 1 / Math.sqrt(5)) < 1e-12);
  const tall = scaleNormal(ramp, 2);
  check('scaleNormal: taller layers make a steeper slope (63.4 degrees)', Math.abs(Math.atan2(-tall[2], tall[1]) - Math.atan(2)) < 1e-12);
  check('scaleNormal: the result is always a unit vector', [0.25, 0.5, 1, 2, 4].every((L) => Math.abs(Math.hypot(...scaleNormal(ramp, L)) - 1) < 1e-12));
  check('scaleNormal: flat and wall faces are unchanged at any height', [0.5, 2].every((L) => { const up = scaleNormal([0, 1, 0], L), wall = scaleNormal([1, 0, 0], L); return up[1] === 1 && wall[0] === 1 && wall[1] === 0; }));
  check('scaleNormal: a nonsense height changes nothing instead of dividing by zero', scaleNormal(ramp, 0) === ramp && scaleNormal(ramp, -1) === ramp && scaleNormal(ramp, Number.NaN) === ramp);
}
console.log(failures === 0 ? '\nAll shape checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
