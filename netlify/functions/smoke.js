// netlify/functions/smoke.js
export const config = { path: "/.netlify/functions/smoke" };

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
  } finally {
    clearTimeout(id);
  }
}

export default async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: cors });

  try {
    const body = req.method === "POST" ? await req.json() : {};
    const baseUrl = body.baseUrl;
    const paths = Array.isArray(body.paths) && body.paths.length ? body.paths : DEFAULTS.paths;
    const timeoutMs = typeof body.timeoutMs === "number" ? Math.max(1000, Math.min(body.timeoutMs, 30000)) : DEFAULTS.timeoutMs;
    if (!baseUrl) return Response.json({ error: "baseUrl obrigatório" }, { status: 400, headers: cors });

    let origin;
    try { origin = new URL(baseUrl).origin; } catch { return Response.json({ error: "baseUrl inválida" }, { status: 400, headers: cors }); }

    const startedAt = new Date().toISOString();
    const headers = { "User-Agent": DEFAULTS.userAgent, "Accept": "*/*" };
    const jobs = paths.map(p => {
      const url = joinUrl(origin, p);
      return timedFetch(url, { timeoutMs, headers })
        .then(r => ({ endpoint: p, ...r }))
        .catch(e => ({ endpoint: p, status: null, timeMs: null, bytes: null, finalUrl: null, error: e.message || "error" }));
    });

    const results = await Promise.all(jobs);
    const durationMs = results.reduce((acc, r) => Math.max(acc, r.timeMs || 0), 0);
    return Response.json({ baseUrl: origin, startedAt, durationMs, results }, { status: 200, headers: { "Content-Type": "application/json", ...cors } });
  } catch (e) {
    return Response.json({ error: e.message || "unknown error" }, { status: 500, headers: cors });
  }
};
