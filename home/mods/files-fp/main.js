// A lazy file browser for the focused pane's folder, with bounded previews; fp: local text files are editable.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, writeTextFile, watchFolder, theme, settings, window, openOverlay, nextCommand, appHome } from "herdr";
// fp additions (copied from mods/file-preview; they share its .pele renderer and .cache)
import { segment } from "./markdown.js";
import { isMarkdown } from "./lang.js";
import { Mermaid, cacheKey, themeOf } from "./mermaid.js";
import { isImage, readImage } from "./photo.js";
import { writeRemote } from "./remote.js";
import * as fs from "fs/promises";
import { sh } from "./sh.js";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;
const EDIT_MAX = 400000;   // fp: longer files are shown cut short, so they stay read-only
const lf = (s) => s?.replace(/\r\n/g, "\n");   // fp: the editor may not keep CRLF; compare without it
// fp: a draft's key; the same path on two machines is two files.
const draftKey = (abs, on) => (on ? `${on}:${abs}` : abs);
// fp: a folder takes its most urgent change: conflict > deleted > modified > added.
const RANK = { A: 1, M: 2, D: 3, U: 4 };
const markColor = (mark, t) => (mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked);

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.drafts = new Map(); this.edit = null;   // fp: unsaved text by draftKey; the open file's edit state
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {}; this.dirMarks = {};
    this.mermaid = new Mermaid(); this.mermaid.prune();   // fp
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
    // fp: "files-fp.open:<path from the root>" (keys.json or herdr-app do), for keys and tests.
    cx.spawn(async cx => { for (;;) { const c = await nextCommand(); if (c?.startsWith("open:")) { this.show(c.slice(5), cx); cx.notify(); } else if (c?.startsWith("reveal:")) this.reveal(c.slice(7), c.endsWith("/")); else if (c === "save") this.save(cx); } });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.dirMarks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        // fp: marks are keyed by the path under the shown folder. Git writes C:/x where the pane says C:\x,
        // so absolute paths never matched on Windows.
        const top = await exec("git", ["rev-parse", "--show-prefix"], { cwd, on }).catch(() => null);
        const marks = {}, dirMarks = {}, prefix = top?.code === 0 ? top.stdout.trim() : "";
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            const path = entry.slice(3).replace(/\/$/, "");
            if (!path.startsWith(prefix)) continue;   // outside the shown folder
            const rel = path.slice(prefix.length), mark = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
            marks[rel] = mark;
            for (let i = rel.lastIndexOf("/"); i > 0; i = rel.lastIndexOf("/", i - 1)) {
              const dir = rel.slice(0, i);
              if ((RANK[dirMarks[dir]] ?? 0) < RANK[mark]) dirMarks[dir] = mark;
            }
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.dirMarks = dirMarks; this.error = null; this.watch(cwd, cx);
        await this.recheck(cx);   // fp
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.stash();   // fp: unsaved edits wait in drafts
    this.code?.release(); this.code = null; this.file = path; this.fileError = null; this.doc = null; this.edit = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        if (isImage(path)) {   // fp: an upright PNG copy (photo.js)
          const doc = await readImage(`${root}/${path}`, on);
          if (this.file !== path || !this.current(context)) return;
          if (doc.kind === "image") this.doc = doc; else this.fileError = doc.message;
          return;
        }
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        // fp: files that fit are editable, here or on another machine; a draft left unsaved comes back (its base is what it was edited from).
        const abs = `${root}/${path}`, id = draftKey(abs, on), draft = this.drafts.get(id), md = isMarkdown(path);
        const ed = this.edit = { abs, on, id, base: draft?.base ?? text, eol: text.includes("\r\n") ? "\r\n" : "\n", editable: text.length <= EDIT_MAX,
          readonly: text.length > EDIT_MAX ? "Too long to edit here" : null,
          dirty: Boolean(draft), md, mode: md && !draft ? "preview" : "edit", source: draft?.text ?? text, note: null, conflict: false, saving: false };
        if (draft && !ed.editable) { this.drafts.delete(id); ed.dirty = false; ed.source = text; ed.base = text; }
        if (md) { this.doc = this.markdown(ed.source, cx); if (ed.mode === "edit") this.code = this.editor(ed, ed.source); return; }
        this.code = this.editor(ed, text.length > EDIT_MAX ? text.slice(0, EDIT_MAX) + "\n… (file truncated)" : ed.source);
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = (entry.dir ? this.dirMarks : this.marks)[path];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .when(!entry.dir && this.drafts.has(draftKey(`${this.root}/${path}`, this.on)), el => el.tooltip("Unsaved changes"))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.reveal(path, entry.dir); })   // fp: in the system file manager
        .child(entry.dir ? svg(`mods/files-fp/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/files-fp/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().when(Boolean(mark), el => el.text_color(markColor(mark, t))).child(entry.name))   // fp: changed in git
        .when(!entry.dir && this.drafts.has(draftKey(`${this.root}/${path}`, this.on)), el => el.child(div().text_size(11).text_color(t.blocked).child("●")))   // fp: unsaved
        .when(Boolean(mark), el => el.child(div().text_size(entry.dir ? 8 : 11).text_color(markColor(mark, t)).child(entry.dir ? "●" : mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }


  // ——— fp additions (not upstream): Markdown, Mermaid (Pele), images. Renderer, cache and the
  // expanded viewer are file-preview's (mods/file-preview/.pele, .cache, mode "diagram").

  /** Prose and Mermaid blocks of a Markdown file; other fences stay in the prose. */
  markdown(text, cx) {
    const theme = themeOf(settings().dark), blocks = [], doc = { kind: "markdown", blocks };
    let md = [], size = 0;
    const flush = () => { if (md.length) blocks.push({ kind: "md", text: md.join("\n\n") }); md = []; size = 0; };
    const prose = (s) => { if (size + s.length > 30000) flush(); md.push(s); size += s.length; };
    for (const s of segment(text)) {
      if (s.kind === "md") { prose(s.text); continue; }
      if (s.info.toLowerCase() !== "mermaid") {
        const run = Math.max(2, ...(s.text.match(/`+/g) ?? [""]).map((m) => m.length)) + 1, f = "`".repeat(run);
        prose(f + s.info + "\n" + s.text + "\n" + f);
        continue;
      }
      flush();
      blocks.push({ kind: "mmd", text: s.text, theme, key: cacheKey(s.text, theme), d: null, id: `files-mmd-${blocks.length}` });
    }
    flush();
    this.doc = doc;   // before request(): its queue drops jobs nobody alive() wants
    for (const b of blocks) if (b.kind === "mmd")
      this.mermaid.request({ key: b.key, source: b.text, theme: b.theme }, { alive: () => this.doc === doc, done: (res, cx) => { b.d = res; cx.notify(); } }, cx);
    return doc;
  }

  /** file-preview's expanded viewer as a dialog (zoom, fit; diagrams get sharper renders). */
  expand(d, label) {
    openOverlay({ kind: "dialog", width: 0.95, height: 0.95, mod: "file-preview", props: { mode: "diagram", diagram: d, label } });
  }

  /** A link in a Markdown file: web links in the browser, relative paths open here. */
  link(url, cx) {
    if (/^(https?|mailto):/i.test(url)) {
      const p = window()?.platform;
      if (!this.on) exec(p === "windows" ? "explorer.exe" : p === "linux" ? "xdg-open" : "open", [url]).catch(() => {});
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^file:/i.test(url)) return;
    let p = url.replace(/^file:\/\//i, "").split("#")[0];
    try { p = decodeURI(p); } catch {}
    if (!p) return;
    const base = this.file?.includes("/") ? this.file.slice(0, this.file.lastIndexOf("/")) : "", parts = [];
    for (const seg of (p.startsWith("/") ? p.slice(1) : (base ? base + "/" : "") + p).split("/")) {
      if (seg === "..") parts.pop(); else if (seg && seg !== ".") parts.push(seg);
    }
    if (parts.length) { this.show(parts.join("/"), cx); cx.notify(); }
  }

  diagram(b, t) {
    const d = b.d;
    if (d?.ok) {
      const w = Math.max(1, Math.min(this.colW ?? 320, d.w / 2)), h = (w * d.h) / d.w;
      return h_flex().id(b.id).w_full().h(h).flex_none().justify_center().cursor_pointer()
        .on_click(() => this.expand({ key: b.key, source: b.text, theme: b.theme, path: d.path, w: d.w, h: d.h }, `${this.file} · diagram`))
        .child(image(d.path).w(w).h(h));
    }
    if (d?.error) return v_flex().w_full().flex_none().gap(6)
      .child(div().text_size(11.5).text_color(d.setup ? t.ansi3 : t.ansi1).child(d.error))
      .child(TextView.markdown(`${b.id}-src`, "```mermaid\n" + b.text + "\n```"));
    return h_flex().id(b.id).w_full().h(56).flex_none().justify_center().items_center().rounded(6).border_1().border_color(t.border)
      .text_size(12).text_color(t.dim).child("Rendering diagram…");
  }

  preview(t, font) {
    const doc = this.doc;
    if (doc?.kind === "image") {
      const w = Math.max(1, Math.min(this.colW ?? 320, doc.w)), h = (w * doc.h) / doc.w;
      const mb = doc.bytes ? ` · ${(doc.bytes / 1e6).toFixed(1)} MB` : "";
      return v_flex().id(`files-img:${this.file}`).flex_1().min_h(0).overflow_y_scrollbar().p(12)
        .child(v_flex().w_full().items_center().gap(8).on_size_change((s, cx) => this.sized(s, cx))
          .child(div().id("files-image").w(w).h(h).flex_none().cursor_pointer()
            .on_click(() => this.expand({ key: doc.text, path: doc.path, w: doc.w, h: doc.h, photo: true }, this.file)).child(image(doc.path).w(w).h(h)))
          .child(div().text_size(11.5).text_color(t.dim).child(`${doc.ow} × ${doc.oh} px${mb} · click to expand`)));
    }
    if (doc?.kind === "markdown" && this.edit?.mode !== "edit") {
      return v_flex().id(`files-md:${this.file}`).flex_1().min_h(0).overflow_y_scrollbar().px(16).py(14)
        .child(v_flex().w_full().gap(12).text_size(14).on_size_change((s, cx) => this.sized(s, cx))
          .children(doc.blocks.map((b, i) => b.kind === "md"
            ? TextView.markdown(`files-md-${i}`, b.text).selectable(true).on_link_click((url, cx) => this.link(url, cx))
            : this.diagram(b, t))));
    }
    return this.code
      ? Editor.new(this.code).font_family(font.font_family).text_size(font.font_size).flex_1().min_h(0)
      : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…");
  }

  /** fp: path (from the root; "" = the root) in the system file manager: a file selected, a folder opened. Local only. */
  reveal(path, dir) {
    if (this.on || !this.root) return;
    const p = window()?.platform, abs = path ? `${this.root}/${path}` : this.root;
    if (p === "windows") { const w = abs.replace(/\//g, "\\"); exec("explorer.exe", dir ? [w] : [`/select,${w}`]).catch(() => {}); }   // explorer exits 1 even when it worked
    else if (p === "macos") exec("open", dir ? [abs] : ["-R", abs]).catch(() => {});
    else exec("xdg-open", [dir ? abs : abs.replace(/\/[^/]*$/, "")]).catch(() => {});
  }

  // ——— fp: editing. Text files edit in place, here or on another machine; ctrl-s or Save writes them only
  // if the file on disk is still what they were opened from, else the person picks Overwrite or Reload.

  /** A code editor for the open file; typing marks it unsaved. */
  editor(ed, value) {
    const t = theme(), ext = this.file.includes(".") ? this.file.split(".").pop() : "txt";
    const state = EditorState.new({ language: LANG[ext] ?? ext, readonly: !ed.editable, value,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
    if (ed.editable) state.on("change", (_e, cx) => {
      const dirty = lf(state.value()) !== lf(ed.base);
      if (dirty === ed.dirty && !ed.note) return;
      ed.dirty = dirty; ed.note = null; cx.notify();
    });
    return state;
  }

  /** The open file's text as edited (the editor's, else what the preview shows). */
  text() {
    return this.code && this.edit?.editable ? this.code.value() : this.edit?.source;
  }

  /** Keep unsaved edits of the open file (or forget its draft once it's clean). */
  stash() {
    const ed = this.edit;
    if (!ed?.editable) return;
    if (ed.dirty) this.drafts.set(ed.id, { text: this.text(), base: ed.base });
    else this.drafts.delete(ed.id);
  }

  /** Write the edits; force: replace whatever is on disk now (after a conflict). */
  save(cx, force = false) {
    const ed = this.edit;
    if (!ed?.editable || ed.saving || (!ed.dirty && !force)) return;
    const text = this.text().replace(/\r?\n/g, ed.eol);
    ed.saving = true; ed.note = null;
    cx.notify();
    cx.spawn(async cx => {
      try {
        await this.put(ed, text, force);
        ed.base = text; ed.source = text; ed.conflict = false; ed.note = "Saved";
        ed.dirty = lf(this.edit === ed ? this.text() : text) !== lf(text);   // typing during the write stays unsaved
        if (!ed.dirty) this.drafts.delete(ed.id);
      } catch (e) {
        const now = await readTextFile(ed.abs, { on: ed.on }).catch(() => undefined);
        if (now !== ed.base) ed.conflict = true;
        else ed.note = `Couldn't save: ${String(e?.message ?? e).slice(0, 120)}`;
      } finally { ed.saving = false; cx.notify(); }
    });
  }

  /** Write the open file's text here or on its machine; force: over whatever is there now. */
  async put(ed, text, force) {
    if (!ed.on) return writeTextFile(ed.abs, text, force ? await readTextFile(ed.abs) : ed.base);
    const io = { exec, read: (p, on) => readTextFile(p, { on }), fs, shell: sh(null), cache: appHome() + "/mods/files-fp/.cache/" };
    return writeRemote(io, ed.on, ed.abs, text, force ? null : ed.base);
  }

  /** Drop the edits and show the file as it is on disk. */
  revert(cx) {
    const ed = this.edit;
    if (!ed) return;
    ed.dirty = false; this.drafts.delete(ed.id);
    this.show(this.file, cx); cx.notify();
  }

  /** Markdown: "edit" shows the source in the editor, "preview" renders what's typed so far. */
  setMode(mode, cx) {
    const ed = this.edit;
    if (!ed?.md || ed.mode === mode) return;
    if (mode === "preview" && this.code) {
      const text = this.code.value();
      if (text !== ed.source) { ed.source = text; this.doc = this.markdown(text, cx); }
    }
    ed.mode = mode;
    if (mode === "edit" && !this.code) this.code = this.editor(ed, ed.source);
    if (mode === "edit") this.code.focus();
    cx.notify();
  }

  /** After the folder changed: a clean open file follows what's on disk (an agent's edit, git checkout). */
  async recheck(cx) {
    const ed = this.edit, path = this.file;
    if (!ed?.editable || ed.dirty || ed.saving) return;
    const text = await readTextFile(ed.abs, { on: ed.on }).catch(() => undefined);
    if (text == null || text === ed.base || this.edit !== ed || ed.dirty || text.length > EDIT_MAX) return;
    ed.base = text; ed.source = text; ed.conflict = false; ed.note = null;
    if (ed.md) this.doc = this.markdown(text, cx);
    if (this.code) this.code.set_value(text);
    ed.dirty = false;
    if (this.file === path) cx.notify();
  }

  /** The header's edit controls: unsaved dot, Edit/Preview for Markdown, Revert and Save, read-only. */
  editBar(t) {
    const ed = this.edit;
    if (!ed) return [];
    const button = (id, label, onClick, strong) => div().id(id).px(8).h(24).flex().flex_none().items_center().rounded(6).text_size(12).cursor_pointer()
      .bg(strong ? t.accent : t.chrome).text_color(strong ? t.background : t.foreground).hover(s => s.opacity(0.85)).on_click(onClick).child(label);
    const out = [];
    if (!ed.editable) return [div().id("files-readonly").flex_none().text_size(11).text_color(t.dim).tooltip(ed.readonly).child("read-only")];
    if (ed.md) out.push(button("files-mode", ed.mode === "edit" ? "Preview" : "Edit", (_e, cx) => this.setMode(ed.mode === "edit" ? "preview" : "edit", cx)));
    if (ed.saving) out.push(div().flex_none().text_size(11).text_color(t.dim).child("Saving…"));
    else if (ed.dirty) out.push(button("files-revert", "Revert", (_e, cx) => this.revert(cx)), button("files-save", "Save", (_e, cx) => this.save(cx), true));
    else if (ed.note === "Saved") out.push(div().flex_none().text_size(11).text_color(t.ansi2).child("Saved"));
    return out;
  }

  /** A line under the header: a save conflict (with its choices) or a failed save. */
  editNotice(t) {
    const ed = this.edit;
    if (ed?.conflict) return h_flex().flex_none().px(14).py(6).gap(8).items_center().border_b(1).border_color(t.border).bg(t.raised).text_size(12)
      .child(div().flex_1().min_w(0).text_color(t.blocked).child("The file changed on disk since you opened it."))
      .child(div().id("files-overwrite").px(8).h(22).flex().items_center().rounded(6).cursor_pointer().bg(t.ansi1).text_color(t.background).on_click((_e, cx) => this.save(cx, true)).child("Overwrite"))
      .child(div().id("files-reload").px(8).h(22).flex().items_center().rounded(6).cursor_pointer().bg(t.chrome).hover(s => s.bg(t.hover)).on_click((_e, cx) => this.revert(cx)).child("Reload"));
    if (ed?.note && ed.note !== "Saved") return div().flex_none().px(14).py(6).border_b(1).border_color(t.border).text_size(12).text_color(t.ansi1).child(ed.note);
    return null;
  }

  sized(size, cx) {
    const w = Math.round(size.width);
    if (w !== this.colW) { this.colW = w; cx.notify(); }
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    const font = this.code ? settings() : null;
    const notice = this.file ? this.editNotice(t) : null;
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {   // fp: save from the editor (cmd is ctrl outside macOS)
        if (e.keystroke !== "cmd-s" && e.keystroke !== "ctrl-s") return;
        this.save(cx); cx.stop_propagation();
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child((this.edit?.dirty || this.edit?.md ? this.file?.split("/").pop() : this.file) ?? this.root?.split(/[\\/]/).pop() ?? ""))   // fp: room for the edit buttons
        .when(Boolean(this.edit?.dirty), el => el.child(div().flex_none().text_size(11).text_color(t.blocked).child("●")))   // fp: unsaved
        .children(this.file ? this.editBar(t) : [])
        // fp: the shown file (selected) or the folder in the system file manager
        .when(Boolean(this.root) && !this.on, el => el.child(div().id("files-reveal").p(4).rounded(5).cursor_pointer().hover(s => s.bg(t.hover))
          .on_click(() => this.reveal(this.file ?? "", !this.file)).child(svg("mods/files-fp/folder.svg").size(14).text_color(t.muted)))))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(notice), el => el.child(notice))
      .when(Boolean(this.file), el => el.child(this.preview(t, font ?? settings())));
  }
}
