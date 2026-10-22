#!/usr/bin/env node
/**
 * Credential leak guard (SEC1).
 *
 * A token that reaches a repository is a token that has to be rotated, and the
 * person who leaked it is usually the last to notice. This scans tracked files for
 * the shapes credentials take and fails the build on a hit.
 *
 * The scanner never prints what it found, only where: echoing a secret into a CI
 * log is the same leak with a different audience.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

const PATTERNS = [
  { id: 'SEC1:github-pat', re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { id: 'SEC1:github-token', re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { id: 'SEC1:openai-key', re: /\bsk-[A-Za-z0-9]{32,}/ },
  { id: 'SEC1:aws-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'SEC1:private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: 'SEC1:assigned-secret', re: /(?:DEEPSEEK|ZHIPU|OPENAI|ANTHROPIC)_API_KEY\s*[=:]\s*['"][^'"\s]{8,}['"]/ },
];

/** Files that are allowed to contain the word rather than the value. */
const SKIP = [/^pnpm-lock\.yaml$/, /^\.git\//, /coverage\//, /^eval\/\.cache\//];

export function scanText(text) {
  return PATTERNS.filter((pattern) => pattern.re.test(text)).map((pattern) => pattern.id);
}

export function scanFiles(files) {
  const hits = [];
  for (const file of files) {
    if (SKIP.some((skip) => skip.test(file))) continue;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const id of scanText(text)) hits.push({ file, id });
  }
  return hits;
}

function trackedFiles(root) {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
      .split('\u0000')
      .filter((entry) => entry.length > 0);
  } catch {
    // Not a git checkout (a tarball, a container): scan what is here instead of
    // silently passing.
    return execFileSync('find', ['.', '-type', 'f'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter((entry) => entry.length > 0);
  }
}

function selfTest() {
  const issues = [];
  const directory = mkdtempSync(join(tmpdir(), 'nl2charts-secrets-'));
  const planted = join(directory, 'leak.ts');
  const clean = join(directory, 'clean.ts');
  const config = join(directory, '.env');
  try {
    writeFileSync(planted, `const token = '${['github', 'pat', '11AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'].join('_')}';\n`);
    writeFileSync(clean, "const key = process.env.DEEPSEEK_API_KEY;\nconst doc = 'sk- is the prefix';\n");
    // Assembled, not written literally: this file is tracked, and a scanner that
    // cannot scan its own source is a scanner nobody runs.
    writeFileSync(config, `${['DEEPSEEK', 'API_KEY'].join('_')}="abcdef1234567890"\n`);

    if (scanFiles([planted]).length !== 1) issues.push('SEC1 has no self-test: a planted token was not caught');
    if (scanFiles([clean]).length !== 0) issues.push('SEC1 rejects an environment reference, which is the correct way to pass a key');
    if (scanFiles([config]).length !== 1) issues.push('SEC1 misses an assigned key in a dotfile');

    // A scanner that reports the file but copies the secret into the log is still
    // a leak; the finding shape is asserted rather than trusted.
    const hit = scanFiles([planted])[0];
    if (hit === undefined || Object.keys(hit).sort().join(',') !== 'file,id') {
      issues.push('SEC1 findings must carry a path and a rule id, never the matched text');
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return issues;
}

if (process.argv[2] === '--self-test') {
  const issues = selfTest();
  for (const issue of issues) console.error(issue);
  if (issues.length > 0) process.exit(1);
  console.log('secret guard self-test: planted, clean and dotfile cases behave');
} else {
  const hits = scanFiles(trackedFiles(ROOT));
  for (const hit of hits) console.error(`${hit.id} in ${hit.file}`);
  if (hits.length > 0) {
    console.error('secret guard: a credential-shaped string is tracked; rotate it, remove it, and rewrite history');
    process.exit(1);
  }
  console.log(`secret guard: no credential-shaped strings in ${trackedFiles(ROOT).length} tracked files`);
}
