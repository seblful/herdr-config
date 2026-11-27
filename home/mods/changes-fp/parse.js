// Parsing git's output and shaping diffs for display. Plain functions with no imports, so tests run them in Node.

/** Lines in a text, not counting a final newline. */
export const countLines = (text) => (text ? text.split("\n").length - Number(text.endsWith("\n")) : 0);

const WIDE = /[\p{Ideographic}\p{Emoji_Presentation}\p{Extended_Pictographic}\u{1100}-\u{115f}\u{2e80}-\u{a4cf}\u{ac00}-\u{d7a3}\u{fe10}-\u{fe19}\u{fe30}-\u{fe6f}\u{ff01}-\u{ff60}\u{ffe0}-\u{ffe6}]/gu;

/** Columns a line takes: spacing marks keep room, wide glyphs take two. */
export function displayColumns(text) {
  let columns = text.length;
  for (const glyph of text.match(WIDE) ?? []) if (glyph.length === 1) columns++;
  return columns;
}

/** Text draws a tab as nothing: pad each to the next 4-column stop. */
export const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - ((s.length - 1) % 4) + 4));

const MAX_LINES = 1500, MAX_LINE = 4000;

/** A diff cut to what the panel draws: 1,500 lines of at most 4,000 characters. */
export const clip = (lines) => lines.slice(0, MAX_LINES).map((l) => (l.length > MAX_LINE ? l.slice(0, MAX_LINE) + "… (line truncated)" : l));

/** A diff from its first hunk on, or null when it has none (binary, mode only). */
export function hunks(text) {
  const all = text.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
  return first < 0 ? null : all.slice(first);
}

/** Number each diff line once, so a frame only draws the rows on screen. */
export function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0], text = untab(line.slice(1)) || " ";
    if (kind === "-") return { kind, number: old++, text };
    if (kind === "+") return { kind, number: next++, text };
    if (kind === " ") { old++; return { kind, number: next++, text }; }
    return { kind: "", text: line };
  });
}

/** A diff ready to draw: its rows, widest line and line-number width. */
export function diffView(lines) {
  const rows = diffRows(lines);
  return {
    rows,
    longest: Math.max(0, ...rows.map((r) => displayColumns(r.text))),
    gutterChars: Math.max(4, String(Math.max(0, ...rows.map((r) => r.number ?? 0))).length),
  };
}

export const EMPTY_DIFF = diffView([]);

const MAX_FILES = 1000;

/** `git status --porcelain=v1 -z` as files: path, status (A, M, D, or U for a conflict), fresh (untracked). */
export function parseStatus(out) {
  const entries = out.split("\0").filter(Boolean);
  const files = entries.slice(0, MAX_FILES).map((entry) => {
    const xy = entry.slice(0, 2), fresh = xy === "??";
    const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
    const status = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
    return { path: entry.slice(3), status, fresh, add: 0, del: 0 };
  });
  return { files, limited: entries.length > MAX_FILES };
}

/** `git diff --numstat -z` outputs as lines added and removed per path, summed. */
export function parseNumstat(outputs) {
  const stats = {};
  for (const out of outputs) {
    for (const entry of out.split("\0")) {
      const [a, d, ...parts] = entry.replace(/^\n+/, "").split("\t");
      if (!parts.length) continue;
      const path = parts.join("\t"), was = stats[path] ?? { add: 0, del: 0 };
      stats[path] = { add: was.add + (Number(a) || 0), del: was.del + (Number(d) || 0), binary: a === "-" };
    }
  }
  return stats;
}

/** `git show --name-status -z` as files with their status letter. */
export function parseNameStatus(out) {
  const f = out.split("\0"), files = [];
  for (let i = 0; i + 1 < f.length; i += 2) {
    const k = f[i].replace(/^\n+/, "")[0];
    if (k) files.push({ path: f[i + 1], status: k === "D" ? "D" : k === "A" ? "A" : "M", add: 0, del: 0 });
  }
  return files.slice(0, MAX_FILES);
}

