const API_URL = "/api/energy_prices_latest_ui.json";

const elFuelSelect = document.getElementById("fuelSelect");
const elTbody = document.getElementById("tbody");
const elGeneratedAt = document.getElementById("generatedAt");
const elErrorBox = document.getElementById("errorBox");
const elStatusPill = document.getElementById("statusPill");
const elRefreshBtn = document.getElementById("refreshBtn");

let state = {
  data: null,
  selectedFuelKey: null
};

function setStatus(text, kind = "info") {
  elStatusPill.textContent = text;
  elStatusPill.className = "pill " + (kind === "ok" ? "ok" : kind === "fb" ? "fb" : "");
}

function showError(msg) {
  elErrorBox.style.display = "block";
  elErrorBox.textContent = msg;
}

function clearError() {
  elErrorBox.style.display = "none";
  elErrorBox.textContent = "";
}

function fmtPrice(v) {
  if (v === null || v === undefined) return "—";
  if (typeof v !== "number") return String(v);
  // keep readable but stable
  return v.toFixed(3).replace(/\.?0+$/, (m) => (m === "." ? "" : ""));
}

function safeString(v) {
  return v === null || v === undefined ? "" : String(v);
}

function buildFuelOptions(fuels) {
  elFuelSelect.innerHTML = "";
  for (const f of fuels) {
    const opt = document.createElement("option");
    opt.value = f.fuel_key;
    opt.textContent = `${f.fuel} (${f.dataset})`;
    elFuelSelect.appendChild(opt);
  }
}

function renderTable() {
  const data = state.data;
  if (!data) return;

  const fk = state.selectedFuelKey || (data.fuels?.[0]?.fuel_key ?? null);
  if (!fk) return;

  const valuesForFuel = data.values?.[fk];
  if (!valuesForFuel) return;

  const rows = [];
  for (const g of data.geos) {
    const geo = g.geo_code;
    const cell = valuesForFuel[geo] || null;

    rows.push({
      geo_code: geo,
      geo_display_name: g.geo_display_name,
      price: cell?.price ?? null,
      units: cell?.units ?? null,
      period: cell?.period ?? null,
      is_fallback: cell?.is_fallback ?? true,
      fallback_from_geo_code: cell?.fallback_from_geo_code ?? null
    });
  }

  elTbody.innerHTML = "";
  for (const r of rows) {
    const tr = document.createElement("tr");

    const tdGeo = document.createElement("td");
    tdGeo.innerHTML = `<div><strong>${r.geo_display_name}</strong></div><div class="mono">${r.geo_code}</div>`;
    tr.appendChild(tdGeo);

    const tdPrice = document.createElement("td");
    tdPrice.textContent = fmtPrice(r.price);
    tr.appendChild(tdPrice);

    const tdUnits = document.createElement("td");
    tdUnits.textContent = safeString(r.units) || "—";
    tr.appendChild(tdUnits);

    const tdPeriod = document.createElement("td");
    tdPeriod.textContent = safeString(r.period) || "—";
    tr.appendChild(tdPeriod);

    const tdDF = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = "pill " + (r.is_fallback ? "fb" : "ok");
    pill.textContent = r.is_fallback ? "fallback" : "direct";
    tdDF.appendChild(pill);
    tr.appendChild(tdDF);

    const tdFrom = document.createElement("td");
    tdFrom.textContent = r.is_fallback ? (safeString(r.fallback_from_geo_code) || "—") : "—";
    tdFrom.className = "mono";
    tr.appendChild(tdFrom);

    elTbody.appendChild(tr);
  }

  // status pill: show if there are any fallback rows
  const fallbackCount = rows.filter((x) => x.is_fallback).length;
  if (fallbackCount > 0) setStatus(`ok (${fallbackCount} fallback)`, "fb");
  else setStatus("ok (all direct)", "ok");
}

async function load() {
  clearError();
  setStatus("loading…");

  try {
    // IMPORTANT: Do NOT add cache-busting query params. We want CDN + ETag behavior.
    const res = await fetch(API_URL, {
      headers: { accept: "application/json" }
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Fetch failed (${res.status}). Body: ${text.slice(0, 200)}`);
    }

    const json = await res.json();

    if (!json?.ok) {
      throw new Error(`API ok=false: ${String(json?.error || "unknown error")}`);
    }

    state.data = json;

    elGeneratedAt.textContent = safeString(json?.meta?.generated_at) || "—";

    buildFuelOptions(json.fuels || []);
    if (!state.selectedFuelKey) {
      state.selectedFuelKey = json.fuels?.[0]?.fuel_key ?? null;
      elFuelSelect.value = state.selectedFuelKey || "";
    }

    renderTable();
  } catch (e) {
    setStatus("error");
    showError(String(e?.message || e));
  }
}

elFuelSelect.addEventListener("change", () => {
  state.selectedFuelKey = elFuelSelect.value;
  renderTable();
});

elRefreshBtn.addEventListener("click", () => {
  // This triggers a normal fetch; CDN may still serve cached until revalidation.
  load();
});

load();
