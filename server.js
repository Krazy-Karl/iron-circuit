// Iron Circuit — serveur LAN. Aucune dépendance : lance simplement `node server.js`.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PUB = path.join(__dirname, 'public');
const THREE = require(path.join(PUB, 'three.min.js'));
const Sim = require(path.join(PUB, 'sim.js'));
const T = Sim.buildTrack(THREE);
const PORT = parseInt(process.argv[2] || process.env.PORT || '3000', 10);
const MAX_CLIENTS = 16;

/* ---------------- HTTP (fichiers du jeu) ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  let url;
  try { url = decodeURIComponent(req.url.split('?')[0]); } catch (e) { res.writeHead(400); return res.end(); }
  if (url === '/') url = '/index.html';
  const file = path.normalize(path.join(PUB, url));
  if (!file.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Introuvable'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

/* ---------------- WebSocket minimal ---------------- */
const clients = new Set();
let nextPid = 1;
function frame(data, op = 1) {
  const len = data.length;
  let h;
  if (len < 126) { h = Buffer.alloc(2); h[1] = len; }
  else if (len < 65536) { h = Buffer.alloc(4); h[1] = 126; h.writeUInt16BE(len, 2); }
  else { h = Buffer.alloc(10); h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
  h[0] = 0x80 | op;
  return Buffer.concat([h, data]);
}
function sendRaw(cl, buf) { if (!cl.open) return; try { cl.socket.write(buf); } catch (e) { drop(cl); } }
function send(cl, obj) { sendRaw(cl, frame(Buffer.from(JSON.stringify(obj)))); }
function broadcast(obj) { const buf = frame(Buffer.from(JSON.stringify(obj))); for (const cl of clients) if (cl.joined) sendRaw(cl, buf); }

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { socket.destroy(); return; }
  if (clients.size >= MAX_CLIENTS) { socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const cl = { socket, id: nextPid++, open: true, joined: false, name: '', color: 0, buf: Buffer.alloc(0), input: {}, queue: [], ack: 0, rk: 0, re: 0, wantRocket: false, wantRear: false, spec: false, lateEv: [] };
  clients.add(cl);
  socket.on('data', d => { cl.buf = Buffer.concat([cl.buf, d]); parseFrames(cl); });
  socket.on('close', () => drop(cl));
  socket.on('error', () => drop(cl));
});
function parseFrames(cl) {
  let b = cl.buf;
  while (b.length >= 2) {
    const op = b[0] & 0x0f, masked = b[1] & 0x80;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) break; len = Number(b.readBigUInt64BE(2)); off = 10; }
    const ml = masked ? 4 : 0;
    if (len > 65536) { cl.socket.destroy(); return; }
    if (b.length < off + ml + len) break;
    let payload = Buffer.from(b.subarray(off + ml, off + ml + len));
    if (masked) { const m = b.subarray(off, off + 4); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
    b = b.subarray(off + ml + len);
    if (op === 1) onMessage(cl, payload.toString('utf8'));
    else if (op === 8) { sendRaw(cl, frame(Buffer.alloc(0), 8)); drop(cl); return; }
    else if (op === 9) sendRaw(cl, frame(payload, 10));
  }
  cl.buf = b;
}
function drop(cl) {
  if (!cl.open) return;
  cl.open = false;
  clients.delete(cl);
  try { cl.socket.destroy(); } catch (e) {}
  if (cl.joined) {
    console.log('  - ' + cl.name + ' a quitté la partie');
    if (race) race.releaseHuman(cl.id);
    broadcastLobby();
  }
}

/* ---------------- Salon & course ---------------- */
let phase = 'lobby', diff = 'detenu', race = null, results = null, finishDeadline = null, tick = 0, ending = false;
const players = () => [...clients].filter(c => c.joined).sort((a, b) => a.id - b.id);
const host = () => players()[0] || null;

function lobbyState() {
  const h = host();
  return { t: 'lobby', phase, diff, addrs: lanAddresses().map(ip => 'http://' + ip + ':' + PORT), host: h ? h.id : null, players: players().map(p => ({ id: p.id, name: p.name, color: p.color, spec: p.spec })), results };
}
function broadcastLobby() { broadcast(lobbyState()); }

