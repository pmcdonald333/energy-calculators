// public/energy-prices.js
//
// UI for /api/energy_prices_latest_ui.json
// Hardened selection behavior:
// - Never snaps back to first option unless absolutely necessary
// - Persists selection in localStorage
// - Supports deep links: ?fuel=<fuel_key>
// - Keeps URL in sync with dropdown (history.replaceState)
// - Refresh preserves selection

const API_URL = "/api/energy_prices_latest_ui.json";
const STORAGE_KEY = "energy_prices_selected_fuel_key";
const URL_PARAM_FUEL = "fuel";

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
  // Example: "Gasoline — Retail"
  return `${f.fuel} — ${f.sector}`;
}

function computeFuelKeysSignature(fuels) {
  return fuels.map((f) => f.fuel_key).join("|");
}

function loadStoredSelection() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v ? String(v) : null;
  } catch {
    return null;
  }
}

function storeSelection(fuelKey) {
  try {
    if (fuelKey) localStorage.setItem(STORAGE_KEY, String(fuelKey));
  } catch {
    // ignore
  }
}

function parseFuelKey(fuelKey) {
  // dataset::fuel::sector
  const parts = String(fuelKey || "").split("::");
  return {
    dataset: parts[0] || null,
    fuel: parts[1] || null,
    sector: parts[2] || null
  };
}

function readFuelKeyFromUrl() {
  try {
    const u = new URL(window.location.href);
    const v = u.searchParams.get(URL_PARAM_FUEL);
    return v ? String(v) : null;
  } catch {
    return null;
  }
}

function writeFuelKeyToUrl(fuelKey) {
  try {
    const u = new URL(window.location.href);
    if (fuelKey) u.searchParams.set(URL_PARAM_FUEL, fuelKey);
    else u.searchParams.delete(URL_PARAM_FUEL);

    // Don’t pollute browser history when someone toggles dropdown
    window.history.replaceState({}, "", u.toString());
  } catch {
    // ignore
  }
}

// Keep these across refreshes
let lastData = null;
let lastFuelKeysSignature = null;

// Precedence for initial selection:
// 1) URL ?fuel=...
// 2) localStorage
// 3) first option
let selectedFuelKey = readFuelKeyFromUrl() || loadStoredSelection();

let isLoading = false;

function chooseBestAvailableFuelKey(fuels, desiredKey) {
  if (!Array.isArray(fuels) || fuels.length === 0) return null;

  const keys = new Set(fuels.map((f) => f.fuel_key));

  // 1) Exact match
  if (desiredKey && keys.has(desiredKey)) return desiredKey;

  // 2) Best-effort match by dataset + fuel (ignore sector changes)
  if (desiredKey) {
    const want = parseFuelKey(desiredKey);
    if (want.dataset && want.fuel) {
      const candidate = fuels.find((f) => f.dataset === want.dataset && f.fuel === want.fuel);
      if (candidate?.fuel_key) return candidate.fuel_key;
    }
  }

  // 3) Fall back to first option
  return fuels[0].fuel_key || null;
}

function ensureDropdownPopulated(data) {
  const fuels = Array.isArray(data?.fuels) ? data.fuels : [];
  const sig = computeFuelKeysSignature(fuels);

  const sel = $("fuelSelect");

  // Rebuild ONLY if fuels changed
  if (sig && sig !== lastFuelKeysSignature) {
    lastFuelKeysSignature = sig;

    clearChildren(sel);
    for (const f of fuels) {
      const opt = document.createElement("option");
      opt.value = f.fuel_key;
      opt.textContent = buildFuelOptionLabel(f);
      sel.appendChild(opt);
    }
  }

  // Always ensure selection is valid and applied
  selectedFuelKey = chooseBestAvailableFuelKey(fuels, selectedFuelKey);

  if (selectedFuelKey) {
    sel.value = selectedFuelKey;

    // Keep everything in sync (storage + URL)
    storeSelection(selectedFuelKey);
    writeFuelKeyToUrl(selectedFuelKey);
  }
}

function renderMeta(data) {
  text($("generatedAt"), data?.meta?.generated_at || "—");
}

function renderTable(data) {
  const tbody = $("tbody");
  clearChildren(tbody);

  const geos = Array.isArray(data?.geos) ? data.geos : [];
  const values = data?.values && typeof data.values === "object" ? data.values : {};

  const grid = selectedFuelKey ? values[selectedFuelKey] : null;

  let fallbackCount = 0;

  for (const g of geos) {
    const geo = g.geo_code;
    const cell = grid ? grid[geo] : null;

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

    const directOrFallback = isFallback ? "fallback" : "direct";

    const tr = document.createElement("tr");
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

async function fetchLatest({ bustCache } = {}) {
  const url = bustCache ? `${API_URL}?t=${Date.now()}` : API_URL;

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

async function refresh({ bustCache } = {}) {
  if (isLoading) return;
  isLoading = true;

  hideError();
  $("refreshBtn").disabled = true;
  $("fuelSelect").disabled = true;

  try {
    const data = await fetchLatest({ bustCache });
    lastData = data;

    // Capture current selection from UI (if any) before reconciling
    const sel = $("fuelSelect");
    if (sel?.value) selectedFuelKey = sel.value;

    ensureDropdownPopulated(data);
    renderMeta(data);
    renderTable(data);
  } catch (err) {
    showError(err?.message || String(err));
    setPill(false, 0);
  } finally {
    $("refreshBtn").disabled = false;
    $("fuelSelect").disabled = false;
    isLoading = false;
  }
}

function init() {
  const sel = $("fuelSelect");
  const btn = $("refreshBtn");

  sel.addEventListener("change", () => {
    selectedFuelKey = sel.value;
    storeSelection(selectedFuelKey);
    writeFuelKeyToUrl(selectedFuelKey);

    if (lastData) {
      ensureDropdownPopulated(lastData);
      renderMeta(lastData);
      renderTable(lastData);
    }
  });

  btn.addEventListener("click", () => {
    // Bust cache on manual refresh
    refresh({ bustCache: true });
  });

  // Initial load (respects CDN cache)
  refresh({ bustCache: false });
}

init();
