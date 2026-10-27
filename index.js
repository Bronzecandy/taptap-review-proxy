import express from "express";
import cors from "cors";
import crypto from "crypto";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";

/** Ping /health định kỳ để tránh sleep (Railway free). Tắt: KEEP_ALIVE_INTERVAL_MS=0 */
const KEEP_ALIVE_MS = parseInt(process.env.KEEP_ALIVE_INTERVAL_MS ?? "240000", 10);

function resolvePublicBaseUrl() {
  if (process.env.PUBLIC_URL?.trim()) return process.env.PUBLIC_URL.trim().replace(/\/$/, "");
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (domain) return `https://${domain}`;
  return null;
}

function startKeepAlive() {
  if (!Number.isFinite(KEEP_ALIVE_MS) || KEEP_ALIVE_MS <= 0) {
    console.log("[keep-alive] disabled (KEEP_ALIVE_INTERVAL_MS=0)");
    return;
  }
  const base = resolvePublicBaseUrl();
  if (!base) {
    console.log(
      "[keep-alive] skipped — set PUBLIC_URL or deploy on Railway (RAILWAY_PUBLIC_DOMAIN) for self-ping",
    );
    return;
  }
  const url = `${base}/health`;
  const headers = API_KEY ? { "x-api-key": API_KEY } : {};
  console.log(`[keep-alive] ping ${url} every ${KEEP_ALIVE_MS / 1000}s`);
  setInterval(async () => {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
      if (!res.ok) console.warn(`[keep-alive] ${res.status} ${res.statusText}`);
    } catch (e) {
      console.warn("[keep-alive] ping failed:", e instanceof Error ? e.message : e);
    }
  }, KEEP_ALIVE_MS);
}

// ─── Auth middleware ───
function authGuard(req, res, next) {
  if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ─── TapTap constants ───
const BASE_URL = "https://www.taptap.cn/webapiv2";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

const RATING_BUCKETS = [
  { label: "Very Negative", min: 1, max: 1 },
  { label: "Negative", min: 2, max: 2 },
  { label: "Mixed", min: 3, max: 3 },
  { label: "Positive", min: 4, max: 4 },
  { label: "Very Positive", min: 5, max: 5 },
];

const PAGE_SIZE = 10;
const CONCURRENT_PAGES = 15;
const BATCH_DELAY_MS = 400;
const MAX_OFFSET = 9900;

function buildXUA() {
  return `V=1&PN=WebApp&LANG=zh_CN&VN_CODE=102&LOC=CN&PLT=PC&DS=Android&UID=${crypto.randomUUID()}&OS=Windows&OSV=10&DT=PC`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function taptapGet(path, params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  qs.set("X-UA", buildXUA());

  const url = `${BASE_URL}/${path}?${qs.toString()}`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });

  if (!res.ok) {
    let body = "";
    try { body = await res.text(); } catch {}
    console.error(`[taptap] ${res.status} ${res.statusText} — ${body.slice(0, 300)}`);
    throw new Error(`TapTap API ${res.status}: ${res.statusText}`);
  }

  const json = await res.json();
  if (!json.data) throw new Error("TapTap API returned no data");
  return json.data;
}

// ─── App detail (full TapTap `app/v4/detail` payload) — BE dùng cho tag / developer / publisher trong prompt ───
async function fetchAppDetailRaw(appId) {
  return await taptapGet("app/v4/detail", { id: appId });
}

function appInfoFromDetail(data, appId) {
  const icon = data.icon;
  const stat = data.stat;
  const rating = stat?.rating;
  return {
    title: data.title ?? `App #${appId}`,
    iconUrl: icon?.url ?? icon?.medium_url ?? null,
    rating: rating?.score ?? null,
    fansCount: stat?.fans_count ?? null,
    reserveCount: stat?.reserve_count ?? null,
  };
}

async function fetchAppInfo(appId) {
  const data = await fetchAppDetailRaw(appId);
  return appInfoFromDetail(data, appId);
}

// ─── Bài đăng chính thức (公告/动态) — BE dùng để bắt lịch ra mắt / đợt test mới ───
async function fetchOfficialPosts(appId, limit) {
  const groupData = await taptapGet("group/v1/detail", { app_id: appId });
  const groupId = groupData?.group?.id;
  if (!groupId) return [];
  const feed = await taptapGet("feed/v7/by-group", { group_id: groupId, type: "official", limit });
  return (feed.list ?? [])
    .map((item) => item?.moment)
    .filter(Boolean)
    .map((m) => ({
      title: m.topic?.title ?? "",
      summary: m.topic?.summary ?? "",
      date: m.publish_time ? new Date(m.publish_time * 1000).toISOString().slice(0, 10) : null,
    }));
}

// ─── Fetch reviews ───
async function fetchPage(appId, from) {
  try {
    const data = await taptapGet("review/v2/list-by-app", {
      app_id: appId,
      sort: "new",
      from,
      limit: PAGE_SIZE,
    });
    return {
      list: data.list ?? [],
      nextPage: !!data.next_page,
      total: data.total ?? 0,
    };
  } catch {
    return null;
  }
}

