// netlify/functions/heating-fuels-latest.mjs
//
// Latest-only Heating Fuels (PRS-only):
// - Petroleum weekly (wfr): Heating Oil (EPD2F) + Propane (EPLLPA)
// - Natural gas monthly (sum): Residential (PRS)
//
// Uses locked configs in public/:
// - geo_accept_lists_v1.json
// - geo_display_names_v1.json
// - geo_fallback_map_v1.json
//
// Hardening:
// - Never leak api_key (redact in outputs + errors)
// - Petroleum WFR calls are CHUNKED to avoid EIA 500s on huge facet queries
// - Retry transient EIA 5xx a few times
//
// Tightening additions (small):
// 1) Latest NG month chosen from rows that have a valid numeric value
// 2) Deduplicate output rows by (geo_code, fuel, period) deterministically

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
  // Period strings are YYYY-MM-DD or YYYY-MM; lexicographic compare works.
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

function startForMonthsBack(monthsBack) {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - monthsBack);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
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

// --- EIA query builders ---

function buildPetroleumWfrUrl({ apiKey, duoareas, start }) {
  const base = "https://api.eia.gov/v2/petroleum/pri/wfr/data/";
  const params = new URLSearchParams();
  params.set("api_key", apiKey);
  params.set("frequency", "weekly");
  params.set("data[0]", "value");

  params.append("facets[process][]", "PRS");
  params.append("facets[product][]", "EPD2F");
  params.append("facets[product][]", "EPLLPA");

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

function buildNaturalGasSumUrl({ apiKey, acceptedDuoareas, start }) {
  const base = "https://api.eia.gov/v2/natural-gas/pri/sum/data/";
  const params = new URLSearchParams();
  params.set("api_key", apiKey);
  params.set("frequency", "monthly");
  params.set("data[0]", "value");

  params.append("facets[process][]", "PRS");

  for (const d of acceptedDuoareas) params.append("facets[duoarea][]", d);

  params.set("start", start);

  params.set("sort[0][column]", "period");
  params.set("sort[0][direction]", "desc");
  params.set("sort[1][column]", "duoarea");
  params.set("sort[1][direction]", "asc");
  params.set("sort[2][column]", "series");
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
  // rows are already for a single latest period per fuel
  // Key: geo_code|fuel|period, keep first non-null price, else first row.
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
      throw new Error("Could not determine baseUrl (process.env.URL missing and request origin unavailable).");
    }

    const cfg = await loadAndValidateGeoConfigs({ baseUrl });

    const accept = cfg.geo_accept_lists_v1;
    const names = cfg.geo_display_names_v1.geo_display_names;
    const duoToGeo = accept.duoarea_to_geo_code;

    assertMappingCoverage({
      acceptedDuoareas: accept.accepted_duoarea_petroleum_wfr,
      duoToGeo,
      label: "heating-fuels-latest petroleum_wfr"
    });
    assertMappingCoverage({
      acceptedDuoareas: accept.accepted_duoarea_natural_gas,
      duoToGeo,
      label: "heating-fuels-latest natural_gas"
    });

    const petroleumStart = startForWeeksBack(26);
    const naturalGasStart = startForMonthsBack(24);

    // --- Petroleum WFR (weekly) CHUNKED ---
    const DUOAREA_CHUNK_SIZE = 15;
    const duoareaChunks = chunkArray(accept.accepted_duoarea_petroleum_wfr, DUOAREA_CHUNK_SIZE);

    const petroleumAllRows = [];
    const petroleumUrls = [];

    for (const chunk of duoareaChunks) {
      const url = buildPetroleumWfrUrl({ apiKey, duoareas: chunk, start: petroleumStart });
      petroleumUrls.push(url);

      const json = await fetchJsonWithRetry(url, { tries: 3, baseDelayMs: 450 });
      const rows = Array.isArray(json?.response?.data) ? json.response.data : [];
      petroleumAllRows.push(...rows);
    }

    const PETRO_FUELS = new Set(["EPD2F", "EPLLPA"]);
    const petroleumPRS = petroleumAllRows.filter(
      (r) => r && r.process === "PRS" && PETRO_FUELS.has(r.product)
    );

    const latestPetroleumWeek = pickLatestPeriod(petroleumPRS);
    if (!latestPetroleumWeek) {
      throw new Error(`EIA_WFR_NO_DATA: could not determine latest weekly period (start=${petroleumStart})`);
    }
    const petroleumLatest = petroleumPRS.filter((r) => String(r.period) === latestPetroleumWeek);

    // --- Natural Gas (monthly) ---
    const naturalGasUrl = buildNaturalGasSumUrl({
      apiKey,
      acceptedDuoareas: accept.accepted_duoarea_natural_gas,
      start: naturalGasStart
    });

    const naturalGas = await fetchJsonWithRetry(naturalGasUrl, { tries: 3, baseDelayMs: 450 });
    const ngRows = Array.isArray(naturalGas?.response?.data) ? naturalGas.response.data : [];

    const ngPRS = ngRows.filter((r) => r && r.process === "PRS");

    // Tightening #1: choose "latest" month from rows with a valid numeric value
    const ngPRSWithValue = ngPRS.filter((r) => toNumberOrNull(r?.value) !== null);
    const latestNgMonth = pickLatestPeriod(ngPRSWithValue);
    if (!latestNgMonth) {
      throw new Error(
        `EIA_NG_NO_DATA: could not determine latest monthly period with numeric values (start=${naturalGasStart})`
      );
    }
    const ngLatest = ngPRS.filter((r) => String(r.period) === latestNgMonth);

    // --- Normalize ---
    const fuelNameByProduct = {
      EPD2F: "Heating Oil",
      EPLLPA: "Propane",
      EPG0: "Natural Gas"
    };

    const out = [];

    function pushRow({ source, period, duoarea, product, units, value, series }) {
      const geo_code = duoToGeo[duoarea] || null;
      if (!geo_code) throw new Error(`INTERNAL_MAPPING_GAP: duoarea ${duoarea} missing in duoarea_to_geo_code`);
      out.push({
        fuel: fuelNameByProduct[product] || product,
        sector: "Residential",
        geo_code,
        geo_display_name: names[geo_code] || geo_code,
        period,
        price: toNumberOrNull(value),
        price_units: units || null,
        source_route: source,
        source_series: series || null
      });
    }

    for (const r of petroleumLatest) {
      pushRow({
        source: "petroleum/pri/wfr (weekly)",
        period: String(r.period),
        duoarea: String(r.duoarea),
        product: String(r.product),
        units: r.units || "$/GAL",
        value: r.value,
        series: r.series || null
      });
    }

    for (const r of ngLatest) {
      pushRow({
        source: "natural-gas/pri/sum (monthly)",
        period: String(r.period),
        duoarea: String(r.duoarea),
        product: "EPG0",
        units: r.units || "$/MCF",
        value: r.value,
        series: r.series || null
      });
    }

    // Tightening #2: dedupe by (geo_code, fuel, period)
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
      latest: {
        petroleum_week: latestPetroleumWeek,
        natural_gas_month: latestNgMonth
      },
      windows: {
        petroleum_start: petroleumStart,
        natural_gas_start: naturalGasStart
      },
      sources: {
        petroleum_wfr_urls: petroleumUrls.map(redactApiKeyFromUrlString),
        natural_gas_url: redactApiKeyFromUrlString(naturalGasUrl)
      },
      counts: {
        petroleum_chunks: duoareaChunks.length,
        petroleum_rows_fetched_total: petroleumAllRows.length,
        petroleum_rows_latest_period: petroleumLatest.length,
        natural_gas_rows_latest_period: ngLatest.length,
        output_rows: deduped.length
      },
      rows: deduped
    });
  } catch (err) {
    const msg = redactApiKeyFromUrlString(String(err?.message || err));
    return jsonResponse(500, { ok: false, error: msg });
  }
};
