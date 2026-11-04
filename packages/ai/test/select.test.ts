import { describe, expect, it } from 'vitest';
import { applySelection, buildPairwisePrompt, buildReconcilePrompt, buildSelectionPrompt, chooseCandidate, chooseCandidateByRule, chooseCandidatePairwise, parsePairwise, parseSelection, resultGroups, SELECTION_RULES, toCandidate } from '../src/select.js';
import type { LlmProvider } from '../src/provider.js';
import type { Candidate } from '../src/select.js';
import { judgeOfficial } from '@agentix-e/nl2charts-devkit';

/**
 * The selector is the only part of the harness that decides between complete
 * answers, so its two failure modes matter more than its prompt wording: it must
 * never silently pick candidate 1 when it could not answer, and it must never count
 * a statement's text as an index.
 */
const candidates: Candidate[] = [
  { sql: 'SELECT COUNT(*) FROM orders', rows: 500, columns: 1, preview: '[[500]]' },
  { sql: 'SELECT COUNT(*) FROM orders WHERE status = "completed"', rows: 120, columns: 1, preview: '[[120]]' },
  { sql: 'SELECT id FROM orders', rows: 12, columns: 1, preview: '[[1], [2], [3]]' },
];

describe('selection prompt', () => {
  const prompt = buildSelectionPrompt('How many completed orders are there?', candidates);

  it('numbers every candidate from one, in the order given', () => {
    for (const [index, candidate] of candidates.entries()) {
      expect(prompt).toContain(`${String(index + 1)}. ${candidate.sql}`);
    }
  });

  it('shows the shape of each result, which is what a row count can decide', () => {
    expect(prompt).toContain('500 rows, 1 columns');
    expect(prompt).toContain('120 rows, 1 columns');
    expect(prompt).toContain('first rows: [[120]]');
  });

  it('states the rules that make the comparison falsifiable', () => {
    expect(prompt).toContain('already been executed');
    expect(prompt).toContain('row count that cannot answer the question');
    expect(prompt).toContain('nothing else');
  });

  it('renders a candidate with no rows without an empty preview line', () => {
    const empty = buildSelectionPrompt('q', [{ sql: 'SELECT 1 WHERE 0', rows: 0, columns: 1, preview: '' }]);
    expect(empty).not.toContain('first rows:');
    expect(empty).toContain('0 rows, 1 columns');
  });
});

describe('collapsing a result for the selector', () => {
  it('reads an empty result as zero columns rather than as no candidate', () => {
    // The one shape a result-based rule has to survive: a statement that ran and returned
    // nothing. It has no first row to take a width from, and `0 columns` beside `0 rows` is
    // what tells the selector the candidate is empty rather than narrow.
    expect(toCandidate({ sql: 'SELECT 1 WHERE 0', rows: [] })).toEqual({
      sql: 'SELECT 1 WHERE 0',
      rows: 0,
      columns: 0,
      preview: '[]',
    });
  });

  it('keeps three rows of preview and clips the rest', () => {
    const rows = [[1], [2], [3], [4], [5]];
    const candidate = toCandidate({ sql: 'SELECT id FROM orders', rows });
    expect(candidate.rows).toBe(5);
    expect(candidate.columns).toBe(1);
    expect(candidate.preview).toBe('[[1],[2],[3]]');
  });
});

