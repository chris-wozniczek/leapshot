import { Game } from './game.js';
import { ART, cropTo, levelDims, stylise } from './art.js';
import { CELL } from './physics.js';
import { audioInit, audioStream, isMuted, setMuted, sfx } from './audio.js';
import { encodeLevel, decodeLevel, levelHash } from './share.js';

const SAMPLES = [
  { id: 'city', name: 'Night city', label: 'a night city', credit: '“Château Frontenac illuminated at night” by Wilfredor', lic: 'CC0', url: 'https://commons.wikimedia.org/wiki/File:Chateau_Frontenac_illuminated_at_night_in_Quebec_City.jpg' },
  { id: 'desk', name: 'Messy desk', label: 'a messy desk', credit: '“Messy translator desk with mini neko” by Arria Belli', lic: 'Public domain', url: 'https://commons.wikimedia.org/wiki/File:Messy_translator_desk_with_mini_neko.jpg' },
  { id: 'cat', name: 'Cat', label: 'Larry the cat', credit: '“Larry the cat sitting on a bed” by Trougnouf (Benoit Brummer)', lic: 'CC BY 4.0', url: 'https://commons.wikimedia.org/wiki/File:Larry_the_cat_sitting_on_a_bed_(DSC_0010).jpg' },
  { id: 'mountains', name: 'Mountains', label: 'the Caucasus', credit: '“Zagedan Lakes, Mountain cirque” by Vyacheslav Argenberg', lic: 'CC BY 4.0', url: 'https://commons.wikimedia.org/wiki/File:Zagedan_Lakes,_Mountain_cirque,_Caucasus_Mountains.jpg' },
];

const $ = s => document.querySelector(s);
const vp = $('#viewport'), canvas = $('#game');
const state = { src: null, level: null, tool: 'play', challenge: null, lastTime: 0, genId: 0, reachedGoal: true, recording: null };

// ---------- worker ----------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
let reqId = 0;
worker.onmessage = e => { const p = pending.get(e.data.id); if (p) { pending.delete(e.data.id); p(e.data); } };
worker.onerror = e => { console.error(e); toast('The level generator failed to start in this browser.'); };
function ask(msg, transfer) { const id = ++reqId; return new Promise(res => { pending.set(id, res); worker.postMessage({ ...msg, id }, transfer || []); }); }

// ---------- game ----------
const game = new Game(canvas, {
  onCoin(n, total, quiet) { $('#coinCount').textContent = `${n}/${total}`; if (n && !quiet) bump($('.pill.coins')); },
  onMode(m) { setModeChip(m); },
  onStart() { hint('', 0); },
  onDeath(d) { if (d === 3) hint('Too spicy? Slide <b>Terrain</b> toward Sparse for an easier level.', 4200); },
  onWin(r) { showWin(r); },
});

// ---------- photo pipeline ----------
async function loadSample(s, opts) {
  const img = new Image(); img.decoding = 'async'; img.src = `assets/samples/${s.id}.jpg`;
  await img.decode();
  state.challenge = null; $('#banner').hidden = true;
  await usePhoto(img, { label: s.label, sample: s }, opts);
}

async function usePhoto(src, meta, { reveal = true } = {}) {
  busy(true, 'Reading your photo…');
  const { cols, rows } = levelDims(src.width, src.height);
  const raw = cropTo(src, cols, rows, cols * CELL * ART, rows * CELL * ART);
  const an = cropTo(src, cols, rows, cols * 4, rows * 4);
  const rgba = an.getContext('2d').getImageData(0, 0, an.width, an.height).data;
  const tw = 200, th = Math.round(tw * rows / cols);
  const thumbC = cropTo(src, cols, rows, tw, th);
  const thumbBytes = await canvasBytes(thumbC, 'image/webp', 0.62);
  const id = ++state.genId;
  busy(true, 'Tracing edges & solving…');
  const res = await ask({ rgba, cols, rows, sensitivity: sens(), seed: 7 }, [rgba.buffer]);
  if (id !== state.genId) return;
  const art = stylise(raw, res.edges, res.ew, res.eh);
  state.src = { raw, art, meta, thumbBytes };
  applyLevel(res.level, { reveal });
  busy(false);
  markSample(meta.sample);
}

function applyLevel(level, opts) {
  state.level = level;
  state.reachedGoal = true;
  game.setLevel(level, state.src.art, state.src.raw, opts);
  solverStatus(level);
  refreshBest();
  $('#win').hidden = true;
  if (opts.reveal) hint('Any key or tap takes control. The autopilot proves it’s beatable.', 5200, 1800);
}

