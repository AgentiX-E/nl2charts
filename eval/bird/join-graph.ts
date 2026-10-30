/**
 * The foreign-key graph, and the closure the two instruments share.
 *
 * Split out of `join.ts` when the closure stopped being only a measurement: the prune arm sends
 * the closure instead of the card, so the rule that decides which tables a question can reach is
 * the same rule in the probe and in the prompt. Two implementations of "one hop" would let the
 * published coverage and the shipped card disagree, and the disagreement would be invisible —
 * the instrument would keep reporting 95.2% while the prompt sent something else.
 *
 * Nothing here reads the corpus, the report or a model: the edges come from the manifest's
 * column indices, and a closure is a walk over a name-to-neighbours map.
 */
import type { BirdTable } from './data.js';

/**
 * Where the edges come from.
 *
 * `manifest` is what the dataset declares. `shared` adds an edge between two tables that carry a
 * column of the same name, which is how BIRD's own statements join (`T1.GasStationID =
 * T2.GasStationID`) and how several of its manifests fail to describe themselves. The two are
 * reported apart because they trade coverage for saving: a denser graph reaches more of the gold
 * and has less left to cut.
 */
export const EDGE_SOURCES = ['manifest', 'shared'] as const;
export type EdgeSource = (typeof EDGE_SOURCES)[number];

/**
 * A shared column stops being evidence of a join when it is everywhere.
 *
 * `year`, `name` and `id` appear in most tables of most databases, and connecting every table
 * that carries one would make the closure the whole card. A column shared by more than a third of
 * a database's tables is treated as vocabulary rather than a key; the floor keeps a two- or
 * three-table database readable, where a third is less than one table.
 */
export const SHARED_SHARE = 0.3;

/** The foreign-key graph of one database, as table names and a name-to-neighbours map. */
export interface JoinGraph {
  /** Undirected edges, one per join the graph knows about. */
  readonly edges: number;
  /** Edges the shared-column source added on top of the manifest's. */
  readonly added: number;
  readonly adjacency: ReadonlyMap<string, readonly string[]>;
  /** Foreign keys whose two ends are the same table. Counted, because they add no path. */
  readonly selfLoops: number;
  /** Foreign keys naming a column index the manifest does not have. A defect, not a reading. */
  readonly outOfRange: number;
}

/** Column names that say nothing about a join even when two tables share them. */
const GENERIC_ID = 'id';

/** A column name with its spelling flattened, so `GasStationID` and `gas_station_id` agree. */
function flat(name: string): string {
  return name.toLowerCase().replace(/[_\s]/g, '');
}

/**
 * The tables that carry each flattened column name.
 *
 * Built from the manifest's column list, which lists every column of every table: a column that
 * appears under two owners is the database saying the two tables can be joined on it.
 */
export function sharedColumns(table: BirdTable): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  table.columnNames.forEach(([owner, name]) => {
    if (owner < 0 || name === '*') return;
    const key = flat(name);
    if (key.length < 3 || key === GENERIC_ID) return;
    const set = owners.get(key) ?? new Set<string>();
    set.add(table.tableNames[owner]?.toLowerCase() ?? '');
    owners.set(key, set);
  });
  return owners;
}

/**
 * Build the graph from the manifest's column indices, then optionally from shared columns.
 *
 * The undirected edge is the point: a join can be written from either side, and a closure that
 * could only walk `orders.item_id -> items.id` would miss the question that names `items` and
 * needs `orders`.
 */
export function joinGraphOf(table: BirdTable, source: EdgeSource = 'manifest'): JoinGraph {
  const tableOfColumn = (index: number): string | undefined => {
    const owner = table.columnNames[index]?.[0];
    return owner === undefined || owner < 0 ? undefined : table.tableNames[owner];
  };
  const adjacency = new Map<string, Set<string>>();
  for (const name of table.tableNames) adjacency.set(name.toLowerCase(), new Set());
  const linked = new Set<string>();
  let edges = 0;
  let selfLoops = 0;
  let outOfRange = 0;
  const link = (left: string, right: string): boolean => {
    const a = left.toLowerCase();
    const b = right.toLowerCase();
    if (a === b) {
      selfLoops += 1;
      return false;
    }
    const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
    if (linked.has(key)) return false;
    linked.add(key);
    adjacency.get(a)?.add(b);
    adjacency.get(b)?.add(a);
    return true;
  };
  for (const [from, to] of table.foreignKeys) {
    const left = tableOfColumn(from);
    const right = tableOfColumn(to);
    if (left === undefined || right === undefined) {
      outOfRange += 1;
      continue;
    }
    if (link(left, right)) edges += 1;
  }
  let added = 0;
  if (source === 'shared') {
    const limit = Math.max(2, Math.floor(table.tableNames.length * SHARED_SHARE));
    for (const owners of sharedColumns(table).values()) {
      if (owners.size < 2 || owners.size > limit) continue;
      const names = [...owners];
      for (let index = 0; index < names.length; index += 1) {
        for (let other = index + 1; other < names.length; other += 1) {
          if (link(names[index] as string, names[other] as string)) added += 1;
        }
      }
    }
  }
  const frozen = new Map<string, readonly string[]>();
  for (const [name, neighbours] of adjacency) frozen.set(name, [...neighbours]);
  return { edges: edges + added, added, adjacency: frozen, selfLoops, outOfRange };
}

/**
 * Every table within `hops` joins of the seeds.
 *
 * Breadth first and level by level, so `hops` means what a reader thinks it means: one hop is
 * "the tables one join away from anything the question named". Seeds the card does not have are
 * kept in the result — a name that arrives from the linker but is not in the card cannot
 * contribute characters, and quietly deleting it would hide a linker defect behind a saving.
 */
export function closureOf(adjacency: ReadonlyMap<string, readonly string[]>, seeds: Iterable<string>, hops: number): Set<string> {
  const reached = new Set<string>();
  let frontier: string[] = [];
  for (const seed of seeds) {
    const name = seed.toLowerCase();
    if (reached.has(name)) continue;
    reached.add(name);
    frontier.push(name);
  }
  for (let step = 0; step < hops; step += 1) {
    const next: string[] = [];
    for (const name of frontier) {
      for (const neighbour of adjacency.get(name) ?? []) {
        if (reached.has(neighbour)) continue;
        reached.add(neighbour);
        next.push(neighbour);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return reached;
}

/**
 * The graph of one manifest, built once.
 *
 * Cached on the manifest itself, because every caller asks for the same database's graph on every
 * question it scores: the card instrument, the join instrument and the prune rule all loop over
 * one manifest, and rebuilding the graph per question would make a lever pay for a walk of the
 * manifest it never uses. A `WeakMap` keyed on the manifest means the cache goes away with it.
 */
const GRAPHS = new WeakMap<BirdTable, JoinGraph>();

export function graphOf(manifest: BirdTable): JoinGraph {
  const cached = GRAPHS.get(manifest);
  if (cached !== undefined) return cached;
  const graph = joinGraphOf(manifest);
  GRAPHS.set(manifest, graph);
  return graph;
}

/**
 * The graph of every database a run covers.
 *
 * A database the manifest does not describe is an error rather than an empty graph: an empty
 * graph would prune every card down to the tables the question named, and that would look like a
 * saving rather than a broken input.
 */
export function graphForDatabase(tables: ReadonlyMap<string, BirdTable>): (db: string) => JoinGraph {
  return (db) => {
    const manifest = tables.get(db);
    if (manifest === undefined) throw new Error(`prune: the run has no manifest for ${db}`);
    return graphOf(manifest);
  };
}
