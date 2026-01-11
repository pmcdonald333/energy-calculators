// netlify/functions/heating-fuels-latest.mjs
//
// Latest-only Heating Fuels (PRS-only):
// - Petroleum weekly (wfr): Heating Oil (EPD2F) + Propane (EPLLPA)
// - Natural gas monthly (sum): Natural Gas (EPG0), PRS-only
//
// Uses locked configs in public/:
// - geo_accept_lists_v1.json
// - geo_display_names_v1.json
// - geo_fallback_map_v1.json
//
// IMPORTANT:
// - Do NOT leak api_key in returned payloads (we redact it).
// - Use rolling time windows so "latest" is truly latest.

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

function toNumberOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t === "" || t.toLowerCase() === "null") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
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

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`EIA fetch failed (${res.status}) for ${url}. Body: ${body.slice(0, 200)}`);
  }
  return res.json();
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

function redactApiKey(url) {
  // Prevent leaking secrets in your response payload.
  const u = new URL(url);
  if (u.searchParams.has("api_key")) u.searchParams.set("api_key", "REDACTED");
  return u.toString();
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function startForWeeksBack(weeksBack) {
  // returns YYYY-MM-DD
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - weeksBack * 7);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function startForMonthsBack(monthsBack) {
  // returns YYYY-MM
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - monthsBack);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

// --- EIA query builders (kept explicit + deterministic) ---

function buildPetroleumWfrUrl({ apiKey, acceptedDuoareas, start }) {
  // Weekly heating oil + propane lives under petroleum/pri/wfr.
  // PRS-only + products filtered at the API level.
  const base = "https://api.eia.gov/v2/petroleum/pri/wfr/data/";
  const params = new URLSearchParams();
  params.set("api_key", apiKey);
  params.set("frequency", "weekly");
  params.set("data[0]", "value");

  // PRS-only
  params.append("facets[process][]", "PRS");

  // Only heating oil + propane
  params.append("facets[product][]", "EPD2F");
  params.append("facets[product][]", "EPLLPA");

  for (const d of acceptedDuoareas) params.append("facets[duoarea][]", d);

  params.set("start", start); // YYYY-MM-DD

  // deterministic sorting
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
  // Monthly natural gas prices live under natural-gas/pri/sum.
  // PRS-only filtered at the API level.
  const base = "https://api.eia.gov/v2/natural-gas/pri/sum/data/";
  const params = new URLSearchParams();
  params.set("api_key", apiKey);
  params.set("frequency", "monthly");
  params.set("data[0]", "value");

  // PRS-only
  params.append("facets[process][]", "PRS");

  for (const d of acceptedDuoareas) params.append("facets[duoarea][]", d);

  params.set("start", start); // YYYY-MM

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

export default async (request) => {
  try {
    const apiKey = ensureEnv("EIA_API_KEY");

    const baseUrl =
      process.env.URL || process.env.DEPLOY_PRIME_URL || originFromRequest(request);

    if (!baseUrl) {
      throw new Error(
        "Could not determine baseUrl (process.env.URL missing and request origin unavailable)."
      );
    }

    const cfg = await loadAndValidateGeoConfigs({ baseUrl });

    const accept = cfg.geo_accept_lists_v1;
    const names = cfg.geo_display_names_v1.geo_display_names;
    const duoToGeo = accept.duoarea_to_geo_code;

    // Tightening: mapping coverage
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

    // Rolling windows so "latest" is truly latest
    const petroleumStart = startForWeeksBack(26); // ~6 months
    const naturalGasStart = startForMonthsBack(24); // 2 years

    // --- Petroleum WFR (weekly) ---
    const petroleumWfrUrl = buildPetroleumWfrUrl({
      apiKey,
      acceptedDuoareas: accept.accepted_duoarea_petroleum_wfr,
      start: petroleumStart
    });

    const petroleumWfr = await fetchJson(petroleumWfrUrl);
    const petroleumRows = Array.isArray(petroleumWfr?.response?.data)
      ? petroleumWfr.response.data
      : [];

    // Safety filter (even though API query is filtered)
    const PETRO_FUELS = new Set(["EPD2F", "EPLLPA"]);
    const petroleumPRS = petroleumRows.filter(
      (r) => r && r.process === "PRS" && PETRO_FUELS.has(r.product)
    );

    const latestPetroleumWeek = pickLatestPeriod(petroleumPRS);
    if (!latestPetroleumWeek) {
      throw new Error(
        `EIA_WFR_NO_DATA: could not determine latest weekly period (start=${petroleumStart})`
      );
    }
    const petroleumLatest = petroleumPRS.filter(
      (r) => String(r.period) === latestPetroleumWeek
    );

    // --- Natural Gas (monthly) ---
    const naturalGasUrl = buildNaturalGasSumUrl({
      apiKey,
      acceptedDuoareas: accept.accepted_duoarea_natural_gas,
      start: naturalGasStart
    });

    const naturalGas = await fetchJson(naturalGasUrl);
    const ngRows = Array.isArray(naturalGas?.response?.data) ? naturalGas.response.data : [];

    const ngPRS = ngRows.filter((r) => r && r.process === "PRS");

    const latestNgMonth = pickLatestPeriod(ngPRS);
    if (!latestNgMonth) {
      throw new Error(
        `EIA_NG_NO_DATA: could not determine latest monthly period (start=${naturalGasStart})`
      );
    }
    const ngLatest = ngPRS.filter((r) => String(r.period) === latestNgMonth);

    // --- Normalize into one response ---
    const fuelNameByProduct = {
      EPD2F: "Heating Oil",
      EPLLPA: "Propane",
      EPG0: "Natural Gas"
    };

    const out = [];
    const pushRow = ({ source, period, duoarea, product, units, value, series }) => {
      const geo_code = duoToGeo[duoarea] || null;
      if (!geo_code) {
        throw new Error(`INTERNAL_MAPPING_GAP: duoarea ${duoarea} missing in duoarea_to_geo_code`);
      }

      out.push({
        fuel: fuelNameByProduct[product] || product,
        sector: "Residential", // PRS-only
        geo_code,
        geo_display_name: names[geo_code] || geo_code,
        period,
        price: toNumberOrNull(value),
        price_units: units || null,
        source_route: source,
        source_series: series || null
      });
    };

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

    // Deterministic sort
    out.sort((a, b) => {
      if (a.fuel !== b.fuel) return a.fuel < b.fuel ? -1 : 1;
      if (a.geo_code !== b.geo_code) return a.geo_code < b.geo_code ? -1 : 1;
      // period DESC
      if (a.period !== b.period) return a.period > b.period ? -1 : 1;
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
        petroleum_wfr_url: redactApiKey(petroleumWfrUrl),
        natural_gas_url: redactApiKey(naturalGasUrl)
      },
      counts: {
        petroleum_rows_latest_period: petroleumLatest.length,
        natural_gas_rows_latest_period: ngLatest.length,
        output_rows: out.length
      },
      rows: out
    });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: String(err?.message || err) });
  }
};
