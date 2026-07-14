// Reads a workflow journal.jsonl and flattens all agent results into data/enrichment.json.
// Usage: node scripts/collect-enrichment.mjs <path-to-journal.jsonl>
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const journalPath = process.argv[2];
if (!journalPath) { console.error('need journal path'); process.exit(1); }

const lines = readFileSync(journalPath, 'utf8').split('\n').filter(Boolean);
const all = [];
for (const line of lines) {
  let obj;
  try { obj = JSON.parse(line); } catch { continue; }
  if (obj.type !== 'result') continue;
  const r = obj.result;
  const arr = r?.results ?? (Array.isArray(r) ? r : []);
  if (Array.isArray(arr)) all.push(...arr);
}
// dedupe by id (keep last-seen)
const byId = new Map();
for (const e of all) if (e && e.id) byId.set(e.id, e);

writeFileSync(join(ROOT, 'data', 'enrichment.json'),
  JSON.stringify({ results: [...byId.values()] }, null, 2) + '\n');
console.log(`enrichment.json written: ${byId.size} mountains (from ${all.length} raw entries)`);
