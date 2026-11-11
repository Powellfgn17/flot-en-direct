import test from 'node:test';
import assert from 'node:assert/strict';
import { Session, cleanName, MAX_NODES } from '../src/session.js';

const room = (humans = 8) => {
  const s = new Session();
  const people = Array.from({ length: humans }, (_, i) => s.join(`Étudiant ${i}`));
  return { s, people };
};

test('les noms sont nettoyés et rendus uniques', () => {
  assert.equal(cleanName('  Ana\u0000  Bio\n '), 'Ana Bio');
  const s = new Session();
  assert.equal(s.join('Ana').name, 'Ana');
  assert.equal(s.join('ana').name, 'ana 2');
  assert.throws(() => s.join('   '), /Entre ton nom/);
  assert.throws(() => s.join({ evil: true }), /Entre ton nom/);
});

test('l’état public ne contient aucun jeton', () => {
  const { s, people } = room();
  s.build(7);
  const text = JSON.stringify(s.publicState());
  for (const p of people) assert.ok(!text.includes(p.token));
});

test('moins de 4 sommets : le réseau est complété par des sommets simulés', () => {
  const { s } = room(1);
  s.build(1);
  assert.equal(s.base.nodes.length, 4);
  const state = s.publicState();
  assert.ok(state.participants.filter((p) => p.bot).length === 3);
  const human = state.participants.find((p) => !p.bot).id;
  assert.ok([state.network.source, state.network.sink].includes(human));
});

test('au-delà de la limite : les étudiants passent avant les sommets simulés, les autres deviennent spectateurs', () => {
  const s = new Session();
  s.addBots(10);
  for (let i = 0; i < MAX_NODES + 3; i++) s.join(`E${i}`);
  s.build(3);
  const state = s.publicState();
  assert.equal(state.network.nodes.length, MAX_NODES);
  assert.equal(state.network.nodes.filter((n) => n.bot).length, 0);
  assert.equal(state.participants.filter((p) => p.spectator && !p.bot).length, 3);
});

test('rejoindre après la création : spectateur, sans modifier le réseau', () => {
  const { s } = room();
  s.build(5);
  const edges = JSON.stringify(s.publicState().network.edges);
  const late = s.join('Retardataire');
  assert.equal(late.spectator, true);
  assert.equal(JSON.stringify(s.publicState().network.edges), edges);
  assert.throws(() => s.failNode(late.id), /pas un sommet/);
});

test('le pas à pas est cohérent : flots, conservation et valeur à chaque image', () => {
  const { s } = room(14);
  s.build(11);
  const { network } = s.publicState();
  const seen = [];
  do {
    const { frame, log } = s.publicState();
    seen.push(frame.kind);
    const balance = Object.fromEntries(network.nodes.map((n) => [n.id, 0]));
    for (const e of network.edges) {
      const f = frame.flows[e.id];
      assert.ok(f >= 0 && f <= e.capacity);
      balance[e.from] -= f;
      balance[e.to] += f;
    }
    for (const n of network.nodes) {
      if (n.id !== network.source && n.id !== network.sink) assert.equal(balance[n.id], 0);
    }
    assert.equal(balance[network.sink], frame.value);
    if (frame.kind === 'found') {
      assert.equal(log.length, frame.iteration - 1);
      assert.equal(frame.bottleneck, Math.min(...frame.arcs.map((a) => a.residual)));
    }
    if (frame.kind === 'applied') assert.equal(log.at(-1).value, frame.value);
  } while (s.next());
  assert.equal(seen[0], 'initial');
  assert.equal(seen.at(-1), 'final');
  assert.ok(seen.includes('found') && seen.includes('applied'));
  const { frame } = s.publicState();
  assert.equal(frame.value, frame.cut.capacity);
  s.previous();
  assert.notEqual(s.publicState().frame.kind, 'final');
  s.rewind();
  assert.equal(s.publicState().frame.kind, 'initial');
  s.finish();
  assert.equal(s.publicState().frame.kind, 'final');
});

