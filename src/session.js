/**
 * État d'une séance : participants, réseau, calcul et images du pas à pas.
 * Aucune dépendance réseau : tout est testable sans serveur.
 */
import { randomBytes } from 'node:crypto';
import { fordFulkerson } from './core/maxflow.js';
import { generateNetwork, MIN_NODES } from './core/generator.js';

export const MAX_NODES = 25;
const MAX_PARTICIPANTS = 300;
const MAX_NAME_LENGTH = 24;
const MIN_CAPACITY = 0;
const MAX_CAPACITY = 200;
const CAPACITY_STEP = 10;

const newId = () => randomBytes(6).toString('hex');

export function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\p{C}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

export class Session {
  constructor() {
    this.reset();
  }

  reset() {
    this.participants = new Map();
    this.byToken = new Map();
    this.botCount = 0;
    this.strategy = 'dfs';
    this.view = 'flow';
    this.allowFailures = false;
    this._clearNetwork();
  }

  _clearNetwork() {
    this.base = null;
    this.downNodes = new Set();
    this.downEdges = new Set();
    this.capacities = new Map();
    this.result = null;
    this.frames = [];
    this.cursor = 0;
    this.history = [];
    for (const p of this.participants?.values() ?? []) p.spectator = false;
  }

  get phase() { return this.base ? 'network' : 'lobby'; }

  // ---------- Participants ----------

  join(rawName) {
    const name = cleanName(rawName);
    if (!name) throw new Error('Entre ton nom pour rejoindre le réseau.');
    if (this.participants.size >= MAX_PARTICIPANTS) throw new Error('La salle est complète.');
    const participant = {
      id: newId(),
      token: randomBytes(16).toString('hex'),
      name: this._uniqueName(name),
      bot: false,
      connections: 0,
      spectator: this.phase === 'network',
    };
    this.participants.set(participant.id, participant);
    this.byToken.set(participant.token, participant);
    return participant;
  }

  _uniqueName(name) {
    const taken = new Set([...this.participants.values()].map((p) => p.name.toLocaleLowerCase('fr')));
    if (!taken.has(name.toLocaleLowerCase('fr'))) return name;
    for (let i = 2; ; i++) {
      const candidate = `${name.slice(0, MAX_NAME_LENGTH - 3)} ${i}`;
      if (!taken.has(candidate.toLocaleLowerCase('fr'))) return candidate;
    }
  }

  resume(token) {
    return typeof token === 'string' ? this.byToken.get(token) ?? null : null;
  }

  addBots(count = 1) {
    if (this.phase !== 'lobby') throw new Error('Reviens à la salle pour ajouter des sommets simulés.');
    const n = Math.max(1, Math.min(MAX_NODES, Number(count) || 1));
    for (let i = 0; i < n; i++) this._addBot();
  }

  _addBot() {
    this.botCount += 1;
    const bot = {
      id: newId(), token: null, name: `Simulé ${this.botCount}`, bot: true, connections: 0, spectator: false,
    };
    this.participants.set(bot.id, bot);
    return bot;
  }

  removeParticipant(id) {
    if (this.phase !== 'lobby') throw new Error('Reviens à la salle pour retirer un participant.');
    const p = this.participants.get(id);
    if (!p) throw new Error('Participant introuvable.');
    this.participants.delete(id);
    if (p.token) this.byToken.delete(p.token);
    return p;
  }

  // ---------- Réseau ----------

  build(seed) {
    const all = [...this.participants.values()];
    let humans = all.filter((p) => !p.bot);
    let bots = all.filter((p) => p.bot);
    // Les étudiants passent avant les sommets simulés ; au-delà de la limite, ils suivent en spectateurs.
    while (humans.length + bots.length < MIN_NODES) bots.push(this._addBot());
    humans = humans.slice(0, MAX_NODES);
    bots = bots.slice(0, Math.max(0, MAX_NODES - humans.length));
    const members = new Set([...humans, ...bots].map((p) => p.id));
    for (const p of this.participants.values()) p.spectator = !members.has(p.id);

    const generated = generateNetwork([...members], {
      seed,
      strategy: this.strategy,
      preferredTerminals: humans.map((p) => p.id),
    });
    this.base = generated;
    this.downNodes = new Set();
    this.downEdges = new Set();
    this.capacities = new Map(generated.edges.map((e) => [e.id, e.capacity]));
    this.history = [];
    this._compute();
    this.cursor = 0;
  }