let regenTimer = 0;
async function regenerate() {
  if (!state.src) return;
  const id = ++state.genId;
  $('#solver').className = 'solver busy'; $('#solverText').textContent = 'Regenerating…';
  const res = await ask({ sensitivity: sens(), seed: 7 });
  if (id !== state.genId) return;
  state.challenge = null; $('#banner').hidden = true;
  applyLevel(res.level, { keepMode: true });
}

function sens() { return +$('#density').value / 100; }

function solverStatus(l) {
  const el = $('#solver');
  const b = (l.bridges || []).length;
  el.className = 'solver';
  const t = (l.ghost.length / 5 / 60).toFixed(1);
  $('#solverText').innerHTML = `Beatable · autopilot clears it in <b>${t}s</b>` + (b ? ` · ${b} bridge${b > 1 ? 's' : ''} added` : '');
}

// ---------- shared levels ----------
async function loadShared(code) {
  busy(true, 'Unpacking shared level…');
  const d = await decodeLevel(code);
  const blob = new Blob([d.thumb], { type: 'image/webp' });
  const bmp = await createImageBitmap(blob);
  const { cols, rows } = d.level;
  const raw = cropTo(bmp, cols, rows, cols * CELL * ART, rows * CELL * ART);
  const an = cropTo(bmp, cols, rows, cols * 4, rows * 4);
  const rgba = an.getContext('2d').getImageData(0, 0, an.width, an.height).data;
  const e = await ask({ rgba, cols, rows, edgesOnly: true }, [rgba.buffer]);
  const art = stylise(raw, e.edges, e.ew, e.eh);
  const sol = await ask({ type: 'solve', cols, rows, tiles: d.level.tiles, start: d.level.start, goal: d.level.goal, bridges: d.level.bridges, fix: true });
  const level = { ...d.level, tiles: sol.solved.tiles, goal: sol.solved.goal, bridges: sol.solved.bridges, ghost: sol.solved.ghost };
  state.src = { raw, art, meta: { label: d.label || 'a photo' }, thumbBytes: d.thumb };
  state.challenge = d.timeMs ? d.timeMs / 1000 : null;
  applyLevel(level, { reveal: true });
  busy(false);
  markSample(null);
  const bn = $('#banner');
  bn.innerHTML = state.challenge ? `Challenge: beat <b>${fmt(state.challenge)}</b> on ${esc(d.label || 'this photo')}` : `Shared level: ${esc(d.label || 'a photo')}`;
  bn.hidden = false;
  $('#credit').textContent = 'Shared level, rebuilt from a thumbnail carried inside the link.';
}

// ---------- UI: samples ----------
function buildSamples() {
  const wrap = $('#samples');
  for (const s of SAMPLES) {
    const b = document.createElement('button');
    b.className = 'sample'; b.dataset.id = s.id; b.title = s.name;
    b.innerHTML = `<img src="assets/samples/${s.id}_thumb.jpg" alt="${s.name}" loading="lazy"><span>${s.name}</span>`;
    b.onclick = () => { audioInit(); sfx.click(); loadSample(s); };
    wrap.appendChild(b);
  }
}
function markSample(s) {
  document.querySelectorAll('.sample').forEach(b => b.classList.toggle('on', !!s && b.dataset.id === s.id));
  if (s) $('#credit').innerHTML = `Photo: <a href="${s.url}" target="_blank" rel="noopener">${s.credit}</a>, ${s.lic}, via Wikimedia Commons.`;
  else if (state.src && state.src.meta.label !== 'a photo') $('#credit').textContent = 'Your photo. It stays on this device.';
}

// ---------- intake: file, drop, paste, webcam ----------
$('#snapBtn').onclick = () => { audioInit(); $('#fileIn').click(); };
$('#fileIn').onchange = e => { const f = e.target.files[0]; if (f) useFile(f); e.target.value = ''; };
async function useFile(f) {
  if (!f.type.startsWith('image/')) { toast('That’s not an image. Try a JPG, PNG or WebP.'); return; }
  try {
    const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
    state.challenge = null; $('#banner').hidden = true;
    await usePhoto(bmp, { label: 'my photo' });
    $('#credit').textContent = 'Your photo. It stays on this device.';
    if (game.mode !== 'edit') setTool('play');
  } catch (err) { console.error(err); busy(false); toast('Couldn’t read that image. Try another one.'); }
}
let dragDepth = 0;
window.addEventListener('dragenter', e => { if (hasFiles(e)) { dragDepth++; $('#drop').classList.add('on'); e.preventDefault(); } });
window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop').classList.remove('on'); });
window.addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; $('#drop').classList.remove('on');
  const f = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith('image/'));
  if (f) { audioInit(); useFile(f); } else toast('Drop an image file to turn it into a level.');
});
function hasFiles(e) { return [...(e.dataTransfer?.types || [])].includes('Files'); }
window.addEventListener('paste', e => {
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (item) { e.preventDefault(); audioInit(); useFile(item.getAsFile()); toast('Pasted! Building your level…'); }
});