function extractReview(item) {
  if (item.type !== "moment") return null;
  const moment = item.moment;
  if (!moment) return null;

  const review = moment.review;
  const contents = review?.contents;
  const text = contents?.text ?? moment.sharing?.description ?? "";
  if (text.length < 5) return null;

  const score = Math.round(Number(review?.score ?? 0));
  if (score < 1 || score > 5) return null;

  const bucket = RATING_BUCKETS.find((b) => score >= b.min && score <= b.max);
  if (!bucket) return null;

  const publishTime = moment.publish_time;
  const date = publishTime
    ? new Date(publishTime * 1000).toISOString().slice(0, 10)
    : "unknown";

  return { text, score, date, bucket: bucket.label };
}

async function fetchAllReviews(appId) {
  const allReviews = [];
  const bucketCounts = new Map();
  for (const b of RATING_BUCKETS) bucketCounts.set(b.label, 0);

  let from = 0;
  let totalScanned = 0;
  let apiTotal = Infinity;
  let reachedEnd = false;
  const startTime = Date.now();

  while (!reachedEnd) {
    const offsets = [];
    for (let i = 0; i < CONCURRENT_PAGES; i++) {
      const off = from + i * PAGE_SIZE;
      if (off < apiTotal && off <= MAX_OFFSET) offsets.push(off);
    }
    if (offsets.length === 0) break;

    const results = await Promise.all(offsets.map((off) => fetchPage(appId, off)));

    let anyData = false;
    for (const result of results) {
      if (!result || result.list.length === 0) {
        reachedEnd = true;
        continue;
      }
      anyData = true;
      apiTotal = result.total;
      if (!result.nextPage) reachedEnd = true;

      for (const item of result.list) {
        const rev = extractReview(item);
        if (rev) {
          allReviews.push(rev);
          bucketCounts.set(rev.bucket, (bucketCounts.get(rev.bucket) ?? 0) + 1);
        }
      }
      totalScanned += result.list.length;
    }

    if (!anyData) break;
    from += offsets.length * PAGE_SIZE;

    if (totalScanned % 500 === 0 || totalScanned >= apiTotal) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(
        `[taptap] appId=${appId}: scanned ${totalScanned}/${apiTotal}, collected ${allReviews.length} (${elapsed}s)`
      );
    }

    await sleep(BATCH_DELAY_MS);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `[taptap] appId=${appId}: DONE — ${allReviews.length} reviews from ${totalScanned} scanned in ${elapsed}s`
  );

  return allReviews;
}

// ─── Routes ───

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/app-info/:appId", authGuard, async (req, res) => {
  try {
    const appId = parseInt(req.params.appId, 10);
    if (isNaN(appId)) return res.status(400).json({ error: "Invalid appId" });
    const info = await fetchAppInfo(appId);
    res.json({ success: true, data: info });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

app.get("/api/detail/:appId", authGuard, async (req, res) => {
  try {
    const appId = parseInt(req.params.appId, 10);
    if (isNaN(appId)) return res.status(400).json({ error: "Invalid appId" });
    const detailRaw = await fetchAppDetailRaw(appId);
    res.json({ success: true, data: { appId, detailRaw, appInfo: appInfoFromDetail(detailRaw, appId) } });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

app.get("/api/official-posts/:appId", authGuard, async (req, res) => {
  try {
    const appId = parseInt(req.params.appId, 10);
    if (isNaN(appId)) return res.status(400).json({ error: "Invalid appId" });
    const limit = Math.min(20, Math.max(1, parseInt(String(req.query.limit ?? "10"), 10) || 10));
    const posts = await fetchOfficialPosts(appId, limit);
    res.json({ success: true, data: { appId, posts } });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

app.get("/api/reviews/:appId", authGuard, async (req, res) => {
  try {
    const appId = parseInt(req.params.appId, 10);
    if (isNaN(appId)) return res.status(400).json({ error: "Invalid appId" });

    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const keepAlive = setInterval(() => res.write(" "), 10_000);

    const reviews = await fetchAllReviews(appId);

    clearInterval(keepAlive);
    res.end(JSON.stringify({
      success: true,
      data: {
        appId,
        totalCollected: reviews.length,
        reviews,
      },
    }));
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

app.get("/api/full/:appId", authGuard, async (req, res) => {
  try {
    const appId = parseInt(req.params.appId, 10);
    if (isNaN(appId)) return res.status(400).json({ error: "Invalid appId" });

    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const keepAlive = setInterval(() => res.write(" "), 10_000);

    // Một lần app/v4/detail + reviews song song — đính kèm detailRaw để Sourcing BE (pickTapTapDetailFromProxyBundle) lấy 厂商/tags.
    const [detailRaw, reviews] = await Promise.all([
      fetchAppDetailRaw(appId),
      fetchAllReviews(appId),
    ]);
    const appInfo = appInfoFromDetail(detailRaw, appId);

    clearInterval(keepAlive);
    res.end(JSON.stringify({
      success: true,
      data: {
        appId,
        appInfo,
        detailRaw,
        totalCollected: reviews.length,
        reviews,
      },
    }));
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`TapTap Proxy running on port ${PORT}`);
  console.log(`Auth: ${API_KEY ? "enabled" : "disabled (set API_KEY to enable)"}`);
  startKeepAlive();
});