test('panne : le sommet disparaît du calcul, le débit ne peut pas augmenter, le retour le rétablit', () => {
  const { s } = room(14);
  s.build(21);
  s.finish();
  const before = s.result.value;
  const { network, frame } = s.publicState();
  const victim = network.edges.find((e) => frame.flows[e.id] > 0 && e.from !== network.source).from;
  s.failNode(victim);
  const state = s.publicState();
  assert.equal(state.frame.kind, 'final');
  assert.ok(state.frame.value < before + 1);
  for (const e of state.network.edges) {
    if (e.from === victim || e.to === victim) {
      assert.equal(e.down, true);
      assert.equal(state.frame.flows[e.id], undefined);
    }
  }
  assert.equal(state.history.at(-1).before, before);
  assert.equal(state.history.at(-1).after, state.frame.value);
  assert.throws(() => s.failNode(victim), /déjà en panne/);
  s.restoreNode(victim);
  assert.equal(s.result.value, before);
});

test('la source et le puits ne tombent pas en panne ; les pannes étudiantes sont fermées par défaut', () => {
  const { s, people } = room();
  s.build(2);
  assert.throws(() => s.failNode(s.base.source), /source/);
  assert.throws(() => s.failNode(s.base.sink), /puits/);
  const inner = people.find((p) => p.id !== s.base.source && p.id !== s.base.sink);
  assert.throws(() => s.failSelf(inner), /pas encore ouvert/);
  s.setAllowFailures(true);
  s.failSelf(inner);
  assert.ok(s.downNodes.has(inner.id));
});

test('renforcer un lien hors coupe ne change rien ; un lien saturé de la coupe peut augmenter le débit', () => {
  const { s } = room(14);
  s.build(33);
  s.finish();
  const value = s.result.value;
  const cut = new Set(s.result.minCut.edges);
  const outside = s.base.edges.find((e) => !cut.has(e.id) && e.from === s.base.source);
  if (outside) {
    const current = s.capacities.get(outside.id);
    s.setCapacity(outside.id, Math.min(200, current + 10));
    assert.ok(s.result.value >= value);
    assert.equal(s.result.value, s.result.minCut.capacity);
    s.restoreAll();
  }
  const inCut = s.base.edges.find((e) => cut.has(e.id));
  s.setCapacity(inCut.id, s.capacities.get(inCut.id) + 10);
  assert.ok(s.result.value >= value && s.result.value <= value + 10);
  s.restoreAll();
  assert.equal(s.result.value, value);
  assert.throws(() => s.setCapacity(inCut.id, 13), /multiple/);
  assert.throws(() => s.setCapacity(inCut.id, 500), /multiple/);
});

test('couper tous les liens de la coupe minimale ramène le débit à 0', () => {
  const { s } = room(10);
  s.build(9);
  for (const id of [...s.result.minCut.edges]) s.toggleEdge(id);
  assert.equal(s.result.value, 0);
  assert.equal(s.publicState().frame.cut.capacity, 0);
  s.restoreAll();
  assert.ok(s.result.value > 0);
});

test('changer de parcours conserve la valeur et repart du début', () => {
  const { s } = room(16);
  s.build(44);
  s.finish();
  const value = s.result.value;
  s.setStrategy('bfs');
  assert.equal(s.result.value, value);
  assert.equal(s.publicState().frame.kind, 'initial');
  assert.throws(() => s.setStrategy('x'), /inconnu/);
});

test('le retour à la salle garde les participants, la réinitialisation les efface', () => {
  const { s, people } = room(5);
  s.build(1);
  s.backToLobby();
  assert.equal(s.phase, 'lobby');
  assert.equal(s.participants.size, 5);
  assert.equal(s.resume(people[0].token), people[0]);
  s.reset();
  assert.equal(s.participants.size, 0);
  assert.equal(s.resume(people[0].token), null);
});
