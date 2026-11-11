/**
 * Méthode de Ford-Fulkerson pour le flot maximal.
 *
 * Écrite sans bibliothèque de graphes. Le graphe résiduel est une liste
 * d'adjacence : chaque arc du réseau produit deux arcs résiduels stockés aux
 * indices i et i ^ 1, ce qui donne l'arc opposé en O(1).
 *
 *   arc direct  u → v : capacité résiduelle c − f (ce qu'on peut encore ajouter)
 *   arc inverse v → u : capacité résiduelle f     (ce qu'on peut annuler)
 *
 * Le flot d'un arc du réseau se lit donc sur son arc inverse.
 */

function validate({ nodes, edges }, source, sink) {
  const known = new Set(nodes);
  if (known.size !== nodes.length) throw new Error('Sommets en double dans le réseau.');
  if (!known.has(source)) throw new Error(`Source inconnue : ${source}`);
  if (!known.has(sink)) throw new Error(`Puits inconnu : ${sink}`);
  if (source === sink) throw new Error('La source et le puits doivent être distincts.');
  const ids = new Set();
  for (const e of edges) {
    if (ids.has(e.id)) throw new Error(`Arc en double : ${e.id}`);
    ids.add(e.id);
    if (!known.has(e.from) || !known.has(e.to)) throw new Error(`Arc ${e.id} : extrémité inconnue.`);
    if (!Number.isFinite(e.capacity) || e.capacity < 0) throw new Error(`Arc ${e.id} : capacité invalide.`);
  }
}

function buildResidual({ nodes, edges }) {
  const adjacency = new Map(nodes.map((n) => [n, []]));
  const to = [];
  const from = [];
  const residual = [];
  const edgeOf = [];
  for (const e of edges) {
    adjacency.get(e.from).push(to.length);
    from.push(e.from); to.push(e.to); residual.push(e.capacity); edgeOf.push(e.id);
    adjacency.get(e.to).push(to.length);
    from.push(e.to); to.push(e.from); residual.push(0); edgeOf.push(e.id);
  }
  return { adjacency, from, to, residual, edgeOf };
}

/**
 * Cherche un chemin augmentant. DFS et BFS partagent le même parcours : seule
 * change la frontière, une pile pour DFS et une file pour BFS (Edmonds-Karp).
 * Renvoie les arcs résiduels du chemin (ou null) et les sommets atteints.
 */
function searchPath(graph, source, sink, strategy) {
  const { adjacency, to, residual } = graph;
  const via = new Map();
  const frontier = [{ node: source, arc: -1 }];
  let head = 0;

  while (strategy === 'bfs' ? head < frontier.length : frontier.length > 0) {
    const { node, arc } = strategy === 'bfs' ? frontier[head++] : frontier.pop();
    if (via.has(node)) continue;
    via.set(node, arc);
    if (node === sink) break;

    const arcs = adjacency.get(node);
    // La pile dépile à l'envers : on empile à rebours pour explorer les arcs dans l'ordre.
    const order = strategy === 'bfs' ? arcs : [...arcs].reverse();
    for (const a of order) {
      if (residual[a] > 0 && !via.has(to[a])) frontier.push({ node: to[a], arc: a });
    }
  }

  if (!via.has(sink)) return { path: null, reachable: [...via.keys()] };

  const path = [];
  for (let node = sink; node !== source; node = graph.from[via.get(node)]) path.unshift(via.get(node));
  return { path, reachable: [...via.keys()] };
}

function readFlows(graph, edges) {
  const flows = {};
  edges.forEach((e, i) => { flows[e.id] = graph.residual[2 * i + 1]; });
  return flows;
}

/**
 * @param {{nodes: string[], edges: {id: string, from: string, to: string, capacity: number}[]}} network
 * @param {string} source
 * @param {string} sink
 * @param {{strategy?: 'dfs'|'bfs', record?: boolean, maxIterations?: number}} [options]
 * @returns {{value: number, flows: Record<string, number>, iterations: object[], iterationCount: number,
 *            reachable: string[], minCut: {source: string[], sink: string[], edges: string[], capacity: number}, strategy: string}}
 */
export function fordFulkerson(network, source, sink, options = {}) {
  const { strategy = 'dfs', record = true, maxIterations = 1_000_000 } = options;
  if (strategy !== 'dfs' && strategy !== 'bfs') throw new Error(`Parcours inconnu : ${strategy}`);
  validate(network, source, sink);

  const graph = buildResidual(network);
  const { from, to, residual, edgeOf } = graph;
  const iterations = [];
  let value = 0;
  let iterationCount = 0;
  let reachable;

  while (true) {
    const search = searchPath(graph, source, sink, strategy);
    reachable = search.reachable;
    if (!search.path) break;
    if (++iterationCount > maxIterations) {
      throw new Error(`Arrêt après ${maxIterations} itérations : vérifie les capacités.`);
    }

    // Le goulot est la plus petite capacité résiduelle du chemin.
    const bottleneck = Math.min(...search.path.map((a) => residual[a]));
    const limiting = search.path.find((a) => residual[a] === bottleneck);
    const arcs = search.path.map((a) => ({
      from: from[a], to: to[a], edgeId: edgeOf[a], inverse: a % 2 === 1, residual: residual[a],
    }));

    // Augmentation : l'arc emprunté perd le goulot, son opposé le gagne.
    for (const a of search.path) {
      residual[a] -= bottleneck;
      residual[a ^ 1] += bottleneck;
    }
    value += bottleneck;

    if (record) {
      iterations.push({
        index: iterationCount,
        path: [source, ...arcs.map((a) => a.to)],
        arcs,
        bottleneck,
        bottleneckArc: { from: from[limiting], to: to[limiting], edgeId: edgeOf[limiting], inverse: limiting % 2 === 1 },
        usesInverse: arcs.some((a) => a.inverse),
        flows: readFlows(graph, network.edges),
        value,
      });
    }
  }

  // À l'arrêt, les sommets atteints depuis la source définissent une coupe minimale.
  const sourceSide = new Set(reachable);
  const cutEdges = network.edges.filter((e) => sourceSide.has(e.from) && !sourceSide.has(e.to));

  return {
    strategy,
    value,
    flows: readFlows(graph, network.edges),
    iterations,
    iterationCount,
    reachable,
    minCut: {
      source: [...sourceSide],
      sink: network.nodes.filter((n) => !sourceSide.has(n)),
      edges: cutEdges.map((e) => e.id),
      capacity: cutEdges.reduce((sum, e) => sum + e.capacity, 0),
    },
  };
}
