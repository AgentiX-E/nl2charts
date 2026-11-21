#!/usr/bin/env node
/**
 * The readback channel: a benchmark run's reading, published where this project can read it.
 *
 * A dispatched run writes its artifact into the job's workspace and uploads it, and the uploaded
 * file is served from a signed storage URL that answers `401` to anything that is not a browser
 * session — `GET /actions/runs/{id}/logs` and `/actions/artifacts/{id}/zip` both. That left the
 * 1,532-question dev split measurable only through a web page, which is a defect in the
 * measurement loop and not in the metric: a number nobody can quote is a number the next round
 * has to derive again.
 *
 * Two channels, because the first one was not enough:
 *
 *  - `branch` (default) writes `readings/index.json` on the `readback` branch, one entry per
 *    workflow, through the contents API. It needs `contents: write`, which every token that can
 *    push a commit already has — including the one this project uses from a terminal, where the
 *    issue channel answers `403` for a token without the Issues permission.
 *  - `issue` posts the reading as a comment on one long-lived issue, which a human can read in a
 *    browser. It needs `issues: write`, which the workflow token has and a fine-grained personal
 *    token may not.
 *
 * Both carry the same object: the readings plus the commit they belong to, because a reading
 * without its coordinates is the class of defect this repository keeps paying for.
 *
 *   node tools/readback.mjs --publish                 # from eval/out/bird-eval.json, to the branch
 *   node tools/readback.mjs --read --slug bird-dev    # that workflow's latest reading
 *   node tools/readback.mjs --publish --channel issue --ves eval/out/bird-ves.json
 *   node tools/readback.mjs --self-test               # the digest rules, on a fixture
 *
 * Environment: `GITHUB_TOKEN` (required), `GITHUB_REPOSITORY` (required in Actions), and
 * `READBACK_API` to point at another origin — which is how the tests reach a real HTTP server
 * instead of mocking a client.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const ISSUE_TITLE = 'bench readback';
const LABEL = 'bench-readback';
const MARKER = '<!-- bench-readback:';
const DEFAULT_API = 'https://api.github.com';
/** The branch readings land on: not `master`, because a measurement is not a source change. */
export const READBACK_BRANCH = 'readback';
/** One file for every workflow, merged by slug, so a publish is one read and one write. */
export const INDEX_PATH = 'readings/index.json';

/**
 * The reading, reduced to the fields a report quotes.
 *
 * Reduction is the point: the artifact of a five-arm dev run is megabytes and the comment has to
 * stay readable. What survives is what a report can say out loud — the split, the model that
 * answered, each arm's score with the pool it drew from, the price, and the run's provenance —
 * plus the R-VES block when the run measured one.
 */
export function digest(artifact, ves, meta = {}) {
  const arms = (artifact.arms ?? []).map((arm) => ({
    arm: arm.arm,
    passed: arm.passed,
    total: arm.total,
    accuracy: arm.accuracy,
    ...(arm.candidateRecall === undefined ? {} : { candidateRecall: arm.candidateRecall }),
    ...(arm.selectionLoss === undefined ? {} : { selectionLoss: arm.selectionLoss }),
    ...(arm.calls === undefined ? {} : { calls: arm.calls.mean }),
    ...(arm.tokens === undefined ? {} : { promptTokens: arm.tokens.prompt, completionTokens: arm.tokens.completion }),
    ...(arm.strictPassed === undefined ? {} : { strictPassed: arm.strictPassed }),
    // The funnel, which is the half a pre-registration actually names. A gate's bar is written as
    // "`calls.mean` at or below X and `spend.asked` at or below Y", and the first reading this tool
    // published carried the mean and dropped `asked` — so the dispatch could not be checked against
    // the criterion it was dispatched for, and the check had to be done by hand from the artifact.
    // `selectorRule` travels with it because a free decision is only a decision if the rule ran:
    // the same reading published `{rule: 'shortest'}` for an arm whose gate answered by `modal`.
    ...(arm.spend === undefined ? {} : { spend: { asked: arm.spend.asked, priced: arm.spend.priced } }),
    ...(arm.selectorRule === undefined ? {} : { selectorRule: arm.selectorRule }),
    ...(arm.poolRead === undefined ? {} : { poolRead: arm.poolRead }),
    ...(arm.pairwise === undefined ? {} : { pairwise: arm.pairwise }),
  }));
  return {
    kind: 'bench-readback',
    commit: meta.commit ?? null,
    workflow: meta.workflow ?? null,
    runId: meta.runId ?? null,
    split: artifact.split ?? null,
    dataset: artifact.dataset ?? null,
    model: artifact.model ?? null,
    secondModel: artifact.secondModel ?? null,
    generatedAt: artifact.generatedAt ?? null,
    corpus: artifact.corpus ?? null,
    selection: artifact.selection === undefined ? null : { requested: artifact.selection.requested, scored: artifact.selection.scored },
    arms,
    ...(ves === undefined || ves === null
      ? {}
      : {
          rves: {
            rves: ves.rves,
            ex: ves.ex,
            scored: ves.scored,
            of: ves.of,
            runs: ves.runs,
            repeats: ves.repeats,
            ...(ves.floor === undefined ? {} : { floor: ves.floor.rves, net: ves.floor.net }),
          },
        }),
  };
}

