import { describe, expect, it } from 'vitest';
import { classifyColumn, renderDefinitions, singularize } from '../src/definitions.js';
import type { SchemaTable } from '../src/linking.js';

/**
 * The definitions block is the one piece of prompt context that a customer
 * database can produce without a human-written data dictionary: grain, keys,
 * join direction and column roles, all derived from names, types and the
 * declared foreign keys. The tests therefore pin two things at once — the text
 * a model sees, and the honesty of the claim (a name-derived gloss says what the
 * name suggests, not what a business owner meant).
 */
describe('column roles', () => {
  it('reads an identifier from a name that ends in id', () => {
    expect(classifyColumn('customer_id', 'BIGINT')).toBe('identifier');
    expect(classifyColumn('customerId', 'BIGINT')).toBe('identifier');
    expect(classifyColumn('id', 'BIGINT')).toBe('identifier');
  });

  it('reads a boolean flag from is/has prefixes and flag suffixes', () => {
    expect(classifyColumn('is_active', 'BIGINT')).toBe('flag');
    expect(classifyColumn('has_shipped', 'BIGINT')).toBe('flag');
    expect(classifyColumn('refund_flag', 'TEXT')).toBe('flag');
  });

  it('reads a fraction before a count, because "percentage change" is not a count', () => {
    expect(classifyColumn('discount_rate', 'DOUBLE')).toBe('ratio');
    expect(classifyColumn('pct_change', 'DOUBLE')).toBe('ratio');
    expect(classifyColumn('success_ratio', 'DOUBLE')).toBe('ratio');
    expect(classifyColumn('quantity', 'BIGINT')).toBe('count');
    expect(classifyColumn('order_count', 'BIGINT')).toBe('count');
  });

  it('reads a monetary amount from the usual name stems', () => {
    expect(classifyColumn('total_amount', 'DOUBLE')).toBe('amount');
    expect(classifyColumn('unit_price', 'DOUBLE')).toBe('amount');
    expect(classifyColumn('revenue', 'DOUBLE')).toBe('amount');
    expect(classifyColumn('shipping_cost', 'DOUBLE')).toBe('amount');
    expect(classifyColumn('balance', 'DOUBLE')).toBe('amount');
  });

  it('separates a calendar date from a timestamp', () => {
    expect(classifyColumn('order_date', 'TEXT')).toBe('date');
    expect(classifyColumn('report_day', 'DATE')).toBe('date');
    expect(classifyColumn('created_at', 'TIMESTAMP')).toBe('timestamp');
    expect(classifyColumn('updated', 'DATETIME')).toBe('timestamp');
  });

  it('does not read a code as a count or a year label as a date', () => {
    // Both were produced by the first real run and both were wrong: BIRD's
    // "Charter School Number" holds a school code, "Academic Year" holds
    // '2012-2013'. A wrong gloss displaces a line that a real column needed.
    expect(classifyColumn('charter_school_number', 'VARCHAR')).toBe('text');
    expect(classifyColumn('academic_year', 'VARCHAR')).toBe('text');
    expect(classifyColumn('order_year', 'BIGINT')).toBe('number');
  });

  it('falls back on the declared type when the name says nothing', () => {
    expect(classifyColumn('label', 'TEXT')).toBe('text');
    expect(classifyColumn('label', 'VARCHAR(40)')).toBe('text');
    expect(classifyColumn('score', 'DOUBLE')).toBe('number');
    expect(classifyColumn('payload', 'BLOB')).toBe('other');
  });
});

describe('table names', () => {
  it('singularises the last segment only, so a join table keeps its owner', () => {
    expect(singularize('orders')).toBe('order');
    expect(singularize('categories')).toBe('category');
    expect(singularize('addresses')).toBe('address');
    expect(singularize('boxes')).toBe('box');
    expect(singularize('order_items')).toBe('order_item');
    expect(singularize('status')).toBe('status');
    expect(singularize('people')).toBe('person');
    expect(singularize('children')).toBe('child');
    expect(singularize('series')).toBe('series');
  });
});

const shop: readonly SchemaTable[] = [
  {
    table: 'customers',
    columns: [
      { name: 'customer_id', type: 'BIGINT' },
      { name: 'name', type: 'TEXT' },
      { name: 'region', type: 'TEXT' },
    ],
  },
  {
    table: 'orders',
    columns: [
      { name: 'order_id', type: 'BIGINT' },
      { name: 'customer_id', type: 'BIGINT' },
      { name: 'order_date', type: 'DATE' },
      { name: 'total_amount', type: 'DOUBLE' },
      { name: 'quantity', type: 'BIGINT' },
      { name: 'discount_rate', type: 'DOUBLE' },
      { name: 'is_paid', type: 'BIGINT' },
      { name: 'region', type: 'TEXT' },
    ],
    foreignKeys: ['orders.customer_id = customers.customer_id'],
  },
];

