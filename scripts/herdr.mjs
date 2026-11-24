#!/usr/bin/env node
// Keeps the Herdr app's mods, layouts and keys in this repo and copies them to and from the
// live Herdr home. Run with no arguments for help.
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { exists, listEntries, listFiles, mtime } from "./lib/files.mjs";
import { BACKUPS, HERDR_HOME, SOURCE } from "./lib/paths.mjs";
import { refuseReason, unitOf } from "./lib/rules.mjs";
import { checkMods, installPackages, packageFolders } from "./lib/steps.mjs";
import { apply, describe, plan, trackedUnits } from "./lib/sync.mjs";

const HELP = `Usage: node scripts/herdr.mjs <command> [options]   (or: npm run <command>)

  status               what differs between the repo and the Herdr home
  deploy [--prune]     repo -> Herdr home; installs npm packages mods need, checks mods.
                       --prune also deletes files in tracked mods that the repo lacks
  capture              Herdr home -> repo, for everything the repo tracks
  add <path>...        start tracking something from the Herdr home:
                       mods/<name>, layouts/<name>.json, themes/<name>, keys.json, settings.json
  check                herdr-app check every tracked mod

  --dry-run            show what deploy, capture or add would do, change nothing

Herdr home: ${HERDR_HOME}  (HERDR_APP_HOME picks another)`;

const stamp = (what) => join(BACKUPS, `${new Date().toISOString().replace(/[:.]/g, "-")}-${what}`);
const say = (...lines) => console.log(lines.flat(Infinity).join("\n"));

/** Herdr's own shipped mods and layouts, so status doesn't offer to track them. */
async function shipped() {
  const file = join(HERDR_HOME, "installed.json");
  if (!(await exists(file))) return new Set();
  const names = Object.keys(JSON.parse(await readFile(file, "utf8")));
  return new Set(names.map((n) => (n.startsWith("layout:") ? `layouts/${n.slice(7)}.json` : `mods/${n}`)));
}

/** A path as a unit relative to the Herdr home: accepts "mods\\x", "./mods/x/", or an absolute path. */
function toUnit(arg) {
  const rel = (isAbsolute(arg) ? relative(HERDR_HOME, arg) : arg).replace(/\\/g, "/").replace(/^\.\/|\/$/g, "");
  if (!rel || rel.startsWith("..")) throw new Error(`${arg} is not inside the Herdr home (${HERDR_HOME})`);
  const unit = unitOf(rel);
  if (unit !== rel) throw new Error(`${arg}: track the whole ${unit}, not a file inside it`);
  return unit;
}

async function status() {
  const units = await trackedUnits(SOURCE);
  const { changes } = await plan(SOURCE, HERDR_HOME, units);
  const lines = [];
  for (const { rel, action } of changes) {
    if (action === "add") lines.push(`  only in repo   ${rel}   (deploy adds it)`);
    else if (action === "delete") lines.push(`  only in home   ${rel}   (capture adds it, deploy --prune deletes it)`);
    else {
      const homeNewer = (await mtime(join(HERDR_HOME, rel))) > (await mtime(join(SOURCE, rel)));
      lines.push(`  differs        ${rel}   (${homeNewer ? "home is newer: capture" : "repo is newer: deploy"})`);
    }
  }
  const tracked = new Set(units), ship = await shipped();
  const candidates = [...(await listEntries(HERDR_HOME, "mods")), ...(await listEntries(HERDR_HOME, "layouts")), ...(await listEntries(HERDR_HOME, "themes"))];
  const untracked = candidates.filter((u) => !tracked.has(u) && !ship.has(u) && !u.split("/")[1].startsWith(".")
    && (!u.startsWith("layouts/") || u.endsWith(".json")));
  say(`Tracking ${units.length} units, Herdr home ${HERDR_HOME}`, "");
  say(lines.length ? ["Differences:", ...lines] : "Repo and Herdr home match.");
  if (untracked.length) say("", "Yours but not tracked (npm run add -- <path>):", untracked.map((u) => `  ${u}`));
}

