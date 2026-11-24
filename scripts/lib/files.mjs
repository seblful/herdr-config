// File-tree helpers: list, compare, copy, back up, delete.
import { copyFile as fsCopy, mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SKIP_NAMES, isText } from "./rules.mjs";

/** Every file under root/rel as posix paths relative to root, skipping SKIP_NAMES. [] if missing. */
export async function listFiles(root, rel = "") {
  const here = join(root, rel);
  const info = await stat(here).catch(() => null);
  if (!info) return [];
  if (info.isFile()) return [rel];
  const out = [];
  for (const entry of await readdir(here, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(root, child)));
    else if (entry.isFile()) out.push(child);
  }
  return out.sort();
}

/** Second-level entries of a folder (e.g. the mods in mods/), or [] if it's missing. */
export async function listEntries(root, dir) {
  const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => !SKIP_NAMES.has(e.name)).map((e) => `${dir}/${e.name}`).sort();
}

export const exists = (path) => stat(path).then(() => true, () => false);
export const mtime = (path) => stat(path).then((s) => s.mtimeMs, () => 0);

async function contents(path, rel) {
  const data = await readFile(path);
  return isText(rel) ? Buffer.from(data.toString("utf8").replace(/\r\n/g, "\n"), "utf8") : data;
}

/** Same content, ignoring CRLF vs LF in text files. */
export async function sameFile(a, b, rel) {
  if (!(await exists(a)) || !(await exists(b))) return false;
  const [x, y] = await Promise.all([contents(a, rel), contents(b, rel)]);
  return x.equals(y);
}

/** Copy a file, creating folders; text files are written with LF endings. */
export async function copyFile(from, to, rel) {
  await mkdir(dirname(to), { recursive: true });
  if (isText(rel)) await writeFile(to, await contents(from, rel));
  else await fsCopy(from, to);
}

/** Keep a copy of a file about to be replaced or deleted. */
export async function backup(path, backupRoot, rel) {
  if (await exists(path)) await copyFile(path, join(backupRoot, rel), rel);
}

/** Delete a file and any folders it leaves empty, up to (not including) root. */
export async function removeFile(root, rel) {
  await rm(join(root, rel), { force: true });
  const parts = rel.split("/").slice(0, -1);
  while (parts.length) {
    const ok = await rmdir(join(root, ...parts)).then(() => true, () => false);
    if (!ok) break;
    parts.pop();
  }
}
