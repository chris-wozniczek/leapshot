// Photo -> tile grid. Pure functions over pixel data, no ML.
import { T, Grid } from './physics.js';
import { solve, placeBridge } from './reach.js';

export const A = 4; // analysis pixels per cell

// rgba: Uint8ClampedArray of size (cols*A)*(rows*A)*4
export function analyse(rgba, cols, rows) {
  const w = cols * A, h = rows * A, n = w * h;
  const lum = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) lum[i] = (0.2126 * rgba[j] + 0.7152 * rgba[j + 1] + 0.0722 * rgba[j + 2]) / 255;
  const blur = gauss(gauss(lum, w, h), w, h);
  const mag = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = -blur[i - w - 1] - 2 * blur[i - 1] - blur[i + w - 1] + blur[i - w + 1] + 2 * blur[i + 1] + blur[i + w + 1];
    const gy = -blur[i - w - 1] - 2 * blur[i - w] - blur[i - w + 1] + blur[i + w - 1] + 2 * blur[i + w] + blur[i + w + 1];
    mag[i] = Math.sqrt(gx * gx + gy * gy);
  }
  // per-cell luminance
  const cl = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    let s = 0;
    for (let yy = 0; yy < A; yy++) for (let xx = 0; xx < A; xx++) s += blur[(r * A + yy) * w + c * A + xx];
    cl[r * cols + c] = s / (A * A);
  }
  // 8-bit edge map for the glow layer
  let mx = 0; for (let i = 0; i < n; i++) if (mag[i] > mx) mx = mag[i];
  const edge8 = new Uint8ClampedArray(n);
  const k = mx > 0 ? 255 / (mx * 0.55) : 0;
  for (let i = 0; i < n; i++) edge8[i] = mag[i] * k;
  return { w, h, mag, cl, edge8 };
}

function gauss(src, w, h) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const a = src[y * w + Math.max(0, x - 2)], b = src[y * w + Math.max(0, x - 1)], c = src[i], d = src[y * w + Math.min(w - 1, x + 1)], e = src[y * w + Math.min(w - 1, x + 2)];
    tmp[i] = (a + 4 * b + 6 * c + 4 * d + e) / 16;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = tmp[Math.max(0, y - 2) * w + x], b = tmp[Math.max(0, y - 1) * w + x], c = tmp[y * w + x], d = tmp[Math.min(h - 1, y + 1) * w + x], e = tmp[Math.min(h - 1, y + 2) * w + x];
    out[y * w + x] = (a + 4 * b + 6 * c + 4 * d + e) / 16;
  }
  return out;
}

function cellsAt(an, cols, rows, thr) {
  const out = new Uint8Array(cols * rows);
  const { w, mag } = an;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    let cnt = 0;
    for (let yy = 0; yy < A; yy++) for (let xx = 0; xx < A; xx++) if (mag[(r * A + yy) * w + c * A + xx] > thr) cnt++;
    out[r * cols + c] = cnt >= 4 ? 1 : 0;
  }
  return out;
}

