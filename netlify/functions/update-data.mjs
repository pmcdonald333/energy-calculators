import { getStore } from "@netlify/blobs";

function nowIso() {
  return new Date().toISOString();
}

// This is a Scheduled Function. Netlify will invoke it on the cron schedule.
// The request body contains { next_run }, but we don't need it yet.  [oai_citation:2‡Netlify Docs](https://docs.netlify.com/build/functions/scheduled-functions/)
export default async (req) => {
  const startedAt = Date.now();
  const generatedAt = nowIso();

  const store = getStore("system"); // global store name

  // Load existing status if present; otherwise fall back to a safe minimal object.
  let status =
    (await store.get("system_status", { type: "json" })) ??
    {
      schema_version: 1,
      environment: "prod",
      generated_at_utc: generatedAt,
      overall_health: {
        status: "DEGRADED",
        reason: "Initialized in updater; serving seeded artifacts until real data updater is implemented.",
        last_successful_update_utc: generatedAt,
        fallback_active: true,
        broken_user_impact: false
      },
      build: { site_version: "git:unknown", build_id: null, deployed_at_utc: null },
      updater_last_run: { run_id: "init", started_at_utc: generatedAt, finished_at_utc: generatedAt, duration_ms: 0, result: "PARTIAL", jobs: [], errors: [], warnings: [], fallback_in_effect: true },
      artifacts: [],
      runtime_checks: {
        artifact_fetch_test: { status: "SKIP", checked_at_utc: generatedAt, message: "Runtime checks not yet enabled." },
        calculator_boot_test: { status: "SKIP", checked_at_utc: generatedAt, message: "Runtime checks not yet enabled." },
        ads_container_present: { status: "SKIP", checked_at_utc: generatedAt, message: "Ads not yet configured." }
      },
      recent_flags: [],
      links: { deploy_logs: null, function_logs: null }
    };

  // Update “heartbeat” fields
  status.generated_at_utc = generatedAt;

  // Record updater run summary (stub: no real EIA/NOAA fetch yet)
  const finishedAt = Date.now();
  status.updater_last_run = {
    run_id: generatedAt,
    started_at_utc: new Date(finishedAt - (finishedAt - startedAt)).toISOString(),
    finished_at_utc: new Date(finishedAt).toISOString(),
    duration_ms: finishedAt - startedAt,
    result: "SUCCESS",
    jobs: [
      {
        job: "update_system_status",
        source: "internal",
        checked: true,
        updated: true,
        data_period_detected: "n/a",
        message: "Updated status heartbeat. Data fetch not yet implemented."
      }
    ],
    errors: [],
    warnings: [],
    fallback_in_effect: status.overall_health?.fallback_active ?? true
  };

  // Deterministic overall health (for now: degraded until real datasets implemented)
  status.overall_health = {
    status: "DEGRADED",
    reason: "Updater heartbeat running. Real data ingestion not yet enabled; seeded artifacts remain in use.",
    last_successful_update_utc: generatedAt,
    fallback_active: true,
    broken_user_impact: false
  };

  // Keep a short flags feed
  status.recent_flags = [
    {
      timestamp_utc: generatedAt,
      severity: "WARN",
      component: "updater",
      dataset: "system",
      type: "heartbeat",
      dedupe_key: "system:heartbeat",
      summary: "Scheduled updater ran successfully (heartbeat). Real data ingestion not yet enabled."
    }
  ].slice(0, 10);

  await store.set("system_status", JSON.stringify(status), {
    contentType: "application/json"
  });

  return new Response("ok", { status: 200 });
};

// Schedule can live in code OR netlify.toml. We'll put it in netlify.toml.
// (If you prefer, you can export config here instead.)  [oai_citation:3‡Netlify Docs](https://docs.netlify.com/build/functions/scheduled-functions/)
