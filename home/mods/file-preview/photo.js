// Image files in the preview (Windows fit, not upstream). Herdr's image() reads only files under
// ~/.config/herdr-app and ignores EXIF orientation, so .pele/image.mjs writes an upright PNG copy
// (at most MAX px) to .cache/, keyed by path + mtime + size: one conversion per version of a file.
import { exec, appHome } from "herdr";
import * as fs from "fs/promises";
import { fnv1a } from "./mermaid.js";
import { stamp } from "./source.js";
import { sh } from "./sh.js";

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
const REL = "mods/file-preview/.cache/", PELE = "mods/file-preview/.pele/";
const MAX = 1600, KEEP = 60, TIMEOUT = 60000;
const NODES = ["C:/Program Files/nodejs/node.exe", "node"];
// Keeps the KEEP newest image copies (img-*.png and their .json sizes).
const PRUNE = 'cd "$1" 2>/dev/null || exit 0; ls -t -- img-*.png 2>/dev/null | tail -n +$(($2 + 1)) | while IFS= read -r f; do rm -f -- "$f" "${f%.png}.json"; done';

export const isImage = (path) => IMAGE.test(path ?? "");

let node = null, pruned = false;

async function findNode() {
  if (node) return node;
  for (const n of NODES) {
    const v = await exec(n, ["--version"]).catch(() => null);
    if (v?.code === 0) return (node = n);
  }
  return null;
}

async function meta(path) {
  try { const m = JSON.parse(await fs.readFile(path, "utf8")); return m.w > 0 && m.h > 0 ? m : null; }
  catch { return null; }
}

/**
 * -> { kind: "image", text: key, path, w, h, ow, oh, bytes } (path for image(); w × h the PNG,
 *    ow × oh the upright original) | { kind: "missing" | "binary" | "error", message }
 */
export async function readImage(abs, on) {
  if (on) return { kind: "binary", message: "Images on other machines aren't shown" };
  const st = await stamp(abs, on);
  if (st === "missing") return { kind: "missing", message: "This file no longer exists" };
  const key = "img-" + fnv1a(abs + "|" + st), root = appHome() + "/";
  const dir = root + REL, png = dir + key + ".png";
  const bytes = Number(st.split(" ")[1]) || 0;
  let m = await meta(dir + key + ".json");
  if (!m || !(await fs.exists(png).catch(() => false))) {
    const cmd = await findNode();
    if (!cmd) return { kind: "error", message: "Showing images needs Node.js" };
    if (!(await fs.exists(root + PELE + "node_modules/@resvg/resvg-js/package.json").catch(() => false)))
      return { kind: "error", message: "Showing images needs npm install in mods/file-preview/.pele" };
    await fs.mkdir(dir, { recursive: true });
    const r = await exec(cmd, [root + PELE + "image.mjs", "-i", abs, "-o", png, "--max", String(MAX)], { timeout: TIMEOUT })
      .catch((e) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) }));
    if (r.code !== 0) return { kind: "error", message: (r.stderr || r.stdout || "Cannot show this image").trim().slice(0, 300) };
    const [w, h, ow, oh] = r.stdout.trim().split(/\s+/).map(Number);
    if (!(w > 0 && h > 0)) return { kind: "error", message: "Cannot show this image" };
    m = { w, h, ow, oh };
    await fs.writeFile(dir + key + ".json", JSON.stringify(m)).catch(() => {});
    if (!pruned) { pruned = true; exec(sh(), ["-c", PRUNE, "fp", dir, String(KEEP)]).catch(() => {}); }
  }
  return { kind: "image", text: key, path: REL + key + ".png", w: m.w, h: m.h, ow: m.ow ?? m.w, oh: m.oh ?? m.h, bytes };
}
