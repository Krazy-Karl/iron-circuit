/* Iron Circuit — shared race simulation.
   Runs authoritative on the LAN server (Node) and provides track data to the browser client. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IronSim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';
const PI = Math.PI, TAU = PI * 2;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const wrapA = a => { while (a > PI) a -= TAU; while (a < -PI) a += TAU; return a; };
const rnd = (a, b) => a + Math.random() * (b - a);
function mulberry(seed) {
  return function () {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const C = {
  LAPS: 3, N: 1200, HALF_W: 11, CAR_R: 1.5, BASE_MAX: 36, KMH: 2.8,
  TURRET_ARC: 75 * PI / 180, PITCH_MIN: -10 * PI / 180, PITCH_MAX: 10 * PI / 180, GUN_Y: 2.04, ARM_DELAY: 5, RESPAWN_DELAY: 2.5, MAX_CARS: 6, FINISH_GRACE: 45,
  ARENA_TIME: 180, ARENA_KILLS: 10, ARENA_ARM: 3
};
const DIFFS = {
  recrue:  { speed: 0.86, acc: 0.35, aggr: 0.55, dmg: 0.7 },
  detenu:  { speed: 0.95, acc: 0.6,  aggr: 0.8,  dmg: 0.9 },
  legende: { speed: 1.02, acc: 0.85, aggr: 1.0,  dmg: 1.1 }
};
const CTRL = [[-60,0],[60,0],[150,0],[200,20],[220,70],[200,120],[150,135],[110,170],[120,220],[170,250],[190,300],[150,345],[80,350],[20,320],[-10,260],[-60,230],[-120,250],[-170,220],[-190,160],[-160,100],[-180,50],[-150,5]];
const COLORS = [0xff6a1a, 0x2f6fd6, 0xd8b02a, 0x2a9e6a, 0xc23a4a, 0x8a5ad8];
const AI_NAMES = ['RASOIR', 'BULLDOZER', 'VEUVE NOIRE', 'LE BOUCHER', 'KRYPTE', 'FERRAILLE'];
const PAD_GROUPS = [160, 340, 520, 700, 880, 1060], PAD_LAT = [-6, 0, 6];
const PAD_ORDER = [['rocket', 'rear', 'repair'], ['rear', 'repair', 'rocket'], ['repair', 'rocket', 'rear']];
const REAR_KEYS = ['oil', 'mines', 'smoke'], REAR_N = { oil: 2, mines: 3, smoke: 1 }, REAR_CODE = { oil: 1, mines: 2, smoke: 3 };
// snapshot layout of one car
const F = { x: 0, z: 1, h: 2, vF: 3, vL: 4, tur: 5, armor: 6, flags: 7, steer: 8, nitro: 9, rockets: 10, rear: 11, rearN: 12, heat: 13, overheat: 14, progress: 15, finishTime: 16, kills: 17, deaths: 18, respawnT: 19, smokeT: 20, invuln: 21, tp: 22, oil: 23, oilSpin: 24, y: 25, vy: 26 };
const FL = { alive: 1, finished: 2, turbo: 4, drifting: 8, oil: 16, air: 32 };

function buildTrack(THREE) {
  const N = C.N;
  const curve = new THREE.CatmullRomCurve3(CTRL.map(p => new THREE.Vector3(p[0], 0, p[1])), true, 'centripetal');
  const PX = new Float32Array(N), PZ = new Float32Array(N), TX = new Float32Array(N), TZ = new Float32Array(N), NX = new Float32Array(N), NZ = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const p = curve.getPointAt(i / N), t = curve.getTangentAt(i / N);
    PX[i] = p.x; PZ[i] = p.z;
    const l = Math.hypot(t.x, t.z); TX[i] = t.x / l; TZ[i] = t.z / l;
    NX[i] = -TZ[i]; NZ[i] = TX[i];
  }
  const T = { N, PX, PZ, TX, TZ, NX, NZ, SEG: curve.getLength() / N };
  T.tangAng = i => Math.atan2(TX[i], TZ[i]);
  T.nearest = (x, z, hint) => {
    let best = hint, bd = Infinity;
    for (let k = -26; k <= 26; k++) {
      const i = (hint + k + N) % N, dx = x - PX[i], dz = z - PZ[i], d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  T.lateral = (x, z, i) => (x - PX[i]) * NX[i] + (z - PZ[i]) * NZ[i];
  T.isClear = (x, z, margin) => {
    const m2 = margin * margin;
    for (let i = 0; i < N; i += 3) { const dx = x - PX[i], dz = z - PZ[i]; if (dx * dx + dz * dz < m2) return false; }
    return true;
  };
  T.kind = 'track';
  T.collide = (c, onWall) => { collideWalls(T, c, onWall); updateProgress(T, c); };
  // projectile vs walls; o carries a nearest-sample hint in o.idx
  T.blocked = (o, y) => { o.idx = T.nearest(o.x, o.z, o.idx); return y < 1.4 && Math.abs(T.lateral(o.x, o.z, o.idx)) > C.HALF_W + 0.4; };
  T.pads = [];
  PAD_GROUPS.forEach((gi, g) => PAD_LAT.forEach((lat, k) => {
    T.pads.push({ type: PAD_ORDER[g % 3][k], gi, lat, x: PX[gi] + NX[gi] * lat, z: PZ[gi] + NZ[gi] * lat });
  }));
  return T;
}

/* ---------- Arena: a yard with a deck on ramps, a tunnel under it, jump ramps, cover and barrels ----------
   Everything solid is a box footprint with a bottom and a top; the top can slope (ramps).
   A car can drive onto any top that is at most 0.9 above it; anything higher is a wall. */
