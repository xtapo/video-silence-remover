/* Silence Remover — 100% client-side.
 * Không có bất kỳ request upload nào: file chỉ được đọc bằng FileReader/URL.createObjectURL.
 */
(() => {
  const $ = (id) => document.getElementById(id);

  const FFMPEG_VER = '0.12.10';
  const CORE_VER = '0.12.6';
  const LIB_BASE = 'https://unpkg.com/@ffmpeg/ffmpeg@' + FFMPEG_VER + '/dist/umd';
  const CORE_BASE = 'https://unpkg.com/@ffmpeg/core@' + CORE_VER + '/dist/umd';

  const state = {
    file: null,
    duration: 0,
    envelope: null,   // Float32Array dB mỗi frame
    frameDur: 0.02,   // 20ms
    keep: [],         // [{start,end}]
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
    video.onloadedmetadata = () => { state.duration = video.duration; };
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

  // Lỗi từ worker thường không phải Error -> tránh hiển thị "undefined".
  function errText(e) {
    if (!e) return 'không rõ nguyên nhân';
    if (typeof e === 'string') return e;
    if (e.message) return e.message;
    if (e.type) return 'worker lỗi (' + e.type + ')';
    try { return JSON.stringify(e); } catch (_) { return String(e); }
  }

  $('export').onclick = async () => {
    if (!state.keep.length) return setStatus('Chưa có đoạn nào để giữ lại.', true);
    const engine = document.querySelector('input[name=engine]:checked').value;
    $('export').disabled = true;
    $('downloadArea').innerHTML = '';
    $('prog').hidden = false; $('prog').value = 0;
    let ext = engine === 'ffmpeg' ? 'mp4' : 'webm';
    try {
      let blob;
      if (engine === 'ffmpeg') {
        try {
          blob = await exportWithFFmpeg();
        } catch (e) {
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
      setStatus('✅ Xuất xong!');
    } catch (e) {
      console.error(e);
      setStatus('❌ Lỗi khi xuất: ' + errText(e), true);
    } finally {
      $('export').disabled = false;
      $('prog').hidden = true;
    }
  };

  /* --- 6a. FFmpeg.wasm ---
   * Worker được tạo từ ffmpeg-worker.js (cùng origin) thay vì file trên CDN,
   * vì trình duyệt không cho phép new Worker() với script khác origin.
   */
  let ffmpeg = null;

  async function getFFmpeg() {
    if (ffmpeg) return ffmpeg;
    if (!window.FFmpegWASM || !window.FFmpegWASM.FFmpeg) throw new Error('Không tải được thư viện FFmpeg từ CDN.');
    const FFmpeg = window.FFmpegWASM.FFmpeg;
    const toBlobURL = window.FFmpegUtil.toBlobURL;

    const inst = new FFmpeg();
    inst.on('log', (e) => log(e.message));
    inst.on('progress', (e) => { $('prog').value = Math.min(1, Math.max(0, e.progress || 0)); });

    setStatus('Đang tải FFmpeg core (~32MB, chỉ lần đầu)…');
    log('Tải ffmpeg-core.js…');
    const coreURL = await toBlobURL(CORE_BASE + '/ffmpeg-core.js', 'text/javascript');
    log('Tải ffmpeg-core.wasm…');
    const wasmURL = await toBlobURL(CORE_BASE + '/ffmpeg-core.wasm', 'application/wasm');
    const classWorkerURL = new URL('ffmpeg-worker.js', document.baseURI).href;
    log('Worker (cùng origin): ' + classWorkerURL);

    log('Gọi ffmpeg.load()…');
    let ok;
    try {
      ok = await inst.load({ coreURL, wasmURL, classWorkerURL });
    } catch (e) {
      throw new Error('ffmpeg.load() thất bại: ' + errText(e));
    }
    if (ok === false) throw new Error('ffmpeg.load() trả về false.');
    log('FFmpeg đã sẵn sàng.');
    ffmpeg = inst;
    return ffmpeg;
  }

  async function exportWithFFmpeg() {
    const ff = await getFFmpeg();
    const fetchFile = window.FFmpegUtil.fetchFile;
    const ext = (state.file.name.match(/\.[^.]+$/) || ['.mp4'])[0];
    const inName = 'input' + ext;
    setStatus('Đang nạp video vào bộ nhớ ảo…');
    await ff.writeFile(inName, await fetchFile(state.file));

    const expr = state.keep
      .map(s => 'between(t,' + s.start.toFixed(3) + ',' + s.end.toFixed(3) + ')')
      .join('+');
    const crf = $('crf').value, preset = $('preset').value;

    setStatus('Đang mã hoá ' + state.keep.length + ' đoạn bằng FFmpeg…');
    await ff.exec([
      '-i', inName,
      '-vf', "select='" + expr + "',setpts=N/FRAME_RATE/TB",
      '-af', "aselect='" + expr + "',asetpts=N/SR/TB",
      '-c:v', 'libx264', '-preset', preset, '-crf', String(crf),
      '-c:a', 'aac', '-b:a', '160k',
      '-movflags', '+faststart',
      'output.mp4',
    ]);
    const data = await ff.readFile('output.mp4');
    try { await ff.deleteFile(inName); await ff.deleteFile('output.mp4'); } catch (_) {}
    if (!data || !data.length) throw new Error('FFmpeg không tạo được tệp đầu ra.');
    return new Blob([data.buffer], { type: 'video/mp4' });
  }

  // --- 6b. MediaRecorder: phát thật & ghi lại, tạm dừng ở khoảng lặng ---
  async function exportWithRecorder() {
    setStatus('Đang ghi theo thời gian thực (giữ tab này ở phía trước)…');
    const v = document.createElement('video');
    v.src = video.src; v.muted = false; v.playsInline = true;
    await new Promise(r => { v.onloadedmetadata = r; });

    const stream = v.captureStream ? v.captureStream() : v.mozCaptureStream();
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find(m => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6e6 });
    const chunks = [];
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    const done = new Promise(r => rec.onstop = r);

    const total = state.keep.reduce((a, s) => a + (s.end - s.start), 0);
    let elapsed = 0;
    rec.start(100);
    for (const seg of state.keep) {
      rec.pause();
      await seek(v, seg.start);
      rec.resume();
      await v.play();
      await new Promise(res => {
        const tick = () => {
          if (v.currentTime >= seg.end || v.ended) { v.pause(); res(); return; }
          $('prog').value = Math.min(1, (elapsed + (v.currentTime - seg.start)) / total);
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
})();
