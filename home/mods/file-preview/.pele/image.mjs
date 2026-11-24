// Image file -> upright PNG for file-preview (Windows fit, not upstream). Herdr's image() only
// reads files under ~/.config/herdr-app and ignores EXIF orientation, so the panel shows this copy.
//   node image.mjs -i photo.jpg -o out.png [--max 2000] [--no-exif]
// Prints "<outW> <outH> <srcW> <srcH>" (srcW/H: the upright original's size).
import { readFileSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const input = opt("-i"), output = opt("-o"), max = Number(opt("--max", "2000")) || 2000;
if (!input || !output) { console.error("usage: image.mjs -i in -o out.png [--max 2000]"); process.exit(2); }
const fail = (m) => { console.error(m); process.exit(1); };
const FONT = { loadSystemFonts: true, defaultFontFamily: "Segoe UI" };

const buf = readFileSync(input);
const ext = input.toLowerCase().split(".").pop();

if (ext === "svg") {
  const svg = buf.toString("utf8");
  const probe = new Resvg(svg, { font: FONT });
  const w = probe.width, h = probe.height, s = Math.min(4, max / Math.max(w, h));
  const png = new Resvg(svg, { font: FONT, fitTo: { mode: "zoom", value: s } }).render();
  writeFileSync(output, png.asPng());
  console.log(png.width, png.height, Math.round(w), Math.round(h));
  process.exit(0);
}

/** { mime, w, h } from the header, or null. */
function info(b) {
  if (b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") return { mime: "image/png", w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.toString("latin1", 0, 3) === "GIF") return { mime: "image/gif", w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    const k = b.toString("latin1", 12, 16);
    if (k === "VP8 ") return { mime: "image/webp", w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (k === "VP8L") { const n = b.readUInt32LE(21); return { mime: "image/webp", w: (n & 0x3fff) + 1, h: ((n >> 14) & 0x3fff) + 1 }; }
    if (k === "VP8X") return { mime: "image/webp", w: b.readUIntLE(24, 3) + 1, h: b.readUIntLE(27, 3) + 1 };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1], len = b.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { mime: "image/jpeg", w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

/** EXIF orientation 1..8 of a JPEG (1 when absent). */
function orientation(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return 1;
  for (let i = 2; i + 4 < b.length;) {
    if (b[i] !== 0xff) return 1;
    const m = b[i + 1], len = b.readUInt16BE(i + 2);
    if (m === 0xe1 && b.toString("latin1", i + 4, i + 10) === "Exif\0\0") {
      const t = i + 10, le = b.toString("latin1", t, t + 2) === "II";
      const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o)), u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
      const ifd = t + u32(t + 4), n = u16(ifd);
      for (let k = 0; k < n; k++) { const e = ifd + 2 + k * 12; if (u16(e) === 0x0112) return u16(e + 8) || 1; }
      return 1;
    }
    if (m === 0xda) return 1;
    i += 2 + len;
  }
  return 1;
}

const im = info(buf);
if (!im || !im.w || !im.h) fail("Unsupported image format");
const o = args.includes("--no-exif") ? 1 : orientation(buf);
const W = im.w, H = im.h, swap = o >= 5;
const ow = swap ? H : W, oh = swap ? W : H;
const M = { 1: [1, 0, 0, 1, 0, 0], 2: [-1, 0, 0, 1, W, 0], 3: [-1, 0, 0, -1, W, H], 4: [1, 0, 0, -1, 0, H],
  5: [0, 1, 1, 0, 0, 0], 6: [0, 1, -1, 0, H, 0], 7: [0, -1, -1, 0, H, W], 8: [0, -1, 1, 0, 0, W] }[o] ?? [1, 0, 0, 1, 0, 0];
const s = Math.min(1, max / Math.max(ow, oh));
const svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="' + ow + '" height="' + oh + '">' +
  '<g transform="matrix(' + M.join(",") + ')"><image width="' + W + '" height="' + H + '" xlink:href="data:' + im.mime + ";base64," + buf.toString("base64") + '"/></g></svg>';
let png;
try { png = new Resvg(svg, { fitTo: { mode: "zoom", value: s } }).render(); }
catch (e) { fail(String(e?.message ?? e)); }
writeFileSync(output, png.asPng());
console.log(png.width, png.height, ow, oh);
