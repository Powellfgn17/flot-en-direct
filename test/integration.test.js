import test from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { startServer } from '../src/app.js';

const KEY = 'cle-de-test';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function client(port, auth = {}) {
  const socket = connect(`http://localhost:${port}`, { auth, forceNew: true, transports: ['websocket'] });
  socket.latest = null;
  socket.on('state', (s) => { socket.latest = s; });
  return socket;
}
const once = (socket, event) => new Promise((r) => socket.once(event, r));
const call = (socket, event, payload) => new Promise((r) => socket.emit(event, payload, r));
const cmd = (socket, payload) => call(socket, 'presenter:command', payload);

async function until(check, label, ms = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`Délai dépassé : ${label}`);
    await wait(15);
  }
}

test('séance complète : 20 étudiants, reconnexion, panne, lecture, sécurité', async () => {
  const server = await startServer({ port: 0, presenterKey: KEY, publicUrl: 'https://exemple.test' });
  const { port } = server;
  const sockets = [];
  try {
    // Mauvaise clé refusée.
    const intruder = connect(`http://localhost:${port}`, { auth: { role: 'presenter', key: 'faux' }, forceNew: true, transports: ['websocket'] });
    const refused = await once(intruder, 'connect_error');
    assert.equal(refused.message, 'cle-invalide');
    intruder.close();

    const presenter = client(port, { role: 'presenter', key: KEY });
    const projector = client(port);
    sockets.push(presenter, projector);
    await once(presenter, 'connect');
    await once(projector, 'connect');

    // 20 téléphones rejoignent en même temps.
    const students = Array.from({ length: 20 }, () => client(port));
    sockets.push(...students);
    await Promise.all(students.map((s) => once(s, 'connect')));
    const joined = await Promise.all(students.map((s, i) => call(s, 'student:join', { name: `Étudiant ${i}` })));
    assert.ok(joined.every((j) => j.ok));
    await until(() => projector.latest?.participants.length === 20, 'participants visibles');
    assert.ok(projector.latest.participants.every((p) => p.online));

    // Un étudiant ne peut ni commander ni usurper le présentateur.
    const denied = await cmd(students[0], { type: 'build' });
    assert.equal(denied.ok, false);
    assert.equal((await cmd(presenter, { type: '__proto__' })).ok, false);
    assert.equal((await cmd(presenter, { type: 'constructor' })).ok, false);

    // Le jeton ne fuit jamais.
    assert.ok(!JSON.stringify(projector.latest).includes(joined[0].token));

    // Création automatique.
    assert.ok((await cmd(presenter, { type: 'build', seed: 1234 })).ok);
    await until(() => projector.latest?.phase === 'network', 'réseau créé');
    const { network } = projector.latest;
    assert.equal(network.nodes.length, 20);
    assert.ok(students.every((s) => s.latest.network?.seed === 1234));
    assert.equal(projector.latest.frame.kind, 'initial');

    // Un téléphone se verrouille puis revient : même sommet.
    const lockedIndex = joined.findIndex((j) => j.id !== network.source && j.id !== network.sink);
    students[lockedIndex].disconnect();
    await until(() => !projector.latest.participants.find((p) => p.id === joined[lockedIndex].id).online, 'hors ligne');
    assert.equal(projector.latest.network.nodes.length, 20);
    const back = client(port);
    sockets.push(back);
    await once(back, 'connect');
    const resumed = await call(back, 'student:resume', { token: joined[lockedIndex].token });
    assert.equal(resumed.id, joined[lockedIndex].id);
    await until(() => projector.latest.participants.find((p) => p.id === resumed.id).online, 'de retour');
    const stranger = client(port);
    sockets.push(stranger);
    assert.equal((await call(stranger, 'student:resume', { token: 'faux' })).ok, false);

    // Retardataire : spectateur.
    const late = client(port);
    sockets.push(late);
    await once(late, 'connect');
    const lateJoin = await call(late, 'student:join', { name: 'Retard' });
    assert.ok(lateJoin.ok);
    await until(() => projector.latest.participants.find((p) => p.id === lateJoin.id)?.spectator, 'spectateur');

    // Lecture automatique jusqu'au résultat.
    await cmd(presenter, { type: 'speed', speed: 'rapide' });
    await cmd(presenter, { type: 'pause' });
    for (let i = 0; i < 2; i++) await cmd(presenter, { type: 'next' });
    await until(() => projector.latest.frame.kind === 'applied', 'première augmentation');
    assert.ok(projector.latest.frame.value > 0);
    await cmd(presenter, { type: 'finish' });
    await until(() => projector.latest.frame.kind === 'final', 'résultat');
    const { value, cut } = projector.latest.frame;
    assert.equal(value, cut.capacity);

    // Panne étudiante : fermée, puis ouverte.
    const victimIndex = joined.findIndex((j, i) => i !== lockedIndex && j.id !== network.source && j.id !== network.sink);
    const closed = await call(students[victimIndex], 'student:fail', {});
    assert.equal(closed.ok, false);
    await cmd(presenter, { type: 'allowFailures', value: true });
    assert.ok((await call(students[victimIndex], 'student:fail', {})).ok);
    await until(() => projector.latest.history.length === 1, 'panne diffusée');
    assert.equal(projector.latest.history[0].before, value);
    assert.equal(projector.latest.frame.kind, 'final');
    assert.ok(projector.latest.frame.value <= value);

    // Retour du sommet.
    await cmd(presenter, { type: 'restoreNode', id: joined[victimIndex].id });
    await until(() => projector.latest.frame.value === value, 'débit rétabli');

    // Lecture complète.
    await cmd(presenter, { type: 'play' });
    await until(() => projector.latest.playing === true, 'lecture');
    await cmd(presenter, { type: 'speed', speed: 'rapide' });
    await cmd(presenter, { type: 'pause' });
    await until(() => projector.latest.playing === false, 'pause');

    // Réinitialisation : les téléphones sont prévenus.
    const removed = once(students[1], 'removed');
    await cmd(presenter, { type: 'resetRoom' });
    await removed;
    await until(() => projector.latest.participants.length === 0, 'salle vide');
    const former = client(port);
    sockets.push(former);
    assert.equal((await call(former, 'student:resume', { token: joined[1].token })).ok, false);
  } finally {
    sockets.forEach((s) => s.close());
    await server.close();
  }
});

