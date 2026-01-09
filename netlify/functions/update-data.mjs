import { getStore } from "@netlify/blobs";

function nowIso() {
  return new Date().toISOString();
}

const STATE_CODES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
  "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
  "DC"
];

function clampNum(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}

function maxPctDelta(prevMap, nextMap) {
  let max = 0;
  for (const k of Object.keys(nextMap)) {
    const p = prevMap?.[k];
    const n = nextMap?.[k];
    if (Number.isFinite(p) && Number.isFinite(n) && p > 0) {
      const pct = Math.abs((n - p) / p) * 100;
      if (pct > max) max = pct;
    }
  }
  return max;
}

async function fetchEiaResidentialAnnualPrices(apiKey) {
  // EIA v2 retail-sales endpoint supports facets and data[]=price, sectorid=RES for residential.  [oai_citation:4‡U.S. Energy Information Administration](https://www.eia.gov/opendata/documentation.php?utm_source=chatgpt.com)
  // We'll request all stateids we care about + sort by period desc and take enough rows to cover latest year for all states.
  const base = "https://api.eia.gov/v2/electricity/retail-sales/data/";
  const params = new URLSearchParams();
  params.set("api_key", apiKey);
  params.set("frequency", "annual");
  params.append("data[]", "price");
  params.append("facets[sectorid][]", "RES");
  // Add each state code explicitly to avoid pulling regions like ENC/WNC/etc.
  for (const s of STATE_CODES) params.append("facets[stateid][]", s);

  // Sort newest year first
  params.append("sort[0][column]", "period");
  params.append("sort[0][direction]", "desc");

  // Pull enough rows to cover one or two years for all states
  params.set("length", String(STATE_CODES.length * 3)); // plenty

  const url = `${base}?${params.toString()}`;
  const res = await fetch(url, { headers: { "accept": "application/json" } });
  if (!res.ok) throw new Error(`EIA fetch failed: ${res.status}`);
  const json = await res.json();

  const rows = json?.response?.data ?? [];
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("EIA returned no data");

  // Determine latest period present (e.g., "2024")
  const latestPeriod = rows[0]?.period;
  if (!latestPeriod) throw new Error("EIA data missing period");

  // Keep only the latest period
  const latestRows = rows.filter(r => r?.period === latestPeriod);

  // Build state -> price map (cents/kWh)
  const byState = {};
  for (const r of latestRows) {
    const stateid = r?.stateid;
    const price = clampNum(r?.price);
    if (!stateid || price === null) continue;
    byState[stateid] = price;
  }

  return {
    period: String(latestPeriod),
    byState
  };
}

