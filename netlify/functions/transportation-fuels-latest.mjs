// netlify/functions/transportation-fuels-latest.mjs
//
// Latest-only Transportation Fuels:
// - Petroleum weekly (gnd): Diesel (EPD2DXL0) + Gasoline (EPMR)
//
// Uses locked configs in public/:
// - geo_accept_lists_v1.json
// - geo_display_names_v1.json
// - geo_fallback_map_v1.json
//
// Hardening:
// - Never leak api_key (redact in outputs + errors)
// - Chunk duoarea facet queries to avoid EIA 500s
// - Retry transient 5xx
//
// Tightening:
// - Latest week chosen from rows with numeric values
// - Deduplicate output rows by (geo_code, fuel, period)

import { loadAndValidateGeoConfigs } from "./_lib/config-validators.js";

function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

function ensureEnv(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === "") throw new Error(`Missing required env var: ${name}`);
  return v;
}

function originFromRequest(req) {
  try {
    return new URL(req.url).origin;
  } catch {
    return null;
  }
}

function toNumberOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t === "" || t.toLowerCase() === "null") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function pickLatestPeriod(rows) {
  let best = null;
  for (const r of rows) {
    if (!r?.period) continue;
    const p = String(r.period);
    if (best === null || p > best) best = p;
  }
  return best;
}

function redactApiKeyFromUrlString(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.has("api_key")) u.searchParams.set("api_key", "REDACTED");
    return u.toString();
  } catch {
    return String(url).replace(/api_key=[^&]+/g, "api_key=REDACTED");
  }
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function startForWeeksBack(weeksBack) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - weeksBack * 7);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function fetchJsonWithRetry(url, { tries = 3, baseDelayMs = 400 } = {}) {
  let lastText = "";
  for (let attempt = 1; attempt <= tries; attempt++) {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.ok) return res.json();

    lastText = await res.text().catch(() => "");
    if (res.status >= 500 && res.status <= 599 && attempt < tries) {
      await sleep(baseDelayMs * attempt);
      continue;
    }

    throw new Error(
      `EIA fetch failed (${res.status}) for ${redactApiKeyFromUrlString(url)}. Body: ${String(
        lastText
      ).slice(0, 200)}`
    );
  }

  throw new Error(
    `EIA fetch failed for ${redactApiKeyFromUrlString(url)}. Body: ${String(lastText).slice(0, 200)}`
  );
}

function buildPetroleumGndUrl({ apiKey, duoareas, products, start }) {
  const base = "https://api.eia.gov/v2/petroleum/pri/gnd/data/";
  const params = new URLSearchParams();
  params.set("api_key", apiKey);
  params.set("frequency", "weekly");
  params.set("data[0]", "value");

  // NOTE: DO NOT set facets[process] here.
  // petroleum/pri/gnd does not behave like PRS/PWR endpoints.

  for (const p of products) params.append("facets[product][]", p);
  for (const d of duoareas) params.append("facets[duoarea][]", d);

  params.set("start", start);

  params.set("sort[0][column]", "period");
  params.set("sort[0][direction]", "desc");
  params.set("sort[1][column]", "duoarea");
  params.set("sort[1][direction]", "asc");
  params.set("sort[2][column]", "product");
  params.set("sort[2][direction]", "asc");

  params.set("offset", "0");
  params.set("length", "5000");

  return `${base}?${params.toString()}`;
}

function assertMappingCoverage({ acceptedDuoareas, duoToGeo, label }) {
  const missing = [];
  for (const d of acceptedDuoareas) {
    if (!duoToGeo[d]) missing.push(d);
  }
  if (missing.length) {
    throw new Error(
      `CONFIG_VALIDATION_FAILED: ${label}: duoarea_to_geo_code missing keys: ${missing.join(", ")}`
    );
  }
}

function dedupeLatestRows(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.geo_code}|${r.fuel}|${r.period}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, r);
      continue;
    }
    const prevHas = prev.price !== null && prev.price !== undefined;
    const curHas = r.price !== null && r.price !== undefined;
    if (!prevHas && curHas) byKey.set(key, r);
  }
  return Array.from(byKey.values());
}

