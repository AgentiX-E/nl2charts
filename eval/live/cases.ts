/**
 * Generated benchmark set for the live NL -> SQL evaluation.
 *
 * The questions are written from the schema, not from the gold SQL: each intent
 * has several phrasings and several parameter values, so a template matcher
 * cannot win by memorising one sentence. The gold queries are executed against
 * the fixture before a model is called, which catches a broken case early.
 */
export interface LiveCase {
  readonly id: string;
  readonly intent: string;
  readonly question: string;
  readonly goldSql: string;
}

const REGIONS = ['north', 'south', 'east', 'west'] as const;
const CHANNELS = ['web', 'store'] as const;
const MONTHS = [
  { name: 'January 2026', from: '2026-01-01', to: '2026-02-01' },
  { name: 'February 2026', from: '2026-02-01', to: '2026-03-01' },
  { name: 'March 2026', from: '2026-03-01', to: '2026-04-01' },
  { name: 'April 2026', from: '2026-04-01', to: '2026-05-01' },
] as const;

const pick = <T,>(values: readonly T[], index: number): T => values[index % values.length] as T;

function phrasing(intent: string, variant: number, params: Record<string, string | number>): string {
  const options = PHRASINGS[intent] ?? [];
  const template = options[variant % options.length] ?? '';
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => String(params[key] ?? ''));
}

const PHRASINGS: Record<string, readonly string[]> = {
  revenue_by_region: [
    'What is the total revenue by region?',
    'Show total revenue for each region.',
    'Break revenue down by region.',
  ],
  revenue_by_channel: [
    'What is total revenue by channel?',
    'Show revenue per channel.',
    'Break down revenue by sales channel.',
  ],
  revenue_by_segment: [
    'What is total revenue by customer segment?',
    'Show revenue for each customer segment.',
    'Break revenue down by segment.',
  ],
  orders_by_region: [
    'How many orders are there by region?',
    'Count orders per region.',
    'Show the number of orders in each region.',
  ],
  avg_amount_by_region: [
    'What is the average order amount by region?',
    'Show the average amount for each region.',
    'Average order value per region.',
  ],
  tax_by_region: [
    'What is the total tax by region?',
    'Sum the tax for each region.',
    'Show total tax per region.',
  ],
  monthly_revenue: [
    'What is the monthly revenue?',
    'Show revenue by month.',
    'Revenue per month over time.',
  ],
  top_regions: [
    'Which {n} regions have the highest revenue?',
    'Show the top {n} regions by revenue.',
    'List the {n} best regions by total revenue.',
  ],
  revenue_for_region: [
    'What is the total revenue in the {region} region?',
    'Show revenue for {region}.',
    'How much revenue did {region} generate?',
  ],
  orders_for_channel: [
    'How many orders came through {channel}?',
    'Count orders for the {channel} channel.',
    'Number of {channel} orders.',
  ],
  revenue_by_region_channel: [
    'What is revenue by region and channel?',
    'Show revenue for every region and channel combination.',
    'Break revenue down by region and channel.',
  ],
  completed_revenue_by_region: [
    'What is the completed revenue by region?',
    'Show revenue from completed orders for each region.',
    'Sum completed order amounts per region.',
  ],
  monthly_orders: [
    'How many orders are there per month?',
    'Count orders by month.',
    'Show the number of orders each month.',
  ],
  avg_amount_by_channel: [
    'What is the average order amount by channel?',
    'Show the average amount per channel.',
    'Average order value for each channel.',
  ],
  customers_by_segment: [
    'How many customers are in each segment?',
    'Count customers by segment.',
    'Show the number of customers per segment.',
  ],
  max_amount_by_region: [
    'What is the largest order amount by region?',
    'Show the maximum order amount for each region.',
    'Max order amount per region.',
  ],
  min_amount_by_channel: [
    'What is the smallest order amount by channel?',
    'Show the minimum order amount for each channel.',
    'Min order amount per channel.',
  ],
  revenue_by_segment_region: [
    'What is revenue by segment and region?',
    'Show revenue for each segment and region pair.',
    'Break revenue down by segment and region.',
  ],
  orders_in_month: [
    'How many orders were placed in {month}?',
    'Count orders in {month}.',
    'Number of orders during {month}.',
  ],
  revenue_in_month: [
    'What was the revenue in {month}?',
    'Show total revenue for {month}.',
    'How much revenue did {month} produce?',
  ],
};

interface Builder {
  readonly intent: string;
  readonly build: (index: number, variant: number) => LiveCase;
}

