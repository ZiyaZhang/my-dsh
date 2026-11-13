import { build } from 'esbuild';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Every relative path below is anchored to the repository root, so the script behaves the same from any directory.
const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);

await rm('dist', { recursive: true, force: true });
await mkdir('dist/host', { recursive: true });
// The Host plugin, and the my-dsh preset's own row, which the preset loads as `dsh-my-dsh/tools`.
await build({
  absWorkingDir: root, entryPoints: { index: 'src/host/index.ts', tools: 'src/host/tools.ts' }, outdir: 'dist/host',
  bundle: true, packages: 'external', platform: 'node', target: 'node22', format: 'esm', sourcemap: true,
});
const client = await build({
  absWorkingDir: root, entryPoints: ['src/client/index.tsx'], bundle: true, write: false,
  platform: 'browser', target: 'es2022', format: 'cjs', jsx: 'automatic',
  // DSH serves these from its own module table when it loads the bundle.
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives'],
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text', '.svg': 'dataurl', '.woff2': 'dataurl' }, minify: true,
});
await writeFile('dist/client.js', `window.__ModuleLoader__.load({id:"dsh-my-dsh",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`);
// The banner's font ships inside client.js; its licence ships beside it.
await copyFile('src/client/art/OFL-InstrumentSerif.txt', 'dist/OFL-InstrumentSerif.txt');
execFileSync('node', ['node_modules/typescript/bin/tsc', '--declaration', '--emitDeclarationOnly', '--outDir', 'dist/types', '--rootDir', 'src', '--project', 'tsconfig.build.json'], { stdio: 'inherit' });
