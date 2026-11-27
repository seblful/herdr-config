// fp: saving a file on another machine. writeTextFile writes only on this one, so the text goes to a
// file in .cache and herdr-core sends it with `hc file write --on`: swapped in whole, mode kept,
// symlinks followed. No herdr import, so the tests run it under Node.

// $1 machine, $2 path there, $3 the local file holding the text. Git's sh would turn "/home/x" into
// "C:/Program Files/Git/home/x" when it starts hc.exe; MSYS_NO_PATHCONV keeps it as written.
export const WRITE = 'MSYS_NO_PATHCONV=1 exec hc file write --on "$1" -- "$2" < "$3"';

let seq = 0;

/**
 * Write text to path on machine `on` if it still holds expected (null: whatever it holds now).
 * The check is a read just before the write, not one step with it as writeTextFile does here.
 * Args:
 *   io: { exec, read(path, on), fs (writeFile, unlink, mkdir), shell, cache (a folder here, ending in /) }.
 */
export async function writeRemote(io, on, path, text, expected) {
  if (expected !== null) {
    const now = await io.read(path, on);
    if (now !== expected) throw new Error("The file changed on disk");
  }
  await io.fs.mkdir(io.cache, { recursive: true });
  const local = `${io.cache}save-${Date.now()}-${seq++}.txt`;
  await io.fs.writeFile(local, text);
  try {
    const r = await io.exec(io.shell, ["-c", WRITE, "files", on, path, local], { timeout: 60000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `hc exited with ${r.code}`);
  } finally {
    await io.fs.unlink(local).catch(() => {});
  }
}
