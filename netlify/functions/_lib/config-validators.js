import {
  hashStringMap,
  hashChainMap,
  firstNSortedLinesFromStringMap,
  firstNSortedLinesFromChainMap
} from "./geo_config_hash.js";

import crypto from "node:crypto";

/**
 * ---------- helpers ----------
 */
function assertNoUnknownTopLevelKeys(obj, allowedKeys, label) {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(obj).filter((k) => !allowed.has(k));
  if (unknown.length) {
    throw new Error(`${label}: unknown top-level keys: ${unknown.join(", ")}`);
  }
}
function assertNoUnknownTopLevelKeys(obj, allowedKeys, label) {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(obj).filter((k) => !allowed.has(k));
  if (unknown.length) {
    throw new Error(`${label}: unknown top-level keys: ${unknown.join(", ")}`);
  }
}
function sha256Hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function assert(condition, msg) {
  if (!condition) throw new Error(`CONFIG_VALIDATION_FAILED: ${msg}`);
}

function isPlainObject(x) {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function assertExactKeys(obj, allowedKeys, context) {
  assert(isPlainObject(obj), `${context}: expected object`);
  const keys = Object.keys(obj).sort();
  const allowed = [...allowedKeys].sort();
  assert(
    keys.length === allowed.length && keys.every((k, i) => k === allowed[i]),
    `${context}: keys mismatch. got=[${keys.join(",")}], expected=[${allowed.join(",")}]`
  );
}

function assertArrayOfStrings(arr, context) {
  assert(Array.isArray(arr), `${context}: expected array`);
  for (let i = 0; i < arr.length; i++) {
    assert(typeof arr[i] === "string", `${context}: item[${i}] not string`);
  }
}

function sortedListHash(list) {
  // Deterministic hash for a SET represented as a list of strings:
  // sort ASC, join with \n, sha256
  const sorted = [...list].slice().sort();
  return sha256Hex(sorted.join("\n"));
}

function mappingHash(mapObj) {
  // Deterministic hash for mapping layer:
  // lines of "KEY=VALUE", sort by KEY ASC, join \n, sha256
  const lines = Object.keys(mapObj)
    .slice()
    .sort()
    .map((k) => `${k}=${mapObj[k]}`);
  return sha256Hex(lines.join("\n"));
}

function assertExpectedCounts(countsObj, actualCounts, context) {
  assert(isPlainObject(countsObj), `${context}: expected_counts must be object`);
  for (const [k, expected] of Object.entries(countsObj)) {
    assert(
      Number.isInteger(expected) && expected >= 0,
      `${context}: expected_counts.${k} must be nonnegative integer`
    );
    assert(
      actualCounts[k] === expected,
      `${context}: expected_counts.${k} mismatch. got=${actualCounts[k]}, expected=${expected}`
    );
  }
}

function assertExpectedSortedFirstItems(firstItemsObj, actualSorted, context) {
  assert(
    isPlainObject(firstItemsObj),
    `${context}: expected_sorted_first_items must be object`
  );
  for (const [k, expectedFirst] of Object.entries(firstItemsObj)) {
    assertArrayOfStrings(expectedFirst, `${context}: expected_sorted_first_items.${k}`);
    const actualFirst = actualSorted[k].slice(0, expectedFirst.length);
    assert(
      expectedFirst.length === actualFirst.length &&
        expectedFirst.every((v, i) => v === actualFirst[i]),
      `${context}: expected_sorted_first_items.${k} mismatch. got=[${actualFirst.join(
        ","
      )}], expected=[${expectedFirst.join(",")}]`
    );
  }
}

function assertExpectedSetHashes(hashesObj, actualHashes, context) {
  assert(isPlainObject(hashesObj), `${context}: expected_set_hashes must be object`);
  for (const [k, expectedHash] of Object.entries(hashesObj)) {
    assert(typeof expectedHash === "string", `${context}: expected_set_hashes.${k} must be string`);
    assert(
      actualHashes[k] === expectedHash,
      `${context}: expected_set_hashes.${k} mismatch. got=${actualHashes[k]}, expected=${expectedHash}`
    );
  }
}

/**
 * ---------- validators ----------
 */

export function validateGeoAcceptListsV1(doc) {
  const TOP_KEYS = [
    "schema_version",
    "description",
    "accepted_duoarea_petroleum_gnd",
    "accepted_duoarea_petroleum_wfr",
    "accepted_duoarea_natural_gas",
    "duoarea_to_geo_code",
    "expected_counts",
    "expected_sorted_first_items",
    "expected_set_hashes",
    "notes"
  ];

  assertExactKeys(doc, TOP_KEYS, "geo_accept_lists_v1");

  assert(doc.schema_version === 1, "geo_accept_lists_v1: schema_version must be 1");
  assert(typeof doc.description === "string", "geo_accept_lists_v1: description must be string");
  assert(isPlainObject(doc.notes), "geo_accept_lists_v1: notes must be object");

  // Lists
  assertArrayOfStrings(doc.accepted_duoarea_petroleum_gnd, "geo_accept_lists_v1.accepted_duoarea_petroleum_gnd");
  assertArrayOfStrings(doc.accepted_duoarea_petroleum_wfr, "geo_accept_lists_v1.accepted_duoarea_petroleum_wfr");
  assertArrayOfStrings(doc.accepted_duoarea_natural_gas, "geo_accept_lists_v1.accepted_duoarea_natural_gas");

  // Mapping
  assert(isPlainObject(doc.duoarea_to_geo_code), "geo_accept_lists_v1.duoarea_to_geo_code must be object");
  for (const [k, v] of Object.entries(doc.duoarea_to_geo_code)) {
    assert(typeof k === "string" && k.length > 0, "geo_accept_lists_v1.duoarea_to_geo_code has invalid key");
    assert(typeof v === "string" && v.length > 0, `geo_accept_lists_v1.duoarea_to_geo_code[${k}] invalid value`);
  }

  // Compute counts
  const actualCounts = {
    accepted_duoarea_petroleum_gnd: doc.accepted_duoarea_petroleum_gnd.length,
    accepted_duoarea_petroleum_wfr: doc.accepted_duoarea_petroleum_wfr.length,
    accepted_duoarea_natural_gas: doc.accepted_duoarea_natural_gas.length,
    duoarea_to_geo_code: Object.keys(doc.duoarea_to_geo_code).length
  };

  // Compute sorted-first-items
  const sorted = {
    accepted_duoarea_petroleum_gnd: [...doc.accepted_duoarea_petroleum_gnd].slice().sort(),
    accepted_duoarea_petroleum_wfr: [...doc.accepted_duoarea_petroleum_wfr].slice().sort(),
    accepted_duoarea_natural_gas: [...doc.accepted_duoarea_natural_gas].slice().sort(),
    duoarea_to_geo_code: Object.keys(doc.duoarea_to_geo_code)
      .slice()
      .sort()
      .map((k) => `${k}=${doc.duoarea_to_geo_code[k]}`)
  };

  // Compute hashes
  const actualHashes = {
    accepted_duoarea_petroleum_gnd: sortedListHash(doc.accepted_duoarea_petroleum_gnd),
    accepted_duoarea_petroleum_wfr: sortedListHash(doc.accepted_duoarea_petroleum_wfr),
    accepted_duoarea_natural_gas: sortedListHash(doc.accepted_duoarea_natural_gas),
    duoarea_to_geo_code: mappingHash(doc.duoarea_to_geo_code)
  };

  // Validate “no surprises” primitives
  assertExpectedCounts(doc.expected_counts, actualCounts, "geo_accept_lists_v1");
  assertExpectedSortedFirstItems(doc.expected_sorted_first_items, sorted, "geo_accept_lists_v1");
  assertExpectedSetHashes(doc.expected_set_hashes, actualHashes, "geo_accept_lists_v1");

  return { ok: true, actualCounts, actualHashes };
}

export function validateGeoDisplayNamesV1(doc) {
  const TOP_KEYS = ["schema_version", "description", "geo_display_names", "expected_counts"];
  assertExactKeys(doc, TOP_KEYS, "geo_display_names_v1");

  assert(doc.schema_version === 1, "geo_display_names_v1: schema_version must be 1");
  assert(typeof doc.description === "string", "geo_display_names_v1: description must be string");
  assert(isPlainObject(doc.geo_display_names), "geo_display_names_v1.geo_display_names must be object");

  for (const [k, v] of Object.entries(doc.geo_display_names)) {
    assert(typeof k === "string" && k.length > 0, "geo_display_names_v1.geo_display_names invalid key");
    assert(typeof v === "string" && v.length > 0, `geo_display_names_v1.geo_display_names[${k}] invalid value`);
  }

  const actualCounts = { geo_display_names: Object.keys(doc.geo_display_names).length };
  assertExpectedCounts(doc.expected_counts, actualCounts, "geo_display_names_v1");

  return { ok: true, actualCounts };
}

export function validateGeoFallbackMapV1(doc) {
  const TOP_KEYS = ["schema_version", "description", "fallback_chain_by_geo_code", "expected_counts"];
  assertExactKeys(doc, TOP_KEYS, "geo_fallback_map_v1");

  assert(doc.schema_version === 1, "geo_fallback_map_v1: schema_version must be 1");
  assert(typeof doc.description === "string", "geo_fallback_map_v1: description must be string");
  assert(isPlainObject(doc.fallback_chain_by_geo_code), "geo_fallback_map_v1.fallback_chain_by_geo_code must be object");

  for (const [geo, chain] of Object.entries(doc.fallback_chain_by_geo_code)) {
    assert(typeof geo === "string" && geo.length > 0, "geo_fallback_map_v1 invalid key");
    assertArrayOfStrings(chain, `geo_fallback_map_v1.fallback_chain_by_geo_code[${geo}]`);
    assert(chain.length >= 1, `geo_fallback_map_v1 chain for ${geo} must have at least 1 item`);
    // Must start with itself (strict)
    assert(chain[0] === geo, `geo_fallback_map_v1 chain for ${geo} must start with itself`);
    // Must end in US
    assert(chain[chain.length - 1] === "US", `geo_fallback_map_v1 chain for ${geo} must end with US (except US itself)`);
  }

  // Special-case: US chain is ["US"]
  assert(
    Array.isArray(doc.fallback_chain_by_geo_code.US) &&
      doc.fallback_chain_by_geo_code.US.length === 1 &&
      doc.fallback_chain_by_geo_code.US[0] === "US",
    "geo_fallback_map_v1: US chain must be [\"US\"]"
  );

  const actualCounts = { fallback_chain_by_geo_code: Object.keys(doc.fallback_chain_by_geo_code).length };
  assertExpectedCounts(doc.expected_counts, actualCounts, "geo_fallback_map_v1");

  return { ok: true, actualCounts };
}

/**
 * ---------- loader ----------
 * Fetch configs from your site (public/ folder).
 */
export async function loadAndValidateGeoConfigs({ baseUrl }) {
  assert(typeof baseUrl === "string" && baseUrl.startsWith("http"), "loadAndValidateGeoConfigs: baseUrl must be http(s) URL");

  const urls = {
    geo_accept_lists_v1: `${baseUrl}/geo_accept_lists_v1.json`,
    geo_display_names_v1: `${baseUrl}/geo_display_names_v1.json`,
    geo_fallback_map_v1: `${baseUrl}/geo_fallback_map_v1.json`
  };

  const [acceptRes, namesRes, fbRes] = await Promise.all([
    fetch(urls.geo_accept_lists_v1, { headers: { accept: "application/json" } }),
    fetch(urls.geo_display_names_v1, { headers: { accept: "application/json" } }),
    fetch(urls.geo_fallback_map_v1, { headers: { accept: "application/json" } })
  ]);

  assert(acceptRes.ok, `Failed to fetch geo_accept_lists_v1.json (${acceptRes.status})`);
  assert(namesRes.ok, `Failed to fetch geo_display_names_v1.json (${namesRes.status})`);
  assert(fbRes.ok, `Failed to fetch geo_fallback_map_v1.json (${fbRes.status})`);

  const [acceptDoc, namesDoc, fbDoc] = await Promise.all([acceptRes.json(), namesRes.json(), fbRes.json()]);

  const acceptInfo = validateGeoAcceptListsV1(acceptDoc);
  const namesInfo = validateGeoDisplayNamesV1(namesDoc);
  const fbInfo = validateGeoFallbackMapV1(fbDoc);

  return {
    urls,
    geo_accept_lists_v1: acceptDoc,
    geo_display_names_v1: namesDoc,
    geo_fallback_map_v1: fbDoc,
    validation: { acceptInfo, namesInfo, fbInfo }
  };
}
