import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = "apps/web/public";
const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".js")) files.push(full);
  }
}
walk(root);
const exportsByFile = new Map();
for (const file of files) {
  const source = readFileSync(file, "utf8");
  const names = new Set();
  for (const match of source.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g)) names.add(match[1]);
  for (const match of source.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g)) names.add(match[1]);
  for (const match of source.matchAll(/export\s+class\s+([A-Za-z0-9_$]+)/g)) names.add(match[1]);
  for (const match of source.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const item of match[1].split(",")) {
      const name = item.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.add(name);
    }
  }
  exportsByFile.set(resolve(file), names);
}
let issues = 0;
for (const file of files) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/import\s+(?:([A-Za-z0-9_$]+)|\*\s+as\s+([A-Za-z0-9_$]+)|\{([^}]+)\})\s+from\s+["']([^"']+)["']/g)) {
    const spec = match[4];
    if (!spec.startsWith(".")) continue;
    const target = resolve(dirname(file), spec);
    if (!exportsByFile.has(target)) {
      console.log("MISSING FILE", file, "->", spec);
      issues += 1;
      continue;
    }
    if (match[3]) {
      const available = exportsByFile.get(target);
      for (const item of match[3].split(",")) {
        const name = item.trim().split(/\s+as\s+/)[0].trim();
        if (name && !available.has(name)) {
          console.log("MISSING EXPORT", file, spec, name);
          issues += 1;
        }
      }
    }
  }
}
console.log(`checked ${files.length} files, issues=${issues}`);
process.exit(issues ? 1 : 0);
