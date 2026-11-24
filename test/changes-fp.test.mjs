// Tests for the Git panel's parsing (home/mods/changes-fp/parse.js), which runs without Herdr.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseStatus, parseNumstat, parseNameStatus, parseLog, parseCounts, parseWorktrees, refLabel,
  gitError, syncArgs, diffRows, diffView, hunks, clip, countLines, untab, ago, plural, inside, samePath,
} from "../home/mods/changes-fp/parse.js";

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
