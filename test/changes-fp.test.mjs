// Tests for the Git panel's parsing (home/mods/changes-fp/parse.js), which runs without Herdr.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseStatus, parseNumstat, parseNameStatus, parseLog, parseCounts, parseWorktrees, refLabel,
  gitError, syncArgs, diffRows, diffView, hunks, clip, countLines, untab, ago, plural, inside, samePath, statusCount, within, Gate,
  parseBranches, branchRows,
} from "../home/mods/changes-fp/parse.js";
import { gitAt, commitAll, sync, readWorktrees, READ_MS, switchTo, stashAndSwitch } from "../home/mods/changes-fp/git.js";

/** An exec that records each call and answers from `reply(cmd, args)`: a result, or a thrown error. */
function fakeExec(reply = () => ({ code: 0, stdout: "", stderr: "" })) {
  const calls = [];
  const exec = async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { code: 0, stdout: "", stderr: "", ...reply(cmd, args) }; };
  return { exec, calls };
}
const gitArgs = (calls) => calls.map((c) => (c.cmd === "git" ? c.args : c.args.slice(3)).join(" "));

test("status: letters for modified, added, untracked, deleted and conflicted files", () => {
  const out = [" M src/a.js", "A  b.js", "?? new.txt", " D gone.js", "UU both.js", "AA twice.js"].join("\0") + "\0";
  const { files, limited } = parseStatus(out);
  assert.deepEqual(files.map((f) => [f.path, f.status, f.fresh]), [
    ["src/a.js", "M", false], ["b.js", "A", false], ["new.txt", "A", true], ["gone.js", "D", false], ["both.js", "U", false], ["twice.js", "U", false],
  ]);
  assert.equal(limited, false);
});

test("status: past 1,000 files the list stops and says so", () => {
  const out = Array.from({ length: 1001 }, (_, i) => `?? f${i}`).join("\0");
  const { files, limited } = parseStatus(out);
  assert.equal(files.length, 1000);
  assert.equal(limited, true);
});

test("numstat: sums outputs per path and marks binary files", () => {
  const stats = parseNumstat(["3\t1\ta.js\0-\t-\timg.png\0", "2\t0\ta.js\0"]);
  assert.deepEqual(stats["a.js"], { add: 5, del: 1, binary: false });
  assert.equal(stats["img.png"].binary, true);
});

test("name-status: a commit's files with their letters", () => {
  assert.deepEqual(parseNameStatus("M\0a.js\0A\0b.js\0D\0c.js\0").map((f) => [f.path, f.status]), [["a.js", "M"], ["b.js", "A"], ["c.js", "D"]]);
});

test("log: commits from unit-separated fields", () => {
  const rec = ["abc123", "abc", "Ann", "1700000000", "HEAD -> main, origin/main", "fix: a bug"].join("\x1f");
  const [c] = parseLog(rec + "\0");
  assert.deepEqual(c, { sha: "abc123", short: "abc", author: "Ann", at: 1700000000, refs: "HEAD -> main, origin/main", subject: "fix: a bug" });
  assert.equal(refLabel(c.refs), "main");
  assert.equal(refLabel("tag: v1.0"), "◆ v1.0");
  assert.equal(refLabel(""), undefined);
});

test("counts: ahead and behind", () => {
  assert.deepEqual(parseCounts("2\t5\n"), [2, 5]);
});

test("worktrees: main first, bare and prunable ones dropped, locks kept", () => {
  const out = [
    "worktree /r\nHEAD aaa\nbranch refs/heads/main",
    "worktree /w/feature\nHEAD bbb\nbranch refs/heads/feature/x\nlocked moving it",
    "worktree /w/old\nHEAD ccc\ndetached\nprunable gitdir file points to non-existent location",
    "worktree /w/plain\nHEAD ddd\ndetached\nlocked",
  ].join("\n\n") + "\n";
  const list = parseWorktrees(out);
  assert.deepEqual(list.map((w) => [w.path, w.branch, w.main, w.locked]), [
    ["/r", "main", true, null], ["/w/feature", "feature/x", false, "moving it"], ["/w/plain", null, false, "locked"],
  ]);
});

