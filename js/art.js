// Visual layers: stylised photo (duotone + posterise + edge glow) and tile layers.
import { CELL, T } from './physics.js';

export const ART = 2; // art pixels per world pixel
const STOPS = [[0, [9, 6, 26]], [0.22, [36, 16, 84]], [0.45, [118, 38, 140]], [0.66, [230, 78, 122]], [0.84, [255, 170, 120]], [1, [255, 240, 214]]];
const LUT = (() => {
  const l = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255; let k = 0;
    while (k < STOPS.length - 2 && t > STOPS[k + 1][0]) k++;
    const [t0, c0] = STOPS[k], [t1, c1] = STOPS[k + 1];
    const u = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    for (let j = 0; j < 3; j++) l[i * 3 + j] = c0[j] + (c1[j] - c0[j]) * u;
  }
  return l;
})();

export function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

// Crop + scale a source image to the level's aspect.
export function cropTo(src, cols, rows, w, h) {
  const sw = src.width, sh = src.height, ar = cols / rows;
  let cw = sw, ch = sh, cx = 0, cy = 0;
  if (sw / sh > ar) { cw = sh * ar; cx = (sw - cw) / 2; } else { ch = sw / ar; cy = (sh - ch) / 2; }
  const c = makeCanvas(w, h), x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, cx, cy, cw, ch, 0, 0, w, h);
  return c;
}

export function levelDims(w, h) {
  const cols = 144;
  const rows = Math.max(64, Math.min(150, Math.round(cols * h / w)));
  return { cols, rows };
}

export function stylise(raw, edges, ew, eh) {
  const w = raw.width, h = raw.height;
  const out = makeCanvas(w, h), x = out.getContext('2d');
  x.drawImage(raw, 0, 0);
  const id = x.getImageData(0, 0, w, h), d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    let l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    l = Math.round(l * 6) / 6 * 0.7 + l * 0.3; // soft posterise
    const li = Math.max(0, Math.min(255, (l * 255) | 0)) * 3;
    d[i] = (LUT[li] * 0.72 + r * 0.28) * 0.82;
    d[i + 1] = (LUT[li + 1] * 0.72 + g * 0.28) * 0.82;
    d[i + 2] = (LUT[li + 2] * 0.72 + b * 0.28) * 0.86;
  }
  x.putImageData(id, 0, 0);
  if (edges) {
    const e = makeCanvas(ew, eh), ex = e.getContext('2d');
    const eid = ex.createImageData(ew, eh);
    for (let i = 0; i < edges.length; i++) {
      const v = edges[i], j = i * 4;
      eid.data[j] = 110; eid.data[j + 1] = 235; eid.data[j + 2] = 255; eid.data[j + 3] = Math.min(255, v * 0.9);
    }
    ex.putImageData(eid, 0, 0);
    x.save();
    x.globalCompositeOperation = 'screen';
    x.globalAlpha = 0.55; x.filter = 'blur(6px)'; x.drawImage(e, 0, 0, w, h);
    x.globalAlpha = 0.35; x.filter = 'none'; x.drawImage(e, 0, 0, w, h);
    x.restore();
  }
  // vignette to seat the level
  const g = x.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(4,2,12,0.55)');
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  return out;
}

