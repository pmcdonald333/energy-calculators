export default async () => {
  const apiKey = process.env.EIA_API_KEY;

  if (!apiKey) {
    return new Response(
      JSON.stringify({ ok: false, error: "EIA_API_KEY is not set in environment variables." }),
      { status: 500, headers: { "content-type": "application/json; charset=utf-8" } }
    );
  }

  // Tiny request: ask EIA for 1 row from the route you selected (annual, all-other-costs)
  // NOTE: we intentionally do NOT return the key or echo the full URL.
  const base =
    "https://api.eia.gov/v2/electricity/state-electricity-profiles/energy-efficiency/data/";

  const params = new URLSearchParams();
  params.set("api_key", apiKey);
  params.set("frequency", "annual");
  params.append("data[]", "all-other-costs");

  // Minimal facets (keep it tiny for a key test)
  params.append("facets[state][]", "US");

  // Sort newest first
  params.append("sort[0][column]", "period");
  params.append("sort[0][direction]", "desc");

  // Only 1 record
  params.set("length", "1");
  params.set("offset", "0");

  const url = `${base}?${params.toString()}`;

  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    const text = await res.text();

    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // leave json null
    }

    // If EIA rejects the key, status will be 401/403 typically
    if (!res.ok) {
      return new Response(
        JSON.stringify({
          ok: false,
          status: res.status,
          error: "EIA request failed (likely invalid/missing key or route/field mismatch).",
          // Provide a small hint without dumping everything
          hint: json?.error || json?.message || text.slice(0, 200)
        }),
        { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }
      );
    }

    const row = json?.response?.data?.[0] ?? null;

    return new Response(
      JSON.stringify({
        ok: true,
        status: res.status,
        route_ok: true,
        sample: row
          ? {
              period: row.period ?? null,
              state: row.state ?? null,
              sector: row.sector ?? null,
              all_other_costs: row["all-other-costs"] ?? row.all_other_costs ?? null
            }
          : { note: "No data row returned (key may still be valid, but dataset returned empty)." }
      }),
      { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err?.message || err) }),
      { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }
    );
  }
};
