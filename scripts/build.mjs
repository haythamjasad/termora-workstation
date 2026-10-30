import { build } from 'esbuild';
import { mkdir, copyFile, readFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
// noVNC probes H.264 support with a top-level await, which an IIFE bundle
// cannot contain. Run the probe in the background instead; the exported flag
// is a live binding, so it updates once the probe finishes.
const novncTopLevelAwait = {
  name: 'novnc-top-level-await',
  setup(context) {
    context.onLoad({ filter: /[\\/]@novnc[\\/]novnc[\\/]core[\\/]util[\\/]browser\.js$/ }, async args => {
      const source = await readFile(args.path, 'utf8');
      const original = 'supportsWebCodecsH264Decode = await _checkWebCodecsH264DecodeSupport();';
      if (!source.includes(original)) throw new Error('noVNC browser.js changed; review the top-level await patch.');
      return { contents: source.replace(original, '_checkWebCodecsH264DecodeSupport().then(value => { supportsWebCodecsH264Decode = value; });'), loader: 'js' };
    });
  },
};
await build({
  entryPoints: ['src/renderer.js'], bundle: true, outfile: 'dist/renderer.js',
  platform: 'browser', target: 'chrome140', format: 'iife',
  sourcemap: false, minify: false, legalComments: 'eof', plugins: [novncTopLevelAwait],
});
await copyFile('src/index.html', 'dist/index.html');
console.log('Built Termora renderer.');
