/**
 * Dessin du réseau en SVG. Chaque lien est une conduite : sa largeur suit la
 * capacité, son remplissage suit le flot, les points se déplacent dans le sens
 * du flot et d'autant plus vite que le débit est élevé.
 */
const NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}, parent) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (parent) parent.appendChild(node);
  return node;
}

function cubic(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

/** Courbe d'un lien : horizontale entre colonnes, en arc à l'intérieur d'une colonne. */
function curveBetween(a, b) {
  const dx = b.x - a.x;
  if (Math.abs(dx) < 4) {
    const bulge = Math.min(70, 26 + Math.abs(b.y - a.y) * 0.3);
    return [a, { x: a.x + bulge, y: a.y + (b.y - a.y) * 0.2 }, { x: b.x + bulge, y: b.y - (b.y - a.y) * 0.2 }, b];
  }
  return [a, { x: a.x + dx * 0.5, y: a.y }, { x: b.x - dx * 0.5, y: b.y }, b];
}

const pathOf = ([a, c1, c2, b]) => `M${a.x} ${a.y}C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${b.x} ${b.y}`;

/** Décale une courbe sur le côté, pour séparer l'arc direct de l'arc inverse dans le graphe résiduel. */
function offsetCurve(curve, distance) {
  const [a, , , b] = curve;
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const nx = -(b.y - a.y) / length;
  const ny = (b.x - a.x) / length;
  return curve.map((p) => ({ x: p.x + nx * distance, y: p.y + ny * distance }));
}

function trimmedPolyline(curve, startGap, endGap) {
  const [a, , , b] = curve;
  const points = [];
  for (let i = 0; i <= 48; i++) {
    const p = cubic(...curve, i / 48);
    if (Math.hypot(p.x - a.x, p.y - a.y) >= startGap && Math.hypot(p.x - b.x, p.y - b.y) >= endGap) points.push(p);
  }
  return points.length > 1 ? `M${points.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('L')}` : '';
}

const pipeWidth = (capacity, compact) => {
  const scale = compact ? [2, 8] : [7, 26];
  return scale[0] + ((scale[1] - scale[0]) * Math.min(capacity, 120)) / 120;
};

function initials(name) {
  const parts = name.trim().split(/\s+/);
  const last = parts[parts.length - 1];
  if (parts.length > 1 && /^\d+$/.test(last)) return (parts[0][0] + last).toLocaleUpperCase('fr');
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : name.slice(0, 2);
  return letters.toLocaleUpperCase('fr');
}

const shorten = (name, max = 13) => (name.length > max ? `${name.slice(0, max - 1)}…` : name);

export class FlowGraph {
  constructor(root, { compact = false, onNode = null, onEdge = null } = {}) {
    this.root = root;
    this.compact = compact;
    this.onNode = onNode;
    this.onEdge = onEdge;
    this.signature = null;
    this.width = compact ? 400 : 1200;
    this.height = compact ? 400 : 760;
    this.margin = compact ? { x: 20, y: 22 } : { x: 66, y: 56 };
    this.radius = compact ? 9 : 25;
    root.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);
    root.classList.add('graph');
    if (compact) root.classList.add('graph-compact');
    this._defs();
    this.edgeLayer = svg('g', {}, root);
    this.residualLayer = svg('g', { class: 'residual-layer' }, root);
    this.labelLayer = svg('g', {}, root);
    this.nodeLayer = svg('g', {}, root);
    this.edges = new Map();
    this.nodes = new Map();
  }

  _defs() {
    const defs = svg('defs', {}, this.root);
    for (const [id, cls] of [['fleche-direct', 'marker-direct'], ['fleche-inverse', 'marker-inverse'], ['fleche-chemin', 'marker-chemin']]) {
      const marker = svg('marker', {
        id, viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto', markerUnits: 'userSpaceOnUse',
      }, defs);
      marker.setAttribute('markerWidth', 12);
      marker.setAttribute('markerHeight', 12);
      svg('path', { d: 'M1 1L9 5L1 9Z', class: cls }, marker);
    }
  }

  _point(id, positions) {
    const p = positions[id];
    return {
      x: this.margin.x + p.x * (this.width - 2 * this.margin.x),
      y: this.margin.y + p.y * (this.height - 2 * this.margin.y),
    };
  }

  _build(network) {
    for (const layer of [this.edgeLayer, this.labelLayer, this.nodeLayer]) layer.replaceChildren();
    this.edges.clear();
    this.nodes.clear();
    this.points = new Map(network.nodes.map((n) => [n.id, this._point(n.id, network.positions)]));

    network.edges.forEach((edge, index) => {
      const curve = curveBetween(this.points.get(edge.from), this.points.get(edge.to));
      const d = pathOf(curve);
      const group = svg('g', { class: 'edge' }, this.edgeLayer);
      const pipe = svg('path', { d, class: 'pipe' }, group);
      const fill = svg('path', { d, class: 'fill' }, group);
      const dots = svg('path', { d, class: 'dots' }, group);
      const guide = svg('path', { d, class: 'path-guide' }, group);
      const head = svg('path', { class: 'head' }, group);
      const entry = { edge, curve, group, pipe, fill, dots, guide, head };

      if (!this.compact) {
        const t = 0.4 + 0.2 * ((index * 7) % 3) / 2;
        const at = cubic(...curve, t);
        entry.label = svg('text', { x: at.x, y: at.y, class: 'edge-label', 'text-anchor': 'middle', 'dominant-baseline': 'central' }, this.labelLayer);
      }
      if (this.onEdge) {
        const hit = svg('path', { d, class: 'hit' }, group);
        hit.addEventListener('click', () => this.onEdge(edge.id));
      }
      this.edges.set(edge.id, entry);
    });

    for (const node of network.nodes) {
      const at = this.points.get(node.id);
      const group = svg('g', { class: 'node', transform: `translate(${at.x} ${at.y})` }, this.nodeLayer);
      const terminal = node.id === network.source || node.id === network.sink;
      const r = terminal ? this.radius * 1.25 : this.radius;
      svg('circle', { r: r + (this.compact ? 3 : 7), class: 'node-ring' }, group);
      svg('circle', { r, class: 'node-disc' }, group);
      const entry = { group };
      if (!this.compact) {
        const code = terminal ? (node.id === network.source ? 'S' : 'T') : initials(node.name);
        const inner = svg('text', { class: 'node-code', 'text-anchor': 'middle', 'dominant-baseline': 'central', y: 1 }, group);
        inner.textContent = code;
        const name = svg('text', { class: 'node-name', 'text-anchor': 'middle', y: r + 19 }, group);
        name.textContent = shorten(node.name);
        const title = svg('title', {}, group);
        title.textContent = node.name;
      }
      if (this.onNode) {
        group.classList.add('clickable');
        group.addEventListener('click', () => this.onNode(node.id));
      }
      this.nodes.set(node.id, entry);
    }
  }

  _arrow(entry, width) {
    const [, , , b] = entry.curve;
    const [a] = entry.curve;
    // Un lien vertical qui remonte arrive sous le sommet : la flèche s'arrête avant le nom.
    const belowName = !this.compact && Math.abs(a.x - b.x) < 4 && a.y > b.y ? 28 : 0;
    const gap = this.radius + (this.compact ? 4 : 10) + belowName;
    let tip = entry.curve[3];
    let base = tip;
    for (let i = 60; i >= 0; i--) {
      const p = cubic(...entry.curve, i / 60);
      const distance = Math.hypot(p.x - b.x, p.y - b.y);
      if (distance >= gap && tip === b) tip = p;
      if (distance >= gap + (this.compact ? 7 : 15)) { base = p; break; }
    }
    const length = Math.hypot(tip.x - base.x, tip.y - base.y) || 1;
    const ux = (tip.x - base.x) / length;
    const uy = (tip.y - base.y) / length;
    const half = width / 2 + (this.compact ? 2 : 5);
    entry.head.setAttribute('d', `M${tip.x} ${tip.y}L${base.x - uy * half} ${base.y + ux * half}L${base.x + uy * half} ${base.y - ux * half}Z`);
  }

  render(state, { you = null, selection = null } = {}) {
    const { network, frame } = state;
    if (!network) return;
    const signature = JSON.stringify([network.seed, network.nodes.map((n) => n.id), network.edges.map((e) => e.id)]);
    if (signature !== this.signature) {
      this._build(network);
      this.signature = signature;
    }

    const onPath = new Map((frame.arcs ?? []).map((a) => [a.edgeId, a]));
    const pathNodes = new Set(frame.path ?? []);
    const showingPath = frame.kind === 'found' || frame.kind === 'applied';
    const final = frame.kind === 'final';
    const cutEdges = new Set(final ? frame.cut.edges : []);
    const sourceSide = new Set(final ? frame.cut.source : []);
    const residual = state.view === 'residual' && !this.compact;
    this.root.classList.toggle('view-residual', residual);
    this.root.classList.toggle('is-final', final);
    this.root.classList.toggle('has-path', showingPath);

    for (const edge of network.edges) {
      const entry = this.edges.get(edge.id);
      entry.edge = edge;
      const flow = frame.flows[edge.id] ?? 0;
      const width = pipeWidth(edge.capacity, this.compact);
      const ratio = edge.capacity > 0 ? flow / edge.capacity : 0;
      const arc = showingPath ? onPath.get(edge.id) : null;
      const isBottleneck = arc && frame.bottleneckArc?.edgeId === edge.id;
      const cl = entry.group.classList;
      cl.toggle('is-down', edge.down);
      cl.toggle('on-path', Boolean(arc));
      cl.toggle('inverse', Boolean(arc?.inverse));
      cl.toggle('bottleneck', Boolean(isBottleneck));
      cl.toggle('in-cut', cutEdges.has(edge.id));
      cl.toggle('saturated', !edge.down && edge.capacity > 0 && flow === edge.capacity);
      cl.toggle('selected', selection?.type === 'edge' && selection.id === edge.id);
      cl.toggle('mine', Boolean(you) && (edge.from === you || edge.to === you));
      entry.pipe.style.strokeWidth = width;
      entry.guide.style.strokeWidth = width + (this.compact ? 3 : 7);
      entry.fill.style.strokeWidth = flow > 0 ? Math.max(this.compact ? 1.5 : 3, width * ratio) : 0;
      const dotSize = Math.max(this.compact ? 1.2 : 2.5, Math.min(this.compact ? 2.5 : 7, width * ratio * 0.42));
      entry.dots.style.strokeWidth = flow > 0 ? dotSize : 0;
      entry.dots.style.setProperty('--dot-speed', `${Math.max(0.35, 2.6 - (flow / 100) * 2.1).toFixed(2)}s`);
      entry.dots.classList.toggle('moving', flow > 0 && !edge.down);
      this._arrow(entry, width);
      if (entry.label) {
        entry.label.textContent = edge.down ? '' : `${flow}/${edge.capacity}`;
        entry.label.classList.toggle('label-bottleneck', Boolean(isBottleneck));
        entry.label.classList.toggle('label-cut', cutEdges.has(edge.id));
        entry.label.classList.toggle('label-hidden', residual);
      }
    }

    for (const node of network.nodes) {
      const cl = this.nodes.get(node.id).group.classList;
      cl.toggle('is-source', node.id === network.source);
      cl.toggle('is-sink', node.id === network.sink);
      cl.toggle('is-down', node.down);
      cl.toggle('is-bot', node.bot);
      cl.toggle('is-offline', !node.online);
      cl.toggle('on-path', showingPath && pathNodes.has(node.id));
      cl.toggle('side-source', final && sourceSide.has(node.id));
      cl.toggle('side-sink', final && !sourceSide.has(node.id) && !node.down);
      cl.toggle('is-you', node.id === you);
      cl.toggle('selected', selection?.type === 'node' && selection.id === node.id);
    }

    if (residual) this._drawResidual(state, onPath, showingPath);
    else this.residualLayer.replaceChildren();
  }

  /** Graphe résiduel : c − f sur l'arc direct, f sur l'arc inverse, en pointillés. */
  _drawResidual(state, onPath, showingPath) {
    const { network, frame } = state;
    this.residualLayer.replaceChildren();
    const gap = this.radius + 3;
    const addArc = (edge, inverse, amount, onThisPath) => {
      const a = this.points.get(inverse ? edge.to : edge.from);
      const b = this.points.get(inverse ? edge.from : edge.to);
      const curve = inverse
        ? offsetCurve([...curveBetween(this.points.get(edge.from), this.points.get(edge.to))].reverse(), 7)
        : offsetCurve(curveBetween(a, b), 7);
      const d = trimmedPolyline(curve, gap, gap + 3);
      if (!d) return;
      const type = onThisPath ? 'chemin' : inverse ? 'inverse' : 'direct';
      svg('path', {
        d, class: `residual-arc residual-${type}`, 'marker-end': `url(#fleche-${type})`,
      }, this.residualLayer);
      const at = cubic(...curve, inverse ? 0.62 : 0.42);
      const label = svg('text', {
        x: at.x, y: at.y, class: `residual-label residual-label-${type}`, 'text-anchor': 'middle', 'dominant-baseline': 'central',
      }, this.residualLayer);
      label.textContent = amount;
    };
    for (const edge of network.edges) {
      if (edge.down) continue;
      const flow = frame.flows[edge.id] ?? 0;
      const arc = showingPath && frame.kind === 'found' ? onPath.get(edge.id) : null;
      if (edge.capacity - flow > 0) addArc(edge, false, edge.capacity - flow, arc && !arc.inverse);
      if (flow > 0) addArc(edge, true, flow, arc && arc.inverse);
    }
  }
}
