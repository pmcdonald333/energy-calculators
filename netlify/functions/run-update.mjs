import { getStore } from "@netlify/blobs";

function nowIso() {
  return new Date().toISOString();
}

export default async () => {
  const startedAt = Date.now();
  const generatedAt = nowIso();

  const store = getStore("system");

  // Minimal valid status payload (matches your locked schema shape enough to render)
  const status = {
    schema_version: 1,
    environment: "prod",
    generated_at_utc: generatedAt,
    overall_health: {
      status: "DEGRADED",
      reason: "Manual run wrote initial blob status. Scheduled updater will take over.",
      last_successful_update_utc: generatedAt,
      fallback_active: true,
      broken_user_impact: false
    },
    build: { site_version: "git:unknown", build_id: null, deployed_at_utc: null },
    updater_last_run: {
      run_id: generatedAt,
      started_at_utc: generatedAt,
      finished_at_utc: generatedAt,
      duration_ms: Date.now() - startedAt,
      result: "SUCCESS",
      jobs: [
        {
          job: "manual_run_update",
          source: "internal",
          checked: true,
          updated: true,
          data_period_detected: "n/a",
          message: "Manual trigger wrote system_status blob."
        }
      ],
      errors: [],
      warnings: [],
      fallback_in_effect: true
    },
    artifacts: [],
    runtime_checks: {
      artifact_fetch_test: { status: "SKIP", checked_at_utc: generatedAt, message: "Not enabled yet." },
      calculator_boot_test: { status: "SKIP", checked_at_utc: generatedAt, message: "Not enabled yet." },
      ads_container_present: { status: "SKIP", checked_at_utc: generatedAt, message: "Ads not enabled yet." }
    },
    recent_flags: [
      {
        timestamp_utc: generatedAt,
        severity: "WARN",
        component: "updater",
        dataset: "system",
        type: "manual_seed",
        dedupe_key: "system:manual_seed",
        summary: "Manual trigger wrote initial blob status."
      }
    ],
    links: { deploy_logs: null, function_logs: null }
  };

  await store.set("system_status", JSON.stringify(status), {
    contentType: "application/json"
  });

  return new Response(
    JSON.stringify({ ok: true, wrote: "system_status", generated_at_utc: generatedAt }),
    { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }
  );
};
