import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { createOracle } from '../eval/bird/oracle.js';

// A real Python process, a real SQLite file, no mocks: the protocol is the
// contract, and the only way to know it holds is to speak it.
const root = mkdtempSync(join(tmpdir(), 'nl2charts-oracle-'));
mkdirSync(join(root, 'shop'), { recursive: true });
const writer = new DatabaseSync(join(root, 'shop', 'shop.sqlite'));
writer.exec(`
  create table items (id integer, name text, price real, blob_col blob);
  insert into items values (1, 'pen', 1.5, x'0a0b');
  insert into items values (2, 'cup', 3.25, null);
  insert into items values (3, 'pen', 1.5, null);
`);
writer.close();

const oracle = createOracle(resolve('eval/bird/oracle.py'), root);
afterAll(async () => {
  await oracle.close();
  rmSync(root, { recursive: true, force: true });
});

describe('SQLite execution oracle', () => {
  it('returns ordered tuples, not named rows', async () => {
    const result = await oracle.run('shop', 'select price, name from items order by id');
    expect(result.ok).toBe(true);
    expect(result.columns).toEqual(['price', 'name']);
    expect(result.rows).toEqual([
      [1.5, 'pen'],
      [3.25, 'cup'],
      [1.5, 'pen'],
    ]);
  });

  it('preserves duplicate rows and duplicate column names', async () => {
    const rows = await oracle.run('shop', 'select 1 as a, 2 as a');
    expect(rows.rows).toEqual([[1, 2]]);
    const duplicates = await oracle.run('shop', 'select name from items where name = \'pen\'');
    expect(duplicates.rows).toHaveLength(2);
  });

  it('encodes a blob so the row survives JSON', async () => {
    const [row] = (await oracle.run('shop', 'select blob_col from items where id = 1')).rows;
    expect(row?.[0]).toEqual({ $b64: 'Cgs=' });
  });

  it('reports a SQL error as data instead of crashing the process', async () => {
    const result = await oracle.run('shop', 'select missing from items');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no such column');
  });

  it('carries the name SQLite gave the failure, so a repair can act on the class', async () => {
    // `oracle.py` returns `errorName`, `run.ts` turns it into the hint a repair turn is
    // asked with, and the decoder here used to drop it — so every repair was told the code
    // was `undefined` and the branch that adds the code was unreachable in production.
    const result = await oracle.run('shop', 'select missing from items');
    expect(result.errorName).toBe('SQLITE_ERROR');
    expect(result.errorCode).toBeGreaterThan(0);
  });

  it('leaves the code absent when the failure was not SQLite that raised it', async () => {
    // A missing database fails in this client, not in SQLite: there is no name to report,
    // and a synthesised one would make a harness bug look like a query error.
    const result = await oracle.run('absent', 'select 1');
    expect(result.errorName).toBeUndefined();
    expect(result.errorCode).toBeUndefined();
  });

  it('reports a missing database as an error, not a hang', async () => {
    const result = await oracle.run('absent', 'select 1');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('database not found');
  });

  it('keeps a database usable after a failed statement', async () => {
    expect((await oracle.run('shop', 'select from')).ok).toBe(false);
    expect((await oracle.run('shop', 'select count(*) from items')).rows).toEqual([[3]]);
  });

  it('runs concurrent requests and matches each response to its request', async () => {
    const results = await Promise.all([
      oracle.run('shop', 'select 1'),
      oracle.run('shop', 'select 2'),
      oracle.run('shop', 'select 3'),
      oracle.run('shop', 'select 4'),
    ]);
    expect(results.map((result) => result.rows[0]?.[0])).toEqual([1, 2, 3, 4]);
  });
});

/**
 * A second Python process that speaks the same protocol badly.
 *
 * `oracle.py` is one implementation of the wire format, not the format itself, and the
 * client's job on this side is to survive a peer that is noisier than the one we ship: a
 * banner line, a response for a request nobody made, a response with no timing. Each of
 * those is a branch in the decoder, and none of them can be reached through the script in
 * `eval/` because it never does any of it. So the fixture is a real peer, not a stub.
 */
const awkward = `
import json, sys

# A pipe is block-buffered: without the flush the client waits for an answer that the
# interpreter is holding in a buffer, which looks exactly like a hang.
print("", flush=True)
print(json.dumps({"id": "not-a-request", "ok": True, "rows": []}), flush=True)
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    print(json.dumps({"id": request["id"], "ok": True, "rows": [[request["sql"]]]}), flush=True)
`;

describe('the protocol client against a noisy peer', () => {
  it('ignores a banner line, a response for no request, and a missing timing', async () => {
    const script = join(root, 'awkward_oracle.py');
    writeFileSync(script, awkward);
    const peer = createOracle(script, root);
    try {
      const result = await peer.run('shop', 'select 1');
      expect(result.rows).toEqual([['select 1']]);
      // The peer sent neither `ms` nor `columns`: the decoder fills both, so a caller never
      // has to check for them before doing arithmetic on a duration.
      expect(result.ms).toBe(0);
      expect(result.columns).toEqual([]);
    } finally {
      await peer.close();
    }
  });

  it('rejects a request made after close instead of writing to a dead pipe', async () => {
    const peer = createOracle(resolve('eval/bird/oracle.py'), root);
    await peer.close();
    await expect(peer.run('shop', 'select 1')).rejects.toThrow(/oracle is closed/);
  });

  it('closes twice without waiting for an exit that already happened', async () => {
    const peer = createOracle(resolve('eval/bird/oracle.py'), root);
    await peer.close();
    await expect(peer.close()).resolves.toBeUndefined();
  });

  it('answers a request that was in flight when the input closed, instead of hanging', async () => {
    const peer = createOracle(resolve('eval/bird/oracle.py'), root);
    // `close()` ends stdin, which the process sees only after it has answered everything it
    // already read. A client that resolved `close()` by racing the answers would leave this
    // promise pending forever, and a benchmark that hangs is indistinguishable from one
    // that is slow.
    const inFlight = peer.run('shop', 'select count(*) from items');
    await peer.close();
    await expect(inFlight).resolves.toMatchObject({ ok: true, rows: [[3]] });
  });
});
