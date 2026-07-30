# ✂️ Video Silence Remover

Ứng dụng web **chạy hoàn toàn trên trình duyệt** giúp phát hiện và xoá các đoạn im lặng trong video — dùng cho podcast, screencast, bài giảng, vlog.

> 🔒 **Không server, không upload.** Video của bạn không bao giờ rời khỏi máy. Toàn bộ giải mã, phân tích và mã hoá đều chạy bằng Web Audio API + WebAssembly ngay trong tab trình duyệt.

## Tính năng

- **Tải video** bằng kéo–thả hoặc chọn tệp (MP4, WebM, MOV, MKV…)
- **Phát hiện im lặng** bằng RMS/dBFS theo khung 20 ms, có thể tinh chỉnh:
  - Ngưỡng âm lượng (dB)
  - Độ dài khoảng lặng tối thiểu
  - Đệm (padding) trước/sau mỗi đoạn nói để không cụt tiếng
  - Độ dài đoạn giữ tối thiểu (lọc tiếng động lạ)
- **Timeline trực quan**: dạng sóng màu, vùng giữ (xanh) / vùng cắt (đỏ), đường ngưỡng, con trỏ phát; bấm để tua
- **Xem trước tức thì**: video tự động nhảy qua các khoảng lặng, kèm thống kê thời lượng tiết kiệm được
- **Xuất video** bằng 2 công cụ:
  - **FFmpeg.wasm** → MP4 (H.264/AAC), chỉnh CRF & preset
  - **MediaRecorder** → WebM, ghi theo thời gian thực, nhẹ và nhanh

## Chạy thử

Mở trực tiếp `index.html`, hoặc chạy một static server bất kỳ:

```bash
git clone https://github.com/xtapo/video-silence-remover.git
cd video-silence-remover
python3 -m http.server 8080
# mở http://localhost:8080
```

Không cần build, không cần cài dependency (FFmpeg.wasm được nạp từ CDN unpkg khi bạn bấm xuất MP4).

### GitHub Pages

Repo đã kèm workflow `.github/workflows/pages.yml`. Vào **Settings → Pages → Build and deployment → Source: GitHub Actions** là site sẽ có tại:

```
https://xtapo.github.io/video-silence-remover/
```

## Cách hoạt động

1. `File` → `AudioContext.decodeAudioData()` giải mã toàn bộ track âm thanh trong bộ nhớ.
2. Tính RMS mỗi khung 20 ms → chuyển sang dBFS → đường bao âm lượng.
3. Khung có mức > ngưỡng = "có tiếng"; gộp các đoạn có tiếng cách nhau ngắn hơn `minSilence`, thêm padding, lọc đoạn quá ngắn → danh sách **đoạn giữ lại**.
4. Xem trước: `<video>` tự tua tới đoạn giữ kế tiếp.
5. Xuất: FFmpeg.wasm dùng bộ lọc `select`/`aselect` với biểu thức `between(t,a,b)+…` rồi `setpts`/`asetpts` để nối liền các đoạn.

## Mẹo dùng

| Tình huống | Gợi ý |
|---|---|
| Có tiếng ồn nền (quạt, điều hoà) | Nâng ngưỡng lên −30 … −25 dB |
| Thu âm rất sạch | Hạ ngưỡng xuống −50 … −45 dB |
| Bị cụt đầu/cuối từ | Tăng padding lên 0.15–0.25 s |
| Video vẫn giật cục | Tăng "độ dài im lặng tối thiểu" lên 0.8–1.0 s |
| Video dài (>30 phút) | Dùng preset `ultrafast`, hoặc chọn MediaRecorder |

## Giới hạn

- Toàn bộ audio được giải mã vào RAM → video rất dài (nhiều giờ, 4K) có thể chiếm nhiều bộ nhớ.
- FFmpeg.wasm bản single-thread nên mã hoá chậm hơn FFmpeg gốc vài lần.
- MediaRecorder ghi theo thời gian thực (video 10 phút → mất ~10 phút) và chỉ xuất WebM.
- Codec lạ (một số MKV/AV1) có thể không giải mã được bởi trình duyệt.

## Giấy phép

MIT — xem [LICENSE](LICENSE).