export default async (request) => {
  try {
    const apiKey = ensureEnv("EIA_API_KEY");

    const baseUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || originFromRequest(request);
    if (!baseUrl) {
      throw new Error(
        "Could not determine baseUrl (process.env.URL missing and request origin unavailable)."
      );
    }

    const cfg = await loadAndValidateGeoConfigs({ baseUrl });

    const accept = cfg.geo_accept_lists_v1;
    const names = cfg.geo_display_names_v1.geo_display_names;
    const duoToGeo = accept.duoarea_to_geo_code;

    assertMappingCoverage({
      acceptedDuoareas: accept.accepted_duoarea_petroleum_gnd,
      duoToGeo,
      label: "transportation-fuels-latest petroleum_gnd"
    });

    // 26 weeks back is a good default; keep as-is.
    const start = startForWeeksBack(26);

    const PRODUCTS = ["EPD2DXL0", "EPMR"]; // locked: diesel + gasoline
    const fuelNameByProduct = {
      EPD2DXL0: "Diesel",
      EPMR: "Gasoline"
    };

    // Chunking to avoid EIA 500s
    const DUOAREA_CHUNK_SIZE = 15;
    const duoareaChunks = chunkArray(accept.accepted_duoarea_petroleum_gnd, DUOAREA_CHUNK_SIZE);

    const allRows = [];
    const urls = [];

    for (const chunk of duoareaChunks) {
      const url = buildPetroleumGndUrl({ apiKey, duoareas: chunk, products: PRODUCTS, start });
      urls.push(url);

      const json = await fetchJsonWithRetry(url, { tries: 3, baseDelayMs: 450 });
      const rows = Array.isArray(json?.response?.data) ? json.response.data : [];
      allRows.push(...rows);
    }

    // Filter only the products we care about.
    // NOTE: do NOT filter on process here.
    const filtered = allRows.filter((r) => r && PRODUCTS.includes(r.product));

    // Tightening: choose latest week from rows with numeric values
    const withValue = filtered.filter((r) => toNumberOrNull(r?.value) !== null);
    const latestWeek = pickLatestPeriod(withValue);
    if (!latestWeek) {
      throw new Error(`EIA_GND_NO_DATA: could not determine latest weekly period (start=${start})`);
    }

    const latestRows = filtered.filter((r) => String(r.period) === latestWeek);

    const out = [];
    for (const r of latestRows) {
      const duoarea = String(r.duoarea);
      const geo_code = duoToGeo[duoarea] || null;
      if (!geo_code) continue;

      out.push({
        fuel: fuelNameByProduct[String(r.product)] || String(r.product),
        sector: null, // Transportation fuels are not PRS-residential
        geo_code,
        geo_display_name: names[geo_code] || geo_code,
        period: String(r.period),
        price: toNumberOrNull(r.value),
        price_units: r.units || null, // typically $/GAL
        source_route: "petroleum/pri/gnd (weekly)",
        source_series: r.series || null,
        source_process: r.process || null // keep for debugging if EIA includes it
      });
    }

    const deduped = dedupeLatestRows(out);

    // Deterministic sort
    deduped.sort((a, b) => {
      if (a.fuel !== b.fuel) return a.fuel < b.fuel ? -1 : 1;
      if (a.geo_code !== b.geo_code) return a.geo_code < b.geo_code ? -1 : 1;
      if (a.period !== b.period) return a.period > b.period ? -1 : 1; // DESC
      return 0;
    });

    return jsonResponse(200, {
      ok: true,
      generated_at: new Date().toISOString(),
      latest: { petroleum_week: latestWeek },
      windows: { petroleum_start: start },
      sources: { petroleum_gnd_urls: urls.map(redactApiKeyFromUrlString) },
      counts: {
        petroleum_chunks: duoareaChunks.length,
        petroleum_rows_fetched_total: allRows.length,
        petroleum_rows_filtered_products: filtered.length,
        petroleum_rows_latest_period: latestRows.length,
        output_rows: deduped.length
      },
      rows: deduped
    });
  } catch (err) {
    const msg = redactApiKeyFromUrlString(String(err?.message || err));
    return jsonResponse(500, { ok: false, error: msg });
  }
};
