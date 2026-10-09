const esbuild = require('esbuild');
const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Prints start/end markers so the VS Code watch task knows when a build is done. */
const watchMarkers = {
  name: 'watch-markers',
  setup(build) {
    build.onStart(() => console.log('[watch] build started'));
    build.onEnd(r => {
      for (const e of r.errors) {
        console.error(`✘ [ERROR] ${e.text}`);
        if (e.location) { console.error(`    ${e.location.file}:${e.location.line}:${e.location.column}:`); }
      }
      console.log('[watch] build finished');
    });
  }
};

(async () => {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    sourcemap: !production,          // source maps → breakpoints in .ts files work
    sourcesContent: false,
    minify: production,
    external: ['vscode', 'cpu-features', '*.node'],
    logLevel: 'silent',
    plugins: [watchMarkers]
  });
  if (watch) { await ctx.watch(); }
  else { await ctx.rebuild(); await ctx.dispose(); }
})().catch(e => { console.error(e); process.exit(1); });
