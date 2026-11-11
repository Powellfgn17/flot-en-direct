import test from 'node:test';
import assert from 'node:assert/strict';
import { generateNetwork } from '../src/core/generator.js';
import { fordFulkerson } from '../src/core/maxflow.js';

const ids = (n) => Array.from({ length: n }, (_, i) => `p${i}`);

function reach(edges, start, forward = true) {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const u = stack.pop();
    for (const e of edges) {
      const [a, b] = forward ? [e.from, e.to] : [e.to, e.from];
      if (a === u && !seen.has(b)) { seen.add(b); stack.push(b); }
    }
  }
  return seen;
}

test('de 4 à 30 sommets : tous sur un chemin s-t, capacités entières de 10 à 100', () => {
  for (let n = 4; n <= 30; n++) {
    for (let seed = 1; seed <= 15; seed++) {
      const g = generateNetwork(ids(n), { seed, attempts: 40 });
      const fromS = reach(g.edges, g.source);
      const toT = reach(g.edges, g.sink, false);
      for (const id of g.nodes) {
        assert.ok(fromS.has(id) && toT.has(id), `n=${n} seed=${seed} : ${id} hors chemin`);
      }
      for (const e of g.edges) {
        assert.ok(Number.isInteger(e.capacity / 10) && e.capacity >= 10 && e.capacity <= 100);
        assert.ok(!g.edges.some((x) => x.from === e.to && x.to === e.from), 'lien antiparallèle');
      }
      assert.equal(g.nodes.length, n);
      assert.ok(g.quality.value > 0);
    }
  }
});

test('qualité : arc inverse et coupe intérieure sur presque tous les tirages', () => {
  const stats = {};
  for (const n of [4, 5, 6, 8, 10, 15, 20, 25]) {
    let inverse = 0; let interior = 0; let coverage = 0;
    const runs = 30;
    for (let seed = 1; seed <= runs; seed++) {
      const q = generateNetwork(ids(n), { seed }).quality;
      inverse += q.usesInverse ? 1 : 0;
      interior += q.interiorCut ? 1 : 0;
      coverage += q.coverage;
    }
    stats[n] = { inverse: inverse / runs, interior: interior / runs, coverage: +(coverage / runs).toFixed(2) };
  }
  console.log(stats);
  for (const [n, s] of Object.entries(stats)) {
    assert.ok(s.inverse >= 0.9, `n=${n} arc inverse ${s.inverse}`);
    // À 4 sommets, un arc intérieur saturé dans la coupe et un arc inverse utilisé s'excluent : l'arc inverse prime.
    if (+n >= 5) assert.ok(s.interior >= 0.9, `n=${n} coupe intérieure ${s.interior}`);
  }
});

test('même graine, même réseau ; flot annoncé conforme au calcul', () => {
  const a = generateNetwork(ids(12), { seed: 42 });
  const b = generateNetwork(ids(12), { seed: 42 });
  assert.deepEqual(a, b);
  const r = fordFulkerson({ nodes: a.nodes, edges: a.edges }, a.source, a.sink);
  assert.equal(r.value, a.quality.value);
  assert.equal(r.value, r.minCut.capacity);
});

test('la source et le puits sont choisis parmi les sommets privilégiés', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const g = generateNetwork(ids(10), { seed, attempts: 5, preferredTerminals: ['p3', 'p7'] });
    assert.deepEqual([g.source, g.sink].sort(), ['p3', 'p7']);
  }
});

test('trop peu de sommets refusé', () => {
  assert.throws(() => generateNetwork(ids(3)), /au moins 4/);
});
