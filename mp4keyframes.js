/* Đọc bảng keyframe (sync sample) trực tiếp từ container MP4/MOV.
 * Chỉ đọc phần moov — không giải mã một khung hình nào, chạy trong tích tắc.
 * Trả về mảng mốc thời gian (giây) của các keyframe, hoặc null nếu không đọc được.
 */

const tag = (u8, o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);

async function slice(file, start, len) {
  const end = Math.min(file.size, start + len);
  if (end <= start) return new Uint8Array(0);
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

function dvOf(u8) {
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
}

function* children(u8, start, end) {
  const dv = dvOf(u8);
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = tag(u8, p + 4);
    let hdr = 8;
    if (size === 1) {
      if (p + 16 > end) return;
      size = Number(dv.getBigUint64(p + 8));
      hdr = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < 8 || p + size > end) return;
    yield { type, start: p + hdr, end: p + size };
    p += size;
  }
}

function find(u8, box, type) {
  for (const c of children(u8, box.start, box.end)) if (c.type === type) return c;
  return null;
}

export async function readKeyframes(file) {
  const ext = ((file.name.match(/\.[^.]+$/) || [''])[0]).toLowerCase();
  if (ext && !['.mp4', '.mov', '.m4v', '.m4a'].includes(ext)) return null;

  // Tìm box moov ở cấp cao nhất (có thể nằm cuối tệp) mà không đọc mdat.
  let pos = 0, moov = null;
  while (pos + 8 <= file.size) {
    const h = await slice(file, pos, 16);
    if (h.length < 8) break;
    const dv = dvOf(h);
    let size = dv.getUint32(0);
    const type = tag(h, 4);
    let hdr = 8;
    if (size === 1) { size = Number(dv.getBigUint64(8)); hdr = 16; }
    else if (size === 0) size = file.size - pos;
    if (size < 8) return null;
    if (type === 'moov') {
      const bytes = await slice(file, pos + hdr, size - hdr);
      moov = { u8: bytes, start: 0, end: bytes.length };
      break;
    }
    pos += size;
  }
  if (!moov) return null;

  const u8 = moov.u8;
  for (const trak of children(u8, moov.start, moov.end)) {
    if (trak.type !== 'trak') continue;
    const mdia = find(u8, trak, 'mdia');
    if (!mdia) continue;
    const hdlr = find(u8, mdia, 'hdlr');
    if (!hdlr || tag(u8, hdlr.start + 8) !== 'vide') continue;

    const mdhd = find(u8, mdia, 'mdhd');
    if (!mdhd) continue;
    const dv = dvOf(u8);
    const version = u8[mdhd.start];
    const timescale = version === 1 ? dv.getUint32(mdhd.start + 20) : dv.getUint32(mdhd.start + 12);
    if (!timescale) continue;

    const minf = find(u8, mdia, 'minf');
    const stbl = minf && find(u8, minf, 'stbl');
    const stts = stbl && find(u8, stbl, 'stts');
    if (!stts) continue;
    const stss = find(u8, stbl, 'stss');

    return syncTimes(dv, stts, stss, timescale);
  }
  return null;
}

function syncTimes(dv, stts, stss, timescale) {
  const nEntries = dv.getUint32(stts.start + 4);
  const counts = new Uint32Array(nEntries);
  const deltas = new Uint32Array(nEntries);
  for (let i = 0; i < nEntries; i++) {
    counts[i] = dv.getUint32(stts.start + 8 + i * 8);
    deltas[i] = dv.getUint32(stts.start + 12 + i * 8);
  }

  let syncs = null;
  if (stss) {
    const n = dv.getUint32(stss.start + 4);
    syncs = new Uint32Array(n);
    for (let i = 0; i < n; i++) syncs[i] = dv.getUint32(stss.start + 8 + i * 4);
  }

  const out = [];
  let sample = 1, time = 0, si = 0;
  outer:
  for (let e = 0; e < nEntries; e++) {
    for (let c = 0; c < counts[e]; c++) {
      if (!syncs) out.push(time / timescale);
      else if (si < syncs.length && syncs[si] === sample) { out.push(time / timescale); si++; }
      time += deltas[e];
      sample++;
      if (syncs && si >= syncs.length) break outer;
    }
  }
  return out.length ? out : null;
}

// Lùi mỗi đoạn về keyframe gần nhất phía trước, rồi gộp các đoạn chồng nhau.
export function snapToKeyframes(keep, kf) {
  const out = [];
  for (const s of keep) {
    let lo = 0, hi = kf.length - 1, k = kf[0] <= s.start ? kf[0] : 0;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (kf[m] <= s.start + 0.001) { k = kf[m]; lo = m + 1; } else hi = m - 1;
    }
    const last = out[out.length - 1];
    if (last && k <= last.end + 0.001) last.end = Math.max(last.end, s.end);
    else out.push({ start: k, end: s.end });
  }
  return out;
}
