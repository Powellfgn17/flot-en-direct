import { FlowGraph } from './graph.js';
import { el, describeFrame, pathText, connectionBanner } from './common.js';

const socket = io({ auth: { role: 'viewer' } });
connectionBanner(socket, document.getElementById('banner'));
const app = document.getElementById('app');
let salle = null;
let mode = null;
let graph = null;
let parts = null;

fetch('/api/salle').then((r) => r.json()).then((data) => { salle = data; drawLobbyJoin(); });

function drawLobbyJoin() {
  const qr = document.getElementById('qr');
  const url = document.getElementById('join-url');
  if (qr && salle) {
    qr.innerHTML = salle.qr;
    url.textContent = salle.url;
  }
}

function buildLobby() {
  app.replaceChildren(el('main', { class: 'lobby' },
    el('section', { class: 'lobby-join' },
      el('h1', { text: 'Scanne pour devenir un sommet du réseau' }),
      el('div', { class: 'qr', id: 'qr', role: 'img', 'aria-label': 'QR code vers la page pour rejoindre le réseau' }),
      el('p', { class: 'join-url', id: 'join-url' })),
    el('section', { class: 'lobby-room' },
      el('div', {}, el('div', { class: 'count', id: 'count' }), el('div', { class: 'count-label', id: 'count-label' })),
      el('ul', { class: 'stations', id: 'stations' }))));
  drawLobbyJoin();
}

function renderLobby(state) {
  document.getElementById('count').textContent = state.participants.length;
  document.getElementById('count-label').textContent = state.participants.length > 1 ? 'sommets dans la salle' : 'sommet dans la salle';
  document.getElementById('stations').replaceChildren(...state.participants.map((p) => el('li', {
    class: [p.bot ? 'bot' : '', p.online ? '' : 'offline'].join(' ').trim(), text: p.name,
  })));
}

function buildStage() {
  const svgRoot = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgRoot.setAttribute('role', 'img');
  svgRoot.setAttribute('aria-label', 'Réseau et circulation du flot');
  parts = {
    meter: el('div', { class: 'meter' }),
    equality: el('div', { class: 'equality', hidden: true }),
    bar: el('i'),
    explain: el('div', { class: 'explain' }),
    log: el('ol', { class: 'log' }),
    logTitle: el('h3', { class: 'section-title', text: 'Chemins augmentants' }),
    history: el('div'),
  };
  app.replaceChildren(el('main', { class: 'stage' },
    el('section', { class: 'stage-graph' }, svgRoot),
    el('aside', { class: 'rail' },
      el('div', {}, el('div', { class: 'meter-label', id: 'meter-label', text: 'Débit total' }), parts.meter),
      parts.equality,
      el('div', { class: 'progress' }, parts.bar),
      parts.explain,
      parts.history,
      el('div', {}, parts.logTitle, parts.log))));
  graph = new FlowGraph(svgRoot);
}

function renderRail(state, p) {
  const { frame } = state;
  p.meter.replaceChildren(String(frame.value), el('small', { text: 'Mbps' }));
  p.bar.style.width = `${(frame.index / Math.max(1, frame.total - 1)) * 100}%`;
  const final = frame.kind === 'final';
  p.equality.hidden = !final;
  if (final) p.equality.textContent = `Flot maximal = ${frame.value} Mbps = capacité de la coupe minimale (${frame.cut.capacity} Mbps)`;
  const text = describeFrame(state);
  p.explain.replaceChildren(...[
    el('h2', { text: state.view === 'residual' ? `${text.title} (graphe résiduel)` : text.title }),
    text.path ? el('div', { class: 'route', text: text.path }) : null,
    el('p', { text: text.body }),
  ].filter(Boolean));
  p.logTitle.hidden = state.log.length === 0;
  p.log.replaceChildren(...[...state.log].reverse().map((entry) => el('li', {},
    el('span', { class: 'add', text: `+${entry.bottleneck}` }),
    el('span', {}, pathText(state, entry.path), entry.usesInverse ? el('span', { class: 'inverse-tag', text: ' (arc inverse)' }) : null),
    el('b', { text: String(entry.value) }))));
  p.history.replaceChildren(...(state.history.length ? [el('h3', { class: 'section-title', text: 'Événements sur le réseau' })] : []),
    ...state.history.slice(-4).map((h) => el('div', { class: 'history-item' }, el('span', { text: h.label }), el('b', { text: `${h.before} → ${h.after} Mbps` }))));
}

socket.on('state', (state) => {
  if (state.phase !== mode) {
    mode = state.phase;
    if (mode === 'lobby') buildLobby();
    else buildStage();
  }
  if (mode === 'lobby') {
    renderLobby(state);
  } else {
    graph.render(state);
    renderRail(state, parts);
  }
});
