/* Silence Remover — 100% client-side.
 * Không có bất kỳ request upload nào.
 */

const $ = (id) => document.getElementById(id);

const LIB_ESM = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm';
const UTIL_ESM = 'https://unpkg.com/@ffmpeg/util@0.12.1/dist/esm/index.js';
const CORE_ST = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
const CORE_MT = 'https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/esm';
const WEBCODECS = './webcodecs.js?v=12';
const KEYFRAMES = './mp4keyframes.js?v=12';

const ANALYSIS_SR = 16000;

const state = {
  file: null,
  duration: 0,
  w: 0, h: 0,
  videoDecodable: true,
  envelope: null,
  audio: null,
  frameDur: 0.02,
  keep: [],
  cancel: false,
};

/* ---------------- 1. Nhận file ---------------- */
const drop = $('drop'), fileInput = $('file');
$('browse').onclick = () => fileInput.click();
drop.onclick = (e) => { if (e.target.tagName !== 'BUTTON') fileInput.click(); };
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) loadFile(f); });
fileInput.onchange = () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); };

const fmtSize = b => b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(1) + ' MB';
const fmtTime = s => {
  if (!isFinite(s) || s < 0) return '—';
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = (s % 60);
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + sec.toFixed(1).padStart(4, '0');
};
const withTimeout = (p, ms, label) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(label || ('quá ' + Math.round(ms / 1000) + ' giây'))), ms)),
]);

const video = $('video');

function loadFile(f) {
  state.file = f;
  state.keep = []; state.envelope = null; state.audio = null;
  state.w = 0; state.h = 0; state.videoDecodable = true;
  if (video.src) URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(f);
  $('fileInfo').classList.remove('hidden');
  $('fileInfo').textContent = '📄 ' + f.name + ' · ' + fmtSize(f.size);
  $('settingsCard').hidden = false;
  $('resultCard').hidden = true;
  $('exportCard').hidden = true;
  $('analyzeStatus').textContent = '';
  video.onloadedmetadata = () => {
    state.duration = video.duration;
    state.w = video.videoWidth; state.h = video.videoHeight;
    state.videoDecodable = !!(state.w && state.h);
    applySourceDefaults();
  };
}

let turboOk = false;
const engineRadio = (v) => document.querySelector('input[name=engine][value=' + v + ']');

function applySourceDefaults() {
  const info = $('srcInfo');
  const rTurbo = engineRadio('turbo'), rRec = engineRadio('recorder'), rCopy = engineRadio('copy');
  if (!info) return;

  if (state.file && state.duration && !state.videoDecodable) {
    if (rTurbo) rTurbo.disabled = true;
    if (rRec) rRec.disabled = true;
    if (rCopy) rCopy.checked = true;
    info.className = 'status err';
    info.textContent = '⚠️ Trình duyệt không giải mã được phần hình của tệp này (thường là H.265/HEVC). ' +
      'Turbo và MediaRecorder đều cần xem được hình nên đã bị tắt. ' +
      'Đã chọn sẵn chế độ Siêu tốc — chế độ này không giải mã hình nên chạy được và rất nhanh.';
    return;
  }

  if (rTurbo) rTurbo.disabled = !turboOk;
  if (rRec) rRec.disabled = false;
  if (!state.h) { info.textContent = ''; return; }

  const sc = $('scale');
  if (state.h > 1080 && sc.value === '0') sc.value = '1080';

  const heavy = state.h > 1440 || (state.w * state.h * state.duration) > 1080 * 1920 * 900;
  let msg = 'Nguồn: ' + state.w + '×' + state.h + ' · ' + fmtTime(state.duration);
  if (heavy) {
    msg += ' — tệp nặng. FFmpeg.wasm sẽ rất chậm vì giải mã bằng phần mềm; ' +
      'hãy dùng Siêu tốc' + (turboOk ? ' hoặc Turbo.' : '.');
    if (rCopy) rCopy.checked = true;
  }
  info.textContent = msg;
  info.className = heavy ? 'status err' : 'status';
}