const builders: readonly Builder[] = [
  {
    intent: 'revenue_by_region',
    build: (index, variant) => ({
      id: `rev-region-${index}`,
      intent: 'revenue_by_region',
      question: phrasing('revenue_by_region', variant, {}),
      goldSql: 'select region, sum(amount) as revenue from orders group by region order by region',
    }),
  },
  {
    intent: 'revenue_by_channel',
    build: (index, variant) => ({
      id: `rev-channel-${index}`,
      intent: 'revenue_by_channel',
      question: phrasing('revenue_by_channel', variant, {}),
      goldSql: 'select channel, sum(amount) as revenue from orders group by channel order by channel',
    }),
  },
  {
    intent: 'revenue_by_segment',
    build: (index, variant) => ({
      id: `rev-segment-${index}`,
      intent: 'revenue_by_segment',
      question: phrasing('revenue_by_segment', variant, {}),
      goldSql:
        'select c.segment, sum(o.amount) as revenue from orders o join customers c on o.customer_id = c.customer_id group by c.segment order by c.segment',
    }),
  },
  {
    intent: 'orders_by_region',
    build: (index, variant) => ({
      id: `orders-region-${index}`,
      intent: 'orders_by_region',
      question: phrasing('orders_by_region', variant, {}),
      goldSql: 'select region, count(*) as orders from orders group by region order by region',
    }),
  },
  {
    intent: 'avg_amount_by_region',
    build: (index, variant) => ({
      id: `avg-region-${index}`,
      intent: 'avg_amount_by_region',
      question: phrasing('avg_amount_by_region', variant, {}),
      goldSql: 'select region, avg(amount) as average_amount from orders group by region order by region',
    }),
  },
  {
    intent: 'tax_by_region',
    build: (index, variant) => ({
      id: `tax-region-${index}`,
      intent: 'tax_by_region',
      question: phrasing('tax_by_region', variant, {}),
      goldSql: 'select region, sum(tax) as total_tax from orders group by region order by region',
    }),
  },
  {
    intent: 'monthly_revenue',
    build: (index, variant) => ({
      id: `monthly-revenue-${index}`,
      intent: 'monthly_revenue',
      question: phrasing('monthly_revenue', variant, {}),
      goldSql:
        "select date_trunc('month', order_date) as month, sum(amount) as revenue from orders group by 1 order by 1",
    }),
  },
  {
    intent: 'top_regions',
    build: (index, variant) => {
      const n = 2 + (index % 3);
      return {
        id: `top-regions-${index}`,
        intent: 'top_regions',
        question: phrasing('top_regions', variant, { n }),
        goldSql: `select region, sum(amount) as revenue from orders group by region order by revenue desc limit ${n}`,
      };
    },
  },
  {
    intent: 'revenue_for_region',
    build: (index, variant) => {
      const region = pick(REGIONS, index);
      return {
        id: `rev-for-region-${index}`,
        intent: 'revenue_for_region',
        question: phrasing('revenue_for_region', variant, { region }),
        goldSql: `select sum(amount) as revenue from orders where region = '${region}'`,
      };
    },
  },
  {
    intent: 'orders_for_channel',
    build: (index, variant) => {
      const channel = pick(CHANNELS, index);
      return {
        id: `orders-channel-${index}`,
        intent: 'orders_for_channel',
        question: phrasing('orders_for_channel', variant, { channel }),
        goldSql: `select count(*) as orders from orders where channel = '${channel}'`,
      };
    },
  },
  {
    intent: 'revenue_by_region_channel',
    build: (index, variant) => ({
      id: `rev-region-channel-${index}`,
      intent: 'revenue_by_region_channel',
      question: phrasing('revenue_by_region_channel', variant, {}),
      goldSql:
        'select region, channel, sum(amount) as revenue from orders group by region, channel order by region, channel',
    }),
  },
  {
    intent: 'completed_revenue_by_region',
    build: (index, variant) => ({
      id: `completed-rev-${index}`,
      intent: 'completed_revenue_by_region',
      question: phrasing('completed_revenue_by_region', variant, {}),
      goldSql:
        "select region, sum(amount) as revenue from orders where status = 'completed' group by region order by region",
    }),
  },
  {
    intent: 'monthly_orders',
    build: (index, variant) => ({
      id: `monthly-orders-${index}`,
      intent: 'monthly_orders',
      question: phrasing('monthly_orders', variant, {}),
      goldSql:
        "select date_trunc('month', order_date) as month, count(*) as orders from orders group by 1 order by 1",
    }),
  },
  {
    intent: 'avg_amount_by_channel',
    build: (index, variant) => ({
      id: `avg-channel-${index}`,
      intent: 'avg_amount_by_channel',
      question: phrasing('avg_amount_by_channel', variant, {}),
      goldSql: 'select channel, avg(amount) as average_amount from orders group by channel order by channel',
    }),
  },
  {
    intent: 'customers_by_segment',
    build: (index, variant) => ({
      id: `customers-segment-${index}`,
      intent: 'customers_by_segment',
      question: phrasing('customers_by_segment', variant, {}),
      goldSql: 'select segment, count(*) as customers from customers group by segment order by segment',
    }),
  },
  {
    intent: 'max_amount_by_region',
    build: (index, variant) => ({
      id: `max-region-${index}`,
      intent: 'max_amount_by_region',
      question: phrasing('max_amount_by_region', variant, {}),
      goldSql: 'select region, max(amount) as max_amount from orders group by region order by region',
    }),
  },
  {
    intent: 'min_amount_by_channel',
    build: (index, variant) => ({
      id: `min-channel-${index}`,
      intent: 'min_amount_by_channel',
      question: phrasing('min_amount_by_channel', variant, {}),
      goldSql: 'select channel, min(amount) as min_amount from orders group by channel order by channel',
    }),
  },
  {
    intent: 'revenue_by_segment_region',
    build: (index, variant) => ({
      id: `rev-segment-region-${index}`,
      intent: 'revenue_by_segment_region',
      question: phrasing('revenue_by_segment_region', variant, {}),
      goldSql:
        'select c.segment, o.region, sum(o.amount) as revenue from orders o join customers c on o.customer_id = c.customer_id group by c.segment, o.region order by c.segment, o.region',
    }),
  },
  {
    intent: 'orders_in_month',
    build: (index, variant) => {
      const month = pick(MONTHS, index);
      return {
        id: `orders-month-${index}`,
        intent: 'orders_in_month',
        question: phrasing('orders_in_month', variant, { month: month.name }),
        goldSql: `select count(*) as orders from orders where order_date >= DATE '${month.from}' and order_date < DATE '${month.to}'`,
      };
    },
  },
  {
    intent: 'revenue_in_month',
    build: (index, variant) => {
      const month = pick(MONTHS, index);
      return {
        id: `revenue-month-${index}`,
        intent: 'revenue_in_month',
        question: phrasing('revenue_in_month', variant, { month: month.name }),
        goldSql: `select sum(amount) as revenue from orders where order_date >= DATE '${month.from}' and order_date < DATE '${month.to}'`,
      };
    },
  },
];

