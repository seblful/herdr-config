// The Git panel: the branch and its worktrees, uncommitted changes with their diffs, and the history.
// Started as a clone of Herdr's changes mod (0.1.17). git.js runs git, parse.js reads its output, ui.js draws.
import { View, div } from "gpui-kit";
import { v_flex, InputState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, nextCommand, run, openOverlay, home, window, checking } from "herdr";
import { EMPTY_DIFF, diffView, clip, slash, inside, samePath, Gate, within } from "./parse.js";
import * as git from "./git.js";
import * as ui from "./ui.js";

/** The folder the panel shows: the focused pane's, else its space's; and the machine it's on. */
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const where = () => JSON.stringify(location());
const caseless = () => window().platform === "windows";
// Herdr's exec has a minimal PATH without Git's sh on Windows; Git for Windows' sh.exe sets up its own.
const shell = (on) => (!on && caseless() ? "C:/Program Files/Git/bin/sh.exe" : "sh");
const gitIn = (path, on) => git.gitAt(exec, path, on, shell(on));
// Past this a load counts as hung: reads time out at 20s, so a healthy one never gets near it.
const LOAD_LIMIT_MS = 60000;

/** The space showing a checkout: its first terminal is in it, and the deepest checkout wins. */
function spaceOf(path, trees, on) {
  const all = panes(), dir = slash(path);
  const placeOf = (s) => { const tabs = new Set((s.tabs ?? []).map((c) => c.id)); return all.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null; };
  return spaces().find((s) => {
    if ((s.machine ?? null) !== (on ?? null)) return false;
    const at = slash(placeOf(s));
    return Boolean(at) && inside(at, dir, caseless()) && !trees.some((w) => slash(w.path).length > dir.length && inside(at, slash(w.path), caseless()));
  });
}

// Everything read from one folder. A new folder starts from these, so nothing from the last one shows.
const fresh = () => ({
  repo: { git: null, root: null, headSha: null, files: [], limited: false, error: null },
  branch: { branch: null, upstream: null, ahead: 0, behind: 0, remote: null },
  changes: { open: null, closed: false, view: EMPTY_DIFF },
  history: { commits: null, more: false, error: null, unpushed: new Set(), headSha: null, loading: false, sel: null, files: null, open: null, view: EMPTY_DIFF },
  trees: { list: null, error: null, loading: false },
});

export default class Changes extends View {
  init(_props, cx) {
    Object.assign(this, fresh());
    this.mode = "changes";       // or "history"
    this.menu = false;           // the worktree list is open
    this.sync = null;            // { op, context } while a fetch, pull or push runs
    this.committing = false;
    this.note = null;            // the last action's error
    this.gate = new Gate(LOAD_LIMIT_MS);   // the load running, if any
    this.readAt = null;          // when the folder was last read in full
    this.message = "";
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const had = Boolean(this.message.trim());
      this.message = this.input.value();
      if (had !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => { for (;;) { this.command(await nextCommand(), cx); cx.notify(); } });
  }

  /**
   * "changes-fp.<command>" from keys.json or `herdr-app do`: changes, history (or commits), worktrees (opens or
   * closes the list), fetch, pull, push, refresh, commit:<n>, file:<n>, worktree:<n>, new-worktree, back, more.
   */
  command(c, cx) {
    const [name, arg] = (c ?? "").split(":"), n = Number(arg), h = this.history;
    if (name === "changes" || name === "history" || name === "commits") this.setMode(name === "changes" ? "changes" : "history", cx);
    else if (name === "worktrees") this.toggleMenu(cx);
    else if (name === "fetch" || name === "pull" || name === "push") this.syncWith(name, cx);
    else if (name === "refresh") this.refresh(cx, true);
    else if (name === "worktree" && this.trees.list?.[n]) this.openTree(this.trees.list[n]);
    else if (name === "new-worktree") this.worktreeDialog("new", this.repo.root);
    else if (name === "commit" && h.commits?.[n]) this.openCommit(h.commits[n], cx);
    else if (name === "file" && h.files?.[n]) this.pickCommitFile(h.files[n].path, cx);
    else if (name === "back") this.closeCommit();
    else if (name === "more") this.loadHistory(cx, true);
  }

  // ——— Reading the folder

  /** One visit to a folder: what an earlier visit to the same folder read is stale too. */
  current(context) { return this.context === context && where() === context.key; }

