import { FlowGraph } from './graph.js';
import { el, connectionBanner, store, terminalLabel } from './common.js';

const socket = io({ auth: { role: 'viewer' } });
connectionBanner(socket, document.getElementById('banner'));
const app = document.getElementById('app');
const TOKEN = 'flot-jeton';
const NAME = 'flot-nom';

let me = null;
let token = store(TOKEN);
let state = null;
let formError = '';
let failError = '';
let graph = null;
let map = null;
let screen = null;
let main = null;

function saveToken(value) {
  // Le jeton reste aussi en mémoire : la reconnexion marche même si le stockage du navigateur est bloqué.
  token = value;
  store(TOKEN, value);
}

function forget() {
  me = null;
  saveToken(null);
  graph = null;
  screen = null;
  render();
}

socket.on('connect', () => {
  if (!token) { render(); return; }
  socket.emit('student:resume', { token }, (response) => {
    if (response?.ok) me = { id: response.id, name: response.name };
    else {
      me = null;
      saveToken(null);
    }
    render();
  });
});

socket.on('removed', forget);
socket.on('state', (next) => { state = next; render(); });

function joinScreen() {
  const input = el('input', {
    type: 'text', id: 'nom', maxlength: 24, autocomplete: 'name', autocapitalize: 'words', value: store(NAME) ?? '', 'aria-label': 'Ton nom', placeholder: 'Ton nom',
  });
  const error = el('p', { class: 'error', role: 'alert', text: formError });
  const submit = el('button', { type: 'submit', class: 'primary', text: 'Rejoindre le réseau' });
  const form = el('form', {
    class: 'join-screen',
    onsubmit: (event) => {
      event.preventDefault();
      if (!input.value.trim()) { error.textContent = 'Entre ton nom pour rejoindre le réseau.'; input.focus(); return; }
      submit.disabled = true;
      socket.emit('student:join', { name: input.value }, (response) => {
        submit.disabled = false;
        if (!response?.ok) { error.textContent = response?.error ?? 'La connexion a échoué. Réessaie.'; return; }
        saveToken(response.token);
        store(NAME, input.value.trim());
        me = { id: response.id, name: response.name };
        render();
      });
    },
  },
  el('h1', { text: 'Deviens un sommet du réseau' }),
  el('p', { text: 'Le système te placera dans le réseau et attribuera une capacité à chacun de tes liens.' }),
  input, error, submit);
  app.replaceChildren(el('div', { class: 'phone' }, form));
  input.focus({ preventScroll: true });
}

function waitingScreen(participant) {
  const count = state.participants.length;
  app.replaceChildren(el('div', { class: 'phone' },
    el('header', { class: 'phone-card' },
      el('div', { class: 'phone-role', text: 'Tu es connecté' }),
      el('div', { class: 'phone-name', text: participant.name })),
    el('section', { class: 'phone-main' },
      el('div', {}, el('div', { class: 'waiting-count', text: String(count) }), el('p', { text: count > 1 ? 'sommets dans la salle' : 'sommet dans la salle' })),
      el('p', { text: 'Le réseau sera créé dès que le présentateur le lancera. Garde cette page ouverte : si ton téléphone se verrouille, tu retrouveras ta place.' }))));
}

function totalFlow(frame, edges) {
  return edges.reduce((sum, e) => sum + (frame.flows[e.id] ?? 0), 0);
}

function linkRow(frame, edge, neighbourLabel, cut) {
  const flow = frame.flows[edge.id] ?? 0;
  const onPath = (frame.kind === 'found' || frame.kind === 'applied') && frame.arcs.some((a) => a.edgeId === edge.id);
  return el('div', { class: `link-row${cut.has(edge.id) ? ' cut' : ''}${onPath ? ' onpath' : ''}` },
    el('header', {},
      el('span', { class: 'who', text: neighbourLabel }),
      el('span', { class: 'amount', text: edge.down ? 'coupé' : `${flow}/${edge.capacity} Mbps` })),
    el('span', { class: 'bar' }, el('i', { style: `width:${edge.capacity ? (flow / edge.capacity) * 100 : 0}%` })));
}

function buildMemberScreen() {
  main = el('section', { class: 'phone-main' });
  const svgRoot = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgRoot.setAttribute('role', 'img');
  svgRoot.setAttribute('aria-label', 'Vue d’ensemble du réseau, ton sommet est entouré en rouge');
  map = el('div', { class: 'mini-map' }, svgRoot);
  graph = new FlowGraph(svgRoot, { compact: true });
  const header = el('header', { class: 'phone-card', id: 'card' },
    el('div', { class: 'phone-role', id: 'role' }),
    el('div', { class: 'phone-name', id: 'pname' }));
  app.replaceChildren(el('div', { class: 'phone' }, header, main));
}

function pathAlert(frame, id) {
  if (frame.kind !== 'found' && frame.kind !== 'applied') return null;
  if (!frame.path.includes(id)) return null;
  if (frame.kind === 'found') {
    return el('div', { class: 'alert path' }, el('b', { text: 'Le chemin passe par toi' }), `Goulot de ce chemin : ${frame.bottleneck} Mbps.`);
  }
  return el('div', { class: 'alert path' }, el('b', { text: `+${frame.bottleneck} Mbps` }), 'Ce débit vient de passer par ton sommet.');
}

