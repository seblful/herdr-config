import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, nextCommand } from "herdr";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
const wideGlyph = /[\p{Ideographic}\p{Emoji_Presentation}\p{Extended_Pictographic}\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6]/gu;

// Keep room for spacing marks and give wide glyphs at least two columns.
function displayColumns(text) {
  let columns = text.length;
  for (const glyph of text.match(wideGlyph) ?? []) {
    if (glyph.length === 1) columns++;
  }
  return columns;
}

// The diff was laid out for 11px text: 20px rows, 7px characters.
const rowHeight = size => Math.ceil(size * 1.8), charWidth = size => size * 0.64;

// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// fp (not upstream): Commits tab. Merge commits diff against their first parent.
const LOG_PAGE = 100, MERGES = ["--diff-merges=first-parent"];
const ago = (at) => {
  const s = Math.max(0, Date.now() / 1000 - at);
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : s < 2592000 ? `${Math.floor(s / 86400)}d` : new Date(at * 1000).toISOString().slice(0, 10);
};
const dateOf = (at) => new Date(at * 1000).toLocaleString();

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: line };
  });
}

// fp: rows, widest line and gutter width of a diff, for one diff view.
function rowsOf(lines) {
  const rows = diffRows(lines);
  return { rows, longest: Math.max(0, ...rows.map((r) => displayColumns(r.text))), gutterChars: Math.max(4, String(Math.max(0, ...rows.map((r) => r.number ?? 0))).length) };
}

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.rows = []; this.longest = 0; this.gutterChars = 4; this.message = ""; this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.mode = "changes"; this.cv = rowsOf([]);   // fp
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
    // fp: "changes-fp.<cmd>" (keys.json or herdr-app do): changes, commits, commit:<n>, file:<n>, back, more.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "changes" || c === "commits") this.setMode(c, cx);
        else if (c?.startsWith("commit:") && this.commits?.[Number(c.slice(7))]) this.openCommit(this.commits[Number(c.slice(7))], cx);
        else if (c?.startsWith("file:") && this.cfiles?.[Number(c.slice(5))]) await this.pickCommitFile(this.cfiles[Number(c.slice(5))].path, cx);
        else if (c === "back") this.closeCommit();
        else if (c === "more") this.loadLog(this.context, cx, true);
        cx.notify();
      }
    });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  // One visit to a folder: results from an earlier visit to the same folder are stale too.
  current(context) {
    return this.context === context && key() === context.key;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      this.context = { key: next }; this.root = null; this.files = []; this.open = null;
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false;
      this.loading = false;
      this.commits = null; this.closeCommit(); this.unpushed = null; this.headSha = null; this.logMore = false; this.logError = null;   // fp
    }
    // A load left behind in another folder (a slow git, a read that never ends) must not hold this one.
    if (!cwd || this.loading || this.busy) return;
    const context = this.context;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (!this.current(context)) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.setLines([]); this.open = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, ...stat });
        }
        if (!this.current(context)) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.watch(root, cx);
        // fp: the Commits tab follows new commits.
        if (this.mode === "commits" && (head.code === 0 ? head.stdout.trim() : null) !== this.headSha) this.loadLog(context, cx, false);
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (this.current(context)) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (this.current(context) && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.longest = Math.max(0, ...this.rows.map(row => displayColumns(row.text)));
    this.gutterChars = Math.max(4, String(Math.max(0, ...this.rows.map(row => row.number ?? 0))).length);
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (this.current(context) && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context?.key !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (this.current(context)) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (this.current(context)) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  gutter(size, chars = this.gutterChars) { return Math.ceil(chars * charWidth(size)) + 2; }

  diffRow({ kind, number, text }, t, size, chars) {
    const height = rowHeight(size);
    if (kind === "@") return div().w_full().px(12).h(height).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(height).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(this.gutter(size, chars)).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  // ——— fp: Commits tab (not upstream). Read-only: log, show; nothing under .git is written.

  setMode(mode, cx) {
    if (this.mode === mode) return;
    this.mode = mode; this.note = null;
    if (mode === "commits" && !this.commits) this.loadLog(this.context, cx, false);
    cx.notify();
  }

  loadLog(context, cx, more) {
    if (!this.root || this.logLoading) return;
    const root = this.root, on = this.on, skip = more ? (this.commits?.length ?? 0) : 0;
    const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
    this.logLoading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await git(["log", "-z", `--skip=${skip}`, "-n", String(LOG_PAGE + 1), "--format=%H%x1f%h%x1f%an%x1f%at%x1f%D%x1f%s"]);
        if (!this.current(context)) return;
        if (r.code !== 0) { this.commits = []; this.logMore = false; this.logError = /does not have any commits/.test(r.stderr) ? "No commits yet" : (r.stderr || "Cannot read the history").trim(); return; }
        const list = r.stdout.split("\0").filter((x) => x.trim()).map((rec) => {
          const [sha, short, author, at, refs, subject] = rec.replace(/^\n+/, "").split("\x1f");
          return { sha, short, author, at: Number(at), refs, subject };
        });
        let up = this.unpushed, head = this.headSha;
        if (!more) {
          const u = await git(["rev-list", "@{u}..HEAD"]).catch(() => null);   // no upstream: nothing marked
          up = new Set(u?.code === 0 ? u.stdout.split("\n").filter(Boolean) : []);
          head = list[0]?.sha ?? null;
        }
        if (!this.current(context)) return;
        this.unpushed = up; this.headSha = head; this.logError = null; this.logMore = list.length > LOG_PAGE;
        this.commits = [...(more ? this.commits ?? [] : []), ...list.slice(0, LOG_PAGE)];
        if (this.sel && !this.commits.some((c) => c.sha === this.sel.sha)) this.closeCommit();
      } catch (e) { if (this.current(context)) this.logError = String(e); }
      finally { this.logLoading = false; cx.notify(); }
    });
  }

  openCommit(c, cx) {
    this.sel = c; this.cfiles = null; this.copen = null; this.cv = rowsOf([]); this.note = null;
    const context = this.context, root = this.root, on = this.on;
    const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
    cx.spawn(async (cx) => {
      try {
        const [ns, st] = await Promise.all([
          git(["show", "--format=", "--name-status", "-z", "--no-renames", ...MERGES, c.sha]),
          git(["show", "--format=", "--numstat", "-z", "--no-renames", ...MERGES, c.sha]),
        ]);
        if (!this.current(context) || this.sel !== c) return;
        if (ns.code !== 0) throw new Error(ns.stderr);
        const stats = {};
        for (const entry of st.stdout.split("\0")) {
          const [a, d, ...p] = entry.replace(/^\n+/, "").split("\t");
          if (p.length) stats[p.join("\t")] = { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" };
        }
        const f = ns.stdout.split("\0"), files = [];
        for (let i = 0; i + 1 < f.length; i += 2) {
          const k = f[i].replace(/^\n+/, "")[0];
          if (!k) continue;
          files.push({ path: f[i + 1], status: k === "D" ? "D" : k === "A" ? "A" : "M", ...(stats[f[i + 1]] ?? { add: 0, del: 0 }) });
        }
        this.cfiles = files.slice(0, 1000);
        if (files.length) await this.pickCommitFile(files[0].path, cx, context);
      } catch (e) { if (this.current(context)) { this.cfiles = []; this.note = `Cannot read this commit: ${e}`; } }
      finally { cx.notify(); }
    });
    cx.notify();
  }

  async pickCommitFile(path, cx, context = this.context) {
    const c = this.sel;
    if (!c) return;
    this.copen = path; this.cv = rowsOf([]); cx.notify();
    const r = await exec("git", [...READ, "show", "--format=", "--no-ext-diff", "--no-textconv", "--no-color", ...MERGES, c.sha, "--", path], { cwd: this.root, on: this.on })
      .catch((e) => ({ code: -1, stdout: "", stderr: String(e) }));
    if (!this.current(context) || this.sel !== c || this.copen !== path) return;
    let lines;
    if (r.code !== 0) lines = [`Cannot show this diff: ${(r.stderr || "").trim()}`];
    else {
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [/^Binary files/m.test(r.stdout) ? "Binary file changed" : "No text diff"] : all.slice(first);
    }
    this.cv = rowsOf(lines.slice(0, 1500).map((l) => (l.length > 4000 ? l.slice(0, 4000) + "… (line truncated)" : l)));
  }

  closeCommit() { this.sel = null; this.cfiles = null; this.copen = null; this.cv = rowsOf([]); }

  tab(mode, label, t) {
    const on = this.mode === mode;
    return div().id(`changes-tab-${mode}`).px(8).py(3).rounded(6).cursor_pointer().text_color(on ? t.foreground : t.muted)
      .when(on, (e) => e.bg(t.selected).font_semibold()).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.setMode(mode, cx)).child(label);
  }

  fileRow(f, selected, onPick, t, id) {
    const parts = f.path.split("/"), name = parts.pop();
    return h_flex().id(id).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(selected, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => onPick(cx))
      .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
      .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
      .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
  }

  commitRows(t) {
    const mono = settings().font_family ?? "JetBrains Mono";
    if (this.sel) {
      const c = this.sel;
      return [
        h_flex().id("commit-back").h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.closeCommit(); cx.notify(); })
          .child(div().w(14).flex_none().text_color(t.muted).child("←")).child(div().flex_1().min_w(0).truncate().font_semibold().child(c.subject || c.short)),
        h_flex().h(24).flex_none().px(8).gap(8).items_center().text_size(11).text_color(t.dim)
          .child(div().w(14).flex_none()).child(div().flex_none().font_family(mono).child(c.short)).child(div().flex_1().min_w(0).truncate().child(`${c.author} · ${dateOf(c.at)}`)),
        ...(this.cfiles ?? []).map((f) => this.fileRow(f, this.copen === f.path, (cx) => cx.spawn(async (cx) => { await this.pickCommitFile(f.path, cx); cx.notify(); }), t, `cfile-${f.path}`)),
      ];
    }
    const rows = (this.commits ?? []).map((c) => {
      const up = this.unpushed?.has(c.sha);
      const ref = (c.refs ?? "").split(", ").filter(Boolean).map((r) => r.replace(/^HEAD -> /, "").replace(/^tag: /, "◆ "))[0];
      return h_flex().id(`commit-${c.sha}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.openCommit(c, cx))
        .child(div().w(58).flex_none().font_family(mono).text_size(11).text_color(up ? t.ansi3 : t.dim).child((up ? "↑" : " ") + c.short.slice(0, 7)))
        .child(div().flex_1().min_w(0).truncate().child(c.subject))
        .when(Boolean(ref), (e) => e.child(div().max_w(110).flex_none().truncate().px(5).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.accent).child(ref)))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(c.at)));
    });
    if (this.logMore) rows.push(h_flex().id("commits-more").h(28).flex_none().px(8).items_center().justify_center().rounded(7).cursor_pointer().text_size(12).text_color(t.accent)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.loadLog(this.context, cx, true)).child(this.logLoading ? "Loading…" : "Load more"));
    return rows;
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme(), size = settings().font_size, add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const commits = this.mode === "commits";
    const v = commits ? this.cv : { rows: this.rows, longest: this.longest, gutterChars: this.gutterChars };
    const listId = commits ? "changes-clist" : "changes-list", diffId = commits ? "changes-cdiff" : "changes-diff";
    const listRows = commits ? this.commitRows(t) : this.files.map((f) => this.fileRow(f, this.open === f.path, (cx) => this.pick(f.path, cx), t, `change-${f.path}`));
    const count = commits ? (this.sel ? (this.cfiles?.length ?? 0) + 2 : (this.commits?.length ?? 0) + (this.logMore ? 1 : 0)) : this.files.length;
    const empty = commits
      ? (this.sel ? (this.cfiles ? (this.cfiles.length ? null : "No file changes") : "Loading commit…") : (this.commits?.length ? null : this.logError || (this.root ? "Loading commits…" : this.error || "No folder")))
      : (this.files.length ? null : this.error || (this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "No folder"));
    const hint = commits ? (!this.sel && this.commits?.length ? "Select a commit to see its changes" : null) : (!this.open && this.files.length > 0 ? "Select a file to view its changes" : null);
    const sAdd = (this.cfiles ?? []).reduce((n, f) => n + f.add, 0), sDel = (this.cfiles ?? []).reduce((n, f) => n + f.del, 0);
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border)
        .child(this.tab("changes", "Changes", t)).child(this.tab("commits", "Commits", t))
        .when(!commits, (e) => e.child(div().ml(4).px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`)))
        .when(commits && this.unpushed?.size > 0, (e) => e.child(div().ml(4).px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.ansi3).child(`↑${this.unpushed.size} not pushed`)))
        .child(div().flex_1())
        .when(!commits || Boolean(this.sel), (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${commits ? sAdd : add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${commits ? sDel : del}`))))
      // overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout.
      .child(div().flex_1().min_h(44).max_h(count * 28 + 12).relative().border_b(1).border_color(t.border)
        .child(v_flex().id(listId).absolute().inset_0().overflow_y_scroll().p(6).children(listRows).when(Boolean(empty), (e) => e.child(div().p(8).text_color(t.dim).child(empty))))
        .child(Scrollbar.vertical(listId).absolute().inset_0()))
      .when(!commits && this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(size)
        .child(div().id(`${diffId}-x`).size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(Math.max(300, v.longest * charWidth(size) + this.gutter(size, v.gutterChars) + 20)).h_full().child(v_virtual_list(diffId, v.rows.length, rowHeight(size), (i) => String(i),
            (range) => v.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t, size, v.gutterChars))).size_full())))
        .child(Scrollbar.vertical(diffId).viewport_from_layout().absolute().inset_0())
        .when(Boolean(hint), (e) => e.child(div().absolute().top(6).px(12).text_size(11).text_color(t.dim).child(hint))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .when(!commits, (e) => e.child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit"))));
  }
}
