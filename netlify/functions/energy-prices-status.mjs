// netlify/functions/energy-prices-status.mjs
//
// Step 7: Health/Diagnostics endpoint
//
// Purpose:
// - One small endpoint to tell if the pipeline is healthy
// - Distinguish "upstream broken" vs "UI endpoint broken"
// - Fast to curl + easy to monitor
//
// What it checks (lightweight):
// - /.netlify/functions/energy-prices-latest-with-fallback
// - /api/energy_prices_latest_ui.json
//
// Notes:
// - Does NOT re-fetch EIA directly.
// - Returns non-2xx on failure so UptimeRobot alerts reliably.
// - Uses no-store so CDN does NOT mask outages.

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

async function fetchJsonWithDetails(url, { timeoutMs = 6000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);

  let res;
  let text = "";
  let json = null;

  try {
    res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: ac.signal
    });

    text = await res.text().catch(() => "");

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
  } catch (err) {
    return {
      okHttp: false,
      status: 0,
      json: null,
      text: "",
      error: String(err?.message || err)
    };
  } finally {
    clearTimeout(t);
  }
}

function computeLatestPeriodsFromRows(rows) {
  const best = new Map(); // dataset::fuel::sector -> bestPeriod

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

  const out = {};
  for (const [k, v] of best.entries()) out[k] = v;
  return out;
}

function compactUpstreamError(fetched) {
  if (fetched?.error) return `Fetch error: ${String(fetched.error).slice(0, 600)}`;

  const j = fetched?.json;
  if (j && typeof j === "object" && j.ok === false && j.error) {
    return String(j.error).slice(0, 900);
  }

  return String(fetched?.text || "").slice(0, 900);
}

export default async (request) => {
  const startedAt = new Date();

  // Optional: reject non-GET
  if (request.method && request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse(405, {
      ok: false,
      generated_at: startedAt.toISOString(),
      error: "Method not allowed"
    });
  }

  const baseUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || originFromRequest(request);
  if (!baseUrl) {
    return jsonResponse(500, {
      ok: false,
      generated_at: startedAt.toISOString(),
      error: "Could not determine baseUrl (process.env.URL missing and request origin unavailable)."
    });
  }

  const urls = {
    energy_prices_latest_with_fallback: `${baseUrl}/.netlify/functions/energy-prices-latest-with-fallback`,
    energy_prices_latest_ui_json: `${baseUrl}/api/energy_prices_latest_ui.json`
  };

  // Fetch upstreams (fast fail)
  const [f1, f2] = await Promise.all([
    fetchJsonWithDetails(urls.energy_prices_latest_with_fallback, { timeoutMs: 7000 }),
    fetchJsonWithDetails(urls.energy_prices_latest_ui_json, { timeoutMs: 7000 })
  ]);

  const checks = {
    energy_prices_latest_with_fallback: {
      ok: !!(f1.okHttp && f1.json && typeof f1.json === "object" && f1.json.ok !== false),
      http_status: f1.status || 0
    },
    energy_prices_latest_ui_json: {
      ok: !!(f2.okHttp && f2.json && typeof f2.json === "object" && f2.json.ok !== false),
      http_status: f2.status || 0
    }
  };

  // If either check fails, return 500 so monitors alert.
  const allOk = Object.values(checks).every((c) => c.ok);

  if (!allOk) {
    return jsonResponse(500, {
      ok: false,
      generated_at: startedAt.toISOString(),
      checks,
      errors: {
        energy_prices_latest_with_fallback: checks.energy_prices_latest_with_fallback.ok
          ? null
          : compactUpstreamError(f1),
        energy_prices_latest_ui_json: checks.energy_prices_latest_ui_json.ok ? null : compactUpstreamError(f2)
      }
    });
  }

  // Build useful diagnostics from upstream
  const src = f1.json;
  const rows = Array.isArray(src.rows_filled) ? src.rows_filled : [];
  const latestByFuelKey = computeLatestPeriodsFromRows(rows);

  let direct = 0;
  let fallback = 0;
  let nullPrice = 0;
  for (const r of rows) {
    if (!r) continue;
    if (r.price === null || r.price === undefined) nullPrice += 1;
    if (r.is_fallback === true) fallback += 1;
    else direct += 1;
  }

  return jsonResponse(200, {
    ok: true,
    generated_at: startedAt.toISOString(),
    checks,
    upstream: {
      energy_prices_latest_with_fallback: {
        url: "/.netlify/functions/energy-prices-latest-with-fallback",
        upstream_generated_at: src.generated_at || null
      },
      energy_prices_latest_ui_json: {
        url: "/api/energy_prices_latest_ui.json",
        upstream_generated_at: f2.json?.meta?.generated_at || f2.json?.generated_at || null
      }
    },
    latest: src.latest || null,
    windows: src.windows || null,
    counts: {
      ...(src.counts || {}),
      rows_filled: rows.length,
      direct_rows: direct,
      fallback_rows: fallback,
      null_price_rows: nullPrice
    },
    latest_period_by_fuel_key: latestByFuelKey
  });
};
