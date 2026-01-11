// public/energy-prices.js
//
// UI for /api/energy_prices_latest_ui.json
// - Stable dropdown selection (never snaps back)
// - Refresh fetches latest but preserves selection
// - Renders table for selected fuel_key

const API_URL = "/api/energy_prices_latest_ui.json";

function $(id) {
  return document.getElementById(id);
}

function text(el, v) {
  el.textContent = v == null ? "" : String(v);
}

function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function fmt(v) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  const s = String(v).trim();
  return s ? s : "—";
}

function setPill(ok, fallbackCount) {
  const pill = $("statusPill");
  pill.classList.remove("ok", "fb");
  if (!ok) {
    pill.classList.add("fb");
    pill.textContent = "error";
    return;
  }
  if (fallbackCount > 0) {
    pill.classList.add("fb");
    pill.textContent = `ok (${fallbackCount} fallback)`;
  } else {
    pill.classList.add("ok");
    pill.textContent = "ok";
  }
}

function showError(err) {
  const box = $("errorBox");
  box.style.display = "block";
  box.textContent = String(err);
}

function hideError() {
  const box = $("errorBox");
  box.style.display = "none";
  box.textContent = "";
}

function buildFuelOptionLabel(f) {
  // Example: "Gasoline — Residential"
  return `${f.fuel} — ${f.sector}`;
}

// Keep these across refreshes
let lastData = null;
let lastFuelKeysSignature = null;
let selectedFuelKey = null;

function computeFuelKeysSignature(fuels) {
  // If this signature changes, we rebuild the dropdown.
  return fuels.map((f) => f.fuel_key).join("|");
}

function ensureDropdownPopulated(data) {
  const fuels = Array.isArray(data?.fuels) ? data.fuels : [];
  const sig = computeFuelKeysSignature(fuels);

  // If same fuels as last time, do not rebuild (prevents selection snapping)
  if (sig && sig === lastFuelKeysSignature) return;

  lastFuelKeysSignature = sig;

  const sel = $("fuelSelect");
  clearChildren(sel);

  for (const f of fuels) {
    const opt = document.createElement("option");
    opt.value = f.fuel_key;
    opt.textContent = buildFuelOptionLabel(f);
    sel.appendChild(opt);
  }

  // Preserve selection if possible; otherwise default to first fuel
  const availableKeys = new Set(fuels.map((f) => f.fuel_key));
  if (!selectedFuelKey || !availableKeys.has(selectedFuelKey)) {
    selectedFuelKey = fuels[0]?.fuel_key || null;
  }

  if (selectedFuelKey) sel.value = selectedFuelKey;
}

function renderTable(data) {
  const tbody = $("tbody");
  clearChildren(tbody);

  const geos = Array.isArray(data?.geos) ? data.geos : [];
  const values = data?.values && typeof data.values === "object" ? data.values : {};

  if (!selectedFuelKey || !values[selectedFuelKey]) {
    // No data for selection
    for (const g of geos) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${fmt(g.geo_display_name)}<div class="mono">${fmt(g.geo_code)}</div></td>
        <td>—</td><td>—</td><td>—</td><td class="mono">—</td><td>—</td>
      `;
      tbody.appendChild(tr);
    }
    setPill(!!data?.ok, geos.length);
    return;
  }

  let fallbackCount = 0;

  for (const g of geos) {
    const geo = g.geo_code;
    const cell = values[selectedFuelKey][geo] || null;

    const price = cell?.price ?? null;
    const units = cell?.units ?? null;
    const period = cell?.period ?? null;

    const isFallback = cell?.is_fallback === true;
    if (isFallback) fallbackCount += 1;

    const fbFrom =
      cell?.fallback_from_geo_code === null ||
      cell?.fallback_from_geo_code === undefined ||
      cell?.fallback_from_geo_code === ""
        ? "—"
        : String(cell.fallback_from_geo_code);

    const tr = document.createElement("tr");

    const directOrFallback = isFallback ? "fallback" : "direct";

    tr.innerHTML = `
      <td>
        ${fmt(g.geo_display_name)}
        <div class="mono">${fmt(geo)}</div>
      </td>
      <td>${price === null ? "—" : fmt(price)}</td>
      <td>${units === null ? "—" : fmt(units)}</td>
      <td>${period === null ? "—" : fmt(period)}</td>
      <td>${directOrFallback}</td>
      <td>${isFallback ? fbFrom : "—"}</td>
    `;

    tbody.appendChild(tr);
  }

  setPill(!!data?.ok, fallbackCount);
}

function renderMeta(data) {
  text($("generatedAt"), data?.meta?.generated_at || "—");
}

async function fetchLatest() {
  // Use cache-busting query only on manual refresh to bypass edge cache if desired.
  // (But you can remove this if you WANT caching behavior always.)
  const url = `${API_URL}?t=${Date.now()}`;

  const res = await fetch(url, {
    headers: { accept: "application/json" },
    cache: "no-store"
  });

  const txt = await res.text();
  let json;
  try {
    json = JSON.parse(txt);
  } catch {
    throw new Error(`API returned invalid JSON (HTTP ${res.status}). Body: ${txt.slice(0, 250)}`);
  }

  if (!res.ok || !json?.ok) {
    throw new Error(json?.error || `API error (HTTP ${res.status})`);
  }

  return json;
}

async function refresh() {
  hideError();

  try {
    const data = await fetchLatest();
    lastData = data;

    ensureDropdownPopulated(data);
    renderMeta(data);
    renderTable(data);
  } catch (err) {
    showError(err?.message || String(err));
    setPill(false, 0);
  }
}

function renderFromExistingData() {
  if (!lastData) return;
  ensureDropdownPopulated(lastData);
  renderMeta(lastData);
  renderTable(lastData);
}

function init() {
  const sel = $("fuelSelect");
  const btn = $("refreshBtn");

  // Change selection without rebuilding options
  sel.addEventListener("change", () => {
    selectedFuelKey = sel.value;
    renderFromExistingData();
  });

  btn.addEventListener("click", () => {
    // Keep current selection and refresh data
    selectedFuelKey = sel.value;
    refresh();
  });

  // Initial load
  refresh();
}

init();
