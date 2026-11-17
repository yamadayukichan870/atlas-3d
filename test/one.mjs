import esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
const name = process.argv[2];
await esbuild.build({ entryPoints: [`test/${name}.test.ts`], bundle: true, platform: 'node', format: 'cjs', outfile: 'test/.one.cjs', logLevel: 'error' });
process.exit(spawnSync(process.execPath, ['test/.one.cjs'], { stdio: 'inherit' }).status ?? 1);