  backToLobby() {
    this._clearNetwork();
  }

  _activeNetwork() {
    const nodes = this.base.nodes.filter((n) => !this.downNodes.has(n));
    const present = new Set(nodes);
    const edges = this.base.edges
      .filter((e) => !this.downEdges.has(e.id) && present.has(e.from) && present.has(e.to))
      .map((e) => ({ ...e, capacity: this.capacities.get(e.id) }));
    return { nodes, edges };
  }

  _compute() {
    const network = this._activeNetwork();
    this.result = fordFulkerson(network, this.base.source, this.base.sink, { strategy: this.strategy });
    const zero = Object.fromEntries(network.edges.map((e) => [e.id, 0]));
    const frames = [{ kind: 'initial', iteration: 0, flows: zero, value: 0 }];
    let previous = zero;
    let previousValue = 0;
    for (const it of this.result.iterations) {
      const common = {
        iteration: it.index, path: it.path, arcs: it.arcs, bottleneck: it.bottleneck,
        bottleneckArc: it.bottleneckArc, usesInverse: it.usesInverse,
      };
      frames.push({ kind: 'found', ...common, flows: previous, value: previousValue });
      frames.push({ kind: 'applied', ...common, flows: it.flows, value: it.value });
      previous = it.flows;
      previousValue = it.value;
    }
    frames.push({
      kind: 'final',
      iteration: this.result.iterationCount,
      flows: this.result.flows,
      value: this.result.value,
      reachable: this.result.reachable,
      cut: this.result.minCut,
    });
    this.frames = frames;
  }

  /** Recalcule après un changement du réseau et affiche directement le nouveau résultat. */
  _changed(label, type) {
    const before = this.result.value;
    this._compute();
    this.cursor = this.frames.length - 1;
    this.history.push({ type, label, before, after: this.result.value });
  }

  _name(id) { return this.participants.get(id)?.name ?? 'Sommet'; }

  _requireNetwork() {
    if (!this.base) throw new Error("Crée d'abord le réseau.");
  }

  failNode(id) {
    this._requireNetwork();
    if (!this.base.nodes.includes(id)) throw new Error("Ce participant n'est pas un sommet du réseau.");
    if (id === this.base.source) throw new Error('La source ne peut pas tomber en panne : sans elle, il n’y a plus de flot à calculer.');
    if (id === this.base.sink) throw new Error('Le puits ne peut pas tomber en panne : sans lui, il n’y a plus de flot à calculer.');
    if (this.downNodes.has(id)) throw new Error('Ce sommet est déjà en panne.');
    this.downNodes.add(id);
    this._changed(`Panne de ${this._name(id)}`, 'failure');
  }

  failSelf(participant) {
    if (!this.allowFailures) throw new Error('Le présentateur n’a pas encore ouvert les pannes.');
    this.failNode(participant.id);
  }

  restoreNode(id) {
    this._requireNetwork();
    if (!this.downNodes.delete(id)) throw new Error("Ce sommet n'est pas en panne.");
    this._changed(`Retour de ${this._name(id)}`, 'restore');
  }

  _edge(id) {
    const edge = this.base.edges.find((e) => e.id === id);
    if (!edge) throw new Error('Lien introuvable.');
    return edge;
  }

  _edgeName(edge) { return `${this._name(edge.from)} → ${this._name(edge.to)}`; }

  setCapacity(edgeId, capacity) {
    this._requireNetwork();
    const edge = this._edge(edgeId);
    if (!Number.isInteger(capacity) || capacity < MIN_CAPACITY || capacity > MAX_CAPACITY || capacity % CAPACITY_STEP) {
      throw new Error(`La capacité doit être un multiple de ${CAPACITY_STEP} entre ${MIN_CAPACITY} et ${MAX_CAPACITY} Mbps.`);
    }
    const old = this.capacities.get(edgeId);
    if (old === capacity) return;
    this.capacities.set(edgeId, capacity);
    this._changed(`${this._edgeName(edge)} : ${old} → ${capacity} Mbps`, 'capacity');
  }

