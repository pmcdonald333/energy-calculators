export default async () => {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ ok:false, error:"Missing EIA_API_KEY" }), {
      status: 500,
      headers: { "content-type":"application/json; charset=utf-8", "cache-control":"no-store" }
    });
  }

  const base = "https://api.eia.gov/v2/electricity/retail-sales/data/";
  const params = new URLSearchParams();
  params.set("api_key", apiKey);
  params.set("frequency", "annual");
  params.append("data[]", "price");

  // Residential
  params.append("facets[sectorid][]", "RES");
  // Tiny scope for test
  params.append("facets[stateid][]", "US"); // <-- if this fails, try "CA" or "TX" instead

  params.append("sort[0][column]", "period");
  params.append("sort[0][direction]", "desc");
  params.set("length", "5");

  const url = `${base}?${params.toString()}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const text = await res.text();

  let json = null;
  try { json = JSON.parse(text); } catch {}

  if (!res.ok) {
    return new Response(JSON.stringify({
      ok:false, status: res.status,
      hint: json?.error || json?.message || text.slice(0, 200)
    }), { status: 200, headers: { "content-type":"application/json; charset=utf-8", "cache-control":"no-store" }});
  }

  const rows = json?.response?.data ?? [];
  return new Response(JSON.stringify({
    ok:true,
    status: res.status,
    count: rows.length,
    sample: rows[0] ?? null
  }), { status: 200, headers: { "content-type":"application/json; charset=utf-8", "cache-control":"no-store" }});
};