describe('agreement, when the caller measured it', () => {
  const marked: Candidate[] = [
    { sql: 'SELECT COUNT(*) FROM orders', rows: 500, columns: 1, preview: '[[500]]' },
    { sql: 'SELECT COUNT(*) FROM orders WHERE status = "completed"', rows: 500, columns: 1, preview: '[[500]]', agreesWith: 1 },
    { sql: 'SELECT id FROM orders', rows: 12, columns: 1, preview: '[[1], [2], [3]]' },
  ];

  it('says nothing about agreement when no candidate carries a mark', () => {
    // The property the ablation depends on: an unmarked list gets the prompt every arm
    // before this one was measured with, byte for byte. A prompt that changed when the
    // marks were absent would price the marks against a different experiment.
    const prompt = buildSelectionPrompt('How many completed orders are there?', candidates);
    expect(prompt).not.toContain('distinct results');
    expect(prompt).not.toContain('same result as candidate');
    expect(prompt).not.toContain('not independent opinions');
  });

  it('marks the agreeing candidate and counts the distinct results', () => {
    const prompt = buildSelectionPrompt('How many orders?', marked);
    expect(prompt).toContain('These 3 candidates returned 2 distinct results; identical results are marked.');
    expect(prompt).toContain('2. SELECT COUNT(*) FROM orders WHERE status = "completed"\n   result: 500 rows, 1 columns\n   first rows: [[500]]\n   same result as candidate 1');
    // The two unique candidates carry no line: a mark is a fact about a pair, and printing
    // "same result as candidate 2" over a candidate that matches nothing would be a lie the
    // model cannot check.
    expect(prompt.match(/same result as candidate/g)).toHaveLength(1);
  });

  it('states the rule that makes the mark worth reading', () => {
    // Without this line the mark is trivia; with it the selector is asked the question the
    // 2+1 pool turns on — whether agreement here is evidence or a shared mistake.
    expect(buildSelectionPrompt('q', marked)).toContain(
      'Candidates marked as returning the same result are not independent opinions: they may share one mistake. Agreement is evidence, not proof',
    );
  });

  it('counts a three-way agreement as one distinct result, not two', () => {
    const all: Candidate[] = [
      { sql: 'SELECT 1', rows: 1, columns: 1, preview: '[[1]]' },
      { sql: 'SELECT 2', rows: 1, columns: 1, preview: '[[1]]', agreesWith: 1 },
      { sql: 'SELECT 3', rows: 1, columns: 1, preview: '[[1]]', agreesWith: 1 },
    ];
    expect(buildSelectionPrompt('q', all)).toContain('These 3 candidates returned 1 distinct results');
  });
});

describe('reading the answer', () => {
  it('accepts the forms a model actually writes', () => {
    expect(parseSelection('2', 3)).toBe(1);
    expect(parseSelection(' 2\n', 3)).toBe(1);
    expect(parseSelection('2.', 3)).toBe(1);
    expect(parseSelection('**2**', 3)).toBe(1);
    expect(parseSelection('Candidate 2', 3)).toBe(1);
    expect(parseSelection('candidate: 3', 3)).toBe(2);
  });

  it('rejects an index outside the list instead of clamping it', () => {
    // Clamping would turn a selector that answered "9" into a vote for candidate 3.
    expect(parseSelection('0', 3)).toBe(-1);
    expect(parseSelection('4', 3)).toBe(-1);
    expect(parseSelection('-1', 3)).toBe(-1);
  });

  it('rejects prose that happens to contain a number', () => {
    // A statement is not an index: parsing it as one would make a model that ignored
    // the instruction look like a model that chose.
    expect(parseSelection('SELECT COUNT(*) FROM orders LIMIT 2', 3)).toBe(-1);
    expect(parseSelection('I think candidate 2 is right because it filters', 3)).toBe(-1);
    expect(parseSelection('', 3)).toBe(-1);
  });

  it('reports when it could not decide, rather than absorbing the failure', () => {
    const decided = applySelection('3', candidates);
    expect(decided).toEqual({ index: 2, decided: true });
    const undecided = applySelection('not a number', candidates);
    expect(undecided).toEqual({ index: 0, decided: false });
  });

  it('is deterministic for the same reply', () => {
    expect(applySelection('2', candidates)).toEqual(applySelection('2', candidates));
  });
});

