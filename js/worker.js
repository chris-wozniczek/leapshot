import { analyse, buildLevel } from './generate.js';
import { Grid } from './physics.js';
import { solve } from './reach.js';
let cache = null;
self.onmessage = e => {
  const m = e.data;
  const t0 = performance.now();
  if (m.type === 'solve') {
    const g = new Grid(m.cols, m.rows, m.tiles);
    const bridges = m.bridges.slice();
    const sol = solve(g, m.start, m.goal, { fix: m.fix, bridges });
    const reachedGoal = sol.goal.x === m.goal.x && sol.goal.y === m.goal.y;
    self.postMessage({ id: m.id, solved: { tiles: g.tiles, goal: sol.goal, bridges, ghost: sol.ghost, fixes: sol.fixes, reachable: sol.reachCount, reachedGoal, ms: performance.now() - t0 } });
    return;
  }
  if (m.rgba) cache = { an: analyse(m.rgba, m.cols, m.rows), cols: m.cols, rows: m.rows };
  const { an, cols, rows } = cache;
  if (m.edgesOnly) { self.postMessage({ id: m.id, edges: an.edge8, ew: an.w, eh: an.h }); return; }
  const lvl = buildLevel(an, cols, rows, m.sensitivity, { seed: m.seed });
  lvl.ms = performance.now() - t0;
  const out = { id: m.id, level: lvl };
  if (m.rgba) { out.edges = an.edge8; out.ew = an.w; out.eh = an.h; }
  self.postMessage(out);
};
