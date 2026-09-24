// Game loop: fixed-step physics, juicy feedback, camera, rendering.
import { CELL, P, T, Grid, makeBody, step, touchesSpike, outOfWorld } from './physics.js';
import { ART, renderTiles, renderGlow, renderSpikes, roundRect } from './art.js';
import { sfx } from './audio.js';

const PALETTE = ['#ff4f8b', '#ffb547', '#5ef2ff', '#c8ff5a', '#ffffff', '#b28cff'];
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Game {
  constructor(canvas, hooks = {}) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.hooks = hooks;
    this.keys = { left: false, right: false, jump: false };
    this.jumpEdge = false;
    this.mode = 'idle';
    this.cam = { x: 0, y: 0, z: 1 };
    this.shake = 0; this.parts = []; this.confetti = [];
    this.acc = 0; this.t = 0;
    this.time = 0; this.running = false; this.deaths = 0;
    this.sq = { x: 1, y: 1, vx: 0, vy: 0 };
    this.blink = 0; this.runPhase = 0; this.stepSnd = 0;
    this.brush = null;
    this.resize();
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.vw = Math.max(1, r.width); this.vh = Math.max(1, r.height);
    this.cv.width = Math.round(this.vw * this.dpr); this.cv.height = Math.round(this.vh * this.dpr);
  }

  // level: {cols, rows, tiles, start, goal, coins, bridges, ghost}
  setLevel(level, art, raw, { reveal = false, keepMode = false } = {}) {
    this.level = level;
    this.grid = new Grid(level.cols, level.rows, level.tiles);
    this.art = art; this.raw = raw;
    this.worldW = level.cols * CELL; this.worldH = level.rows * CELL;
    this.rebuildLayers();
    this.taken = new Set();
    const prev = this.mode;
    this.resetRun();
    if (reveal) { this.mode = 'reveal'; this.revealT = 0; this.fitCamera(true); sfx.whoosh(); }
    else if (keepMode && (prev === 'play' || prev === 'edit')) this.mode = prev;
    else this.startDemo();
    if (this.mode === 'edit') this.fitCamera(false);
    this.hooks.onMode && this.hooks.onMode(this.mode);
  }

  rebuildLayers() {
    this.tileLayer = renderTiles(this.level, this.tileLayer);
    this.glowLayer = renderGlow(this.tileLayer, this.glowLayer);
    this.spikeLayer = renderSpikes(this.level, this.spikeLayer);
    this.spikeGlow = renderGlow(this.spikeLayer, this.spikeGlow);
  }

  spawnBody() {
    const s = this.level.start;
    const b = makeBody(s.x * CELL + (CELL - P.W) / 2, (s.y + 1) * CELL - P.H);
    b.grounded = true;
    return b;
  }

  resetRun() {
    this.body = this.spawnBody();
    this.prev = { x: this.body.x, y: this.body.y };
    this.alive = true; this.deadT = 0;
    this.time = 0; this.running = false; this.deaths = 0; this.combo = 0; this.comboT = 0;
    this.taken = new Set(); this.won = false; this.confetti = [];
    this.stepOff = 0;
    this.hooks.onCoin && this.hooks.onCoin(0, this.level.coins.length);
  }

  startDemo() { this.mode = 'demo'; this.gi = 0; this.resetRun(); this.demoWait = 0; this.hooks.onMode && this.hooks.onMode('demo'); }

  play() {
    if (this.mode === 'play' && !this.won) return;
    this.mode = 'play'; this.resetRun();
    this.snapCameraToPlayer();
    this.hooks.onMode && this.hooks.onMode('play');
  }
  restart() { if (this.mode === 'edit') return; this.mode = 'play'; this.resetRun(); this.hooks.onMode && this.hooks.onMode('play'); }
  edit(on) {
    if (on) { this.mode = 'edit'; this.fitCamera(false); }
    else { this.mode = 'play'; this.resetRun(); }
    this.hooks.onMode && this.hooks.onMode(this.mode);
  }

  pressJump() { this.jumpEdge = true; }

  // ---------- camera ----------
  playZoom() {
    let z = this.vh / 290;
    z = Math.max(z, this.vw / this.worldW, this.vh / this.worldH);
    return Math.min(z, 4);
  }
  fitZoom() { return Math.min(this.vw / this.worldW, this.vh / this.worldH) * 0.94; }
  fitCamera(snap) {
    this.camT = { x: this.worldW / 2, y: this.worldH / 2, z: this.fitZoom() };
    if (snap) Object.assign(this.cam, this.camT);
  }
  snapCameraToPlayer() {
    this.cam.z = this.playZoom();
    this.cam.x = this.body.x; this.cam.y = this.body.y; this.clampCam(this.cam);
  }
  clampCam(c) {
    const hw = this.vw / c.z / 2, hh = this.vh / c.z / 2;
    c.x = hw * 2 >= this.worldW ? this.worldW / 2 : clamp(c.x, hw, this.worldW - hw);
    c.y = hh * 2 >= this.worldH ? this.worldH / 2 : clamp(c.y, hh, this.worldH - hh);
  }
  updateCamera(dt) {
    let tgt;
    if (this.mode === 'edit' || this.mode === 'reveal') tgt = { x: this.worldW / 2, y: this.worldH / 2, z: this.fitZoom() };
    else {
      const z = this.mode === 'demo' ? this.playZoom() * 0.86 : this.playZoom();
      const b = this.body;
      tgt = { x: b.x + P.W / 2 + b.vx * 0.32, y: b.y - 10 + (b.vy > 250 ? 40 : 0), z };
      if (this.won) tgt.z = z * 1.15;
    }
    const k = 1 - Math.exp(-dt * (this.mode === 'play' ? 6 : 3.2));
    const kz = 1 - Math.exp(-dt * 2.6);
    this.cam.z = lerp(this.cam.z, tgt.z, kz);
    const c = { x: tgt.x, y: tgt.y, z: this.cam.z }; this.clampCam(c);
    this.cam.x = lerp(this.cam.x, c.x, k); this.cam.y = lerp(this.cam.y, c.y, k);
    const cc = { ...this.cam }; this.clampCam(cc); this.cam.x = cc.x; this.cam.y = cc.y;
  }

  // ---------- loop ----------
  frame(dt) {
    dt = Math.min(dt, 0.1);
    this.t += dt;
    if (!this.level) { const c = this.ctx; c.setTransform(1, 0, 0, 1, 0, 0); c.fillStyle = '#05040b'; c.fillRect(0, 0, this.cv.width, this.cv.height); return; }
    if (this.mode === 'reveal') {
      this.revealT += dt;
      if (this.revealT > 2.1) { this.startDemo(); if (this.pendingPlay) { this.pendingPlay = false; this.play(); } }
    }
    this.acc += dt;
    while (this.acc >= P.DT) { this.prev = { x: this.body.x, y: this.body.y }; this.tick(); this.acc -= P.DT; }
    this.updateFx(dt);
    this.updateCamera(dt);
    this.render();
  }

  tick() {
    const dt = P.DT;
    if (this.mode === 'demo') return this.tickDemo();
    if (this.mode !== 'play') { this.jumpEdge = false; return; }
    if (this.won) { this.jumpEdge = false; this.bodyIdle(); return; }
    if (!this.alive) {
      this.deadT -= dt; this.jumpEdge = false;
      if (this.deadT <= 0) {
        this.body = this.spawnBody(); this.prev = { x: this.body.x, y: this.body.y }; this.alive = true;
        this.sq.x = 0.6; this.sq.y = 1.5; this.burst(this.body.x + P.W / 2, this.body.y + P.H / 2, 14, ['#ffffff', '#5ef2ff'], 90);
      }
      return;
    }
    const dir = (this.keys.right ? 1 : 0) - (this.keys.left ? 1 : 0);
    const input = { dir, jump: this.keys.jump, jumpPressed: this.jumpEdge };
    this.jumpEdge = false;
    if (!this.running && (dir !== 0 || input.jumpPressed)) { this.running = true; this.hooks.onStart && this.hooks.onStart(); }
    if (this.running) this.time += dt;
    const vyBefore = this.body.vy;
    const ev = step(this.body, input, this.grid);
    this.handleEvents(ev, vyBefore, dir);
    this.collect();
    if (touchesSpike(this.body, this.grid) || outOfWorld(this.body, this.grid)) this.die();
    else this.checkGoal();
  }

  tickDemo() {
    const g = this.level.ghost;
    if (!g || g.length < 5) return;
    const n = g.length / 5;
    if (this.gi >= n) {
      if (!this.won) this.celebrate(false);
      this.demoWait += P.DT;
      if (this.demoWait > 3) { this.gi = 0; this.resetRun(); }
      return;
    }
    const i = this.gi * 5, b = this.body;
    const nx = g[i], ny = g[i + 1];
    const wasG = b.grounded, vyBefore = b.vy;
    b.vx = (nx - b.x) / P.DT; b.vy = (ny - b.y) / P.DT;
    if (this.gi === 0) { b.vx = 0; b.vy = 0; }
    b.x = nx; b.y = ny; b.facing = g[i + 2]; b.grounded = !!g[i + 3];
    let ev = 0; if (g[i + 4]) ev |= 1; if (b.grounded && !wasG) ev |= 2;
    this.handleEvents(ev, vyBefore, Math.abs(b.vx) > 5 ? Math.sign(b.vx) : 0, true);
    this.collect(true);
    this.gi++;
  }

  bodyIdle() { this.body.vx *= 0.8; }

  handleEvents(ev, vyBefore, dir, quiet) {
    const b = this.body, fx = b.x + P.W / 2, fy = b.y + P.H;
    if (ev & 1) { this.sq.x = 0.68; this.sq.y = 1.4; this.dust(fx, fy, 7, 0); if (!quiet) sfx.jump(); }
    if (ev & 2) {
      const p = clamp(vyBefore / 520, 0.25, 1);
      this.sq.x = 1 + 0.45 * p; this.sq.y = 1 - 0.38 * p;
      this.dust(fx, fy, Math.round(6 + 8 * p), 1);
      if (!quiet) sfx.land(p);
      if (p > 0.95) this.shake = Math.max(this.shake, 0.18);
    }
    if (ev & 8) this.stepOff += CELL;
    if (b.grounded && Math.abs(b.vx) > 40) {
      this.runPhase += Math.abs(b.vx) * P.DT * 0.09;
      this.stepSnd -= P.DT;
      if (this.stepSnd <= 0) { this.stepSnd = 0.16; if (!quiet) sfx.step(); if (Math.random() < 0.6) this.dust(fx - b.facing * 3, fy, 1, 2); }
    }
  }

  collect(quiet) {
    const b = this.body, cx = b.x + P.W / 2, cy = b.y + P.H / 2;
    this.comboT -= P.DT; if (this.comboT <= 0) this.combo = 0;
    this.level.coins.forEach((c, i) => {
      if (this.taken.has(i)) return;
      const x = c.x * CELL + 4, y = c.y * CELL + 4;
      if (Math.abs(x - cx) < 8 && Math.abs(y - cy) < 10) {
        this.taken.add(i);
        if (!quiet) sfx.coin(this.combo);
        this.combo++; this.comboT = 1.3;
        this.burst(x, y, 16, ['#ffe27a', '#fff6c9', '#ffb547'], 110, true);
        this.parts.push({ kind: 'ring', x, y, life: 0.35, max: 0.35 });
        this.parts.push({ kind: 'text', x, y: y - 6, vy: -30, life: 0.8, max: 0.8, text: this.combo > 1 ? `+1 ×${this.combo}` : '+1' });
        this.hooks.onCoin && this.hooks.onCoin(this.taken.size, this.level.coins.length, quiet);
      }
    });
  }

  checkGoal() {
    const b = this.body, g = this.level.goal;
    const gx = g.x * CELL + 4, gy = (g.y + 1) * CELL;
    if (Math.abs(b.x + P.W / 2 - gx) < 9 && b.y + P.H > gy - 30 && b.y < gy + 2) this.celebrate(true);
  }

  celebrate(real) {
    if (this.won) return;
    this.won = true;
    if (real) { this.running = false; sfx.win(); }
    const g = this.level.goal;
    this.burst(g.x * CELL + 4, g.y * CELL - 10, 40, PALETTE, 200, true);
    this.shake = Math.max(this.shake, real ? 0.35 : 0.15);
    this.spawnConfetti(real ? 220 : 90);
    if (real && this.hooks.onWin) this.hooks.onWin({ time: this.time, coins: this.taken.size, total: this.level.coins.length, deaths: this.deaths });
  }

  die() {
    if (!this.alive) return;
    this.alive = false; this.deadT = 0.75; this.deaths++;
    const b = this.body;
    this.burst(b.x + P.W / 2, b.y + P.H / 2, 34, ['#ff2d55', '#ff7a3c', '#ffe38a', '#ffffff'], 220);
    this.shake = 0.55; sfx.die();
    this.hooks.onDeath && this.hooks.onDeath(this.deaths);
  }

  // ---------- fx ----------
  dust(x, y, n, kind) {
    for (let i = 0; i < n; i++) {
      const a = kind === 1 ? (Math.random() < 0.5 ? Math.PI : 0) + (Math.random() - 0.5) * 0.9 : -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
      const s = kind === 2 ? 15 : 40 + Math.random() * 60;
      this.parts.push({ kind: 'dust', x: x + (Math.random() - 0.5) * 6, y: y - 1, vx: Math.cos(a) * s, vy: Math.sin(a) * s * (kind === 1 ? 0.3 : 0.6) - 10, life: 0.35 + Math.random() * 0.3, max: 0.6, r: 1.2 + Math.random() * 1.8 });
    }
  }
  burst(x, y, n, colors, speed, star) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = speed * (0.3 + Math.random() * 0.7);
      this.parts.push({ kind: star ? 'spark' : 'chunk', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 40, life: 0.5 + Math.random() * 0.5, max: 1, r: 1 + Math.random() * 2, c: colors[i % colors.length], rot: Math.random() * 6 });
    }
  }
  spawnConfetti(n) {
    for (let i = 0; i < n; i++) {
      const side = i % 2 ? 1 : -1;
      this.confetti.push({ x: this.vw / 2 + side * this.vw * 0.42, y: this.vh * 0.85, vx: -side * (150 + Math.random() * 420), vy: -(450 + Math.random() * 600), rot: Math.random() * 6, vr: (Math.random() - 0.5) * 14, w: 5 + Math.random() * 6, h: 3 + Math.random() * 4, c: PALETTE[i % PALETTE.length], life: 3 + Math.random() * 1.5 });
    }
  }
  updateFx(dt) {
    for (const p of this.parts) {
      p.life -= dt;
      if (p.vx !== undefined) { p.x += p.vx * dt; p.y += (p.vy || 0) * dt; }
      if (p.kind === 'dust') { p.vx *= 0.9; p.vy *= 0.9; }
      if (p.kind === 'chunk') p.vy += 500 * dt;
      if (p.kind === 'spark') { p.vx *= 0.94; p.vy = p.vy * 0.94 + 60 * dt; }
    }
    this.parts = this.parts.filter(p => p.life > 0);
    for (const c of this.confetti) { c.vy += 900 * dt; c.vx *= 0.985; c.vy *= 0.985; c.x += c.vx * dt; c.y += c.vy * dt; c.rot += c.vr * dt; c.life -= dt; }
    this.confetti = this.confetti.filter(c => c.life > 0 && c.y < this.vh + 40);
    this.shake = Math.max(0, this.shake - dt * 1.6);
    // spring squash back to 1
    const k = 260, d = 16;
    this.sq.vx += ((1 - this.sq.x) * k - this.sq.vx * d) * dt; this.sq.x += this.sq.vx * dt;
    this.sq.vy += ((1 - this.sq.y) * k - this.sq.vy * d) * dt; this.sq.y += this.sq.vy * dt;
    if (!this.body.grounded && Math.abs(this.body.vy) > 60) { const s = clamp(Math.abs(this.body.vy) / 2600, 0, 0.12); this.sq.y += s * 0.2; this.sq.x -= s * 0.2; }
    this.stepOff *= Math.exp(-dt * 22);
    this.blink -= dt; if (this.blink < -0.12) this.blink = 2 + Math.random() * 3;
  }

  // ---------- render ----------
  render() {
    const { ctx, dpr } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#07060d'; ctx.fillRect(0, 0, this.cv.width, this.cv.height);
    if (!this.level) return;
    const s = dpr * this.cam.z;
    const tr = this.shake * this.shake;
    const sx = tr * 12 * Math.sin(this.t * 71), sy = tr * 12 * Math.cos(this.t * 53);
    ctx.setTransform(s, 0, 0, s, this.cv.width / 2 - this.cam.x * s + sx * dpr, this.cv.height / 2 - this.cam.y * s + sy * dpr);
    this.drawWorld(ctx, { player: true });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawScreenFx(ctx);
  }

  drawWorld(ctx, opts = {}) {
    const W = this.worldW, H = this.worldH, t = this.t;
    // frame shadow
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 40;
    ctx.fillStyle = '#0b0818'; ctx.fillRect(0, 0, W, H);
    ctx.restore();
    const rev = this.mode === 'reveal' && !opts.card ? clamp(this.revealT / 1.6, 0, 1) : 1;
    const scan = easeInOut(rev) * (W + 60) - 30;
    if (rev < 1) {
      ctx.drawImage(this.raw, 0, 0, W, H);
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, Math.max(0, scan), H); ctx.clip();
    }
    ctx.drawImage(this.art, 0, 0, W, H);
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.55; ctx.drawImage(this.glowLayer, 0, 0, W, H);
    ctx.globalAlpha = 0.5 + 0.35 * Math.sin(t * 4); ctx.drawImage(this.spikeGlow, 0, 0, W, H); ctx.restore();
    ctx.drawImage(this.tileLayer, 0, 0, W, H);
    ctx.drawImage(this.spikeLayer, 0, 0, W, H);
    if (rev < 1) {
      ctx.restore();
      const g = ctx.createLinearGradient(scan - 40, 0, scan + 6, 0);
      g.addColorStop(0, 'rgba(94,242,255,0)'); g.addColorStop(0.85, 'rgba(94,242,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0.95)');
      ctx.fillStyle = g; ctx.fillRect(scan - 40, 0, 46, H);
    }
    if (rev > 0.55 || this.mode !== 'reveal') {
      const a = this.mode === 'reveal' ? clamp((rev - 0.55) * 3, 0, 1) : 1;
      ctx.globalAlpha = a;
      this.drawCoins(ctx); this.drawGoal(ctx);
      ctx.globalAlpha = 1;
    }
    if (this.mode === 'edit' && !opts.card) this.drawEditOverlay(ctx);
    this.drawParts(ctx, false);
    if (opts.player && this.mode !== 'reveal' && this.mode !== 'edit' && this.alive) this.drawPlayer(ctx);
    if (opts.card) this.drawStartMarker(ctx);
    this.drawParts(ctx, true);
  }

  drawCoins(ctx) {
    const t = this.t;
    this.level.coins.forEach((c, i) => {
      if (this.taken.has(i)) return;
      const x = c.x * CELL + 4, y = c.y * CELL + 4 + Math.sin(t * 3 + i) * 1.3;
      ctx.save(); ctx.translate(x, y);
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 11);
      g.addColorStop(0, 'rgba(255,215,90,0.55)'); g.addColorStop(1, 'rgba(255,160,60,0)');
      ctx.fillStyle = g; ctx.fillRect(-11, -11, 22, 22);
      ctx.globalCompositeOperation = 'source-over';
      ctx.scale(Math.max(0.18, Math.abs(Math.cos(t * 2.6 + i * 0.7))), 1);
      star(ctx, 0, 0, 4.6, 2.1);
      const sg = ctx.createLinearGradient(0, -5, 0, 5); sg.addColorStop(0, '#fff7cf'); sg.addColorStop(0.5, '#ffd24d'); sg.addColorStop(1, '#ff9f2e');
      ctx.fillStyle = sg; ctx.fill();
      ctx.lineWidth = 0.6; ctx.strokeStyle = 'rgba(120,50,0,0.6)'; ctx.stroke();
      ctx.restore();
    });
  }

  drawGoal(ctx) {
    const g = this.level.goal, t = this.t;
    const x = g.x * CELL + 4, base = (g.y + 1) * CELL;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const beam = ctx.createLinearGradient(0, base - 260, 0, base);
    beam.addColorStop(0, 'rgba(200,255,90,0)'); beam.addColorStop(1, `rgba(200,255,90,${0.22 + 0.08 * Math.sin(t * 3)})`);
    ctx.fillStyle = beam; ctx.fillRect(x - 9, base - 260, 18, 260);
    const halo = ctx.createRadialGradient(x, base - 16, 0, x, base - 16, 34);
    halo.addColorStop(0, 'rgba(200,255,90,0.4)'); halo.addColorStop(1, 'rgba(200,255,90,0)');
    ctx.fillStyle = halo; ctx.fillRect(x - 34, base - 50, 68, 68);
    ctx.restore();
    ctx.fillStyle = '#f4f1ff'; ctx.fillRect(x - 0.8, base - 30, 1.6, 30);
    ctx.beginPath(); ctx.arc(x, base - 30.5, 1.8, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + 0.8, base - 29);
    const N = 8;
    for (let i = 0; i <= N; i++) { const u = i / N; ctx.lineTo(x + 0.8 + u * 15, base - 29 + Math.sin(t * 6 - u * 4) * 1.6 * u + u * 1); }
    for (let i = N; i >= 0; i--) { const u = i / N; ctx.lineTo(x + 0.8 + u * 15, base - 20 + Math.sin(t * 6 - u * 4) * 1.6 * u - u * 1); }
    ctx.closePath();
    const fg = ctx.createLinearGradient(x, 0, x + 16, 0); fg.addColorStop(0, '#c8ff5a'); fg.addColorStop(1, '#5ef2ff');
    ctx.fillStyle = fg; ctx.fill();
  }

  drawStartMarker(ctx) {
    const s = this.level.start;
    const x = s.x * CELL + 4, y = (s.y + 1) * CELL;
    ctx.save(); ctx.translate(x, y); this.drawCharacter(ctx, 1, 1, 1, 0); ctx.restore();
  }

  drawPlayer(ctx) {
    const a = this.acc / P.DT;
    const b = this.body;
    const x = lerp(this.prev.x, b.x, a) + P.W / 2, y = lerp(this.prev.y, b.y, a) + P.H + this.stepOff;
    ctx.save(); ctx.translate(x, y);
    this.drawCharacter(ctx, this.sq.x, this.sq.y, b.facing, b.vx);
    ctx.restore();
  }

  drawCharacter(ctx, sx, sy, facing, vx) {
    const t = this.t;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const halo = ctx.createRadialGradient(0, -7, 0, 0, -7, 18);
    halo.addColorStop(0, 'rgba(255,200,230,0.35)'); halo.addColorStop(1, 'rgba(255,200,230,0)');
    ctx.fillStyle = halo; ctx.fillRect(-18, -25, 36, 36);
    ctx.restore();
    ctx.save();
    ctx.scale(sx, sy);
    // feet
    const run = Math.abs(vx) > 30 && this.body.grounded;
    const f1 = run ? Math.sin(this.runPhase) * 2.2 : 0;
    ctx.fillStyle = '#2a1640';
    ctx.beginPath(); ctx.ellipse(-3 + f1, -0.9, 2.3, 1.3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(3 - f1, -0.9, 2.3, 1.3, 0, 0, Math.PI * 2); ctx.fill();
    // sprout
    const sway = clamp(-vx / 60, -3, 3) + Math.sin(t * 3) * 0.6;
    ctx.strokeStyle = '#7ad64a'; ctx.lineWidth = 1.1; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0, -13.5); ctx.quadraticCurveTo(sway * 0.3, -16.5, sway, -18); ctx.stroke();
    ctx.fillStyle = '#c8ff5a';
    ctx.beginPath(); ctx.ellipse(sway + 1.8, -18.4, 2.4, 1.2, -0.5, 0, Math.PI * 2); ctx.fill();
    // body
    const bg = ctx.createLinearGradient(0, -14, 0, 0);
    bg.addColorStop(0, '#fffaf0'); bg.addColorStop(1, '#ffbfa0');
    ctx.fillStyle = bg;
    roundRect(ctx, -6.6, -14, 13.2, 13, 5.2); ctx.fill();
    ctx.lineWidth = 0.7; ctx.strokeStyle = 'rgba(60,20,70,0.55)'; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.7)'; roundRect(ctx, -4.8, -12.8, 4, 1.6, 0.8); ctx.fill();
    // face
    const lx = facing * 1.5 + clamp(vx / 160, -0.6, 0.6);
    const bl = this.blink < 0 ? 0.15 : 1;
    ctx.fillStyle = '#1b0f2e';
    ctx.beginPath(); ctx.ellipse(-2.4 + lx, -7.6, 1.15, 1.8 * bl, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(2.4 + lx, -7.6, 1.15, 1.8 * bl, 0, 0, Math.PI * 2); ctx.fill();
    if (bl === 1) { ctx.fillStyle = '#fff'; ctx.fillRect(-2.7 + lx, -8.7, 0.7, 0.7); ctx.fillRect(2.1 + lx, -8.7, 0.7, 0.7); }
    ctx.fillStyle = 'rgba(255,90,140,0.55)';
    ctx.beginPath(); ctx.ellipse(-4.2 + lx, -4.9, 1.4, 0.8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(4.2 + lx, -4.9, 1.4, 0.8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#1b0f2e'; ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.arc(lx, -5.3, 0.9, 0.2, Math.PI - 0.2); ctx.stroke();
    ctx.restore();
  }

  drawParts(ctx, top) {
    for (const p of this.parts) {
      const a = clamp(p.life / p.max, 0, 1);
      if (p.kind === 'dust' && !top) { ctx.fillStyle = `rgba(230,220,255,${a * 0.55})`; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1.6 - a * 0.6), 0, Math.PI * 2); ctx.fill(); }
      if (!top) continue;
      if (p.kind === 'spark') { ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = a; ctx.fillStyle = p.c; ctx.translate(p.x, p.y); ctx.rotate(p.rot + this.t * 4); star(ctx, 0, 0, p.r * 1.6, p.r * 0.6); ctx.fill(); ctx.restore(); }
      if (p.kind === 'chunk') { ctx.globalAlpha = a; ctx.fillStyle = p.c; ctx.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2); ctx.globalAlpha = 1; }
      if (p.kind === 'ring') { const u = 1 - a; ctx.strokeStyle = `rgba(255,230,140,${a})`; ctx.lineWidth = 1.4 * a + 0.2; ctx.beginPath(); ctx.arc(p.x, p.y, 3 + u * 14, 0, Math.PI * 2); ctx.stroke(); }
      if (p.kind === 'text') { ctx.globalAlpha = a; ctx.fillStyle = '#fff3b0'; ctx.font = '700 7px "Unbounded", sans-serif'; ctx.textAlign = 'center'; ctx.fillText(p.text, p.x, p.y); ctx.globalAlpha = 1; }
    }
  }

  drawEditOverlay(ctx) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let c = 0; c <= this.level.cols; c += 2) { ctx.moveTo(c * CELL, 0); ctx.lineTo(c * CELL, this.worldH); }
    for (let r = 0; r <= this.level.rows; r += 2) { ctx.moveTo(0, r * CELL); ctx.lineTo(this.worldW, r * CELL); }
    ctx.stroke();
    this.drawStartMarker(ctx);
    if (this.brush) {
      const { x, y, r, erase } = this.brush;
      ctx.strokeStyle = erase ? '#ff4f8b' : '#5ef2ff'; ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.strokeRect((x - r) * CELL, (y - r) * CELL, (2 * r + 1) * CELL, (2 * r + 1) * CELL);
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  drawScreenFx(ctx) {
    for (const c of this.confetti) {
      ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.rot);
      ctx.globalAlpha = clamp(c.life, 0, 1);
      ctx.fillStyle = c.c; ctx.fillRect(-c.w / 2, -c.h / 2 * Math.abs(Math.cos(c.rot * 1.3)), c.w, c.h * Math.abs(Math.cos(c.rot * 1.3)) + 0.5);
      ctx.restore();
    }
    // goal compass when off-screen
    if ((this.mode === 'play' || this.mode === 'demo') && !this.won) {
      const g = this.level.goal;
      const sx = (g.x * CELL + 4 - this.cam.x) * this.cam.z + this.vw / 2, sy = ((g.y + 1) * CELL - 16 - this.cam.y) * this.cam.z + this.vh / 2;
      const m = 34;
      if (sx < 0 || sx > this.vw || sy < 0 || sy > this.vh) {
        const cx = this.vw / 2, cy = this.vh / 2, dx = sx - cx, dy = sy - cy;
        const k = Math.min((this.vw / 2 - m) / Math.abs(dx || 1e-3), (this.vh / 2 - m) / Math.abs(dy || 1e-3));
        const px = cx + dx * k, py = cy + dy * k, ang = Math.atan2(dy, dx);
        ctx.save(); ctx.translate(px, py);
        ctx.globalAlpha = 0.75 + 0.25 * Math.sin(this.t * 4);
        ctx.fillStyle = 'rgba(12,10,26,0.6)'; ctx.beginPath(); ctx.arc(0, 0, 15, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(200,255,90,0.6)'; ctx.lineWidth = 1; ctx.stroke();
        ctx.rotate(ang); ctx.fillStyle = '#c8ff5a';
        ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-4, -5.5); ctx.lineTo(-1.5, 0); ctx.lineTo(-4, 5.5); ctx.closePath(); ctx.fill();
        ctx.restore();
      }
    }
  }

  // ---------- editing ----------
  screenToCell(px, py) {
    const wx = (px - this.vw / 2) / this.cam.z + this.cam.x, wy = (py - this.vh / 2) / this.cam.z + this.cam.y;
    return { x: Math.floor(wx / CELL), y: Math.floor(wy / CELL) };
  }
  paint(cx, cy, r, erase) {
    const L = this.level; let changed = false;
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= L.cols || y >= L.rows) continue;
      const i = y * L.cols + x;
      const v = erase ? T.EMPTY : T.SOLID;
      if (L.tiles[i] !== v) { L.tiles[i] = v; changed = true; }
    }
    if (changed) { this.rebuildLayers(); }
    return changed;
  }

  // ---------- card ----------
  renderCard(w, h) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d');
    const z = Math.min(w / this.worldW, h / this.worldH);
    const savedMode = this.mode; const savedParts = this.parts; this.parts = [];
    x.setTransform(z, 0, 0, z, (w - this.worldW * z) / 2, (h - this.worldH * z) / 2);
    const savedTaken = this.taken; this.taken = new Set();
    this.drawWorld(x, { card: true });
    this.taken = savedTaken; this.parts = savedParts; this.mode = savedMode;
    return c;
  }
}

function star(ctx, x, y, R, r) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r : R;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
}
function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
