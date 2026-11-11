import test from 'node:test';
import assert from 'node:assert/strict';
import { fordFulkerson } from '../src/core/maxflow.js';
import { createRng } from '../src/core/generator.js';

const net = (nodes, list) => ({
  nodes,
  edges: list.map(([from, to, capacity], i) => ({ id: `e${i}`, from, to, capacity })),
});

const small = () => net(['s', 'a', 'b', 't'], [
  ['s', 'a', 3], ['s', 'b', 2], ['a', 'b', 2], ['a', 't', 2], ['b', 't', 3],
]);
const telecom = (over = {}) => {
  const caps = { SA: 100, SB: 80, AC: 60, AD: 30, BC: 20, BD: 50, CT: 70, DT: 90, ...over };
  return net(['S', 'A', 'B', 'C', 'D', 'T'], Object.entries(caps).filter(([, c]) => c !== null)
    .map(([k, c]) => [k[0], k[1], c]));
};

/** Oracle indépendant : énumère toutes les coupes s-t et renvoie leur capacité minimale. */
function bruteForceMinCut({ nodes, edges }, s, t) {
  const inner = nodes.filter((n) => n !== s && n !== t);
  let best = Infinity;
  let count = 0;
  for (let mask = 0; mask < 1 << inner.length; mask++) {
    const side = new Set([s, ...inner.filter((_, i) => mask & (1 << i))]);
    const cap = edges.filter((e) => side.has(e.from) && !side.has(e.to)).reduce((a, e) => a + e.capacity, 0);
    if (cap < best) { best = cap; count = 1; } else if (cap === best) count++;
  }
  return { best, count };
}

function assertValidFlow({ nodes, edges }, s, t, result) {
  const balance = new Map(nodes.map((n) => [n, 0]));
  for (const e of edges) {
    const f = result.flows[e.id];
    assert.ok(f >= 0 && f <= e.capacity, `capacité violée sur ${e.id}`);
    balance.set(e.from, balance.get(e.from) - f);
    balance.set(e.to, balance.get(e.to) + f);
  }
  for (const n of nodes) {
    if (n !== s && n !== t) assert.equal(balance.get(n), 0, `conservation violée en ${n}`);
  }
  assert.equal(balance.get(t), result.value);
  assert.equal(balance.get(s) + result.value, 0);
}

test('petit réseau : flot de 5, avec la séquence 2, 3, 4, 5 et un arc inverse', () => {
  const r = fordFulkerson(small(), 's', 't');
  assert.equal(r.value, 5);
  // Le DFS explore les arcs dans l'ordre de la liste d'adjacence : b→a (inverse) passe avant b→t.
  assert.deepEqual(r.iterations.map((i) => i.path.join('')), ['sabt', 'sat', 'sbat', 'sbt']);
  assert.deepEqual(r.iterations.map((i) => i.value), [2, 3, 4, 5]);
  assert.ok(r.iterations[2].usesInverse);
  assert.equal(r.iterations[2].arcs.find((a) => a.inverse).from, 'b');
  assert.equal(r.minCut.capacity, 5);
});

test('sans arcs inverses, le même choix de chemins resterait bloqué à 4', () => {
  const edges = small().edges.map((e) => ({ ...e, left: e.capacity }));
  let value = 0;
  for (const path of [['e0', 'e2', 'e4'], ['e0', 'e3'], ['e1', 'e4']]) {
    const used = path.map((id) => edges.find((e) => e.id === id));
    const b = Math.min(...used.map((e) => e.left));
    used.forEach((e) => { e.left -= b; });
    value += b;
  }
  assert.equal(value, 4);
  const left = Object.fromEntries(edges.map((e) => [e.id, e.left]));
  assert.ok(left.e0 === 0 && left.e4 === 0, 's→a et b→t sont saturés : plus aucun chemin direct');
});

