import { FlowGraph } from './graph.js';
import { el, describeFrame, pathText, connectionBanner, nameMap } from './common.js';

const key = new URLSearchParams(location.search).get('cle') ?? '';
const socket = io({ auth: { role: 'presenter', key } });
connectionBanner(socket, document.getElementById('banner'));
const app = document.getElementById('app');
let state = null;
let mode = null;
let graph = null;
let selection = null;
let salle = null;
let confirmReset = false;
let errorText = '';
let errorTimer = null;

socket.on('connect_error', (error) => {
  if (error.message === 'cle-invalide') {
    socket.disconnect();
    document.getElementById('banner').hidden = true;
    app.replaceChildren(el('main', { class: 'gate' },
      el('h1', { text: 'Clé présentateur incorrecte' }),
      el('p', { text: 'Ouvre le lien affiché dans le terminal au démarrage du serveur : il contient la bonne clé.' })));
  }
});

fetch('/api/salle').then((r) => r.json()).then((data) => { salle = data; if (mode === 'lobby') render(); });

function send(type, payload = {}) {
  socket.emit('presenter:command', { type, ...payload }, (response) => {
    if (response && !response.ok) showError(response.error);
  });
}

function showError(message) {
  errorText = message;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => { errorText = ''; render(); }, 5000);
  render();
}

const button = (text, onclick, attrs = {}) => el('button', { type: 'button', text, onclick, ...attrs });

function segment(options, current, onPick) {
  return el('div', { class: 'segment', role: 'group' }, options.map(([value, label]) => el('button', {
    type: 'button', text: label, 'aria-pressed': String(value === current), onclick: () => onPick(value),
  })));
}

function renderLobby() {
  const count = state.participants.length;
  const { minNodes, maxNodes } = state.limits;
  const missing = Math.max(0, minNodes - count);
  const humans = state.participants.filter((p) => !p.bot).length;
  const notes = [];
  if (missing) notes.push(`${missing} sommet${missing > 1 ? 's' : ''} simulé${missing > 1 ? 's' : ''} seront ajoutés pour atteindre le minimum de ${minNodes}.`);
  if (humans > maxNodes) notes.push(`Limite de ${maxNodes} sommets : les ${humans - maxNodes} derniers étudiants suivront en spectateurs.`);

  app.replaceChildren(el('main', { class: 'stage' },
    el('section', { class: 'stage-graph' },
      el('div', { class: 'lobby-room' },
        el('div', {},
          el('div', { class: 'count', text: String(count) }),
          el('div', { class: 'count-label', text: count > 1 ? 'sommets dans la salle' : 'sommet dans la salle' })),
        el('div', { class: 'qr', style: 'width:min(34vw,44vh)', role: 'img', 'aria-label': 'QR code pour rejoindre', id: 'qr' }),
        el('p', { class: 'join-url', text: salle?.url ?? '' }))),
    el('aside', { class: 'rail presenter-rail' },
      button('Créer le réseau', () => send('build'), { class: 'primary' }),
      notes.length ? el('p', { class: 'hint', text: notes.join(' ') }) : null,
      el('p', { class: 'error', role: 'alert', text: errorText }),
      el('div', { class: 'toolbar' },
        button('+1 sommet simulé', () => send('addBots', { count: 1 })),
        button('+5', () => send('addBots', { count: 5 })),
        button('+10', () => send('addBots', { count: 10 }))),
      el('ul', { class: 'participants' }, state.participants.map((p) => el('li', {},
        el('span', {}, p.name, ' ', el('span', { class: 'tag', text: p.bot ? 'simulé' : p.online ? '' : 'hors ligne' })),
        button('Retirer', () => send('remove', { id: p.id }))))),
      button('Ouvrir la vue projecteur', () => window.open('/projecteur', '_blank')),
      resetButton())));
  const qr = document.getElementById('qr');
  if (qr && salle) qr.innerHTML = salle.qr;
}

function resetButton() {
  return button(confirmReset ? 'Confirmer : tout le monde est déconnecté' : 'Vider la salle', () => {
    if (confirmReset) { confirmReset = false; send('resetRoom'); } else { confirmReset = true; render(); setTimeout(() => { confirmReset = false; render(); }, 4000); }
  }, { class: 'danger' });
}

