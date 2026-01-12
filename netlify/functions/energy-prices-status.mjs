// netlify/functions/energy-prices-status.mjs
//
// Step 7: Health/Diagnostics endpoint
//
// Purpose:
// - One small endpoint to tell if the pipeline is healthy
// - Distinguish "EIA/upstream broken" vs "our UI function broken"
// - Fast to curl + easy to monitor
//
// What it checks:
// - Fetches /.netlify/functions/energy-prices-latest-with-fallback
// - Reports basic counts and latest periods
// - Does NOT re-fetch EIA directly (keeps this light + consistent)

function jsonResponse(status, obj, { cacheControl = "no-store" } = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": cacheControl
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

async function fetchJsonWithDetails(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const text = await res.text().catch(() => "");

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  return {
    okHttp: res.ok,
    status: res.status,
    json,
    text
  };
}

function computeLatestPeriodsFromRows(rows) {
  const best = new Map(); // fuel_key-ish: dataset::fuel::sector -> bestPeriod

  for (const r of rows) {
    if (!r) continue;
    const dataset = r.dataset ? String(r.dataset) : null;
    const fuel = r.fuel ? String(r.fuel) : null;
    const sector = r.sector ? String(r.sector) : null;
    const period = r.period ? String(r.period) : null;
    if (!dataset || !fuel || !sector || !period) continue;

    const fk = `${dataset}::${fuel}::${sector}`;
    const prev = best.get(fk);
    if (!prev || period > prev) best.set(fk, period);
  }

  // Convert to plain object for JSON output
  const out = {};
  for (const [k, v] of best.entries()) out[k] = v;
  return out;
}

export default async (request) => {
  const startedAt = new Date();
  const baseUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || originFromRequest(request);

  if (!baseUrl) {
    return jsonResponse(500, {
      ok: false,
      generated_at: startedAt.toISOString(),
      error: "Could not determine baseUrl (process.env.URL missing and request origin unavailable)."
    });
  }

  const srcUrl = `${baseUrl}/.netlify/functions/energy-prices-latest-with-fallback`;

  try {
    const fetched = await fetchJsonWithDetails(srcUrl);

    // If upstream isn't OK HTTP-wise, surface a compact error
    if (!fetched.okHttp) {
      const upstreamError =
        fetched.json && typeof fetched.json === "object" && fetched.json.ok === false && fetched.json.error
          ? String(fetched.json.error)
          : String(fetched.text || "").slice(0, 600);

      return jsonResponse(500, {
        ok: false,
        generated_at: startedAt.toISOString(),
        checks: {
          energy_prices_latest_with_fallback: {
            ok: false,
            http_status: fetched.status
          }
        },
        error: `Upstream failed: energy-prices-latest-with-fallback (HTTP ${fetched.status}). ${upstreamError}`
      });
    }

    // HTTP ok but JSON may still be ok=false
    const src = fetched.json;
    if (!src || typeof src !== "object") {
      return jsonResponse(500, {
        ok: false,
        generated_at: startedAt.toISOString(),
        checks: {
          energy_prices_latest_with_fallback: { ok: false, http_status: fetched.status }
        },
        error: "Upstream returned non-JSON or invalid JSON."
      });
    }

    if (src.ok === false) {
      return jsonResponse(500, {
        ok: false,
        generated_at: startedAt.toISOString(),
        checks: {
          energy_prices_latest_with_fallback: { ok: false, http_status: fetched.status }
        },
        error: `Upstream ok=false: ${String(src.error || "unknown")}`
      });
    }

    const rows = Array.isArray(src.rows_filled) ? src.rows_filled : [];
    const latestByFuelKey = computeLatestPeriodsFromRows(rows);

    // Optional: compute a few convenience counts
    let direct = 0;
    let fallback = 0;
    let nullPrice = 0;

    for (const r of rows) {
      if (!r) continue;
      if (r.price === null || r.price === undefined) nullPrice += 1;
      if (r.is_fallback === true) fallback += 1;
      else direct += 1;
    }

    // Make this endpoint cacheable lightly (optional).
    // Since it is "status", keeping it mostly fresh helps monitoring.
    // You can change to "no-store" if you want it always live.
    const cacheControl = "public, max-age=0, s-maxage=60, stale-while-revalidate=300";

    return jsonResponse(
      200,
      {
        ok: true,
        generated_at: startedAt.toISOString(),
        checks: {
          energy_prices_latest_with_fallback: {
            ok: true,
            http_status: fetched.status
          }
        },
        upstream: {
          url: "/.netlify/functions/energy-prices-latest-with-fallback",
          upstream_generated_at: src.generated_at || null
        },
        latest: src.latest || null,
        windows: src.windows || null,
        counts: {
          // Prefer the upstream counts if present, since that is “authoritative”
          ...(src.counts || {}),
          // Plus a few helpful breakdowns from rows_filled
          rows_filled: rows.length,
          direct_rows: direct,
          fallback_rows: fallback,
          null_price_rows: nullPrice
        },
        latest_period_by_fuel_key: latestByFuelKey
      },
      { cacheControl }
    );
  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      generated_at: startedAt.toISOString(),
      checks: {
        energy_prices_latest_with_fallback: { ok: false }
      },
      error: String(err?.message || err)
    });
  }
};
