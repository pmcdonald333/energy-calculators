import { loadAndValidateGeoConfigs } from "./_lib/config-validators.js";

export default async () => {
  try {
    const baseUrl = process.env.URL; // Netlify-provided canonical site URL on deploy
    const cfg = await loadAndValidateGeoConfigs({ baseUrl });

    return new Response(
      JSON.stringify(
        {
          ok: true,
          baseUrl,
          urls: cfg.urls,
          validation: cfg.validation
        },
        null,
        2
      ),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify(
        {
          ok: false,
          error: String(err?.message || err)
        },
        null,
        2
      ),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
};
