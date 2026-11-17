#!/usr/bin/env node
/**
 * Bring the two database servers up, so that the connector suites stop skipping.
 *
 * Thirty-three tests in this repository are written against real servers: the PostgreSQL and
 * MySQL connector integration suites, and the two leak-audit and two runbook tests that need a
 * URL to point at. Without `PG_TEST_URL` and `MYSQL_TEST_URL` they *skip*, which is a deliberate
 * design — a laptop without a database still covers every contract — but a skipped test is also
 * a test whose coverage was never measured, and `packages/node` reports 65.78% of lines instead
 * of 99.62% when they are gone. That gap is a measurement of the environment, not of the code,
 * and it took a round of reading the wrong number to learn the difference.
 *
 *   node tools/local-db.mjs            # what is up, what is down, and the two exports
 *   node tools/local-db.mjs --start    # start what is down, then print the same report
 *   node tools/local-db.mjs --self-test
 *
 * Starting a server is an operating-system question, so the answer is a command per platform
 * rather than a guess: Debian/Ubuntu runs `service <name> start`, and anything else gets the
 * command a reader can paste instead of a failure that names only our own assumption.
 */
import { spawnSync } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { pathToFileURL } from 'node:url';

const HOST = '127.0.0.1';
const PROBE_TIMEOUT_MS = 500;

/**
 * The two servers, the variables that name them, and what their absence costs.
 *
 * `suites` is what the report points at when a server is down: naming the file is what turns
 * "33 skipped" into an address. `service` is the Debian/Ubuntu unit; `manual` is the same
 * instruction for a machine that has no `service` command.
 */
export const SERVERS = [
  {
    name: 'postgresql',
    port: 5432,
    env: 'PG_TEST_URL',
    url: 'postgres://postgres:postgres@127.0.0.1:5432/nl2charts_test',
    suites: ['packages/node/test/postgres.test.ts', 'test/leak-audit.test.ts', 'test/runbooks.test.ts'],
    manual: 'pg_ctl -D /var/lib/postgresql/16/main -o \'-k /tmp -p 5432 -h 127.0.0.1\' -w start',
  },
  {
    name: 'mariadb',
    port: 3306,
    env: 'MYSQL_TEST_URL',
    url: 'mysql://analyst:s3cret@127.0.0.1:3306/nl2charts_test',
    suites: ['packages/node/test/mysql.test.ts', 'test/leak-audit.test.ts', 'test/runbooks.test.ts'],
    manual: 'mariadbd --user=mysql --datadir=/var/lib/mysql --socket=/tmp/mysql.sock --port=3306 --bind-address=127.0.0.1',
  },
];

/**
 * Whether something is listening on a port.
 *
 * A TCP connect is the weakest claim that is still true: it does not say the server accepts our
 * credentials, only that a process is there. The distinction matters because the two failures
 * have different repairs, and the report below names the repair it can see.
 */