function selectionPanel() {
  if (!selection) return el('p', { class: 'hint', text: 'Clique sur un sommet pour simuler une panne, ou sur un lien pour modifier sa capacité.' });
  const names = nameMap(state);
  const { network, frame, limits } = state;
  if (selection.type === 'node') {
    const node = network.nodes.find((n) => n.id === selection.id);
    if (!node) return null;
    const terminal = node.id === network.source ? 'Source' : node.id === network.sink ? 'Puits' : null;
    const input = network.edges.filter((e) => e.to === node.id).reduce((s, e) => s + (frame.flows[e.id] ?? 0), 0);
    const output = network.edges.filter((e) => e.from === node.id).reduce((s, e) => s + (frame.flows[e.id] ?? 0), 0);
    return el('div', { class: 'panel' },
      el('h3', { text: terminal ? `${terminal} : ${node.name}` : node.name }),
      el('p', { text: `Entrant : ${input} Mbps. Sortant : ${output} Mbps.` }),
      terminal ? el('p', { class: 'hint', text: 'La source et le puits ne peuvent pas tomber en panne.' })
        : node.down ? button('Rétablir ce sommet', () => send('restoreNode', { id: node.id }), { class: 'primary' })
          : button('Mettre en panne', () => send('failNode', { id: node.id }), { class: 'danger' }));
  }
  const edge = network.edges.find((e) => e.id === selection.id);
  if (!edge) return null;
  const route = `${names.get(edge.from)} → ${names.get(edge.to)}`;
  const nodeDown = network.nodes.some((n) => n.down && (n.id === edge.from || n.id === edge.to));
  return el('div', { class: 'panel' },
    el('h3', { text: route }),
    el('p', { text: `Flot actuel : ${frame.flows[edge.id] ?? 0} Mbps.` }),
    el('div', { class: 'stepper' },
      button('−', () => send('capacity', { edgeId: edge.id, capacity: edge.capacity - limits.capacityStep }), { 'aria-label': 'Réduire la capacité', disabled: edge.capacity <= 0 }),
      el('span', { text: `${edge.capacity} Mbps` }),
      button('+', () => send('capacity', { edgeId: edge.id, capacity: edge.capacity + limits.capacityStep }), { 'aria-label': 'Augmenter la capacité', disabled: edge.capacity >= limits.maxCapacity })),
    nodeDown ? el('p', { class: 'hint', text: 'Un sommet de ce lien est en panne.' })
      : button(edge.linkCut ? 'Rétablir ce lien' : 'Couper ce lien', () => send('toggleEdge', { edgeId: edge.id }), { class: edge.linkCut ? 'primary' : 'danger' }));
}

