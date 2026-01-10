// netlify/functions/_lib/config-validators.js
//
// Tight, auditable validators for:
//   - public/geo_accept_lists_v1.json
//   - public/geo_display_names_v1.json
//   - public/geo_fallback_map_v1.json
//
// “Tightening” included:
//   1) expected_* objects must have EXACT keys (no extras, no missing)
//   2) accept-lists must be unique (no duplicates)
//   3) mapping coverage checks: every accepted duoarea MUST exist in duoarea_to_geo_code
//      and duoarea_to_geo_code MUST NOT contain extra keys beyond the union of accept-lists + NUS
//   4) display-names + fallback-map keys must match the canonical geo universe
//      derived from duoarea_to_geo_code values plus US and region codes
//
// Notes:
// - This file assumes geo_config_hash.js provides deterministic hashing utilities.
// - Keep configs in the site root served from /public (so they load at /geo_*.json).

import {
  hashStringMap,
  hashChainMap,
  firstNSortedLinesFromStringMap,
  firstNSortedLinesFromChainMap
} from "./geo_config_hash.js";

/**
 * ---------- small primitives ----------
 */
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

function assertUniqueStringArray(arr, context) {
  assertArrayOfStrings(arr, context);
  const seen = new Set();
  const dups = [];
  for (const s of arr) {
    if (seen.has(s)) dups.push(s);
    seen.add(s);
  }
  assert(dups.length === 0, `${context}: duplicate items not allowed: ${dups.join(", ")}`);
}

function sortedSetHashFromList(list) {
  // Deterministic hash for a SET represented as a list of strings:
  // sort ASC, join with \n, sha256 using the sha256() inside geo_config_hash.js via hashStringMap? (No.)
  // We already lock hashes in the JSON using the same method as before:
  // sort ASC, join with \n, sha256
  //
  // Implemented via a tiny local helper using hashStringMap would be incorrect because hashStringMap expects key=value.
  // So we compute in-place using a stable algorithm below by reusing crypto via geo_config_hash.js is not available.
  // Instead: rely on the expected_set_hashes being computed in your build step with THIS algorithm.
  //
  // IMPORTANT: To avoid mismatch risk, we keep the original approach you already use elsewhere:
  //   sort list, join("\n"), sha256
  // We implement sha256 locally without importing crypto by using WebCrypto in runtime? Netlify node supports crypto,
  // but for simplicity and to keep consistent with your previous known-good behavior, we will NOT re-implement here.
  //
  // Therefore: we do NOT compute list hashes here anymore.
  // We will compute list hashes by converting the set into a synthetic map index->value and hashing stringMap would change output.
  // So: KEEP the previous method by importing node:crypto. (Netlify Functions run on Node, so this is safe.)
  throw new Error(
    "sortedSetHashFromList should not be called. Use sortedListHash() (implemented below) instead."
  );
}

// Keep the exact same list-hash algorithm you’ve already been using successfully.
import crypto from "node:crypto";
function sha256Hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}
function sortedListHash(list) {
  const sorted = [...list].slice().sort();
  return sha256Hex(sorted.join("\n"));
}

function mappingHash(mapObj) {
  // lines "KEY=VALUE", sort by KEY, join "\n", sha256
  const keys = Object.keys(mapObj).slice().sort();
  const lines = keys.map((k) => `${k}=${mapObj[k]}`);
  return sha256Hex(lines.join("\n"));
}

