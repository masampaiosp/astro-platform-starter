// netlify/functions/smoke.js
// Full version with reliability, content, header, API and performance checks

const DEFAULTS = { paths: ["/"], timeoutMs: 8000, userAgent: "SmokeTester/1.0 (+netlify)" };

function joinUrl(base, path) {
  if (!path || path === "/") return base + "/";
  try { return new URL(path, base).toString(); }
  catch { return base + (path.startsWith("/") ? path : "/" + path); }
}

async function timedFetch(url, { timeoutMs, headers }) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { redirect: "follow", headers, signal: controller.signal });
    const buf = await res.arrayBuffer();
    const text = (() => {
      try {
        const decoder = new TextDecoder("utf-8", { fatal: false });
        const slice = new Uint8Array(buf.slice(0, 64 * 1024));
        return decoder.decode(slice);
      } catch { return null; }
    })();
    return { ok: res.ok, status: res.status, timeMs: Date.now() - t0, bytes: buf.byteLength, finalUrl: res.url, headers: Object.fromEntries(res.headers), text, error: null };
  } catch (err) {
    return { ok: false, status: null, timeMs: Date.now() - t0, bytes: null, finalUrl: null, headers: {}, text: null, error: err.name === "AbortError" ? `timeout ${timeoutMs}ms` : (err.message || "error") };
  } finally { clearTimeout(id); }
}

function json(statusCode, data, extraHeaders = {}) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...extraHeaders },
    body: JSON.stringify(data)
  };
}

async function notifySlack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  } catch {}
}

async function mapPool(items, limit, worker) {
  const out = [];
  const running = new Set();
  async function run(i) {
    const p = worker(items[i]).then(v => out[i] = v).finally(() => running.delete(p));
    running.add(p);
    if (running.size >= limit) await Promise.race(running);
  }
  for (let i = 0; i < items.length; i++) await run(i);
  await Promise.all([...running]);
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
      },
      body: ""
    };
  }

  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const baseUrl = body.baseUrl;
    const paths = Array.isArray(body.paths) && body.paths.length ? body.paths : DEFAULTS.paths;
    const timeoutMs = typeof body.timeoutMs === "number" ? Math.max(1000, Math.min(body.timeoutMs, 30000)) : DEFAULTS.timeoutMs;
    const expectContains = body.expectContains ? String(body.expectContains) : null;
    const requireHeaders = Array.isArray(body.requireHeaders) ? body.requireHeaders.map(h => h.toLowerCase()) : [];
    const expectJsonKeys = Array.isArray(body.expectJsonKeys) ? body.expectJsonKeys : [];
    const warnOverMs = body.warnOverMs || 1500;
    const auth = body.authorization ? String(body.authorization) : null;
    const cookie = body.cookie ? String(body.cookie) : null;

    if (!baseUrl) return json(400, { error: "baseUrl required" });

    let origin;
    try { origin = new URL(baseUrl).origin; }
    catch { return json(400, { error: "invalid baseUrl" }); }

    const headers = { "User-Agent": DEFAULTS.userAgent, "Accept": "*/*" };
    if (auth) headers["Authorization"] = auth;
    if (cookie) headers["Cookie"] = cookie;

    const startedAt = new Date().toISOString();

    const results = await mapPool(paths, 5, async (p) => {
      const url = joinUrl(origin, p);
      const r = await timedFetch(url, { timeoutMs, headers });
      r.endpoint = p;

      // Content keyword check
      if (expectContains && r.text && !r.text.toLowerCase().includes(expectContains.toLowerCase())) {
        r.ok = false;
        r.error = (r.error ? r.error + " | " : "") + `missing text: "${expectContains}"`;
      }

      // Required headers
      for (const h of requireHeaders) {
        if (!Object.keys(r.headers).map(x => x.toLowerCase()).includes(h)) {
          r.ok = false;
          r.error = (r.error ? r.error + " | " : "") + `missing header: ${h}`;
        }
      }

      // JSON shape check
      if (expectJsonKeys.length && r.text && (r.headers["content-type"] || "").includes("json")) {
        try {
          const obj = JSON.parse(r.text);
          for (const key of expectJsonKeys) {
            if (!(key in obj)) {
              r.ok = false;
              r.error = (r.error ? r.error + " | " : "") + `json missing key: ${key}`;
            }
          }
        } catch { r.ok = false; r.error = "invalid JSON"; }
      }

      // Latency warning
      if (r.ok && r.timeMs > warnOverMs) r.warn = `slow: ${r.timeMs}ms`;

      return r;
    });

    // sitemap.xml quick check
    const sitemapUrl = joinUrl(origin, "/sitemap.xml");
    const sitemap = await timedFetch(sitemapUrl, { timeoutMs, headers });
    if (!sitemap.ok || !sitemap.text?.includes("<urlset")) {
      results.push({ endpoint: "/sitemap.xml", status: sitemap.status, ok: false, error: "invalid sitemap" });
    }

    // manifest.json quick check
    const manifestUrl = joinUrl(origin, "/manifest.json");
    const manifest = await timedFetch(manifestUrl, { timeoutMs, headers });
    if (!manifest.ok) {
      results.push({ endpoint: "/manifest.json", status: manifest.status, ok: false, error: "manifest missing" });
    }

    const durationMs = results.reduce((acc, r) => Math.max(acc, r.timeMs || 0), 0);
    const fails = results.filter(r => !r.ok);
    if (fails.length) {
      const summary = fails.map(f => `• ${f.endpoint}: ${f.status ?? 'no-status'} ${f.error ? '— '+f.error : ''}`).join('\n');
      await notifySlack(`🚨 Smoke failed on ${origin}\n${summary}`);
    }

    return json(200, { baseUrl: origin, startedAt, durationMs, results });
  } catch (e) {
    return json(500, { error: e.message || "unknown error" });
  }
};