export default async () => {
  const startedAtMs = Date.now();
  const generatedAt = nowIso();

  const systemStore = getStore("system");
  const artifactsStore = getStore("artifacts");

  const prevStatus = await systemStore.get("system_status", { type: "json" });
  const prevElec = await artifactsStore.get("electricity_rates_latest", { type: "json" });

  // Default: assume fallback until proven otherwise
  let elecArtifactStatus = "WARN";
  let elecFallback = { active: true, reason: "Seeded placeholder data (real ingestion not enabled yet)" };
  let elecValidation = {
    schema_valid: true,
    complete_coverage: false,
    missing_keys: ["all_states"],
    range_ok: true,
    delta_ok: true,
    anomalies: []
  };

  // Attempt EIA ingestion
  let electricityBlobToWrite = null;

  try {
    const apiKey = process.env.EIA_API_KEY;
    if (!apiKey) throw new Error("Missing EIA_API_KEY env var");

    const eia = await fetchEiaResidentialAnnualPrices(apiKey);

    // Validation
    const missing = STATE_CODES.filter(s => !(s in eia.byState));
    const values = Object.values(eia.byState);

    // Range check: cents/kWh should be a sane number; we’ll accept 1–60 normally, warn beyond but still allow up to 100.
    const outOfRange = [];
    for (const [k, v] of Object.entries(eia.byState)) {
      if (!(v > 0 && v < 100)) outOfRange.push({ state: k, value: v });
    }

    const rangeOk = outOfRange.length === 0;

    // Delta check vs last blob (if present)
    const prevMap = prevElec?.values?.by_state_cents_per_kwh ?? null;
    const maxDeltaPct = prevMap ? maxPctDelta(prevMap, eia.byState) : 0;
    const deltaOk = prevMap ? (maxDeltaPct <= 60) : true; // >60% is suspicious for annual series

    const completeCoverage = missing.length === 0;

    elecValidation = {
      schema_valid: true,
      complete_coverage: completeCoverage,
      missing_keys: missing.length ? missing : [],
      range_ok: rangeOk,
      delta_ok: deltaOk,
      anomalies: [
        ...(outOfRange.length ? [{ type: "range", details: outOfRange.slice(0, 10) }] : []),
        ...(prevMap && !deltaOk ? [{ type: "delta", details: { max_delta_pct: Math.round(maxDeltaPct * 10) / 10 } }] : [])
      ]
    };

    // Decide OK/WARN/ERROR and fallback rules
    if (!completeCoverage || !rangeOk) {
      // Incomplete or weird numbers: keep last-known-good if we have one, else warn and still write what we have
      elecArtifactStatus = prevElec ? "WARN" : "WARN";
      elecFallback = prevElec
        ? { active: true, reason: "EIA data failed validation; serving last-known-good blob" }
        : { active: true, reason: "EIA data incomplete; serving partial until first good run" };

      electricityBlobToWrite = prevElec ? null : {
        version: 1,
        source: "EIA",
        series: "electricity/retail-sales price (RES) annual",
        data_period: eia.period,
        fetched_at_utc: generatedAt,
        units: "cents_per_kwh",
        values: {
          by_state_cents_per_kwh: eia.byState
        }
      };
    } else if (!deltaOk) {
      // Suspicious jump: warn, but still keep last-known-good if available
      elecArtifactStatus = prevElec ? "WARN" : "WARN";
      elecFallback = prevElec
        ? { active: true, reason: "EIA data shows large jump vs prior; serving last-known-good blob" }
        : { active: false, reason: "No prior blob; accepting first run despite delta flag" };

      electricityBlobToWrite = prevElec ? null : {
        version: 1,
        source: "EIA",
        series: "electricity/retail-sales price (RES) annual",
        data_period: eia.period,
        fetched_at_utc: generatedAt,
        units: "cents_per_kwh",
        values: { by_state_cents_per_kwh: eia.byState }
      };
    } else {
      // Good data
      elecArtifactStatus = "OK";
      elecFallback = { active: false, reason: null };

      electricityBlobToWrite = {
        version: 1,
        source: "EIA",
        series: "electricity/retail-sales price (RES) annual",
        data_period: eia.period,
        fetched_at_utc: generatedAt,
        units: "cents_per_kwh",
        values: { by_state_cents_per_kwh: eia.byState }
      };
    }
  } catch (err) {
    elecArtifactStatus = prevElec ? "WARN" : "ERROR";
    elecFallback = prevElec
      ? { active: true, reason: `EIA fetch failed; serving last-known-good blob (${String(err.message)})` }
      : { active: true, reason: `EIA fetch failed and no prior blob (${String(err.message)})` };
    elecValidation = {
      schema_valid: false,
      complete_coverage: false,
      missing_keys: ["all_states"],
      range_ok: false,
      delta_ok: false,
      anomalies: [{ type: "fetch_error", details: String(err.message) }]
    };
  }

  // Write artifact blob if we have a validated payload to write
  if (electricityBlobToWrite) {
    await artifactsStore.set("electricity_rates_latest", JSON.stringify(electricityBlobToWrite), {
      contentType: "application/json"
    });
  }

  // Compose status artifacts (keep your other placeholders for now)
  const artifacts = [
    {
      artifact: "electricity_rates_latest.json",
      calculator: "electricity",
      source: "EIA",
      data_period: electricityBlobToWrite?.data_period ?? prevElec?.data_period ?? "seed",
      last_checked_utc: generatedAt,
      last_successful_update_utc: electricityBlobToWrite ? generatedAt : (prevStatus?.artifacts?.find(x => x.artifact === "electricity_rates_latest.json")?.last_successful_update_utc ?? generatedAt),
      status: elecArtifactStatus,
      fallback: elecFallback,
      validation: elecValidation,
      thresholds: { warn_after_days: 45, error_after_days: 90 }
    },
    {
      artifact: "fuel_prices_latest.json",
      calculator: "heating",
      source: "EIA",
      data_period: "seed",
      last_checked_utc: generatedAt,
      last_successful_update_utc: prevStatus?.artifacts?.find(x => x.artifact === "fuel_prices_latest.json")?.last_successful_update_utc ?? generatedAt,
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
      last_successful_update_utc: prevStatus?.artifacts?.find(x => x.artifact === "climate_hdd_cdd_latest.json")?.last_successful_update_utc ?? generatedAt,
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
          job: "electricity_eia_ingest",
          source: "EIA",
          checked: true,
          updated: Boolean(electricityBlobToWrite),
          data_period_detected: artifacts[0].data_period,
          message: electricityBlobToWrite
            ? "Fetched and stored electricity prices from EIA."
            : "Did not overwrite electricity artifact (served last-known-good or seeded)."
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
        severity: (overall === "BROKEN") ? "ERROR" : "WARN",
        component: "electricity",
        dataset: "EIA",
        type: "ingest",
        dedupe_key: "electricity:ingest",
        summary: `Electricity ingest run complete. Status=${artifacts[0].status}, fallback=${artifacts[0].fallback.active ? "on" : "off"}.`
      }
    ],
    links: prevStatus?.links ?? { deploy_logs: null, function_logs: null }
  };

  await systemStore.set("system_status", JSON.stringify(status), {
    contentType: "application/json"
  });

  return new Response("ok", { status: 200 });
};