/** The Markdown a human reads: one line per arm, and the JSON a program reads under it. */
export function bodyOf(reading) {
  const lines = [];
  const where = [reading.split, reading.model, reading.commit === null ? undefined : reading.commit.slice(0, 8)].filter(
    (part) => part !== undefined && part !== null && part !== '',
  );
  lines.push(`### ${where.join(' · ')}`);
  lines.push('');
  lines.push('| arm | passed | accuracy | pool | loss | paid | calls | prompt | completion |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const arm of reading.arms) {
    lines.push(
      `| \`${arm.arm}\` | ${arm.passed}/${arm.total} | ${(arm.accuracy * 100).toFixed(2)}% | ` +
        `${arm.candidateRecall === undefined ? '—' : String(arm.candidateRecall)} | ` +
        `${arm.selectionLoss === undefined ? '—' : String(arm.selectionLoss)} | ` +
        `${arm.spend === undefined ? '—' : `${String(arm.spend.asked)}/${String(arm.total)}`} | ` +
        `${arm.calls === undefined ? '—' : arm.calls.toFixed(2)} | ` +
        `${arm.promptTokens === undefined ? '—' : String(arm.promptTokens)} | ` +
        `${arm.completionTokens === undefined ? '—' : String(arm.completionTokens)} |`,
    );
  }
  if (reading.rves !== undefined) {
    lines.push('');
    lines.push(
      `R-VES **${reading.rves.rves.toFixed(2)}** over ${String(reading.rves.scored)} of ${String(reading.rves.of)} questions` +
        (reading.rves.floor === undefined ? '' : ` · floor ${reading.rves.floor.toFixed(2)} · net ${reading.rves.net.toFixed(2)}pp`),
    );
  }
  lines.push('');
  lines.push(`${MARKER}json -->`);
  lines.push('```json');
  lines.push(JSON.stringify(reading, null, 1));
  lines.push('```');
  return lines.join('\n');
}

/** The reading back out of a comment body, or undefined when the comment is not one of ours. */
export function parseBody(body) {
  const start = body.indexOf(`${MARKER}json -->`);
  if (start === -1) return undefined;
  const fence = body.indexOf('```json', start);
  if (fence === -1) return undefined;
  const from = body.indexOf('\n', fence);
  const to = body.indexOf('```', from);
  if (from === -1 || to === -1) return undefined;
  try {
    return JSON.parse(body.slice(from + 1, to));
  } catch {
    return undefined;
  }
}

/** An HTTP failure with the status kept, because `404` means "not written yet" and `403` does not. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * One request against the REST API, with the headers every call needs.
 *
 * `fetch` is passed in rather than reached for: the tests run a real HTTP server and are therefore
 * testing the request this function builds, not a stub of it.
 */
