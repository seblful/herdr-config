// Plans and applies copies between two trees, one unit (a mod folder, a layout file) at a time.
import { join } from "node:path";
import { backup, copyFile, listFiles, removeFile, sameFile } from "./files.mjs";
import { unitOf } from "./rules.mjs";

/** The units the repo tracks: "keys.json", "layouts/main-fp.json", "mods/files-fp", ... */
export async function trackedUnits(source) {
  return [...new Set((await listFiles(source)).map(unitOf))].sort();
}

/**
 * What it takes to make `to` match `from` for the given units:
 * [{ rel, action: "add" | "update" | "delete" }], plus the units `from` lacks.
 */
export async function plan(from, to, units) {
  const changes = [], missing = [];
  for (const unit of units) {
    const want = await listFiles(from, unit);
    if (!want.length) { missing.push(unit); continue; }
    const have = new Set(await listFiles(to, unit));
    for (const rel of want) {
      if (!have.has(rel)) changes.push({ rel, action: "add" });
      else if (!(await sameFile(join(from, rel), join(to, rel), rel))) changes.push({ rel, action: "update" });
      have.delete(rel);
    }
    for (const rel of have) changes.push({ rel, action: "delete" });
  }
  return { changes, missing };
}

/** Apply a plan, backing up every file it replaces or deletes under backupRoot. */
export async function apply(changes, from, to, backupRoot) {
  for (const { rel, action } of changes) {
    if (action !== "add") await backup(join(to, rel), backupRoot, rel);
    if (action === "delete") await removeFile(to, rel);
    else await copyFile(join(from, rel), join(to, rel), rel);
  }
}

const MARK = { add: "+", update: "~", delete: "-" };

/** One line per change: "+ mods/x/main.js". */
export const describe = (changes) => changes.map(({ rel, action }) => `  ${MARK[action]} ${rel}`);
