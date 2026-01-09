import { getStore } from "@netlify/blobs";

export default async () => {
  const store = getStore("artifacts");
  const text = await store.get("efficiency_all_other_costs_latest", { type: "text" });

  if (!text) {
    return new Response(
      JSON.stringify({ error: "No artifact yet. Updater has not ingested EIA data." }),
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