test("gitError: keeps the reason, drops hints and progress", () => {
  const out = [
    "To github.com:me/repo.git",
    " ! [rejected]        main -> main (fetch first)",
    "error: failed to push some refs to 'github.com:me/repo.git'",
    "hint: Updates were rejected because the remote contains work that you do not",
    "hint: have locally.",
  ].join("\n");
  assert.equal(gitError(out), "! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'github.com:me/repo.git'");
  assert.equal(gitError("fatal: Not possible to fast-forward, aborting.\n"), "fatal: Not possible to fast-forward, aborting.");
  assert.equal(gitError("something odd"), "something odd");
  assert.equal(gitError(""), "git gave no reason");
});

test("syncArgs: what each button runs, and when it can't", () => {
  const tracked = { branch: "main", upstream: "origin/main", remote: "origin", hasHead: true };
  const unpublished = { ...tracked, upstream: null };
  assert.deepEqual(syncArgs("fetch", tracked), ["fetch"]);
  assert.deepEqual(syncArgs("fetch", unpublished), ["fetch", "origin"]);
  assert.deepEqual(syncArgs("pull", tracked), ["pull", "--ff-only"]);
  assert.equal(syncArgs("pull", unpublished), null);
  assert.deepEqual(syncArgs("push", tracked), ["push"]);
  assert.deepEqual(syncArgs("push", unpublished), ["push", "-u", "origin", "HEAD"]);
  assert.equal(syncArgs("push", { ...tracked, branch: null }), null, "detached HEAD");
  assert.equal(syncArgs("push", { ...unpublished, hasHead: false }), null, "no commits yet");
  assert.equal(syncArgs("fetch", { ...tracked, remote: null }), null, "no remote");
  assert.equal(syncArgs("merge", tracked), null);
});

test("diff: rows numbered from each hunk, tabs padded", () => {
  const rows = diffRows(["@@ -10,2 +10,3 @@", " same", "-old", "+new", "+\tx", "\\ No newline at end of file"]);
  assert.deepEqual(rows.map((r) => [r.kind, r.number]), [["@", undefined], [" ", 10], ["-", 11], ["+", 11], ["+", 12], ["", undefined]]);
  assert.equal(rows[4].text, "    x");
  const view = diffView(["@@ -1 +1 @@", "+" + "y".repeat(50)]);
  assert.equal(view.longest, 50);
  assert.equal(view.gutterChars, 4);
});

test("diff: hunks, clipping and line counts", () => {
  assert.deepEqual(hunks("diff --git a/x b/x\nindex 1..2\n@@ -1 +1 @@\n-a\n+b\n"), ["@@ -1 +1 @@", "-a", "+b"]);
  assert.equal(hunks("Binary files a/x and b/x differ\n"), null);
  const long = clip(["x".repeat(5000), ...Array(2000).fill("y")]);
  assert.equal(long.length, 1500);
  assert.ok(long[0].endsWith("… (line truncated)"));
  assert.equal(countLines("a\nb\n"), 2);
  assert.equal(countLines("a\nb"), 2);
  assert.equal(countLines(""), 0);
  assert.equal(untab("ab\tc"), "ab  c");
});