  toggleEdge(edgeId) {
    this._requireNetwork();
    const edge = this._edge(edgeId);
    if (this.downEdges.delete(edgeId)) {
      this._changed(`Lien rétabli : ${this._edgeName(edge)}`, 'restore');
    } else {
      this.downEdges.add(edgeId);
      this._changed(`Lien coupé : ${this._edgeName(edge)}`, 'failure');
    }
  }

  restoreAll() {
    this._requireNetwork();
    const changed = this.downNodes.size || this.downEdges.size
      || this.base.edges.some((e) => this.capacities.get(e.id) !== e.capacity);
    if (!changed) return;
    this.downNodes.clear();
    this.downEdges.clear();
    this.capacities = new Map(this.base.edges.map((e) => [e.id, e.capacity]));
    this._changed('Réseau rétabli', 'restore');
  }

  setStrategy(strategy) {
    if (strategy !== 'dfs' && strategy !== 'bfs') throw new Error('Parcours inconnu.');
    this.strategy = strategy;
    if (this.base) {
      this._compute();
      this.cursor = 0;
    }
  }

  setView(view) {
    if (view !== 'flow' && view !== 'residual') throw new Error('Vue inconnue.');
    this.view = view;
  }

  setAllowFailures(value) {
    this.allowFailures = Boolean(value);
  }

  // ---------- Pas à pas ----------

  next() {
    this._requireNetwork();
    if (this.cursor >= this.frames.length - 1) return false;
    this.cursor += 1;
    return true;
  }

  previous() {
    this._requireNetwork();
    if (this.cursor > 0) this.cursor -= 1;
  }

  rewind() {
    this._requireNetwork();
    this.cursor = 0;
  }

  finish() {
    this._requireNetwork();
    this.cursor = this.frames.length - 1;
  }

  get atEnd() { return this.base ? this.cursor >= this.frames.length - 1 : true; }

  // ---------- État diffusé (jamais de jeton) ----------

  publicState() {
    const participants = [...this.participants.values()].map((p) => ({
      id: p.id,
      name: p.name,
      bot: p.bot,
      online: p.bot || p.connections > 0,
      spectator: p.spectator,
      down: this.downNodes.has(p.id),
    }));
    const state = {
      phase: this.phase,
      limits: { minNodes: MIN_NODES, maxNodes: MAX_NODES, capacityStep: CAPACITY_STEP, maxCapacity: MAX_CAPACITY },
      participants,
      strategy: this.strategy,
      view: this.view,
      allowFailures: this.allowFailures,
      history: this.history,
      network: null,
      frame: null,
      log: [],
    };
    if (!this.base) return state;

    state.network = {
      seed: this.base.seed,
      source: this.base.source,
      sink: this.base.sink,
      positions: this.base.positions,
      nodes: this.base.nodes.map((id) => ({
        id,
        name: this._name(id),
        down: this.downNodes.has(id),
        bot: this.participants.get(id)?.bot ?? false,
        online: (this.participants.get(id)?.bot ?? false) || (this.participants.get(id)?.connections ?? 0) > 0,
      })),
      edges: this.base.edges.map((e) => ({
        id: e.id,
        from: e.from,
        to: e.to,
        capacity: this.capacities.get(e.id),
        initialCapacity: e.capacity,
        down: this.downEdges.has(e.id) || this.downNodes.has(e.from) || this.downNodes.has(e.to),
        linkCut: this.downEdges.has(e.id),
      })),
    };

    const frame = this.frames[this.cursor];
    state.frame = { ...frame, index: this.cursor, total: this.frames.length };
    state.log = this.result.iterations
      .filter((it) => it.index < frame.iteration || (it.index === frame.iteration && frame.kind !== 'found' && frame.kind !== 'initial'))
      .map((it) => ({ index: it.index, path: it.path, bottleneck: it.bottleneck, usesInverse: it.usesInverse, value: it.value }));
    return state;
  }
}
