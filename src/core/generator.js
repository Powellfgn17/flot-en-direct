/**
 * Génère automatiquement les liens et les capacités d'un réseau à partir de la
 * liste des sommets. Les sommets sont rangés en colonnes, de la source au puits.
 *
 * Garanties par construction : graphe sans circuit, chaque sommet reçoit depuis
 * la colonne précédente et émet vers la suivante, donc tous se trouvent sur un
 * chemin de la source au puits.
 *
 * Plusieurs tirages sont évalués et le plus instructif est conservé : arc
 * inverse utilisé, coupe minimale à l'intérieur du réseau, sommets traversés.
 */
import { fordFulkerson } from './maxflow.js';

export const MIN_NODES = 4;

export function createRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randInt = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));
/** Capacité entière en Mbps, multiple de 10 : les calculs restent lisibles et l'algorithme se termine. */
const capacity = (rng, min, max) => randInt(rng, min / 10, max / 10) * 10;

function shuffle(rng, items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(rng, 0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function splitIntoColumns(rng, ids) {
  // Une seule colonne jusqu'à 3 sommets : deux colonnes d'un sommet formeraient une simple chaîne.
  const count = ids.length <= 3 ? 1 : Math.min(6, Math.round(Math.sqrt(ids.length * 1.4)));
  const base = Math.floor(ids.length / count);
  const extra = ids.length - base * count;
  const columns = [];
  let cursor = 0;
  const extraAt = new Set(shuffle(rng, [...Array(count).keys()]).slice(0, extra));
  for (let c = 0; c < count; c++) {
    const size = base + (extraAt.has(c) ? 1 : 0);
    columns.push(ids.slice(cursor, cursor + size));
    cursor += size;
  }
  return columns;
}

const rowOf = (column, id) => (column.length === 1 ? 0.5 : column.indexOf(id) / (column.length - 1));

function drawAttempt(rng, source, sink, inner) {
  const columns = splitIntoColumns(rng, shuffle(rng, inner));
  const waist = randInt(rng, 0, Math.max(0, columns.length - 2));
  const links = [];
  const has = new Set();
  const link = (from, to, cap) => {
    const key = `${from}>${to}`;
    if (has.has(key)) return;
    has.add(key);
    links.push({ from, to, capacity: cap });
  };

  for (const id of columns[0]) link(source, id, capacity(rng, 40, 100));
  for (const id of columns[columns.length - 1]) link(id, sink, capacity(rng, 40, 100));

  for (let c = 0; c < columns.length - 1; c++) {
    const here = columns[c];
    const next = columns[c + 1];
    const range = c === waist ? [10, 40] : [20, 80];
    const byDistance = (id) => [...next].sort(
      (a, b) => Math.abs(rowOf(next, a) - rowOf(here, id)) - Math.abs(rowOf(next, b) - rowOf(here, id)),
    );
    for (const id of here) {
      const targets = byDistance(id).slice(0, rng() < 0.45 ? 2 : 1);
      for (const target of targets) link(id, target, capacity(rng, ...range));
    }
    for (const id of next) {
      if (!links.some((l) => l.to === id)) {
        const nearest = [...here].sort(
          (a, b) => Math.abs(rowOf(here, a) - rowOf(next, id)) - Math.abs(rowOf(here, b) - rowOf(next, id)),
        )[0];
        link(nearest, id, capacity(rng, ...range));
      }
    }
  }

  // Liens verticaux entre voisins d'une colonne : ils créent les détours qui rendent les arcs inverses utiles.
  for (const column of columns) {
    for (let r = 0; r < column.length - 1; r++) {
      if (rng() < 0.5) {
        const [from, to] = rng() < 0.5 ? [column[r], column[r + 1]] : [column[r + 1], column[r]];
        link(from, to, capacity(rng, 10, 40));
      }
    }
  }

  // L'ordre des arcs oriente le DFS : on le mélange pour varier les premiers chemins.
  const edges = shuffle(rng, links).map((l, i) => ({ id: `e${i}`, ...l }));
  return { columns, edges };
}

function evaluate(attempt, source, sink, inner, strategy) {
  const nodes = [source, ...inner, sink];
  const result = fordFulkerson({ nodes, edges: attempt.edges }, source, sink, { strategy });
  const byId = new Map(attempt.edges.map((e) => [e.id, e]));
  const usesInverse = result.iterations.some((it) => it.usesInverse);
  const interiorCut = result.minCut.edges.some((id) => {
    const e = byId.get(id);
    return e.from !== source && e.to !== sink;
  });
  const traversed = new Set();
  for (const e of attempt.edges) {
    if (result.flows[e.id] > 0) { traversed.add(e.from); traversed.add(e.to); }
  }
  const coverage = traversed.size / nodes.length;
  const score = (usesInverse ? 100 : 0) + (interiorCut ? 100 : 0) + coverage * 60
    + Math.min(result.iterationCount, 6) * 2;
  return { score, quality: { usesInverse, interiorCut, coverage, iterations: result.iterationCount, value: result.value } };
}

function layout(columns, source, sink) {
  const positions = { [source]: { x: 0, y: 0.5 }, [sink]: { x: 1, y: 0.5 } };
  columns.forEach((column, c) => {
    const x = (c + 1) / (columns.length + 1);
    column.forEach((id, r) => {
      positions[id] = {
        x,
        y: column.length === 1 ? 0.5 : r / (column.length - 1),
        column: c,
        row: r,
      };
    });
  });
  return positions;
}

/**
 * @param {string[]} ids identifiants des sommets (au moins 4)
 * @param {{seed?: number, strategy?: 'dfs'|'bfs', attempts?: number, preferredTerminals?: string[]}} [options]
 *   preferredTerminals : sommets à privilégier pour la source et le puits (les étudiants plutôt que les sommets simulés).
 */
export function generateNetwork(ids, options = {}) {
  const { seed = (Math.random() * 2 ** 32) >>> 0, strategy = 'dfs', attempts = 300, preferredTerminals = [] } = options;
  if (new Set(ids).size !== ids.length) throw new Error('Sommets en double.');
  if (ids.length < MIN_NODES) throw new Error(`Il faut au moins ${MIN_NODES} sommets.`);

  const rng = createRng(seed);
  const preferred = shuffle(rng, ids.filter((id) => preferredTerminals.includes(id)));
  const others = shuffle(rng, ids.filter((id) => !preferredTerminals.includes(id)));
  const [source, sink] = [...preferred, ...others];
  const inner = ids.filter((id) => id !== source && id !== sink);

  let best = null;
  for (let i = 0; i < attempts; i++) {
    const attempt = drawAttempt(rng, source, sink, inner);
    const evaluation = evaluate(attempt, source, sink, inner, strategy);
    if (!best || evaluation.score > best.evaluation.score) best = { attempt, evaluation };
  }

  return {
    seed,
    source,
    sink,
    nodes: [source, ...inner, sink],
    edges: best.attempt.edges,
    positions: layout(best.attempt.columns, source, sink),
    quality: best.evaluation.quality,
  };
}