test("ago and plural", () => {
  const now = 1_700_000_000;
  assert.equal(ago(now - 30, now), "now");
  assert.equal(ago(now - 300, now), "5m");
  assert.equal(ago(now - 7200, now), "2h");
  assert.equal(ago(now - 3 * 86400, now), "3d");
  assert.match(ago(now - 60 * 86400, now), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(plural(1, "file"), "1 file");
  assert.equal(plural(3, "file"), "3 files");
});

test("paths: same and inside, without case on Windows", () => {
  assert.ok(samePath("C:/Users/x", "c:/users/x", true));
  assert.ok(!samePath("C:/Users/x", "c:/users/x", false));
  assert.ok(inside("C:/r/sub/file", "c:/r", true));
  assert.ok(inside("/r", "/r", false));
  assert.ok(!inside("/rx", "/r", false), "a sibling with the same prefix");
});

test("status count: every entry, untracked files included", () => {
  assert.equal(statusCount(" M a.js\0?? dir/new.txt\0?? dir/other.txt\0"), 3);
  assert.equal(statusCount(""), 0);
});

test("within: the work's answer, or a timeout once the sleep ends first", async () => {
  assert.equal(await within(Promise.resolve(7), 1000, () => new Promise(() => {}), "Reading"), 7);
  await assert.rejects(within(new Promise(() => {}), 20000, () => Promise.resolve(), "Reading a file"), /Reading a file took over 20s/);
});

test("gate: one load at a time, but a hung one stops counting after the limit", () => {
  const gate = new Gate(60000);
  const first = gate.enter(0);
  assert.ok(first && gate.busy);
  assert.equal(gate.enter(59999), null, "a young load holds the gate");
  const second = gate.enter(60000);
  assert.ok(second, "a load past the limit is given up");
  assert.ok(!gate.holds(first) && gate.holds(second), "the given-up load may no longer show its results");
  gate.leave(first);
  assert.ok(gate.busy, "the old load ending late doesn't free the gate");
  const forced = gate.enter(60001, true);
  assert.ok(forced && gate.holds(forced), "Refresh starts over at once");
  gate.leave(forced);
  assert.ok(!gate.busy);
});

test("git reads have a time limit", async () => {
  const { exec, calls } = fakeExec();
  await gitAt(exec, "/r", null).read(["status"]);
  assert.equal(calls[0].opts.timeout, READ_MS);
  assert.ok(calls[0].args.includes("--no-optional-locks"));
});

test("sync: runs through sh with prompts off; push waits for the pre-push hook", async () => {
  const { exec, calls } = fakeExec();
  const git = gitAt(exec, "/r", null, "C:/Program Files/Git/bin/sh.exe");
  const branch = { branch: "main", upstream: "origin/main", remote: "origin", hasHead: true };
  await sync(git, "fetch", branch);
  await sync(git, "push", branch);
  assert.equal(calls[0].cmd, "C:/Program Files/Git/bin/sh.exe");
  assert.deepEqual(calls[0].args.slice(0, 2), ["-c", 'GIT_TERMINAL_PROMPT=0 exec git "$@"']);
  assert.deepEqual(gitArgs(calls), ["fetch", "push"]);
  assert.equal(calls[0].opts.timeout, 120000);
  assert.equal(calls[1].opts.timeout, 600000);
});

test("sync: git's reason comes back when it fails", async () => {
  const { exec } = fakeExec(() => ({ code: 128, stderr: "fatal: could not read Username for 'https://x': terminal prompts disabled\n" }));
  const branch = { branch: "main", upstream: "origin/main", remote: "origin", hasHead: true };
  await assert.rejects(sync(gitAt(exec, "/r", null), "pull", branch), /terminal prompts disabled/);
});

test("commit all: stages, commits, and waits for the pre-commit hook", async () => {
  const { exec, calls } = fakeExec((_c, args) => (args[0] === "write-tree" ? { stdout: "tree1\n" } : {}));
  await commitAll(gitAt(exec, "/r", null), "fix: a bug");
  assert.deepEqual(gitArgs(calls), ["write-tree", "add -A", "commit -m fix: a bug"]);
  assert.equal(calls[2].opts.timeout, 600000);
});

test("commit all: a refused commit puts back what was staged before", async () => {
  const { exec, calls } = fakeExec((_c, args) =>
    args[0] === "write-tree" ? { stdout: "tree1\n" } : args[0] === "commit" ? { code: 1, stderr: "ruff....Failed\n" } : {});
  await assert.rejects(commitAll(gitAt(exec, "/r", null), "wip"), /ruff\.\.\.\.Failed/);
  assert.deepEqual(gitArgs(calls), ["write-tree", "add -A", "commit -m wip", "read-tree tree1"]);
});

test("commit all: a timeout leaves the staging alone, since git may still finish", async () => {
  const { exec, calls } = fakeExec((_c, args) => {
    if (args[0] === "commit") throw new Error("timed out");
    return args[0] === "write-tree" ? { stdout: "tree1\n" } : {};
  });
  await assert.rejects(commitAll(gitAt(exec, "/r", null), "wip"), /timed out/);
  assert.ok(!gitArgs(calls).some((a) => a.startsWith("read-tree")));
});

test("commit all: with conflicts there is no tree to put back", async () => {
  const { exec, calls } = fakeExec((_c, args) =>
    args[0] === "write-tree" ? { code: 128, stderr: "error: unmerged files" } : args[0] === "commit" ? { code: 1, stderr: "nope" } : {});
  await assert.rejects(commitAll(gitAt(exec, "/r", null), "wip"), /nope/);
  assert.ok(!gitArgs(calls).some((a) => a.startsWith("read-tree")));
});

test("worktrees: changed files counted as the Changes tab counts them", async () => {
  const { exec } = fakeExec((_c, args) => {
    if (args.includes("worktree")) return { stdout: "worktree /r\nHEAD aaa\nbranch refs/heads/main\n" };
    if (args.includes("status")) {
      assert.ok(args.includes("--untracked-files=all") && args.includes("-z"));
      return { stdout: "?? dir/a\0?? dir/b\0 M c\0" };
    }
    return { stdout: "1\t0\n" };
  });
  const [w] = await readWorktrees(gitAt(exec, "/r", null), (p) => gitAt(exec, p, null));
  assert.equal(w.dirty, 3);
  assert.deepEqual([w.ahead, w.behind], [1, 0]);
});

const ref = (...f) => f.join("\x1f");
const REFS = [
  ref("refs/heads/develop", "origin/develop", "", "300", ""),
  ref("refs/heads/master", "origin/master", "behind 3", "200", ""),
  ref("refs/heads/feature/login", "", "", "250", ""),
  ref("refs/heads/old", "origin/old", "gone", "100", ""),
  ref("refs/remotes/origin/HEAD", "", "", "300", "refs/remotes/origin/develop"),
  ref("refs/remotes/origin/develop", "", "", "300", ""),
  ref("refs/remotes/origin/master", "", "", "210", ""),
  ref("refs/remotes/origin/fix-x", "", "", "400", ""),
  ref("refs/remotes/origin", "", "", "1", ""),
].join("\n") + "\n";

test("branches: local first then remote, newest first; origin/HEAD dropped; ahead, behind and gone read", () => {
  const list = parseBranches(REFS);
  assert.deepEqual(list.map((b) => b.name), ["develop", "feature/login", "master", "old", "origin/fix-x", "origin/develop", "origin/master"]);
  const master = list.find((b) => b.name === "master");
  assert.deepEqual([master.remote, master.upstream, master.ahead, master.behind, master.gone], [false, "origin/master", 0, 3, false]);
  assert.equal(list.find((b) => b.name === "old").gone, true);
  assert.equal(list.find((b) => b.name === "origin/fix-x").remote, true);
});

test("branch rows: here first, then other folders and branches, then remote ones nobody tracks", () => {
  const trees = [
    { path: "C:/r", branch: "develop", main: true, head: "a", dirty: 2 },
    { path: "C:/wt/login", branch: "feature/login", main: false, head: "b", dirty: 0, locked: null },
    { path: "C:/wt/probe", branch: null, main: false, head: "c1234567890", dirty: 0 },
  ];
  const { rows, create } = branchRows(parseBranches(REFS), trees, { root: "c:\\r", caseless: true });
  assert.deepEqual(rows.map((r) => [r.name, r.kind]), [
    ["develop", "here"], ["feature/login", "folder"], ["master", "local"], ["old", "local"], ["detached c123456", "folder"], ["origin/fix-x", "remote"],
  ]);
  assert.equal(rows[0].dirty, 2);
  assert.equal(rows[1].path, "C:/wt/login");
  assert.equal(create, null);
});

test("branch rows: the filter narrows them and offers a new branch by a name not taken", () => {
  const branches = parseBranches(REFS), trees = [{ path: "/r", branch: "develop", main: true, head: "a" }];
  const found = branchRows(branches, trees, { root: "/r", caseless: false, filter: "MAS" });
  assert.deepEqual(found.rows.map((r) => r.name), ["master"]);
  assert.equal(found.create, "MAS");
  assert.equal(branchRows(branches, trees, { root: "/r", caseless: false, filter: "master" }).create, null, "taken");
  assert.equal(branchRows(branches, trees, { root: "/r", caseless: false, filter: "two words" }).create, null, "not a branch name");
  assert.equal(branchRows(branches, trees, { root: "/r", caseless: false, filter: "  " }).create, null);
});

test("switch: a local branch, a remote one tracked, a new one", async () => {
  const { exec, calls } = fakeExec();
  const git = gitAt(exec, "/r", null);
  await switchTo(git, { name: "master" });
  await switchTo(git, { name: "origin/fix-x", remote: true });
  await switchTo(git, { name: "spike", create: true });
  assert.deepEqual(gitArgs(calls), ["switch master", "switch --track origin/fix-x", "switch -c spike"]);
});

test("switch: refused for uncommitted changes says so, so the panel can offer a stash", async () => {
  const stderr = "error: Your local changes to the following files would be overwritten by checkout:\n\ta.js\nPlease commit your changes or stash them before you switch branches.\nAborting\n";
  const { exec } = fakeExec(() => ({ code: 1, stderr }));
  const e = await switchTo(gitAt(exec, "/r", null), { name: "master" }).catch((e) => e);
  assert.equal(e.blocked, true);
  assert.equal(e.message, "uncommitted changes to a.js would be overwritten");
  const other = await switchTo(gitAt(fakeExec(() => ({ code: 128, stderr: "fatal: invalid reference: nope\n" })).exec, "/r", null), { name: "nope" }).catch((e) => e);
  assert.equal(other.blocked, false);
});

test("stash and switch: stashes new files too, and names the stash", async () => {
  const { exec, calls } = fakeExec((_c, args) => (args[0] === "stash" ? { stdout: "Saved working directory and index state On develop: herdr\n" } : {}));
  const label = await stashAndSwitch(gitAt(exec, "/r", null), { name: "master" }, "develop");
  assert.equal(label, "herdr: switching from develop to master");
  assert.deepEqual(gitArgs(calls), ["stash push --include-untracked -m herdr: switching from develop to master", "switch master"]);
});

test("stash and switch: a failed switch brings the changes back", async () => {
  const { exec, calls } = fakeExec((_c, args) => (args[0] === "switch" ? { code: 128, stderr: "fatal: nope\n" } : { stdout: "Saved\n" }));
  await assert.rejects(stashAndSwitch(gitAt(exec, "/r", null), { name: "master" }, "develop"), /nope/);
  assert.deepEqual(gitArgs(calls).at(-1), "stash pop");
});

test("stash and switch: with nothing stashed, a failed switch pops nothing (an older stash would come back)", async () => {
  const { exec, calls } = fakeExec((_c, args) => (args[0] === "switch" ? { code: 128, stderr: "fatal: nope\n" } : { stdout: "No local changes to save\n" }));
  await assert.rejects(stashAndSwitch(gitAt(exec, "/r", null), { name: "master" }, "develop"), /nope/);
  assert.ok(!gitArgs(calls).includes("stash pop"));
});