let camStream = null;
$('#camBtn').onclick = async () => {
  audioInit(); sfx.click();
  openModal('#cam');
  const msg = $('#camMsg'), v = $('#camVideo');
  msg.textContent = 'Starting camera…';
  if (!navigator.mediaDevices?.getUserMedia) { msg.textContent = 'Camera isn’t available in this browser. Use “Snap a photo” to upload instead.'; return; }
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 960 }, facingMode: 'user' }, audio: false });
    v.srcObject = camStream; await v.play(); msg.textContent = '';
  } catch (err) {
    msg.textContent = err.name === 'NotAllowedError' ? 'Camera permission was denied. You can still upload, drop or paste a photo.' : 'No camera found. You can still upload, drop or paste a photo.';
  }
};
$('#shutter').onclick = async () => {
  const v = $('#camVideo');
  if (!camStream || !v.videoWidth) return;
  const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
  const x = c.getContext('2d'); x.translate(c.width, 0); x.scale(-1, 1); x.drawImage(v, 0, 0);
  const f = document.createElement('div'); f.className = 'flash'; $('.cam-view').appendChild(f); setTimeout(() => f.remove(), 500);
  sfx.click();
  await new Promise(r => setTimeout(r, 220));
  closeModal('#cam');
  state.challenge = null; $('#banner').hidden = true;
  await usePhoto(c, { label: 'a webcam snap' });
  $('#credit').textContent = 'Your snapshot. It stays on this device.';
};
function stopCam() { if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; } }

// ---------- modals ----------
function openModal(sel) { $(sel).hidden = false; }
function closeModal(sel) { $(sel).hidden = true; if (sel === '#cam') stopCam(); if (sel === '#help') localStorage.setItem('leapshot:seenHelp', '1'); }
document.querySelectorAll('.modal').forEach(m => {
  m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-close]')) { closeModal('#' + m.id); audioInit(); } });
});
$('#helpBtn').onclick = () => { sfx.click(); openModal('#help'); };
const anyModal = () => [...document.querySelectorAll('.modal')].some(m => !m.hidden);

