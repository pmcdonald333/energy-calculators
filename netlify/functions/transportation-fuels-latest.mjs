// netlify/functions/transportation-fuels-latest.mjs
//
// Latest-only Transportation Fuels (PRS-only):
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
// - Multi-window fallback (26w -> 52w -> 104w) if latest week cannot be determined
//
// Tightening:
// - Latest week chosen from rows with numeric values
// - Deduplicate output rows by (geo_code, fuel, period)
//
// IMPORTANT FOR UI PIPELINE:
// - Always emit dataset="transportation_fuels_latest"
// - Always emit sector="Residential"
// - Always emit fuel exactly "Diesel" or "Gasoline"

import { loadAndValidateGeoConfigs } from "./_lib/config-validators.js";

function jsonResponse(status, obj, { extraHeaders = {} } = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...extraHeaders
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
  // Period strings are YYYY-MM-DD; lexicographic compare works.
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

async function fetchJsonWithRetry(url, { tries = 4, baseDelayMs = 600 } = {}) {
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

  // PRS-only
  params.append("facets[process][]", "PRS");

  // Products
  for (const p of products) params.append("facets[product][]", p);

  // Duoareas (chunked)
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

async function fetchAllChunks({ apiKey, start, duoareas, products, chunkSize }) {
  const duoareaChunks = chunkArray(duoareas, chunkSize);

  const allRows = [];
  const urls = [];

  for (const chunk of duoareaChunks) {
    const url = buildPetroleumGndUrl({ apiKey, duoareas: chunk, products, start });
    urls.push(url);

    const json = await fetchJsonWithRetry(url, { tries: 4, baseDelayMs: 600 });
    const rows = Array.isArray(json?.response?.data) ? json.response.data : [];
    allRows.push(...rows);
  }

  return { allRows, urls, duoareaChunks };
}

export default async (request) => {
  try {
    const apiKey = ensureEnv("EIA_API_KEY");

    const baseUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || originFromRequest(request);
    if (!baseUrl) {
      throw new Error("Could not determine baseUrl (process.env.URL missing and request origin unavailable).");
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

    const PRODUCTS = ["EPD2DXL0", "EPMR"]; // diesel + gasoline
    const fuelNameByProduct = {
      EPD2DXL0: "Diesel",
      EPMR: "Gasoline"
    };

    // Smaller chunk size = fewer EIA 500s in practice
    const DUOAREA_CHUNK_SIZE = 12;

    // Multi-window fallback if EIA returns no usable numeric values
    const WEEKS_BACK_CANDIDATES = [26, 52, 104];

    let chosenStart = null;
    let chosenLatestWeek = null;
    let chosenRows = [];
    let chosenUrls = [];
    let chosenChunks = [];

    for (const weeksBack of WEEKS_BACK_CANDIDATES) {
      const start = startForWeeksBack(weeksBack);

      const { allRows, urls, duoareaChunks } = await fetchAllChunks({
        apiKey,
        start,
        duoareas: accept.accepted_duoarea_petroleum_gnd,
        products: PRODUCTS,
        chunkSize: DUOAREA_CHUNK_SIZE
      });

      const prs = allRows.filter((r) => r && r.process === "PRS" && PRODUCTS.includes(r.product));
      const prsWithValue = prs.filter((r) => toNumberOrNull(r?.value) !== null);

      const latestWeek = pickLatestPeriod(prsWithValue);

      if (latestWeek) {
        chosenStart = start;
        chosenLatestWeek = latestWeek;
        chosenRows = prs.filter((r) => String(r.period) === latestWeek);
        chosenUrls = urls;
        chosenChunks = duoareaChunks;
        break;
      }
    }

    if (!chosenLatestWeek) {
      // Keep message short; include last attempted start
      const lastStart = startForWeeksBack(WEEKS_BACK_CANDIDATES[WEEKS_BACK_CANDIDATES.length - 1]);
      throw new Error(
        `EIA_GND_NO_DATA: could not determine latest weekly period (tried starts: ${WEEKS_BACK_CANDIDATES
          .map((w) => startForWeeksBack(w))
          .join(", ")}; last=${lastStart})`
      );
    }

    const out = [];
    for (const r of chosenRows) {
      const duoarea = String(r.duoarea).trim();
      const geo_code = duoToGeo[duoarea] || null;
      if (!geo_code) continue;

      const product = String(r.product).trim();
      const fuel = (fuelNameByProduct[product] || product).trim();

      out.push({
        dataset: "transportation_fuels_latest",
        fuel,
        sector: "Residential",
        geo_code,
        geo_display_name: (names[geo_code] || geo_code).trim(),
        period: String(r.period).trim(),
        price: toNumberOrNull(r.value),
        price_units: r.units ? String(r.units).trim() : null,
        source_route: "petroleum/pri/gnd (weekly)",
        source_series: r.series ? String(r.series).trim() : null
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
      latest: { petroleum_week: chosenLatestWeek },
      windows: { petroleum_start: chosenStart },
      sources: { petroleum_gnd_urls: chosenUrls.map(redactApiKeyFromUrlString) },
      counts: {
        petroleum_chunks: chosenChunks.length,
        petroleum_rows_latest_period: chosenRows.length,
        output_rows: deduped.length
      },
      rows: deduped
    });
  } catch (err) {
    const msg = redactApiKeyFromUrlString(String(err?.message || err));
    return jsonResponse(500, { ok: false, error: msg });
  }
};
