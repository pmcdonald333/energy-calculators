import { getStore } from "@netlify/blobs";

export default async () => {
  const store = getStore("system");
  const status = await store.get("system_status", { type: "text" });

  // Fallback: if blobs empty, serve the seeded static file path hint
  if (!status) {
    return new Response(
      JSON.stringify({
        error: "No blob status yet. Run the scheduled function once ('Run now' in Netlify UI) or wait for next schedule."
      }),
      { status: 503, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }
    );
  }

  return new Response(status, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
};
