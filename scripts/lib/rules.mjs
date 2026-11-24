// What may be tracked, and how paths group into units (a mod folder, a layout, keys.json).
import { extname } from "node:path";

/** Never copied in either direction: caches, installed packages, files Herdr writes into mod folders. */
export const SKIP_NAMES = new Set([
  ".cache",
  "node_modules",
  "gpui-kit.d.ts",
  "jsconfig.json",
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
]);

/** Top-level entries of the Herdr home that Herdr writes itself: per-machine state, never tracked. */
export const HERDR_OWNED = new Set([
  "AGENTS.md",
  "data",
  "frame",
  "herdr-app.sock",
  "herdr.d.ts",
  "gpui-kit.d.ts",
  "icons",
  "installed.json",
  "seen.json",
  "shared.json",
  "telemetry",
  "update-notes-cache.md",
  "update-notes-media",
  "update-notes.json",
  "view.json",
  "window.json",
  "windows.json",
]);

const TEXT = new Set([".js", ".mjs", ".cjs", ".json", ".md", ".svg", ".css", ".txt", ".toml", ".yml", ".yaml"]);

/** Text files are compared and written with LF line endings, so CRLF on Windows isn't a change. */
export const isText = (rel) => TEXT.has(extname(rel).toLowerCase());

/**
 * The unit a path belongs to: a root file is its own unit, anything deeper belongs to its
 * second-level entry. "mods/files-fp/main.js" -> "mods/files-fp", "layouts/x.json" -> "layouts/x.json".
 */
export function unitOf(rel) {
  const parts = rel.split("/");
  return parts.length === 1 ? parts[0] : parts.slice(0, 2).join("/");
}

/** Why a unit can't be tracked, or null when it can. */
export function refuseReason(unit) {
  const top = unit.split("/")[0];
  if (HERDR_OWNED.has(top)) return `${top} is written by Herdr (per-machine state)`;
  if (unit.split("/").some((part) => SKIP_NAMES.has(part))) return "caches and installed packages aren't tracked";
  return null;
}