/** 20 intents x 10 variants + 10 extra parameter cases = 210. */
export function liveCases(): LiveCase[] {
  const cases: LiveCase[] = [];
  for (const builder of builders) {
    for (let index = 0; index < 10; index += 1) cases.push(builder.build(index, index));
  }
  for (let extra = 0; extra < 10; extra += 1) {
    const builder = builders[extra % builders.length] as Builder;
    cases.push(builder.build(10 + extra, extra));
  }
  const ids = new Set(cases.map((entry) => entry.id));
  if (ids.size !== cases.length) throw new Error('generated case ids are not unique');
  return cases;
}

export const liveSchema = [
  {
    table: 'orders',
    columns: [
      { name: 'order_id', type: 'BIGINT', comment: 'order identifier' },
      { name: 'customer_id', type: 'BIGINT', comment: 'customer who placed the order' },
      { name: 'order_date', type: 'DATE', comment: 'date the order was placed' },
      { name: 'region', type: 'VARCHAR', samples: ['north', 'south', 'east', 'west'], comment: 'sales region' },
      { name: 'channel', type: 'VARCHAR', samples: ['web', 'store'], comment: 'sales channel' },
      { name: 'amount', type: 'DECIMAL', comment: 'total amount charged for the order' },
      { name: 'tax', type: 'DECIMAL', comment: 'tax charged for the order' },
      { name: 'status', type: 'VARCHAR', samples: ['completed', 'refunded'], comment: 'order status' },
    ],
  },
  {
    table: 'customers',
    columns: [
      { name: 'customer_id', type: 'BIGINT', comment: 'customer identifier' },
      { name: 'segment', type: 'VARCHAR', samples: ['smb', 'enterprise', 'consumer'], comment: 'customer segment' },
    ],
  },
  {
    table: 'order_items',
    columns: [
      { name: 'item_id', type: 'BIGINT', comment: 'line item identifier' },
      { name: 'order_id', type: 'BIGINT', comment: 'order this line belongs to' },
      { name: 'quantity', type: 'INTEGER', comment: 'units in this line item' },
      { name: 'price', type: 'DECIMAL', comment: 'unit price of one item' },
    ],
  },
] as const;
