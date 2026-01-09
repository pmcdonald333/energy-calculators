import { getStore } from "@netlify/blobs";

export default async () => {
  const store = getStore("system");

  // Prefer json parsing; will be null if missing
  const statusObj = await store.get("system_status", { type: "json" });

  if (!statusObj) {
    return new Response(
      JSON.stringify({
        error: "No blob status yet. Run the updater once or wait for the next schedule.",
        generated_at_utc: new Date().toISOString()
      }),
      {
        status: 503,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "access-control-allow-origin": "*"
        }
      }
    );
  }

  return new Response(JSON.stringify(statusObj), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    }
  });
};
