// Every git command the Git panel runs. No herdr import: the panel hands in its exec, so this runs anywhere.
import {
  parseStatus, parseNumstat, parseNameStatus, parseLog, LOG_FORMAT, parseCounts, parseWorktrees, gitError, hunks, countLines, syncArgs, statusCount,
  parseBranches, BRANCH_FORMAT,
} from "./parse.js";

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie): the folder watch would
// see it, and every refresh would start the next one.
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const MERGES = ["--diff-merges=first-parent"];   // a merge commit diffs against its first parent
const PLAIN = ["--no-ext-diff", "--no-textconv", "--no-color"];
const NUMSTAT = ["--numstat", "-z", "--no-renames"];
export const READ_MS = 20000;
const NETWORK_MS = 120000;
// Commit and push run the repository's hooks (lint, tests, a build), which can take minutes: Herdr's cap.
const HOOKS_MS = 600000;
// Run through sh so git fails at once instead of waiting on a password prompt nobody can see.
const NO_PROMPT = 'GIT_TERMINAL_PROMPT=0 exec git "$@"';
const COUNTED_NEW = 20;   // new files whose lines count toward the summary; past that, reading them all costs too much
export const LOG_PAGE = 100;

/**
 * Git in one folder on one machine: read() never writes under .git, write() may, network() reaches a remote
 * and never prompts. `shell` is the sh that runs network(): Git for Windows' own on a Windows machine.
 */
export function gitAt(exec, cwd, on, shell = "sh") {
  return {
    cwd, on, shell,
    read: (args) => exec("git", [...READ, ...args], { cwd, on, timeout: READ_MS }),
    write: (args, timeout) => exec("git", args, { cwd, on, timeout }),
    network: (args, timeout) => exec(shell, ["-c", NO_PROMPT, "git", ...args], { cwd, on, timeout }),
  };
}

const stdout = (r) => {
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "git failed").trim());
  return r.stdout;
};