test('la lecture automatique parcourt toutes les images puis s’arrête sur le résultat', async () => {
  const fast = { lent: 12, normal: 8, rapide: 4 };
  const server = await startServer({ port: 0, presenterKey: KEY, speeds: fast });
  const presenter = client(server.port, { role: 'presenter', key: KEY });
  try {
    await once(presenter, 'connect');
    await cmd(presenter, { type: 'addBots', count: 12 });
    await cmd(presenter, { type: 'build', seed: 99 });
    const seen = new Set();
    presenter.on('state', (s) => seen.add(s.frame?.index));
    assert.ok((await cmd(presenter, { type: 'speed', speed: 'rapide' })).ok);
    assert.equal((await cmd(presenter, { type: 'speed', speed: 'constructor' })).ok, false);
    assert.ok((await cmd(presenter, { type: 'play' })).ok);
    await until(() => presenter.latest.frame.kind === 'final' && presenter.latest.playing === false, 'fin de lecture');
    assert.equal(seen.size, presenter.latest.frame.total);
    // « Rejouer » repart du début.
    assert.ok((await cmd(presenter, { type: 'play' })).ok);
    await until(() => presenter.latest.frame.index === 0 || presenter.latest.frame.index === 1, 'retour au début');
    await cmd(presenter, { type: 'pause' });
  } finally {
    presenter.close();
    await server.close();
  }
});

test('l’URL de la salle et le QR code sont servis ; les trois pages répondent', async () => {
  const server = await startServer({ port: 0, presenterKey: KEY, publicUrl: 'https://exemple.test' });
  try {
    const salle = await (await fetch(`http://localhost:${server.port}/api/salle`)).json();
    assert.equal(salle.url, 'https://exemple.test');
    assert.match(salle.qr, /<svg/);
    for (const path of ['/', '/presentateur', '/projecteur', '/css/style.css', '/js/graph.js', '/socket.io/socket.io.js']) {
      const res = await fetch(`http://localhost:${server.port}${path}`);
      assert.equal(res.status, 200, path);
    }
  } finally {
    await server.close();
  }
});
