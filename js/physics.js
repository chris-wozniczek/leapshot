// Shared platformer physics. Used by the game loop AND the reachability solver,
// so "the solver says it's beatable" means exactly "the player can beat it".
export const CELL = 8;
export const T = { EMPTY: 0, SOLID: 1, LEDGE: 2, SPIKE: 3 };

export const P = {
  W: 7, H: 12,
  DT: 1 / 60,
  GRAV_UP: 1500, GRAV_DOWN: 2300, GRAV_CUT: 3400,
  JUMP_V: 395, MAXFALL: 620,
  RUN: 150, ACC_G: 1700, ACC_A: 1150, FRIC: 2100,
  COYOTE: 0.09, BUFFER: 0.12,
};

export function makeBody(x, y) {
  return { x, y, vx: 0, vy: 0, grounded: false, coyote: 0, buffer: 0, jumping: false, stepUp: 0, facing: 1 };
}

export class Grid {
  constructor(cols, rows, tiles) {
    this.cols = cols; this.rows = rows;
    this.tiles = tiles || new Uint8Array(cols * rows);
  }
  get(c, r) {
    if (c < 0 || c >= this.cols || r >= this.rows) return T.EMPTY;
    if (r < 0) return T.EMPTY;
    return this.tiles[r * this.cols + c];
  }
  set(c, r, v) {
    if (c < 0 || c >= this.cols || r < 0 || r >= this.rows) return;
    this.tiles[r * this.cols + c] = v;
  }
  solid(c, r) { return this.get(c, r) === T.SOLID; }
  floor(c, r) { const t = this.get(c, r); return t === T.SOLID || t === T.LEDGE; }
}

const EPS = 0.001;

function colsOf(x) { return [Math.floor(x / CELL), Math.floor((x + P.W - EPS) / CELL)]; }
function rowsOf(y) { return [Math.floor(y / CELL), Math.floor((y + P.H - EPS) / CELL)]; }

function boxHitsSolid(g, x, y) {
  const [c0, c1] = colsOf(x), [r0, r1] = rowsOf(y);
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (g.solid(c, r)) return true;
  return false;
}

