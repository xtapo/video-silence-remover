/* Silence Remover — 100% client-side.
 * Không có bất kỳ request upload nào: file chỉ được đọc bằng URL.createObjectURL / arrayBuffer().
 */

const $ = (id) => document.getElementById(id);

const LIB_ESM = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm';
const UTIL_ESM = 'https://unpkg.com/@ffmpeg/util@0.12.1/dist/esm/index.js';
const CORE_ST = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';      // 1 luồng
const CORE_MT = 'https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/esm';   // đa luồng

const state = {
  file: null,
  duration: 0,
  w: 0, h: 0,
  envelope: null,   // Float32Array dB mỗi frame
  frameDur: 0.02,   // 20ms
  keep: [],         // [{start,end}]
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
  if (!isFinite(s)) return '—';
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = (s % 60);
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + sec.toFixed(1).padStart(4, '0');
};

const video = $('video');

function loadFile(f) {
  state.file = f;
  state.keep = []; state.envelope = null;
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
    applySourceDefaults();
  };
}

// Tự chọn thiết lập hợp lý theo nguồn + cảnh báo video quá nặng.
function applySourceDefaults() {
  const info = $('srcInfo');
  if (!state.h) return;
  const sc = $('scale');
  if (state.h > 1080 && sc.value === '0') sc.value = '1080';

  const heavy = state.h > 1440 || (state.w * state.h * state.duration) > 1080 * 1920 * 900;
  let msg = 'Nguồn: ' + state.w + '×' + state.h + ' · ' + fmtTime(state.duration);
  if (heavy) {
    msg += ' — ⚠️ Rất nặng cho FFmpeg trong trình duyệt. Video 4K dài có thể mất nhiều giờ vì trình duyệt phải giải mã bằng phần mềm (không dùng được GPU). Khuyến nghị: chọn MediaRecorder (xong sau đúng thời lượng giữ lại), hoặc hạ độ phân giải xuống 1080p/720p.';
    const r = document.querySelector('input[name=engine][value=recorder]');
    if (r) r.checked = true;
  }
  if (info) { info.textContent = msg; info.className = heavy ? 'status err' : 'status'; }
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

async function analyze() {
  const st = $('analyzeStatus');
  st.className = 'status'; st.textContent = 'Đang đọc tệp…';
  $('analyze').disabled = true;
  try {
    const buf = await state.file.arrayBuffer();
    st.textContent = 'Đang giải mã âm thanh (có thể mất chút thời gian với video dài)…';
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const audio = await ctx.decodeAudioData(buf.slice(0));
    ctx.close();

    state.duration = Math.max(state.duration || 0, audio.duration);
    st.textContent = 'Đang tính đường bao âm lượng…';
    state.envelope = buildEnvelope(audio, state.frameDur);

    computeSegments();
    render();
    $('resultCard').hidden = false;
    $('exportCard').hidden = false;
    applySourceDefaults();
    st.textContent = '✅ Phân tích xong. Chỉnh thanh trượt để cập nhật tức thì.';
    $('resultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    console.error(e);
    st.className = 'status err';
    st.textContent = '❌ Không giải mã được âm thanh của tệp này (' + errText(e) + '). Thử định dạng MP4/WebM có tiếng.';
  } finally {
    $('analyze').disabled = false;
  }
}

// RMS theo khung -> dBFS
function buildEnvelope(audio, frameDur) {
  const sr = audio.sampleRate;
  const frameLen = Math.max(1, Math.round(sr * frameDur));
  const n = Math.ceil(audio.length / frameLen);
  const out = new Float32Array(n);
  const chans = [];
  for (let c = 0; c < audio.numberOfChannels; c++) chans.push(audio.getChannelData(c));
  for (let i = 0; i < n; i++) {
    const s0 = i * frameLen, s1 = Math.min(audio.length, s0 + frameLen);
    let sum = 0, cnt = 0;
    for (const ch of chans) {
      for (let s = s0; s < s1; s++) { const v = ch[s]; sum += v * v; cnt++; }
    }
    const rms = cnt ? Math.sqrt(sum / cnt) : 0;
    out[i] = 20 * Math.log10(rms + 1e-10);
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

/* ---------------- 4. Vẽ timeline + thống kê ---------------- */
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

/* ---------------- 5. Xem trước (bỏ qua khoảng lặng) ---------------- */
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
const logEl = $('log');
const log = (m) => { logEl.hidden = false; logEl.textContent += m + '\n'; logEl.scrollTop = logEl.scrollHeight; };
const setStatus = (m, err) => { const s = $('exportStatus'); s.className = 'status' + (err ? ' err' : ''); s.textContent = m; };

function errText(e) {
  if (!e) return 'không rõ nguyên nhân';
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  if (e.type) return 'worker lỗi (' + e.type + ')';
  try { return JSON.stringify(e); } catch (_) { return String(e); }
}

const cores = navigator.hardwareConcurrency || 4;
const iso = $('isoStatus');
if (iso) {
  iso.textContent = self.crossOriginIsolated
    ? '⚡ Chế độ đa luồng đang BẬT — sẽ dùng ' + Math.min(8, cores) + ' luồng CPU.'
    : 'ℹ️ Đa luồng chưa bật (service worker đang cài). Tải lại trang một lần để nhanh hơn 3–4 lần.';
}

$('cancel').onclick = () => { state.cancel = true; setStatus('Đang dừng sau đoạn hiện tại…'); };

$('export').onclick = async () => {
  if (!state.keep.length) return setStatus('Chưa có đoạn nào để giữ lại.', true);
  const engine = document.querySelector('input[name=engine]:checked').value;
  state.cancel = false;
  $('export').disabled = true;
  $('cancel').hidden = false;
  $('downloadArea').innerHTML = '';
  $('prog').hidden = false; $('prog').value = 0;
  let ext = engine === 'ffmpeg' ? 'mp4' : 'webm';
  const t0 = performance.now();
  try {
    let blob;
    if (engine === 'ffmpeg') {
      try {
        blob = await exportWithFFmpeg();
      } catch (e) {
        if (state.cancel) throw e;
        console.warn('FFmpeg thất bại, chuyển sang MediaRecorder:', e);
        log('FFmpeg lỗi: ' + errText(e));
        setStatus('⚠️ Không dùng được FFmpeg.wasm — đang tự chuyển sang MediaRecorder (WebM)…');
        ffmpeg = null;
        blob = await exportWithRecorder();
        ext = 'webm';
      }
    } else {
      blob = await exportWithRecorder();
    }
    const url = URL.createObjectURL(blob);
    const name = state.file.name.replace(/\.[^.]+$/, '') + '-no-silence.' + ext;
    $('downloadArea').innerHTML = '<a class="dl" href="' + url + '" download="' + name + '">⬇︎ Tải ' + name + ' (' + fmtSize(blob.size) + ')</a>';
    setStatus('✅ Xuất xong sau ' + ((performance.now() - t0) / 1000).toFixed(1) + ' giây!');
  } catch (e) {
    console.error(e);
    setStatus(state.cancel ? '⏹ Đã dừng.' : ('❌ Lỗi khi xuất: ' + errText(e)), !state.cancel);
  } finally {
    $('export').disabled = false;
    $('cancel').hidden = true;
    $('prog').hidden = true;
  }
};

/* --- 6a. FFmpeg.wasm --- */
let ffmpeg = null;
let ffUtil = null;
let ffThreads = 1;
const probe = { w: 0, h: 0, fps: 0 };
let segProgress = 0;   // tiến độ của đoạn đang mã hoá (0..1)

function handleFfLog(msg) {
  log(msg);
  const r = msg.match(/Video:.*?,\s*(\d+)x(\d+)/);
  if (r) { probe.w = +r[1]; probe.h = +r[2]; }
  const f = msg.match(/,\s*([\d.]+)\s+fps\b/);
  if (f) probe.fps = parseFloat(f[1]);
}

async function loadCore(FFmpeg, util, base, mt) {
  const inst = new FFmpeg();
  inst.on('log', (e) => handleFfLog(e.message));
  inst.on('progress', (e) => { segProgress = Math.min(1, Math.max(0, e.progress || 0)); });

  setStatus('Đang tải FFmpeg core' + (mt ? ' đa luồng' : '') + ' (~32MB, chỉ lần đầu)…');
  log('Tải ffmpeg-core.js' + (mt ? ' (mt)' : '') + '…');
  const opts = {
    coreURL: await util.toBlobURL(base + '/ffmpeg-core.js', 'text/javascript'),
    wasmURL: await util.toBlobURL(base + '/ffmpeg-core.wasm', 'application/wasm'),
    classWorkerURL: new URL('ffmpeg-worker.js', document.baseURI).href,
  };
  if (mt) {
    log('Tải ffmpeg-core.worker.js…');
    opts.workerURL = await util.toBlobURL(base + '/ffmpeg-core.worker.js', 'text/javascript');
    ffThreads = Math.max(1, Math.min(8, cores));
  } else {
    ffThreads = 1;
  }

  log('Gọi ffmpeg.load()…');
  const ok = await inst.load(opts);
  if (ok === false) throw new Error('ffmpeg.load() trả về false.');
  log('FFmpeg sẵn sàng — số luồng: ' + ffThreads);
  return inst;
}

async function getFFmpeg() {
  if (ffmpeg) return ffmpeg;
  log('Nạp thư viện ffmpeg (ESM)…');
  const [{ FFmpeg }, util] = await Promise.all([
    import(LIB_ESM + '/index.js'),
    import(UTIL_ESM),
  ]);
  ffUtil = util;
  log('crossOriginIsolated = ' + !!self.crossOriginIsolated);

  if (self.crossOriginIsolated) {
    try {
      ffmpeg = await loadCore(FFmpeg, util, CORE_MT, true);
      return ffmpeg;
    } catch (e) {
      log('Core đa luồng lỗi (' + errText(e) + ') — quay lại core 1 luồng…');
    }
  }
  ffmpeg = await loadCore(FFmpeg, util, CORE_ST, false);
  return ffmpeg;
}

/* Mã hoá từng đoạn riêng rồi nối lại (concat, không mã hoá lại).
 * Lợi ích: thấy tiến độ tức thì, không giải mã phần bị cắt bỏ, giải phóng bộ nhớ sau mỗi đoạn,
 * và có thể dừng giữa chừng. Điểm cắt vẫn chính xác tới frame vì ffmpeg seek chính xác khi transcode. */
async function exportWithFFmpeg() {
  const ff = await getFFmpeg();
  const inExt = (state.file.name.match(/\.[^.]+$/) || ['.mp4'])[0];
  const inName = 'input' + inExt;

  setStatus('Đang nạp video vào bộ nhớ ảo…');
  await ff.writeFile(inName, await ffUtil.fetchFile(state.file));

  // Thăm dò thông số nguồn (lệnh này thoát với lỗi — bình thường).
  setStatus('Đang đọc thông tin video…');
  try { await ff.exec(['-hide_banner', '-i', inName]); } catch (_) {}

  const crf = $('crf').value, preset = $('preset').value;
  const scaleSel = parseInt($('scale').value, 10);
  const fpsSel = parseFloat($('fps').value);
  const srcH = probe.h || state.h || 0;
  const srcFps = probe.fps || 0;

  const vf = [];
  // Chỉ hạ fps, không bao giờ tăng (tăng fps = nhân thêm việc vô ích).
  if (fpsSel > 0 && (!srcFps || fpsSel < srcFps)) vf.push('fps=' + fpsSel);
  else if (fpsSel > 0) log('Bỏ qua fps=' + fpsSel + ' vì nguồn chỉ ' + srcFps + ' fps.');
  // Chỉ thu nhỏ, không phóng to.
  if (scaleSel > 0 && (!srcH || scaleSel < srcH)) vf.push('scale=-2:' + scaleSel + ':flags=fast_bilinear');
  else if (scaleSel > 0) log('Bỏ qua scale vì nguồn chỉ cao ' + srcH + 'px.');

  const total = state.keep.reduce((a, s) => a + (s.end - s.start), 0);
  let done = 0;
  const parts = [];
  const t0 = performance.now();

  for (let i = 0; i < state.keep.length; i++) {
    if (state.cancel) throw new Error('Đã dừng theo yêu cầu.');
    const s = state.keep[i];
    const dur = s.end - s.start;
    const out = 'p' + i + '.mp4';
    segProgress = 0;

    const args = ['-hide_banner', '-nostdin'];
    args.push('-ss', s.start.toFixed(3), '-i', inName, '-t', dur.toFixed(3));
    if (ffThreads > 1) args.push('-threads', String(ffThreads));
    if (vf.length) args.push('-vf', vf.join(','));
    args.push(
      '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      '-sn', '-dn', '-map_metadata', '-1',
      '-avoid_negative_ts', 'make_zero',
      out
    );

    // Cập nhật tiến độ tổng + ước lượng thời gian còn lại trong lúc đang chạy.
    const timer = setInterval(() => {
      const p = Math.min(1, (done + segProgress * dur) / total);
      $('prog').value = p;
      const el = (performance.now() - t0) / 1000;
      const eta = p > 0.01 ? ' · còn ~' + fmtTime(el / p - el) : '';
      setStatus('Đang mã hoá đoạn ' + (i + 1) + '/' + state.keep.length +
        ' — ' + (p * 100).toFixed(1) + '%' + eta);
    }, 500);

    try {
      await ff.exec(args);
    } finally {
      clearInterval(timer);
    }

    parts.push(out);
    done += dur;
  }

  if (state.cancel) throw new Error('Đã dừng theo yêu cầu.');

  setStatus('Đang nối ' + parts.length + ' đoạn lại (không mã hoá lại, rất nhanh)…');
  const list = parts.map(p => "file '" + p + "'").join('\n') + '\n';
  await ff.writeFile('list.txt', new TextEncoder().encode(list));
  await ff.exec(['-hide_banner', '-f', 'concat', '-safe', '0', '-i', 'list.txt',
    '-c', 'copy', '-movflags', '+faststart', 'output.mp4']);

  const data = await ff.readFile('output.mp4');
  try {
    await ff.deleteFile(inName);
    await ff.deleteFile('list.txt');
    await ff.deleteFile('output.mp4');
    for (const p of parts) await ff.deleteFile(p);
  } catch (_) {}

  if (!data || !data.length) throw new Error('FFmpeg không tạo được tệp đầu ra.');
  return new Blob([data.buffer], { type: 'video/mp4' });
}

/* --- 6b. MediaRecorder: phát thật & ghi lại, tạm dừng ở khoảng lặng --- */
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
