import { fileURLToPath } from 'node:url';

export const name = 'live';

/** Absolute path to the static /live assets (index.html + live.js). The api serves this directory at /live. */
export function livePublicDir(): string {
  return fileURLToPath(new URL('../public/', import.meta.url));
}