/* ---------------- 2. Tham số ---------------- */
const bind = (id, out, fmt) => {
  const el = $(id);
  const upd = () => $(out).textContent = fmt(parseFloat(el.value));
  el.addEventListener('input', () => { upd(); if (state.envelope) { computeSegments(); render(); } });
  upd();
};
bind('threshold', 'thVal', v => v + ' dB');
bind('minSilence', 'minSilVal', v => v.toFixed(2) + ' s');
bind('padding', 'padVal', v => v.toFixed(2) + ' s');
bind('minKeep', 'minKeepVal', v => v.toFixed(2) + ' s');
$('crf').addEventListener('input', e => $('crfVal').textContent = e.target.value);

/* ---------------- 3. Phân tích âm thanh ---------------- */
$('analyze').onclick = analyze;

const logEl = $('log');
const log = (m) => { logEl.hidden = false; logEl.textContent += m + '\n'; logEl.scrollTop = logEl.scrollHeight; };

async function analyze() {
  const st = $('analyzeStatus');
  st.className = 'status';
  $('analyze').disabled = true;
  const t0 = performance.now();
  const tick = setInterval(() => {
    const el = (performance.now() - t0) / 1000;
    if (el > 3) st.textContent = st.textContent.replace(/ \u00b7 \d+s$/, '') + ' · ' + Math.round(el) + 's';
  }, 1000);

  try {
    let env = null;
    st.textContent = 'Đang giải mã âm thanh (cách nhanh)…';
    try {
      env = await withTimeout(decodeFast(), 150000, 'giải mã quá 150 giây');
    } catch (e) {
      log('Cách nhanh thất bại: ' + errText(e) + ' — chuyển sang trích âm thanh bằng FFmpeg…');
      st.textContent = 'Đang trích âm thanh bằng FFmpeg (bỏ qua phần hình)…';
      env = await decodeViaFfmpeg(st);
    }

    state.envelope = env;
    computeSegments();
    render();
    $('resultCard').hidden = false;
    $('exportCard').hidden = false;
    applySourceDefaults();
    await previewCopyPlan();
    st.textContent = '✅ Phân tích xong sau ' + ((performance.now() - t0) / 1000).toFixed(1) + ' giây.';
    $('resultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    console.error(e);
    st.className = 'status err';
    st.textContent = '❌ Không phân tích được âm thanh (' + errText(e) + ').';
  } finally {
    clearInterval(tick);
    $('analyze').disabled = false;
  }
}

async function decodeFast() {
  const buf = await state.file.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, ANALYSIS_SR);
  const audio = await ctx.decodeAudioData(buf);
  state.duration = Math.max(state.duration || 0, audio.duration);
  log('Giải mã nhanh OK · ' + audio.sampleRate + ' Hz · ' + fmtTime(audio.duration));
  return envelopeFromBuffer(audio);
}

async function decodeViaFfmpeg(st) {
  const ff = await getFFmpeg();
  const inName = 'input' + srcExt();
  st.textContent = 'Đang nạp tệp vào FFmpeg…';
  await ff.writeFile(inName, await ffUtil.fetchFile(state.file));
  st.textContent = 'Đang trích âm thanh (bỏ qua hình)…';
  await ff.exec([
    '-hide_banner', '-nostdin', '-i', inName,
    '-vn', '-sn', '-dn', '-map', '0:a:0',
    '-ac', '1', '-ar', String(ANALYSIS_SR),
    '-f', 's16le', '-acodec', 'pcm_s16le', 'audio.raw',
  ]);
  const data = await ff.readFile('audio.raw');
  try { await ff.deleteFile('audio.raw'); await ff.deleteFile(inName); } catch (_) {}
  if (!data || !data.length) throw new Error('không trích được luồng âm thanh nào');
  const pcm = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2));
  state.duration = Math.max(state.duration || 0, pcm.length / ANALYSIS_SR);
  log('Trích âm thanh OK · ' + fmtTime(pcm.length / ANALYSIS_SR));
  return envelopeFromMono(pcm, ANALYSIS_SR, state.frameDur, 1 / 32768);
}

