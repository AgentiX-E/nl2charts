import { pathToFileURL } from 'node:url';

/**
 * The Text2Vis corpus, as a file this repository can read without a Python dependency.
 *
 * Text2Vis (EMNLP 2025) is the only public benchmark that scores a *chart* rather than a result
 * set: 1,985 questions over small tables, each with the answer, the reference visualization code
 * and the chart type the authors judged correct. It is one 6.7 MB CSV in a public Hugging Face
 * repository, which makes it the cheapest external reading this project has -- and the reason the
 * loader below is a parser plus a file copy rather than a client library.
 *
 * Two decisions are load-bearing.
 *
 * The first is that the CSV is parsed here rather than by a dependency. The file is 1,985 rows of
 * prose with commas in it, so the parser has to honour quoting and embedded newlines; a package
 * that does that is a package whose failure mode is silent (a split on `,` returns 1,985 rows and
 * the wrong ones). Forty lines that are tested against the awkward cases -- a quoted comma, a
 * quoted newline, a doubled quote, CRLF, a byte-order mark -- are a parser this repository can
 * defend, and the count is the check: a corpus that comes back with a different number of rows than
 * the file has columns of data is a parse that lost a row.
 *
 * The second is that a missing column is an error, not an empty string. Every field below is one a
 * reading needs, and a corpus that silently answers `''` for `Prompt` produces a benchmark whose
 * questions are blank and whose accuracy is therefore a number about nothing. The header is
 * checked before any row is read, which is the only place the mistake can be named.
 */

/** The columns a reading depends on, by the names the file uses. */
export const TEXT2VIS_FIELDS = {
  prompt: 'Prompt',
  answer: 'Answer',
  code: 'Visualization Code',
  chartType: 'Chart Type',
} as const;

/** One question, as the corpus states it. */
export interface Text2VisRow {
  /** The natural-language question. The one field a reading cannot proceed without. */
  readonly prompt: string;
  /** The answer the authors computed, as the file spells it. */
  readonly answer: string;
  /** The reference matplotlib source. Empty when the file has none for this row. */
  readonly code: string;
  /** The chart type the authors judged correct, verbatim (e.g. `Bar Chart`). */
  readonly chartType: string;
  /**
   * Every column of the row, keyed by the header the file uses.
   *
   * Kept because the corpus has more fields than this repository reads yet -- the table itself,
   * the axis labels, the colour column -- and a loader that discards them would make the next
   * mechanism a re-download rather than a new reading of the same bytes.
   */
  readonly raw: Readonly<Record<string, string>>;
}

/** The corpus, plus the header it was read under. */
export interface Text2VisCorpus {
  readonly columns: readonly string[];
  readonly rows: readonly Text2VisRow[];
}

/** Where the file lives, and what it is called. */
export const TEXT2VIS_URL = 'https://huggingface.co/datasets/mizanurr/Text2Vis/resolve/main/Text2Vis.csv';

/**
 * One CSV document, as a header and a rectangular body.
 *
 * RFC 4180, which is what the file is: fields are separated by commas, a field may be quoted, a
 * quoted field may contain commas, newlines and doubled quotes that mean one quote, and either
 * CRLF or LF ends a record. The parser is a single pass with an explicit state rather than a
 * regular expression, because a regular expression over 6.7 MB of prose with quotes in it is a
 * parser whose worst case nobody measured.
 *
 * A final newline does not open an empty record: files end with one, and a row of one empty field
 * would make every count off by one. A byte-order mark is stripped for the same reason -- Excel
 * writes one, and without stripping it the first column is named `\uFEFFPrompt` and the header
 * check fails on a file whose header is correct.
 */
