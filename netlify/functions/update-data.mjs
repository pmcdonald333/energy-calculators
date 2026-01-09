import { getStore } from "@netlify/blobs";

function nowIso() {
  return new Date().toISOString();
}

// Your state list intent: 50 states + DC + US total.
// We'll validate for these keys.
const REQUIRED_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
  "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
  "DC","US"
];

function toNumberOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchEiaAllOtherCosts(apiKey) {
  const base =
    "https://api.eia.gov/v2/electricity/state-electricity-profiles/energy-efficiency/data/";

  // Canonical EIA v2 parameter style: data[]=... facets[...][]=... sort[...]...
  const params = new URLSearchParams();
  params.set("api_key", apiKey);
  params.set("frequency", "annual");
  params.append("data[]", "all-other-costs");

  // Facets: all states + DC + US (your provided URL used facets[state][])
  for (const s of REQUIRED_STATES) params.append("facets[state][]", s);

  // Your sort stack
  params.append("sort[0][column]", "period");
  params.append("sort[0][direction]", "desc");
  params.append("sort[1][column]", "state");
  params.append("sort[1][direction]", "asc");
  params.append("sort[2][column]", "sector");
  params.append("sort[2][direction]", "asc");

  params.set("offset", "0");
  params.set("length", "5000");

  const url = `${base}?${params.toString()}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`EIA fetch failed: ${res.status}`);

  const json = await res.json();
  const rows = json?.response?.data ?? [];
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("EIA returned no data rows");

  // Determine latest period (because we sorted desc by period)
  const latestPeriod = String(rows[0]?.period ?? "");
  if (!latestPeriod) throw new Error("EIA data missing period");

  // Keep only latest period
  const latestRows = rows.filter(r => String(r?.period ?? "") === latestPeriod);

  // Build: by_state -> by_sector -> all_other_costs
  const byState = {};
  for (const r of latestRows) {
    const state = r?.state;
    const sector = r?.sector;
    const value = toNumberOrNull(r?.["all-other-costs"]);
    if (!state || !sector) continue;

    if (!byState[state]) byState[state] = {};
    // store null if missing; keep numeric if present
    byState[state][sector] = value;
  }

  return { period: latestPeriod, byState };
}

export default async () => {
  const startedAtMs = Date.now();
  const generatedAt = nowIso();

  const systemStore = getStore("system");
  const artifactsStore = getStore("artifacts");

  const prevStatus = await systemStore.get("system_status", { type: "json" });
  const prevArtifact = await artifactsStore.get("efficiency_all_other_costs_latest", { type: "json" });

  // ---- Ingest EIA: All Other Costs ----
  let effStatus = "WARN";
  let effFallback = { active: true, reason: "Not ingested yet." };
  let effValidation = {
    schema_valid: true,
    complete_coverage: false,
    missing_keys: [],
    range_ok: true,
    delta_ok: true,
    anomalies: []
  };
  let artifactToWrite = null;
  let dataPeriod = prevArtifact?.data_period ?? "seed";

  try {
    const apiKey = process.env.EIA_API_KEY;
    if (!apiKey) throw new Error("Missing EIA_API_KEY");

    const eia = await fetchEiaAllOtherCosts(apiKey);
    dataPeriod = eia.period;

    // Coverage: must have each required state present (even if sectors vary)
    const missingStates = REQUIRED_STATES.filter(s => !(s in eia.byState));

    // Range: values should be >= 0 when present
    const negatives = [];
    for (const [st, sectors] of Object.entries(eia.byState)) {
      for (const [sec, v] of Object.entries(sectors ?? {})) {
        if (v !== null && v < 0) negatives.push({ state: st, sector: sec, value: v });
      }
    }
    const rangeOk = negatives.length === 0;

    // Delta check vs last-known-good (US total, any sector that exists in both)
    let deltaOk = true;
    let maxDeltaPct = 0;
    const prev = prevArtifact?.values?.by_state ?? null;
    if (prev && prev.US && eia.byState.US) {
      for (const [sec, v] of Object.entries(eia.byState.US)) {
        const pv = prev.US?.[sec];
        if (Number.isFinite(pv) && Number.isFinite(v) && pv > 0) {
          const pct = Math.abs((v - pv) / pv) * 100;
          if (pct > maxDeltaPct) maxDeltaPct = pct;
        }
      }
      // Very loose: annual program costs can shift; warn only if extreme
      deltaOk = maxDeltaPct <= 250;
    }

    const completeCoverage = missingStates.length === 0;

    effValidation = {
      schema_valid: true,
      complete_coverage: completeCoverage,
      missing_keys: missingStates,
      range_ok: rangeOk,
      delta_ok: deltaOk,
      anomalies: [
        ...(negatives.length ? [{ type: "negative_values", details: negatives.slice(0, 10) }] : []),
        ...(!deltaOk ? [{ type: "delta", details: { max_delta_pct: Math.round(maxDeltaPct * 10) / 10 } }] : [])
      ]
    };

    if (completeCoverage && rangeOk) {
      // Accept and write
      effStatus = deltaOk ? "OK" : "WARN";
      effFallback = deltaOk
        ? { active: false, reason: null }
        : { active: false, reason: "Large year-over-year delta flagged; data accepted but monitored." };

      artifactToWrite = {
        version: 1,
        source: "EIA",
        dataset: "state-electricity-profiles/energy-efficiency",
        metric: "all-other-costs",
        data_period: eia.period,
        fetched_at_utc: generatedAt,
        values: { by_state: eia.byState }
      };
    } else {
      // Validation fail: keep last-known-good if exists
      if (prevArtifact) {
        effStatus = "WARN";
        effFallback = { active: true, reason: "Validation failed; serving last-known-good artifact." };
        artifactToWrite = null;
      } else {
        // No prior artifact; still write what we have, but clearly WARN+fallback
        effStatus = "WARN";
        effFallback = { active: true, reason: "Incomplete data on first ingest; serving partial until next run." };
        artifactToWrite = {
          version: 1,
          source: "EIA",
          dataset: "state-electricity-profiles/energy-efficiency",
          metric: "all-other-costs",
          data_period: eia.period,
          fetched_at_utc: generatedAt,
          values: { by_state: eia.byState }
        };
      }
    }
  } catch (err) {
    if (prevArtifact) {
      effStatus = "WARN";
      effFallback = { active: true, reason: `Fetch failed; serving last-known-good (${String(err.message)})` };
    } else {
      effStatus = "ERROR";
      effFallback = { active: true, reason: `Fetch failed and no prior artifact (${String(err.message)})` };
    }
    effValidation = {
      schema_valid: false,
      complete_coverage: false,
      missing_keys: ["states"],
      range_ok: false,
      delta_ok: false,
      anomalies: [{ type: "fetch_error", details: String(err.message) }]
    };
  }

  if (artifactToWrite) {
    await artifactsStore.set("efficiency_all_other_costs_latest", JSON.stringify(artifactToWrite), {
      contentType: "application/json"
    });
  }

  // ---- Compose system status ----
  // Keep your existing other placeholder artifacts for now (from prevStatus if present).
  const prevArtifacts = Array.isArray(prevStatus?.artifacts) ? prevStatus.artifacts : [];
  const keepOthers = prevArtifacts.filter(a =>
    a?.artifact !== "efficiency_all_other_costs_latest.json" &&
    a?.artifact !== "efficiency_all_other_costs_latest.json"
  );

  const artifacts = [
    ...keepOthers,
    {
      artifact: "efficiency_all_other_costs_latest.json",
      calculator: "efficiency",
      source: "EIA",
      data_period: dataPeriod,
      last_checked_utc: generatedAt,
      last_successful_update_utc: artifactToWrite ? generatedAt : (prevStatus?.generated_at_utc ?? generatedAt),
      status: effStatus,
      fallback: effFallback,
      validation: effValidation,
      thresholds: { warn_after_days: 400, error_after_days: 800 }
    }
  ];

  const anyError = artifacts.some(a => a.status === "ERROR");
  const anyWarn = artifacts.some(a => a.status === "WARN");
  const anyFallback = artifacts.some(a => a.fallback?.active);

  const overall = anyError ? "BROKEN" : (anyWarn || anyFallback ? "DEGRADED" : "HEALTHY");

  const finishedAtMs = Date.now();

  const status = {
    schema_version: 1,
    environment: "prod",
    generated_at_utc: generatedAt,
    overall_health: {
      status: overall,
      reason:
        overall === "HEALTHY"
          ? "All artifacts valid; no fallback active."
          : "Updater ran. Some artifacts are still seeded or using fallback.",
      last_successful_update_utc: generatedAt,
      fallback_active: anyFallback,
      broken_user_impact: overall === "BROKEN"
    },
    build: prevStatus?.build ?? { site_version: "git:unknown", build_id: null, deployed_at_utc: null },
    updater_last_run: {
      run_id: generatedAt,
      started_at_utc: new Date(startedAtMs).toISOString(),
      finished_at_utc: new Date(finishedAtMs).toISOString(),
      duration_ms: finishedAtMs - startedAtMs,
      result: anyError ? "PARTIAL" : "SUCCESS",
      jobs: [
        {
          job: "eia_efficiency_all_other_costs",
          source: "EIA",
          checked: true,
          updated: Boolean(artifactToWrite),
          data_period_detected: dataPeriod,
          message: artifactToWrite
            ? "Fetched and stored EIA efficiency all-other-costs."
            : "Did not overwrite artifact (served last-known-good or awaiting next run)."
        }
      ],
      errors: anyError ? ["One or more artifacts failed."] : [],
      warnings: anyWarn ? ["One or more artifacts in WARN."] : [],
      fallback_in_effect: anyFallback
    },
    artifacts,
    runtime_checks: prevStatus?.runtime_checks ?? {
      artifact_fetch_test: { status: "SKIP", checked_at_utc: generatedAt, message: "Runtime checks not yet enabled." },
      calculator_boot_test: { status: "SKIP", checked_at_utc: generatedAt, message: "Runtime checks not yet enabled." },
      ads_container_present: { status: "SKIP", checked_at_utc: generatedAt, message: "Ads not yet configured." }
    },
    recent_flags: [
      {
        timestamp_utc: generatedAt,
        severity: anyError ? "ERROR" : "WARN",
        component: "efficiency",
        dataset: "EIA",
        type: "ingest",
        dedupe_key: "efficiency:all_other_costs",
        summary: `EIA efficiency ingest complete. Status=${effStatus}, fallback=${effFallback.active ? "on" : "off"}, period=${dataPeriod}.`
      }
    ],
    links: prevStatus?.links ?? { deploy_logs: null, function_logs: null }
  };

  await systemStore.set("system_status", JSON.stringify(status), { contentType: "application/json" });

  return new Response("ok", { status: 200 });
};