describe('choosing among executed candidates', () => {
  const executed = [
    { sql: 'SELECT COUNT(*) FROM orders', rows: [[500]] },
    { sql: 'SELECT COUNT(*) FROM orders WHERE status = "completed"', rows: [[120]] },
  ];
  const provider = (reply: string): LlmProvider => ({
    id: 'test',
    model: 'test-model',
    async complete() {
      return { text: reply, usage: { promptTokens: 1, completionTokens: 1 } } as never;
    },
  });

  it('returns the statement the model chose', async () => {
    const decision = await chooseCandidate(provider('2'), 'How many completed orders?', executed);
    expect(decision).toEqual({ index: 1, decided: true, sql: executed[1]?.sql });
  });

  it('reports an unreadable reply instead of pretending it chose', async () => {
    const decision = await chooseCandidate(provider('I would need the schema'), 'q', executed);
    expect(decision.index).toBe(0);
    expect(decision.decided).toBe(false);
  });

  it('skips the extra call when there is nothing to choose between', async () => {
    // A single candidate is what a one-sample run returns anyway; spending a call to
    // confirm it would make the option cost something and change nothing.
    let calls = 0;
    const counting: LlmProvider = {
      id: 'test',
      model: 'test-model',
      async complete() {
        calls += 1;
        return { text: '1', usage: { promptTokens: 1, completionTokens: 1 } } as never;
      },
    };
    const decision = await chooseCandidate(counting, 'q', [executed[0] as (typeof executed)[number]]);
    expect(decision).toEqual({ index: 0, decided: true, sql: executed[0]?.sql });
    expect(calls).toBe(0);
  });

  it('refuses an empty candidate list rather than inventing an answer', async () => {
    await expect(chooseCandidate(provider('1'), 'q', [])).rejects.toThrow(/at least one/);
  });

  it('describes a result by shape, not by dumping it', () => {
    const wide = { sql: 'SELECT * FROM t', rows: Array.from({ length: 1000 }, () => [1, 'a']) };
    const candidate = toCandidate(wide);
    expect(candidate.rows).toBe(1000);
    expect(candidate.columns).toBe(2);
    expect(candidate.preview.length).toBeLessThanOrEqual(300);
  });
});

/**
 * Pairwise selection: the shape CHASE-SQL's selector has, copied as a prompt.
 *
 * The claims worth testing are structural, not stylistic — the incumbent is challenged
 * once per challenger, an unreadable reply leaves the ranking alone instead of handing
 * the decision to candidate 1, and the count is exactly `k - 1` so the price of a
 * comparison is predictable.
 */
