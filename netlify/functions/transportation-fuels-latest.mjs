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
// - If newest weeks have no numeric values, step backwards to the most-recent week that does
// - Deduplicate output rows by (geo_code, fuel, period)
//
// IMPORTANT:
// - Unlike heating fuels, gnd does NOT reliably support PRS filtering.
//   Do NOT facet[process]=PRS; accept rows even if process is missing.

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

async function fetchJsonWithRetry(url, { tries = 3, baseDelayMs = 450 } = {}) {
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

  // Products
  for (const p of products) params.append("facets[product][]", p);

  // Duoareas (chunked)
  for (const d of duoareas) params.append("facets[duoarea][]", d);

  params.set("start", start);

  // deterministic sort
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

function pickMostRecentPeriodWithNumericValues(rows) {
  const periodsDesc = Array.from(
    new Set(rows.map((r) => (r?.period ? String(r.period) : null)).filter(Boolean))
  ).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0)); // DESC

  for (const p of periodsDesc) {
    const anyNumeric = rows.some((r) => String(r.period) === p && toNumberOrNull(r?.value) !== null);
    if (anyNumeric) return p;
  }
  return null;
}

function acceptGndRowProcess(processValue) {
  // gnd often returns no process, or process that isn't PRS.
  // We accept missing/empty OR PRS to avoid filtering out everything.
  if (processValue === null || processValue === undefined) return true;
  const s = String(processValue).trim();
  if (!s) return true;
  return s === "PRS";
}

export default async (request) => {
  try {
    ensureEnv("EIA_API_KEY");
    const apiKey = process.env.EIA_API_KEY;

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

    // Chunking to avoid EIA 500s
    const DUOAREA_CHUNK_SIZE = 15;
    const duoareaChunks = chunkArray(accept.accepted_duoarea_petroleum_gnd, DUOAREA_CHUNK_SIZE);

    // Adaptive lookback windows (weeks)
    const LOOKBACK_WEEKS = [26, 52, 104];
    const triedStarts = LOOKBACK_WEEKS.map((w) => startForWeeksBack(w));

    let chosenStart = null;
    let latestWeek = null;
    let latestRows = [];
    let urlsUsed = [];
    let fetchedTotal = 0;

    for (let i = 0; i < LOOKBACK_WEEKS.length; i++) {
      const start = triedStarts[i];
      const allRows = [];
      const urls = [];

      for (const chunk of duoareaChunks) {
        const url = buildPetroleumGndUrl({ apiKey, duoareas: chunk, products: PRODUCTS, start });
        urls.push(url);

        const json = await fetchJsonWithRetry(url, { tries: 3, baseDelayMs: 450 });
        const rows = Array.isArray(json?.response?.data) ? json.response.data : [];
        allRows.push(...rows);
      }

      fetchedTotal += allRows.length;

      // Filter to our products, and accept process if missing/empty (or PRS)
      const filtered = allRows.filter(
        (r) =>
          r &&
          PRODUCTS.includes(r.product) &&
          acceptGndRowProcess(r.process) &&
          r.period &&
          r.duoarea
      );

      const candidateWeek = pickMostRecentPeriodWithNumericValues(filtered);
      if (!candidateWeek) continue;

      chosenStart = start;
      latestWeek = candidateWeek;
      latestRows = filtered.filter((r) => String(r.period) === latestWeek);
      urlsUsed = urls;
      break;
    }

    if (!latestWeek) {
      throw new Error(
        `EIA_GND_NO_DATA: could not determine latest weekly period with numeric values (tried starts: ${triedStarts.join(
          ", "
        )}; last=${triedStarts[triedStarts.length - 1]})`
      );
    }

    const out = [];
    for (const r of latestRows) {
      const duoarea = String(r.duoarea);
      const geo_code = duoToGeo[duoarea] || null;
      if (!geo_code) continue;

      out.push({
        fuel: fuelNameByProduct[String(r.product)] || String(r.product),
        sector: "Residential", // UI label; gnd does not reliably provide process=PRS
        geo_code,
        geo_display_name: names[geo_code] || geo_code,
        period: String(r.period),
        price: toNumberOrNull(r.value),
        price_units: r.units || null,
        source_route: "petroleum/pri/gnd (weekly)",
        source_series: r.series || null
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
      windows: { petroleum_start: chosenStart },
      sources: { petroleum_gnd_urls: urlsUsed.map(redactApiKeyFromUrlString) },
      counts: {
        petroleum_chunks: duoareaChunks.length,
        petroleum_rows_fetched_total: fetchedTotal,
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
