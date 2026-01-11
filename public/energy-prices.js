// public/energy-prices.js
//
// UI for /energy-prices.html
// Reads: /api/energy_prices_latest_ui.json
// Renders a matrix by (fuel_key x geo_code).
//
// Fixes:
// - Always populate fuel dropdown from data.fuels
// - Always select a valid default fuel_key
// - Render safely even if some cells are missing

const API_PATH = "/api/energy_prices_latest_ui.json";

const fuelSelect = document.getElementById("fuelSelect");
const refreshBtn = document.getElementById("refreshBtn");
const tbody = document.getElementById("tbody");
const generatedAt = document.getElementById("generatedAt");
const statusPill = document.getElementById("statusPill");
const errorBox = document.getElementById("errorBox");

function setError(message) {
  errorBox.style.display = "block";
  errorBox.textContent = message;
}

function clearError() {
  errorBox.style.display = "none";
  errorBox.textContent = "";
}

function setStatus(ok, fallbackCount, totalGeos) {
  statusPill.classList.remove("ok", "fb");
  if (!ok) {
    statusPill.textContent = "error";
    return;
  }

  const fb = Number.isFinite(fallbackCount) ? fallbackCount : 0;
  const total = Number.isFinite(totalGeos) ? totalGeos : 0;

  // If there are fallbacks, highlight as fb; otherwise ok
  statusPill.classList.add(fb > 0 ? "fb" : "ok");
  statusPill.textContent = `ok (${fb} fallback)`;
}

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function dashIfNull(v) {
  return v === null || v === undefined || v === "" ? "—" : String(v);
}

function buildFuelOptions(fuels) {
  fuelSelect.innerHTML = "";

  for (const f of fuels) {
    const opt = document.createElement("option");
    opt.value = f.fuel_key;
    // label: "Heating Oil (heating_fuels_latest)" etc.
    opt.textContent = `${f.fuel} (${f.dataset})`;
    fuelSelect.appendChild(opt);
  }
}

function ensureValidSelectedFuelKey(data) {
  const fuels = Array.isArray(data?.fuels) ? data.fuels : [];
  if (fuels.length === 0) throw new Error("UI: data.fuels is missing or empty.");

  // If nothing selected or selected key not present in values, choose first
  const current = fuelSelect.value;
  const hasValuesForCurrent =
    current && data?.values && Object.prototype.hasOwnProperty.call(data.values, current);

  if (!hasValuesForCurrent) {
    fuelSelect.value = fuels[0].fuel_key;
  }

  // Still invalid? hard fail
  const chosen = fuelSelect.value;
  if (!chosen || !data?.values || !Object.prototype.hasOwnProperty.call(data.values, chosen)) {
    throw new Error("UI: could not select a valid fuel_key (values missing for selection).");
  }

  return chosen;
}

function computeFallbackCountForFuel(data, fuelKey) {
  const geos = Array.isArray(data?.geos) ? data.geos : [];
  const cellMap = data?.values?.[fuelKey] || {};
  let fb = 0;

  for (const g of geos) {
    const geo = g.geo_code;
    const cell = cellMap?.[geo];
    if (!cell) {
      // if missing, treat as fallback/missing
      fb++;
      continue;
    }
    if (cell.is_fallback) fb++;
  }
  return { fallbackCount: fb, totalGeos: geos.length };
}

function renderTable(data, fuelKey) {
  const geos = Array.isArray(data?.geos) ? data.geos : [];
  const cellMap = data?.values?.[fuelKey] || {};

  const rowsHtml = geos
    .map((g) => {
      const geo = g.geo_code;
      const name = g.geo_display_name || geo;

      const cell = cellMap?.[geo] || null;

      const price = cell ? cell.price : null;
      const units = cell ? cell.units : null;
      const period = cell ? cell.period : null;

      const isFallback = cell ? !!cell.is_fallback : true;
      const fbFrom = cell ? cell.fallback_from_geo_code : null;

      const df = isFallback ? "fallback" : "direct";

      return `
        <tr>
          <td>${esc(name)}<div class="mono">${esc(geo)}</div></td>
          <td>${esc(dashIfNull(price))}</td>
          <td>${esc(dashIfNull(units))}</td>
          <td>${esc(dashIfNull(period))}</td>
          <td>${esc(df)}</td>
          <td>${esc(isFallback ? dashIfNull(fbFrom) : "—")}</td>
        </tr>
      `;
    })
    .join("");

  tbody.innerHTML = rowsHtml;
}

async function fetchUiJson({ bustCache = false } = {}) {
  const url = bustCache ? `${API_PATH}?t=${Date.now()}` : API_PATH;

  const res = await fetch(url, {
    headers: { accept: "application/json" },
    // browser-side hint; Netlify edge may still serve cache within TTL (that's OK)
    cache: "no-store"
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Fetch failed (${res.status}) for ${url}\n\n${text.slice(0, 500)}`);
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON from ${url}\n\n${text.slice(0, 500)}`);
  }
}

function setGeneratedAt(data) {
  const ga = data?.meta?.generated_at || null;
  generatedAt.textContent = ga ? String(ga) : "—";
}

async function loadAndRender({ bustCache = false } = {}) {
  clearError();
  statusPill.textContent = "loading…";
  statusPill.classList.remove("ok", "fb");

  const data = await fetchUiJson({ bustCache });

  setGeneratedAt(data);

  const fuels = Array.isArray(data?.fuels) ? data.fuels : [];
  if (fuels.length === 0) throw new Error("UI: fuels[] empty in response.");

  // Always rebuild dropdown from server response (keeps in sync)
  buildFuelOptions(fuels);

  // Force valid selection
  const fuelKey = ensureValidSelectedFuelKey(data);

  // Render
  renderTable(data, fuelKey);

  // Status pill
  const { fallbackCount, totalGeos } = computeFallbackCountForFuel(data, fuelKey);
  setStatus(true, fallbackCount, totalGeos);
}

fuelSelect.addEventListener("change", async () => {
  try {
    // Don’t refetch; just reload + re-render from API to be safe and simple
    await loadAndRender({ bustCache: false });
  } catch (e) {
    setStatus(false);
    setError(String(e?.message || e));
  }
});

refreshBtn.addEventListener("click", async () => {
  try {
    await loadAndRender({ bustCache: true });
  } catch (e) {
    setStatus(false);
    setError(String(e?.message || e));
  }
});

// Initial load
loadAndRender({ bustCache: false }).catch((e) => {
  setStatus(false);
  setError(String(e?.message || e));
});
