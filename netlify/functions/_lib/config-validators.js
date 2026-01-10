// netlify/functions/_lib/config-validators.js
import crypto from "node:crypto";

import {
  hashStringMap,
  hashChainMap,
  firstNSortedLinesFromStringMap,
  firstNSortedLinesFromChainMap
} from "./geo_config_hash.js";

/**
 * ---------- small primitives ----------
 */
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

function assertExpectedCounts(expectedCounts, actualCounts, context) {
  assert(isPlainObject(expectedCounts), `${context}: expected_counts must be object`);
  for (const [k, expected] of Object.entries(expectedCounts)) {
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

function assertExpectedSortedFirstItems(expectedObj, actualSortedObj, context) {
  assert(isPlainObject(expectedObj), `${context}: expected_sorted_first_items must be object`);
  for (const [k, expectedFirst] of Object.entries(expectedObj)) {
    assertArrayOfStrings(expectedFirst, `${context}: expected_sorted_first_items.${k}`);
    const actualFirst = (actualSortedObj[k] || []).slice(0, expectedFirst.length);
    assert(
      expectedFirst.length === actualFirst.length &&
        expectedFirst.every((v, i) => v === actualFirst[i]),
      `${context}: expected_sorted_first_items.${k} mismatch. got=[${actualFirst.join(
        ","
      )}], expected=[${expectedFirst.join(",")}]`
    );
  }
}

function assertExpectedSetHashes(expectedHashes, actualHashes, context) {
  assert(isPlainObject(expectedHashes), `${context}: expected_set_hashes must be object`);
  for (const [k, expectedHash] of Object.entries(expectedHashes)) {
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
  assertArrayOfStrings(
    doc.accepted_duoarea_petroleum_gnd,
    "geo_accept_lists_v1.accepted_duoarea_petroleum_gnd"
  );
  assertArrayOfStrings(
    doc.accepted_duoarea_petroleum_wfr,
    "geo_accept_lists_v1.accepted_duoarea_petroleum_wfr"
  );
  assertArrayOfStrings(
    doc.accepted_duoarea_natural_gas,
    "geo_accept_lists_v1.accepted_duoarea_natural_gas"
  );

  // Mapping
  assert(
    isPlainObject(doc.duoarea_to_geo_code),
    "geo_accept_lists_v1.duoarea_to_geo_code must be object"
  );
  for (const [k, v] of Object.entries(doc.duoarea_to_geo_code)) {
    assert(typeof k === "string" && k.length > 0, "geo_accept_lists_v1.duoarea_to_geo_code invalid key");
    assert(
      typeof v === "string" && v.length > 0,
      `geo_accept_lists_v1.duoarea_to_geo_code[${k}] invalid value`
    );
  }

  const actualCounts = {
    accepted_duoarea_petroleum_gnd: doc.accepted_duoarea_petroleum_gnd.length,
    accepted_duoarea_petroleum_wfr: doc.accepted_duoarea_petroleum_wfr.length,
    accepted_duoarea_natural_gas: doc.accepted_duoarea_natural_gas.length,
    duoarea_to_geo_code: Object.keys(doc.duoarea_to_geo_code).length
  };

  const actualSortedFirst = {
    accepted_duoarea_petroleum_gnd: [...doc.accepted_duoarea_petroleum_gnd].slice().sort(),
    accepted_duoarea_petroleum_wfr: [...doc.accepted_duoarea_petroleum_wfr].slice().sort(),
    accepted_duoarea_natural_gas: [...doc.accepted_duoarea_natural_gas].slice().sort(),
    // IMPORTANT: for mapping, “sorted first items” are locked as lines "KEY=VALUE"
    duoarea_to_geo_code: firstNSortedLinesFromStringMap(doc.duoarea_to_geo_code, 999999)
  };

  const actualHashes = {
    accepted_duoarea_petroleum_gnd: sortedListHash(doc.accepted_duoarea_petroleum_gnd),
    accepted_duoarea_petroleum_wfr: sortedListHash(doc.accepted_duoarea_petroleum_wfr),
    accepted_duoarea_natural_gas: sortedListHash(doc.accepted_duoarea_natural_gas),
    duoarea_to_geo_code: hashStringMap(doc.duoarea_to_geo_code)
  };

  assertExpectedCounts(doc.expected_counts, actualCounts, "geo_accept_lists_v1");
  assertExpectedSortedFirstItems(doc.expected_sorted_first_items, actualSortedFirst, "geo_accept_lists_v1");
  assertExpectedSetHashes(doc.expected_set_hashes, actualHashes, "geo_accept_lists_v1");

  return { ok: true, actualCounts, actualHashes };
}

export function validateGeoDisplayNamesV1(doc) {
  // Tight style: counts + sorted-first-items + set-hash
  const TOP_KEYS = [
    "schema_version",
    "description",
    "geo_display_names",
    "expected_counts",
    "expected_sorted_first_items",
    "expected_set_hashes"
  ];
  assertExactKeys(doc, TOP_KEYS, "geo_display_names_v1");

  assert(doc.schema_version === 1, "geo_display_names_v1: schema_version must be 1");
  assert(typeof doc.description === "string", "geo_display_names_v1: description must be string");
  assert(isPlainObject(doc.geo_display_names), "geo_display_names_v1.geo_display_names must be object");

  for (const [k, v] of Object.entries(doc.geo_display_names)) {
    assert(typeof k === "string" && k.length > 0, "geo_display_names_v1.geo_display_names invalid key");
    assert(
      typeof v === "string" && v.length > 0,
      `geo_display_names_v1.geo_display_names[${k}] invalid value`
    );
  }

  const actualCounts = { geo_display_names: Object.keys(doc.geo_display_names).length };
  const actualHashes = { geo_display_names: hashStringMap(doc.geo_display_names) };

  // For display names, sorted-first-items are locked as lines "GEO=Label"
  const sortedLines = firstNSortedLinesFromStringMap(doc.geo_display_names, 999999);
  const actualSortedFirst = { geo_display_names: sortedLines };

  assertExpectedCounts(doc.expected_counts, actualCounts, "geo_display_names_v1");
  assertExpectedSortedFirstItems(doc.expected_sorted_first_items, actualSortedFirst, "geo_display_names_v1");
  assertExpectedSetHashes(doc.expected_set_hashes, actualHashes, "geo_display_names_v1");

  return { ok: true, actualCounts, actualHashes };
}

export function validateGeoFallbackMapV1(doc) {
  // Tight style: counts + sorted-first-items + set-hash
  const TOP_KEYS = [
    "schema_version",
    "description",
    "fallback_chain_by_geo_code",
    "expected_counts",
    "expected_sorted_first_items",
    "expected_set_hashes"
  ];
  assertExactKeys(doc, TOP_KEYS, "geo_fallback_map_v1");

  assert(doc.schema_version === 1, "geo_fallback_map_v1: schema_version must be 1");
  assert(typeof doc.description === "string", "geo_fallback_map_v1: description must be string");
  assert(
    isPlainObject(doc.fallback_chain_by_geo_code),
    "geo_fallback_map_v1.fallback_chain_by_geo_code must be object"
  );

  for (const [geo, chain] of Object.entries(doc.fallback_chain_by_geo_code)) {
    assert(typeof geo === "string" && geo.length > 0, "geo_fallback_map_v1 invalid key");
    assertArrayOfStrings(chain, `geo_fallback_map_v1.fallback_chain_by_geo_code[${geo}]`);
    assert(chain.length >= 1, `geo_fallback_map_v1 chain for ${geo} must have at least 1 item`);
    // Must start with itself (strict)
    assert(chain[0] === geo, `geo_fallback_map_v1 chain for ${geo} must start with itself`);
    // Must end in US (US itself is special-cased below)
    assert(
      chain[chain.length - 1] === "US",
      `geo_fallback_map_v1 chain for ${geo} must end with US`
    );
  }

  // Special-case: US chain is ["US"]
  assert(
    Array.isArray(doc.fallback_chain_by_geo_code.US) &&
      doc.fallback_chain_by_geo_code.US.length === 1 &&
      doc.fallback_chain_by_geo_code.US[0] === "US",
    'geo_fallback_map_v1: US chain must be ["US"]'
  );

  const actualCounts = { fallback_chain_by_geo_code: Object.keys(doc.fallback_chain_by_geo_code).length };
  const actualHashes = { fallback_chain_by_geo_code: hashChainMap(doc.fallback_chain_by_geo_code) };

  // For fallback map, sorted-first-items are lines like "AK=AK>R20>US"
  const sortedLines = firstNSortedLinesFromChainMap(doc.fallback_chain_by_geo_code, 999999);
  const actualSortedFirst = { fallback_chain_by_geo_code: sortedLines };

  assertExpectedCounts(doc.expected_counts, actualCounts, "geo_fallback_map_v1");
  assertExpectedSortedFirstItems(doc.expected_sorted_first_items, actualSortedFirst, "geo_fallback_map_v1");
  assertExpectedSetHashes(doc.expected_set_hashes, actualHashes, "geo_fallback_map_v1");

  return { ok: true, actualCounts, actualHashes };
}

/**
 * ---------- loader ----------
 * Fetch configs from your site (public/ folder).
 */
export async function loadAndValidateGeoConfigs({ baseUrl }) {
  assert(
    typeof baseUrl === "string" && baseUrl.startsWith("http"),
    "loadAndValidateGeoConfigs: baseUrl must be http(s) URL"
  );

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

  const [acceptDoc, namesDoc, fbDoc] = await Promise.all([
    acceptRes.json(),
    namesRes.json(),
    fbRes.json()
  ]);

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
