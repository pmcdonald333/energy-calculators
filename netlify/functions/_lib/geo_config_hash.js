import crypto from "crypto";

/**
 * Makes a SHA-256 hex hash for text.
 */
export function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Hash a dictionary where values are strings.
 * Example input:
 *   { "AK": "Alaska", "US": "United States" }
 *
 * We normalize it into sorted lines:
 *   AK=Alaska
 *   US=United States
 *
 * Then hash the joined lines.
 */
export function hashStringMap(mapObj) {
  const lines = Object.entries(mapObj).map(([k, v]) => `${k}=${v}`);
  lines.sort();
  return sha256(lines.join("\n"));
}

/**
 * Hash a dictionary where values are arrays.
 * Example input:
 *   { "AK": ["AK", "US"], "AL": ["AL", "R10", "US"] }
 *
 * Normalize to sorted lines:
 *   AK=AK>US
 *   AL=AL>R10>US
 *
 * Then hash.
 */
export function hashChainMap(chainObj) {
  const lines = Object.entries(chainObj).map(([k, arr]) => `${k}=${arr.join(">")}`);
  lines.sort();
  return sha256(lines.join("\n"));
}

/**
 * For auditing: return the first N lines of the normalized map.
 * This lets you "lock" a known first few values.
 */
export function firstNSortedLinesFromStringMap(mapObj, n) {
  const lines = Object.entries(mapObj).map(([k, v]) => `${k}=${v}`);
  lines.sort();
  return lines.slice(0, n);
}

export function firstNSortedLinesFromChainMap(chainObj, n) {
  const lines = Object.entries(chainObj).map(([k, arr]) => `${k}=${arr.join(">")}`);
  lines.sort();
  return lines.slice(0, n);
}
