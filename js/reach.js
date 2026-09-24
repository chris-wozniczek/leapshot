// Reachability solver: BFS over standing spots, where every edge is a real
// simulated jump/walk using the game's own physics. If the goal can't be
// reached, it carves corridors and drops "bridge" ledges until it can.
import { CELL, P, T, makeBody, step, touchesSpike, outOfWorld } from './physics.js';

const ACTIONS = [];
for (const dir of [-1, 1]) {
  ACTIONS.push({ dir, jumpF: 0, moveF: 999, delay: 0, walk: true });
  for (const jumpF of [5, 12, 40]) for (const [moveF, delay] of [[999, 0], [14, 0], [999, 12]]) ACTIONS.push({ dir, jumpF, moveF, delay });
}
ACTIONS.push({ dir: 0, jumpF: 12, moveF: 0, delay: 0 });
ACTIONS.push({ dir: 0, jumpF: 40, moveF: 0, delay: 0 });

const MAXF = 110;

export function nodeBody(cx, cy) {
  const b = makeBody(cx * CELL + (CELL - P.W) / 2, (cy + 1) * CELL - P.H);
  b.grounded = true; b.coyote = P.COYOTE;
  return b;
}
const footX = b => Math.floor((b.x + P.W / 2) / CELL);
const footY = b => Math.round((b.y + P.H) / CELL) - 1;

function inputFor(a, f) {
  const dir = (f >= a.delay && f < a.delay + a.moveF) ? a.dir : 0;
  return { dir, jump: f < a.jumpF, jumpPressed: f === 0 && a.jumpF > 0 };
}

// returns landing key or -1
export function simulate(g, cx, cy, a, rec) {
  const b = nodeBody(cx, cy);
  let air = false;
  for (let f = 0; f < MAXF; f++) {
    const ev = step(b, inputFor(a, f), g);
    if (rec) rec.push(b.x, b.y, b.facing, b.grounded ? 1 : 0, ev & 1 ? 1 : 0);
    if (touchesSpike(b, g) || outOfWorld(b, g)) return -1;
    if (!b.grounded) air = true;
    else {
      const fx = footX(b), fy = footY(b);
      if (a.walk) { if (fx !== cx || fy !== cy) return fy * g.cols + fx; }
      else if (air && f > 1) return fy * g.cols + fx;
    }
  }
  return -1;
}

function settle(g, x, y) {
  const b = nodeBody(x, y); b.grounded = false;
  for (let f = 0; f < 240; f++) { step(b, { dir: 0, jump: false, jumpPressed: false }, g); if (b.grounded) return footY(b) * g.cols + footX(b); if (outOfWorld(b, g)) break; }
  return -1;
}

class Search {
  constructor(g) {
    this.g = g; const n = g.cols * g.rows;
    this.parent = new Int32Array(n).fill(-2); this.act = new Int16Array(n); this.queue = [];
  }
  seed(k) { if (k >= 0 && this.parent[k] === -2) { this.parent[k] = -1; this.queue.push(k); } }
  run(goalTest) {
    const { g, parent, act, queue } = this; const cols = g.cols;
    let found = -1;
    for (const k of this.list()) if (goalTest(k)) found = k;
    while (queue.length) {
      const k = queue.shift();
      const cx = k % cols, cy = (k / cols) | 0;
      for (let i = 0; i < ACTIONS.length; i++) {
        const land = simulate(g, cx, cy, ACTIONS[i]);
        if (land < 0 || parent[land] !== -2) continue;
        parent[land] = k; act[land] = i; queue.push(land);
        if (found < 0 && goalTest(land)) found = land;
      }
    }
    return found;
  }
  list() { const out = []; for (let i = 0; i < this.parent.length; i++) if (this.parent[i] !== -2) out.push(i); return out; }
  requeue(mx, my, R) {
    const cols = this.g.cols;
    for (const k of this.list()) { const x = k % cols, y = (k / cols) | 0; if (Math.abs(x - mx) <= R && Math.abs(y - my) <= R) this.queue.push(k); }
  }
}

