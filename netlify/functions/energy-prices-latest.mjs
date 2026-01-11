// netlify/functions/energy-prices-latest.mjs
//
// Combined “latest-only” endpoint for v1 UI consumption.
// This endpoint composes the already-working building blocks:
//
//  - /.netlify/functions/heating-fuels-latest
//  - /.netlify/functions/transportation-fuels-latest
//
// Hardening:
// - Never leak api_key (we do not include it; we only relay already-redacted outputs)
// - Deterministic output shape
// - Clear debug counts
//
// Notes:
// - This does NOT re-fetch EIA directly; it calls your two existing functions.
//   That keeps logic single-sourced and easier to audit.

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
  } catch (e) {
    throw new Error(`Internal fetch returned invalid JSON for ${url}. Body: ${text.slice(0, 200)}`);
  }
}

function asRows(payload) {
  return Array.isArray(payload?.rows) ? payload.rows : [];
}

export default async (request) => {
  try {
    const baseUrl =
      process.env.URL || process.env.DEPLOY_PRIME_URL || originFromRequest(request);

    if (!baseUrl) {
      throw new Error("Could not determine baseUrl (process.env.URL missing and request origin unavailable).");
    }

    const heatingUrl = `${baseUrl}/.netlify/functions/heating-fuels-latest`;
    const transportUrl = `${baseUrl}/.netlify/functions/transportation-fuels-latest`;

    const [heating, transport] = await Promise.all([
      fetchInternalJson(heatingUrl),
      fetchInternalJson(transportUrl)
    ]);

    if (!heating?.ok) throw new Error(`heating-fuels-latest returned ok=false: ${String(heating?.error || "unknown")}`);
    if (!transport?.ok) throw new Error(`transportation-fuels-latest returned ok=false: ${String(transport?.error || "unknown")}`);

    // Optional: provide a flattened “rows” array for UI convenience
    // while also keeping the original payloads.
    const combinedRows = [
      ...asRows(heating).map((r) => ({ ...r, dataset: "heating_fuels_latest" })),
      ...asRows(transport).map((r) => ({ ...r, dataset: "transportation_fuels_latest" }))
    ];

    // Deterministic sort (dataset, fuel, geo_code, period DESC)
    combinedRows.sort((a, b) => {
      if (a.dataset !== b.dataset) return a.dataset < b.dataset ? -1 : 1;
      if (a.fuel !== b.fuel) return a.fuel < b.fuel ? -1 : 1;
      if (a.geo_code !== b.geo_code) return a.geo_code < b.geo_code ? -1 : 1;
      if (a.period !== b.period) return a.period > b.period ? -1 : 1; // DESC
      return 0;
    });

    return jsonResponse(200, {
      ok: true,
      generated_at: new Date().toISOString(),
      endpoints: {
        heating_fuels_latest: "/api/heating_fuels_latest.json",
        transportation_fuels_latest: "/api/transportation_fuels_latest.json",
        energy_prices_latest: "/api/energy_prices_latest.json"
      },
      latest: {
        heating: heating.latest || null,
        transportation: transport.latest || null
      },
      windows: {
        heating: heating.windows || null,
        transportation: transport.windows || null
      },
      counts: {
        heating_rows: asRows(heating).length,
        transportation_rows: asRows(transport).length,
        combined_rows: combinedRows.length
      },
      // The flattened row list (easy for UI)
      rows: combinedRows,
      // Keep original payloads for audits/debug
      components: {
        heating_fuels_latest: heating,
        transportation_fuels_latest: transport
      }
    });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: String(err?.message || err) });
  }
};