function renderNetwork() {
  const { frame } = state;
  const svgRoot = graph.root;
  const atStart = frame.index === 0;
  const atEnd = frame.index >= frame.total - 1;
  const text = describeFrame(state);
  const modified = state.history.length > 0;

  const rail = el('aside', { class: 'rail presenter-rail' },
    el('div', {}, el('div', { class: 'meter-label', text: 'Débit total' }),
      el('div', { class: 'meter', style: 'font-size:72px' }, String(frame.value), el('small', { text: 'Mbps' }))),
    frame.kind === 'final' ? el('div', { class: 'equality', text: `Flot maximal = ${frame.value} = coupe minimale (${frame.cut.capacity})` }) : null,
    el('div', { class: 'explain' },
      el('h2', { text: text.title }),
      text.path ? el('div', { class: 'route', text: text.path }) : null,
      el('p', { text: text.body, style: 'font-size:15.5px' })),
    el('p', { class: 'error', role: 'alert', text: errorText }),
    el('div', { class: 'progress' }, el('i', { style: `width:${(frame.index / Math.max(1, frame.total - 1)) * 100}%` })),
    el('div', { class: 'toolbar' },
      button('Précédent', () => send('previous'), { disabled: atStart }),
      button('Suivant', () => send('next'), { class: 'primary', disabled: atEnd })),
    el('div', { class: 'toolbar' },
      button(state.playing ? 'Pause' : atEnd ? 'Rejouer' : 'Lecture', () => send(state.playing ? 'pause' : 'play')),
      button('Résultat', () => send('finish'), { disabled: atEnd }),
      button('Début', () => send('rewind'), { disabled: atStart })),
    el('div', { class: 'field' }, el('span', { text: 'Vitesse' }),
      segment([['lent', 'Lente'], ['normal', 'Normale'], ['rapide', 'Rapide']], state.speed, (speed) => send('speed', { speed }))),
    el('div', { class: 'field' }, el('span', { text: 'Affichage' }),
      segment([['flow', 'Réseau'], ['residual', 'Graphe résiduel']], state.view, (view) => send('view', { view }))),
    el('div', { class: 'field' }, el('span', { text: 'Recherche de chemin' }),
      segment([['dfs', 'DFS (Ford-Fulkerson)'], ['bfs', 'BFS (Edmonds-Karp)']], state.strategy, (strategy) => send('strategy', { strategy }))),
    el('label', { class: 'check' },
      el('input', { type: 'checkbox', checked: state.allowFailures, onchange: (e) => send('allowFailures', { value: e.target.checked }) }),
      'Les étudiants peuvent se mettre en panne'),
    selectionPanel(),
    modified ? el('div', {},
      el('h3', { class: 'section-title', text: 'Événements' }),
      ...state.history.slice(-4).map((h) => el('div', { class: 'history-item' }, el('span', { text: h.label }), el('b', { text: `${h.before} → ${h.after}` })))) : null,
    modified ? button('Rétablir le réseau initial', () => send('restoreAll')) : null,
    state.log.length ? el('div', {},
      el('h3', { class: 'section-title', text: `${state.log.length} chemin${state.log.length > 1 ? 's' : ''} augmentant${state.log.length > 1 ? 's' : ''}` }),
      el('ol', { class: 'log' }, [...state.log].reverse().map((entry) => el('li', {},
        el('span', { class: 'add', text: `+${entry.bottleneck}` }),
        el('span', {}, pathText(state, entry.path), entry.usesInverse ? el('span', { class: 'inverse-tag', text: ' (arc inverse)' }) : null),
        el('b', { text: String(entry.value) }))))) : null,
    el('div', { class: 'toolbar' },
      button('Nouveau tirage', () => { selection = null; send('build'); }),
      button('Retour à la salle', () => { selection = null; send('lobby'); })),
    button('Ouvrir la vue projecteur', () => window.open('/projecteur', '_blank')));

  const main = app.firstElementChild;
  if (!main || main.dataset.mode !== 'network') {
    const stage = el('main', { class: 'stage', 'data-mode': 'network' },
      el('section', { class: 'stage-graph' }, svgRoot), rail);
    app.replaceChildren(stage);
  } else {
    const oldRail = main.querySelector('.rail');
    const scroll = oldRail.scrollTop;
    oldRail.replaceWith(rail);
    rail.scrollTop = scroll;
  }
  graph.render(state, { selection });
}

function render() {
  if (!state) return;
  if (state.phase === 'lobby') renderLobby();
  else renderNetwork();
}

socket.on('state', (next) => {
  state = next;
  if (state.phase !== mode) {
    mode = state.phase;
    selection = null;
    if (mode === 'network') {
      app.replaceChildren();
      const svgRoot = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svgRoot.setAttribute('role', 'img');
      svgRoot.setAttribute('aria-label', 'Réseau et circulation du flot');
      graph = new FlowGraph(svgRoot, {
        onNode: (id) => { selection = { type: 'node', id }; render(); },
        onEdge: (id) => { selection = { type: 'edge', id }; render(); },
      });
    }
  }
  render();
});

window.addEventListener('keydown', (event) => {
  if (!state || state.phase !== 'network' || event.target.matches('input')) return;
  const actions = {
    ArrowRight: () => send('next'),
    PageDown: () => send('next'),
    ArrowLeft: () => send('previous'),
    PageUp: () => send('previous'),
    ' ': () => send(state.playing ? 'pause' : 'play'),
    r: () => send('view', { view: state.view === 'flow' ? 'residual' : 'flow' }),
    Escape: () => { selection = null; render(); },
  };
  const action = actions[event.key];
  if (action) {
    if (event.key === ' ' && event.target.matches('button')) return;
    event.preventDefault();
    action();
  }
});