function cleanName(s) {
  s = String(s || '').replace(/[^\p{L}\p{N} _\-'.]/gu, '').trim().toUpperCase().slice(0, 14);
  return s || 'PILOTE';
}
function onMessage(cl, txt) {
  let m;
  try { m = JSON.parse(txt); } catch (e) { return; }
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'hello') {
    if (cl.joined) return;
    let name = cleanName(m.name);
    const taken = new Set(players().map(p => p.name));
    for (let n = 2; taken.has(name); n++) name = cleanName(m.name).slice(0, 12) + ' ' + n;
    const used = new Set(players().map(p => p.color));
    let color = 0; while (used.has(color) && color < 5) color++;
    Object.assign(cl, { joined: true, name, color });
    console.log('  + ' + name + ' a rejoint la partie');
    send(cl, { t: 'welcome', id: cl.id, name });
    broadcastLobby();
    if (phase === 'race' && race) send(cl, { t: 'start', cars: race.info(), diff, spectator: true });
    return;
  }
  if (!cl.joined) return;
  const isHost = host() === cl;
  if (m.t === 'in') {
    // one message per client physics step (60 Hz); the server consumes one per tick and acknowledges it
    const i = { sq: +m.sq || 0, th: !!m.th, br: !!m.br, dr: !!m.dr, tu: !!m.tu, fi: !!m.fi, st: Math.max(-1, Math.min(1, +m.st || 0)) };
    if (typeof m.ay === 'number' && isFinite(m.ay)) i.ay = m.ay;
    if (typeof m.ap === 'number' && isFinite(m.ap)) i.ap = m.ap;
    cl.queue.push(i);
    if (cl.queue.length > 8) cl.queue.splice(0, cl.queue.length - 4);
    if (typeof m.rk === 'number' && m.rk > cl.rk) { cl.rk = m.rk; cl.wantRocket = true; }
    if (typeof m.re === 'number' && m.re > cl.re) { cl.re = m.re; cl.wantRear = true; }
  } else if (m.t === 'diff' && isHost && phase === 'lobby' && Sim.DIFFS[m.d]) {
    diff = m.d; broadcastLobby();
  } else if (m.t === 'start' && isHost && phase === 'lobby') {
    startRace();
  } else if (m.t === 'ping') {
    send(cl, { t: 'pong', c: m.c, tps: load.tps, busy: load.busy, q: cl.socket.writableLength });
  } else if (m.t === 'spec' && phase !== 'race') {
    cl.spec = !!m.on; broadcastLobby();
  } else if (m.t === 'lobby' && isHost && phase === 'results') {
    phase = 'lobby'; results = null; broadcastLobby();
  }
}

function startRace() {
  const racers = players().filter(p => !p.spec).slice(0, Sim.C.MAX_CARS);
  if (!racers.length) { send(host(), { t: 'notice', txt: 'Il faut au moins un pilote pour lancer la course.' }); return; }
  race = Sim.createRace(T, { humans: racers.map(p => ({ id: p.id, name: p.name, color: p.color })), diff });
  for (const p of players()) { p.input = {}; p.queue = []; p.ack = 0; p.wantRocket = p.wantRear = false; }
  phase = 'race'; finishDeadline = null; results = null; ending = false;
  broadcastLobby();
  for (const p of players()) send(p, { t: 'start', cars: race.info(), diff, spectator: !racers.includes(p) });
  console.log('  > Départ ! ' + racers.length + ' joueur(s) + ' + (Sim.C.MAX_CARS - racers.length) + ' IA, difficulté ' + diff);
}
function endRace() {
  results = race.results();
  phase = 'results'; race = null;
  broadcast({ t: 'results', rows: results });
  broadcastLobby();
  console.log('  < Course terminée. Vainqueur : ' + results[0].name);
}

// Fixed 60 Hz simulation. Timers are coarse on Windows (~16 ms), so we poll often,
// run as many fixed steps as real time requires, then send one snapshot.
const STEP = 1 / 60;
let last = process.hrtime.bigint(), acc = 0;
// load figures for the F3 display: simulation steps per second and ms of work per second
const load = { tps: 0, busy: 0, steps: 0, ns: 0n, since: process.hrtime.bigint() };
setInterval(() => {
  const now = process.hrtime.bigint();
  if (now - load.since >= 1000000000n) {
    load.tps = load.steps; load.busy = Math.round(Number(load.ns) / 1e5) / 10;
    load.steps = 0; load.ns = 0n; load.since = now;
  }
  const t0 = now;
  try { serverTick(now); } finally { load.ns += process.hrtime.bigint() - t0; }
}, 4);
function serverTick(now) {
  acc = Math.min(acc + Number(now - last) / 1e9, 0.25);
  last = now;
  if (phase !== 'race' || !race) { acc = 0; return; }
  if (acc < STEP) return;
  const list = players();
  while (acc >= STEP && race) {
    acc -= STEP;
    const inputs = {};
    for (const p of list) {
      const car = race.cars.find(c => c.pid === p.id && c.human);
      if (!car) continue;
      if (p.queue.length) { p.input = p.queue.shift(); p.ack = p.input.sq; }
      inputs[car.id] = Object.assign({}, p.input, { rk: p.wantRocket, re: p.wantRear });
      p.wantRocket = p.wantRear = false;
    }
    race.step(STEP, inputs); load.steps++;
    if (checkEnd()) break;
  }
  if (!race) return;
  const snap = race.snapshot();
  snap.ak = {};
  for (const p of list) { const car = race.cars.find(c => c.pid === p.id); if (car) snap.ak[car.id] = p.ack; }
  broadcastSnap(snap);
}
// A client whose connection backs up only gets the newest snapshot (with the events it missed),
// so a slow browser never builds a growing delay.
function broadcastSnap(snap) {
  const ev = snap.ev;
  let shared = null;
  for (const cl of clients) {
    if (!cl.joined || !cl.open) continue;
    if (cl.socket.writableLength > 8192) {
      for (const e of ev) cl.lateEv.push(e);
      if (cl.lateEv.length > 400) cl.lateEv.splice(0, cl.lateEv.length - 400);
      continue;
    }
    if (cl.lateEv.length) {
      snap.ev = cl.lateEv.concat(ev); cl.lateEv = [];
      sendRaw(cl, frame(Buffer.from(JSON.stringify(snap))));
      snap.ev = ev;
    } else {
      if (!shared) shared = frame(Buffer.from(JSON.stringify(snap)));
      sendRaw(cl, shared);
    }
  }
}

function checkEnd() {
  // fin de course : tous les humains arrivés, ou délai après le premier arrivé
  const humans = race.cars.filter(c => c.human);
  if (!humans.length) { endRace(); return true; }
  if (ending) return false;
  if (humans.every(c => c.finished)) {
    ending = true; setTimeout(() => { if (race && phase === 'race') endRace(); }, 1500);
    return false;
  }
  if (finishDeadline === null && humans.some(c => c.finished)) {
    finishDeadline = race.raceTime + Sim.C.FINISH_GRACE;
    broadcast({ t: 'deadline', s: Sim.C.FINISH_GRACE });
  }
  if (finishDeadline !== null && race.raceTime > finishDeadline) { endRace(); return true; }
  return false;
}

/* ---------------- Démarrage ---------------- */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
    if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a.address);
  }
  return out;
}
server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error('\n  Le port ' + PORT + ' est déjà utilisé. Ferme l’autre serveur ou lance : node server.js 3001\n');
  else console.error(e);
  process.exit(1);
});
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  IRON CIRCUIT — serveur LAN prêt\n');
  console.log('  Sur ce PC        : http://localhost:' + PORT);
  const ips = lanAddresses();
  if (ips.length) for (const ip of ips) console.log('  Pour les autres  : http://' + ip + ':' + PORT);
  else console.log('  Aucune adresse réseau trouvée : vérifie que ce PC est connecté au Wi-Fi ou au câble.');
  console.log('\n  Laisse cette fenêtre ouverte pendant la partie. Ctrl+C pour arrêter.\n');
});