describe('pairwise selection', () => {
  const replies = (texts: readonly string[]) => {
    const seen: string[] = [];
    const provider: LlmProvider = {
      id: 'scripted',
      model: 'scripted',
      complete: async (request) => {
        const prompt = request.messages[0]?.content ?? '';
        seen.push(prompt);
        const text = texts[seen.length - 1] ?? '1';
        return { text, model: 'scripted' };
      },
    };
    return { provider, seen };
  };
  const executed = [
    { sql: 'SELECT 1', rows: [[1]] as unknown[][] },
    { sql: 'SELECT 2', rows: [[2]] as unknown[][] },
    { sql: 'SELECT 3', rows: [[3]] as unknown[][] },
  ];

  it('challenges the incumbent once per challenger, so three candidates cost two calls', async () => {
    const scripted = replies(['2', '2']);
    const decision = await chooseCandidatePairwise(scripted.provider, 'q', executed);
    expect(scripted.seen).toHaveLength(2);
    // 1 vs 2 → 2 wins; then 2 vs 3 → 3 wins.
    expect(decision.index).toBe(2);
    expect(decision.sql).toBe('SELECT 3');
  });

  it('keeps the incumbent when the challenger loses', async () => {
    const scripted = replies(['1', '1', '1']);
    const decision = await chooseCandidatePairwise(scripted.provider, 'q', executed);
    expect(decision.index).toBe(0);
    expect(decision.decided).toBe(true);
    expect(scripted.seen).toHaveLength(2);
  });

  it('costs nothing on a single candidate, which has nothing to compare against', async () => {
    const scripted = replies([]);
    const decision = await chooseCandidatePairwise(scripted.provider, 'q', [executed[0] as (typeof executed)[0]]);
    expect(decision.index).toBe(0);
    expect(decision.decided).toBe(true);
    expect(scripted.seen).toHaveLength(0);
  });

  it('reports an unreadable comparison instead of treating it as a vote for the challenger', async () => {
    const scripted = replies(['I think the second one', '2']);
    const decision = await chooseCandidatePairwise(scripted.provider, 'q', executed);
    // The first comparison is unreadable, so candidate 1 stays; the second is readable
    // and picks candidate 3.
    expect(decision.index).toBe(2);
    expect(decision.decided).toBe(false);
  });

  it('shows the question and both statements, one of which is labelled 1', () => {
    const prompt = buildPairwisePrompt('How many orders?', candidates[0] as Candidate, candidates[1] as Candidate);
    expect(prompt).toContain('How many orders?');
    expect(prompt).toContain(`1. ${(candidates[0] as Candidate).sql}`);
    expect(prompt).toContain(`2. ${(candidates[1] as Candidate).sql}`);
    expect(prompt).toContain('Answer with 1 or 2 and nothing else.');
  });

  it('reads only a bare 1 or 2, because prose containing a 2 is not a choice', () => {
    expect(parsePairwise('2')).toBe(1);
    expect(parsePairwise(' 1. ')).toBe(0);
    expect(parsePairwise('Candidate 2')).toBe(1);
    expect(parsePairwise('The second candidate has 2 rows')).toBe(-1);
    expect(parsePairwise('3')).toBe(-1);
  });

  it('refuses an empty candidate list rather than inventing one', async () => {
    await expect(chooseCandidatePairwise(replies([]).provider, 'q', [])).rejects.toThrow(/at least one/);
  });
});

/**
 * A label the selector cannot see is a distinction that does not exist.
 *
 * The adopted arm's candidates come from three prompts and, in the cross arm, two models.
 * Unlabelled they are three SQL strings, and the selector's only handle on where a
 * statement came from is its confidence about the SQL itself. The label is opt-in per
 * candidate, so an arm that never sets it keeps its prompt byte-identical.
 */
describe('candidate source labels', () => {
  it('renders the label in front of the statement', () => {
    const prompt = buildSelectionPrompt('How many orders?', [
      { ...(candidates[0] as Candidate), source: 'inline+evidence@second' },
      { ...(candidates[1] as Candidate), source: 'metadata+evidence' },
    ]);
    expect(prompt).toContain(`1. [inline+evidence@second] ${(candidates[0] as Candidate).sql}`);
    expect(prompt).toContain(`2. [metadata+evidence] ${(candidates[1] as Candidate).sql}`);
  });

  it('leaves an unlabelled candidate exactly as it was', () => {
    const prompt = buildSelectionPrompt('How many orders?', candidates);
    expect(prompt).toContain(`1. ${(candidates[0] as Candidate).sql}`);
    // A preview is JSON and contains brackets, so the check is for the tag position.
    expect(prompt).not.toContain('1. [');
  });
});