async function deploy({ prune, dryRun }) {
  if (!(await exists(HERDR_HOME))) throw new Error(`No Herdr home at ${HERDR_HOME}: open Herdr once first`);
  const units = await trackedUnits(SOURCE);
  const { changes } = await plan(SOURCE, HERDR_HOME, units);
  const kept = prune ? [] : changes.filter((c) => c.action === "delete");
  const todo = prune ? changes : changes.filter((c) => c.action !== "delete");
  say(todo.length ? [`${dryRun ? "Would deploy" : "Deploying"} to ${HERDR_HOME}:`, describe(todo)] : "Herdr home already matches the repo.");
  if (kept.length) say("Only in the Herdr home, kept (deploy --prune deletes them):", kept.map((c) => `    ${c.rel}`));
  if (!dryRun && todo.length) {
    const backups = stamp("deploy");
    await apply(todo, SOURCE, HERDR_HOME, backups);
    if (todo.some((c) => c.action !== "add")) say(`Replaced files backed up in ${backups}`);
  }
  const pkgLines = await installPackages(HERDR_HOME, await packageFolders(SOURCE, units), todo.map((c) => c.rel), { dryRun });
  if (pkgLines.length) say("Packages:", pkgLines);
  if (dryRun) return;
  const { lines, failed } = checkMods(HERDR_HOME, units);
  say("Checks:", lines);
  const layouts = todo.filter((c) => c.action === "add" && c.rel.startsWith("layouts/")).map((c) => c.rel.slice(8, -5));
  if (layouts.length) say("", "To use a layout: herdr-app do layout.switch '{\"name\":\"" + layouts[0] + "\"}'   (ctrl-shift-l cycles them)");
  if (failed) process.exitCode = 1;
}

async function capture({ dryRun }) {
  const units = await trackedUnits(SOURCE);
  const { changes, missing } = await plan(HERDR_HOME, SOURCE, units);
  if (missing.length) say("Not in the Herdr home, left as is in the repo:", missing.map((u) => `    ${u}`));
  if (!changes.length) return say("Repo already matches the Herdr home.");
  say(`${dryRun ? "Would capture" : "Capturing"} from ${HERDR_HOME}:`, describe(changes));
  if (dryRun) return;
  await apply(changes, HERDR_HOME, SOURCE, stamp("capture"));
  say("", "Review with git diff, then commit.");
}

async function add(args, { dryRun }) {
  if (!args.length) throw new Error("add needs a path, e.g. npm run add -- mods/win98");
  const tracked = new Set(await trackedUnits(SOURCE));
  for (const arg of args) {
    let unit;
    try { unit = toUnit(arg); } catch (e) { say(`  skipped ${e.message}`); continue; }
    const reason = refuseReason(unit);
    if (reason) { say(`  skipped ${unit}: ${reason}`); continue; }
    if (tracked.has(unit)) { say(`  already tracked: ${unit} (use capture to update it)`); continue; }
    const files = await listFiles(HERDR_HOME, unit);
    if (!files.length) { say(`  skipped ${unit}: not found in ${HERDR_HOME}`); continue; }
    const { changes } = await plan(HERDR_HOME, SOURCE, [unit]);
    say(`${dryRun ? "Would add" : "Added"} ${unit} (${files.length} file${files.length === 1 ? "" : "s"})`);
    if (!dryRun) await apply(changes, HERDR_HOME, SOURCE, stamp("add"));
  }
}

async function check() {
  const { lines, failed } = checkMods(HERDR_HOME, await trackedUnits(SOURCE));
  say(lines);
  if (failed) process.exitCode = 1;
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { prune: { type: "boolean" }, "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" } },
});
const [command, ...rest] = positionals;
const opts = { prune: values.prune, dryRun: values["dry-run"] };
const commands = { status, deploy: () => deploy(opts), capture: () => capture(opts), add: () => add(rest, opts), check };

if (values.help || !commands[command]) {
  say(HELP);
  if (command && !values.help) process.exitCode = 2;
} else {
  await commands[command]().catch((e) => { console.error(`error: ${e.message}`); process.exitCode = 1; });
}
