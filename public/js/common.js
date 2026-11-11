/** Fonctions partagées entre les trois écrans. */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, '');
    else if (value !== false && value != null) node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child != null) node.append(child);
  }
  return node;
}

export const nameMap = (state) => new Map(state.participants.map((p) => [p.id, p.name]));

export function terminalLabel(state, id) {
  if (id === state.network?.source) return 'Source';
  if (id === state.network?.sink) return 'Puits';
  return null;
}

export function pathText(state, path) {
  const names = nameMap(state);
  return path.map((id) => terminalLabel(state, id) ?? names.get(id) ?? '?').join(' → ');
}

const arcText = (state, arc) => pathText(state, [arc.from, arc.to]);

/** Décrit l'image en cours en français, pour le projecteur et le présentateur. */
export function describeFrame(state) {
  const { frame } = state;
  switch (frame.kind) {
    case 'initial':
      return { title: 'Flot nul', body: 'Aucun débit ne circule. L’algorithme cherche un premier chemin de la source au puits.' };
    case 'found': {
      const inverse = frame.arcs.filter((a) => a.inverse);
      const parts = [`Goulot : ${frame.bottleneck} Mbps sur ${arcText(state, frame.bottleneckArc)}.`];
      if (inverse.length) {
        const list = inverse.map((a) => arcText(state, a)).join(', ');
        parts.push(inverse.length > 1
          ? `Ce chemin emprunte ${inverse.length} arcs inverses (${list}) : ils annulent du débit déjà envoyé pour le rediriger.`
          : `Ce chemin emprunte un arc inverse (${list}) : il annule du débit déjà envoyé pour le rediriger.`);
      }
      return { title: `Itération ${frame.iteration} : chemin trouvé`, path: pathText(state, frame.path), body: parts.join(' ') };
    }
    case 'applied':
      return {
        title: `Itération ${frame.iteration} : +${frame.bottleneck} Mbps`,
        path: pathText(state, frame.path),
        body: `Le débit total passe à ${frame.value} Mbps. Le graphe résiduel est mis à jour.`,
      };
    case 'final':
      return {
        title: 'Plus aucun chemin',
        body: frame.value === 0
          ? 'La source ne peut pas atteindre le puits : le débit du réseau est nul.'
          : 'La source ne peut plus atteindre le puits dans le graphe résiduel. Les liens en rouge forment la coupe minimale : ce sont eux qui limitent le débit.',
      };
    default:
      return { title: '', body: '' };
  }
}

export function connectionBanner(socket, node) {
  const update = (down) => {
    node.hidden = !down;
    node.textContent = down ? 'Connexion perdue. Reconnexion en cours…' : '';
  };
  socket.on('disconnect', () => update(true));
  socket.on('connect', () => update(false));
}

export function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Stockage indisponible (navigation privée) : la reconnexion automatique ne fonctionnera simplement pas.
  }
  return null;
}