test('réseau télécom : 150 Mbps, coupe unique C→T, A→D, B→D', () => {
  const network = telecom();
  const r = fordFulkerson(network, 'S', 'T');
  assert.equal(r.value, 150);
  const cut = r.minCut.edges.map((id) => {
    const e = network.edges.find((x) => x.id === id);
    return e.from + e.to;
  }).sort();
  assert.deepEqual(cut, ['AD', 'BD', 'CT']);
  assert.deepEqual(bruteForceMinCut(network, 'S', 'T'), { best: 150, count: 1 });
});

test('réseau télécom : renforcer, réparer et couper donnent les valeurs annoncées', () => {
  assert.equal(fordFulkerson(telecom({ SA: 200 }), 'S', 'T').value, 150);
  assert.equal(fordFulkerson(telecom({ CT: 80 }), 'S', 'T').value, 160);
  assert.equal(fordFulkerson(telecom({ AD: null }), 'S', 'T').value, 120);
});

test('DFS et BFS atteignent la même valeur, mais BFS évite le pire cas', () => {
  const n = net(['s', 'a', 'b', 't'], [['s', 'a', 1000], ['s', 'b', 1000], ['a', 'b', 1], ['a', 't', 1000], ['b', 't', 1000]]);
  const dfs = fordFulkerson(n, 's', 't', { strategy: 'dfs' });
  const bfs = fordFulkerson(n, 's', 't', { strategy: 'bfs' });
  assert.equal(dfs.value, 2000);
  assert.equal(bfs.value, 2000);
  assert.equal(bfs.iterationCount, 2);
  assert.ok(dfs.iterationCount >= bfs.iterationCount);
});

test('puits inaccessible : flot nul et coupe vide', () => {
  const r = fordFulkerson(net(['s', 'a', 't'], [['s', 'a', 5]]), 's', 't');
  assert.equal(r.value, 0);
  assert.deepEqual(r.minCut.edges, []);
  assert.equal(r.iterations.length, 0);
});

test('arcs antiparallèles et parallèles', () => {
  const n = net(['s', 'a', 'b', 't'], [
    ['s', 'a', 4], ['s', 'a', 3], ['a', 'b', 5], ['b', 'a', 2], ['b', 't', 6], ['a', 't', 1],
  ]);
  const r = fordFulkerson(n, 's', 't');
  assert.equal(r.value, 6);
  assertValidFlow(n, 's', 't', r);
  assert.equal(r.value, bruteForceMinCut(n, 's', 't').best);
});

test('entrées invalides refusées', () => {
  assert.throws(() => fordFulkerson(small(), 's', 's'), /distincts/);
  assert.throws(() => fordFulkerson(small(), 'x', 't'), /Source inconnue/);
  assert.throws(() => fordFulkerson(net(['s', 't'], [['s', 't', -1]]), 's', 't'), /capacité invalide/);
  assert.throws(() => fordFulkerson(small(), 's', 't', { strategy: 'autre' }), /Parcours inconnu/);
});

test('2 000 graphes aléatoires : flot valide, égal à la coupe minimale par énumération, DFS = BFS', () => {
  const rng = createRng(20261106);
  for (let g = 0; g < 2000; g++) {
    const size = 2 + Math.floor(rng() * 8);
    const nodes = Array.from({ length: size }, (_, i) => `n${i}`);
    const list = [];
    const count = Math.floor(rng() * size * size);
    for (let i = 0; i < count; i++) {
      const u = nodes[Math.floor(rng() * size)];
      const v = nodes[Math.floor(rng() * size)];
      if (u !== v) list.push([u, v, Math.floor(rng() * 21)]);
    }
    const n = net(nodes, list);
    const [s, t] = [nodes[0], nodes[size - 1]];
    const dfs = fordFulkerson(n, s, t, { strategy: 'dfs' });
    const bfs = fordFulkerson(n, s, t, { strategy: 'bfs' });
    const oracle = bruteForceMinCut(n, s, t).best;
    assert.equal(dfs.value, oracle, `graphe ${g}`);
    assert.equal(bfs.value, oracle, `graphe ${g}`);
    assert.equal(dfs.minCut.capacity, oracle, `graphe ${g}`);
    assertValidFlow(n, s, t, dfs);
    assertValidFlow(n, s, t, bfs);
  }
});
