/**
 * Adversarial cases: the shapes that the aggregate BIRD score hides.
 *
 * BIRD's own questions are mostly filter-and-aggregate. Four shapes decide
 * whether a system is usable on real analysis, and none of them can be read off
 * an aggregate accuracy:
 *
 *   window      ranking, running totals, previous-row deltas
 *   ratio       division with a defensible zero case (NULLIF, not a crash)
 *   multi-hop   three or more joins where the join key itself is the question
 *   tie         "the most" when several rows share the maximum
 *
 * Every case is hand-written against the BIRD Mini-Dev databases, so the gold
 * statement can be read and checked by a human. The runner executes all of them
 * before a model is called; a case whose gold returns nothing is a bug in this
 * file, not a result.
 */
export type Category = 'window' | 'ratio' | 'multi-hop' | 'tie';

export interface AdversarialCase {
  readonly id: string;
  readonly category: Category;
  /** What this case is designed to catch, in one line. */
  readonly probes: string;
  readonly db: string;
  readonly question: string;
  readonly evidence?: string;
  readonly sql: string;
}

const formula = 'formula_1';
const superhero = 'superhero';
const debit = 'debit_card_specializing';
const student = 'student_club';
const tox = 'toxicology';
const throm = 'thrombosis_prediction';

export const CASES: readonly AdversarialCase[] = [
  // ---------------------------------------------------------------- window
  {
    id: 'w1',
    category: 'window',
    probes: 'RANK over a grouped sum, ties share a rank',
    db: formula,
    question:
      'For the 2009 season, report exactly two columns: the driver surname and their rank by total points, highest first. Drivers on equal points share a rank.',
    sql: `select d.surname, rank() over (order by sum(r.points) desc) as rnk
from results r
join races ra on r.raceId = ra.raceId
join drivers d on r.driverId = d.driverId
where ra.year = 2009
group by d.driverId, d.surname
having sum(r.points) > 0
order by rnk, d.surname`,
  },
  {
    id: 'w2',
    category: 'window',
    probes: 'LAG over a ranked list; the first row has a NULL delta',
    db: formula,
    question:
      'Rank drivers by career points, highest first. Report exactly three columns: surname, career points and the gap to the driver directly above in that ranking; the top driver has an empty gap. Report only the first 25 drivers.',
    sql: `with career as (
  select d.driverId, d.surname, sum(r.points) as pts
  from results r join drivers d on r.driverId = d.driverId
  group by d.driverId, d.surname
)
select surname, pts, pts - lag(pts) over (order by pts desc, surname) as gap
from career
order by pts desc, surname
limit 25`,
  },
  {
    id: 'w3',
    category: 'window',
    probes: 'RANK on an aggregate count, ties are common here',
    db: superhero,
    question:
      'Rank publishers that have at least one hero by their hero count, most first. Report exactly three columns: publisher name, hero count and rank; publishers with the same count share a rank.',
    sql: `select p.publisher_name, count(s.id) as heroes,
       rank() over (order by count(s.id) desc) as rnk
from publisher p
join superhero s on s.publisher_id = p.id
group by p.id, p.publisher_name
order by rnk, p.publisher_name`,
  },
  {
    id: 'w4',
    category: 'window',
    probes: 'per-group maximum with ties (rank = 1 inside a partition)',
    db: superhero,
    question:
      'For each publisher that has heroes with a recorded weight, list the heaviest hero or heroes with exactly three columns: publisher name, hero name and weight. Every hero that shares the maximum weight within its publisher must appear.',
    sql: `with ranked as (
  select p.publisher_name, s.superhero_name, s.weight_kg,
         rank() over (partition by p.id order by s.weight_kg desc) as rnk
  from superhero s join publisher p on s.publisher_id = p.id
  where s.weight_kg is not null
)
select publisher_name, superhero_name, weight_kg
from ranked where rnk = 1
order by publisher_name, superhero_name`,
  },
  {
    id: 'w5',
    category: 'window',
    probes: 'window function over text dates (YYYYMM) inside a partition',
    db: debit,
    question:
      'For each customer, report exactly three columns: customer id, the month with their highest total consumption, and that total. If several months share the maximum, report each of them. Report at most 40 rows.',
    sql: `with monthly as (
  select CustomerID, Date as month, sum(Consumption) as total
  from yearmonth
  group by CustomerID, Date
), ranked as (
  select CustomerID, month, total,
         rank() over (partition by CustomerID order by total desc) as rnk
  from monthly
)
select CustomerID, month, total from ranked where rnk = 1
order by CustomerID, month
limit 40`,
  },
  {
    id: 'w6',
    category: 'window',
    probes: 'aggregate joined to a per-group count, then ranked',
    db: student,
    question:
      'List events that had at least one attendee, with exactly three columns: event name, attendee count and rank by attendance, most first. Events with equal attendance share a rank.',
    sql: `select e.event_name, count(a.link_to_member) as attendees,
       rank() over (order by count(a.link_to_member) desc) as rnk
from event e
join attendance a on a.link_to_event = e.event_id
group by e.event_id, e.event_name
order by rnk, e.event_name`,
  },
  {
    id: 'w7',
    category: 'window',
    probes: 'running total over a grouped count',
    db: tox,
    question:
      'Count the atoms of each element, then report exactly three columns: element, atom count and a running total of those counts from the most common element downwards.',
    sql: `with counts as (
  select element, count(*) as atoms from atom group by element
)
select element, atoms, sum(atoms) over (order by atoms desc, element) as running_total
from counts
order by atoms desc, element`,
  },
  {
    id: 'w8',
    category: 'window',
    probes: 'date arithmetic between consecutive rows of the same patient',
    db: throm,
    question:
      'For each patient with at least two examinations, report exactly three columns: patient id, examination date and the number of days until their next examination; the last examination has an empty gap. Report at most 40 rows.',
    sql: `with visits as (
  select ID, "Examination Date" as seen,
         lead("Examination Date") over (partition by ID order by "Examination Date") as next_seen,
         count(*) over (partition by ID) as visits
  from Examination
)
select ID, seen, cast(julianday(next_seen) - julianday(seen) as integer) as days_to_next
from visits
where visits > 1
order by ID, seen
limit 40`,
  },

  // ----------------------------------------------------------------- ratio
  {
    id: 'r1',
    category: 'ratio',
    probes: 'ratio of a filtered count to a total, cast to REAL',
    db: superhero,
    question: 'What fraction of heroes are taller than 180 cm? Report exactly one column: the ratio.',
    sql: `select cast(sum(case when height_cm > 180 then 1 else 0 end) as real) / count(*) as ratio
from superhero where height_cm is not null`,
  },
  {
    id: 'r2',
    category: 'ratio',
    probes: 'division guarded by NULLIF; a zero denominator must not crash',
    db: superhero,
    question:
      'For each publisher, report exactly two columns: publisher name and the ratio of male heroes to female heroes. A publisher with no female hero has an empty ratio.',
    sql: `select p.publisher_name,
       cast(sum(case when g.gender = 'Male' then 1 else 0 end) as real)
         / nullif(sum(case when g.gender = 'Female' then 1 else 0 end), 0) as male_to_female
from superhero s
join publisher p on s.publisher_id = p.id
join gender g on s.gender_id = g.id
group by p.id, p.publisher_name
order by p.publisher_name`,
  },
  {
    id: 'r3',
    category: 'ratio',
    probes: 'conditional proportion across two tables',
    db: throm,
    question:
      'Among patients whose ANA value is greater than 0, what proportion has a thrombosis flag of 1 or more? Report exactly one column: the proportion.',
    sql: `select cast(sum(case when e.Thrombosis = 1 then 1 else 0 end) as real) / count(distinct e.ID) as ratio
from Examination e
where e.ANA > 0`,
  },
  {
    id: 'r4',
    category: 'ratio',
    probes: 'ratio of a sum to a sum, joined per event',
    db: student,
    question: 'For each event with a budget, report exactly two columns: event name and the fraction of the budget amount that was spent.',
    sql: `select e.event_name, b.spent / cast(b.amount as real) as spent_fraction
from budget b join event e on b.link_to_event = e.event_id
where b.amount > 0
order by e.event_name`,
  },
  {
    id: 'r5',
    category: 'ratio',
    probes: 'ratio between two filtered counts in the same table',
    db: debit,
    question:
      "Among customers whose currency is CZK, what is the ratio of transactions paid in CZK to transactions paid in EUR? Report exactly one column: the ratio.",
    sql: `select cast(sum(case when c.Currency = 'CZK' then 1 else 0 end) as real)
         / nullif(sum(case when c.Currency = 'EUR' then 1 else 0 end), 0) as ratio
from transactions_1k t
join customers c on t.CustomerID = c.CustomerID
where c.Currency = 'CZK'`,
  },
  {
    id: 'r6',
    category: 'ratio',
    probes: 'share of a set that satisfies a condition across a join',
    db: formula,
    question:
      'What share of the 2009 races had at least one retirement, that is, at least one result whose status is not Finished? Report exactly one column: the share.',
    sql: `select cast(sum(case when retired > 0 then 1 else 0 end) as real) / count(*) as share
from (
  select ra.raceId,
         sum(case when st.status <> 'Finished' then 1 else 0 end) as retired
  from races ra
  join results r on r.raceId = ra.raceId
  join status st on st.statusId = r.statusId
  where ra.year = 2009
  group by ra.raceId
)`,
  },
  {
    id: 'r7',
    category: 'ratio',
    probes: 'proportion over a two-value label',
    db: tox,
    question: 'What fraction of molecules are labelled active, that is, labelled +? Report exactly one column: the fraction.',
    sql: `select cast(sum(case when label = '+' then 1 else 0 end) as real) / count(*) as ratio from molecule`,
  },
  {
    id: 'r8',
    category: 'ratio',
    probes: 'per-group share with a guard against an empty denominator',
    db: student,
    question:
      'For each major that has members, report exactly two columns: major name and the share of its members whose position contains Executive.',
    sql: `select m.major_name,
       cast(sum(case when mb.position like '%Executive%' then 1 else 0 end) as real) / count(*) as share
from major m
join member mb on mb.link_to_major = m.major_id
group by m.major_id, m.major_name
order by m.major_name`,
  },

  // ------------------------------------------------------------- multi-hop
  {
    id: 'm1',
    category: 'multi-hop',
    probes: 'three joins through a many-to-many table',
    db: superhero,
    question: "Which publishers have heroes with the power named 'Super Strength'? Report exactly two columns: publisher name and the number of such heroes.",
    sql: `select p.publisher_name, count(distinct s.id) as heroes
from publisher p
join superhero s on s.publisher_id = p.id
join hero_power hp on hp.hero_id = s.id
join superpower sp on sp.id = hp.power_id
where sp.power_name = 'Super Strength'
group by p.id, p.publisher_name
order by heroes desc, p.publisher_name`,
  },
  {
    id: 'm2',
    category: 'multi-hop',
    probes: 'four tables; the join key carries the question (nationality)',
    db: formula,
    question: 'List the circuits that hosted at least one race won by a British driver. Report exactly one column, the circuit name, with each circuit once.',
    sql: `select distinct c.name
from results r
join drivers d on r.driverId = d.driverId
join races ra on r.raceId = ra.raceId
join circuits c on ra.circuitId = c.circuitId
where r.positionOrder = 1 and d.nationality = 'British'
order by c.name`,
  },
  {
    id: 'm3',
    category: 'multi-hop',
    probes: 'four hops ending in a status filter',
    db: student,
    question:
      'List the members who have an expense charged to an event that is still open. Report exactly two columns, first name and last name, with each member once.',
    sql: `select distinct mb.first_name, mb.last_name
from member mb
join expense ex on ex.link_to_member = mb.member_id
join budget b on ex.link_to_budget = b.budget_id
join event e on b.link_to_event = e.event_id
where e.status = 'Open'
order by mb.last_name, mb.first_name`,
  },
  {
    id: 'm4',
    category: 'multi-hop',
    probes: 'two tables, a window-free earliest row and a having clause',
    db: throm,
    question:
      'For each patient, count the laboratory tests recorded before their first examination. Report exactly two columns, patient id and that count, for patients with more than twenty such tests, ordered by the count descending.',
    sql: `with first_exam as (
  select ID, min("Examination Date") as exam_date from Examination group by ID
)
select l.ID, count(*) as tests_before
from Laboratory l
join first_exam f on f.ID = l.ID
where l.Date < f.exam_date
group by l.ID
having count(*) > 20
order by tests_before desc, l.ID`,
  },
  {
    id: 'm5',
    category: 'multi-hop',
    probes: 'three tables where the grouping key is two hops away',
    db: debit,
    question:
      "For each gas station chain that has transactions from customers in the segment 'KAM', report exactly two columns: chain id and the number of such transactions.",
    sql: `select g.ChainID, count(*) as transactions
from transactions_1k t
join gasstations g on t.GasStationID = g.GasStationID
join customers c on t.CustomerID = c.CustomerID
where c.Segment = 'KAM'
group by g.ChainID
order by g.ChainID`,
  },
  {
    id: 'm6',
    category: 'multi-hop',
    probes: 'self-join through a link table',
    db: tox,
    question: 'How many bonds connect two atoms of the same element? Report exactly one column: the count.',
    sql: `select count(*) as bonds
from connected c
join atom a1 on a1.atom_id = c.atom_id
join atom a2 on a2.atom_id = c.atom_id2
where a1.element = a2.element`,
  },
  {
    id: 'm7',
    category: 'multi-hop',
    probes: 'intersection of two many-to-many sets',
    db: superhero,
    question: "List the heroes who have both the power 'Super Strength' and the power 'Flight'. Report exactly one column, the hero name, with each hero once.",
    sql: `select s.superhero_name
from superhero s
where exists (
  select 1 from hero_power hp join superpower sp on sp.id = hp.power_id
  where hp.hero_id = s.id and sp.power_name = 'Super Strength'
) and exists (
  select 1 from hero_power hp join superpower sp on sp.id = hp.power_id
  where hp.hero_id = s.id and sp.power_name = 'Flight'
)
order by s.superhero_name`,
  },
  {
    id: 'm8',
    category: 'multi-hop',
    probes: 'three hops with a having clause on a count',
    db: student,
    question:
      'Which majors have members who attended more than five events? Report exactly two columns: major name and the number of such members, one row per major.',
    sql: `select m.major_name, count(*) as members
from major m
join member mb on mb.link_to_major = m.major_id
where mb.member_id in (
  select a.link_to_member from attendance a
  group by a.link_to_member having count(distinct a.link_to_event) > 5
)
group by m.major_id, m.major_name
order by m.major_name`,
  },

  // ------------------------------------------------------------------- tie
  {
    id: 't1',
    category: 'tie',
    probes: 'maximum with ties; LIMIT 1 would be wrong',
    db: formula,
    question: 'Which driver won the most races in 2008? Report exactly two columns: driver surname and win count, for every driver tied for the most wins.',
    sql: `with wins as (
  select d.surname, count(*) as wins
  from results r
  join races ra on r.raceId = ra.raceId
  join drivers d on r.driverId = d.driverId
  where ra.year = 2008 and r.positionOrder = 1
  group by d.driverId, d.surname
)
select surname, wins from wins where wins = (select max(wins) from wins)`,
  },
  {
    id: 't2',
    category: 'tie',
    probes: 'most frequent entity in a log, ties must all appear',
    db: debit,
    question:
      'Which gas station chain appears most often in the transactions table? Report exactly two columns: chain id and transaction count, for every chain tied for the most.',
    sql: `with counts as (
  select g.ChainID, count(*) as transactions
  from transactions_1k t
  join gasstations g on t.GasStationID = g.GasStationID
  group by g.ChainID
)
select ChainID, transactions from counts where transactions = (select max(transactions) from counts)
order by ChainID`,
  },
  {
    id: 't3',
    category: 'tie',
    probes: 'maximum of a count with a shared top',
    db: superhero,
    question: 'Which publisher has the most heroes? Report exactly two columns: publisher name and hero count, for every publisher tied for the most.',
    sql: `with counts as (
  select p.publisher_name, count(s.id) as heroes
  from publisher p join superhero s on s.publisher_id = p.id
  group by p.id, p.publisher_name
)
select publisher_name, heroes from counts where heroes = (select max(heroes) from counts)`,
  },
  {
    id: 't4',
    category: 'tie',
    probes: 'maximum attendance, several events can tie',
    db: student,
    question: 'Which event had the most attendees? Report exactly two columns: event name and attendee count, for every event tied for the most.',
    sql: `with counts as (
  select e.event_name, count(a.link_to_member) as attendees
  from event e join attendance a on a.link_to_event = e.event_id
  group by e.event_id, e.event_name
)
select event_name, attendees from counts where attendees = (select max(attendees) from counts)
order by event_name`,
  },
  {
    id: 't5',
    category: 'tie',
    probes: 'mode of a categorical column with a tie',
    db: throm,
    question: 'Which diagnosis is the most common? Report exactly two columns: diagnosis and patient count, for every diagnosis tied for the most.',
    sql: `with counts as (
  select Diagnosis, count(distinct ID) as patients
  from Examination where Diagnosis is not null
  group by Diagnosis
)
select Diagnosis, patients from counts where patients = (select max(patients) from counts)
order by Diagnosis`,
  },
  {
    id: 't6',
    category: 'tie',
    probes: 'maximum of a grouped count over a secondary table',
    db: tox,
    question: 'Which molecule has the most atoms? Report exactly two columns: molecule id and atom count, for every molecule tied for the most.',
    sql: `with counts as (
  select molecule_id, count(*) as atoms from atom group by molecule_id
)
select molecule_id, atoms from counts where atoms = (select max(atoms) from counts)
order by molecule_id`,
  },
  {
    id: 't7',
    category: 'tie',
    probes: 'maximum restricted by a filter, ties included',
    db: superhero,
    question:
      'Among heroes weighing more than 100 kg, which race has the most heroes? Report exactly two columns: race name and hero count, for every race tied for the most.',
    sql: `with counts as (
  select r.race, count(*) as heroes
  from superhero s join race r on s.race_id = r.id
  where s.weight_kg > 100
  group by r.id, r.race
)
select race, heroes from counts where heroes = (select max(heroes) from counts)
order by race`,
  },
  {
    id: 't8',
    category: 'tie',
    probes: 'most frequent item in a transaction log, ties included',
    db: debit,
    question: 'Which product was bought most often in 2012? Report exactly two columns: product description and transaction count, for every product tied for the most.',
    sql: `with counts as (
  select p.Description, count(*) as purchases
  from transactions_1k t
  join products p on p.ProductID = t.ProductID
  where t.Date like '2012%'
  group by p.ProductID, p.Description
)
select Description, purchases from counts where purchases = (select max(purchases) from counts)
order by Description`,
  },
];
