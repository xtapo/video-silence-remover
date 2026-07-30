/* Worker shim cùng origin cho @ffmpeg/ffmpeg 0.12.x.
 *
 * Thư viện mặc định tự tạo Worker từ file phụ trên CDN (ví dụ 814.ffmpeg.js).
 * Trình duyệt chặn vì khác origin. File này nằm cùng origin với trang web nên
 * được phép tạo Worker, rồi nạp mã worker thật qua importScripts (unpkg có CORS).
 */
const VER = '0.12.10';
const BASE = 'https://unpkg.com/@ffmpeg/ffmpeg@' + VER + '/dist/umd/';
const CANDIDATES = ['814.ffmpeg.js', '814.ffmpeg.min.js', 'ffmpeg.worker.js'];

let loaded = false;
for (const name of CANDIDATES) {
  try {
    importScripts(BASE + name);
    loaded = true;
    break;
  } catch (e) {
    // thử tên tiếp theo
  }
}

if (!loaded) {
  self.postMessage({ type: 'ERROR', data: 'Không nạp được mã worker của FFmpeg từ CDN.' });
}
