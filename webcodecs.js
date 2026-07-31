/* Bộ máy xuất "Turbo" dùng WebCodecs.
 * Trình duyệt giải mã và mã hoá bằng phần cứng nên nhanh hơn FFmpeg.wasm rất nhiều.
 * Vẫn 100% chạy cục bộ, không upload gì.
 */

const MUXER_URL = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.1/build/mp4-muxer.mjs';

export function supported() {
  return typeof self.VideoEncoder !== 'undefined'
    && typeof self.VideoFrame !== 'undefined'
    && typeof self.AudioEncoder !== 'undefined'
    && typeof self.MediaStreamTrackProcessor !== 'undefined';
}

const once = (el, ev) => new Promise(r => el.addEventListener(ev, r, { once: true }));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Chờ metadata một cách chắc chắn: có thể sự kiện đã bắn trước, hoặc videoWidth đến muộn hơn.
async function waitMeta(v) {
  if (v.readyState >= 1 && v.videoWidth) return;
  await new Promise((res) => {
    const done = () => res();
    v.addEventListener('loadedmetadata', done, { once: true });
    v.addEventListener('loadeddata', done, { once: true });
    v.addEventListener('error', done, { once: true });
    setTimeout(done, 15000);
  });
  for (let i = 0; i < 60 && !v.videoWidth; i++) await sleep(50);
}

async function readFrame(reader, ms) {
  let timer;
  const timeout = new Promise(r => { timer = setTimeout(() => r({ timedOut: true }), ms); });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function exportTurbo(o) {
  const log = o.onLog || (() => {});
  const cancelled = () => (o.shouldCancel ? o.shouldCancel() : false);

  log('Nạp bộ đóng gói MP4…');
  const { Muxer, ArrayBufferTarget } = await import(MUXER_URL);

  const v = document.createElement('video');
  v.src = o.srcUrl;
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0';
  document.body.appendChild(v);

  try {
    await waitMeta(v);
    const sw = v.videoWidth, sh = v.videoHeight;
    if (!sw || !sh) {
      throw new Error('Trình duyệt không giải mã được phần HÌNH của tệp này (videoWidth = 0). ' +
        'Thường gặp với video H.265/HEVC trên Edge/Chrome khi máy chưa có bộ giải mã HEVC. ' +
        'Hãy chuyển sang chế độ FFmpeg.wasm (giải mã bằng phần mềm, chậm nhưng chạy được), ' +
        'hoặc chuyển video sang H.264 rồi thử lại.');
    }

    let ow = sw, oh = sh;
    if (o.outHeight && o.outHeight < sh) {
      oh = Math.round(o.outHeight / 2) * 2;
      ow = Math.round(sw * oh / sh / 2) * 2;
    }
    log('WebCodecs: nguồn ' + sw + '×' + sh + ' → đầu ra ' + ow + '×' + oh);

    const fpsGuess = 30;
    const q = Math.max(0.3, Math.min(1.3, o.quality == null ? 0.7 : o.quality));
    const bitrate = Math.round(Math.min(24e6, Math.max(1.5e6, ow * oh * fpsGuess * 0.07 * q)));

    const codecs = ['avc1.640033', 'avc1.640028', 'avc1.4d4028', 'avc1.42e01e'];
    let cfg = null;
    for (const hw of ['prefer-hardware', 'no-preference']) {
      for (const c of codecs) {
        const test = {
          codec: c, width: ow, height: oh, bitrate, framerate: fpsGuess,
          hardwareAcceleration: hw, avc: { format: 'avc' }, latencyMode: 'quality',
        };
        try {
          const s = await VideoEncoder.isConfigSupported(test);
          if (s && s.supported) { cfg = test; break; }
        } catch (_) {}
      }
      if (cfg) break;
    }
    if (!cfg) throw new Error('Trình duyệt không có bộ mã hoá H.264 khả dụng.');
    log('Bộ mã hoá: ' + cfg.codec + ' · ' + cfg.hardwareAcceleration + ' · ' + (bitrate / 1e6).toFixed(1) + ' Mbps');

    const hasAudio = !!o.audioBuffer;
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: ow, height: oh },
      audio: hasAudio ? {
        codec: 'aac',
        sampleRate: o.audioBuffer.sampleRate,
        numberOfChannels: Math.min(2, o.audioBuffer.numberOfChannels),
      } : undefined,
      fastStart: 'in-memory',
    });

    let encError = null;
    const venc = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { encError = e; },
    });
    venc.configure(cfg);

    const needScale = (ow !== sw || oh !== sh);
    let canvas = null, ctx = null;
    if (needScale) {
      canvas = new OffscreenCanvas(ow, oh);
      ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    }

    const stream = v.captureStream ? v.captureStream() : v.mozCaptureStream();
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('Không lấy được luồng hình từ trình duyệt.');
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();

    const total = o.keep.reduce((a, s) => a + (s.end - s.start), 0);
    const speed = Math.max(1, Math.min(8, o.speed || 2));
    let accumUs = 0, frames = 0;

    for (let i = 0; i < o.keep.length; i++) {
      if (cancelled()) throw new Error('Đã dừng theo yêu cầu.');
      const seg = o.keep[i];
      const segUs = Math.round((seg.end - seg.start) * 1e6);

      v.pause();
      v.currentTime = seg.start;
      await once(v, 'seeked');
      v.playbackRate = speed;
      try { await v.play(); } catch (_) {}

      let base = null, lastOut = -1;
      while (true) {
        if (cancelled()) throw new Error('Đã dừng theo yêu cầu.');
        const res = await readFrame(reader, 4000);
        if (res.timedOut) { log('Hết frame ở đoạn ' + (i + 1) + '.'); break; }
        if (res.done) break;
        const frame = res.value;
        if (!frame) continue;

        if (base === null) base = frame.timestamp;
        const rel = Math.round((frame.timestamp - base) * speed);
        if (rel > segUs) { frame.close(); break; }

        const ts = accumUs + rel;
        if (ts <= lastOut) { frame.close(); continue; }
        lastOut = ts;

        let out = frame;
        if (needScale) {
          ctx.drawImage(frame, 0, 0, ow, oh);
          out = new VideoFrame(canvas, { timestamp: ts, duration: frame.duration || undefined });
          frame.close();
        } else if (frame.timestamp !== ts) {
          out = new VideoFrame(frame, { timestamp: ts });
          frame.close();
        }

        venc.encode(out, { keyFrame: (frames % 150) === 0 });
        out.close();
        frames++;
        if (encError) throw encError;

        if (venc.encodeQueueSize > 24) {
          v.pause();
          while (venc.encodeQueueSize > 6 && !cancelled()) await sleep(15);
          try { await v.play(); } catch (_) {}
        }

        if (o.onProgress && (frames % 8) === 0) {
          o.onProgress(Math.min(0.96, (accumUs + rel) / 1e6 / total), 'đoạn ' + (i + 1) + '/' + o.keep.length);
        }
      }
      accumUs += segUs;
    }

    v.pause();
    try { track.stop(); } catch (_) {}
    try { await reader.cancel(); } catch (_) {}

    if (!frames) throw new Error('Không nhận được khung hình nào từ trình duyệt — nhiều khả năng định dạng hình không được hỗ trợ. Hãy dùng FFmpeg.wasm.');

    log('Đã mã hoá ' + frames + ' khung hình, đang kết thúc…');
    await venc.flush();
    venc.close();
    if (encError) throw encError;

    if (hasAudio) {
      if (o.onProgress) o.onProgress(0.97, 'âm thanh');
      log('Mã hoá âm thanh AAC…');
      await encodeAudio(muxer, o.audioBuffer, o.keep);
    }

    muxer.finalize();
    if (o.onProgress) o.onProgress(1, 'hoàn tất');
    return new Blob([muxer.target.buffer], { type: 'video/mp4' });
  } finally {
    try { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); } catch (_) {}
  }
}

