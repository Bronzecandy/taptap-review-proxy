# TapTap Proxy (Railway)

Proxy nhẹ gọi TapTap API cho Sourcing BE. Deploy trên **Railway** free tier (~$1 credit/tháng).

## Giữ service online (tránh cold start / timeout)

1. **Trong app (mặc định bật)** — `KEEP_ALIVE_INTERVAL_MS=240000` (4 phút) tự gọi `GET /health`. Cần biến public URL:
   - Railway tự set `RAILWAY_PUBLIC_DOMAIN`, hoặc
   - Set `PUBLIC_URL=https://your-service.up.railway.app`

2. **Ping ngoài (khuyên dùng thêm, miễn phí)** — Nếu vẫn sleep, dùng [cron-job.org](https://cron-job.org) hoặc UptimeRobot ping `GET /health` mỗi **5 phút** (không tốn CPU trên Railway).

3. **Tối ưu credit**
   - `KEEP_ALIVE_INTERVAL_MS=300000` (5 phút) nếu 4 phút vẫn ổn
   - Một replica (`railway.toml`)
   - Không bật log verbose

## Biến môi trường

| Biến | Mô tả |
|------|--------|
| `API_KEY` | Khớp `TAPTAP_PROXY_KEY` trên BE |
| `KEEP_ALIVE_INTERVAL_MS` | Chu kỳ self-ping ms; `0` = tắt |
| `PUBLIC_URL` | URL public (nếu không dùng Railway domain) |

## BE

```env
TAPTAP_PROXY_URL=https://xxx.up.railway.app
TAPTAP_PROXY_KEY=...
```
