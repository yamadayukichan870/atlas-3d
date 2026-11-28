import esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// `obsidian` ships types only; some modules import normalizePath from it, so stub it for Node.
const stubObsidian = {
  name: 'stub-obsidian',
  setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export const normalizePath = (p) => p.replace(/\\/+/g, "/");',
      loader: 'js',
    }));
  },
};

// The renderer needs a GPU and a mouse; its tests swap those two parts for stand-ins and run everything else for real.
const shimThree = {
  name: 'shim-three',
  setup(build) {
    build.onResolve({ filter: /^three$/ }, () => ({ path: fileURLToPath(new URL('./shims/three.js', import.meta.url)) }));
    build.onResolve({ filter: /OrbitControls/ }, () => ({ path: fileURLToPath(new URL('./shims/OrbitControls.js', import.meta.url)) }));
  },
};

// Obsidian's element helpers are globals in the app and absent in Node. GridLayer builds its glyph
// atlas and TokenLayer its three textures AT CONSTRUCTION, all through the global createEl('canvas').
// A canvas whose 2D context is null makes every `if (ctx)` drawing block skip itself; the real
// CanvasTexture keeps the stub as its image, and nothing here samples it (the renderer is stubbed).
const domGlobals = 'globalThis.createEl = () => ({ width: 0, height: 0, style: {}, getContext: () => null });';

let failed = false;
for (const name of ['shapes', 'blocks', 'blockGeometry', 'placement', 'terrainMeshes', 'resources', 'sceneRenderer', 'internals', 'bridge']) {
  await esbuild.build({
    entryPoints: [`test/${name}.test.ts`], bundle: true, platform: 'node', format: 'cjs',
    outfile: 'test/.out.cjs',
    plugins: name === 'sceneRenderer' ? [stubObsidian, shimThree] : [stubObsidian],
    banner: name === 'sceneRenderer' ? { js: domGlobals } : undefined,
    logLevel: 'error',
  });
  console.log(`\n== ${name} ==`);
  if (spawnSync(process.execPath, ['test/.out.cjs'], { stdio: 'inherit' }).status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);