/** The checkout's top folder, or null outside a repository. */
export async function findRoot(git) {
  const r = await git.read(["rev-parse", "--show-toplevel"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Uncommitted files with lines added and removed, and the commit checked out (null before the first). */
export async function readChanges(git, readText) {
  const [status, head] = await Promise.all([
    git.read(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]),
    git.read(["rev-parse", "--verify", "HEAD"]),
  ]);
  const { files, limited } = parseStatus(stdout(status));
  const headSha = head.code === 0 ? head.stdout.trim() : null;
  // Before the first commit there is no HEAD to diff against, so staged and unstaged are read apart.
  const diffs = await Promise.all(headSha
    ? [git.read(["diff", "HEAD", ...NUMSTAT])]
    : [git.read(["diff", "--cached", ...NUMSTAT]), git.read(["diff", ...NUMSTAT])]);
  const stats = parseNumstat(diffs.map(stdout));
  for (const f of files) Object.assign(f, stats[f.path]);
  // git counts no lines for an untracked file: read the first few, so the summary isn't short.
  await Promise.all(files.filter((f) => f.fresh).slice(0, COUNTED_NEW).map(async (f) => {
    const text = await readText(`${git.cwd}/${f.path}`).catch(() => null);
    if (text !== null && !text.includes("\0")) f.add = countLines(text);
  }));
  return { files, limited, headSha };
}

/** The branch checked out, its upstream, how far apart they are, and the remote to publish to. */
export async function readBranch(git) {
  const [branch, counts, upstream, remotes] = await Promise.all([
    git.read(["branch", "--show-current"]),
    git.read(["rev-list", "--left-right", "--count", "HEAD...@{u}"]),
    git.read(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
    git.read(["remote"]),
  ]);
  // Without an upstream, rev-list and rev-parse fail: nothing is ahead or behind.
  const [ahead, behind] = counts.code === 0 ? parseCounts(counts.stdout) : [0, 0];
  const names = remotes.code === 0 ? remotes.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  return {
    branch: branch.code === 0 ? branch.stdout.trim() || null : null,
    upstream: upstream.code === 0 ? upstream.stdout.trim() || null : null,
    ahead, behind,
    remote: names.includes("origin") ? "origin" : names[0] ?? null,
  };
}

/** An uncommitted file's diff; a new file is read whole, and `added` counts its lines. */
export async function readFileDiff(git, file, hasHead, readText) {
  if (file.fresh || (!hasHead && file.status === "A")) {
    const text = await readText(`${git.cwd}/${file.path}`).catch(() => null);
    if (text === null) return { lines: ["Cannot preview this file (binary, too large, or unreadable)"] };
    if (text.includes("\0")) return { lines: ["Binary file · no text diff"] };
    const added = countLines(text);
    const body = text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map((l) => `+${l}`);
    return { added, lines: [`@@ -0,0 +1,${added} @@`, ...body] };
  }
  const out = stdout(await git.read(["diff", ...(hasHead ? ["HEAD"] : []), ...PLAIN, "--", file.path]));
  return { lines: hunks(out) ?? [file.binary ? "Binary file changed" : "No text diff available"] };
}

/** A page of history from `skip` on, and whether more follows. */
export async function readLog(git, skip) {
  const r = await git.read(["log", "-z", `--skip=${skip}`, "-n", String(LOG_PAGE + 1), LOG_FORMAT]);
  if (r.code !== 0) throw new Error(/does not have any commits/.test(r.stderr) ? "No commits yet" : (r.stderr || "Cannot read the history").trim());
  const list = parseLog(r.stdout);
  return { commits: list.slice(0, LOG_PAGE), more: list.length > LOG_PAGE };
}

/** The commits the upstream doesn't have yet; none without an upstream. */
export async function readUnpushed(git) {
  const r = await git.read(["rev-list", "@{u}..HEAD"]).catch(() => null);
  return new Set(r?.code === 0 ? r.stdout.split("\n").filter(Boolean) : []);
}

/** The files a commit changed, with lines added and removed. */
export async function readCommitFiles(git, sha) {
  const [names, stats] = await Promise.all([
    git.read(["show", "--format=", "--name-status", "-z", "--no-renames", ...MERGES, sha]),
    git.read(["show", "--format=", ...NUMSTAT, ...MERGES, sha]),
  ]);
  const files = parseNameStatus(stdout(names)), counts = parseNumstat([stats.stdout]);
  for (const f of files) Object.assign(f, counts[f.path]);
  return files;
}

/** One file's diff in a commit. */
export async function readCommitDiff(git, sha, path) {
  const r = await git.read(["show", "--format=", ...PLAIN, ...MERGES, sha, "--", path]).catch((e) => ({ code: -1, stdout: "", stderr: String(e) }));
  if (r.code !== 0) return [`Cannot show this diff: ${(r.stderr || "").trim()}`];
  return hunks(r.stdout) ?? [/^Binary files/m.test(r.stdout) ? "Binary file changed" : "No text diff"];
}

/** The repository's checkouts, each with its uncommitted files and distance from its upstream. */
export async function readWorktrees(git, gitIn) {
  const list = parseWorktrees(stdout(await git.read(["worktree", "list", "--porcelain"])));
  await Promise.all(list.slice(0, 30).map(async (w) => {
    const at = gitIn(w.path);
    const [status, counts] = await Promise.all([
      at.read(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]).catch(() => null),
      w.branch ? at.read(["rev-list", "--left-right", "--count", "HEAD...@{u}"]).catch(() => null) : null,
    ]);
    if (status?.code === 0) w.dirty = statusCount(status.stdout);   // counted as the Changes tab counts
    if (counts?.code === 0) [w.ahead, w.behind] = parseCounts(counts.stdout);
  }));
  return list;
}

/** Local and remote branches with their upstream, distance from it and last commit time. */
export async function readBranches(git) {
  return parseBranches(stdout(await git.read(["for-each-ref", BRANCH_FORMAT, "refs/heads", "refs/remotes"])));
}

const SWITCH_MS = 60000;
// Git's words when uncommitted changes stand in the way of a checkout: the cue to offer stashing them.
const BLOCKED = /would be overwritten|commit your changes or stash them|untracked working tree files/i;

/**
 * Switch this folder to a branch: `create` makes it from what is checked out, a remote one gets a local branch
 * that tracks it. Fails with git's reason; `blocked` on the error says uncommitted changes were in the way.
 */
export async function switchTo(git, { name, remote = false, create = false }) {
  const r = await git.write(create ? ["switch", "-c", name] : remote ? ["switch", "--track", name] : ["switch", name], SWITCH_MS);
  if (r.code !== 0) {
    const text = r.stderr || r.stdout, blocked = BLOCKED.test(text);
    // Git lists the files in the way on tab-indented lines, which gitError leaves out: name them.
    const files = text.split(/\r?\n/).filter((l) => l.startsWith("\t")).map((l) => l.trim());
    const message = blocked && files.length
      ? `uncommitted changes to ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` and ${files.length - 3} more` : ""} would be overwritten`
      : gitError(text);
    throw Object.assign(new Error(message), { blocked });
  }
}

/** Stash every uncommitted change (new files too), then switch; when the switch fails the changes come back. */
export async function stashAndSwitch(git, target, from) {
  const label = `herdr: switching from ${from ?? "a detached HEAD"} to ${target.name}`;
  const stash = await git.write(["stash", "push", "--include-untracked", "-m", label], SWITCH_MS);
  if (stash.code !== 0) throw new Error(gitError(stash.stderr || stash.stdout));
  // Nothing stashed: popping now would bring back an older, unrelated stash.
  const saved = !/no local changes to save/i.test(stash.stdout + stash.stderr);
  try { await switchTo(git, target); }
  catch (e) { if (saved) await git.write(["stash", "pop"], SWITCH_MS).catch(() => null); throw e; }
  return saved ? label : null;
}

/** Stage every change, then commit it; when the commit fails (a hook said no), the staging is put back. */
export async function commitAll(git, message) {
  const before = await git.write(["write-tree"]).catch(() => null);   // fails with conflicts: nothing to put back then
  const added = await git.write(["add", "-A"]);
  if (added.code !== 0) throw new Error((added.stderr || added.stdout).trim());
  // A timeout throws here and leaves the staging alone: git may still be running and finish the commit.
  const r = await git.write(["commit", "-m", message], HOOKS_MS);
  if (r.code === 0) return;
  if (before?.code === 0) await git.write(["read-tree", before.stdout.trim()]).catch(() => null);
  throw new Error((r.stderr || r.stdout).trim() || "git commit failed");
}

/** Fetch, pull or push the branch; throws with git's reason when that fails. */
export async function sync(git, op, branch) {
  const args = syncArgs(op, branch);
  if (!args) throw new Error(`This branch has nothing to ${op}`);
  const r = await git.network(args, op === "push" ? HOOKS_MS : NETWORK_MS);
  if (r.code !== 0) throw new Error(gitError(r.stderr || r.stdout));
}
