// netlify/functions/energy-prices-latest-with-fallback.mjs
//
// Step 4: Apply fallback chains (geo_fallback_map_v1) to produce a complete grid.
//
// Input source:
//   - /.netlify/functions/energy-prices-latest   (already combined)
//
// Output:
//   - rows_filled: same row schema, but guaranteed to have a value for every geo_code
//                 when any value exists in that chain
//   - is_fallback + fallback_from_geo_code metadata
//
// Notes:
// - We do NOT re-fetch EIA here; we build off your combined endpoint.
// - We load + validate geo configs to get display names + fallback chains.
// - Deterministic ordering for stable diffs.

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

function originFromRequest(req) {
  try {
    return new URL(req.url).origin;
  } catch {
    return null;
  }
}

async function fetchInternalJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Internal fetch failed (${res.status}) for ${url}. Body: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Internal fetch returned invalid JSON for ${url}. Body: ${text.slice(0, 200)}`);
  }
}

function asRows(payload) {
  return Array.isArray(payload?.rows) ? payload.rows : [];
}

// key builder for row-value lookup
function kFuelPeriodGeo(fuel, period, geo) {
  return `${fuel}||${period}||${geo}`;
}

function stableRowSort(a, b) {
  if (a.dataset !== b.dataset) return a.dataset < b.dataset ? -1 : 1;
  if (a.fuel !== b.fuel) return a.fuel < b.fuel ? -1 : 1;
  if (a.geo_code !== b.geo_code) return a.geo_code < b.geo_code ? -1 : 1;
  if (a.period !== b.period) return a.period > b.period ? -1 : 1; // DESC
  return 0;
}

export default async (request) => {
  try {
    const baseUrl =
      process.env.URL || process.env.DEPLOY_PRIME_URL || originFromRequest(request);

    if (!baseUrl) {
      throw new Error("Could not determine baseUrl (process.env.URL missing and request origin unavailable).");
    }

    // Load configs (gives us display names + fallback chains; already validated)
    const cfg = await loadAndValidateGeoConfigs({ baseUrl });
    const geoNames = cfg.geo_display_names_v1.geo_display_names;
    const fb = cfg.geo_fallback_map_v1.fallback_chain_by_geo_code;

    // Fetch the combined latest output
    const combinedUrl = `${baseUrl}/.netlify/functions/energy-prices-latest`;
    const combined = await fetchInternalJson(combinedUrl);
    if (!combined?.ok) {
      throw new Error(`energy-prices-latest returned ok=false: ${String(combined?.error || "unknown")}`);
    }

    const rows = asRows(combined);

    // Build (fuel,period,geo)->row index for quick lookup
    // If duplicates exist, prefer a row with numeric price over null.
    const index = new Map();
    for (const r of rows) {
      if (!r) continue;
      const fuel = String(r.fuel || "");
      const period = String(r.period || "");
      const geo = String(r.geo_code || "");
      if (!fuel || !period || !geo) continue;

      const key = kFuelPeriodGeo(fuel, period, geo);
      const prev = index.get(key);

      if (!prev) {
        index.set(key, r);
        continue;
      }

      const prevHas = prev.price !== null && prev.price !== undefined;
      const curHas = r.price !== null && r.price !== undefined;
      if (!prevHas && curHas) index.set(key, r);
    }

    // Determine which (dataset,fuel,period) combos exist.
    // We fill for each combo across all geo codes in fallback map.
    const combos = new Map(); // comboKey -> { dataset, fuel, period, sector, price_units, source_route }
    for (const r of rows) {
      if (!r?.fuel || !r?.period || !r?.dataset) continue;
      const comboKey = `${r.dataset}||${r.fuel}||${r.period}`;
      if (!combos.has(comboKey)) {
        combos.set(comboKey, {
          dataset: r.dataset,
          fuel: r.fuel,
          period: r.period,
          sector: r.sector || null,
          price_units: r.price_units || null
        });
      }
    }

    const allGeoCodes = Object.keys(fb).slice().sort(); // canonical universe (61 keys)
    const filled = [];
    const stats = {
      combos: combos.size,
      geos: allGeoCodes.length,
      direct_hits: 0,
      fallback_hits: 0,
      still_missing: 0
    };

    for (const combo of combos.values()) {
      for (const targetGeo of allGeoCodes) {
        const directKey = kFuelPeriodGeo(combo.fuel, combo.period, targetGeo);
        const directRow = index.get(directKey);

        if (directRow && directRow.price !== null && directRow.price !== undefined) {
          stats.direct_hits += 1;
          filled.push({
            ...directRow,
            geo_display_name: geoNames[targetGeo] || targetGeo,
            is_fallback: false,
            fallback_from_geo_code: null
          });
          continue;
        }

        // Walk fallback chain: targetGeo -> ... -> US
        const chain = fb[targetGeo] || [targetGeo, "US"];
        let picked = null;
        let pickedFrom = null;

        for (const geoTry of chain) {
          const keyTry = kFuelPeriodGeo(combo.fuel, combo.period, geoTry);
          const rowTry = index.get(keyTry);
          if (rowTry && rowTry.price !== null && rowTry.price !== undefined) {
            picked = rowTry;
            pickedFrom = geoTry;
            break;
          }
        }

        if (picked) {
          stats.fallback_hits += 1;
          filled.push({
            ...picked,
            // overwrite to represent the target geo (the one we are filling)
            geo_code: targetGeo,
            geo_display_name: geoNames[targetGeo] || targetGeo,
            is_fallback: true,
            fallback_from_geo_code: pickedFrom
          });
        } else {
          stats.still_missing += 1;
          filled.push({
            dataset: combo.dataset,
            fuel: combo.fuel,
            sector: combo.sector,
            geo_code: targetGeo,
            geo_display_name: geoNames[targetGeo] || targetGeo,
            period: combo.period,
            price: null,
            price_units: combo.price_units,
            source_route: null,
            source_series: null,
            is_fallback: true,
            fallback_from_geo_code: null
          });
        }
      }
    }

    filled.sort(stableRowSort);

    return jsonResponse(200, {
      ok: true,
      generated_at: new Date().toISOString(),
      endpoints: {
        energy_prices_latest: "/api/energy_prices_latest.json",
        energy_prices_latest_with_fallback: "/api/energy_prices_latest_with_fallback.json"
      },
      latest: combined.latest || null,
      windows: combined.windows || null,
      counts: {
        input_rows: rows.length,
        output_rows_filled: filled.length,
        ...stats
      },
      rows_filled: filled
    });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: String(err?.message || err) });
  }
};