function envelopeFromBuffer(audio) {
  const n = audio.length;
  const a = audio.getChannelData(0);
  if (audio.numberOfChannels === 1) return envelopeFromMono(a, audio.sampleRate, state.frameDur, 1);
  const b = audio.getChannelData(1);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = (a[i] + b[i]) * 0.5;
  return envelopeFromMono(mono, audio.sampleRate, state.frameDur, 1);
}

function envelopeFromMono(data, sr, frameDur, scale) {
  const frameLen = Math.max(1, Math.round(sr * frameDur));
  const n = Math.ceil(data.length / frameLen);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s0 = i * frameLen, s1 = Math.min(data.length, s0 + frameLen);
    let sum = 0;
    for (let s = s0; s < s1; s++) { const v = data[s] * scale; sum += v * v; }
    out[i] = 20 * Math.log10(Math.sqrt(sum / Math.max(1, s1 - s0)) + 1e-10);
  }
  return out;
}

function computeSegments() {
  const env = state.envelope; if (!env) return;
  const fd = state.frameDur;
  const th = parseFloat($('threshold').value);
  const minSil = parseFloat($('minSilence').value);
  const pad = parseFloat($('padding').value);
  const minKeep = parseFloat($('minKeep').value);
  const dur = state.duration || env.length * fd;

  const loud = new Uint8Array(env.length);
  for (let i = 0; i < env.length; i++) loud[i] = env[i] > th ? 1 : 0;

  const segs = [];
  let cur = null;
  for (let i = 0; i < loud.length; i++) {
    if (loud[i]) { if (!cur) cur = { start: i * fd, end: (i + 1) * fd }; else cur.end = (i + 1) * fd; }
    else if (cur) { segs.push(cur); cur = null; }
  }
  if (cur) segs.push(cur);

  const merged = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && s.start - last.end < minSil) last.end = s.end;
    else merged.push({ start: s.start, end: s.end });
  }

  const keep = [];
  for (const s of merged) {
    if (s.end - s.start < minKeep) continue;
    const a = Math.max(0, s.start - pad), b = Math.min(dur, s.end + pad);
    const last = keep[keep.length - 1];
    if (last && a <= last.end) last.end = Math.max(last.end, b);
    else keep.push({ start: a, end: b });
  }
  state.keep = keep;
}

/* ---------------- 4. Timeline ---------------- */
const cv = $('timeline');
function render() {
  const dur = state.duration || 1;
  const kept = state.keep.reduce((a, s) => a + (s.end - s.start), 0);
  const removed = Math.max(0, dur - kept);
  $('stats').innerHTML =
    '<div><b>' + fmtTime(dur) + '</b>Thời lượng gốc</div>' +
    '<div><b>' + fmtTime(kept) + '</b>Sau khi cắt</div>' +
    '<div><b>' + fmtTime(removed) + '</b>Đã loại bỏ (' + (removed / dur * 100).toFixed(1) + '%)</div>' +
    '<div><b>' + state.keep.length + '</b>Số đoạn giữ lại</div>';
  draw();
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = 90;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const dur = state.duration || 1;

  g.fillStyle = '#ff5c6c33'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#3ddc8433';
  for (const s of state.keep) g.fillRect(s.start / dur * w, 0, Math.max(1, (s.end - s.start) / dur * w), h);

  const env = state.envelope;
  if (env) {
    const th = parseFloat($('threshold').value);
    g.lineWidth = 1;
    for (let x = 0; x < w; x++) {
      const i0 = Math.floor(x / w * env.length), i1 = Math.max(i0 + 1, Math.floor((x + 1) / w * env.length));
      let mx = -100; for (let i = i0; i < i1 && i < env.length; i++) mx = Math.max(mx, env[i]);
      const v = Math.max(0, Math.min(1, (mx + 70) / 70));
      const bh = v * (h - 10);
      g.strokeStyle = mx > th ? '#3ddc84' : '#ff5c6c';
      g.beginPath(); g.moveTo(x + .5, h / 2 - bh / 2); g.lineTo(x + .5, h / 2 + bh / 2); g.stroke();
    }
    const ty = h / 2 - ((th + 70) / 70) * (h - 10) / 2;
    g.strokeStyle = '#ffffff66'; g.setLineDash([4, 4]);
    g.beginPath(); g.moveTo(0, ty); g.lineTo(w, ty); g.stroke(); g.setLineDash([]);
  }

  if (video.currentTime) {
    g.fillStyle = '#fff';
    g.fillRect(video.currentTime / dur * w, 0, 2, h);
  }
}
window.addEventListener('resize', () => state.envelope && draw());
cv.addEventListener('click', e => {
  const r = cv.getBoundingClientRect();
  video.currentTime = (e.clientX - r.left) / r.width * (state.duration || 0);
});

