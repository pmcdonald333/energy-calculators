import { getStore } from "@netlify/blobs";

export default async () => {
  const store = getStore("artifacts");
  const text = await store.get("electricity_rates_latest", { type: "text" });

  if (!text) {
    // If blob not written yet, return a clear error (calculator can fall back to user input)
    return new Response(
      JSON.stringify({ error: "No electricity artifact yet. Updater has not ingested EIA data." }),
      { status: 503, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }
    );
  }

  return new Response(text, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
};
