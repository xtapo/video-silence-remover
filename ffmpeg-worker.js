/* Worker shim CÙNG ORIGIN cho @ffmpeg/ffmpeg 0.12.x (bản ESM).
 *
 * Vì sao cần file này:
 * - Thư viện gọi new Worker(url, { type: 'module' }) với url trỏ tới CDN.
 *   Trình duyệt CẤM tạo Worker từ script khác origin -> lỗi "cannot be accessed from origin".
 * - File này nằm cùng origin với trang nên tạo Worker hợp lệ, sau đó dùng
 *   import (ESM) để nạp mã worker thật từ CDN — import cross-origin được phép vì unpkg có CORS.
 *
 * Lưu ý: ĐÂY LÀ ES MODULE. Không dùng importScripts() ở đây — module worker
 * không có hàm đó, đó chính là nguyên nhân lỗi "this[#s][e] is not a function".
 */
import 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/worker.js'
