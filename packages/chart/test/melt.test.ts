import { describe, expect, it } from 'vitest';
import { meltWide } from '../src/index.js';

/**
 * The table the corpus is full of and the contract could not hold: one row per entity, one column per
 * period. Every assertion here is about the *predicate*, because a melt that fires on the wrong table
 * rewrites a result set into one the query did not return, and no downstream check can tell.
 */
const wide = [
  { country: 'Oman', '2019': 1203, '2020': 1180, '2021': 1164 },
  { country: 'Samoa', '2019': 200, '2020': 210, '2021': 219 },
];

describe('a table that is wide in time', () => {
  it('melts into one row per entity and period, and names the two columns it invents', () => {
    const melted = meltWide(wide);
    expect(melted?.entity).toBe('country');
    // A run of bare years gets a year axis; the measure column is the one name the table does not
    // supply, and `Value` is what it is called rather than a word borrowed from the data.
    expect(melted?.period).toBe('Year');
    expect(melted?.value).toBe('Value');
    expect(melted?.rows).toEqual([
      { country: 'Oman', Year: '2019', Value: 1203 },
      { country: 'Oman', Year: '2020', Value: 1180 },
      { country: 'Oman', Year: '2021', Value: 1164 },
      { country: 'Samoa', Year: '2019', Value: 200 },
      { country: 'Samoa', Year: '2020', Value: 210 },
      { country: 'Samoa', Year: '2021', Value: 219 },
    ]);
  });

  it('reads a run of months as a period rather than as a year it does not have', () => {
    const melted = meltWide([
      { country: 'Oman', '2019-01': 1, '2019-02': 2, '2019-03': 3 },
      { country: 'Samoa', '2019-01': 4, '2019-02': 5, '2019-03': 6 },
    ]);
    expect(melted?.period).toBe('Period');
  });

  it('omits the pair the table does not hold, because a missing cell is not a zero', () => {
    const melted = meltWide([
      { country: 'Oman', '2019': 1, '2020': null, '2021': 3 },
      { country: 'Samoa', '2019': 4, '2020': 5, '2021': 6 },
    ]);
    expect(melted?.rows).toHaveLength(5);
    expect(melted?.rows).not.toContainEqual({ country: 'Oman', Year: '2020', Value: 0 });
  });

  it('takes the caller’s column order rather than the object’s', () => {
    // `Object.keys` puts integer-like keys first, so a table whose periods are named `2019` enumerates
    // with the periods ahead of the entity — which would melt the entity column as a period.
    const melted = meltWide([{ '2019': 1, '2020': 2, '2021': 3, country: 'Oman' }], [
      'country',
      '2019',
      '2020',
      '2021',
    ]);
    expect(melted?.entity).toBe('country');
    expect(melted?.rows).toHaveLength(3);
  });

  it.each([
    ['an empty result set', []],
    ['three columns, because a pair is not a timeline', [{ a: 'x', '2019': 1, '2020': 2 }]],
    ['a column that is not a period', [{ a: 'x', '2019': 1, '2020': 2, revenue: 3 }]],
    ['a period column with a text cell', [{ a: 'x', '2019': 1, '2020': 'n/a', '2021': 3 }]],
    ['a nested cell, which no axis can measure', [{ a: 'x', '2019': [1], '2020': 2, '2021': 3 }]],
    [
      'an entity that appears twice, which would be one line drawn twice',
      [
        { a: 'x', '2019': 1, '2020': 2, '2021': 3 },
        { a: 'x', '2019': 4, '2020': 5, '2021': 6 },
      ],
    ],
    ['an entity with no name', [{ a: null, '2019': 1, '2020': 2, '2021': 3 }]],
    ['a period column with no number in it', [{ a: 'x', '2019': 1, '2020': 2, '2021': null }]],
    ['a first column already called Value', [{ Value: 'x', '2019': 1, '2020': 2, '2021': 3 }]],
    ['a first column already called Year', [{ Year: 'x', '2019': 1, '2020': 2, '2021': 3 }]],
    ['a first column that is itself a year', [{ '2018': 'x', '2019': 1, '2020': 2, '2021': 3 }]],
  ])('declines %s', (_name, rows) => {
    expect(meltWide(rows as never)).toBeUndefined();
  });
});