export function reachable(port, host = HOST, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const settle = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

/** The report: one line per server, then the exports, then what a down server still hides. */
export function report(servers, up) {
  const lines = servers.map((server) => {
    const state = up[server.name] === true ? 'up  ' : 'down';
    return `${server.name.padEnd(10)} ${HOST}:${server.port}  ${state}`;
  });
  const down = servers.filter((server) => up[server.name] !== true);
  if (down.length === 0) {
    lines.push('', 'both servers are up; these exports make the integration suites run:');
  } else {
    lines.push('', 'a server that is down does not fail these suites, it removes them:');
    for (const server of down) {
      lines.push(`  ${server.env} unset skips ${server.suites.join(', ')}`);
    }
    lines.push('', 'these exports make the integration suites run:');
  }
  for (const server of servers) lines.push(`export ${server.env}='${server.url}'`);
  return lines;
}

/** Start one server, and say whether the command claimed success. */
export function start(server, run = spawnSync) {
  const result = run('service', [server.name, 'start'], { stdio: 'pipe', encoding: 'utf8' });
  return { ok: result.status === 0, detail: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

/**
 * Wait for a port to answer.
 *
 * `service <name> start` returns when the init script is done, which on MariaDB is before the
 * server accepts connections: probing once right after the start reports `down` for a server
 * that came up a second later, and a tool that says "down" about a running server is worse than
 * no tool. The deadline is the caller's, so the self-test can wait two seconds for a port that
 * will never open.
 */
export async function waitFor(port, deadlineMs = 20_000, intervalMs = 500, probe = reachable) {
  const started = Date.now();
  for (;;) {
    if (await probe(port)) return true;
    if (Date.now() - started >= deadlineMs) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** `--start`, `--self-test`, and nothing else: a flag that is silently ignored is a lie. */
export function parseFlags(argv) {
  const known = new Set(['--start', '--self-test']);
  const flags = new Set(argv.filter((arg) => known.has(arg)));
  const unknown = argv.find((arg) => arg.startsWith('-') && !known.has(arg));
  return { start: flags.has('--start'), selfTest: flags.has('--self-test'), unknown };
}

async function main(argv) {
  const flags = parseFlags(argv);
  if (flags.unknown !== undefined) {
    process.stderr.write(`local-db: unknown flag ${flags.unknown}\n`);
    return 2;
  }
  if (flags.selfTest) return selfTest();

  const up = {};
  for (const server of SERVERS) up[server.name] = await reachable(server.port);

  if (flags.start) {
    for (const server of SERVERS.filter((candidate) => up[candidate.name] !== true)) {
      const outcome = start(server);
      process.stdout.write(`${server.name}: ${outcome.ok ? 'started' : `could not start — ${outcome.detail}`}\n`);
      if (!outcome.ok) process.stdout.write(`  run it yourself: ${server.manual}\n`);
      up[server.name] = await waitFor(server.port);
    }
  }

  for (const line of report(SERVERS, up)) process.stdout.write(`${line}\n`);
  const down = SERVERS.some((server) => up[server.name] !== true);
  return down ? 1 : 0;
}

/**
 * The self-test uses a real socket rather than a stub: the thing under test *is* the probe, and
 * a fake `net` module would prove only that the fake behaves.
 */
async function selfTest() {
  let failures = 0;
  const check = (name, condition) => {
    if (condition) return;
    failures += 1;
    process.stderr.write(`FAIL ${name}\n`);
  };

  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, HOST, resolve));
  const livePort = listener.address().port;
  check('a listening port reads as up', (await reachable(livePort)) === true);
  await new Promise((resolve) => listener.close(resolve));
  check('a closed port reads as down', (await reachable(livePort)) === false);

  const both = { postgresql: true, mariadb: true };
  const upReport = report(SERVERS, both);
  check('both up prints no skip', !upReport.some((line) => line.includes('unset skips')));
  check('both up still prints both exports', upReport.filter((line) => line.startsWith('export ')).length === 2);
  check('the postgres export is the one CI uses', upReport.includes(`export PG_TEST_URL='postgres://postgres:postgres@127.0.0.1:5432/nl2charts_test'`));

  const none = { postgresql: false, mariadb: false };
  const downReport = report(SERVERS, none);
  check('a down server names the file it costs', downReport.some((line) => line.includes('packages/node/test/postgres.test.ts')));
  check('a down server still prints its export', downReport.some((line) => line.startsWith('export MYSQL_TEST_URL=')));

  check('--start is read', parseFlags(['--start']).start === true);
  check('--self-test is read', parseFlags(['--self-test']).selfTest === true);
  check('an unknown flag is reported', parseFlags(['--star']).unknown === '--star');

  const started = start({ name: 'mariadb' }, () => ({ status: 0, stdout: 'done', stderr: '' }));
  check('a successful start is reported as such', started.ok === true);
  const refused = start({ name: 'mariadb' }, () => ({ status: 1, stdout: '', stderr: 'not root' }));
  check('a failed start carries the reason', refused.ok === false && refused.detail === 'not root');

  const reopened = createServer();
  await new Promise((resolve) => reopened.listen(0, HOST, resolve));
  const waitPort = reopened.address().port;
  check('waiting returns as soon as the port answers', (await waitFor(waitPort, 1_000)) === true);
  await new Promise((resolve) => reopened.close(resolve));
  check('waiting gives up on a port that never answers', (await waitFor(waitPort, 600, 200)) === false);

  if (failures > 0) {
    process.stderr.write(`local-db self-test: ${failures} failed\n`);
    return 1;
  }
  process.stdout.write('local-db self-test: 14 passed\n');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
