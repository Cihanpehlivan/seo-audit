// Writes KAYNAK_KOD.md: every source file with its path, for Claude Project knowledge.
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SKIP_DIRS = new Set(['node_modules', 'crawls', '.git']);
const SKIP_FILES = new Set(['package-lock.json', 'KAYNAK_KOD.md', '.env']);
const EXT = { '.js': 'js', '.mjs': 'js', '.json': 'json', '.md': 'md', '.html': 'html', '.css': 'css', '': 'text' };

async function walk(dir, out = []) {
  for (const name of (await readdir(dir)).sort()) {
    const full = path.join(dir, name);
    if ((await stat(full)).isDirectory()) { if (!SKIP_DIRS.has(name)) await walk(full, out); }
    else if (!SKIP_FILES.has(name) && (name in { Dockerfile: 1, '.gitignore': 1, '.dockerignore': 1, '.env.example': 1 } || EXT[path.extname(name)] && path.extname(name))) out.push(full);
  }
  return out;
}

const files = await walk(ROOT);
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
let md = `# SEO Audit — kaynak kod (v${pkg.version})\n\nBu dosya \`npm run bundle\` ile üretilir. Elle düzenlemeyin.\nOluşturma: ${new Date().toISOString()} · ${files.length} dosya\n\n## Dosya listesi\n\n`;
md += files.map((f) => `- ${path.relative(ROOT, f)}`).join('\n') + '\n';
for (const f of files) {
  const rel = path.relative(ROOT, f);
  const lang = EXT[path.extname(f)] || 'text';
  const body = await readFile(f, 'utf8');
  const fence = body.includes('```') ? '````' : '```';
  md += `\n## ${rel}\n\n${fence}${lang}\n${body.replace(/\n$/, '')}\n${fence}\n`;
}
await writeFile(path.join(ROOT, 'KAYNAK_KOD.md'), md);
console.log(`KAYNAK_KOD.md yazıldı: ${files.length} dosya, ${Math.round(md.length / 1024)} KB`);
