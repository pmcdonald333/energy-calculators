// netlify/functions/energy-prices-latest-ui.mjs
//
// Step 5: UI-optimized compact matrix built from energy-prices-latest-with-fallback.
//
// Output:
// - meta: generated_at + latest + windows
// - geos: [{ geo_code, geo_display_name }]
// - fuels: [{ fuel_key, dataset, fuel, sector }]
// - values: values[fuel_key][geo_code] = { price, units, period, is_fallback, fallback_from_geo_code }

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

async function fetchJsonOrThrow(url) {
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

function stableSortStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function makeFuelKey(dataset, fuel, sector) {
  return `${dataset}::${fuel}::${sector}`;
}

export default async (request) => {
  try {
    const baseUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || originFromRequest(request);
    if (!baseUrl) {
      throw new Error(
        "Could not determine baseUrl (process.env.URL missing and request origin unavailable)."
      );
    }

    // Load geo configs (display names + canonical geo universe via fallback map keys)
    const cfg = await loadAndValidateGeoConfigs({ baseUrl });
    const names = cfg.geo_display_names_v1.geo_display_names;
    const fallbackChains = cfg.geo_fallback_map_v1.fallback_chain_by_geo_code;

    // Canonical geo list (61)
    const geoCodes = Object.keys(fallbackChains).slice().sort(stableSortStrings);
    const geos = geoCodes.map((geo_code) => ({
      geo_code,
      geo_display_name: names[geo_code] || geo_code
    }));

    // Pull the filled output from step 4
    const srcUrl = `${baseUrl}/.netlify/functions/energy-prices-latest-with-fallback`;
    const src = await fetchJsonOrThrow(srcUrl);

    if (!src?.ok) {
      throw new Error(`energy-prices-latest-with-fallback ok=false: ${String(src?.error || "unknown")}`);
    }

    const rows = Array.isArray(src?.rows_filled) ? src.rows_filled : [];

    // Fixed stable UI fuel order (based on what you’re actually shipping: combos=5)
    // NOTE: This is intentionally explicit so the UI ordering never changes.
    const CANONICAL_FUELS = [
      { dataset: "heating_fuels_latest", fuel: "Heating Oil", sector: "Residential" },
      { dataset: "heating_fuels_latest", fuel: "Propane", sector: "Residential" },
      { dataset: "heating_fuels_latest", fuel: "Natural Gas", sector: "Residential" },
      { dataset: "transportation_fuels_latest", fuel: "Diesel", sector: "Residential" },
      { dataset: "transportation_fuels_latest", fuel: "Gasoline", sector: "Residential" }
    ];

    const fuels = CANONICAL_FUELS.map((f) => ({
      fuel_key: makeFuelKey(f.dataset, f.fuel, f.sector),
      dataset: f.dataset,
      fuel: f.fuel,
      sector: f.sector
    }));

    const fuelKeys = fuels.map((f) => f.fuel_key);

    // Determine best period per fuel_key (should be one, but we’ll compute defensively)
    const bestPeriodByFuelKey = new Map();
    for (const r of rows) {
      const dataset = r?.dataset ? String(r.dataset) : null;
      const fuel = r?.fuel ? String(r.fuel) : null;
      const sector = r?.sector ? String(r.sector) : null;
      const period = r?.period ? String(r.period) : null;
      if (!dataset || !fuel || !sector || !period) continue;

      const fk = makeFuelKey(dataset, fuel, sector);
      const prev = bestPeriodByFuelKey.get(fk);
      if (!prev || period > prev) bestPeriodByFuelKey.set(fk, period);
    }

    // Initialize values matrix with null defaults (ensures every geo exists for every fuel)
    const values = {};
    for (const fk of fuelKeys) {
      values[fk] = {};
      for (const geo of geoCodes) {
        values[fk][geo] = {
          price: null,
          units: null,
          period: bestPeriodByFuelKey.get(fk) || null,
          is_fallback: true,
          fallback_from_geo_code: null
        };
      }
    }

    // Fill matrix using rows_filled, but only for each fuel_key’s best period
    for (const r of rows) {
      const dataset = r?.dataset ? String(r.dataset) : null;
      const fuel = r?.fuel ? String(r.fuel) : null;
      const sector = r?.sector ? String(r.sector) : null;
      const geo = r?.geo_code ? String(r.geo_code) : null;
      const period = r?.period ? String(r.period) : null;

      if (!dataset || !fuel || !sector || !geo || !period) continue;

      const fk = makeFuelKey(dataset, fuel, sector);
      if (!values[fk]) continue; // ignore anything outside the canonical 5 fuels

      const targetPeriod = bestPeriodByFuelKey.get(fk);
      if (targetPeriod && period !== targetPeriod) continue;

      values[fk][geo] = {
        price: r.price ?? null,
        units: r.price_units ?? null,
        period,
        is_fallback: !!r.is_fallback,
        fallback_from_geo_code: r.fallback_from_geo_code ?? null
      };
    }

    return jsonResponse(200, {
      ok: true,
      meta: {
        generated_at: new Date().toISOString(),
        latest: src.latest || null,
        windows: src.windows || null,
        counts: {
          fuels: fuels.length,
          geos: geos.length
        }
      },
      endpoints: {
        energy_prices_latest_ui: "/api/energy_prices_latest_ui.json"
      },
      geos,
      fuels,
      values
    });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: String(err?.message || err) });
  }
};
