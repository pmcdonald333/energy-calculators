// netlify/functions/_lib/eia.js
export function assertEnvApiKey() {
  const key = process.env.EIA_API_KEY;
  if (!key) throw new Error("EIA_API_KEY is missing (set it in Netlify environment variables).");
  return key;
}

export async function fetchEiaJson(url) {
  const apiKey = assertEnvApiKey();

  // EIA v2 supports api_key query param; we append safely.
  const u = new URL(url);
  if (!u.searchParams.get("api_key")) u.searchParams.set("api_key", apiKey);

  const res = await fetch(u.toString(), { headers: { accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`EIA_FETCH_FAILED: ${res.status} ${res.statusText} :: ${text.slice(0, 300)}`);
  }
  return res.json();
}

export function mustArray(x, label) {
  if (!Array.isArray(x)) throw new Error(`${label} must be an array`);
  return x;
}
