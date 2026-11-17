import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const roots = ["packages/engine/test", "apps/server/test"];
const files = [];
for (const root of roots) {
  try {
    for (const name of readdirSync(root)) {
      if (name.endsWith(".test.ts") || name.endsWith(".test.js")) files.push(join(root, name));
    }
  } catch {
    // Ignore missing test directories.
  }
}

if (files.length === 0) {
  console.error("no test files found");
  process.exit(1);
}

for (const file of files) {
  console.log(`\n=== ${file} ===`);
  await import(pathToFileURL(file).href);
}
