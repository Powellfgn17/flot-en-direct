/** Serveur HTTP et temps réel. */
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import { Session } from './session.js';

const here = dirname(fileURLToPath(import.meta.url));
const SPEEDS = { lent: 3200, normal: 1900, rapide: 800 };

function lanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const a of addresses ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

function sameKey(a, b) {
  if (typeof a !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function startServer({ port = 3000, presenterKey, publicUrl, speeds = SPEEDS } = {}) {
  const key = presenterKey || randomBytes(4).toString('hex');
  const session = new Session();
  const app = express();
  app.set('trust proxy', true);
  const http = createServer(app);
  const io = new Server(http, { maxHttpBufferSize: 1e4, pingInterval: 10000, pingTimeout: 8000 });

  const page = (name) => (_req, res) => res.sendFile(join(here, '..', 'public', name));
  app.get('/', page('index.html'));
  app.get('/presentateur', page('presentateur.html'));
  app.get('/projecteur', page('projecteur.html'));
  app.use(express.static(join(here, '..', 'public'), { index: false, maxAge: '1h' }));

  const joinUrlFor = (req) => {
    if (publicUrl) return publicUrl;
    const host = req.get('host') ?? '';
    if (/^(localhost|127\.|\[::1\])/.test(host)) {
      const lan = lanAddress();
      if (lan) return `http://${lan}:${http.address().port}`;
    }
    return `${req.protocol}://${host}`;
  };

  app.get('/api/salle', async (req, res) => {
    const url = joinUrlFor(req);
    const qr = await QRCode.toString(url, {
      type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#101d3aff', light: '#00000000' },
    });
    res.json({ url, qr });
  });

  // ---------- Lecture automatique ----------
  const playback = { playing: false, speed: 'normal', timer: null };

  const broadcast = () => {
    io.emit('state', { ...session.publicState(), playing: playback.playing, speed: playback.speed });
  };

  const stopPlayback = () => {
    playback.playing = false;
    clearTimeout(playback.timer);
    playback.timer = null;
  };

  const schedule = () => {
    clearTimeout(playback.timer);
    playback.timer = setTimeout(() => {
      if (!playback.playing) return;
      session.next();
      if (session.atEnd) stopPlayback();
      else schedule();
      broadcast();
    }, speeds[playback.speed]);
  };

  const commands = {
    addBots: ({ count }) => session.addBots(count),
    remove: ({ id }) => {
      const removed = session.removeParticipant(id);
      if (removed.token) io.to(`p:${removed.id}`).emit('removed');
    },
    build: ({ seed } = {}) => { stopPlayback(); session.build(Number.isInteger(seed) ? seed >>> 0 : undefined); },
    lobby: () => { stopPlayback(); session.backToLobby(); },
    next: () => { stopPlayback(); session.next(); },
    previous: () => { stopPlayback(); session.previous(); },
    rewind: () => { stopPlayback(); session.rewind(); },
    finish: () => { stopPlayback(); session.finish(); },
    play: () => {
      if (session.phase !== 'network') throw new Error("Crée d'abord le réseau.");
      if (session.atEnd) session.rewind();
      playback.playing = true;
      schedule();
    },
    pause: () => stopPlayback(),
    speed: ({ speed }) => {
      if (!Object.hasOwn(speeds, speed)) throw new Error('Vitesse inconnue.');
      playback.speed = speed;
      if (playback.playing) schedule();
    },
    strategy: ({ strategy }) => { stopPlayback(); session.setStrategy(strategy); },
    view: ({ view }) => session.setView(view),
    allowFailures: ({ value }) => session.setAllowFailures(value),
    failNode: ({ id }) => { stopPlayback(); session.failNode(id); },
    restoreNode: ({ id }) => { stopPlayback(); session.restoreNode(id); },
    capacity: ({ edgeId, capacity }) => { stopPlayback(); session.setCapacity(edgeId, capacity); },
    toggleEdge: ({ edgeId }) => { stopPlayback(); session.toggleEdge(edgeId); },
    restoreAll: () => { stopPlayback(); session.restoreAll(); },
    resetRoom: () => {
      stopPlayback();
      session.reset();
      io.emit('removed');
    },
  };

  io.use((socket, next) => {
    const { role, key: given } = socket.handshake.auth ?? {};
    if (role === 'presenter' && !sameKey(given, key)) return next(new Error('cle-invalide'));
    socket.data.role = role === 'presenter' ? 'presenter' : 'viewer';
    return next();
  });

  const attach = (socket, participant) => {
    if (socket.data.participant) return;
    socket.data.participant = participant;
    participant.connections += 1;
    socket.join(`p:${participant.id}`);
  };

  const respond = (ack, payload) => { if (typeof ack === 'function') ack(payload); };

  io.on('connection', (socket) => {
    socket.emit('state', { ...session.publicState(), playing: playback.playing, speed: playback.speed });

    socket.on('student:join', (payload, ack) => {
      try {
        if (socket.data.participant) throw new Error('Tu as déjà rejoint le réseau.');
        const participant = session.join(payload?.name);
        attach(socket, participant);
        // L'état part avant l'accusé : le téléphone se trouve déjà dans la liste quand il reçoit sa confirmation.
        broadcast();
        respond(ack, { ok: true, id: participant.id, token: participant.token, name: participant.name });
      } catch (error) {
        respond(ack, { ok: false, error: error.message });
      }
    });

    socket.on('student:resume', (payload, ack) => {
      const participant = session.resume(payload?.token);
      if (!participant) return respond(ack, { ok: false });
      attach(socket, participant);
      broadcast();
      return respond(ack, { ok: true, id: participant.id, name: participant.name });
    });

    socket.on('student:fail', (_payload, ack) => {
      try {
        if (!socket.data.participant) throw new Error('Rejoins d’abord le réseau.');
        stopPlayback();
        session.failSelf(socket.data.participant);
        respond(ack, { ok: true });
        broadcast();
      } catch (error) {
        respond(ack, { ok: false, error: error.message });
      }
    });

    socket.on('presenter:command', (payload, ack) => {
      if (socket.data.role !== 'presenter') return respond(ack, { ok: false, error: 'Commande réservée au présentateur.' });
      const command = commands[payload?.type];
      if (!command || !Object.hasOwn(commands, payload.type)) return respond(ack, { ok: false, error: 'Commande inconnue.' });
      try {
        command(payload);
        respond(ack, { ok: true });
        return broadcast();
      } catch (error) {
        return respond(ack, { ok: false, error: error.message });
      }
    });

    socket.on('disconnect', () => {
      // Un téléphone verrouillé n'enlève jamais son sommet : seul l'indicateur de connexion change.
      const { participant } = socket.data;
      if (!participant) return;
      participant.connections = Math.max(0, participant.connections - 1);
      broadcast();
    });
  });

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, () => {
      resolve({
        port: http.address().port,
        key,
        session,
        close: () => new Promise((done) => { stopPlayback(); io.close(() => done()); }),
      });
    });
  });
}
