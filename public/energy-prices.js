// public/energy-prices.js
//
// UI for /api/energy_prices_latest_ui.json
// - Stable dropdown selection + URL deep-link (?fuel=...)
// - Direct-only toggle hides fallback rows
// - Show-only-missing toggle hides rows where price is present
// - Persists selection + toggles in localStorage + URL
// - Refresh preserves selection
// - Copy link button
// - "Updated X ago" indicator based on meta.generated_at

const API_URL = "/api/energy_prices_latest_ui.json";

const STORAGE_KEY_FUEL = "energy_prices_selected_fuel_key";
const STORAGE_KEY_DIRECT_ONLY = "energy_prices_direct_only";
const STORAGE_KEY_MISSING_ONLY = "energy_prices_missing_only";

const URL_PARAM_FUEL = "fuel";
const URL_PARAM_DIRECT = "direct";  // 1 or 0
const URL_PARAM_MISSING = "missing"; // 1 or 0

function $(id) {
  return document.getElementById(id);
}

function text(el, v) {
  if (!el) return;
  el.textContent = v == null ? "" : String(v);
}

function clearChildren(el) {
  if (!el) return;
  while (el.firstChild) el.removeChild(el.firstChild);
}

function fmt(v) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  const s = String(v).trim();
  return s ? s : "—";
}

function showError(err) {
  const box = $("errorBox");
  if (!box) return;
  box.style.display = "block";
  box.textContent = String(err);
}

function hideError() {
  const box = $("errorBox");
  if (!box) return;
  box.style.display = "none";
  box.textContent = "";
}

function buildFuelOptionLabel(f) {
  return `${f.fuel} — ${f.sector}`;
}

function computeFuelKeysSignature(fuels) {
  return fuels.map((f) => f.fuel_key).join("|");
}

function parseFuelKey(fuelKey) {
  const parts = String(fuelKey || "").split("::");
  return {
    dataset: parts[0] || null,
    fuel: parts[1] || null,
    sector: parts[2] || null
  };
}

function readBoolStorage(key) {
  try {
    const v = localStorage.getItem(key);
    if (v === "1") return true;
    if (v === "0") return false;
    return null;
  } catch {
    return null;
  }
}

function writeBoolStorage(key, v) {
  try {
    localStorage.setItem(key, v ? "1" : "0");
  } catch {
    // ignore
  }
}

function loadStoredFuelSelection() {
  try {
    const v = localStorage.getItem(STORAGE_KEY_FUEL);
    return v ? String(v) : null;
  } catch {
    return null;
  }
}

function storeFuelSelection(fuelKey) {
  try {
    if (fuelKey) localStorage.setItem(STORAGE_KEY_FUEL, String(fuelKey));
  } catch {
    // ignore
  }
}

function parseBoolParam(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  return s === "1" || s === "true" || s === "yes" || s === "y";
}

function readUrlParams() {
  try {
    const u = new URL(window.location.href);
    return {
      fuel: u.searchParams.get(URL_PARAM_FUEL),
      directOnly: parseBoolParam(u.searchParams.get(URL_PARAM_DIRECT)),
      missingOnly: parseBoolParam(u.searchParams.get(URL_PARAM_MISSING))
    };
  } catch {
    return { fuel: null, directOnly: null, missingOnly: null };
  }
}

function writeUrlParams({ fuelKey, directOnly, missingOnly }) {
  try {
    const u = new URL(window.location.href);

    if (fuelKey) u.searchParams.set(URL_PARAM_FUEL, fuelKey);
    else u.searchParams.delete(URL_PARAM_FUEL);

    u.searchParams.set(URL_PARAM_DIRECT, directOnly ? "1" : "0");
    u.searchParams.set(URL_PARAM_MISSING, missingOnly ? "1" : "0");

    window.history.replaceState({}, "", u.toString());
  } catch {
    // ignore
  }
}

function makeDeepLink({ fuelKey, directOnly, missingOnly }) {
  try {
    const u = new URL(window.location.href);
    if (fuelKey) u.searchParams.set(URL_PARAM_FUEL, fuelKey);
    else u.searchParams.delete(URL_PARAM_FUEL);
    u.searchParams.set(URL_PARAM_DIRECT, directOnly ? "1" : "0");
    u.searchParams.set(URL_PARAM_MISSING, missingOnly ? "1" : "0");
    return u.toString();
  } catch {
    return window.location.href;
  }
}