describe('the selector sends the deployment\'s temperature, not its own', () => {
  const recorder = (): { readonly provider: LlmProvider; readonly seen: (number | null | undefined)[] } => {
    const seen: (number | null | undefined)[] = [];
    return {
      seen,
      provider: {
        id: 'thermometer',
        model: 'fixture',
        async complete(request) {
          seen.push(request.temperature);
          return { text: '1', model: 'fixture', usage: { promptTokens: 0, completionTokens: 0 } };
        },
      },
    };
  };
  const executed = [
    { sql: candidates[0]?.sql ?? '', rows: [[500]] },
    { sql: candidates[1]?.sql ?? '', rows: [[120]] },
    { sql: candidates[2]?.sql ?? '', rows: [[1], [2], [3]] },
  ];

  it('omits the field when the deployment withholds it', async () => {
    // The selector goes to the same endpoint as the statement. A model that refuses to be told
    // a value refuses this call too, and a selector that failed on a 400 would take down an arm
    // whose statements were all fine.
    const { provider, seen } = recorder();
    await chooseCandidate(provider, 'q', executed.slice(0, 2), null);
    expect(seen).toEqual([null]);
  });

  it('sends zero when the caller says nothing, so the reading is unchanged', async () => {
    const { provider, seen } = recorder();
    await chooseCandidate(provider, 'q', executed.slice(0, 2));
    expect(seen).toEqual([0]);
  });

  it('carries the same answer into every pairwise comparison', async () => {
    const { provider, seen } = recorder();
    await chooseCandidatePairwise(provider, 'q', executed, null);
    expect(seen).toEqual([null, null]);
  });
});

/**
 * The reconcile prompt, which is the one lever whose output format is the experiment.
 *
 * A selector answers with an index, and an index cannot express an answer none of the candidates
 * contains. The two readings that pointed here: the paid selector is level with the free modal
 * result on a 2+1 pool (+0.17pp, −0.17pp), while the arm that shows the model *which candidates
 * agree* has paid twice (+1.17pp, +0.33pp). So the grouping is the input and a statement is the
 * output — and the tests below pin the things that make the comparison honest: the grouping is
 * the partition the marks already define, and one call is one statement, not three.
 */
describe('the reconcile prompt', () => {
  const marked: Candidate[] = [
    { sql: 'SELECT COUNT(*) FROM orders', rows: 500, columns: 1, preview: '[[500]]' },
    { sql: 'SELECT COUNT(*) FROM orders WHERE status = "completed"', rows: 120, columns: 1, preview: '[[120]]' },
    { sql: 'SELECT COUNT(*) FROM orders o', rows: 500, columns: 1, preview: '[[500]]', agreesWith: 1 },
  ];

  it('groups the candidates the way the agreement marks already partition them', () => {
    // Two of three returned the same rows, so the model has two opinions in front of it and not
    // three. The members are 1-based and the group carries the earliest member's statement,
    // because a group's identity is its result.
    expect(resultGroups(marked)).toEqual([
      { members: [1, 3], sql: 'SELECT COUNT(*) FROM orders', rows: 500, columns: 1, preview: '[[500]]' },
      { members: [2], sql: 'SELECT COUNT(*) FROM orders WHERE status = "completed"', rows: 120, columns: 1, preview: '[[120]]' },
    ]);
  });

  it('keeps every candidate when nothing agrees, and nothing when there is nothing', () => {
    // Three distinct results is the case the lever exists for: no candidate is the answer, so an
    // index cannot name one.
    expect(resultGroups(candidates).map((group) => group.members)).toEqual([[1], [2], [3]]);
    expect(resultGroups([])).toEqual([]);
  });

  const prompt = buildReconcilePrompt('How many completed orders are there?', resultGroups(marked));

  it('asks for a statement rather than a choice, and names the group sizes', () => {
    expect(prompt).toContain('Your job is not to pick one of them. Write the statement that answers the question.');
    expect(prompt).toContain('These 3 statements produced 2 distinct results.');
    expect(prompt).toContain('Answer with the statement alone, in a single ```sql block on the final line.');
    // A one-group set is the degenerate case, and the sentence has to read as English there too.
    expect(buildReconcilePrompt('q', resultGroups([candidates[0] as Candidate]))).toContain('These 1 statements produced 1 distinct result.');
  });

  it('shows each group with its statement, its shape and its rows', () => {
    expect(prompt).toContain('1. statements 1, 3 — 500 rows, 1 columns');
    expect(prompt).toContain('   SELECT COUNT(*) FROM orders');
    expect(prompt).toContain('2. statement 2 — 120 rows, 1 columns');
    expect(prompt).toContain('first rows: [[120]]');
    expect(prompt).toContain('Question: How many completed orders are there?');
  });

  it('carries the rules that make a result-based judgement falsifiable', () => {
    // The same three rules the selector has always had, because the population of wrong-but-running
    // statements is the same one: a row count that cannot answer the question, and a column the
    // question never mentions.
    expect(prompt).toContain('row count that cannot answer the question');
    expect(prompt).toContain('no invented tables or columns');
  });
});

