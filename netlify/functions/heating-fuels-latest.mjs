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
// Returns a compact normalized response keyed by geo_code.
//
// Tightening additions (runtime):
//  1) FAIL if latest period cannot be determined (empty dataset)
//  2) FAIL if any accepted duoarea is missing from duoarea_to_geo_code mapping
//  3) Query PRS + relevant products at the API level (less data, fewer surprises)

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
    throw new Error(`CONFIG_VALIDATION_FAILED: ${label}: duoarea_to_geo_code missing keys: ${missing.join(", ")}`);
  }
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

  // duoareas (explicit accept-list)
  for (const d of acceptedDuoareas) params.append("facets[duoarea][]", d);

  // start date
  params.set("start", start); // e.g., "2025-10-01"

  // deterministic sorting (latest first, stable grouping)
  params.set("sort[0][column]", "period");
  params.set("sort[0][direction]", "desc");
  params.set("sort[1][column]", "duoarea");
  params.set("sort[1][direction]", "asc");
  params.set("sort[2][column]", "product");
  params.set("sort[2][direction]", "asc");

  // large enough
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
  params.set("start", start); // e.g., "2025-10"

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

    // Base URL for loading /geo_*.json from your published site root.
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

    // Map duoarea -> geo_code (locked mapping layer)
    const duoToGeo = accept.duoarea_to_geo_code;

    // Tightening: ensure mapping coverage for every accepted duoarea used by this function
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

    // --- Petroleum WFR (weekly) ---
    const petroleumWfrUrl = buildPetroleumWfrUrl({
      apiKey,
      acceptedDuoareas: accept.accepted_duoarea_petroleum_wfr,
      start: "2025-10-01"
    });

    const petroleumWfr = await fetchJson(petroleumWfrUrl);
    const petroleumRows = Array.isArray(petroleumWfr?.response?.data)
      ? petroleumWfr.response.data
      : [];

    // Query is PRS-only + products filtered, but keep small safety filter.
    const PETRO_FUELS = new Set(["EPD2F", "EPLLPA"]);
    const petroleumPRS = petroleumRows.filter(
      (r) => r && r.process === "PRS" && PETRO_FUELS.has(r.product)
    );

    const latestPetroleumWeek = pickLatestPeriod(petroleumPRS);
    if (!latestPetroleumWeek) throw new Error("EIA_WFR_NO_DATA: could not determine latest weekly period");

    const petroleumLatest = petroleumPRS.filter(
      (r) => String(r.period) === latestPetroleumWeek
    );

    // --- Natural Gas (monthly) ---
    const naturalGasUrl = buildNaturalGasSumUrl({
      apiKey,
      acceptedDuoareas: accept.accepted_duoarea_natural_gas,
      start: "2025-10"
    });

    const naturalGas = await fetchJson(naturalGasUrl);
    const ngRows = Array.isArray(naturalGas?.response?.data)
      ? naturalGas.response.data
      : [];

    // Query is PRS-only, but keep safety filter.
    const ngPRS = ngRows.filter((r) => r && r.process === "PRS");

    const latestNgMonth = pickLatestPeriod(ngPRS);
    if (!latestNgMonth) throw new Error("EIA_NG_NO_DATA: could not determine latest monthly period");

    const ngLatest = ngPRS.filter((r) => String(r.period) === latestNgMonth);

    // --- Normalize into one response ---
    // Canonical fuel display names locked earlier:
    const fuelNameByProduct = {
      EPD2F: "Heating Oil",
      EPLLPA: "Propane",
      EPG0: "Natural Gas"
    };

    const out = [];
    const pushRow = ({ source, period, duoarea, product, units, value, series }) => {
      const geo_code = duoToGeo[duoarea] || null;
      if (!geo_code) {
        // Should never happen due to tightening checks above.
        throw new Error(`INTERNAL_MAPPING_GAP: duoarea ${duoarea} missing in duoarea_to_geo_code`);
      }

      out.push({
        fuel: fuelNameByProduct[product] || product,
        sector: "Residential", // PRS-only in v1
        geo_code,
        geo_display_name: names[geo_code] || geo_code,
        period,
        // raw price: petroleum in $/GAL, natural gas in $/MCF
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

    // Deterministic sort for stable diffs:
    // fuel ASC, geo_code ASC, period DESC (so "latest" rows appear first within group even though all are latest)
    out.sort((a, b) => {
      if (a.fuel !== b.fuel) return a.fuel < b.fuel ? -1 : 1;
      if (a.geo_code !== b.geo_code) return a.geo_code < b.geo_code ? -1 : 1;
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
      sources: {
        petroleum_wfr_url: petroleumWfrUrl,
        natural_gas_url: naturalGasUrl
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