// ---------- tools ----------
document.querySelectorAll('#tools button').forEach((b, i) => b.onclick = () => { audioInit(); sfx.click(); setTool(b.dataset.tool); });
async function setTool(t) {
  const prev = state.tool; state.tool = t;
  const btns = [...document.querySelectorAll('#tools button')];
  btns.forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  $('.seg-ind').style.transform = `translateX(${btns.findIndex(b => b.dataset.tool === t) * 100}%)`;
  vp.classList.toggle('editing', t !== 'play');
  $('#toolHint').innerHTML = t === 'play' ? 'Arrow keys / WASD to run, Space to jump. Hold for higher.' : t === 'draw' ? 'Drag on the level to paint solid blocks. Right-click erases.' : 'Drag to erase platforms and spikes.';
  if (t !== 'play') { if (game.mode !== 'edit') game.edit(true); hint('Level paused. Paint freely; the solver re-checks every stroke.', 3500); }
  else if (prev !== 'play') {
    if (!state.reachedGoal) await fixLevel();
    game.edit(false); game.snapCameraToPlayer();
  }
}
async function fixLevel() {
  const L = state.level;
  const r = await ask({ type: 'solve', cols: L.cols, rows: L.rows, tiles: L.tiles, start: L.start, goal: L.goal, bridges: L.bridges, fix: true });
  Object.assign(L, { tiles: r.solved.tiles, goal: r.solved.goal, bridges: r.solved.bridges, ghost: r.solved.ghost });
  game.setLevel(L, state.src.art, state.src.raw, { keepMode: true });
  state.reachedGoal = true;
  if (r.solved.fixes) toast(`Added ${r.solved.fixes} bridge${r.solved.fixes > 1 ? 's' : ''} so it’s still beatable.`);
  solverStatus(L);
}
let painting = null;
canvas.addEventListener('contextmenu', e => { if (state.tool !== 'play') e.preventDefault(); });
canvas.addEventListener('pointerdown', e => {
  audioInit();
  if (state.tool === 'play') { if (game.mode === 'demo') game.play(); return; }
  painting = { erase: state.tool === 'erase' || e.button === 2 };
  canvas.setPointerCapture(e.pointerId);
  paintAt(e);
});
canvas.addEventListener('pointermove', e => {
  if (state.tool === 'play') { game.brush = null; return; }
  const r = canvas.getBoundingClientRect(); const c = game.screenToCell(e.clientX - r.left, e.clientY - r.top);
  game.brush = { ...c, r: 1, erase: painting ? painting.erase : state.tool === 'erase' };
  if (painting) paintAt(e);
});
canvas.addEventListener('pointerleave', () => { if (!painting) game.brush = null; });
canvas.addEventListener('pointerup', async () => {
  if (!painting) return; painting = null;
  const L = state.level;
  $('#solver').className = 'solver busy'; $('#solverText').textContent = 'Checking your edit…';
  const r = await ask({ type: 'solve', cols: L.cols, rows: L.rows, tiles: L.tiles.slice(), start: L.start, goal: L.goal, bridges: L.bridges, fix: false });
  state.reachedGoal = r.solved.reachedGoal;
  if (r.solved.reachedGoal) { L.ghost = r.solved.ghost; solverStatus(L); }
  else { $('#solver').className = 'solver warn'; $('#solverText').textContent = 'Goal unreachable. Switching to Play will auto-bridge.'; }
});
let lastPaint = 0;
function paintAt(e) {
  const r = canvas.getBoundingClientRect(); const c = game.screenToCell(e.clientX - r.left, e.clientY - r.top);
  const L = state.level;
  if (Math.abs(c.x - L.start.x) <= 2 && c.y >= L.start.y - 2 && c.y <= L.start.y) return;
  if (game.paint(c.x, c.y, 1, painting.erase)) { const now = performance.now(); if (now - lastPaint > 60) { sfx.paint(); lastPaint = now; } }
}

// ---------- density ----------
const dens = $('#density');
function densUI() { const v = +dens.value; dens.style.setProperty('--p', v + '%'); $('#densVal').textContent = v < 25 ? 'Sparse' : v < 62 ? 'Balanced' : 'Dense'; }
dens.addEventListener('input', () => { densUI(); clearTimeout(regenTimer); regenTimer = setTimeout(regenerate, 110); });
densUI();

