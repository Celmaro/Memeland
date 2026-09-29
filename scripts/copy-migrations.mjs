// Copies src/storage/migrations/*.sql into dist/storage/migrations/ so the
// versioned schema migrations are present when the app runs from compiled JS
// (`node dist/index.js`). `tsc` does not copy non-JS assets, so without this the
// migration runner would silently fall back to the compiled-in baseline.
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = path.join(root, 'src', 'storage', 'migrations');
const dest = path.join(root, 'dist', 'storage', 'migrations');

if (!existsSync(src)) {
  console.warn('[copy-migrations] source dir missing — nothing to copy.');
  process.exit(0);
}
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`[copy-migrations] copied ${src} -> ${dest}`);