/* ---------------- 5. Xem trước ---------------- */
video.addEventListener('timeupdate', () => {
  draw();
  if (!$('skipMode').checked || !state.keep.length) return;
  const t = video.currentTime;
  const inSeg = state.keep.some(s => t >= s.start - 0.02 && t <= s.end + 0.02);
  if (!inSeg) {
    const next = state.keep.find(s => s.start > t);
    if (next) video.currentTime = next.start;
    else if (!video.paused) video.pause();
  }
});
$('playPreview').onclick = () => {
  if (state.keep.length && video.currentTime < state.keep[0].start) video.currentTime = state.keep[0].start;
  video.play();
};
$('stopPreview').onclick = () => video.pause();

/* ---------------- 6. Xuất video ---------------- */
const setStatus = (m, err) => { const s = $('exportStatus'); s.className = 'status' + (err ? ' err' : ''); s.textContent = m; };

function errText(e) {
  if (!e) return 'không rõ nguyên nhân';
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  if (e.type) return 'worker lỗi (' + e.type + ')';
  try { return JSON.stringify(e); } catch (_) { return String(e); }
}

const cores = navigator.hardwareConcurrency || 4;
const srcExt = () => ((state.file.name.match(/\.[^.]+$/) || ['.mp4'])[0]).toLowerCase();

(async () => {
  try {
    const mod = await import(WEBCODECS);
    turboOk = mod.supported();
  } catch (e) { turboOk = false; }
  const radio = engineRadio('turbo');
  const note = $('isoStatus');
  if (turboOk) {
    if (radio) radio.disabled = false;
    if (note) note.textContent = '⚡ Turbo khả dụng: trình duyệt sẽ giải mã và mã hoá bằng phần cứng.';
  } else {
    if (radio) radio.disabled = true;
    if (note) note.textContent = 'ℹ️ Trình duyệt không hỗ trợ WebCodecs' +
      (self.crossOriginIsolated ? ' · FFmpeg đa luồng đang bật (' + Math.min(8, cores) + ' luồng).' : '.');
  }
  applySourceDefaults();
})();

// Đọc keyframe và cho biết trước chế độ Siêu tốc sẽ cho kết quả dài bao nhiêu.
let copyPlan = null;

