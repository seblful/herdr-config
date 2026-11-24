// Mermaid -> PNG without a browser: Pele draws the SVG, resvg rasterizes it.
// Windows fit for file-preview (not upstream). Usage:
//   node render.mjs -i in.mmd -o out.png [-s 2] [--colors '{"bg":"#fff",...}']
// Pele colors with CSS variables (var(--pele-bg,#fff)); resvg has no var(), so they are
// resolved here: --colors values first, then Pele's own fallbacks.
import { readFileSync, writeFileSync } from "node:fs";
import { render } from "pele";
import { Resvg } from "@resvg/resvg-js";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const input = opt("-i"), output = opt("-o"), scale = Number(opt("-s", "2")) || 2;
const colors = JSON.parse(opt("--colors", "{}"));
if (!input || !output) { console.error("usage: render.mjs -i in.mmd -o out.png [-s 2] [--colors json]"); process.exit(2); }

let svg;
try { svg = render(readFileSync(input, "utf8")).svg; }
catch (e) { console.error(String(e?.message ?? e)); process.exit(1); }

// Custom properties declared in style attributes: --_bg:var(--pele-bg,#fff)
const defs = new Map();
for (const m of svg.matchAll(/(--[\w-]+)\s*:\s*((?:var\([^()]*(?:\([^()]*\))?[^()]*\)|[^;"])+)/g)) defs.set(m[1], m[2].trim());
for (const [k, v] of Object.entries(colors)) defs.set("--pele-" + k, v);
const VAR = /var\((--[\w-]+)\s*(?:,\s*([^()]*?))?\)/g;
for (let i = 0; i < 8 && VAR.test(svg); i++) {
  VAR.lastIndex = 0;
  svg = svg.replace(VAR, (_, name, fb) => defs.has(name) ? defs.get(name) : (fb ?? "currentColor"));
  for (const [k, v] of defs) if (v.includes("var(")) defs.set(k, v.replace(VAR, (_, n, fb) => defs.get(n) ?? fb ?? "currentColor"));
}
// rx as a CSS property (style="rx:4px") isn't SVG 1.1: make it an attribute.
svg = svg.replace(/style="rx:([\d.]+)(?:px)?"/g, 'rx="$1"');

const png = new Resvg(svg, {
  fitTo: { mode: "zoom", value: scale },
  font: { loadSystemFonts: true, defaultFontFamily: "Segoe UI", sansSerifFamily: "Segoe UI", monospaceFamily: "Consolas" },
}).render().asPng();
writeFileSync(output, png);