// input: { dir: -1|0|1, jump: bool (held), jumpPressed: bool (edge) }
// returns event bitmask: 1 jumped, 2 landed, 4 bonk, 8 stepped
export function step(b, input, g) {
  const dt = P.DT;
  let ev = 0;
  const wasGrounded = b.grounded;

  // horizontal velocity
  const target = input.dir * P.RUN;
  const acc = b.grounded ? P.ACC_G : P.ACC_A;
  if (input.dir !== 0) {
    b.facing = input.dir;
    const a = (Math.sign(target - b.vx) !== Math.sign(b.vx) && b.vx !== 0) ? acc * 1.6 : acc;
    b.vx = approach(b.vx, target, a * dt);
  } else {
    b.vx = approach(b.vx, 0, (b.grounded ? P.FRIC : P.ACC_A * 0.6) * dt);
  }

  // jump buffering + coyote time
  if (input.jumpPressed) b.buffer = P.BUFFER; else b.buffer = Math.max(0, b.buffer - dt);
  b.coyote = b.grounded ? P.COYOTE : Math.max(0, b.coyote - dt);
  if (b.buffer > 0 && b.coyote > 0) {
    b.vy = -P.JUMP_V; b.buffer = 0; b.coyote = 0; b.grounded = false; b.jumping = true; ev |= 1;
  }

  // gravity with variable jump height
  let grav = b.vy < 0 ? (input.jump && b.jumping ? P.GRAV_UP : P.GRAV_CUT) : P.GRAV_DOWN;
  b.vy = Math.min(P.MAXFALL, b.vy + grav * dt);
  if (b.vy >= 0) b.jumping = false;

  // move X
  const worldW = g.cols * CELL;
  let nx = b.x + b.vx * dt;
  if (nx < 0) { nx = 0; b.vx = 0; }
  if (nx > worldW - P.W) { nx = worldW - P.W; b.vx = 0; }
  if (boxHitsSolid(g, nx, b.y)) {
    // try a one-cell step-up while grounded
    const up = b.y - CELL;
    if (wasGrounded && !boxHitsSolid(g, nx, up) && !boxHitsSolid(g, b.x, up) && stepSupport(g, nx, up)) {
      b.y = up; b.stepUp += CELL; ev |= 8; b.x = nx;
    } else {
      if (b.vx > 0) nx = Math.floor((nx + P.W) / CELL) * CELL - P.W - EPS;
      else if (b.vx < 0) nx = Math.floor(nx / CELL + 1) * CELL + EPS;
      if (boxHitsSolid(g, nx, b.y)) nx = b.x;
      b.x = nx; b.vx = 0;
    }
  } else {
    // ledge step-up (walking into a ledge one cell higher)
    if (wasGrounded && b.vx !== 0) {
      const feetRow = Math.round((b.y + P.H) / CELL) - 1;
      const lead = b.vx > 0 ? Math.floor((nx + P.W - EPS) / CELL) : Math.floor(nx / CELL);
      if (g.get(lead, feetRow) === T.LEDGE && Math.abs((b.y + P.H) - (feetRow + 1) * CELL) < 0.5) {
        const up = (feetRow) * CELL - P.H;
        if (!boxHitsSolid(g, nx, up)) { b.y = up; b.stepUp += CELL; ev |= 8; }
      }
    }
    b.x = nx;
  }

  // move Y
  const prevBottom = b.y + P.H;
  let ny = b.y + b.vy * dt;
  b.grounded = false;
  if (b.vy > 0) {
    const bottom = ny + P.H;
    const r0 = Math.floor((prevBottom - EPS) / CELL) + 1, r1 = Math.floor((bottom - EPS) / CELL);
    const [c0, c1] = colsOf(b.x);
    outer: for (let r = Math.max(r0, 0); r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const t = g.get(c, r);
        if (t === T.SOLID || (t === T.LEDGE && prevBottom <= r * CELL + EPS)) {
          ny = r * CELL - P.H; b.vy = 0; b.grounded = true; break outer;
        }
      }
    }
    // resting exactly on a floor
  } else if (b.vy < 0) {
    if (ny < 0) { ny = 0; b.vy = 0; }
    else if (boxHitsSolid(g, b.x, ny)) {
      ny = (Math.floor(ny / CELL) + 1) * CELL; b.vy = 0; b.jumping = false; ev |= 4;
    }
  }
  b.y = ny;
  if (!b.grounded && b.vy >= 0) {
    // support check for exactly-aligned feet
    const bottom = b.y + P.H;
    if (Math.abs(bottom / CELL - Math.round(bottom / CELL)) < 0.01) {
      const r = Math.round(bottom / CELL);
      const [c0, c1] = colsOf(b.x);
      for (let c = c0; c <= c1; c++) if (g.floor(c, r)) { b.grounded = true; b.vy = 0; b.y = r * CELL - P.H; break; }
    }
  }
  if (b.grounded && !wasGrounded) ev |= 2;
  return ev;
}

function stepSupport(g, x, y) {
  const r = Math.round((y + P.H) / CELL);
  const [c0, c1] = colsOf(x);
  for (let c = c0; c <= c1; c++) if (g.floor(c, r)) return true;
  return false;
}

export function touchesSpike(b, g) {
  const x0 = b.x + 1, x1 = b.x + P.W - 1, y0 = b.y + 2, y1 = b.y + P.H;
  const c0 = Math.floor(x0 / CELL), c1 = Math.floor(x1 / CELL), r0 = Math.floor(y0 / CELL), r1 = Math.floor((y1 - EPS) / CELL);
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    if (g.get(c, r) === T.SPIKE) {
      const sx0 = c * CELL + 1.5, sx1 = c * CELL + CELL - 1.5, sy0 = r * CELL + 3.5, sy1 = r * CELL + CELL;
      if (x1 > sx0 && x0 < sx1 && y1 > sy0 && y0 < sy1) return true;
    }
  }
  return false;
}

export function outOfWorld(b, g) { return b.y > g.rows * CELL + 24; }

function approach(v, t, d) { return v < t ? Math.min(t, v + d) : Math.max(t, v - d); }