/** The `git log` format parseLog reads: fields split by unit separators. */
export const LOG_FORMAT = "--format=%H%x1f%h%x1f%an%x1f%at%x1f%D%x1f%s";

/** `git log -z` in LOG_FORMAT as commits. */
export function parseLog(out) {
  return out.split("\0").filter((x) => x.trim()).map((rec) => {
    const [sha, short, author, at, refs, subject] = rec.replace(/^\n+/, "").split("\x1f");
    return { sha, short, author, at: Number(at), refs, subject };
  });
}

/** The first branch or tag a commit carries, as a short label. */
export const refLabel = (refs) => (refs ?? "").split(", ").filter(Boolean).map((r) => r.replace(/^HEAD -> /, "").replace(/^tag: /, "◆ "))[0];

/** The `git for-each-ref` format parseBranches reads: fields split by unit separators, one ref a line. */
export const BRANCH_FORMAT = "--format=%(refname)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(committerdate:unix)%1f%(symref)";

/** `git for-each-ref` in BRANCH_FORMAT over refs/heads and refs/remotes: local and remote branches, newest first. */
export function parseBranches(out) {
  const list = [];
  for (const line of out.split("\n")) {
    const [ref, upstream, track = "", at, symref] = line.split("\x1f");
    if (!ref || symref) continue;   // origin/HEAD points at another branch
    const local = ref.startsWith("refs/heads/"), remote = ref.startsWith("refs/remotes/");
    if (!local && !remote) continue;
    const name = ref.slice(local ? 11 : 13);
    if (remote && !name.includes("/")) continue;
    list.push({
      name, remote, upstream: upstream || null, at: Number(at) || 0,
      ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0), gone: track === "gone",
    });
  }
  return list.sort((a, b) => Number(a.remote) - Number(b.remote) || b.at - a.at);
}

const MAX_BRANCHES = 200;

/**
 * The branch list's rows. Each branch says where it is checked out: "here" (this folder), "folder" (another
 * worktree, opened as its space), "local" (nowhere: switch this folder to it) or "remote" (only on a remote:
 * switching makes a local branch that tracks it). A remote branch a local one already tracks is left out, and a
 * worktree on no branch comes last. `create` is the filter when it names no local branch, to offer making it.
 */
export function branchRows(branches, trees, { root, caseless, filter = "" }) {
  const here = (w) => samePath(slash(w.path), slash(root), caseless);
  const byBranch = new Map(trees.filter((w) => w.branch).map((w) => [w.branch, w]));
  const tracked = new Set(branches.filter((b) => !b.remote).flatMap((b) => [b.upstream, `${b.upstream?.split("/")[0]}/${b.name}`]));
  const rows = [];
  for (const b of branches) {
    if (b.remote && tracked.has(b.name)) continue;
    const w = b.remote ? null : byBranch.get(b.name);
    const kind = w ? (here(w) ? "here" : "folder") : b.remote ? "remote" : "local";
    rows.push({ ...b, kind, path: w?.path ?? null, main: Boolean(w?.main), locked: w?.locked ?? null, dirty: w?.dirty ?? 0 });
  }
  for (const w of trees.filter((w) => !w.branch)) {
    rows.push({ name: `detached ${w.head.slice(0, 7)}`, detached: true, remote: false, kind: here(w) ? "here" : "folder", path: w.path,
      main: w.main, locked: w.locked, dirty: w.dirty ?? 0, ahead: 0, behind: 0, at: 0 });
  }
  const rank = { here: 0, folder: 1, local: 1, remote: 2 };
  rows.sort((a, b) => rank[a.kind] - rank[b.kind] || Number(Boolean(a.detached)) - Number(Boolean(b.detached)) || b.at - a.at);
  const wanted = filter.trim(), needle = wanted.toLowerCase();
  const shown = needle ? rows.filter((r) => r.name.toLowerCase().includes(needle)) : rows;
  const create = wanted && !/\s/.test(wanted) && !branches.some((b) => !b.remote && b.name === wanted) ? wanted : null;
  return { rows: shown.slice(0, MAX_BRANCHES), more: shown.length > MAX_BRANCHES, create };
}

