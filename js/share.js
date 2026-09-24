// Zero-backend sharing: the whole level + a tiny thumbnail live in the URL hash.
const MAGIC = 0x4c53; // "LS"

async function deflate(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function inflate(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
function b64url(bytes) {
  let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function encodeLevel(level, thumbBytes, timeMs, label) {
  const { cols, rows, tiles, start, goal, coins, bridges } = level;
  const lab = new TextEncoder().encode((label || '').slice(0, 40));
  const packed = new Uint8Array(Math.ceil(tiles.length / 4));
  for (let i = 0; i < tiles.length; i++) packed[i >> 2] |= (tiles[i] & 3) << ((i & 3) * 2);
  const size = 2 + 1 + 4 + 8 + 4 + 1 + lab.length + 2 + coins.length * 4 + 2 + bridges.length * 6 + packed.length + 4 + thumbBytes.length;
  const buf = new Uint8Array(size), dv = new DataView(buf.buffer);
  let o = 0;
  const u8 = v => { dv.setUint8(o, v); o += 1; }, u16 = v => { dv.setUint16(o, v); o += 2; }, u32 = v => { dv.setUint32(o, v); o += 4; };
  u16(MAGIC); u8(1); u16(cols); u16(rows); u16(start.x); u16(start.y); u16(goal.x); u16(goal.y); u32(Math.round(timeMs || 0));
  u8(lab.length); buf.set(lab, o); o += lab.length;
  u16(coins.length); for (const c of coins) { u16(c.x); u16(c.y); }
  u16(bridges.length); for (const b of bridges) { u16(b.x0); u16(b.x1); u16(b.y); }
  buf.set(packed, o); o += packed.length;
  u32(thumbBytes.length); buf.set(thumbBytes, o); o += thumbBytes.length;
  return 'L1' + b64url(await deflate(buf));
}

export async function decodeLevel(str) {
  if (!str.startsWith('L1')) throw new Error('not a level');
  const buf = await inflate(unb64url(str.slice(2)));
  const dv = new DataView(buf.buffer);
  let o = 0;
  const u8 = () => dv.getUint8(o++), u16 = () => { const v = dv.getUint16(o); o += 2; return v; }, u32 = () => { const v = dv.getUint32(o); o += 4; return v; };
  if (u16() !== MAGIC || u8() !== 1) throw new Error('bad level');
  const cols = u16(), rows = u16();
  const start = { x: u16(), y: u16() }, goal = { x: u16(), y: u16() }, timeMs = u32();
  const ll = u8(); const label = new TextDecoder().decode(buf.subarray(o, o + ll)); o += ll;
  const coins = []; for (let n = u16(), i = 0; i < n; i++) coins.push({ x: u16(), y: u16() });
  const bridges = []; for (let n = u16(), i = 0; i < n; i++) bridges.push({ x0: u16(), x1: u16(), y: u16() });
  const tiles = new Uint8Array(cols * rows);
  const plen = Math.ceil(tiles.length / 4);
  for (let i = 0; i < tiles.length; i++) tiles[i] = (buf[o + (i >> 2)] >> ((i & 3) * 2)) & 3;
  o += plen;
  const tl = u32(); const thumb = buf.slice(o, o + tl);
  return { level: { cols, rows, tiles, start, goal, coins, bridges }, thumb, timeMs, label };
}

export function levelHash(level) {
  let h = 2166136261 >>> 0;
  const mix = v => { h ^= v; h = Math.imul(h, 16777619) >>> 0; };
  mix(level.cols); mix(level.rows); mix(level.goal.x); mix(level.goal.y);
  for (let i = 0; i < level.tiles.length; i++) mix(level.tiles[i]);
  return h.toString(36);
}