async function previewCopyPlan() {
  copyPlan = null;
  const el = $('copyInfo');
  if (!el || !state.keep.length) return;
  try {
    const { readKeyframes, snapToKeyframes } = await import(KEYFRAMES);
    const kf = await readKeyframes(state.file);
    if (!kf || kf.length < 2) {
      el.className = 'status err';
      el.textContent = 'ℹ️ Không đọc được bảng keyframe của tệp này, chế độ Siêu tốc có thể không chính xác.';
      return;
    }
    const snapped = snapToKeyframes(state.keep, kf);
    const total = snapped.reduce((a, s) => a + (s.end - s.start), 0);
    const gap = (kf[kf.length - 1] - kf[0]) / Math.max(1, kf.length - 1);
    copyPlan = { kf, snapped, total };
    el.className = 'status';
    el.textContent = '🔑 ' + kf.length + ' keyframe · cách nhau trung bình ' + gap.toFixed(1) + 's — ' +
      'chế độ Siêu tốc sẽ cho ra ' + fmtTime(total) + ' (' + snapped.length + ' đoạn), ' +
      'so với ' + fmtTime(state.keep.reduce((a, s) => a + (s.end - s.start), 0)) + ' nếu mã hoá lại.';
    if (total > state.duration * 0.95) {
      el.className = 'status err';
      el.textContent += ' Keyframe quá thưa nên hầu như không cắt được gì — hãy dùng Turbo hoặc FFmpeg.wasm.';
    }
  } catch (e) {
    log('Không đọc được keyframe: ' + errText(e));
  }
}

$('cancel').onclick = () => { state.cancel = true; setStatus('Đang dừng…'); };

$('export').onclick = async () => {
  if (!state.keep.length) return setStatus('Chưa có đoạn nào để giữ lại.', true);
  const engine = document.querySelector('input[name=engine]:checked').value;
  if ((engine === 'turbo' || engine === 'recorder') && !state.videoDecodable) {
    return setStatus('❌ Chế độ này cần trình duyệt xem được hình, mà tệp này không giải mã được. Hãy chọn Siêu tốc hoặc FFmpeg.wasm.', true);
  }
  state.cancel = false;
  $('export').disabled = true;
  $('cancel').hidden = false;
  $('downloadArea').innerHTML = '';
  $('prog').hidden = false; $('prog').value = 0;
  let ext = engine === 'recorder' ? 'webm' : 'mp4';
  const t0 = performance.now();
  try {
    let blob;
    if (engine === 'turbo') blob = await exportTurboRun(t0);
    else if (engine === 'copy') { const r = await exportWithCopy(); blob = r.blob; ext = r.ext; }
    else if (engine === 'ffmpeg') blob = await exportWithFFmpeg();
    else blob = await exportWithRecorder();
    const url = URL.createObjectURL(blob);
    const name = state.file.name.replace(/\.[^.]+$/, '') + '-no-silence.' + ext;
    $('downloadArea').innerHTML = '<a class="dl" href="' + url + '" download="' + name + '">⬇︎ Tải ' + name + ' (' + fmtSize(blob.size) + ')</a>';
    setStatus('✅ Xuất xong sau ' + ((performance.now() - t0) / 1000).toFixed(1) + ' giây!');
  } catch (e) {
    console.error(e);
    setStatus(state.cancel ? '⏹ Đã dừng.' : ('❌ ' + errText(e)), !state.cancel);
  } finally {
    $('export').disabled = false;
    $('cancel').hidden = true;
    $('prog').hidden = true;
  }
};

/* --- 6a. Turbo: WebCodecs --- */
async function exportTurboRun(t0) {
  const mod = await import(WEBCODECS);
  if (!mod.supported()) throw new Error('Trình duyệt không hỗ trợ WebCodecs.');

  if (!state.audio) {
    setStatus('Đang chuẩn bị âm thanh chất lượng cao…');
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      state.audio = await ctx.decodeAudioData(await state.file.arrayBuffer());
      ctx.close();
    } catch (e) {
      log('Không giải mã được âm thanh chất lượng cao (' + errText(e) + ') — xuất video không tiếng.');
    }
  }

  const outH = parseInt($('scale').value, 10) || 0;
  const crf = parseFloat($('crf').value);
  const quality = Math.max(0.3, Math.min(1.3, (34 - crf) / 12));
  const speed = parseFloat($('speed').value) || 2;

  return await mod.exportTurbo({
    srcUrl: video.src,
    audioBuffer: state.audio,
    keep: state.keep,
    outHeight: outH,
    quality,
    speed,
    onLog: log,
    onProgress: (p, note) => {
      $('prog').value = p;
      const el = (performance.now() - t0) / 1000;
      const eta = p > 0.02 && p < 1 ? ' · còn ~' + fmtTime(el / p - el) : '';
      setStatus('Đang xuất bằng Turbo — ' + (p * 100).toFixed(1) + '%' + eta + (note ? ' · ' + note : ''));
    },
    shouldCancel: () => state.cancel,
  });
}