function formatUpdatedAgo(iso) {
  if (!iso) return "—";
  const t = Date.parse(String(iso));
  if (!Number.isFinite(t)) return "—";

  const now = Date.now();
  let diffMs = now - t;
  if (!Number.isFinite(diffMs)) return "—";
  if (diffMs < 0) diffMs = 0;

  const sec = Math.floor(diffMs / 1000);
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;

  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;

  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;

  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function chooseBestAvailableFuelKey(fuels, desiredKey) {
  if (!Array.isArray(fuels) || fuels.length === 0) return null;

  const keys = new Set(fuels.map((f) => f.fuel_key));

  // 1) exact
  if (desiredKey && keys.has(desiredKey)) return desiredKey;

  // 2) match by dataset+fuel ignoring sector changes
  if (desiredKey) {
    const want = parseFuelKey(desiredKey);
    if (want.dataset && want.fuel) {
      const candidate = fuels.find((f) => f.dataset === want.dataset && f.fuel === want.fuel);
      if (candidate?.fuel_key) return candidate.fuel_key;
    }
  }

  // 3) first
  return fuels[0].fuel_key || null;
}

function currentSelectedLabelFromData(data, selectedFuelKey) {
  const fuels = Array.isArray(data?.fuels) ? data.fuels : [];
  const f = fuels.find((x) => x.fuel_key === selectedFuelKey);
  if (f) return `${f.fuel} — ${f.sector}`;
  return selectedFuelKey || "—";
}

function setSelectedSummary(data) {
  const el = $("selectedSummary");
  if (!el) return;
  if (!data) {
    el.textContent = selectedFuelKey || "—";
    return;
  }
  el.textContent = currentSelectedLabelFromData(data, selectedFuelKey);
}

function setPill(ok, filtersLabel) {
  const pill = $("statusPill");
  if (!pill) return;

  pill.classList.remove("ok", "fb");

  if (!ok) {
    pill.classList.add("fb");
    pill.textContent = "error";
    return;
  }

  pill.classList.add("ok");
  pill.textContent = filtersLabel ? `ok (${filtersLabel})` : "ok";
}

function computeFiltersLabel({ shownRows, totalGeos, directOnly, missingOnly, fallbackShown }) {
  const parts = [];
  if (directOnly) parts.push(`direct: ${shownRows}/${totalGeos}`);
  if (missingOnly) parts.push(`missing: ${shownRows}/${totalGeos}`);
  if (!directOnly && !missingOnly && fallbackShown > 0) parts.push(`${fallbackShown} fallback`);
  return parts.join(", ");
}

// State
let lastData = null;
let lastFuelKeysSignature = null;

// initial state: URL overrides storage
const initial = readUrlParams();

let selectedFuelKey = (initial.fuel && String(initial.fuel)) || loadStoredFuelSelection();

let directOnly =
  initial.directOnly !== null ? initial.directOnly : (readBoolStorage(STORAGE_KEY_DIRECT_ONLY) ?? false);

let missingOnly =
  initial.missingOnly !== null ? initial.missingOnly : (readBoolStorage(STORAGE_KEY_MISSING_ONLY) ?? false);

let isLoading = false;
let updatedAgoTimer = null;

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

function ensureDropdownPopulated(data) {
  const fuels = Array.isArray(data?.fuels) ? data.fuels : [];
  const sig = computeFuelKeysSignature(fuels);
  const sel = $("fuelSelect");

  // Rebuild only if fuels changed
  if (sel && sig && sig !== lastFuelKeysSignature) {
    lastFuelKeysSignature = sig;

    clearChildren(sel);
    for (const f of fuels) {
      const opt = document.createElement("option");
      opt.value = f.fuel_key;
      opt.textContent = buildFuelOptionLabel(f);
      sel.appendChild(opt);
    }
  }

  selectedFuelKey = chooseBestAvailableFuelKey(fuels, selectedFuelKey);

  if (sel && selectedFuelKey) sel.value = selectedFuelKey;

  storeFuelSelection(selectedFuelKey);
  setSelectedSummary(data);

  writeUrlParams({
    fuelKey: selectedFuelKey,
    directOnly: !!directOnly,
    missingOnly: !!missingOnly
  });
}

function renderMeta(data) {
  text($("generatedAt"), data?.meta?.generated_at || "—");
  text($("updatedAgo"), formatUpdatedAgo(data?.meta?.generated_at || null));

  if (updatedAgoTimer) {
    clearInterval(updatedAgoTimer);
    updatedAgoTimer = null;
  }
  updatedAgoTimer = setInterval(() => {
    if (!lastData) return;
    text($("updatedAgo"), formatUpdatedAgo(lastData?.meta?.generated_at || null));
  }, 10_000);
}

function renderTable(data) {
  const tbody = $("tbody");
  clearChildren(tbody);

  const geos = Array.isArray(data?.geos) ? data.geos : [];
  const values = data?.values && typeof data.values === "object" ? data.values : {};
  const grid = selectedFuelKey ? values[selectedFuelKey] : null;

  let shownRows = 0;
  let fallbackShown = 0;

  for (const g of geos) {
    const geo = g.geo_code;
    const cell = grid ? grid[geo] : null;

    const price = cell?.price ?? null;
    const units = cell?.units ?? null;
    const period = cell?.period ?? null;

    const isFallback = cell?.is_fallback === true;

    // Filter 1: direct-only hides fallback
    if (directOnly && isFallback) continue;

    // Filter 2: missing-only hides rows where price exists
    const isMissing = price === null || price === undefined;
    if (missingOnly && !isMissing) continue;

    shownRows += 1;
    if (isFallback) fallbackShown += 1;

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
    tbody?.appendChild(tr);
  }

  const filtersLabel = computeFiltersLabel({
    shownRows,
    totalGeos: geos.length,
    directOnly: !!directOnly,
    missingOnly: !!missingOnly,
    fallbackShown
  });

  setPill(!!data?.ok, filtersLabel);
}

async function refresh({ bustCache } = {}) {
  if (isLoading) return;
  isLoading = true;

  hideError();

  const btn = $("refreshBtn");
  const sel = $("fuelSelect");
  const toggleDirect = $("directOnlyToggle");
  const toggleMissing = $("missingOnlyToggle");
  const copyBtn = $("copyLinkBtn");

  if (btn) btn.disabled = true;
  if (sel) sel.disabled = true;
  if (toggleDirect) toggleDirect.disabled = true;
  if (toggleMissing) toggleMissing.disabled = true;
  if (copyBtn) copyBtn.disabled = true;

  try {
    const data = await fetchLatest({ bustCache });
    lastData = data;

    // Capture current UI state first
    if (sel?.value) selectedFuelKey = sel.value;
    if (toggleDirect) directOnly = !!toggleDirect.checked;
    if (toggleMissing) missingOnly = !!toggleMissing.checked;

    storeFuelSelection(selectedFuelKey);
    writeBoolStorage(STORAGE_KEY_DIRECT_ONLY, !!directOnly);
    writeBoolStorage(STORAGE_KEY_MISSING_ONLY, !!missingOnly);

    ensureDropdownPopulated(data);
    renderMeta(data);
    renderTable(data);
  } catch (err) {
    showError(err?.message || String(err));
    setPill(false, "");
    text($("updatedAgo"), "—");
  } finally {
    if (btn) btn.disabled = false;
    if (sel) sel.disabled = false;
    if (toggleDirect) toggleDirect.disabled = false;
    if (toggleMissing) toggleMissing.disabled = false;
    if (copyBtn) copyBtn.disabled = false;
    isLoading = false;
  }
}

async function copyCurrentLink() {
  const url = makeDeepLink({
    fuelKey: selectedFuelKey,
    directOnly: !!directOnly,
    missingOnly: !!missingOnly
  });

  try {
    await navigator.clipboard.writeText(url);
    const btn = $("copyLinkBtn");
    if (btn) {
      const old = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => {
        btn.textContent = old || "Copy link";
      }, 900);
    }
  } catch {
    window.prompt("Copy this link:", url);
  }
}