  /** Read the folder again; `force` (the Refresh button) drops a load still running and starts over. */
  refresh(cx, force = false) {
    const { cwd, on } = location(), key = JSON.stringify({ cwd, on });
    if (key !== this.context?.key) {
      Object.assign(this, fresh());
      this.context = { key }; this.menu = false; this.note = null; this.watched = null; this.readAt = null;
      this.message = ""; this.input.set_value("");
      // A load left behind in another folder (a slow git, a read that never ends) must not hold this one.
      this.gate.reset(); this.queued = false;
    }
    if (!cwd || this.committing) return;
    const context = this.context, run = this.gate.enter(Date.now(), force);
    // Asked for meanwhile (a fetch or push just ended): it runs as soon as this one ends.
    if (!run) { this.queued = true; return; }
    const live = () => this.current(context) && this.gate.holds(run);
    if (force) cx.notify();
    cx.spawn(async (cx) => {
      try {
        const root = await git.findRoot(gitIn(cwd, on));
        if (!live()) return;
        if (!root) { Object.assign(this, fresh()); this.repo.error = "Not a git repository"; return; }
        const repo = gitIn(root, on);
        const readText = (p) => within(readTextFile(p, { on }), git.READ_MS, (ms) => cx.sleep(ms), "Reading a file");
        const [changes, branch] = await Promise.all([git.readChanges(repo, readText), git.readBranch(repo)]);
        if (!live()) return;
        this.repo = { git: repo, root, ...changes, error: null };
        this.branch = branch;
        this.readAt = Date.now();
        this.watch(root, cx);
        // History feeds the History tab, and Changes when nothing is uncommitted.
        const wantHistory = this.mode === "history" || !changes.files.length;
        if (wantHistory && (!this.history.commits || changes.headSha !== this.history.headSha || this.historyStale())) this.loadHistory(cx, false);
        if (this.menu) this.loadTrees(cx);
        await this.showChanges(context, cx);
      } catch (e) { if (live()) this.repo.error = String(e?.message ?? e); }
      finally {
        this.gate.leave(run);
        if (this.queued && !this.gate.busy) { this.queued = false; this.refresh(cx); }
        cx.notify();
      }
    });
  }