describe('rendered definitions', () => {
  it('states grain, join direction and role in that order', () => {
    expect(renderDefinitions(shop)).toBe(
      [
        '- customers: one row per customer (key: customer_id).',
        '- orders: one row per order (key: order_id).',
        '- orders.customer_id: foreign key to customers.customer_id; many orders per customer.',
        '- orders.order_date: calendar date, day precision.',
        '- orders.total_amount: monetary amount.',
        '- orders.quantity: count.',
        '- orders.discount_rate: fraction or rate.',
        '- orders.is_paid: yes/no flag.',
        '- "region" appears in customers and orders; each is its own column.',
      ].join('\n'),
    );
  });

  it('does not repeat a foreign key as a role line', () => {
    const text = renderDefinitions(shop);
    expect(text).not.toContain('orders.customer_id: identifier');
  });

  it('says nothing about a schema with nothing to infer', () => {
    expect(renderDefinitions([])).toBe('');
    expect(renderDefinitions([{ table: 'notes', columns: [{ name: 'body', type: 'TEXT' }] }])).toBe('');
  });

  it('describes a self reference without claiming a direction it cannot know', () => {
    const employees: SchemaTable[] = [
      {
        table: 'employees',
        columns: [
          { name: 'employee_id', type: 'BIGINT' },
          { name: 'manager_id', type: 'BIGINT' },
        ],
        foreignKeys: ['employees.manager_id = employees.employee_id'],
      },
    ];
    const text = renderDefinitions(employees);
    expect(text).toContain('employees.manager_id: foreign key to employees.employee_id (self reference)');
  });

  it('keeps a table without a single-column key from claiming a grain', () => {
    const log: SchemaTable[] = [{ table: 'events', columns: [{ name: 'kind', type: 'TEXT' }, { name: 'at', type: 'TIMESTAMP' }] }];
    const text = renderDefinitions(log);
    expect(text).not.toContain('one row per event');
    expect(text).toContain('events.at: timestamp.');
  });

  it('ignores a malformed join hint instead of rendering half of it', () => {
    const odd: SchemaTable[] = [
      {
        table: 'orders',
        columns: [{ name: 'customer_id', type: 'BIGINT' }],
        foreignKeys: ['orders.customer_id', 'nonsense'],
      },
    ];
    expect(renderDefinitions(odd)).toBe('');
  });

  it('cuts on a line boundary and never exceeds the budget', () => {
    const many: SchemaTable[] = [
      {
        table: 'facts',
        columns: Array.from({ length: 60 }, (_, index) => ({ name: `metric_amount_${index}`, type: 'DOUBLE' })),
      },
    ];
    const text = renderDefinitions(many, { maxChars: 200 });
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text.split('\n').every((line) => line.length > 0)).toBe(true);
    expect(text.endsWith('.')).toBe(true);
  });

  it('is deterministic for the same input', () => {
    expect(renderDefinitions(shop)).toBe(renderDefinitions(shop));
  });

  it('treats a column another table joins to as the key, whatever it is called', () => {
    const schools = [
      {
        table: 'schools',
        columns: [
          { name: 'CDSCode', type: 'VARCHAR' },
          { name: 'School Name', type: 'VARCHAR' },
        ],
      },
      {
        table: 'frpm',
        columns: [
          { name: 'CDSCode', type: 'VARCHAR' },
          { name: 'Enrollment (K-12)', type: 'DOUBLE' },
        ],
        foreignKeys: ['frpm.CDSCode = schools.CDSCode'],
      },
    ];
    const text = renderDefinitions(schools);
    expect(text).toContain('- schools: one row per school (key: CDSCode).');
    expect(text).toContain('- frpm.CDSCode: foreign key to schools.CDSCode; many frpm per school.');
  });

  it('does not call a shared join key ambiguous', () => {
    const text = renderDefinitions([
      { table: 'schools', columns: [{ name: 'CDSCode', type: 'VARCHAR' }] },
      {
        table: 'frpm',
        columns: [{ name: 'CDSCode', type: 'VARCHAR' }],
        foreignKeys: ['frpm.CDSCode = schools.CDSCode'],
      },
    ]);
    expect(text).not.toContain('appears in');
  });

  it('limits how many ambiguous names it names', () => {
    const wide: SchemaTable[] = ['a', 'b', 'c'].map((table) => ({
      table,
      columns: [
        { name: 'id', type: 'BIGINT' },
        { name: 'shared_one', type: 'TEXT' },
        { name: 'shared_two', type: 'TEXT' },
        { name: 'shared_three', type: 'TEXT' },
      ],
    }));
    const ambiguities = renderDefinitions(wide).split('\n').filter((line) => line.startsWith('- "'));
    expect(ambiguities).toHaveLength(2);
  });
});