function init() {
  const sel = $("fuelSelect");
  const btn = $("refreshBtn");
  const toggleDirect = $("directOnlyToggle");
  const toggleMissing = $("missingOnlyToggle");
  const copyBtn = $("copyLinkBtn");

  // apply initial toggle states to UI + persistence + URL
  if (toggleDirect) toggleDirect.checked = !!directOnly;
  if (toggleMissing) toggleMissing.checked = !!missingOnly;

  writeBoolStorage(STORAGE_KEY_DIRECT_ONLY, !!directOnly);
  writeBoolStorage(STORAGE_KEY_MISSING_ONLY, !!missingOnly);

  writeUrlParams({
    fuelKey: selectedFuelKey,
    directOnly: !!directOnly,
    missingOnly: !!missingOnly
  });

  setSelectedSummary(null);

  sel?.addEventListener("change", () => {
    selectedFuelKey = sel.value;
    storeFuelSelection(selectedFuelKey);

    writeUrlParams({
      fuelKey: selectedFuelKey,
      directOnly: !!directOnly,
      missingOnly: !!missingOnly
    });

    if (lastData) {
      ensureDropdownPopulated(lastData);
      renderMeta(lastData);
      renderTable(lastData);
    } else {
      setSelectedSummary(null);
    }
  });

  toggleDirect?.addEventListener("change", () => {
    directOnly = !!toggleDirect.checked;
    writeBoolStorage(STORAGE_KEY_DIRECT_ONLY, !!directOnly);

    writeUrlParams({
      fuelKey: selectedFuelKey,
      directOnly: !!directOnly,
      missingOnly: !!missingOnly
    });

    if (lastData) renderTable(lastData);
  });

  toggleMissing?.addEventListener("change", () => {
    missingOnly = !!toggleMissing.checked;
    writeBoolStorage(STORAGE_KEY_MISSING_ONLY, !!missingOnly);

    writeUrlParams({
      fuelKey: selectedFuelKey,
      directOnly: !!directOnly,
      missingOnly: !!missingOnly
    });

    if (lastData) renderTable(lastData);
  });

  btn?.addEventListener("click", () => {
    refresh({ bustCache: true });
  });

  copyBtn?.addEventListener("click", () => {
    copyCurrentLink();
  });

  // Initial load (respects CDN cache)
  refresh({ bustCache: false });
}

init();
