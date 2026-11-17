import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "datasets";
const strokes = JSON.parse(readFileSync(join(dir, "strokes.json"), "utf8"));
const idioms = JSON.parse(readFileSync(join(dir, "idioms.json"), "utf8"));
const common = JSON.parse(readFileSync(join(dir, "common-idioms.json"), "utf8"));

const chars = Object.keys(strokes);
const hasStrokes = (word) => [...word].every((ch) => strokes[ch]);
const validIdioms = idioms.filter((item) => hasStrokes(item.idiom));
const validCommon = common.filter((word) => hasStrokes(word));
const missing = idioms.filter((item) => !hasStrokes(item.idiom));

console.log("strokes chars:", chars.length);
console.log("idioms:", idioms.length, "valid for guessing:", validIdioms.length, "missing strokes:", missing.length);
console.log("common idioms:", common.length, "valid answers:", validCommon.length);
console.log("sample answers:", validCommon.slice(0, 8).join("、"));
if (validCommon.length < 5000) throw new Error("answer pool too small");
if (validIdioms.length < 20000) throw new Error("guess pool too small");
console.log("datasets OK");
