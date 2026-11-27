// Tests for saving on another machine (home/mods/files-fp/remote.js), run through a real sh and a fake hc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { writeRemote } from "../home/mods/files-fp/remote.js";

const SHELL = process.platform === "win32" ? "C:/Program Files/Git/bin/sh.exe" : "sh";
// The fake hc keeps its arguments, one per line, and what it read, then answers as $FAKE_HC says.
const FAKE = '#!/bin/sh\nprintf "%s\\n" "$@" > "$OUT.args"\ncat > "$OUT.in"\n[ "$FAKE_HC" = fail ] && { echo "machine_unknown" >&2; exit 1; }\necho "{}"\n';

async function setup(mode = "ok") {
  const dir = await fs.mkdtemp(join(tmpdir(), "files-fp-"));
  await fs.mkdir(join(dir, "bin"));
  await fs.writeFile(join(dir, "bin", "hc"), FAKE, { mode: 0o755 });
  const env = { ...process.env, PATH: join(dir, "bin") + delimiter + process.env.PATH, OUT: join(dir, "hc").replace(/\\/g, "/"), FAKE_HC: mode };
  const reads = [];
  const io = {
    exec: (cmd, args) => new Promise((resolve) => execFile(cmd, args, { env }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }))),
    read: async (path, on) => { reads.push([path, on]); return "old\n"; },
    fs,
    shell: SHELL,
    cache: join(dir, "cache").replace(/\\/g, "/") + "/",
  };
  return { dir, io, reads, out: join(dir, "hc") };
}

test("remote save: hands hc the machine, the path as written and the exact text", async () => {
  const { dir, io, reads, out } = await setup();
  const path = "/home/u/it's a \"$HOME\" file.md", text = "héllo ✓\r\nline 2\n";
  await writeRemote(io, "vps", path, text, "old\n");
  assert.deepEqual(reads, [[path, "vps"]]);
  assert.deepEqual((await fs.readFile(out + ".args", "utf8")).split("\n").slice(0, -1), ["file", "write", "--on", "vps", "--", path]);
  assert.deepEqual(await fs.readFile(out + ".in"), Buffer.from(text, "utf8"));
  assert.deepEqual(await fs.readdir(io.cache), [], "the local copy is removed");
  await fs.rm(dir, { recursive: true });
});

test("remote save: a file changed since it was opened is left alone", async () => {
  const { dir, io, out } = await setup();
  await assert.rejects(writeRemote(io, "vps", "/x.txt", "mine", "what I opened\n"), /changed on disk/);
  await assert.rejects(fs.access(out + ".args"), "hc never ran");
  await fs.rm(dir, { recursive: true });
});

test("remote save: overwriting (expected null) skips the check", async () => {
  const { dir, io, reads } = await setup();
  await writeRemote(io, "vps", "/x.txt", "mine", null);
  assert.deepEqual(reads, []);
  await fs.rm(dir, { recursive: true });
});

test("remote save: hc's error comes back and the local copy is removed", async () => {
  const { dir, io } = await setup("fail");
  await assert.rejects(writeRemote(io, "gone", "/x.txt", "mine", "old\n"), /machine_unknown/);
  assert.deepEqual(await fs.readdir(io.cache), []);
  await fs.rm(dir, { recursive: true });
});
