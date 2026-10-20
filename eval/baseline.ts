/**
 * A deterministic, non-LLM baseline. It exists to prove the harness can tell a
 * good predictor from a bad one: an oracle and an empty predictor bracket the
 * scale, and the template matcher sits somewhere in between.
 */
export interface GoldenCase {
  readonly id: string;
  readonly question: string;
  readonly goldSql: string;
  readonly tags: readonly string[];
}

const REGIONS = ['north', 'south', 'east', 'west'];
const CHANNELS = ['web', 'store'];

const SYNONYMS: Record<string, string> = {
  sales: 'revenue',
  amount: 'revenue',
  area: 'region',
  territory: 'region',
  monthly: 'month',
  per: 'by',
  units: 'quantity',
  unit: 'quantity',
  total: 'sum',
};

export function normalizeQuestion(question: string): string {
  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => SYNONYMS[word] ?? word);
  return words.join(' ');
}

interface Compiled {
  readonly measure: string;
  readonly dimensions: string[];
  readonly filter?: { column: string; value: string };
  readonly topN?: number;
  readonly from: string;
}

function pick(text: string, values: readonly string[]): string[] {
  return values.filter((value) => new RegExp(`\\b${value}\\b`).test(text));
}

function compile(text: string): Compiled | undefined {
  const dimensions: string[] = [];
  const region = pick(text, REGIONS);
  const channel = pick(text, CHANNELS);

  if (/\bby\s+region\s+and\s+channel\b/.test(text)) dimensions.push('region', 'channel');
  else {
    if (/\bby\s+region\b/.test(text)) dimensions.push('region');
    if (/\bby\s+channel\b/.test(text)) dimensions.push('channel');
    if (/\bby\s+product\b/.test(text)) dimensions.push('product');
    if (/\bby\s+segment\b/.test(text)) dimensions.push('segment');
  }
  if (/\bby\s+month\b|\bper\s+month\b|\bmonthly\b|\bmonth\b/.test(text)) dimensions.push('month');
  if (/\b(top|bottom)\s+\d+\s+products?\b/.test(text) && !dimensions.includes('product')) dimensions.push('product');

  let measure: string;
  if (/\bhow many distinct products\b|\bdistinct products\b/.test(text)) measure = 'count_products';
  else if (/\baverage order value\b|\baverage\b.*\b(amount|revenue)\b/.test(text)) measure = 'avg_amount';
  else if (/\baverage\b.*\bquantity\b/.test(text)) measure = 'avg_quantity';
  else if (/\bhow many orders\b|\border count\b|\bnumber of orders\b/.test(text)) measure = 'count_orders';
  else if (/\bmax\b.*\b(amount|revenue)\b/.test(text)) measure = 'max_amount';
  else if (/\bmin\b.*\b(amount|revenue)\b/.test(text)) measure = 'min_amount';
  else if (/\bmedian\b/.test(text)) return undefined;
  else if (/\btotal quantity\b|\bquantity\b/.test(text)) measure = 'sum_quantity';
  else if (/\brevenue\b|\bsum\b/.test(text)) measure = 'sum_amount';
  else if (/\bcustomers\b/.test(text)) measure = 'count_customers';
  else if (/\borders\b/.test(text)) measure = 'count_orders';
  else return undefined;

  const from = measure === 'count_customers' ? 'customers' : dimensions.includes('segment') ? 'join' : 'orders';
  const filter = region[0]
    ? { column: 'region', value: region[0] }
    : channel[0]
      ? { column: 'channel', value: channel[0] }
      : undefined;

  const top = /top\s+(\d+)/.exec(text);
  const compiled: Compiled = { measure, dimensions, from };
  return top ? { ...compiled, topN: Number(top[1]) } : filter ? { ...compiled, filter } : compiled;
}

const MEASURE_SQL: Record<string, { select: string; aggregate: boolean }> = {
  sum_amount: { select: 'sum(amount) as total', aggregate: true },
  count_orders: { select: 'count(*) as orders', aggregate: true },
  count_products: { select: 'count(distinct product) as products', aggregate: true },
  avg_amount: { select: 'avg(amount) as aov', aggregate: true },
  avg_quantity: { select: 'avg(quantity) as avg_quantity', aggregate: true },
  sum_quantity: { select: 'sum(quantity) as units', aggregate: true },
  max_amount: { select: 'max(amount) as max_amount', aggregate: true },
  min_amount: { select: 'min(amount) as min_amount', aggregate: true },
  count_customers: { select: 'count(*) as customers', aggregate: true },
};

export function templateSql(question: string, normalized: boolean): string | undefined {
  const text = normalized ? normalizeQuestion(question) : question.toLowerCase();
  const compiled = compile(text);
  if (!compiled) return undefined;
  const measure = MEASURE_SQL[compiled.measure];
  if (!measure) return undefined;

  if (compiled.from === 'customers') {
    return `select segment, ${measure.select} from customers group by segment order by segment`;
  }

  if (compiled.from === 'join') {
    if (compiled.dimensions.includes('segment')) {
      return `select c.segment, ${measure.select.replace(/\b(amount|quantity|product)\b/, 'o.$1')} from orders o join customers c on o.order_id = c.customer_id group by c.segment order by c.segment`;
    }
  }

  const dimensionSelect = compiled.dimensions.map((dimension) =>
    dimension === 'month' ? "date_trunc('month', order_date) as month" : dimension,
  );
  const groupBy = compiled.dimensions.map((_, index) => index + 1).join(', ');
  const where = compiled.filter ? ` where ${compiled.filter.column} = '${compiled.filter.value}'` : '';
  const order = compiled.topN ? ` order by ${measure.select.split(' ')[0]} desc limit ${compiled.topN}` : compiled.dimensions.length > 0 ? ' order by 1' : '';
  const prefix = dimensionSelect.length > 0 ? `${dimensionSelect.join(', ')}, ` : '';
  const grouping = compiled.dimensions.length > 0 ? ` group by ${groupBy}` : '';
  return `select ${prefix}${measure.select} from orders${where}${grouping}${order}`;
}

export function predict(kind: 'oracle' | 'empty' | 'template' | 'template-raw', testCase: GoldenCase): string {
  switch (kind) {
    case 'oracle':
      return testCase.goldSql;
    case 'empty':
      return 'select 1 as nothing where false';
    case 'template':
      return templateSql(testCase.question, true) ?? 'select 1 as nothing where false';
    case 'template-raw':
      return templateSql(testCase.question, false) ?? 'select 1 as nothing where false';
  }
}