  /** Refresh whenever anything in a local repository changes; a remote one waits for the timer. */
  watch(root, cx) {
    if (this.repo.git.on || this.watched === root) return;
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

  // ——— Changes

  /** Keep the open file's diff current; the first file opens until another is picked or it's closed. */
  async showChanges(context, cx) {
    const c = this.changes, files = this.repo.files;
    if (c.open && !files.some((f) => f.path === c.open)) { c.open = null; c.view = EMPTY_DIFF; }
    if (!c.open && !c.closed && files.length) c.open = files[0].path;
    if (!c.open) return;
    try { await this.loadDiff(c.open, context, cx); }
    catch { if (this.current(context)) c.view = diffView(["Cannot preview this diff (too large or unreadable)"]); }
  }

  async loadDiff(path, context, cx) {
    const file = this.repo.files.find((f) => f.path === path), repo = this.repo.git;
    if (!file) return;
    const readText = (p) => within(readTextFile(p, { on: repo.on }), git.READ_MS, (ms) => cx.sleep(ms), "Reading the file");
    const { lines, added } = await git.readFileDiff(repo, file, Boolean(this.repo.headSha), readText);
    if (added !== undefined) file.add = added;
    if (this.current(context) && this.changes.open === path) this.changes.view = diffView(clip(lines));
  }

  pick(path, cx) {
    const c = this.changes, context = this.context;
    c.open = c.open === path ? null : path; c.closed = !c.open; c.view = EMPTY_DIFF; this.note = null;
    if (c.open) cx.spawn(async (cx) => {
      try { await this.loadDiff(path, context, cx); }
      catch (e) { if (this.current(context) && c.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e?.message ?? e}`; }
      cx.notify();
    });
    cx.notify();
  }

  commit(cx) {
    const repo = this.repo.git, message = this.message.trim(), context = this.context;
    // Commit all stages with `git add -A`, so a read still running doesn't matter: it needs only a change to commit.
    if (!message || !repo || !this.repo.files.length || this.committing || context?.key !== where()) return;
    this.committing = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        await git.commitAll(repo, message);
        if (this.current(context)) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (this.current(context)) this.note = `Commit failed: ${e?.message ?? e}`; }
      finally { this.committing = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // ——— The branch: fetch, pull, push, and its worktrees

  syncWith(op, cx) {
    const repo = this.repo.git, context = this.context, branch = { ...this.branch, hasHead: Boolean(this.repo.headSha) };
    if (!repo || this.sync || this.committing || context?.key !== where()) return;
    this.sync = { op, context }; this.note = null;
    cx.spawn(async (cx) => {
      try { await git.sync(repo, op, branch); }
      catch (e) { if (this.current(context)) this.note = `${op[0].toUpperCase() + op.slice(1)} failed: ${e?.message ?? e}`; }
      finally { this.sync = null; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  toggleMenu(cx) {
    this.menu = !this.menu && Boolean(this.repo.root);
    if (this.menu) this.loadTrees(cx);
    cx.notify();
  }

  loadTrees(cx) {
    const repo = this.repo.git, t = this.trees, context = this.context;
    if (!repo || t.loading) return;
    t.loading = true;
    cx.spawn(async (cx) => {
      try {
        const list = await git.readWorktrees(repo, (path) => gitIn(path, repo.on));
        if (this.current(context)) { t.list = list; t.error = null; }
      } catch (e) { if (this.current(context)) { t.list = []; t.error = String(e?.message ?? e); } }
      finally { t.loading = false; cx.notify(); }
    });
  }

  /** Go to the space showing a checkout, or open one there: unnamed, so the sidebar nests it under its repo. */
  openTree(w) {
    this.menu = false;
    const s = spaceOf(w.path, this.trees.list ?? [], this.repo.git?.on);
    if (s) run("space.select", { id: s.id });
    else run("space.new", { folder: w.path, machine: this.repo.git?.on ?? "" });
  }

  /** Herdr's worktree dialog: "new" makes one from the repository, "remove" deletes a checkout. */
  worktreeDialog(action, folder) {
    if (!folder) return;
    const space = action === "remove" ? spaceOf(folder, this.trees.list ?? [], this.repo.git?.on) : spaces().find((s) => s.active);
    openOverlay({ mod: "worktree", kind: "dialog", width: action === "new" ? 460 : 440, height: action === "new" ? 280 : 260, props: { space: space?.id, folder, machine: this.repo.git?.on, action } });
  }

  /** The worktree list's rows: each checkout, whether it's this one, whether a space shows it, and where it is. */
  treeRows() {
    const list = this.trees.list ?? [], on = this.repo.git?.on, root = slash(this.repo.root), userHome = on ? null : slash(home());
    return list.map((w) => {
      const path = slash(w.path), here = samePath(path, root, caseless());
      const shown = userHome && inside(path, userHome, caseless()) ? "~" + path.slice(userHome.length) : path;
      return { ...w, here, open: !here && Boolean(spaceOf(w.path, list, on)), shown };
    });
  }

  // ——— History

  setMode(mode, cx) {
    if (this.mode === mode) return;
    this.mode = mode; this.note = null;
    if (mode === "history" && (!this.history.commits || this.historyStale())) this.loadHistory(cx, false);
    cx.notify();
  }

  /** History's ↑ marks are the commits ahead of the upstream: a push or fetch since the last read changes them. */
  historyStale() { return Boolean(this.history.commits) && this.history.unpushed.size !== this.branch.ahead; }

  loadHistory(cx, more) {
    const repo = this.repo.git, h = this.history, context = this.context;
    if (!repo || h.loading) return;
    h.loading = true;
    cx.spawn(async (cx) => {
      try {
        const [page, unpushed] = await Promise.all([git.readLog(repo, more ? h.commits?.length ?? 0 : 0), more ? h.unpushed : git.readUnpushed(repo)]);
        if (!this.current(context)) return;
        h.commits = [...(more ? h.commits ?? [] : []), ...page.commits];
        h.more = page.more; h.unpushed = unpushed; h.error = null;
        if (!more) h.headSha = page.commits[0]?.sha ?? null;
        if (h.sel && !h.commits.some((c) => c.sha === h.sel.sha)) this.closeCommit();
      } catch (e) { if (this.current(context)) { h.commits = h.commits ?? []; h.more = false; h.error = String(e?.message ?? e); } }
      finally { h.loading = false; cx.notify(); }
    });
  }

  openCommit(c, cx) {
    const h = this.history, repo = this.repo.git, context = this.context;
    Object.assign(h, { sel: c, files: null, open: null, view: EMPTY_DIFF }); this.note = null;
    cx.spawn(async (cx) => {
      try {
        const files = await git.readCommitFiles(repo, c.sha);
        if (!this.current(context) || h.sel !== c) return;
        h.files = files;
        if (files.length) await this.pickCommitFile(files[0].path, cx);
      } catch (e) { if (this.current(context)) { h.files = []; this.note = `Cannot read this commit: ${e?.message ?? e}`; } }
      finally { cx.notify(); }
    });
    cx.notify();
  }

  async pickCommitFile(path, cx) {
    const h = this.history, c = h.sel, context = this.context;
    if (!c) return;
    h.open = path; h.view = EMPTY_DIFF; cx.notify();
    const lines = await git.readCommitDiff(this.repo.git, c.sha, path);
    if (this.current(context) && h.sel === c && h.open === path) h.view = diffView(clip(lines));
    cx.notify();
  }

  closeCommit() { Object.assign(this.history, { sel: null, files: null, open: null, view: EMPTY_DIFF }); }

  // ——— Drawing

  render(cx) {
    if (!checking() && where() !== this.context?.key) this.refresh(cx);
    const t = theme(), font = { size: settings().font_size, mono: settings().font_family ?? "JetBrains Mono" };
    const history = this.mode === "history";
    const body = history ? this.historyBody(t, font) : this.changesBody(t);
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        if (this.typing) { this.typing = false; this.handle.focus(); }
        else if (this.menu) this.menu = false;
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .when(Boolean(this.repo.root), (e) => e.child(ui.branchBar({ ...this.branch, headSha: this.repo.headSha },
        { menu: this.menu, syncing: this.sync?.context === this.context ? this.sync.op : this.sync ? "other" : null, loading: this.gate.busy, readAt: this.readAt }, t,
        { toggle: (cx) => this.toggleMenu(cx), sync: (op, cx) => this.syncWith(op, cx), refresh: (cx) => this.refresh(cx, true) })))
      // A failed read keeps what was read before on screen: say so, or it passes for the current state.
      .when(Boolean(this.repo.root && this.repo.error), (e) => e.child(ui.banner(this.repo.error, this.readAt, t)))
      .when(this.menu, (e) => e.child(ui.worktreeList(this.treeRows(), this.trees.list?.length ? null : this.trees.error || (this.trees.list ? "No worktrees" : "Loading worktrees…"), t, {
        open: (w, cx) => { this.openTree(w); cx.notify(); },
        remove: (w) => this.worktreeDialog("remove", w.path),
        create: (cx) => { this.menu = false; this.worktreeDialog("new", this.repo.root); cx.notify(); },
      })))
      .child(ui.tabBar(this.mode, body.files, t, (mode, cx) => this.setMode(mode, cx)))
      .child(ui.listBox(history ? "changes-clist" : "changes-list", body.rows, body.rows.length, body.empty, t))
      .when(!history && this.repo.limited, (e) => e.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(body.recent
        ? ui.recentCommits(body.recent, this.history.unpushed, font.mono, t, (c, cx) => { this.setMode("history", cx); this.openCommit(c, cx); })
        : ui.diffPane(history ? "changes-cdiff" : "changes-diff", body.view, body.hint, font, t))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .when(!history && Boolean(this.repo.root), (e) => e.child(ui.commitBox(this.input, {
        typing: this.typing, count: this.repo.files.length, busy: this.committing,
        ready: Boolean(this.message.trim() && this.repo.files.length && !this.committing),
      }, t, (cx) => this.commit(cx))));
  }

  changesBody(t) {
    const { files, error, root } = this.repo, open = this.changes.open;
    return {
      files,
      rows: files.map((f) => ui.fileRow(f, open === f.path, (cx) => this.pick(f.path, cx), t, `change-${f.path}`)),
      empty: files.length ? null
        : !root ? error || (this.gate.busy ? "Loading changes…" : "No folder")
        : error ? "Could not read the changes" : this.readAt ? "No uncommitted changes" : "Loading changes…",
      view: this.changes.view,
      // Nothing uncommitted: the room the diff would take shows the latest commits instead.
      recent: !files.length && root && !error && this.history.commits?.length ? this.history.commits.slice(0, 30) : null,
      hint: !open && files.length ? "Select a file to view its changes" : null,
    };
  }

  historyBody(t, { mono }) {
    const h = this.history, on = {
      open: (c, cx) => this.openCommit(c, cx), more: (cx) => this.loadHistory(cx, true),
      back: (cx) => { this.closeCommit(); cx.notify(); }, file: (path, cx) => this.pickCommitFile(path, cx),
    };
    if (h.sel) return {
      files: h.files ?? [],
      rows: ui.commitDetail(h.sel, h.files ?? [], h.open, mono, t, on),
      empty: h.files ? (h.files.length ? null : "No file changes") : "Loading commit…",
      view: h.view, hint: null,
    };
    return {
      files: [],
      rows: ui.commitRows(h.commits ?? [], { unpushed: h.unpushed, more: h.more, loading: h.loading, mono }, t, on),
      empty: h.commits?.length ? null : h.error || (this.repo.root ? "Loading commits…" : this.repo.error || "No folder"),
      view: EMPTY_DIFF,
      hint: h.commits?.length ? "Select a commit to see its changes" : null,
    };
  }
}