/**
 * The free rules: the same question the selector answers, answered by a function of the
 * candidates. Every expectation below is a property of the rule rather than of a corpus, because
 * the corpus readings live in `eval/bird/consensus.ts` — what a library test has to fix is that the
 * rule means one thing, and that its result-set equality is the judge's equality and not a second
 * definition of it.
 */
describe('choosing without a call', () => {
  const executed = [
    { sql: 'SELECT a FROM t WHERE z IS NOT NULL', rows: [[1], [2], [3]] },
    { sql: '  SELECT b FROM t WHERE x = 1  ', rows: [[1], [2], [3]] },
    { sql: 'SELECT c FROM t WHERE x = 1 AND y = 2', rows: [] },
  ];

  it('offers exactly the three rules the readings were taken with', () => {
    expect(SELECTION_RULES).toEqual(['first', 'shortest', 'modal']);
  });

  it('first is the order the prompts were asked in', () => {
    expect(chooseCandidateByRule('first', executed)).toEqual({ index: 0, decided: true, sql: 'SELECT a FROM t WHERE z IS NOT NULL' });
  });

  it('shortest ignores the whitespace a model wrapped the statement in', () => {
    // 31 characters with the padding, 27 without, against 35 for the first and 38 for the third:
    // the padded statement is the shorter one and has to win, which it cannot do if the ranking
    // reads the padding.
    expect(chooseCandidateByRule('shortest', executed)).toEqual({ index: 1, decided: true, sql: '  SELECT b FROM t WHERE x = 1  ' });
    const paddedFirst = [
      { sql: '   SELECT 1   ', rows: [] },
      { sql: 'SELECT 1234', rows: [] },
    ];
    expect(chooseCandidateByRule('shortest', paddedFirst).index).toBe(0);
  });

  it('a blank statement is never the minimal answer', () => {
    const blank = [
      { sql: '', rows: [] },
      { sql: '   ', rows: [] },
      { sql: 'SELECT 1', rows: [] },
    ];
    expect(chooseCandidateByRule('shortest', blank).index).toBe(2);
    // Every statement blank is the one set where the rule has nothing to rank, and the earliest
    // candidate is the answer rather than an exception: a rule over a candidate set is total.
    expect(chooseCandidateByRule('shortest', blank.slice(0, 2)).index).toBe(0);
  });

  it('modal keeps the result most candidates returned, and counts the rows not the text', () => {
    const byRows = [
      { sql: 'SELECT DISTINCT a FROM t', rows: [[1], [2]] },
      { sql: 'SELECT b FROM t', rows: [[2], [1]] },
      { sql: 'SELECT c FROM t', rows: [[9]] },
    ];
    expect(chooseCandidateByRule('modal', byRows).index).toBe(0);
  });

  it('modal treats two empty results as one answer, because an empty set is one result', () => {
    const empties = [
      { sql: 'SELECT a FROM t WHERE 0', rows: [] },
      { sql: 'SELECT 1', rows: [[1]] },
      { sql: 'SELECT b FROM t WHERE 0', rows: [] },
    ];
    expect(chooseCandidateByRule('modal', empties).index).toBe(0);
  });

  it('every tie goes to the earliest candidate, so first is the limit of the other two', () => {
    const tie = [
      { sql: 'SELECT 1', rows: [[1]] },
      { sql: 'SELECT 2', rows: [[2]] },
    ];
    expect(chooseCandidateByRule('modal', tie).index).toBe(0);
    const sameLength = [
      { sql: 'SELECT 1', rows: [[1]] },
      { sql: 'SELECT 2', rows: [[2]] },
    ];
    expect(chooseCandidateByRule('shortest', sameLength).index).toBe(0);
  });

  it('a rule always decided, which is the difference in price from the selector', () => {
    for (const rule of SELECTION_RULES) {
      expect(chooseCandidateByRule(rule, executed).decided).toBe(true);
    }
  });

  it('one candidate is the answer under every rule, and none is a refusal', () => {
    const single = [{ sql: 'SELECT 1', rows: [[1]] }];
    for (const rule of SELECTION_RULES) {
      expect(chooseCandidateByRule(rule, single)).toEqual({ index: 0, decided: true, sql: 'SELECT 1' });
    }
    expect(() => chooseCandidateByRule('first', [])).toThrow('chooseCandidateByRule needs at least one executed candidate');
  });

  it('tells apart the values that only look alike, and folds the ones that are equal', () => {
    // A result set is a set of tuples, and the judge's equality is not JavaScript's: `1` and `1.0`
    // are one number, `1` and `'1'` are two answers, and `null` is not the string 'null'. Every
    // type a SQLite result can carry is exercised here, because a key that collapsed two of them
    // would make `modal` count a disagreement as agreement on those cases alone.
    const sameResult = (left: readonly (readonly unknown[])[], right: readonly (readonly unknown[])[]) =>
      chooseCandidateByRule('modal', [
        { sql: 'X', rows: [[Symbol.for('distinct')]] },
        { sql: 'L', rows: left },
        { sql: 'R', rows: right },
      ]).index === 1;
    expect(sameResult([[1]], [[1.0]])).toBe(true);
    expect(sameResult([[0]], [[-0]])).toBe(true);
    expect(sameResult([[1]], [['1']])).toBe(false);
    expect(sameResult([[1]], [[true]])).toBe(false);
    expect(sameResult([[null]], [['null']])).toBe(false);
    expect(sameResult([[Number.NaN]], [['n:NaN']])).toBe(false);
    expect(sameResult([[BigInt(1)]], [[1]])).toBe(true);
    expect(sameResult([[BigInt(2) ** BigInt(70)]], [['2']])).toBe(false);
    // A blob arrives as a byte array from most drivers and as the oracle's base64 wrapper from the
    // JSON one; both are the same value, which is the only reason `x:` is a prefix rather than a
    // hex string emitted in two places.
    expect(sameResult([[new Uint8Array([1, 2])]], [[{ $b64: '0102' }]])).toBe(true);
    expect(sameResult([[new Uint8Array([1, 2])]], [[new Uint8Array([1, 3])]])).toBe(false);
  });

  it('agrees with the judge about which results are the same result', () => {
    // The mirror in `select.ts` exists because a production package may not depend on the devkit
    // (PKG2). A mirror that is not held to the original is a second opinion, so the two are asked
    // the same question here: for every pair, "same key" has to mean "the official judge says
    // match". Values are the ones a SQLite result set actually carries.
    const values = [
      [[1]],
      [[1.0]],
      [[1], [2]],
      [[2], [1]],
      [[1], [1]],
      [['1']],
      [[true]],
      [[0]],
      [[-0]],
      [[null]],
      [[]],
      [['a b'], [null]],
    ] as const;
    // A pair on its own cannot answer this: with two candidates and no agreement the tie goes to
    // the first, so `modal` returns index 0 whether or not the two results are equal. A third
    // candidate that matches neither separates the cases — index 1 exactly when the first two
    // agree, index 0 exactly when all three are distinct.
    for (const left of values) {
      for (const right of values) {
        const agreed = chooseCandidateByRule('modal', [
          { sql: 'X', rows: [[Symbol.for('distinct')]] },
          { sql: 'L', rows: left },
          { sql: 'R', rows: right },
        ]).index === 1;
        expect([left, right, agreed]).toEqual([left, right, judgeOfficial(left as never, right as never) === 'match']);
      }
    }
  });
});