function renderMember(participant) {
  if (screen !== 'member') {
    buildMemberScreen();
    screen = 'member';
  }
  const { network, frame } = state;
  const id = participant.id;
  const incoming = network.edges.filter((e) => e.to === id);
  const outgoing = network.edges.filter((e) => e.from === id);
  const names = new Map(state.participants.map((p) => [p.id, p.name]));
  const label = (other) => terminalLabel(state, other) ? `${terminalLabel(state, other)} (${names.get(other)})` : names.get(other);
  const final = frame.kind === 'final';
  const cut = new Set(final ? frame.cut.edges : []);
  const isSource = id === network.source;
  const isSink = id === network.sink;
  const down = participant.down;

  const card = document.getElementById('card');
  card.className = `phone-card${isSource ? ' role-source' : ''}${isSink ? ' role-sink' : ''}${down ? ' role-down' : ''}`;
  document.getElementById('role').textContent = down ? 'En panne' : isSource ? 'Tu es la source' : isSink ? 'Tu es le puits' : 'Tu es un routeur';
  document.getElementById('pname').textContent = participant.name;

  const input = totalFlow(frame, incoming.filter((e) => !e.down));
  const output = totalFlow(frame, outgoing.filter((e) => !e.down));
  const mineInCut = [...incoming, ...outgoing].filter((e) => cut.has(e.id));

  const children = [
    down ? el('div', { class: 'alert down' }, el('b', { text: 'Ton routeur est hors service' }), 'Le réseau a recalculé le flot sans toi.') : pathAlert(frame, id),
    final && mineInCut.length && !down ? el('div', { class: 'alert cut' },
      el('b', { text: mineInCut.length > 1 ? `${mineInCut.length} de tes liens limitent le réseau` : 'Un de tes liens limite le réseau' }),
      mineInCut.length > 1 ? 'Ils font partie de la coupe minimale.' : 'Il fait partie de la coupe minimale.') : null,
    el('div', { class: 'global' }, el('span', { text: final ? 'Débit maximal du réseau' : 'Débit total du réseau' }), el('strong', { text: `${frame.value} Mbps` })),
    !down ? el('div', { class: 'balance' },
      el('div', {}, el('span', { text: 'Tu reçois' }), el('strong', {}, String(input), el('small', { text: 'Mbps' }))),
      el('div', {}, el('span', { text: 'Tu envoies' }), el('strong', {}, String(output), el('small', { text: 'Mbps' })))) : null,
    !down && !isSource && !isSink ? el('p', { class: 'conservation', text: input === output ? 'Conservation respectée : tout ce qui entre ressort.' : '' }) : null,
    incoming.length ? el('div', { class: 'links' }, el('h3', { class: 'section-title', text: 'Liens entrants' }), incoming.map((e) => linkRow(frame, e, label(e.from), cut))) : null,
    outgoing.length ? el('div', { class: 'links' }, el('h3', { class: 'section-title', text: 'Liens sortants' }), outgoing.map((e) => linkRow(frame, e, label(e.to), cut))) : null,
    el('div', {}, el('h3', { class: 'section-title', text: 'Le réseau entier', style: 'margin-bottom:6px' }), map),
    failError ? el('p', { class: 'error', role: 'alert', text: failError }) : null,
    state.allowFailures && !down && !isSource && !isSink ? el('button', {
      type: 'button',
      class: 'danger fail-button',
      text: 'Mettre mon routeur en panne',
      onclick: () => socket.emit('student:fail', {}, (r) => { failError = r?.ok ? '' : r?.error ?? ''; render(); }),
    }) : null,
  ];
  main.replaceChildren(...children.filter(Boolean));
  graph.render(state, { you: id });
}

function renderSpectator(participant) {
  if (screen !== 'spectator') {
    main = el('section', { class: 'phone-main' });
    const svgRoot = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgRoot.setAttribute('role', 'img');
    svgRoot.setAttribute('aria-label', 'Vue d’ensemble du réseau');
    map = el('div', { class: 'mini-map' }, svgRoot);
    graph = new FlowGraph(svgRoot, { compact: true });
    app.replaceChildren(el('div', { class: 'phone' },
      el('header', { class: 'phone-card' },
        el('div', { class: 'phone-role', text: 'Tu suis en spectateur' }),
        el('div', { class: 'phone-name', text: participant.name })),
      main));
    screen = 'spectator';
  }
  const { frame } = state;
  main.replaceChildren(
    el('p', { text: 'Le réseau est déjà formé. Tu rejoindras les sommets au prochain tirage.' }),
    el('div', { class: 'global' }, el('span', { text: frame.kind === 'final' ? 'Débit maximal du réseau' : 'Débit total du réseau' }), el('strong', { text: `${frame.value} Mbps` })),
    map,
  );
  graph.render(state);
}

function render() {
  if (!state) return;
  if (me) {
    const participant = state.participants.find((p) => p.id === me.id);
    if (participant) me.seen = true;
    if (!participant && !me.seen) {
      // Confirmation reçue avant l'état : on attend la prochaine diffusion.
      return;
    }
    if (!participant) {
      // La salle a été vidée entre-temps.
      me = null;
      saveToken(null);
    } else if (state.phase === 'lobby') {
      screen = 'waiting';
      graph = null;
      waitingScreen(participant);
      return;
    } else if (participant.spectator) {
      renderSpectator(participant);
      return;
    } else {
      renderMember(participant);
      return;
    }
  }
  if (screen !== 'join' || !document.getElementById('nom')) {
    screen = 'join';
    joinScreen();
  }
}