export function placeBridge(g, f, t, bridges) {
  const x0 = Math.min(f.x, t.x) - 1, x1 = Math.max(f.x, t.x) + 1;
  const y0 = Math.min(f.y, t.y) - 5, y1 = Math.max(f.y, t.y);
  for (let r = y0; r <= y1; r++) for (let c = x0; c <= x1; c++) {
    if (r === f.y + 1 && Math.abs(c - f.x) <= 1) continue;
    const v = g.get(c, r); if (v === T.SOLID || v === T.SPIKE) g.set(c, r, T.EMPTY);
  }
  for (let c = t.x - 2; c <= t.x + 2; c++) {
    if (g.get(c, t.y + 1) !== T.SOLID) g.set(c, t.y + 1, T.LEDGE);
    if (g.get(c, t.y) === T.SPIKE) g.set(c, t.y, T.EMPTY);
  }
  bridges.push({ x0: t.x - 2, x1: t.x + 2, y: t.y + 1 });
}

export function solve(g, start, goal, opts = {}) {
  const cols = g.cols, rows = g.rows;
  const bridges = opts.bridges || [];
  const goalTest = k => { const x = k % cols, y = (k / cols) | 0; return y === goal.y && Math.abs(x - goal.x) <= 3; };
  const sk = settle(g, start.x, start.y);
  let s = new Search(g); s.seed(sk);
  let found = s.run(goalTest);
  let fixes = 0;
  const tries = new Map();
  const HOPS = [[6, -3], [4, -2], [7, 0], [3, -4], [5, -1]];
  while (found < 0 && opts.fix && fixes < 60) {
    // closest reachable spot to the goal
    let best = -1, bd = 1e9;
    for (const k of s.list()) {
      const x = k % cols, y = (k / cols) | 0;
      const d = Math.hypot(goal.x - x, (goal.y - y) * 1.25) + (tries.get(k) || 0) * 4;
      if (d < bd) { bd = d; best = k; }
    }
    if (best < 0) break;
    const n = tries.get(best) || 0; tries.set(best, n + 1);
    const f = { x: best % cols, y: (best / cols) | 0 };
    const [hx, hy] = HOPS[n % HOPS.length];
    const sx = Math.sign(goal.x - f.x) || 1;
    const dx = sx * Math.min(hx, Math.max(2, Math.abs(goal.x - f.x)));
    const dy = goal.y < f.y ? Math.max(goal.y - f.y, hy) : Math.min(goal.y - f.y, 3);
    const t = { x: clamp(f.x + dx, 3, cols - 4), y: clamp(f.y + dy, 4, rows - 3) };
    placeBridge(g, f, t, bridges);
    fixes++;
    s.requeue(t.x, t.y, 16); s.requeue(f.x, f.y, 4);
    found = s.run(goalTest);
    if (found >= 0) {
      // verify from scratch (a corridor may have cut something important)
      s = new Search(g); s.seed(settle(g, start.x, start.y)); found = s.run(goalTest);
    }
  }
  if (found < 0) {
    // fallback: the best reachable top-right spot becomes the goal
    let best = sk, bs = -1e9;
    for (const k of s.list()) { const x = k % cols, y = (k / cols) | 0; const sc = x / cols + 0.6 * (1 - y / rows); if (sc > bs) { bs = sc; best = k; } }
    found = best;
    goal = { x: found % cols, y: (found / cols) | 0 };
  }
  // path + ghost replay
  const chain = [];
  for (let k = found; k >= 0; k = s.parent[k]) chain.push(k);
  chain.reverse();
  const ghost = [];
  const pathCells = chain.map(k => [k % cols, (k / cols) | 0]);
  for (let i = 1; i < chain.length; i++) {
    const from = chain[i - 1], cx = from % cols, cy = (from / cols) | 0;
    const b = nodeBody(cx, cy);
    if (ghost.length) {
      // glide from last landing to the next take-off spot
      const lx = ghost[ghost.length - 5], ly = ghost[ghost.length - 4];
      const dist = b.x - lx, n = Math.ceil(Math.abs(dist) / 2.5);
      for (let j = 1; j <= n; j++) ghost.push(lx + dist * j / n, ly + (b.y - ly) * j / n, Math.sign(dist) || 1, 1, 0);
    }
    simulate(g, cx, cy, ACTIONS[s.act[chain[i]]], ghost);
  }
  return { goal, bridges, fixes, ghost: new Float32Array(ghost), pathCells, reached: s.list(), reachCount: s.list().length, start: sk };
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