// sensitivity 0..1 -> target solid density
export function buildLevel(an, cols, rows, sensitivity, opts = {}) {
  const target = 0.055 + sensitivity * 0.2;
  let lo = 0.01, hi = 2.5, cand = null;
  for (let it = 0; it < 12; it++) {
    const mid = (lo + hi) / 2;
    cand = cellsAt(an, cols, rows, mid);
    let s = 0; for (let i = 0; i < cand.length; i++) s += cand[i];
    if (s / cand.length > target) lo = mid; else hi = mid;
  }
  cand = cellsAt(an, cols, rows, Math.max(hi, 0.035));
  const g = new Grid(cols, rows);
  const at = (c, r) => (c >= 0 && c < cols && r >= 0 && r < rows) ? cand[r * cols + c] : 0;

  // close 1-cell horizontal gaps, drop isolated specks
  const cl2 = cand.slice();
  for (let r = 0; r < rows; r++) for (let c = 1; c < cols - 1; c++) if (!at(c, r) && at(c - 1, r) && at(c + 1, r)) cl2[r * cols + c] = 1;
  cand = cl2;
  const cl3 = cand.slice();
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (!at(c, r)) continue;
    let nb = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && at(c + dx, r + dy)) nb++;
    if (nb === 0) cl3[r * cols + c] = 0;
  }
  cand = cl3;
  removeSmall(cand, cols, rows, 4);

  // chunky vertical runs become solid walls, thin strokes become jump-through ledges
  for (let c = 0; c < cols; c++) {
    let r = 0;
    while (r < rows) {
      if (!cand[r * cols + c]) { r++; continue; }
      let e = r; while (e < rows && cand[e * cols + c]) e++;
      const run = e - r;
      for (let k = r; k < e; k++) g.set(c, k, run >= 3 ? T.SOLID : T.LEDGE);
      r = e;
    }
  }
  // Ledges stacked on ledges are invisible; keep the top surface only
  for (let r = rows - 1; r > 0; r--) for (let c = 0; c < cols; c++)
    if (g.get(c, r) === T.LEDGE && g.get(c, r - 1) === T.LEDGE) g.set(c, r, T.EMPTY);

  // start pad (left) and goal pad (top-right-ish)
  const sy = Math.round(rows * 0.72), sx = 4;
  clearRect(g, 0, sy - 6, 10, sy);
  for (let c = 0; c <= 8; c++) g.set(c, sy + 1, T.SOLID);
  for (let c = 0; c <= 8; c++) if (g.get(c, sy + 2) === T.EMPTY) g.set(c, sy + 2, T.SOLID);
  const gy = Math.max(8, Math.round(rows * 0.26)), gx = cols - 7;
  clearRect(g, gx - 4, gy - 7, cols - 1, gy);
  for (let c = gx - 3; c <= cols - 2; c++) g.set(c, gy + 1, T.SOLID);

  // hazards: glowing spikes sprout on surfaces over the darkest parts of the photo
  const sorted = Array.from(an.cl).sort((a, b) => a - b);
  const darkT = Math.min(0.24, sorted[Math.floor(sorted.length * 0.14)] + 0.02);
  const spikeCand = [];
  for (let r = 1; r < rows - 1; r++) for (let c = 1; c < cols - 1; c++) {
    if (g.get(c, r) !== T.EMPTY || !g.floor(c, r + 1) || g.get(c, r - 1) !== T.EMPTY) continue;
    if (c < 16 || (c > gx - 8 && r < gy + 6)) continue;
    let s = 0, n = 0;
    for (let dy = -2; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const rr = r + dy, cc = c + dx; if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) { s += an.cl[rr * cols + cc]; n++; } }
    const d = s / n;
    if (d < darkT) spikeCand.push([d, c, r]);
  }
  spikeCand.sort((a, b) => a[0] - b[0]);
  const maxSpikes = Math.round(cols * rows * 0.006 * (0.6 + sensitivity));
  let placed = 0;
  for (const [, c, r] of spikeCand) {
    if (placed >= maxSpikes) break;
    // keep runs short-ish so there's always a way across
    let run = 0; for (let k = c - 1; g.get(k, r) === T.SPIKE; k--) run++;
    if (run >= 4) continue;
    g.set(c, r, T.SPIKE); placed++;
  }

  const start = { x: sx, y: sy };
  let goal = { x: gx, y: gy };
  const sol = solve(g, start, goal, { fix: true, bridges: [] });
  goal = sol.goal;

  // collectibles on the brightest reachable highlights
  const coins = placeCoins(g, an, sol, start, goal, opts.seed || 1);
  return { cols, rows, tiles: g.tiles, start, goal, coins, bridges: sol.bridges, ghost: sol.ghost, fixed: sol.fixes, reachable: sol.reachCount };
}

function clearRect(g, x0, y0, x1, y1) {
  for (let r = y0; r <= y1; r++) for (let c = x0; c <= x1; c++) g.set(c, r, T.EMPTY);
}

function removeSmall(cand, cols, rows, minSize) {
  const seen = new Uint8Array(cand.length);
  const stack = [];
  for (let i = 0; i < cand.length; i++) {
    if (!cand[i] || seen[i]) continue;
    const comp = []; stack.push(i); seen[i] = 1;
    while (stack.length) {
      const j = stack.pop(); comp.push(j);
      const c = j % cols, r = (j / cols) | 0;
      const nb = [c > 0 ? j - 1 : -1, c < cols - 1 ? j + 1 : -1, r > 0 ? j - cols : -1, r < rows - 1 ? j + cols : -1];
      for (const k of nb) if (k >= 0 && cand[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
    }
    if (comp.length < minSize) for (const j of comp) cand[j] = 0;
  }
}

function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function placeCoins(g, an, sol, start, goal, seed) {
  const { cols, rows } = g;
  const rand = rng(seed);
  // cells within easy reach of a reachable standing spot
  const near = new Uint8Array(cols * rows);
  for (const key of sol.reached) {
    const x = key % cols, y = (key / cols) | 0;
    for (let dy = 0; dy <= 3; dy++) { const r = y - dy; if (r >= 0) near[r * cols + x] = 1; }
  }
  const ok = (c, r) => near[r * cols + c] && g.get(c, r) === T.EMPTY && g.get(c, r - 1) !== T.SOLID;
  const cand = [];
  for (let r = 2; r < rows - 1; r++) for (let c = 2; c < cols - 2; c++) if (ok(c, r)) cand.push([an.cl[r * cols + c] + rand() * 0.02, c, r]);
  cand.sort((a, b) => b[0] - a[0]);
  const coins = [];
  const far = (c, r) => coins.every(k => Math.abs(k.x - c) + Math.abs(k.y - r) >= 7) && Math.abs(c - start.x) + Math.abs(r - start.y) > 5 && Math.abs(c - goal.x) + Math.abs(r - goal.y) > 4;
  const maxCoins = 22;
  for (const [, c, r] of cand) {
    if (coins.length >= Math.round(maxCoins * 0.7)) break;
    if (far(c, r)) coins.push({ x: c, y: r });
  }
  // top up along the solution path so there's always a trail to follow
  const path = sol.pathCells || [];
  for (let i = 3; i < path.length && coins.length < maxCoins; i += 3) {
    const [c, r0] = path[i];
    const r = r0 - 1;
    if (r > 1 && ok(c, r) && far(c, r)) coins.push({ x: c, y: r });
  }
  return coins;
}
