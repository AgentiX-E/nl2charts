import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { attachDefinitions } from '@agentix-e/nl2charts-ai';
import { buildSchema, loadDescriptions, loadTables } from '../eval/bird/data.js';

const DATA = 'eval/.cache/bird/minidev/MINIDEV';
const tables = loadTables(join(DATA, 'dev_tables.json'));
const report = JSON.parse(readFileSync('/tmp/art6/b/out/bird-eval.json', 'utf8'));
const defs = report.controls.synthesizedDefinitions as Record<string, string>;
let total = 0, attached = 0;
for (const [db, text] of Object.entries(defs)) {
  const table = tables.get(db);
  if (!table) { console.log('no schema', db); continue; }
  const bare = buildSchema(table, loadDescriptions(join(DATA, 'dev_databases', db, 'database_description'), table.tableNames), { withNotes: false });
  const r = attachDefinitions(bare, text);
  const lines = text.split('\n').filter((l) => l.trim().length > 0).length;
  total += lines; attached += r.attached;
  console.log(`${db.padEnd(24)} lines=${String(lines).padStart(3)} attached=${String(r.attached).padStart(3)} unplaced=${r.unplaced.length}`);
  for (const u of r.unplaced.slice(0, 3)) console.log('    x', u.slice(0, 80));
}
console.log(`TOTAL lines=${total} attached=${attached} rate=${(attached / total * 100).toFixed(1)}%`);
