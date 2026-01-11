// netlify/functions/energy-prices-latest-ui.mjs
//
// Step 5: UI-optimized compact matrix built from energy-prices-latest-with-fallback.
// Output is stable and easy for the UI to consume.

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
  if (!res.ok) throw new Error(`Internal fetch failed (${res.status}) for ${url}. Body: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Internal fetch returned invalid JSON for ${url}. Body: ${text.slice(0, 200)}`);
  }
}

function stableSortStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export default async (request) => {
  try {
    const baseUrl =
      process.env.URL || process.env.DEPLOY_PRIME_URL || originFromRequest(request);

    if (!baseUrl) {
      throw new Error("Could not determine baseUrl (process.env.URL missing and request origin unavailable).");
    }

    // Load geo configs (for display names + canonical geo universe)
    const cfg = await loadAndValidateGeoConfigs({ baseUrl });
    const names = cfg.geo_display_names_v1.geo_display_names;
    const fb = cfg.geo_fallback_map_v1.fallback_chain_by_geo_code;

    // Pull the filled rows (already rolled up)
    const srcUrl = `${baseUrl}/.netlify/functions/energy-prices-latest-with-fallback`;
    const src = await fetchInternalJson(srcUrl);
    if (!src?.ok) throw new Error(`energy-prices-latest-with-fallback ok=false: ${String(src?.error || "unknown")}`);

    const rows = Array.isArray(src?.rows_filled) ? src.rows_filled : [];

    // Canonical geos
    const geoCodes = Object.keys(fb).slice().sort(stableSortStrings);
    const geos = geoCodes.map((geo_code) => ({
      geo_code,
      geo_display_name: names[geo_code] || geo_code
    }));

    // Canonical fuels (derive from data, but make stable keys)
    // We'll key by dataset+fuel to avoid collisions if you ever reuse names.
    const fuelKeySet = new Set();
    for (const r of rows) {
      if (r?.dataset && r?.fuel) fuelKeySet.add(`${r.dataset}::${r.fuel}`);
    }
    const fuelKeys = Array.from(fuelKeySet).sort(stableSortStrings);

    const fuels = fuelKeys.map((k) => {
      const [dataset, fuel] = k.split("::");
      return { fuel_key: k, dataset, fuel };
    });

    // Build compact values matrix
    // Choose ONE period per fuel_key (the latest already enforced upstream).
    // If multiple periods show up, we pick the max lexicographically.
    const bestPeriodByFuelKey = new Map();
    for (const r of rows) {
      const fk = r?.dataset && r?.fuel ? `${r.dataset}::${r.fuel}` : null;
      const p = r?.period ? String(r.period) : null;
      if (!fk || !p) continue;
      const prev = bestPeriodByFuelKey.get(fk);
      if (!prev || p > prev) bestPeriodByFuelKey.set(fk, p);
    }

    const values = {}; // values[fuel_key][geo] = {...}
    for (const fk of fuelKeys) values[fk] = {};

    for (const r of rows) {
      const fk = r?.dataset && r?.fuel ? `${r.dataset}::${r.fuel}` : null;
      if (!fk) continue;

      const targetPeriod = bestPeriodByFuelKey.get(fk);
      if (!targetPeriod || String(r.period) !== targetPeriod) continue;

      const geo = String(r.geo_code || "");
      if (!geo) continue;

      values[fk][geo] = {
        price: r.price ?? null,
        units: r.price_units ?? null,
        period: String(r.period),
        is_fallback: !!r.is_fallback,
        fallback_from_geo_code: r.fallback_from_geo_code ?? null
      };
    }

    // Ensure every (fuel_key, geo) exists (even if null)
    for (const fk of fuelKeys) {
      for (const geo of geoCodes) {
        if (!values[fk][geo]) {
          values[fk][geo] = {
            price: null,
            units: null,
            period: bestPeriodByFuelKey.get(fk) || null,
            is_fallback: true,
            fallback_from_geo_code: null
          };
        }
      }
    }

    return jsonResponse(200, {
      ok: true,
      meta: {
        generated_at: new Date().toISOString(),
        latest: src.latest || null,
        windows: src.windows || null
      },
      geos,
      fuels,
      values
    });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: String(err?.message || err) });
  }
};
