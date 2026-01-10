import fs from "node:fs";
import path from "node:path";
import { hashStringMap, firstNSortedLinesFromStringMap } from "./geo_config_hash.js";

const filePath = path.resolve(process.cwd(), "public/geo_display_names_v1.json");
const doc = JSON.parse(fs.readFileSync(filePath, "utf8"));

const lines = firstNSortedLinesFromStringMap(doc.geo_display_names, 10);
const hash = hashStringMap(doc.geo_display_names);

console.log("expected_sorted_first_items.geo_display_names =", JSON.stringify(lines, null, 2));
console.log("expected_set_hashes.geo_display_names =", hash);
console.log("count =", Object.keys(doc.geo_display_names).length);
