// v0.14.0: reads the .env file of the project root. Before this version no code read it: values worked only when the
// shell exported them. Node's own reader (process.loadEnvFile, Node 20.12+) is used: no new dependency.
// A value set in the shell stays (also an empty one): tests set CLICKUP_TOKEN='' and the developer's .env cannot fill it.
// No file: nothing happens (Docker, Render). ENV_FILE: another file (tests).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv(file = process.env.ENV_FILE || path.join(ROOT, '.env')) {
  if (typeof process.loadEnvFile !== 'function') return { loaded: false, reason: 'node' };
  try {
    process.loadEnvFile(file);
    return { loaded: true };
  } catch (e) {
    if (e.code === 'ENOENT') return { loaded: false, reason: 'none' };
    // A broken file must not stop the server. The message names the file, never a value.
    console.error(`.env okunamadı (${path.basename(file)}): ${e.code || 'hata'}`);
    return { loaded: false, reason: 'error' };
  }
}