/* --- 6b. FFmpeg.wasm --- */
let ffmpeg = null;
let ffUtil = null;
let ffThreads = 1;
const probe = { w: 0, h: 0, fps: 0, vcodec: '', acodec: '' };
let segProgress = 0;

function handleFfLog(msg) {
  log(msg);
  const r = msg.match(/Video:\s*([a-z0-9_]+).*?,\s*(\d+)x(\d+)/);
  if (r) { probe.vcodec = r[1]; probe.w = +r[2]; probe.h = +r[3]; }
  const a = msg.match(/Audio:\s*([a-z0-9_]+)/);
  if (a) probe.acodec = a[1];
  const f = msg.match(/,\s*([\d.]+)\s+fps\b/);
  if (f) probe.fps = parseFloat(f[1]);
}

async function loadCore(FFmpeg, util, base, mt) {
  const inst = new FFmpeg();
  inst.on('log', (e) => handleFfLog(e.message));
  inst.on('progress', (e) => { segProgress = Math.min(1, Math.max(0, e.progress || 0)); });

  setStatus('Đang tải FFmpeg core' + (mt ? ' đa luồng' : '') + ' (~32MB, chỉ lần đầu)…');
  const opts = {
    coreURL: await util.toBlobURL(base + '/ffmpeg-core.js', 'text/javascript'),
    wasmURL: await util.toBlobURL(base + '/ffmpeg-core.wasm', 'application/wasm'),
    classWorkerURL: new URL('ffmpeg-worker.js', document.baseURI).href,
  };
  if (mt) {
    opts.workerURL = await util.toBlobURL(base + '/ffmpeg-core.worker.js', 'text/javascript');
    ffThreads = Math.max(1, Math.min(8, cores));
  } else {
    ffThreads = 1;
  }
  const ok = await inst.load(opts);
  if (ok === false) throw new Error('ffmpeg.load() trả về false.');
  log('FFmpeg sẵn sàng — số luồng: ' + ffThreads);
  return inst;
}

async function getFFmpeg() {
  if (ffmpeg) return ffmpeg;
  log('Nạp thư viện ffmpeg (ESM)…');
  const [{ FFmpeg }, util] = await Promise.all([import(LIB_ESM + '/index.js'), import(UTIL_ESM)]);
  ffUtil = util;
  if (self.crossOriginIsolated) {
    try { ffmpeg = await loadCore(FFmpeg, util, CORE_MT, true); return ffmpeg; }
    catch (e) { log('Core đa luồng lỗi (' + errText(e) + ') — quay lại core 1 luồng…'); }
  }
  ffmpeg = await loadCore(FFmpeg, util, CORE_ST, false);
  return ffmpeg;
}