async function encodeAudio(muxer, buf, keep) {
  const sr = buf.sampleRate;
  const ch = Math.min(2, buf.numberOfChannels);
  let err = null;

  const cfg = { codec: 'mp4a.40.2', sampleRate: sr, numberOfChannels: ch, bitrate: 128000 };
  const sup = await AudioEncoder.isConfigSupported(cfg).catch(() => null);
  if (!sup || !sup.supported) throw new Error('Trình duyệt không hỗ trợ mã hoá AAC.');

  const aenc = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => { err = e; },
  });
  aenc.configure(cfg);

  const src = [];
  for (let c = 0; c < ch; c++) src.push(buf.getChannelData(c));

  const N = 1024;
  let outIdx = 0;
  for (const seg of keep) {
    const a = Math.max(0, Math.round(seg.start * sr));
    const b = Math.min(buf.length, Math.round(seg.end * sr));
    for (let p = a; p < b; p += N) {
      const n = Math.min(N, b - p);
      const data = new Float32Array(n * ch);
      for (let c = 0; c < ch; c++) data.set(src[c].subarray(p, p + n), c * n);
      const ad = new AudioData({
        format: 'f32-planar', sampleRate: sr, numberOfFrames: n,
        numberOfChannels: ch, timestamp: Math.round(outIdx / sr * 1e6), data,
      });
      aenc.encode(ad);
      ad.close();
      outIdx += n;
      if (err) throw err;
      if (aenc.encodeQueueSize > 48) await sleep(5);
    }
  }
  await aenc.flush();
  aenc.close();
  if (err) throw err;
}