async function request(fetchImpl, { api, token, method = 'GET', path, payload }) {
  const response = await fetchImpl(`${api}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'nl2charts-readback',
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(response.status, `${method} ${path} answered ${String(response.status)}: ${text.slice(0, 300)}`);
  }
  return text.length === 0 ? undefined : JSON.parse(text);
}

/* --------------------------------------------------------------------------------------------
 * The branch channel
 * ------------------------------------------------------------------------------------------ */

/** The slug a reading is filed under: the workflow that produced it, or the caller's name. */
export function slugOf(environment, override) {
  const raw = override ?? environment.GITHUB_WORKFLOW ?? 'bench';
  // Workflow names carry spaces and capitals (`bird dev`); a key in a JSON object does not need to
  // be a filename, but a stable readable slug is what a later reader greps for.
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '') || 'bench';
}

/** The index with one entry replaced, and nothing else touched. */
export function mergeReading(index, slug, reading) {
  const readings = index?.readings ?? {};
  return { version: 1, readings: { ...readings, [slug]: reading } };
}

/** The newest entry in an index, by the run that wrote it, for a reader that names no workflow. */
export function latestReading(index) {
  const entries = Object.entries(index?.readings ?? {});
  if (entries.length === 0) return undefined;
  const sorted = entries.sort((left, right) => String(left[1].generatedAt ?? '').localeCompare(String(right[1].generatedAt ?? '')));
  return sorted[sorted.length - 1];
}

async function branchExists({ fetchImpl, api, token, repo, branch }) {
  try {
    await request(fetchImpl, { api, token, path: `/repos/${repo}/git/ref/heads/${branch}` });
    return true;
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}

/**
 * The branch, created from the default branch's head on first use.
 *
 * Readings live on their own branch rather than on `master` for a reason that is not tidiness: a
 * measurement is not a change to the project, and a commit on `master` per dispatch would run the
 * whole CI matrix again to record a number about the previous run.
 */
export async function ensureBranch({ fetchImpl = fetch, api = DEFAULT_API, token, repo, branch = READBACK_BRANCH }) {
  if (await branchExists({ fetchImpl, api, token, repo, branch })) return branch;
  const repository = await request(fetchImpl, { api, token, path: `/repos/${repo}` });
  const head = await request(fetchImpl, { api, token, path: `/repos/${repo}/git/ref/heads/${String(repository.default_branch)}` });
  await request(fetchImpl, {
    api,
    token,
    method: 'POST',
    path: `/repos/${repo}/git/refs`,
    payload: { ref: `refs/heads/${branch}`, sha: head.object.sha },
  });
  return branch;
}

/** The index as it stands, with the blob sha a write has to name. */
export async function readIndex({ fetchImpl = fetch, api = DEFAULT_API, token, repo, branch = READBACK_BRANCH }) {
  try {
    const file = await request(fetchImpl, { api, token, path: `/repos/${repo}/contents/${INDEX_PATH}?ref=${branch}` });
    return { index: JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')), sha: file.sha };
  } catch (error) {
    // A branch with no index yet is the first publish, not an error. Every other status is the
    // channel being unavailable, and reporting that as "empty" would publish over whatever is there.
    if (error.status === 404) return { index: { version: 1, readings: {} }, sha: undefined };
    throw error;
  }
}

export async function publishToBranch({ fetchImpl = fetch, api = DEFAULT_API, token, repo, branch = READBACK_BRANCH, slug, reading }) {
  await ensureBranch({ fetchImpl, api, token, repo, branch });
  const { index, sha } = await readIndex({ fetchImpl, api, token, repo, branch });
  const merged = mergeReading(index, slug, reading);
  const written = await request(fetchImpl, {
    api,
    token,
    method: 'PUT',
    path: `/repos/${repo}/contents/${INDEX_PATH}`,
    payload: {
      message: `bench(readback): ${slug} ${reading.split ?? 'split'} ${reading.model ?? 'model'} ${String(reading.arms.length)} arm(s)`,
      content: Buffer.from(`${JSON.stringify(merged, null, 1)}\n`, 'utf8').toString('base64'),
      branch,
      ...(sha === undefined ? {} : { sha }),
    },
  });
  return { branch, path: INDEX_PATH, commit: written.commit?.sha, slug, readings: Object.keys(merged.readings).length };
}

export async function readFromBranch({ fetchImpl = fetch, api = DEFAULT_API, token, repo, branch = READBACK_BRANCH, slug }) {
  const { index } = await readIndex({ fetchImpl, api, token, repo, branch });
  if (slug === undefined) {
    const latest = latestReading(index);
    return latest === undefined ? undefined : { slug: latest[0], reading: latest[1] };
  }
  const reading = index?.readings?.[slug];
  return reading === undefined ? undefined : { slug, reading };
}

/* --------------------------------------------------------------------------------------------
 * The issue channel
 * ------------------------------------------------------------------------------------------ */

/**
 * The long-lived issue, created on first use so that a dispatch needs no setup.
 *
 * Identity is the title, not the label. The first version filtered the list by `bench-readback`,
 * which is the right thing for a human to click and the wrong thing to rely on: a repository whose
 * label does not exist drops the label from the create call silently, the next run finds no issue
 * with it, and the channel grows one issue per dispatch. Two runs of that bug are on the
 * repository's issue list.
 */
export function findIssue(issues) {
  const matching = issues.filter((issue) => issue.title === ISSUE_TITLE && issue.pull_request === undefined);
  // The oldest, because a duplicate is a leftover rather than a newer channel: the readings all
  // belong on one issue and the first one is where they started.
  return matching.sort((left, right) => left.number - right.number)[0];
}

export async function ensureIssue({ fetchImpl = fetch, api = DEFAULT_API, token, repo }) {
  const issues = await request(fetchImpl, { api, token, path: `/repos/${repo}/issues?state=all&per_page=100` });
  const existing = findIssue(issues);
  if (existing !== undefined) return existing;
  return request(fetchImpl, {
    api,
    token,
    method: 'POST',
    path: `/repos/${repo}/issues`,
    payload: {
      title: ISSUE_TITLE,
      labels: [LABEL],
      body:
        'Every dispatched benchmark run appends its reading here, as a comment. This issue is the ' +
        'readback channel: the uploaded artifacts are served from storage URLs this project cannot ' +
        'read, and `api.github.com` is.',
    },
  });
}

export async function publish({ fetchImpl = fetch, api = DEFAULT_API, token, repo, reading, issue: issueNumber }) {
  const issue = issueNumber === undefined ? await ensureIssue({ fetchImpl, api, token, repo }) : { number: issueNumber };
  const comment = await request(fetchImpl, {
    api,
    token,
    method: 'POST',
    path: `/repos/${repo}/issues/${String(issue.number)}/comments`,
    payload: { body: bodyOf(reading) },
  });
  return { issue: issue.number, comment: comment.id, url: comment.html_url };
}

/**
 * The newest reading, across pages until one does not exist.
 *
 * A comment that is not ours — a conversation on the issue — is skipped rather than treated as an
 * error. The list endpoint returns comments oldest first and does not accept a sort order, so the
 * *last* parsing comment is the newest; reading the first one would report the oldest reading on
 * the issue as if it were the most recent, which is the same direction of error as reading a floor
 * from another split.
 */
export async function read({ fetchImpl = fetch, api = DEFAULT_API, token, repo, issue: issueNumber, pages = 3 }) {
  const issue = issueNumber === undefined ? await ensureIssue({ fetchImpl, api, token, repo }) : { number: issueNumber };
  let newest;
  for (let page = 1; page <= pages; page += 1) {
    const comments = await request(fetchImpl, {
      api,
      token,
      path: `/repos/${repo}/issues/${String(issue.number)}/comments?per_page=100&page=${String(page)}`,
    });
    for (const comment of comments) {
      const parsed = parseBody(comment.body ?? '');
      if (parsed !== undefined) newest = { issue: issue.number, comment: comment.id, url: comment.html_url, reading: parsed };
    }
    // An empty page is the end of the list; continuing would ask for pages that cannot exist.
    if (comments.length === 0) break;
  }
  return newest;
}

/* --------------------------------------------------------------------------------------------
 * The command
 * ------------------------------------------------------------------------------------------ */

/** What the workflow passes to `--publish`: the run's own coordinates, from the environment. */
export function metaFromEnvironment(environment) {
  return {
    commit: environment.GITHUB_SHA ?? null,
    workflow: environment.GITHUB_WORKFLOW ?? null,
    runId: environment.GITHUB_RUN_ID ?? null,
  };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

export async function main(argv, environment = process.env) {
  const args = argv.slice(2);
  const mode = args.includes('--publish') ? 'publish' : args.includes('--read') ? 'read' : args.includes('--self-test') ? 'self-test' : undefined;
  const json = args.includes('--json');
  const value = (flag) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  if (mode === 'self-test') {
    // The digest rules, proved on a fixture rather than on a run: this is the part that can be
    // wrong without a network, and the part a reader of the comment depends on.
    const artifact = {
      split: 'dev',
      model: 'm',
      arms: [{ arm: 'select-cross', passed: 3, total: 4, accuracy: 0.75, candidateRecall: 3, calls: { mean: 4 }, tokens: { prompt: 10, completion: 2 } }],
    };
    const reading = digest(artifact, { rves: 50, ex: 75, scored: 4, of: 4, runs: [50], repeats: 1 }, { commit: 'abcdef1234' });
    const round = parseBody(bodyOf(reading));
    const ok = round !== undefined && round.arms[0]?.arm === 'select-cross' && round.rves?.rves === 50;
    // The merge is the other half that can be wrong without a network: a publish must replace its
    // own slug and leave every other workflow's reading alone.
    const merged = mergeReading({ readings: { other: { keep: true } } }, 'mine', reading);
    const mergedOk = merged.readings.other?.keep === true && merged.readings.mine?.arms.length === 1;
    process.stdout.write(ok && mergedOk ? 'readback self-test: ok\n' : `readback self-test: FAILED (${String(ok)}/${String(mergedOk)})\n`);
    return ok && mergedOk ? 0 : 1;
  }
  const token = environment.GITHUB_TOKEN;
  const repo = environment.GITHUB_REPOSITORY;
  const api = environment.READBACK_API ?? DEFAULT_API;
  if (token === undefined || repo === undefined) {
    process.stderr.write('readback: GITHUB_TOKEN and GITHUB_REPOSITORY are required\n');
    return 2;
  }
  const channel = value('--channel') ?? 'branch';
  const slug = slugOf(environment, value('--slug'));
  const issue = value('--issue') === undefined ? undefined : Number(value('--issue'));
  const branch = value('--branch') ?? READBACK_BRANCH;
  if (mode === 'read') {
    const found =
      channel === 'issue' ? await read({ api, token, repo, issue }) : await readFromBranch({ api, token, repo, branch, slug: value('--slug') === undefined ? undefined : slug });
    if (found === undefined) {
      process.stderr.write(channel === 'issue' ? 'readback: no comment on the issue carries a reading\n' : `readback: ${branch} holds no reading for that slug\n`);
      return 3;
    }
    process.stdout.write(json ? `${JSON.stringify(found.reading, null, 1)}\n` : `${bodyOf(found.reading)}\n`);
    return 0;
  }
  if (mode === 'publish') {
    const artifactPath = resolve(value('--out') ?? resolve(ROOT, 'eval/out/bird-eval.json'));
    const artifact = readJson(artifactPath);
    if (artifact === undefined) {
      process.stderr.write(`readback: no artifact at ${artifactPath}, so there is nothing to publish\n`);
      return 4;
    }
    const vesPath = value('--ves') ?? resolve(ROOT, 'eval/out/bird-ves.json');
    const reading = digest(artifact, readJson(vesPath), metaFromEnvironment(environment));
    if (channel === 'issue') {
      const published = await publish({ api, token, repo, reading, issue });
      process.stdout.write(`readback: published ${String(reading.arms.length)} arms to ${published.url}\n`);
      return 0;
    }
    const published = await publishToBranch({ api, token, repo, branch, slug, reading });
    process.stdout.write(
      `readback: published ${String(reading.arms.length)} arms as ${published.slug} on ${published.branch}${published.commit === undefined ? '' : ` (${published.commit.slice(0, 8)})`}\n`,
    );
    return 0;
  }
  process.stderr.write('readback: one of --publish, --read or --self-test is required\n');
  return 2;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv).then((code) => process.exit(code));
}