export function parseCsv(text: string): { readonly columns: readonly string[]; readonly rows: readonly (readonly string[])[] } {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index] as string;
    if (quoted) {
      if (character !== '"') {
        field += character;
        continue;
      }
      // A doubled quote inside a quoted field is one quote; a single one closes the field.
      if (body[index + 1] === '"') {
        field += '"';
        index += 1;
        continue;
      }
      quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (character === '\r' || character === '\n') {
      // CRLF is one terminator, not two: consuming the pair here is what keeps `\r` out of the
      // last field of every row in a file written on Windows.
      if (character === '\r' && body[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += character;
  }
  // The last record has no terminator: a file that does not end with a newline is still a file.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...data] = rows;
  if (header === undefined) return { columns: [], rows: [] };
  // A row shorter than the header is padded rather than dropped: the missing cell is a fact about
  // the row, and a corpus that silently loses rows cannot be reconciled against its own row count.
  const columns = header.map((name) => name.trim());
  return {
    columns,
    rows: data.map((cells) => columns.map((_name, index) => cells[index] ?? '')),
  };
}

/**
 * The corpus, with the four fields a reading uses pulled out of the row.
 *
 * The header check runs first and names the column that is missing. `Prompt` is required because a
 * question with no text is not a question; the other three are read when present and left empty
 * when not, because a reading of "can the engine pick the mark" does not need the reference code
 * and a reading of "is the answer right" does not need the mark.
 */
export function readText2Vis(text: string): Text2VisCorpus {
  const { columns, rows } = parseCsv(text);
  if (columns.length === 0) throw new Error('the Text2Vis file is empty: no header, so no column to read');
  const index = (name: string): number => columns.indexOf(name);
  if (index(TEXT2VIS_FIELDS.prompt) < 0) {
    throw new Error(
      `the Text2Vis file has no ${TEXT2VIS_FIELDS.prompt} column (it has ${columns.join(', ')}), so every question would be empty`,
    );
  }
  const at = (cells: readonly string[], name: string): string => {
    const position = index(name);
    return position < 0 ? '' : (cells[position] as string);
  };
  return {
    columns,
    rows: rows.map((cells) => ({
      prompt: at(cells, TEXT2VIS_FIELDS.prompt),
      answer: at(cells, TEXT2VIS_FIELDS.answer),
      code: at(cells, TEXT2VIS_FIELDS.code),
      chartType: at(cells, TEXT2VIS_FIELDS.chartType),
      // `cells[position]` is always present: `parseCsv` pads every row to the header's width, so
      // an index past the end is a row the parser would have dropped rather than shortened.
      raw: Object.fromEntries(columns.map((name, position) => [name, cells[position] as string])),
    })),
  };
}

/**
 * How many rows carry each chart type, most frequent first.
 *
 * The one reading the corpus can give without a model: it says what a rule has to beat, and it is
 * the denominator of every per-type score. Ties are broken by name rather than by insertion order,
 * because two runs over the same file have to print the same table.
 */
export function chartTypeCounts(corpus: Text2VisCorpus): readonly (readonly [string, number])[] {
  const counts = new Map<string, number>();
  for (const row of corpus.rows) {
    const name = row.chartType.length === 0 ? '(none)' : row.chartType;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

/** What a caller has to supply to read the corpus, and what it may override. */
export interface LoadOptions {
  /** The directory the file is cached in. Defaults to `TEXT2VIS_CACHE` or `eval/.cache/text2vis`. */
  readonly cacheDir?: string;
  /** Where to download it from. Defaults to the Hugging Face resolve URL. */
  readonly url?: string;
  /**
   * The transport.
   *
   * Injected rather than reached for so the suite can drive this over a real socket without a
   * network: the default is the runtime's own `fetch`, and the tests point it at a server they
   * started, which is the same seam `eval/bird/fetch.mjs` leaves open for its offline mode.
   */
  readonly fetchImpl?: typeof fetch;
}

/**
 * The corpus, from the cache when it is warm and from the network when it is not.
 *
 * The download is written to a temporary name and renamed, so a run that dies mid-transfer leaves
 * no file that a later run would happily parse as half a corpus. That is the whole reason this is
 * not a one-line `fetch().text()`: the failure mode of a truncated CSV is a *smaller* corpus, which
 * every reading downstream reports as a lower score rather than as a broken download.
 */
/**
 * Where the cache lives, resolved from the three places it can come from.
 *
 * A function rather than an expression inside the loader for one reason: the default is a path
 * under the repository, and a test that exercised it by not passing a directory would write into
 * the checkout. Splitting it out keeps the default covered without a test that leaves a 6.7 MB file
 * behind, and it is the same order the rest of `eval/` resolves a cache in
 * (`BIRD_CACHE ?? eval/.cache/bird`), so a workflow sets one variable per corpus.
 */
export function cacheDirFrom(options: { readonly cacheDir?: string }, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return options.cacheDir ?? env.TEXT2VIS_CACHE ?? `${cwd}/eval/.cache/text2vis`;
}

export async function loadText2Vis(
  options: LoadOptions = {},
): Promise<{ readonly corpus: Text2VisCorpus; readonly source: 'cache' | 'network'; readonly path: string }> {
  const { readFile, writeFile, rename, mkdir } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const cacheDir = cacheDirFrom(options);
  // Parsed at call time rather than at module load: `process.env` is read after a test can set it,
  // which is the difference between a workflow variable and one captured at import.
  const path = join(cacheDir, 'Text2Vis.csv');
  if (existsSync(path)) {
    return { corpus: readText2Vis(await readFile(path, 'utf8')), source: 'cache', path };
  }
  // The transport and the URL are two seams, not one: a test can point the loader at a server it
  // started, and another can leave the location alone and check that the default is the one the
  // module declares -- which is the only way to test a constant without a network.
  const transport = options.fetchImpl ?? fetch;
  const response = await transport(options.url ?? TEXT2VIS_URL);
  if (!response.ok) {
    throw new Error(`the Text2Vis file could not be downloaded: ${String(response.status)} ${response.statusText}`);
  }
  const text = await response.text();
  // Parsed before it is cached: a file that fails the header check should not become the cache a
  // later run trusts.
  const corpus = readText2Vis(text);
  await mkdir(cacheDir, { recursive: true });
  const staged = `${path}.part`;
  await writeFile(staged, text);
  await rename(staged, path);
  return { corpus, source: 'network', path };
}

/**
 * What the corpus holds, as lines a workflow log can carry.
 *
 * The shape of every other instrument in this repository: the numbers that make a later reading
 * interpretable (how many rows, which types, how many carry reference code) printed at load time,
 * so a run that reads a truncated file says so before it spends a single call.
 */
export function describeCorpus(corpus: Text2VisCorpus): readonly string[] {
  const withCode = corpus.rows.filter((row) => row.code.trim().length > 0).length;
  const withAnswer = corpus.rows.filter((row) => row.answer.trim().length > 0).length;
  return [
    `rows ${String(corpus.rows.length)}`,
    `columns ${String(corpus.columns.length)}`,
    `with reference code ${String(withCode)}`,
    `with an answer ${String(withAnswer)}`,
    ...chartTypeCounts(corpus).map(([name, count]) => `${name} ${String(count)}`),
  ];
}

/** True when this module is the process entry point rather than an import. */
export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  return argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
}

/**
 * The exit code this module contributes, or `undefined` when it was imported.
 *
 * Returned rather than assigned for `eval/bird/needs-train.ts`'s reason: a module-level `if` around
 * the assignment is a branch no test can execute, and this file cannot afford a line nobody covers.
 */
export async function entryExit(
  argv1: string | undefined,
  moduleUrl: string,
  log: (line: string) => void,
  options: LoadOptions = {},
): Promise<number | undefined> {
  if (!isEntry(argv1, moduleUrl)) return undefined;
  try {
    const { corpus, source, path } = await loadText2Vis(options);
    log(`text2vis: ${source} ${path}`);
    for (const line of describeCorpus(corpus)) log(line);
    return corpus.rows.length === 0 ? 1 : 0;
  } catch (error) {
    log(`text2vis: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/**
 * The one branch that cannot be covered by running the module: on import `entryExit` returns
 * `undefined`, so the assignment is a line only a direct call reaches.
 *
 * Exported for that reason, and written as a function so both of its states are a test rather than
 * a promise about the event loop.
 */
export function applyExitCode(code: number | undefined, target: { exitCode?: string | number | null }): void {
  if (code !== undefined) target.exitCode = code;
}

// `.then` rather than a top-level `await`: the branch that runs on import has to leave the caller's
// exit code exactly as it found it, and an awaited assignment here would be a statement every
// import executes rather than a statement only the entry point reaches.
void entryExit(process.argv[1], import.meta.url, (line) => process.stdout.write(`${line}\n`)).then((code) => {
  applyExitCode(code, process);
});