function assertExpectedCounts(expectedCounts, actualCounts, context, allowedCountKeys) {
  assert(isPlainObject(expectedCounts), `${context}: expected_counts must be object`);
  assertExactKeys(expectedCounts, allowedCountKeys, `${context}.expected_counts`);

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

function assertExpectedSortedFirstItems(expectedObj, actualSortedObj, context, allowedKeys) {
  assert(isPlainObject(expectedObj), `${context}: expected_sorted_first_items must be object`);
  assertExactKeys(expectedObj, allowedKeys, `${context}.expected_sorted_first_items`);

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

function assertExpectedSetHashes(expectedHashes, actualHashes, context, allowedKeys) {
  assert(isPlainObject(expectedHashes), `${context}: expected_set_hashes must be object`);
  assertExactKeys(expectedHashes, allowedKeys, `${context}.expected_set_hashes`);

  for (const [k, expectedHash] of Object.entries(expectedHashes)) {
    assert(typeof expectedHash === "string", `${context}: expected_set_hashes.${k} must be string`);
    assert(
      actualHashes[k] === expectedHash,
      `${context}: expected_set_hashes.${k} mismatch. got=${actualHashes[k]}, expected=${expectedHash}`
    );
  }
}

function toSortedArray(setOrArray) {
  return [...setOrArray].slice().sort();
}

function unionSets(...sets) {
  const out = new Set();
  for (const s of sets) for (const v of s) out.add(v);
  return out;
}

function assertNoUnknownKeysInObject(obj, allowedKeys, context) {
  assert(isPlainObject(obj), `${context}: expected object`);
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(obj).filter((k) => !allowed.has(k));
  assert(unknown.length === 0, `${context}: unknown keys: ${unknown.join(", ")}`);
}

function assertAllValuesInAllowedSet(arr, allowedSet, context) {
  const bad = [];
  for (const v of arr) if (!allowedSet.has(v)) bad.push(v);
  assert(bad.length === 0, `${context}: contains unsupported values: ${bad.join(", ")}`);
}

/**
 * Build canonical geo-code universe based on:
 * - Always includes "US"
 * - Includes all region codes present in duoarea_to_geo_code values (R10/R1X/...)
 * - Includes all state codes present in duoarea_to_geo_code values (AK/AL/.../DC)
 *
 * This is what display-names + fallback-map should cover EXACTLY.
 */
function deriveGeoUniverseFromDuoareaMapping(duoarea_to_geo_code) {
  const universe = new Set();
  universe.add("US");
  for (const geo of Object.values(duoarea_to_geo_code)) {
    universe.add(geo);
  }
  return universe;
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

  // Lists (tight: must be unique)
  assertUniqueStringArray(
    doc.accepted_duoarea_petroleum_gnd,
    "geo_accept_lists_v1.accepted_duoarea_petroleum_gnd"
  );
  assertUniqueStringArray(
    doc.accepted_duoarea_petroleum_wfr,
    "geo_accept_lists_v1.accepted_duoarea_petroleum_wfr"
  );
  assertUniqueStringArray(
    doc.accepted_duoarea_natural_gas,
    "geo_accept_lists_v1.accepted_duoarea_natural_gas"
  );

  // Mapping
  assert(isPlainObject(doc.duoarea_to_geo_code), "geo_accept_lists_v1.duoarea_to_geo_code must be object");
  for (const [k, v] of Object.entries(doc.duoarea_to_geo_code)) {
    assert(typeof k === "string" && k.length > 0, "geo_accept_lists_v1.duoarea_to_geo_code invalid key");
    assert(
      typeof v === "string" && v.length > 0,
      `geo_accept_lists_v1.duoarea_to_geo_code[${k}] invalid value`
    );
  }

  // Tightening: mapping must cover ALL accepted duoareas (no missing mapping)
  const setGnd = new Set(doc.accepted_duoarea_petroleum_gnd);
  const setWfr = new Set(doc.accepted_duoarea_petroleum_wfr);
  const setNg = new Set(doc.accepted_duoarea_natural_gas);
  const allAcceptedDuoareas = unionSets(setGnd, setWfr, setNg);

  const mappingKeys = new Set(Object.keys(doc.duoarea_to_geo_code));

  // Every accepted duoarea must exist as a mapping key
  const missingMapKeys = [];
  for (const duo of allAcceptedDuoareas) {
    if (!mappingKeys.has(duo)) missingMapKeys.push(duo);
  }
  assert(
    missingMapKeys.length === 0,
    `geo_accept_lists_v1: duoarea_to_geo_code missing keys for accepted duoareas: ${missingMapKeys.join(", ")}`
  );

  // Tightening: duoarea_to_geo_code must NOT contain extras beyond the union of accepted lists.
  // (This prevents accidental expansion of the mapping layer without also updating accept-lists.)
  const extraMapKeys = [];
  for (const k of mappingKeys) {
    if (!allAcceptedDuoareas.has(k)) extraMapKeys.push(k);
  }
  assert(
    extraMapKeys.length === 0,
    `geo_accept_lists_v1: duoarea_to_geo_code contains extra keys not present in any accept-list: ${extraMapKeys.join(
      ", "
    )}`
  );

  // Compute counts
  const actualCounts = {
    accepted_duoarea_petroleum_gnd: doc.accepted_duoarea_petroleum_gnd.length,
    accepted_duoarea_petroleum_wfr: doc.accepted_duoarea_petroleum_wfr.length,
    accepted_duoarea_natural_gas: doc.accepted_duoarea_natural_gas.length,
    duoarea_to_geo_code: Object.keys(doc.duoarea_to_geo_code).length
  };

  // Compute sorted-first-items (full sorted lists/lines)
  const actualSortedFirst = {
    accepted_duoarea_petroleum_gnd: [...doc.accepted_duoarea_petroleum_gnd].slice().sort(),
    accepted_duoarea_petroleum_wfr: [...doc.accepted_duoarea_petroleum_wfr].slice().sort(),
    accepted_duoarea_natural_gas: [...doc.accepted_duoarea_natural_gas].slice().sort(),
    // for mapping, lock as sorted "KEY=VALUE" lines
    duoarea_to_geo_code: firstNSortedLinesFromStringMap(doc.duoarea_to_geo_code, 999999)
  };

  // Compute hashes
  const actualHashes = {
    accepted_duoarea_petroleum_gnd: sortedListHash(doc.accepted_duoarea_petroleum_gnd),
    accepted_duoarea_petroleum_wfr: sortedListHash(doc.accepted_duoarea_petroleum_wfr),
    accepted_duoarea_natural_gas: sortedListHash(doc.accepted_duoarea_natural_gas),
    duoarea_to_geo_code: mappingHash(doc.duoarea_to_geo_code)
  };

  // Tightening: expected_* objects must have exact keys (no extras, no missing)
  const EXPECTED_KEYS = [
    "accepted_duoarea_petroleum_gnd",
    "accepted_duoarea_petroleum_wfr",
    "accepted_duoarea_natural_gas",
    "duoarea_to_geo_code"
  ];

  assertExpectedCounts(doc.expected_counts, actualCounts, "geo_accept_lists_v1", EXPECTED_KEYS);
  assertExpectedSortedFirstItems(
    doc.expected_sorted_first_items,
    actualSortedFirst,
    "geo_accept_lists_v1",
    EXPECTED_KEYS
  );
  assertExpectedSetHashes(doc.expected_set_hashes, actualHashes, "geo_accept_lists_v1", EXPECTED_KEYS);

  // Return accept-lists + the canonical derived geo universe for downstream validators
  const geoUniverse = deriveGeoUniverseFromDuoareaMapping(doc.duoarea_to_geo_code);

  return { ok: true, actualCounts, actualHashes, geoUniverse };
}

export function validateGeoDisplayNamesV1(doc, { geoUniverse }) {
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

  // Tightening: keys must EXACTLY match geoUniverse
  assert(
    geoUniverse instanceof Set && geoUniverse.size > 0,
    "geo_display_names_v1: internal error (geoUniverse missing)"
  );

  const nameKeys = Object.keys(doc.geo_display_names);
  const universeArr = toSortedArray(geoUniverse);
  assertExactKeys(doc.geo_display_names, universeArr, "geo_display_names_v1.geo_display_names");

  const actualCounts = { geo_display_names: nameKeys.length };
  const actualHashes = { geo_display_names: hashStringMap(doc.geo_display_names) };
  const sortedLines = firstNSortedLinesFromStringMap(doc.geo_display_names, 999999);
  const actualSortedFirst = { geo_display_names: sortedLines };

  const EXPECTED_KEYS = ["geo_display_names"];
  assertExpectedCounts(doc.expected_counts, actualCounts, "geo_display_names_v1", EXPECTED_KEYS);
  assertExpectedSortedFirstItems(
    doc.expected_sorted_first_items,
    actualSortedFirst,
    "geo_display_names_v1",
    EXPECTED_KEYS
  );
  assertExpectedSetHashes(doc.expected_set_hashes, actualHashes, "geo_display_names_v1", EXPECTED_KEYS);

  return { ok: true, actualCounts, actualHashes };
}

export function validateGeoFallbackMapV1(doc, { geoUniverse }) {
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

  assert(
    geoUniverse instanceof Set && geoUniverse.size > 0,
    "geo_fallback_map_v1: internal error (geoUniverse missing)"
  );

  // Tightening: fallback keys must EXACTLY match geoUniverse
  const fbKeys = Object.keys(doc.fallback_chain_by_geo_code);
  const universeArr = toSortedArray(geoUniverse);
  assertExactKeys(doc.fallback_chain_by_geo_code, universeArr, "geo_fallback_map_v1.fallback_chain_by_geo_code");

  for (const [geo, chain] of Object.entries(doc.fallback_chain_by_geo_code)) {
    assert(typeof geo === "string" && geo.length > 0, "geo_fallback_map_v1 invalid key");
    assertArrayOfStrings(chain, `geo_fallback_map_v1.fallback_chain_by_geo_code[${geo}]`);
    assert(chain.length >= 1, `geo_fallback_map_v1 chain for ${geo} must have at least 1 item`);

    // Must start with itself
    assert(chain[0] === geo, `geo_fallback_map_v1 chain for ${geo} must start with itself`);

    // Must only contain values from geoUniverse
    assertAllValuesInAllowedSet(chain, geoUniverse, `geo_fallback_map_v1 chain for ${geo}`);

    // Must end in US (US itself is special-cased below)
    assert(chain[chain.length - 1] === "US", `geo_fallback_map_v1 chain for ${geo} must end with US`);
  }

  // Special-case: US chain is ["US"]
  assert(
    Array.isArray(doc.fallback_chain_by_geo_code.US) &&
      doc.fallback_chain_by_geo_code.US.length === 1 &&
      doc.fallback_chain_by_geo_code.US[0] === "US",
    'geo_fallback_map_v1: US chain must be ["US"]'
  );

  const actualCounts = { fallback_chain_by_geo_code: fbKeys.length };
  const actualHashes = { fallback_chain_by_geo_code: hashChainMap(doc.fallback_chain_by_geo_code) };

  const sortedLines = firstNSortedLinesFromChainMap(doc.fallback_chain_by_geo_code, 999999);
  const actualSortedFirst = { fallback_chain_by_geo_code: sortedLines };

  const EXPECTED_KEYS = ["fallback_chain_by_geo_code"];
  assertExpectedCounts(doc.expected_counts, actualCounts, "geo_fallback_map_v1", EXPECTED_KEYS);
  assertExpectedSortedFirstItems(
    doc.expected_sorted_first_items,
    actualSortedFirst,
    "geo_fallback_map_v1",
    EXPECTED_KEYS
  );
  assertExpectedSetHashes(doc.expected_set_hashes, actualHashes, "geo_fallback_map_v1", EXPECTED_KEYS);

  return { ok: true, actualCounts, actualHashes };
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

  // Validate accept-lists first, because it derives the canonical geo universe used to validate the other two.
  const acceptInfo = validateGeoAcceptListsV1(acceptDoc);

  const namesInfo = validateGeoDisplayNamesV1(namesDoc, { geoUniverse: acceptInfo.geoUniverse });
  const fbInfo = validateGeoFallbackMapV1(fbDoc, { geoUniverse: acceptInfo.geoUniverse });

  return {
    urls,
    geo_accept_lists_v1: acceptDoc,
    geo_display_names_v1: namesDoc,
    geo_fallback_map_v1: fbDoc,
    validation: { acceptInfo, namesInfo, fbInfo }
  };
}
  };
}
