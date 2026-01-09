import { getStore } from "@netlify/blobs";

function nowIso() {
  return new Date().toISOString();
}
function daysBetween(aIso, bIso) {
  const a = new Date(aIso).getTime();
  const b = new Date(bIso).getTime();
  return Math.floor((b - a) / (1000 * 60 * 60 * 24));
}

export default async () => {
  const startedAtMs = Date.now();
  const generatedAt = nowIso();

  const store = getStore("system");

  // Pull existing blob if present (keeps continuity of last_successful_update if you want later)
  const prev = await store.get("system_status", { type: "json" });

  // Build artifact list based on your Phase 1 artifacts
  const artifacts = [
    {
      artifact: "electricity_rates_latest.json",
      calculator: "electricity",
      source: "EIA",
      data_period: "seed",
      last_checked_utc: generatedAt,
      last_successful_update_utc: prev?.artifacts?.find(x => x.artifact === "electricity_rates_latest.json")?.last_successful_update_utc ?? generatedAt,
      status: "WARN",
      fallback: { active: true, reason: "Seeded placeholder data (real ingestion not enabled yet)" },
      validation: {
        schema_valid: true,
        complete_coverage: false,
        missing_keys: ["all_states"],
        range_ok: true,
        delta_ok: true,
        anomalies: []
      },
      thresholds: { warn_after_days: 45, error_after_days: 90 }
    },
    {
      artifact: "fuel_prices_latest.json",
      calculator: "heating",
      source: "EIA",
      data_period: "seed",
      last_checked_utc: generatedAt,
      last_successful_update_utc: prev?.artifacts?.find(x => x.artifact === "fuel_prices_latest.json")?.last_successful_update_utc ?? generatedAt,
      status: "WARN",
      fallback: { active: true, reason: "Seeded placeholder data (real ingestion not enabled yet)" },
      validation: {
        schema_valid: true,
        complete_coverage: false,
        missing_keys: ["all_states"],
        range_ok: true,
        delta_ok: true,
        anomalies: []
      },
      thresholds: { warn_after_days: 21, error_after_days: 45 }
    },
    {
      artifact: "climate_hdd_cdd_latest.json",
      calculator: "heating",
      source: "NOAA",
      data_period: "seed",
      last_checked_utc: generatedAt,
      last_successful_update_utc: prev?.artifacts?.find(x => x.artifact === "climate_hdd_cdd_latest.json")?.last_successful_update_utc ?? generatedAt,
      status: "WARN",
      fallback: { active: true, reason: "Seeded placeholder data (real ingestion not enabled yet)" },
      validation: {
        schema_valid: true,
        complete_coverage: false,
        missing_keys: ["all_states"],
        range_ok: true,
        delta_ok: true,
        anomalies: []
      },
      thresholds: { warn_after_days: 400, error_after_days: 800 }
    }
  ];

  // Deterministic overall health scoring (simplified for now)
  const anyFallback = artifacts.some(a => a.fallback?.active);
  const anyError = artifacts.some(a => a.status === "ERROR");
  const anyWarn = artifacts.some(a => a.status === "WARN");

  const overallStatus = anyError ? "BROKEN" : (anyFallback || anyWarn ? "DEGRADED" : "HEALTHY");

  const finishedAtMs = Date.now();
  const durationMs = finishedAtMs - startedAtMs;

  const status = {
    schema_version: 1,
    environment: "prod",
    generated_at_utc: generatedAt,
    overall_health: {
      status: overallStatus,
      reason:
        overallStatus === "HEALTHY"
          ? "All artifacts valid; no fallback active."
          : "Updater heartbeat running. Real data ingestion not yet enabled; seeded artifacts remain in use.",
      last_successful_update_utc: generatedAt,
      fallback_active: anyFallback,
      broken_user_impact: overallStatus === "BROKEN"
    },
    build: prev?.build ?? { site_version: "git:unknown", build_id: null, deployed_at_utc: null },
    updater_last_run: {
      run_id: generatedAt,
      started_at_utc: new Date(startedAtMs).toISOString(),
      finished_at_utc: new Date(finishedAtMs).toISOString(),
      duration_ms: durationMs,
      result: "SUCCESS",
      jobs: [
        {
          job: "update_system_status",
          source: "internal",
          checked: true,
          updated: true,
          data_period_detected: "n/a",
          message: "Scheduled updater ran (heartbeat). Real EIA/NOAA ingestion not enabled yet."
        }
      ],
      errors: [],
      warnings: [],
      fallback_in_effect: anyFallback
    },
    artifacts,
    runtime_checks: prev?.runtime_checks ?? {
      artifact_fetch_test: { status: "SKIP", checked_at_utc: generatedAt, message: "Runtime checks not yet enabled." },
      calculator_boot_test: { status: "SKIP", checked_at_utc: generatedAt, message: "Runtime checks not yet enabled." },
      ads_container_present: { status: "SKIP", checked_at_utc: generatedAt, message: "Ads not yet configured." }
    },
    recent_flags: [
      {
        timestamp_utc: generatedAt,
        severity: "WARN",
        component: "updater",
        dataset: "system",
        type: "heartbeat",
        dedupe_key: "system:heartbeat",
        summary: "Scheduled updater ran successfully (heartbeat). Seeded artifacts remain until real ingestion is enabled."
      }
    ],
    links: prev?.links ?? { deploy_logs: null, function_logs: null }
  };

  await store.set("system_status", JSON.stringify(status), {
    contentType: "application/json"
  });

  return new Response("ok", { status: 200 });
};