// ---------- keyboard + touch ----------
const KEYMAP = { ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', Space: 'jump', ArrowUp: 'jump', KeyW: 'jump', KeyZ: 'jump', KeyK: 'jump' };
window.addEventListener('keydown', e => {
  if (e.target.closest && e.target.closest('input,textarea')) { if (e.code !== 'Space') return; }
  if (e.key === 'Escape') { document.querySelectorAll('.modal').forEach(m => !m.hidden && closeModal('#' + m.id)); return; }
  if (anyModal()) { if (e.code === 'Enter' && !$('#help').hidden) closeModal('#help'); return; }
  if (e.key === '?' || (e.code === 'Slash' && e.shiftKey)) { openModal('#help'); return; }
  if (e.code === 'KeyM') { toggleMute(); return; }
  const k = KEYMAP[e.code];
  if (e.code === 'KeyR') { e.preventDefault(); again(); return; }
  if (!k) return;
  e.preventDefault();
  audioInit();
  if (state.tool !== 'play') setTool('play');
  if (game.mode === 'demo') game.play();
  else if (game.mode === 'reveal') game.pendingPlay = true;
  if (!game.keys[k] && k === 'jump') game.pressJump();
  game.keys[k] = true;
});
window.addEventListener('keyup', e => { const k = KEYMAP[e.code]; if (k) game.keys[k] = false; });
window.addEventListener('blur', () => { game.keys.left = game.keys.right = game.keys.jump = false; });
document.querySelectorAll('#touch button').forEach(b => {
  const k = b.dataset.k;
  b.addEventListener('pointerdown', e => { e.preventDefault(); audioInit(); b.classList.add('down'); if (game.mode === 'demo') game.play(); if (k === 'jump') game.pressJump(); game.keys[k] = true; });
  const up = () => { b.classList.remove('down'); game.keys[k] = false; };
  b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('pointerleave', up);
});

function again() { $('#win').hidden = true; if (state.tool !== 'play') setTool('play'); game.restart(); game.snapCameraToPlayer(); }
$('#againBtn').onclick = () => { sfx.click(); again(); };

// ---------- mute ----------
function toggleMute() { setMuted(!isMuted()); $('#muteBtn').classList.toggle('muted', isMuted()); toast(isMuted() ? 'Sound off' : 'Sound on'); }
$('#muteBtn').onclick = () => { audioInit(); toggleMute(); };
$('#muteBtn').classList.toggle('muted', isMuted());

// ---------- win + best ----------
function bestKey() { return 'leapshot:best:' + levelHash(state.level); }
function refreshBest() { const b = +localStorage.getItem(bestKey()) || 0; $('#best').textContent = b ? fmt(b) : '—'; }
function showWin(r) {
  state.lastTime = r.time;
  const key = bestKey(); const prev = +localStorage.getItem(key) || 0;
  const isBest = !prev || r.time < prev;
  if (isBest) localStorage.setItem(key, r.time.toFixed(3));
  refreshBest();
  $('#winTime').textContent = fmt(r.time);
  $('#newBest').hidden = !isBest || !prev;
  $('#winCoins').textContent = `${r.coins}/${r.total}`;
  $('#winDeaths').textContent = r.deaths;
  const bm = $('#beatMsg');
  if (state.challenge) { bm.hidden = false; bm.textContent = r.time < state.challenge ? `You beat their ${fmt(state.challenge)}!` : `${fmt(r.time - state.challenge)} behind their ${fmt(state.challenge)}. Again?`; }
  else bm.hidden = true;
  setTimeout(() => { $('#win').hidden = false; }, 650);
  if (state.recording) setTimeout(stopRecording, 1800);
}

// ---------- share ----------
async function shareLink() {
  audioInit(); sfx.click();
  if (!state.level || !state.src) return;
  if (!('CompressionStream' in window)) { toast('Your browser can’t compress links. Try latest Chrome.'); return; }
  const best = +localStorage.getItem(bestKey()) || state.lastTime || 0;
  const code = await encodeLevel(state.level, state.src.thumbBytes, best * 1000, state.src.meta.label);
  const url = location.origin + location.pathname + '#' + code;
  try { await navigator.clipboard.writeText(url); toast(best ? `Link copied. Dare them to beat ${fmt(best)}.` : 'Link copied. The whole level lives in the URL.'); }
  catch { window.prompt('Copy this link:', url); }
}
$('#shareBtn').onclick = shareLink; $('#winShare').onclick = shareLink;

// ---------- export: card + recording ----------
async function saveCard() {
  audioInit(); sfx.click();
  await document.fonts.ready;
  const best = +localStorage.getItem(bestKey()) || 0;
  const c = composeCard(best, state.src.meta.label);
  c.toBlob(b => download(b, 'leapshot-level.png'), 'image/png');
  toast('Level card saved.');
}
function composeCard(best, label) {
  const W = 1200, H = 630;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#07060d'; x.fillRect(0, 0, W, H);
  const lv = game.renderCard(1600, Math.round(1600 * state.level.rows / state.level.cols));
  const s = Math.max(W / lv.width, H / lv.height) * 1.02;
  x.drawImage(lv, W - lv.width * s + 60, (H - lv.height * s) / 2, lv.width * s, lv.height * s);
  const g = x.createLinearGradient(0, 0, W * 0.75, 0);
  g.addColorStop(0, 'rgba(7,6,13,0.96)'); g.addColorStop(0.45, 'rgba(7,6,13,0.72)'); g.addColorStop(1, 'rgba(7,6,13,0)');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  // brand
  const lg = x.createLinearGradient(64, 64, 110, 110); lg.addColorStop(0, '#ff4f8b'); lg.addColorStop(1, '#ffb547');
  x.fillStyle = lg; x.beginPath(); x.roundRect(64, 62, 46, 46, 14); x.fill();
  x.strokeStyle = '#1a0b24'; x.lineWidth = 4; x.lineCap = 'round'; x.lineJoin = 'round';
  x.beginPath(); x.moveTo(73, 96); x.lineTo(82, 96); x.lineTo(87, 88); x.lineTo(92, 93); x.lineTo(101, 79); x.stroke();
  x.fillStyle = '#f4f1ff'; x.font = '800 30px Unbounded'; x.fillText('Leapshot', 126, 96);
  const tg = x.createLinearGradient(64, 0, 640, 0); tg.addColorStop(0, '#ff4f8b'); tg.addColorStop(1, '#ffb547');
  x.font = '800 76px Unbounded'; x.fillStyle = '#f4f1ff';
  if (best) { x.fillText('Beat my', 60, 270); x.fillStyle = tg; x.font = '800 96px "JetBrains Mono"'; x.fillText(fmt(best), 58, 378); }
  else { x.fillText('Snap anything.', 60, 270); x.fillStyle = tg; x.fillText('Play it.', 60, 360); }
  x.fillStyle = '#b9b2d6'; x.font = '500 28px Inter';
  x.fillText(best ? `on a level made from ${label || 'a photo'}.` : 'Any photo becomes a playable level.', 64, 440);
  x.fillStyle = '#6c6690'; x.font = '600 22px Inter';
  x.fillText('chris-wozniczek.github.io/leapshot', 64, 560);
  return c;
}
$('#cardBtn').onclick = saveCard; $('#winCard').onclick = saveCard;

function startRecording() {
  if (!canvas.captureStream || !window.MediaRecorder) { toast('Recording isn’t supported in this browser.'); return; }
  audioInit();
  const stream = canvas.captureStream(60);
  const a = audioStream(); if (a) a.getAudioTracks().forEach(t => stream.addTrack(t));
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8e6 });
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  rec.onstop = () => { download(new Blob(chunks, { type: 'video/webm' }), 'leapshot-run.webm'); toast('Run saved as WebM.'); };
  rec.start(250);
  state.recording = rec;
  $('#recBtn').classList.add('recording'); $('#recTxt').textContent = 'Stop'; $('#recDot').hidden = false;
  if (state.tool !== 'play') setTool('play');
  game.restart(); game.snapCameraToPlayer(); $('#win').hidden = true;
  toast('Recording. Finish the level to auto-save.');
}
function stopRecording() {
  const r = state.recording; if (!r) return;
  state.recording = null; r.stop();
  $('#recBtn').classList.remove('recording'); $('#recTxt').textContent = 'Record run'; $('#recDot').hidden = true;
}
$('#recBtn').onclick = () => { sfx.click(); state.recording ? stopRecording() : startRecording(); };

