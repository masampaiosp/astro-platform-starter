// netlify/functions/smoke.js  (Functions v1)
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
    return { ok: res.ok, status: res.status, timeMs: Date.now() - t0, bytes: buf.byteLength, finalUrl: res.url, error: null };
  } catch (err) {
    return { ok: false, status: null, timeMs: Date.now() - t0, bytes: null, finalUrl: null, error: err.name === "AbortError" ? `timeout ${timeoutMs}ms` : (err.message || "error") };
  } finally { clearTimeout(id); }
}

function json(statusCode, data, extraHeaders = {}) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...extraHeaders },
    body: JSON.stringify(data)
  };
}

exports.handler = async (event) => {
  // CORS / preflight
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
    let baseUrl, paths, timeoutMs;

    if (event.httpMethod === "GET") {
      const q = event.queryStringParameters || {};
      baseUrl = q.baseUrl;
      timeoutMs = Math.max(1000, Math.min(Number(q.timeoutMs) || DEFAULTS.timeoutMs, 30000));
      // múltiplos "path" podem vir como string única; normaliza:
      const raw = [].concat(q.path || []);
      paths = raw.length ? raw : DEFAULTS.paths;
    } else if (event.httpMethod === "POST") {
      const body = event.body ? JSON.parse(event.body) : {};
      baseUrl = body.baseUrl;
      timeoutMs = Math.max(1000, Math.min(Number(body.timeoutMs) || DEFAULTS.timeoutMs, 30000));
      paths = Array.isArray(body.paths) && body.paths.length ? body.paths : DEFAULTS.paths;
    } else {
      return json(405, { error: "Method not allowed" }, { "Allow": "GET, POST, OPTIONS" });
    }

    if (!baseUrl) return json(400, { error: "baseUrl obrigatório" });

    let origin;
    try { origin = new URL(baseUrl).origin; }
    catch { return json(400, { error: "baseUrl inválida" }); }

    const startedAt = new Date().toISOString();
    const headers = { "User-Agent": DEFAULTS.userAgent, "Accept": "*/*" };

    const results = await Promise.all(
      paths.map(async (p) => {
        const url = joinUrl(origin, p);
        const r = await timedFetch(url, { timeoutMs, headers });
        return { endpoint: p, ...r };
      })
    );
    const durationMs = results.reduce((acc, r) => Math.max(acc, r.timeMs || 0), 0);

    return json(200, { baseUrl: origin, startedAt, durationMs, results });
  } catch (e) {
    return json(500, { error: e.message || "unknown error" });
  }
};