/* --- 6b-1. SIÊU TỐC: cắt ghép không mã hoá lại --- */
async function exportWithCopy() {
  // 1) Lấy danh sách keyframe thực tế để không bị chồng đoạn.
  let segs = state.keep;
  try {
    const { readKeyframes, snapToKeyframes } = await import(KEYFRAMES);
    const kf = (copyPlan && copyPlan.kf) || await readKeyframes(state.file);
    if (kf && kf.length > 1) {
      segs = snapToKeyframes(state.keep, kf);
      log('Keyframe: ' + kf.length + ' — đã lùi điểm cắt về keyframe và gộp ' +
        state.keep.length + ' đoạn thành ' + segs.length + ' đoạn không chồng nhau.');
    } else {
      log('⚠️ Không đọc được bảng keyframe — kết quả có thể còn lặp đoạn.');
    }
  } catch (e) {
    log('Không đọc được keyframe: ' + errText(e));
  }

  // 2) Kiểm tra an toàn: tổng đầu ra không được vượt thời lượng gốc.
  const clean = [];
  for (const s of segs) {
    const a = Math.max(0, s.start), b = Math.min(state.duration || s.end, s.end);
    if (b - a < 0.05) continue;
    const last = clean[clean.length - 1];
    if (last && a <= last.end + 0.001) last.end = Math.max(last.end, b);
    else clean.push({ start: a, end: b });
  }
  const expect = clean.reduce((a, s) => a + (s.end - s.start), 0);
  log('Dự kiến đầu ra: ' + fmtTime(expect) + ' / gốc ' + fmtTime(state.duration) + ' · ' + clean.length + ' đoạn');

  const ff = await getFFmpeg();
  const inExt = srcExt();
  const container = ['.mp4', '.mov', '.m4v', '.mkv', '.webm'].includes(inExt) ? inExt : '.mp4';
  const inName = 'input' + inExt;

  setStatus('Đang nạp video vào bộ nhớ ảo…');
  await ff.writeFile(inName, await ffUtil.fetchFile(state.file));

  setStatus('Đang đọc thông tin video…');
  try { await ff.exec(['-hide_banner', '-i', inName]); } catch (_) {}
  const isHevc = /hevc|h265/.test(probe.vcodec || '');

  const pieces = [];
  const n = clean.length;
  for (let i = 0; i < n; i++) {
    if (state.cancel) throw new Error('Đã dừng theo yêu cầu.');
    const s = clean[i];
    const name = 'p' + String(i).padStart(3, '0') + container;
    const a = [
      '-hide_banner', '-nostdin',
      '-ss', s.start.toFixed(3),
      '-i', inName,
      '-t', (s.end - s.start).toFixed(3),
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c', 'copy', '-avoid_negative_ts', 'make_zero',
    ];
    if (container === '.mp4' && isHevc) a.push('-tag:v', 'hvc1');
    a.push(name);
    await ff.exec(a);
    pieces.push(name);
    $('prog').value = (i + 1) / n * 0.85;
    setStatus('Sao chép đoạn ' + (i + 1) + '/' + n + ' (không mã hoá lại)…');
  }

  try { await ff.deleteFile(inName); } catch (_) {}

  setStatus('Đang ghép ' + n + ' đoạn…');
  const list = pieces.map(p => "file '" + p + "'").join('\n') + '\n';
  await ff.writeFile('list.txt', new TextEncoder().encode(list));
  const outName = 'output' + container;
  const cat = ['-hide_banner', '-nostdin', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy'];
  if (['.mp4', '.mov', '.m4v'].includes(container)) cat.push('-movflags', '+faststart');
  cat.push(outName);
  await ff.exec(cat);

  const data = await ff.readFile(outName);
  for (const p of pieces) { try { await ff.deleteFile(p); } catch (_) {} }
  try { await ff.deleteFile('list.txt'); await ff.deleteFile(outName); } catch (_) {}
  if (!data || !data.length) throw new Error('Không tạo được tệp đầu ra (có thể hết bộ nhớ).');
  $('prog').value = 1;
  return {
    blob: new Blob([data.buffer], { type: container === '.webm' ? 'video/webm' : 'video/mp4' }),
    ext: container.slice(1),
  };
}

async function exportWithFFmpeg() {
  const ff = await getFFmpeg();
  const inName = 'input' + srcExt();

  setStatus('Đang nạp video vào bộ nhớ ảo…');
  try { await ff.writeFile(inName, await ffUtil.fetchFile(state.file)); } catch (e) { throw new Error('Không nạp được tệp vào FFmpeg: ' + errText(e)); }

  setStatus('Đang đọc thông tin video…');
  try { await ff.exec(['-hide_banner', '-i', inName]); } catch (_) {}

  const crf = $('crf').value, preset = $('preset').value;
  const scaleSel = parseInt($('scale').value, 10);
  const fpsSel = parseFloat($('fps').value);
  const srcH = probe.h || state.h || 0;
  const srcFps = probe.fps || 0;

  const vf = [];
  if (fpsSel > 0 && (!srcFps || fpsSel < srcFps)) vf.push('fps=' + fpsSel);
  if (scaleSel > 0 && (!srcH || scaleSel < srcH)) vf.push('scale=-2:' + scaleSel + ':flags=fast_bilinear');

  const expr = state.keep.map(s => 'between(t,' + s.start.toFixed(3) + ',' + s.end.toFixed(3) + ')').join('+');
  const vfAll = ["select='" + expr + "'", 'setpts=N/FRAME_RATE/TB'].concat(vf);

  const args = ['-hide_banner', '-nostdin', '-i', inName];
  if (ffThreads > 1) args.push('-threads', String(ffThreads));
  args.push(
    '-vf', vfAll.join(','),
    '-af', "aselect='" + expr + "',asetpts=N/SR/TB",
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-sn', '-dn', '-map_metadata', '-1', '-movflags', '+faststart', 'output.mp4'
  );

  const t0 = performance.now();
  const timer = setInterval(() => {
    const p = Math.min(0.99, segProgress);
    $('prog').value = p;
    const el = (performance.now() - t0) / 1000;
    const eta = p > 0.01 ? ' · còn ~' + fmtTime(el / p - el) : '';
    setStatus('Đang mã hoá bằng FFmpeg — ' + (p * 100).toFixed(1) + '%' + eta + ' (đã trôi ' + fmtTime(el) + ')');
  }, 500);

  log('ffmpeg ' + args.join(' '));
  try { await ff.exec(args); } finally { clearInterval(timer); }

  const data = await ff.readFile('output.mp4');
  try { await ff.deleteFile(inName); await ff.deleteFile('output.mp4'); } catch (_) {}
  if (!data || !data.length) throw new Error('FFmpeg không tạo được tệp đầu ra (có thể hết bộ nhớ).');
  return new Blob([data.buffer], { type: 'video/mp4' });
}

/* --- 6c. MediaRecorder --- */
async function exportWithRecorder() {
  setStatus('Đang ghi theo thời gian thực (giữ tab này ở phía trước)…');
  const v = document.createElement('video');
  v.src = video.src; v.muted = false; v.playsInline = true;
  await new Promise(r => { v.onloadedmetadata = r; });

  const stream = v.captureStream ? v.captureStream() : v.mozCaptureStream();
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find(m => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8e6 });
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const done = new Promise(r => rec.onstop = r);

  const total = state.keep.reduce((a, s) => a + (s.end - s.start), 0);
  let elapsed = 0;
  rec.start(100);
  for (const seg of state.keep) {
    if (state.cancel) break;
    rec.pause();
    await seek(v, seg.start);
    rec.resume();
    await v.play();
    await new Promise(res => {
      const tick = () => {
        if (state.cancel || v.currentTime >= seg.end || v.ended) { v.pause(); res(); return; }
        const p = (elapsed + (v.currentTime - seg.start)) / total;
        $('prog').value = Math.min(1, p);
        setStatus('Đang ghi — ' + (p * 100).toFixed(1) + '% · còn ~' + fmtTime(total - elapsed - (v.currentTime - seg.start)));
        requestAnimationFrame(tick);
      };
      tick();
    });
    elapsed += seg.end - seg.start;
  }
  rec.stop();
  await done;
  return new Blob(chunks, { type: mime });
}

const seek = (v, t) => new Promise(res => { v.onseeked = () => { v.onseeked = null; res(); }; v.currentTime = t; });