/** Entries in `git status --porcelain=v1 -z`. */
export const statusCount = (out) => out.split("\0").filter(Boolean).length;

/** `git rev-list --left-right --count HEAD...@{u}` as [ahead, behind]. */
export const parseCounts = (out) => out.trim().split(/\s+/).map(Number);

/** `git worktree list --porcelain`: the main checkout first; bare and missing ones dropped. */
export function parseWorktrees(out) {
  return out.split(/\n\n+/).map((block, i) => {
    const lines = block.split("\n"), field = (k) => lines.find((l) => l === k || l.startsWith(k + " "));
    const bare = Boolean(field("bare")), lock = field("locked");
    return {
      path: field("worktree")?.slice(9), head: field("HEAD")?.slice(5) ?? "", branch: field("branch")?.slice(7).replace(/^refs\/heads\//, "") ?? null,
      main: i === 0 && !bare, bare, prunable: Boolean(field("prunable")), locked: lock === undefined ? null : lock.slice(7) || "locked",
    };
  }).filter((w) => w.path && !w.bare && !w.prunable);
}

/** The reason in a failed push or pull, at most three lines: git prints hints and progress around it. */
export function gitError(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^hint:/i.test(l));
  const reasons = lines.filter((l) => /^(fatal|error)\b|^!/i.test(l) || /rejected|denied|not possible/i.test(l));
  return (reasons.length ? reasons : lines).slice(0, 3).join("\n") || "git gave no reason";
}

/**
 * The git arguments for fetch, pull or push on a branch, or null when it can't. Pull only fast-forwards,
 * so it never makes a merge commit; push on a branch with no upstream publishes it to the remote.
 */
export function syncArgs(op, { branch, upstream, remote, hasHead }) {
  if (!remote) return null;
  if (op === "fetch") return upstream ? ["fetch"] : ["fetch", remote];
  if (!branch || !hasHead) return null;
  if (op === "pull") return upstream ? ["pull", "--ff-only"] : null;
  if (op === "push") return upstream ? ["push"] : ["push", "-u", remote, "HEAD"];
  return null;
}

/** How long ago a Unix time was: now, 5m, 3h, 2d, or the date past a month. */
export function ago(at, now = Date.now() / 1000) {
  const s = Math.max(0, now - at);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 2592000) return `${Math.floor(s / 86400)}d`;
  return new Date(at * 1000).toISOString().slice(0, 10);
}

/** Work that rejects once `sleep(ms)` resolves first: a read that never answers must not hold the panel. */
export function within(work, ms, sleep, what) {
  return Promise.race([work, sleep(ms).then(() => { throw new Error(`${what} took over ${Math.round(ms / 1000)}s`); })]);
}

/**
 * One load at a time, where a load older than `limit` ms no longer counts: a task that never ends (a hung
 * read, a cancelled await) would otherwise block every later load and freeze the panel on old data.
 */
export class Gate {
  constructor(limit) { this.limit = limit; this.run = null; }
  /** A token for a new load, or null while a younger one runs; `force` starts one anyway. */
  enter(now = Date.now(), force = false) {
    if (this.run && !force && now - this.run.at < this.limit) return null;
    return (this.run = { at: now });
  }
  /** Whether `run` is still the load in charge, so its results may be shown. */
  holds(run) { return this.run === run; }
  leave(run) { if (this.run === run) this.run = null; }
  reset() { this.run = null; }
  get busy() { return this.run !== null; }
}

/** "1 file", "3 files". */
export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A path with forward slashes and no trailing one. */
export const slash = (p) => (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");

/** Whether two paths are the same. Windows compares without case: git says C:/x where a pane says c:\x. */
export const samePath = (a, b, caseless) => (caseless ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Whether path p is dir or inside it. */
export const inside = (p, dir, caseless) =>
  samePath(p, dir, caseless) || (p.length > dir.length && samePath(p.slice(0, dir.length + 1), dir + "/", caseless));