const ARENA = {
  W: 75, D: 55, WALL_H: 3, DECK: 4,
  solids: [
    // deck: two solid supports and a slab over the tunnel (tunnel runs along x, z in [-5, 5])
    { x0: -22, x1: 22, z0: -12, z1: -5, b: 0, h0: 4, h1: 4 },
    { x0: -22, x1: 22, z0: 5, z1: 12, b: 0, h0: 4, h1: 4 },
    { x0: -22, x1: 22, z0: -5, z1: 5, b: 3.4, h0: 4, h1: 4 },
    // ramps up to the deck (north and south)
    { x0: -7, x1: 7, z0: 12, z1: 28, b: 0, ax: 'z', a0: 12, a1: 28, h0: 4, h1: 0 },
    { x0: -7, x1: 7, z0: -28, z1: -12, b: 0, ax: 'z', a0: -12, a1: -28, h0: 4, h1: 0 },
    // jump ramps
    { x0: -52, x1: -44, z0: -8, z1: 4, b: 0, ax: 'z', a0: -8, a1: 4, h0: 0, h1: 1.8 },
    { x0: 44, x1: 52, z0: -4, z1: 8, b: 0, ax: 'z', a0: 8, a1: -4, h0: 0, h1: 1.8 },
    // cover blocks
    { x0: -46, x1: -30, z0: -32, z1: -28, b: 0, h0: 2.6, h1: 2.6 }, { x0: 30, x1: 46, z0: 28, z1: 32, b: 0, h0: 2.6, h1: 2.6 },
    { x0: -40, x1: -36, z0: 26, z1: 40, b: 0, h0: 2.6, h1: 2.6 }, { x0: 36, x1: 40, z0: -40, z1: -26, b: 0, h0: 2.6, h1: 2.6 },
    { x0: -65, x1: -59, z0: 14, z1: 30, b: 0, h0: 2.6, h1: 2.6 }, { x0: 59, x1: 65, z0: -30, z1: -14, b: 0, h0: 2.6, h1: 2.6 },
    { x0: -10, x1: 10, z0: -46, z1: -42, b: 0, h0: 2.6, h1: 2.6 }, { x0: -10, x1: 10, z0: 42, z1: 46, b: 0, h0: 2.6, h1: 2.6 }
  ],
  barrels: [[6, 0, 0], [-26, 16, 0], [26, -16, 0], [-44, -24, 0], [44, 24, 0], [-58, -40, 0], [58, 40, 0], [-14, -36, 0], [14, 36, 0], [12, 8, 4], [-12, -8, 4]],
  pads: [
    { type: 'repair', x: -30, z: 0, y: 0 }, { type: 'repair', x: 30, z: 0, y: 0 },
    { type: 'rocket', x: 0, z: -8.5, y: 4 }, { type: 'rocket', x: 0, z: 8.5, y: 4 }, { type: 'rocket', x: -60, z: -40, y: 0 }, { type: 'rocket', x: 60, z: 40, y: 0 },
    { type: 'rear', x: -46, z: 34, y: 0 }, { type: 'rear', x: 46, z: -34, y: 0 }, { type: 'rear', x: -10, z: 0, y: 0 }
  ],
  spawns: [[-66, -46], [66, 46], [-66, 46], [66, -46], [-24, -50], [24, 50], [24, -50], [-24, 50]]
};
function solidTop(s, x, z) {
  if (!s.ax) return s.h1;
  const t = clamp(((s.ax === 'z' ? z : x) - s.a0) / (s.a1 - s.a0), 0, 1);
  return s.h0 + (s.h1 - s.h0) * t;
}
function buildArena() {
  const A = { kind: 'arena', W: ARENA.W, D: ARENA.D, WALL_H: ARENA.WALL_H, solids: ARENA.solids, barrels: ARENA.barrels, spawns: ARENA.spawns };
  A.pads = ARENA.pads.map(p => Object.assign({ gi: 0, lat: 0 }, p));
  const RW = 1.4, GRAV = 25;
  // highest drivable top under (x, z) not above maxY
  A.surface = (x, z, maxY) => {
    let h = 0;
    for (const s of A.solids) {
      if (x < s.x0 || x > s.x1 || z < s.z0 || z > s.z1) continue;
      const t = solidTop(s, x, z);
      if (t <= maxY && t > h) h = t;
    }
    return h;
  };
  // a solid too tall to drive onto, overlapping the car's body at height y
  A.wallAt = (x, z, y) => {
    for (const s of A.solids) {
      const cx = clamp(x, s.x0, s.x1), cz = clamp(z, s.z0, s.z1);
      if ((x - cx) ** 2 + (z - cz) ** 2 >= RW * RW) continue;
      if (s.b < y + 1.8 && solidTop(s, cx, cz) > y + 0.9) return true;
    }
    return false;
  };
  A.collide = (c, onWall, dt) => {
    const y = c.y || 0;
    if (A.wallAt(c.x, c.z, y)) {
      let vn;
      if (!A.wallAt(c.x, c.pz, y)) { c.z = c.pz; vn = Math.abs(c.vz); c.vz *= -0.3; }
      else if (!A.wallAt(c.px, c.z, y)) { c.x = c.px; vn = Math.abs(c.vx); c.vx *= -0.3; }
      else { c.x = c.px; c.z = c.pz; vn = Math.hypot(c.vx, c.vz); c.vx *= -0.3; c.vz *= -0.3; }
      if (onWall && vn > 0.5) onWall(c, vn, c.x, c.z);
    }
    // still overlapping (pushed in by a crash or an explosion): move out along the shallowest side
    for (let k = 0; k < 3 && A.wallAt(c.x, c.z, y); k++) {
      for (const s of A.solids) {
        const cx = clamp(c.x, s.x0, s.x1), cz = clamp(c.z, s.z0, s.z1);
        if ((c.x - cx) ** 2 + (c.z - cz) ** 2 >= RW * RW || !(s.b < y + 1.8 && solidTop(s, cx, cz) > y + 0.9)) continue;
        const outs = [[c.x - (s.x0 - RW), -1, 0], [(s.x1 + RW) - c.x, 1, 0], [c.z - (s.z0 - RW), 0, -1], [(s.z1 + RW) - c.z, 0, 1]];
        outs.sort((a, b) => a[0] - b[0]);
        const [d, nx, nz] = outs[0];
        c.x += nx * (d + 0.01); c.z += nz * (d + 0.01);
        const vn = -(c.vx * nx + c.vz * nz); if (vn > 0) { c.vx += nx * vn; c.vz += nz * vn; }
      }
    }
    const lx = A.W - 1.6, lz = A.D - 1.6;
    const bounce = (axis, lim, sign) => {
      c[axis] = lim * sign; const v = axis === 'x' ? 'vx' : 'vz';
      const vn = Math.abs(c[v]); if (c[v] * sign > 0) c[v] *= -0.4;
      if (onWall && vn > 0.5) onWall(c, vn, axis === 'x' ? A.W * sign : c.x, axis === 'z' ? A.D * sign : c.z);
    };
    if (c.x > lx) bounce('x', lx, 1); else if (c.x < -lx) bounce('x', lx, -1);
    if (c.z > lz) bounce('z', lz, 1); else if (c.z < -lz) bounce('z', lz, -1);
    // vertical: follow the ground, or fly and fall when it drops away
    if (!c.air) {
      const sh = A.surface(c.x, c.z, y + 0.9);
      if (sh >= y - 0.25) { c.vy = dt > 0 ? clamp((sh - y) / dt, -20, 20) : 0; c.y = sh; }
      else c.air = true;
    }
    if (c.air && dt > 0) {
      const prev = c.y;
      c.vy -= GRAV * dt; c.y += c.vy * dt;
      const ground = A.surface(c.x, c.z, prev + 0.3);
      if (c.y <= ground) {
        const impact = -c.vy;
        c.y = ground; c.vy = 0; c.air = false;
        if (onWall && impact > 12) onWall(c, impact - 5, c.x, c.z);
      }
    }
  };
  A.blocked = (o, y) => {
    if (y < A.WALL_H && (Math.abs(o.x) > A.W - 0.2 || Math.abs(o.z) > A.D - 0.2)) return true;
    for (const s of A.solids) {
      if (o.x < s.x0 || o.x > s.x1 || o.z < s.z0 || o.z > s.z1) continue;
      if (y > s.b && y < solidTop(s, o.x, o.z)) return true;
    }
    return false;
  };
  // can a car at height y drive in a straight line between two points? (AI)
  A.clearLine = (x0, z0, x1, z1, y) => {
    const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 1.5);
    for (let k = 1; k <= n; k++) {
      const t = k / n, x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
      if (Math.abs(x) > A.W - 3 || Math.abs(z) > A.D - 3 || A.wallAt(x, z, y)) return false;
      y = A.surface(x, z, y + 0.9);
    }
    return true;
  };
  // set routes the AI can follow: over the deck (both ways) and through the tunnel (both ways)
  A.routes = [
    [[0, 40], [0, 20], [0, 8], [0, -8], [0, -20], [0, -40]],
    [[0, -40], [0, -20], [0, -8], [0, 8], [0, 20], [0, 40]],
    [[-40, 0], [-24, 0], [0, 0], [24, 0], [40, 0]],
    [[40, 0], [24, 0], [0, 0], [-24, 0], [-40, 0]],
    [[-48, -20], [-48, -6], [-48, 8], [-48, 20]],
    [[48, 20], [48, 6], [48, -8], [48, -20]]
  ];
  return A;
}

const NOCTL = { throttle: false, brake: false, steer: 0, drift: false, turbo: false };

