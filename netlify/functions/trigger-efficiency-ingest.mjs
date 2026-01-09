import { getStore } from "@netlify/blobs";

function nowIso() { return new Date().toISOString(); }

const STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
  "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
  "DC","US"
];

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchEia(apiKey) {
  const base = "https://api.eia.gov/v2/electricity/state-electricity-profiles/energy-efficiency/data/";
  const p = new URLSearchParams();
  p.set("api_key", apiKey);
  p.set("frequency", "annual");
  p.append("data[]", "all-other-costs");
  for (const s of STATES) p.append("facets[state][]", s);

  p.append("sort[0][column]", "period");
  p.append("sort[0][direction]", "desc");
  p.append("sort[1][column]", "state");
  p.append("sort[1][direction]", "asc");
  p.append("sort[2][column]", "sector");
  p.append("sort[2][direction]", "asc");

  p.set("length", "5000");
  const url = `${base}?${p.toString()}`;

  const res = await fetch(url, { headers: { accept: "application/json" }});
  if (!res.ok) throw new Error(`EIA fetch failed: ${res.status}`);
  const json = await res.json();
  const rows = json?.response?.data ?? [];
  if (!rows.length) throw new Error("No rows from EIA");

  const latest = String(rows[0].period);
  const latestRows = rows.filter(r => String(r.period) === latest);

  const byState = {};
  for (const r of latestRows) {
    const st = r.state;
    const sec = r.sector;
    if (!st || !sec) continue;
    if (!byState[st]) byState[st] = {};
    byState[st][sec] = toNum(r["all-other-costs"]);
  }

  return { period: latest, byState };
}

export default async (req) => {
  // Optional safety: require a header token if you already set one
  // const token = req.headers.get("x-run-token");
  // if (!process.env.RUN_UPDATE_TOKEN || token !== process.env.RUN_UPDATE_TOKEN) {
  //   return new Response(JSON.stringify({ ok:false, error:"Forbidden" }), { status:403 });
  // }

  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ ok:false, error:"Missing EIA_API_KEY" }), { status:500 });

  const generatedAt = nowIso();
  const { period, byState } = await fetchEia(apiKey);

  const artifactsStore = getStore("artifacts");
  await artifactsStore.set(
    "efficiency_all_other_costs_latest",
    JSON.stringify({
      version: 1,
      source: "EIA",
      dataset: "state-electricity-profiles/energy-efficiency",
      metric: "all-other-costs",
      data_period: period,
      fetched_at_utc: generatedAt,
      values: { by_state: byState }
    }),
    { contentType: "application/json" }
  );

  return new Response(JSON.stringify({ ok:true, wrote:"efficiency_all_other_costs_latest", period }), {
    status: 200,
    headers: { "content-type":"application/json; charset=utf-8", "cache-control":"no-store" }
  });
};