// ---------- helpers ----------
function fmt(t) { const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(2).padStart(5, '0')}`; }
function esc(s) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
function canvasBytes(c, type, q) { return new Promise(r => c.toBlob(async b => r(new Uint8Array(await b.arrayBuffer())), type, q)); }
let toastT = 0;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600); }
let hintT = 0, hintD = 0;
function hint(html, ms, delay = 0) {
  clearTimeout(hintT); clearTimeout(hintD);
  const h = $('#hint');
  if (!html) { h.classList.remove('show'); return; }
  hintD = setTimeout(() => { h.innerHTML = html; h.classList.add('show'); hintT = setTimeout(() => h.classList.remove('show'), ms); }, delay);
}
function bump(el) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
function busy(on, text) { $('#busy').hidden = !on; if (text) $('#busyText').textContent = text; }
function setModeChip(m) {
  const chip = $('#modeChip');
  chip.className = 'modechip ' + m;
  $('#modeText').textContent = { reveal: 'Building level…', demo: 'Autopilot demo · press any key', play: 'Your run', edit: 'Editing · paused', idle: '' }[m] || '';
  if (m === 'play' && !game.running) hint('Hold <kbd>Space</kbd> for a higher jump · glowing lines are jump-through', 3800);
}

// ---------- loop ----------
let last = performance.now(), lastTimer = '';
function loop(now) {
  const dt = (now - last) / 1000; last = now;
  game.frame(dt);
  const tt = fmt(game.time);
  if (tt !== lastTimer) { $('#timer').textContent = tt; lastTimer = tt; }
  requestAnimationFrame(loop);
}
new ResizeObserver(() => game.resize()).observe(vp);

// ---------- boot ----------
buildSamples();
requestAnimationFrame(loop);
(async () => {
  const code = location.hash.slice(1);
  try { if (code.startsWith('L1')) await loadShared(code); else await loadSample(SAMPLES[0]); }
  catch (err) { console.error(err); toast('That link looks broken. Loading a sample instead.'); await loadSample(SAMPLES[0]); }
  if (!localStorage.getItem('leapshot:seenHelp')) setTimeout(() => openModal('#help'), 2600);
})();
window.addEventListener('hashchange', () => { const c = location.hash.slice(1); if (c.startsWith('L1')) loadShared(c).catch(() => toast('That link looks broken.')); });
window.leapshot = { game, card: best => composeCard(best || 0, state.src && state.src.meta.label) };