/* ---------- car physics: identical on the server and in the browser ---------- */
function carPhysics(T, c, ctl, dt, onWall) {
  if (!c.alive) {
    const f = Math.exp(-1.6 * dt); c.vx *= f; c.vz *= f; c.vF *= f; c.vL *= f;
    c.px = c.x; c.pz = c.z; c.x += c.vx * dt; c.z += c.vz * dt; T.collide(c, onWall, dt); return;
  }
  c.steerSm += (ctl.steer - c.steerSm) * Math.min(1, dt * 10);
  const air = !!c.air;
  let vF = c.vx * Math.sin(c.h) + c.vz * Math.cos(c.h);
  const auth = Math.min(1, Math.abs(vF) / 6) * (vF < -0.5 ? -1 : 1);
  const hi = 1 - 0.2 * Math.min(1, Math.abs(vF) / 50);
  c.h += c.steerSm * 2.3 * auth * hi * (ctl.drift ? 1.45 : 1) * (air ? 0.3 : 1) * dt;
  if (c.oil > 0) { c.oil -= dt; c.h += c.oilSpin * dt; }
  c.h = wrapA(c.h);
  const fx = Math.sin(c.h), fz = Math.cos(c.h), sx = Math.cos(c.h), sz = -Math.sin(c.h);
  vF = c.vx * fx + c.vz * fz;
  let vL = c.vx * sx + c.vz * sz;
  const turbo = !air && ctl.turbo && c.nitro > 0.02 && vF > 2 && ctl.throttle;
  if (turbo) c.nitro = Math.max(0, c.nitro - dt * 0.34);
  else c.nitro = Math.min(1, c.nitro + dt * (c.drifting ? 0.06 : 0.022));
  const maxF = (C.BASE_MAX + (turbo ? 14 : 0)) * c.speedMul;
  if (!air && ctl.throttle && vF < maxF) vF += (turbo ? 40 : 26) * dt;
  if (!air && ctl.brake) { if (vF > 0.5) vF -= 45 * dt; else vF = Math.max(-10, vF - 16 * dt); }
  if (!air && !ctl.throttle && !ctl.brake) vF -= vF * 0.55 * dt;
  vF -= vF * 0.06 * dt;
  if (vF > maxF) vF -= (vF - maxF) * 2.2 * dt;
  let grip = ctl.drift ? 2.2 : 9;
  if (ctl.drift) vF -= vF * 0.2 * dt;
  if (c.oil > 0) grip = 0.45;
  if (air) grip = 0.3;
  vL *= Math.exp(-grip * dt);
  c.vx = fx * vF + sx * vL; c.vz = fz * vF + sz * vL;
  c.px = c.x; c.pz = c.z;
  c.x += c.vx * dt; c.z += c.vz * dt;
  c.vF = vF; c.vL = vL; c.turboOn = turbo;
  c.drifting = Math.abs(vL) > 3.5 && Math.abs(vF) > 9;
  T.collide(c, onWall, dt);
}
function collideWalls(T, c, onWall) {
  const i = T.nearest(c.x, c.z, c.idx); c.idx = i;
  const d = T.lateral(c.x, c.z, i), lim = C.HALF_W - C.CAR_R;
  if (Math.abs(d) <= lim) return;
  const s = Math.sign(d), pen = Math.abs(d) - lim, NX = T.NX[i], NZ = T.NZ[i];
  c.x -= NX * s * pen; c.z -= NZ * s * pen;
  const vn = (c.vx * NX + c.vz * NZ) * s;
  if (vn > 0) {
    c.vx -= NX * s * vn * 1.4; c.vz -= NZ * s * vn * 1.4;
    c.vx *= 0.985; c.vz *= 0.985;
    if (onWall) onWall(c, vn, c.x + NX * s * C.CAR_R, c.z + NZ * s * C.CAR_R);
  }
}
// Cars collide as capsules: a segment along the car's length with a rounded edge,
// close to the real 2.3 × 4.3 body (a single circle let cars overlap nose to tail).
const CAP_HALF = 1.05, CAP_R = 1.2;
function carContact(a, b) {
  const rx = a.x - b.x, rz = a.z - b.z;
  if (rx * rx + rz * rz > 26) return null;
  const d1x = Math.sin(a.h), d1z = Math.cos(a.h), d2x = Math.sin(b.h), d2z = Math.cos(b.h);
  const bd = d1x * d2x + d1z * d2z, c = d1x * rx + d1z * rz, f = d2x * rx + d2z * rz;
  const den = 1 - bd * bd;
  let s = den > 1e-6 ? clamp((bd * f - c) / den, -CAP_HALF, CAP_HALF) : 0;
  const t = clamp(f + bd * s, -CAP_HALF, CAP_HALF);
  s = clamp(bd * t - c, -CAP_HALF, CAP_HALF);
  let qx = rx + s * d1x - t * d2x, qz = rz + s * d1z - t * d2z;
  let d = Math.hypot(qx, qz);
  if (d >= CAP_R * 2) return null;
  if (d < 1e-4) { qx = rx || 1e-3; qz = rz; d = Math.hypot(qx, qz); }
  // normal points from a towards b
  return { nx: -qx / d, nz: -qz / d, pen: CAP_R * 2 - d, x: b.x + t * d2x + qx / 2, z: b.z + t * d2z + qz / 2 };
}
function updateProgress(T, c) {
  const N = T.N;
  let d = c.idx - c.prevIdx;
  if (d < -N / 2) d += N; else if (d > N / 2) d -= N;
  c.progress += d; c.prevIdx = c.idx;
}


