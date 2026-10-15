import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const PUBLIC_DIR = 'public';

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

/**
 * Emits `sw.js` with a precache list of every file in the build, so the app
 * works offline after the first visit (needed for a good "Add to Home Screen" experience).
 */
function serviceWorker(): Plugin {
  return {
    name: 'tinyplanet-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const hash = createHash('sha256');
      const files = new Set<string>(['./']);

      for (const [fileName, output] of Object.entries(bundle)) {
        if (fileName.endsWith('.map')) continue;
        files.add(fileName);
        hash.update(fileName);
        if (output.type === 'asset') hash.update(output.source);
        else hash.update(output.code);
      }
      for (const full of listFiles(PUBLIC_DIR)) {
        const rel = relative(PUBLIC_DIR, full).split('\\').join('/');
        files.add(rel);
        hash.update(rel);
        hash.update(readFileSync(full));
      }

      const template = readFileSync('scripts/sw-template.js', 'utf8');
      const source = template
        .replace('__VERSION__', hash.digest('hex').slice(0, 12))
        .replace('__PRECACHE__', JSON.stringify([...files], null, 2));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  // Relative base so the build works on GitHub Pages under /<repo>/ (and anywhere else).
  base: './',
  plugins: [serviceWorker()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
  worker: {
    format: 'es',
  },
  server: {
    host: true,
  },
});