// Tile layer: glass blocks with glowing top edges, luminous ledges, bridges.
export function renderTiles(level, into) {
  const { cols, rows, tiles } = level;
  const S = CELL * ART, w = cols * S, h = rows * S;
  const c = into && into.width === w && into.height === h ? into : makeCanvas(w, h);
  const x = c.getContext('2d');
  x.clearRect(0, 0, w, h);
  const at = (cc, r) => (cc < 0 || cc >= cols || r < 0 || r >= rows) ? 0 : tiles[r * cols + cc];
  const bridge = new Uint8Array(cols * rows);
  for (const b of level.bridges || []) for (let cc = b.x0; cc <= b.x1; cc++) if (cc >= 0 && cc < cols && b.y >= 0 && b.y < rows) bridge[b.y * cols + cc] = 1;
  // solid bodies
  x.fillStyle = 'rgba(12,8,30,0.62)';
  for (let r = 0; r < rows; r++) for (let cc = 0; cc < cols; cc++) if (at(cc, r) === T.SOLID) x.fillRect(cc * S, r * S, S, S);
  x.fillStyle = 'rgba(140,120,255,0.10)';
  for (let r = 0; r < rows; r++) for (let cc = 0; cc < cols; cc++) if (at(cc, r) === T.SOLID) x.fillRect(cc * S + 1, r * S + 1, S - 2, S - 2);
  // side rims
  x.fillStyle = 'rgba(120,230,255,0.35)';
  for (let r = 0; r < rows; r++) for (let cc = 0; cc < cols; cc++) if (at(cc, r) === T.SOLID) {
    if (at(cc - 1, r) !== T.SOLID) x.fillRect(cc * S, r * S, 2, S);
    if (at(cc + 1, r) !== T.SOLID) x.fillRect(cc * S + S - 2, r * S, 2, S);
    if (at(cc, r + 1) !== T.SOLID) x.fillRect(cc * S, r * S + S - 2, S, 2);
  }
  // top faces
  for (let r = 0; r < rows; r++) for (let cc = 0; cc < cols; cc++) {
    const t = at(cc, r);
    if (t === T.SOLID && at(cc, r - 1) !== T.SOLID) { x.fillStyle = '#9ff6ff'; x.fillRect(cc * S, r * S, S, 3); x.fillStyle = 'rgba(160,246,255,0.25)'; x.fillRect(cc * S, r * S + 3, S, 3); }
    if (t === T.LEDGE) {
      const br = bridge[r * cols + cc];
      const lg = x.createLinearGradient(0, r * S, 0, r * S + 7);
      if (br) { lg.addColorStop(0, '#f4ffcf'); lg.addColorStop(1, 'rgba(200,255,90,0.2)'); }
      else { lg.addColorStop(0, '#ffffff'); lg.addColorStop(1, 'rgba(120,230,255,0.15)'); }
      x.fillStyle = lg;
      const l = at(cc - 1, r) !== T.LEDGE, rr = at(cc + 1, r) !== T.LEDGE;
      roundRect(x, cc * S + (l ? 1 : 0), r * S, S - (l ? 1 : 0) - (rr ? 1 : 0), 7, l || rr ? 3 : 0);
      x.fill();
    }
  }
  return c;
}

export function renderGlow(tilesCanvas, into) {
  const c = into && into.width === tilesCanvas.width ? into : makeCanvas(tilesCanvas.width, tilesCanvas.height);
  const x = c.getContext('2d');
  x.clearRect(0, 0, c.width, c.height);
  x.filter = 'blur(7px)'; x.drawImage(tilesCanvas, 0, 0); x.filter = 'none';
  return c;
}

export function renderSpikes(level, into) {
  const { cols, rows, tiles } = level;
  const S = CELL * ART, w = cols * S, h = rows * S;
  const c = into && into.width === w && into.height === h ? into : makeCanvas(w, h);
  const x = c.getContext('2d');
  x.clearRect(0, 0, w, h);
  for (let r = 0; r < rows; r++) for (let cc = 0; cc < cols; cc++) if (tiles[r * cols + cc] === T.SPIKE) {
    const bx = cc * S, by = r * S + S;
    const g = x.createLinearGradient(0, by, 0, by - S);
    g.addColorStop(0, '#ff2d55'); g.addColorStop(0.6, '#ff7a3c'); g.addColorStop(1, '#ffe38a');
    x.fillStyle = g;
    x.beginPath();
    x.moveTo(bx + 1, by); x.lineTo(bx + S * 0.27, by - S * 0.72); x.lineTo(bx + S * 0.5, by - S * 0.18);
    x.lineTo(bx + S * 0.73, by - S * 0.85); x.lineTo(bx + S - 1, by); x.closePath(); x.fill();
  }
  return c;
}

export function roundRect(x, px, py, w, h, r) {
  x.beginPath();
  if (x.roundRect) x.roundRect(px, py, w, h, r); else x.rect(px, py, w, h);
}