function createRace(T, opts) {
  const N = T.N, HALF_W = C.HALF_W, CAR_R = C.CAR_R;
  const D = DIFFS[opts.diff] || DIFFS.detenu;
  const ARENA_MODE = T.kind === 'arena', ARM = ARENA_MODE ? C.ARENA_ARM : C.ARM_DELAY;
  const R = {
    mode: ARENA_MODE ? 'arena' : 'race', over: false, warned: 0,
    barrels: ARENA_MODE ? T.barrels.map(b => ({ x: b[0], z: b[1], y: b[2] || 0, hp: 20, alive: true, t: 0, by: null })) : [],
    cars: [], bullets: [], rockets: [], mines: [], slicks: [], puffs: [], events: [],
    tick: 0, time: 0, raceTime: 0, phase: 'countdown', cdT: 3.6, cdShown: 0, nextId: 1,
    pads: T.pads.map(p => Object.assign({}, p, { active: true, t: 0 }))
  };
  const ev = e => R.events.push(e);
  const humanCars = () => R.cars.filter(c => c.human);

  // ---------- grid ----------
  const humans = (opts.humans || []).slice(0, C.MAX_CARS);
  const slots = [0, 1, 2, 3, 4, 5];
  for (let i = slots.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [slots[i], slots[j]] = [slots[j], slots[i]]; }
  const usedColors = new Set(humans.map(h => h.color));
  const freeColors = COLORS.map((c, i) => i).filter(i => !usedColors.has(i));
  let aiN = 0;
  // opts.ai: how many AI cars may fill the grid (0 = humans only)
  const total = Math.max(1, Math.min(C.MAX_CARS, humans.length + (opts.ai === undefined ? C.MAX_CARS : opts.ai)));
  for (let k = 0; k < total; k++) {
    const h = humans[k];
    const car = {
      id: k, slot: slots[k], human: !!h, pid: h ? h.id : null,
      name: h ? h.name : AI_NAMES[aiN], color: COLORS[h ? h.color : freeColors[aiN]],
      ai: { lane: 0, laneTarget: 0, laneT: 0, seed: Math.random() * 100, blind: 0, target: null, retarget: 0, stuck: 0, reverse: 0, padLock: 0, trigger: 0 }
    };
    if (!h) aiN++;
    placeCar(car);
    R.cars.push(car);
  }

  function placeCar(c) {
    if (ARENA_MODE) {
      const sp = T.spawns[c.slot], h = Math.atan2(-sp[0], -sp[1]);
      Object.assign(c, {
        idx: 0, prevIdx: 0, x: sp[0], z: sp[1], h, vx: 0, vz: 0, vF: 0, vL: 0, steerSm: 0, armor: 100, alive: true, y: 0, vy: 0, air: false, finished: false, finishTime: 0,
        progress: 0, nitro: 1, turboOn: false, rockets: 3, rear: null, rearN: 0, heat: 0, overheat: 0, lastShot: 9,
        fireCd: 0, rocketCd: 0, kills: 0, lastHitBy: null, turretYaw: h, aimYaw: h, turretPitch: 0, aimPitch: 0, oil: 0, oilSpin: 0,
        smokeT: 0, smokeEmit: 0, wreckT: 0, drifting: false, speedMul: 1, respawnT: 0, invuln: 0, deaths: 0, lap: 0
      });
      c.ai.wx = 0; c.ai.wz = 0; c.ai.wt = 0;
      return;
    }
    const slot = c.slot, row = Math.floor(slot / 2), lane = slot % 2 ? -4.5 : 4.5;
    const i = (N - 12 - row * 9 - (slot % 2) * 3 + N) % N;
    Object.assign(c, {
      idx: i, prevIdx: i, x: T.PX[i] + T.NX[i] * lane, z: T.PZ[i] + T.NZ[i] * lane, h: T.tangAng(i),
      vx: 0, vz: 0, vF: 0, vL: 0, steerSm: 0, armor: 100, alive: true, y: 0, vy: 0, air: false, finished: false, finishTime: 0,
      progress: i - N, nitro: 1, turboOn: false, rockets: 3, rear: null, rearN: 0, heat: 0, overheat: 0, lastShot: 9,
      fireCd: 0, rocketCd: 0, kills: 0, lastHitBy: null, turretYaw: T.tangAng(i), aimYaw: T.tangAng(i), turretPitch: 0, aimPitch: 0, oil: 0, oilSpin: 0,
      smokeT: 0, smokeEmit: 0, wreckT: 0, drifting: false, speedMul: 1, respawnT: 0, invuln: 0, deaths: 0, lap: 0
    });
    c.ai.lane = lane; c.ai.laneTarget = lane; c.ai.laneT = rnd(1, 3);
  }

  // ---------- weapons ----------
  function muzzle(c) {
    const fx = Math.sin(c.h), fz = Math.cos(c.h), cp = Math.cos(c.turretPitch);
    const dx = Math.sin(c.turretYaw) * cp, dy = Math.sin(c.turretPitch), dz = Math.cos(c.turretYaw) * cp;
    return { x: c.x - fx * 0.45 + dx * 1.7, y: (c.y || 0) + C.GUN_Y + dy * 1.7, z: c.z - fz * 0.45 + dz * 1.7 };
  }
  function fireMG(c, dmgMul) {
    if (c.overheat > 0 || c.fireCd > 0) return;
    c.fireCd = 1 / 13; c.lastShot = 0;
    c.heat += 0.034;
    if (c.heat >= 1) { c.heat = 1; c.overheat = 2; ev({ e: 'heat', c: c.id }); }
    const mz = muzzle(c), sp = c.human ? 0.025 : 0.05, yaw = c.turretYaw + rnd(-sp, sp), pitch = c.turretPitch + rnd(-sp, sp) * 0.5;
    const cp = Math.cos(pitch);
    const vx = Math.sin(yaw) * cp * 165 + c.vx, vy = Math.sin(pitch) * 165, vz = Math.cos(yaw) * cp * 165 + c.vz;
    const id = R.nextId++;
    R.bullets.push({ id, x: mz.x, y: mz.y, z: mz.z, vx, vy, vz, life: 0.45, owner: c, dmg: 2.0 * dmgMul, idx: c.idx });
    ev({ e: 'mg', id, c: c.id, x: r2(mz.x), y: r2(mz.y), z: r2(mz.z), vx: r2(vx), vy: r2(vy), vz: r2(vz) });
  }
  function fireRocket(c) {
    if (c.rockets <= 0 || c.rocketCd > 0) { if (c.rockets <= 0) ev({ e: 'empty', c: c.id, w: 'rocket' }); return; }
    c.rockets--; c.rocketCd = 0.6;
    const fx = Math.sin(c.h), fz = Math.cos(c.h), sp = 92 + Math.max(0, c.vF);
    const side = (c.rockets % 2 ? 1 : -1) * 0.82, sx = Math.cos(c.h), sz = -Math.sin(c.h);
    R.rockets.push({ id: R.nextId++, x: c.x + fx * 2.4 + sx * side, y: (c.y || 0) + 1.5, z: c.z + fz * 2.4 + sz * side, h: c.h, vx: fx * sp, vz: fz * sp, life: 2.2, owner: c, idx: c.idx });
    ev({ e: 'rocket', c: c.id, x: r2(c.x), y: r2(c.y || 0), z: r2(c.z) });
  }
  function useRear(c) {
    if (!c.rear || c.rearN <= 0) { ev({ e: 'empty', c: c.id, w: 'rear' }); return; }
    const fx = Math.sin(c.h), fz = Math.cos(c.h), bx = c.x - fx * 3.8, bz = c.z - fz * 3.8;
    const by = c.y || 0;
    if (c.rear === 'oil') R.slicks.push({ id: R.nextId++, x: bx, y: by, z: bz, life: 20, owner: c, safe: 1 });
    else if (c.rear === 'mines') R.mines.push({ id: R.nextId++, x: bx, y: by, z: bz, arm: 0.7, life: 45, owner: c });
    else c.smokeT = 5;
    c.rearN--;
    if (c.rearN <= 0) c.rear = null;
    ev({ e: 'drop', c: c.id });
  }
  function pickup(c, p) {
    if (p.type === 'rocket') { if (c.rockets >= 6) return false; c.rockets = Math.min(6, c.rockets + 2); }
    else if (p.type === 'repair') { if (c.armor >= 100) return false; c.armor = Math.min(100, c.armor + 35); }
    else { c.rear = REAR_KEYS[Math.floor(Math.random() * 3)]; c.rearN = REAR_N[c.rear]; }
    ev({ e: 'pick', c: c.id, type: p.type, rear: c.rear, n: c.rearN });
    return true;
  }
  function damage(c, amt, src) {
    if (!c.alive || c.finished || R.phase !== 'race' || c.invuln > 0) return;
    if (src && src !== c && !src.human && c.human) amt *= D.dmg;
    c.armor -= amt;
    if (src && src !== c) c.lastHitBy = src;
    if (c.human || (src && src.human)) ev({ e: 'hit', v: c.id, s: src && src !== c ? src.id : -1, a: r2(amt) });
    if (c.armor <= 0) kill(c);
  }
  function kill(c) {
    c.armor = 0; c.alive = false; c.wreckT = C.RESPAWN_DELAY; c.turboOn = false; c.respawnT = C.RESPAWN_DELAY; c.deaths++;
    c.vx += rnd(-4, 4); c.vz += rnd(-4, 4);
    const k = c.lastHitBy && c.lastHitBy !== c ? c.lastHitBy : null;
    if (k) k.kills++;
    c.lastHitBy = null;
    ev({ e: 'boom', x: r2(c.x), y: r2(c.y || 0), z: r2(c.z), b: 1.25 });
    ev({ e: 'kill', v: c.id, k: k ? k.id : -1 });
  }
  function respawn(c) {
    if (ARENA_MODE) {
      // reappear at the spawn point farthest from any living opponent
      let best = T.spawns[0], bd = -1;
      for (const sp of T.spawns) {
        let near = Infinity;
        for (const o of R.cars) if (o !== c && o.alive) near = Math.min(near, Math.hypot(o.x - sp[0], o.z - sp[1]));
        if (near > bd) { bd = near; best = sp; }
      }
      const h = Math.atan2(-best[0], -best[1]);
      Object.assign(c, { x: best[0], z: best[1], h, vx: 0, vz: 0, vF: 0, vL: 0, steerSm: 0, armor: 100, alive: true, y: 0, vy: 0, air: false, invuln: 2, wreckT: 0, oil: 0, smokeT: 0, heat: 0, overheat: 0, rockets: Math.max(c.rockets, 1) });
      c.turretYaw = c.aimYaw = c.h; c.turretPitch = c.aimPitch = 0;
      ev({ e: 'respawn', c: c.id });
      return;
    }
    const i = (c.idx - 6 + N) % N;
    let lane = 0;
    for (const l of [0, -5, 5, -8, 8]) {
      const x = T.PX[i] + T.NX[i] * l, z = T.PZ[i] + T.NZ[i] * l;
      if (R.cars.every(o => o === c || (o.x - x) ** 2 + (o.z - z) ** 2 > 20)) { lane = l; break; }
    }
    Object.assign(c, {
      x: T.PX[i] + T.NX[i] * lane, z: T.PZ[i] + T.NZ[i] * lane, h: T.tangAng(i), idx: i, vx: 0, vz: 0, vF: 0, vL: 0, steerSm: 0,
      armor: 100, alive: true, y: 0, vy: 0, air: false, invuln: 2, wreckT: 0, oil: 0, smokeT: 0, heat: 0, overheat: 0, rockets: Math.max(c.rockets, 1)
    });
    c.turretYaw = c.aimYaw = c.h; c.turretPitch = c.aimPitch = 0;
    ev({ e: 'respawn', c: c.id });
  }
  function hitBarrel(b, amt, by) {
    if (!b.alive) return;
    b.hp -= amt; if (by) b.by = by;
    if (b.hp <= 0) { b.alive = false; b.t = 20; explode(b.x, b.z, b.by, 32, 6.5, null, b.y); }
  }
  function explode(x, z, owner, dmg, radius, direct, y = 0) {
    ev({ e: 'boom', x: r2(x), y: r2(y), z: r2(z), b: 1 });
    for (const b of R.barrels) if (b.alive && Math.hypot(b.x - x, b.z - z, b.y - y) < radius) hitBarrel(b, 25, owner);
    for (const c of R.cars) {
      const d = Math.hypot(c.x - x, c.z - z, (c.y || 0) - y);
      if (d > radius && c !== direct) continue;
      const k = c === direct ? 1 : 1 - d / radius * 0.7;
      const nx = (c.x - x) / (d || 1), nz = (c.z - z) / (d || 1), push = 16 * k;
      c.vx += nx * push; c.vz += nz * push;
      if (c.alive) c.h += rnd(-0.5, 0.5) * k;
      damage(c, dmg * k * (c === owner ? 0.5 : 1), owner);
    }
  }

  // ---------- physics (shared with client-side prediction) ----------
  function onWall(c, vn, wx, wz) {
    if (vn > 9) {
      damage(c, (vn - 9) * 0.6, null);
      ev({ e: 'sp', x: r2(wx), y: r2((c.y || 0) + 1), z: r2(wz), n: 10, s: 9 });
      ev({ e: 'thud', x: r2(wx), z: r2(wz), k: r2(vn / 40), c: c.id });
    } else if (vn > 2 && Math.random() < 0.3) ev({ e: 'sp', x: r2(wx), y: r2((c.y || 0) + 0.8), z: r2(wz), n: 2, s: 5 });
  }
  const stepCar = (c, ctl, dt) => carPhysics(T, c, ctl, dt, onWall);
  function carCollisions() {
    const cars = R.cars;
    for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i], b = cars[j];
      if (Math.abs((a.y || 0) - (b.y || 0)) > 2) continue;
      const hit = carContact(a, b);
      if (!hit) continue;
      const { nx, nz, pen } = hit;
      const ma = a.alive ? 1 : 4, mb = b.alive ? 1 : 4, wa = mb / (ma + mb), wb = ma / (ma + mb);
      a.x -= nx * pen * wa; a.z -= nz * pen * wa; b.x += nx * pen * wb; b.z += nz * pen * wb;
      const rv = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
      if (rv >= 0) continue;
      const jj = -1.3 * rv;
      a.vx -= nx * jj * wa; a.vz -= nz * jj * wa; b.vx += nx * jj * wb; b.vz += nz * jj * wb;
      const imp = -rv;
      if (imp > 3) {
        const mx = hit.x, mz = hit.z;
        ev({ e: 'sp', x: r2(mx), y: r2((a.y || 0) + 1), z: r2(mz), n: Math.min(14, imp | 0), s: 7 });
        ev({ e: 'thud', x: r2(mx), z: r2(mz), k: r2(imp / 35), c: a.id, c2: b.id });
      }
      if (imp > 7) {
        const dmg = (imp - 7) * 0.5;
        const aRam = Math.sin(a.h) * nx + Math.cos(a.h) * nz > 0.6;
        const bRam = -(Math.sin(b.h) * nx + Math.cos(b.h) * nz) > 0.6;
        damage(a, dmg * (aRam ? 0.4 : 1), b);
        damage(b, dmg * (bRam ? 0.4 : 1), a);
      }
    }
  }

  // ---------- AI ----------
  function aiControl(c, dt, armed) {
    const a = c.ai, spd = c.vF;
    const ctl = { throttle: true, brake: false, steer: 0, drift: false, turbo: false };
    if (a.blind > 0) a.blind -= dt;
    a.laneT -= dt; a.padLock -= dt;
    if (a.padLock <= 0) {
      let want = null;
      if (c.armor < 60) want = 'repair'; else if (c.rockets < 3) want = 'rocket'; else if (!c.rear) want = 'rear';
      if (want) for (const p of R.pads) {
        if (!p.active || p.type !== want) continue;
        let ahead = p.gi - c.idx; if (ahead < 0) ahead += N;
        if (ahead > 15 && ahead < 110) { a.laneTarget = p.lat; a.laneT = 2; a.padLock = 1.5; break; }
      }
    }
    if (a.laneT <= 0) { a.laneT = rnd(2, 5); a.laneTarget = rnd(-6.5, 6.5); }
    a.lane += (a.laneTarget - a.lane) * Math.min(1, dt * 1.1);
    for (const s of R.slicks) {
      const dx = s.x - c.x, dz = s.z - c.z;
      if (dx * dx + dz * dz < 900 && s.owner !== c && dx * Math.sin(c.h) + dz * Math.cos(c.h) > 0) a.laneTarget = clamp(a.lane + (T.lateral(s.x, s.z, c.idx) > a.lane ? -5 : 5), -7, 7);
    }
    const look = Math.floor(12 + Math.abs(spd) * 0.55);
    const ti = (c.idx + look) % N;
    const tx = T.PX[ti] + T.NX[ti] * a.lane, tz = T.PZ[ti] + T.NZ[ti] * a.lane;
    let diff = wrapA(Math.atan2(tx - c.x, tz - c.z) - c.h);
    if (a.blind > 0) diff += Math.sin(R.time * 3.3 + a.seed) * 0.5;
    const far = (c.idx + look * 2 + 20) % N;
    const bend = Math.abs(wrapA(T.tangAng(far) - T.tangAng(c.idx)));
    // rubber band against the leading human
    let mul = D.speed;
    const hs = humanCars().filter(h => !h.finished);
    if (R.phase === 'race' && hs.length) {
      const ref = Math.max.apply(null, hs.map(h => h.progress));
      const lead = c.progress - ref;
      mul *= lead > 240 ? 0.9 : lead < -240 ? 1.07 : 1;
    }
    if (c.finished) mul *= 0.65;
    c.speedMul += (mul - c.speedMul) * Math.min(1, dt);
    const targetSpd = C.BASE_MAX * c.speedMul * (1 - Math.min(0.4, bend * 0.35));
    ctl.steer = clamp(diff * 3, -1, 1);
    ctl.throttle = spd < targetSpd;
    ctl.brake = spd > targetSpd + 7;
    ctl.drift = bend > 0.85 && spd > 22 && Math.abs(diff) > 0.25;
    ctl.turbo = bend < 0.15 && c.nitro > 0.45 && Math.sin(R.time * 0.7 + a.seed) > 0.2;
    if (a.reverse > 0) {
      a.reverse -= dt; ctl.throttle = false; ctl.brake = true; ctl.turbo = false; ctl.drift = false; ctl.steer = -Math.sign(diff || 1);
    } else if (Math.abs(spd) < 3 && R.phase === 'race') {
      a.stuck += dt; if (a.stuck > 1.3) { a.reverse = 1.1; a.stuck = 0; }
    } else a.stuck = 0;
    if (!armed || c.finished || R.raceTime < ARM) { c.aimYaw = c.h; c.aimPitch = 0; return ctl; }
    aiCombat(c, dt);
    return ctl;
  }
  function aiPickTarget(c, dt) {
    const a = c.ai;
    a.retarget -= dt;
    if (a.retarget <= 0) {
      a.retarget = 0.3; a.target = null;
      if (a.blind <= 0) {
        let best = Infinity;
        for (const o of R.cars) {
          if (o === c || !o.alive || o.finished || o.invuln > 0) continue;
          const d = Math.hypot(o.x - c.x, o.z - c.z);
          if (d > 58) continue;
          const score = d - (o.human ? 18 * D.aggr : 0);
          if (score < best) { best = score; a.target = o; }
        }
      }
    }
  }
  function aiCombat(c, dt) {
    const a = c.ai;
    aiPickTarget(c, dt);
    const t = a.target;
    if (t && t.alive) {
      const d = Math.hypot(t.x - c.x, t.z - c.z), lead = d / 165;
      const px = t.x + (t.vx - c.vx) * lead, pz = t.z + (t.vz - c.vz) * lead;
      const err = (1 - D.acc) * 0.35 * Math.sin(R.time * 2.1 + a.seed);
      c.aimYaw = Math.atan2(px - c.x, pz - c.z) + err;
      c.aimPitch = Math.atan2((t.y || 0) + 1.1 - ((c.y || 0) + C.GUN_Y), Math.max(d, 1));
      const onTarget = Math.abs(wrapA(c.turretYaw - c.aimYaw)) < 0.18;
      a.trigger -= dt;
      if (a.trigger <= 0) a.trigger = c.heat > 0.7 ? rnd(0.8, 1.6) : rnd(-1.2, -0.4);
      if (onTarget && a.trigger < 0 && c.heat < 0.82) fireMG(c, 0.6);
      if (c.rockets > 0 && c.rocketCd <= 0 && d < 65) {
        const ang = Math.abs(wrapA(Math.atan2(t.x - c.x, t.z - c.z) - c.h));
        if (ang < 0.05 + D.acc * 0.04 && Math.random() < dt * 2.2 * D.aggr) fireRocket(c);
      }
    } else { c.aimYaw = c.h; c.aimPitch = 0; }
    if (c.rear) {
      for (const o of R.cars) {
        if (o === c || !o.alive) continue;
        const dx = o.x - c.x, dz = o.z - c.z, d = Math.hypot(dx, dz);
        if (d < 4 || d > 24) continue;
        const behind = -(dx * Math.sin(c.h) + dz * Math.cos(c.h)) / d;
        if (behind > 0.85 && Math.random() < dt * 1.5 * D.aggr) { useRear(c); break; }
      }
    }
  }
  // Arena AI: hunt a target (circling it), grab pads when hurt, wander otherwise; steer around cover.
  function aiArena(c, dt, armed) {
    const a = c.ai, spd = c.vF;
    const ctl = { throttle: true, brake: false, steer: 0, drift: false, turbo: false };
    if (a.blind > 0) a.blind -= dt;
    a.wt -= dt;
    aiPickTarget(c, dt);
    let dx, dz;
    const t = a.target && a.target.alive ? a.target : null;
    let pad = null;
    if (c.armor < 50 || c.rockets === 0) {
      let bd = 70;
      for (const p of R.pads) {
        if (!p.active || (p.type !== (c.armor < 50 ? 'repair' : 'rocket')) || Math.abs((p.y || 0) - (c.y || 0)) > 1) continue;
        const d = Math.hypot(p.x - c.x, p.z - c.z); if (d < bd) { bd = d; pad = p; }
      }
    }
    if (a.route && (pad || (t && Math.hypot(t.x - c.x, t.z - c.z) < 25))) a.route = null;
    if (a.route) {
      const wp = a.route[a.ri];
      if (Math.hypot(wp[0] - c.x, wp[1] - c.z) < 5) { a.ri++; if (a.ri >= a.route.length) a.route = null; }
    }
    if (!a.route && !pad && a.wt <= 0 && Math.random() < 0.5) {
      // start a run over the deck, through the tunnel or over a jump, from the nearest end
      let best = null, bd = Infinity;
      for (const rt of T.routes) { const d = Math.hypot(rt[0][0] - c.x, rt[0][1] - c.z); if (d < bd) { bd = d; best = rt; } }
      if (best && bd < 60) { a.route = best; a.ri = 0; a.wt = 12; }
    }
    if (a.route) { dx = a.route[a.ri][0]; dz = a.route[a.ri][1]; }
    else if (pad) { dx = pad.x; dz = pad.z; }
    else if (t) {
      const ang = Math.atan2(c.x - t.x, c.z - t.z) + (Math.sin(R.time * 0.4 + a.seed) > 0 ? 0.9 : -0.9);
      const r = 13 + 5 * Math.sin(R.time * 0.3 + a.seed);
      dx = clamp(t.x + Math.sin(ang) * r, -T.W + 6, T.W - 6); dz = clamp(t.z + Math.cos(ang) * r, -T.D + 6, T.D - 6);
    } else {
      if (a.wt <= 0 || Math.hypot(a.wx - c.x, a.wz - c.z) < 8) { a.wt = rnd(3, 6); a.wx = rnd(-T.W + 10, T.W - 10); a.wz = rnd(-T.D + 10, T.D - 10); }
      dx = a.wx; dz = a.wz;
    }
    let desired = Math.atan2(dx - c.x, dz - c.z);
    // obstacle avoidance: probe ahead, turn towards the clearer side
    const look = 7 + Math.max(0, spd) * 0.35;
    if (!a.route && !T.clearLine(c.x, c.z, c.x + Math.sin(c.h) * look, c.z + Math.cos(c.h) * look, c.y || 0)) {
      const l = T.clearLine(c.x, c.z, c.x + Math.sin(c.h + 0.8) * look, c.z + Math.cos(c.h + 0.8) * look, c.y || 0);
      const rr = T.clearLine(c.x, c.z, c.x + Math.sin(c.h - 0.8) * look, c.z + Math.cos(c.h - 0.8) * look, c.y || 0);
      desired = c.h + (l && !rr ? 1.2 : !l && rr ? -1.2 : (Math.sin(a.seed) > 0 ? 1.2 : -1.2));
    }
    let diff = wrapA(desired - c.h);
    if (a.blind > 0) diff += Math.sin(R.time * 3.3 + a.seed) * 0.5;
    const dist = Math.hypot(dx - c.x, dz - c.z);
    c.speedMul = D.speed;
    const targetSpd = C.BASE_MAX * D.speed * (a.route ? 0.85 : clamp(dist / 30, 0.35, 1)) * (Math.abs(diff) > 1.2 ? 0.5 : 1);
    ctl.steer = clamp(diff * 3, -1, 1);
    ctl.throttle = spd < targetSpd;
    ctl.brake = spd > targetSpd + 6;
    ctl.drift = !a.route && Math.abs(diff) > 1 && spd > 18;
    ctl.turbo = Math.abs(diff) < 0.15 && dist > 40 && c.nitro > 0.5;
    if (a.reverse > 0) {
      a.reverse -= dt; ctl.throttle = false; ctl.brake = true; ctl.turbo = false; ctl.drift = false; ctl.steer = -Math.sign(diff || 1);
    } else if (Math.abs(spd) < 3 && R.phase === 'race') {
      a.stuck += dt; if (a.stuck > 1.1) { a.reverse = 1.0; a.stuck = 0; }
    } else a.stuck = 0;
    if (!armed || R.raceTime < ARM) { c.aimYaw = c.h; c.aimPitch = 0; return ctl; }
    aiCombat(c, dt);
    return ctl;
  }

  // ---------- main step ----------
  function step(dt, inputs) {
    R.tick++;
    R.time += dt;
    if (R.phase === 'countdown') {
      R.cdT -= dt;
      const n = Math.ceil(R.cdT - 0.6);
      if (n !== R.cdShown && n >= 1 && n <= 3) { R.cdShown = n; ev({ e: 'cd', n }); }
      if (R.cdT <= 0.6) { R.phase = 'race'; ev({ e: 'cd', n: 0 }); }
    } else if (R.phase === 'race') {
      const was = R.raceTime < ARM;
      R.raceTime += dt;
      if (was && R.raceTime >= ARM) ev({ e: 'armed' });
    }
    const armed = R.phase === 'race';
    for (const c of R.cars) {
      c.fireCd -= dt; c.rocketCd -= dt; c.lastShot += dt;
      if (c.overheat > 0) { c.overheat -= dt; c.heat = Math.max(0, c.overheat / 2); if (c.overheat <= 0) c.heat = 0.2; }
      else if (c.lastShot > 0.14) c.heat = Math.max(0, c.heat - dt * 0.6);
      let ctl;
      if (R.phase === 'countdown') ctl = NOCTL;
      else if (c.human && !c.finished) {
        const inp = (inputs && inputs[c.id]) || {};
        ctl = { throttle: !!inp.th, brake: !!inp.br, steer: clamp(+inp.st || 0, -1, 1), drift: !!inp.dr, turbo: !!inp.tu };
        if (typeof inp.ay === 'number' && isFinite(inp.ay)) c.aimYaw = inp.ay;
        if (typeof inp.ap === 'number' && isFinite(inp.ap)) c.aimPitch = inp.ap;
        if (c.alive && R.raceTime >= ARM) {
          if (inp.fi) fireMG(c, 1);
          if (inp.rk) fireRocket(c);
          if (inp.re) useRear(c);
        }
      } else ctl = (ARENA_MODE ? aiArena : aiControl)(c, dt, armed && c.alive);
      const rate = c.human ? 3.2 : 4;
      const relT = clamp(wrapA(c.aimYaw - c.h), -C.TURRET_ARC, C.TURRET_ARC);
      const relC = clamp(wrapA(c.turretYaw - c.h), -C.TURRET_ARC, C.TURRET_ARC);
      c.turretYaw = wrapA(c.h + relC + clamp(relT - relC, -rate * dt, rate * dt));
      c.turretPitch += clamp(clamp(c.aimPitch, C.PITCH_MIN, C.PITCH_MAX) - c.turretPitch, -1.6 * dt, 1.6 * dt);
      stepCar(c, c.alive ? ctl : NOCTL, dt);
    }
    carCollisions();
    for (const b of R.barrels) {
      if (!b.alive) { if ((b.t -= dt) <= 0 && R.cars.every(c => Math.hypot(c.x - b.x, c.z - b.z) > 4)) { b.alive = true; b.hp = 20; b.by = null; } continue; }
      for (const c of R.cars) {
        const dx = c.x - b.x, dz = c.z - b.z, d = Math.hypot(dx, dz);
        if (d >= 2.4 || d < 1e-4 || Math.abs((c.y || 0) - b.y) > 1.5) continue;
        const nx = dx / d, nz = dz / d; c.x += nx * (2.4 - d); c.z += nz * (2.4 - d);
        const vn = -(c.vx * nx + c.vz * nz);
        if (vn > 0) { c.vx += nx * vn * 1.2; c.vz += nz * vn * 1.2; if (vn > 12) hitBarrel(b, 25, c); }
      }
    }

    // bullets
    for (let i = R.bullets.length - 1; i >= 0; i--) {
      const b = R.bullets[i];
      const ox = b.x, oy = b.y, oz = b.z;
      b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt; b.life -= dt;
      let hit = b.life <= 0, spark = false;
      if (!hit) {
        const sx = b.x - ox, sy = b.y - oy, sz = b.z - oz, sl = sx * sx + sz * sz;
        for (const c of R.cars) {
          if (c === b.owner) continue;
          const t = clamp(((c.x - ox) * sx + (c.z - oz) * sz) / (sl || 1), 0, 1);
          const qx = ox + sx * t - c.x, qz = oz + sz * t - c.z, qy = oy + sy * t;
          const ry = qy - (c.y || 0);
          if (qx * qx + qz * qz < 2.7 && ry > 0.1 && ry < 2.5) { damage(c, b.dmg, b.owner); hit = spark = true; b.x = c.x + qx; b.y = qy; b.z = c.z + qz; break; }
        }
      }
      if (!hit && b.y < 0.05) { hit = spark = true; b.y = 0.05; }
      if (!hit) for (const br of R.barrels) {
        if (br.alive && b.y > br.y && b.y < br.y + 1.4 && (b.x - br.x) ** 2 + (b.z - br.z) ** 2 < 0.8) { hitBarrel(br, b.dmg, b.owner); hit = spark = true; break; }
      }
      if (!hit && T.blocked(b, b.y)) hit = spark = true;
      if (hit) { R.bullets.splice(i, 1); ev({ e: 'bh', id: b.id, x: r2(b.x), y: r2(b.y), z: r2(b.z), s: spark ? 1 : 0 }); }
    }
    // rockets
    for (let i = R.rockets.length - 1; i >= 0; i--) {
      const r = R.rockets[i];
      r.x += r.vx * dt; r.z += r.vz * dt; r.life -= dt;
      let boom = r.life <= 0, direct = null;
      for (const c of R.cars) { if (c === r.owner) continue; if ((c.x - r.x) ** 2 + (c.z - r.z) ** 2 < 4.4 && Math.abs((c.y || 0) + 1 - r.y) < 1.8) { boom = true; direct = c; break; } }
      if (!boom) for (const br of R.barrels) if (br.alive && Math.abs(br.y + 0.7 - r.y) < 1.2 && (r.x - br.x) ** 2 + (r.z - br.z) ** 2 < 1.5) { boom = true; break; }
      if (!boom && T.blocked(r, r.y)) boom = true;
      if (boom) { R.rockets.splice(i, 1); explode(r.x, r.z, r.owner, 36, 7, direct, r.y - 1); }
    }
    // mines
    for (let i = R.mines.length - 1; i >= 0; i--) {
      const m = R.mines[i];
      m.arm -= dt; m.life -= dt;
      let boom = m.life <= 0;
      if (m.arm <= 0 && !boom) for (const c of R.cars) { if ((c.x - m.x) ** 2 + (c.z - m.z) ** 2 < 5.8 && Math.abs((c.y || 0) - m.y) < 1.5) { boom = true; break; } }
      if (boom) { R.mines.splice(i, 1); explode(m.x, m.z, m.owner, 30, 5.5, null, m.y); }
    }
    // oil
    for (let i = R.slicks.length - 1; i >= 0; i--) {
      const s = R.slicks[i];
      s.life -= dt; s.safe -= dt;
      if (s.life <= 0) { R.slicks.splice(i, 1); continue; }
      for (const c of R.cars) {
        if (!c.alive || (c === s.owner && s.safe > 0)) continue;
        if ((c.x - s.x) ** 2 + (c.z - s.z) ** 2 < 13 && Math.abs((c.y || 0) - s.y) < 1.5 && !c.air) {
          if (c.oil <= 0) { c.oilSpin = (Math.random() < 0.5 ? -1 : 1) * rnd(1.6, 2.6); ev({ e: 'oil', c: c.id }); }
          c.oil = 0.9;
        }
      }
    }
    // smoke screens (visuals are drawn by clients from smokeT)
    for (const c of R.cars) {
      if (c.smokeT > 0 && c.alive) {
        c.smokeT -= dt; c.smokeEmit -= dt;
        if (c.smokeEmit <= 0) { c.smokeEmit = 0.06; R.puffs.push({ x: c.x - Math.sin(c.h) * 3, z: c.z - Math.cos(c.h) * 3, life: 4.5, owner: c }); }
      } else if (c.smokeT > 0) c.smokeT = 0;
    }
    for (let i = R.puffs.length - 1; i >= 0; i--) { R.puffs[i].life -= dt; if (R.puffs[i].life <= 0) R.puffs.splice(i, 1); }
    for (const c of R.cars) {
      if (c.human || !c.alive) continue;
      for (const p of R.puffs) { if (p.owner !== c && p.life > 0.6 && (c.x - p.x) ** 2 + (c.z - p.z) ** 2 < 55) { c.ai.blind = 1.4; break; } }
    }
    // pads
    for (const p of R.pads) {
      if (!p.active) { p.t -= dt; if (p.t <= 0) p.active = true; continue; }
      for (const c of R.cars) {
        if (!c.alive || c.finished) continue;
        if ((c.x - p.x) ** 2 + (c.z - p.z) ** 2 < 7 && Math.abs((c.y || 0) - (p.y || 0)) < 1.5 && pickup(c, p)) { p.active = false; p.t = 8; break; }
      }
    }
    // respawn & invulnerability
    for (const c of R.cars) {
      if (!c.alive && c.respawnT > 0) { c.respawnT -= dt; if (c.respawnT <= 0) respawn(c); }
      if (c.invuln > 0) c.invuln -= dt;
      if (c.wreckT > 0) c.wreckT -= dt;
    }
    // arena: time limit or kill target
    if (ARENA_MODE && R.phase === 'race' && !R.over) {
      const left = C.ARENA_TIME - R.raceTime;
      if (left <= 30 && R.warned < 1) { R.warned = 1; ev({ e: 'left', s: 30 }); }
      if (left <= 10 && R.warned < 2) { R.warned = 2; ev({ e: 'left', s: 10 }); }
      const top = R.cars.reduce((m, c) => Math.max(m, c.kills), 0);
      if (left <= 0 || top >= C.ARENA_KILLS) { R.over = true; R.phase = 'done'; ev({ e: 'over' }); }
    }
    // laps & finish
    if (!ARENA_MODE && R.phase === 'race') {
      for (const c of R.cars) {
        if (c.finished) continue;
        if (c.progress >= C.LAPS * N) {
          c.finished = true; c.finishTime = R.raceTime;
          ev({ e: 'fin', c: c.id });
        } else {
          const lap = Math.floor(c.progress / N) + 1;
          if (lap > c.lap && c.lap > 0 && lap > 1) ev({ e: 'lap', c: c.id, lap });
          c.lap = Math.max(c.lap, lap);
        }
      }
    }
  }

  function ranking() {
    if (ARENA_MODE) return R.cars.slice().sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.id - b.id);
    return R.cars.slice().sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished) return a.finishTime - b.finishTime;
      return b.progress - a.progress;
    });
  }

  function snapshot() {
    const out = {
      t: 's', tk: R.tick, ph: R.phase, rt: r2(R.raceTime), md: R.mode,
      c: R.cars.map(c => [
        r2(c.x), r2(c.z), r3(c.h), r2(c.vF), r2(c.vL), r3(c.turretYaw), r2(c.armor),
        (c.alive ? FL.alive : 0) | (c.finished ? FL.finished : 0) | (c.turboOn ? FL.turbo : 0) | (c.drifting ? FL.drifting : 0) | (c.oil > 0 ? FL.oil : 0) | (c.air ? FL.air : 0),
        r2(c.steerSm), r2(c.nitro), c.rockets, c.rear ? REAR_CODE[c.rear] : 0, c.rearN, r2(c.heat), r2(c.overheat), Math.round(c.progress),
        r2(c.finishTime), c.kills, c.deaths, r2(c.respawnT), r2(c.smokeT), r2(c.invuln), r3(c.turretPitch), r2(Math.max(0, c.oil)), r2(c.oilSpin), r2(c.y || 0), r2(c.vy || 0)
      ]),
      r: R.rockets.map(r => [r.id, r2(r.x), r2(r.z), r3(r.h), r2(r.y)]),
      m: R.mines.map(m => [m.id, r2(m.x), r2(m.z), m.arm <= 0 ? 1 : 0, r2(m.y || 0)]),
      o: R.slicks.map(s => [s.id, r2(s.x), r2(s.z), r2(s.life), r2(s.y || 0)]),
      p: R.pads.map(p => p.active ? 1 : 0).join(''),
      b: R.barrels.map(b => b.alive ? 1 : 0).join(''),
      ev: R.events
    };
    R.events = [];
    return out;
  }
  function info() { return R.cars.map(c => ({ id: c.id, name: c.name, color: c.color, human: c.human, pid: c.pid })); }
  function results() {
    return ranking().map((c, i) => ({ id: c.id, name: c.name, color: c.color, human: c.human, pid: c.pid, rank: i + 1, finished: c.finished, time: r2(c.finishTime), kills: c.kills, deaths: c.deaths }));
  }
  function releaseHuman(pid) { for (const c of R.cars) if (c.pid === pid) { c.human = false; c.speedMul = D.speed; } }

  return { step, snapshot, info, results, ranking, releaseHuman, cars: R.cars, mode: R.mode, get over() { return R.over; }, get phase() { return R.phase; }, get raceTime() { return R.raceTime; } };
}

function r2(v) { return Math.round(v * 100) / 100; }
function r3(v) { return Math.round(v * 1000) / 1000; }

return { C, DIFFS, COLORS, F, FL, REAR_KEYS, NOCTL, ARENA, buildTrack, buildArena, createRace, carPhysics, carContact, mulberry, clamp, wrapA };
});
