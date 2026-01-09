import { getStore } from "@netlify/blobs";

function nowIso() {
  return new Date().toISOString();
}

const STATES_50_PLUS_DC_US = [
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

  const params = new URLSearchParams();
  params.set("api_key", apiKey);
  params.set("frequency", "annual");
  params.append("data[]", "all-other-costs");

  for (const s of STATES_50_PLUS_DC_US) params.append("facets[state][]", s);

  // Your chosen sort stack
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

  const latestPeriod = String(rows[0]?.period ?? "");
  if (!latestPeriod) throw new Error("EIA data missing period");

  const latestRows = rows.filter(r => String(r?.period ?? "") === latestPeriod);

  const byState = {};
  for (const r of latestRows) {
    const state = r?.state;
    const sector = r?.sector;
    if (!state || !sector) continue;

    if (!byState[state]) byState[state] = {};
    byState[state][sector] = toNumberOrNull(r?.["all-other-costs"]);
  }

  return { period: latestPeriod, byState };
}

const STATE_CODES_50_PLUS_DC = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
  "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
  "DC"
];

async function fetchEiaResidentialRatesAnnual(apiKey) {
  const base = "https://api.eia.gov/v2/electricity/retail-sales/data/";
  const params = new URLSearchParams();
  params.set("api_key", apiKey);
  params.set("frequency", "annual");
  params.append("data[]", "price");
  params.append("facets[sectorid][]", "RES");
  for (const s of STATE_CODES_50_PLUS_DC) params.append("facets[stateid][]", s);

  params.append("sort[0][column]", "period");
  params.append("sort[0][direction]", "desc");
  params.set("length", String(STATE_CODES_50_PLUS_DC.length * 3));

  const url = `${base}?${params.toString()}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`EIA retail-sales fetch failed: ${res.status}`);

  const json = await res.json();
  const rows = json?.response?.data ?? [];
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("EIA retail-sales returned no data");

  const latestPeriod = String(rows[0]?.period ?? "");
  if (!latestPeriod) throw new Error("EIA retail-sales missing period");

  const latestRows = rows.filter(r => String(r?.period ?? "") === latestPeriod);

  const byState = {};
  for (const r of latestRows) {
    const st = r?.stateid;
    const v = Number(r?.price);
    if (!st || !Number.isFinite(v)) continue;
    byState[st] = v; // cents per kWh
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

  // ---------- INGEST: Electricity rates (RES) ----------
const prevElec = await artifactsStore.get("electricity_rates_latest", { type: "json" });

let elecStatus = "WARN";
let elecFallback = { active: true, reason: "Seeded placeholder data (real ingestion not enabled yet)" };
let elecValidation = {
  schema_valid: true,
  complete_coverage: false,
  missing_keys: [],
  range_ok: true,
  delta_ok: true,
  anomalies: []
};
let wroteElec = false;
let elecPeriod = prevElec?.data_period ?? "seed";

try {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) throw new Error("Missing EIA_API_KEY");

  const eia = await fetchEiaResidentialRatesAnnual(apiKey);
  elecPeriod = eia.period;

  const missing = STATE_CODES_50_PLUS_DC.filter(s => !(s in eia.byState));

  // Range sanity: cents/kWh, allow 0 < v < 100
  const outOfRange = [];
  for (const [st, v] of Object.entries(eia.byState)) {
    if (!(v > 0 && v < 100)) outOfRange.push({ state: st, value: v });
  }
  const rangeOk = outOfRange.length === 0;

  // Delta vs previous (optional but useful)
  let deltaOk = true;
  let maxDeltaPct = 0;
  const prevMap = prevElec?.values?.by_state_cents_per_kwh ?? null;
  if (prevMap) {
    for (const st of Object.keys(eia.byState)) {
      const p = prevMap[st];
      const n = eia.byState[st];
      if (Number.isFinite(p) && Number.isFinite(n) && p > 0) {
        const pct = Math.abs((n - p) / p) * 100;
        if (pct > maxDeltaPct) maxDeltaPct = pct;
      }
    }
    // Annual series: very loose, only flag extreme
    deltaOk = maxDeltaPct <= 60;
  }

  const complete = missing.length === 0;

  elecValidation = {
    schema_valid: true,
    complete_coverage: complete,
    missing_keys: missing,
    range_ok: rangeOk,
    delta_ok: deltaOk,
    anomalies: [
      ...(outOfRange.length ? [{ type: "range", details: outOfRange.slice(0, 10) }] : []),
      ...(prevMap && !deltaOk ? [{ type: "delta", details: { max_delta_pct: Math.round(maxDeltaPct * 10) / 10 } }] : [])
    ]
  };

  if (complete && rangeOk) {
    elecStatus = deltaOk ? "OK" : "WARN";
    elecFallback = { active: false, reason: deltaOk ? null : "Large YoY delta flagged; published but monitored." };

    const elecArtifact = {
      version: 1,
      source: "EIA",
      dataset: "electricity/retail-sales",
      metric: "price",
      sector: "RES",
      data_period: eia.period,
      fetched_at_utc: generatedAt,
      units: "cents_per_kwh",
      values: { by_state_cents_per_kwh: eia.byState }
    };

    await artifactsStore.set("electricity_rates_latest", JSON.stringify(elecArtifact), {
      contentType: "application/json"
    });

    wroteElec = true;
  } else {
    // keep last-known-good if available
    if (prevElec) {
      elecStatus = "WARN";
      elecFallback = { active: true, reason: "Validation failed; serving last-known-good electricity artifact." };
    } else {
      elecStatus = "ERROR";
      elecFallback = { active: true, reason: "Validation failed and no prior electricity artifact exists." };
    }
  }
} catch (err) {
  if (prevElec) {
    elecStatus = "WARN";
    elecFallback = { active: true, reason: `Fetch failed; serving last-known-good (${String(err.message)})` };
  } else {
    elecStatus = "ERROR";
    elecFallback = { active: true, reason: `Fetch failed and no prior artifact (${String(err.message)})` };
  }
  elecValidation = {
    schema_valid: false,
    complete_coverage: false,
    missing_keys: ["all_states"],
    range_ok: false,
    delta_ok: false,
    anomalies: [{ type: "fetch_error", details: String(err.message) }]
  };
}  
  // ---------- INGEST: Efficiency (All Other Costs) ----------
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
  let wroteArtifact = false;
  let dataPeriod = prevArtifact?.data_period ?? "seed";

  try {
    const apiKey = process.env.EIA_API_KEY;
    if (!apiKey) throw new Error("Missing EIA_API_KEY");

    const eia = await fetchEiaAllOtherCosts(apiKey);
    dataPeriod = eia.period;

    // Coverage check
    const missingStates = STATES_50_PLUS_DC_US.filter(s => !(s in eia.byState));

    // Range check (no negatives)
    const negatives = [];
    for (const [st, sectors] of Object.entries(eia.byState)) {
      for (const [sec, v] of Object.entries(sectors ?? {})) {
        if (v !== null && v < 0) negatives.push({ state: st, sector: sec, value: v });
      }
    }
    const rangeOk = negatives.length === 0;

    // AK is sometimes absent in certain EIA tables; treat ONLY-AK-missing as WARN but still acceptable.
    const onlyAkMissing = missingStates.length === 1 && missingStates[0] === "AK";

    const completeCoverage = missingStates.length === 0;

    effValidation = {
      schema_valid: true,
      complete_coverage: completeCoverage,
      missing_keys: missingStates,
      range_ok: rangeOk,
      delta_ok: true,
      anomalies: [
        ...(negatives.length ? [{ type: "negative_values", details: negatives.slice(0, 10) }] : [])
      ]
    };

    // Decide status + whether to write
    if (rangeOk && (completeCoverage || onlyAkMissing)) {
      effStatus = completeCoverage ? "OK" : "WARN";
      effFallback = { active: false, reason: completeCoverage ? null : "AK missing in latest EIA output; publishing remainder." };

      const artifactToWrite = {
        version: 1,
        source: "EIA",
        dataset: "state-electricity-profiles/energy-efficiency",
        metric: "all-other-costs",
        data_period: eia.period,
        fetched_at_utc: generatedAt,
        values: { by_state: eia.byState }
      };

      await artifactsStore.set("efficiency_all_other_costs_latest", JSON.stringify(artifactToWrite), {
        contentType: "application/json"
      });
      wroteArtifact = true;
    } else {
      // Validation failed: fall back to last-known-good if available
      if (prevArtifact) {
        effStatus = "WARN";
        effFallback = { active: true, reason: "Validation failed; serving last-known-good artifact." };
      } else {
        effStatus = "ERROR";
        effFallback = { active: true, reason: "Validation failed and no prior artifact exists." };
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

  // ---------- BUILD ARTIFACT LIST FOR STATUS ----------
  const prevArtifacts = Array.isArray(prevStatus?.artifacts) ? prevStatus.artifacts : [];

  // Keep anything else already listed, but replace any older efficiency row if present
const kept = prevArtifacts.filter(a =>
  a?.artifact !== "efficiency_all_other_costs_latest.json" &&
  a?.artifact !== "electricity_rates_latest.json"
);

  const efficiencyRow = {
    artifact: "efficiency_all_other_costs_latest.json",
    calculator: "efficiency",
    source: "EIA",
    data_period: dataPeriod,
    last_checked_utc: generatedAt,
    last_successful_update_utc: wroteArtifact
      ? generatedAt
      : (prevStatus?.artifacts?.find(x => x.artifact === "efficiency_all_other_costs_latest.json")?.last_successful_update_utc ?? generatedAt),
    status: effStatus,
    fallback: effFallback,
    validation: effValidation,
    thresholds: { warn_after_days: 400, error_after_days: 800 }
  };
const electricityRow = {
  artifact: "electricity_rates_latest.json",
  calculator: "electricity",
  source: "EIA",
  data_period: elecPeriod,
  last_checked_utc: generatedAt,
  last_successful_update_utc: wroteElec
    ? generatedAt
    : (prevStatus?.artifacts?.find(x => x.artifact === "electricity_rates_latest.json")?.last_successful_update_utc ?? generatedAt),
  status: elecStatus,
  fallback: elecFallback,
  validation: elecValidation,
  thresholds: { warn_after_days: 45, error_after_days: 90 }
};
const artifacts = [...kept, electricityRow, efficiencyRow];

  // ---------- OVERALL HEALTH ----------
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
    updated: wroteArtifact,
    data_period_detected: dataPeriod,
    message: wroteArtifact
      ? "Fetched and stored EIA efficiency all-other-costs."
      : "Did not overwrite artifact (served last-known-good or failed validation)."
  },
  {
    job: "eia_electricity_rates_res",
    source: "EIA",
    checked: true,
    updated: wroteElec,
    data_period_detected: elecPeriod,
    message: wroteElec
      ? "Fetched and stored EIA residential electricity prices."
      : "Did not overwrite electricity artifact (served last-known-good or failed validation)."
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
