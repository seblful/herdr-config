// What runs after files land: npm packages a mod needs, and herdr-app check.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { exists, listFiles } from "./files.mjs";

function run(cmd, args, cwd) {
  // npm is npm.cmd on Windows, which only starts through a shell; its args here are fixed words.
  const viaShell = cmd === "npm" && process.platform === "win32";
  const r = viaShell
    ? spawnSync([cmd, ...args].join(" "), { cwd, stdio: "pipe", encoding: "utf8", shell: true })
    : spawnSync(cmd, args, { cwd, stdio: "pipe", encoding: "utf8" });
  if (r.error?.code === "ENOENT") return { missing: true };
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** Folders inside the given units that have a package.json (e.g. mods/file-preview/.pele). */
export async function packageFolders(source, units) {
  const found = [];
  for (const unit of units) {
    for (const rel of await listFiles(source, unit)) {
      if (rel.endsWith("/package.json")) found.push(rel.slice(0, -"/package.json".length));
    }
  }
  return found;
}

/**
 * Install packages in each folder under home whose node_modules is missing or whose
 * package files just changed. Returns log lines.
 */
export async function installPackages(home, folders, changedRels, { dryRun = false } = {}) {
  const lines = [];
  for (const dir of folders) {
    const touched = changedRels.some((rel) => rel === `${dir}/package.json` || rel === `${dir}/package-lock.json`);
    const cwd = join(home, dir);
    if (!touched && (await exists(join(cwd, "node_modules")))) continue;
    const args = (await exists(join(cwd, "package-lock.json"))) ? ["ci"] : ["install"];
    args.push("--no-audit", "--no-fund");
    if (dryRun) { lines.push(`  would run npm ${args[0]} in ${dir}`); continue; }
    const r = run("npm", args, cwd);
    if (r.missing) { lines.push(`  ! npm not found: install Node.js, then run npm ${args[0]} in ${cwd}`); continue; }
    lines.push(r.ok ? `  npm ${args[0]} in ${dir}: ok` : `  ! npm ${args[0]} in ${dir} failed:\n${r.out}`);
  }
  return lines;
}

/** herdr-app check for each mod unit. Returns { lines, failed }. */
export function checkMods(home, units) {
  const lines = [];
  let failed = 0;
  for (const unit of units.filter((u) => u.startsWith("mods/"))) {
    const r = run("herdr-app", ["check", join(home, unit)]);
    if (r.missing) return { lines: ["  ! herdr-app not on PATH: checks skipped"], failed: 0 };
    if (!r.ok) failed++;
    lines.push(r.ok ? `  ok   ${unit}` : `  FAIL ${unit}\n${r.out.replace(/^/gm, "       ")}`);
  }
  return { lines, failed };
}
