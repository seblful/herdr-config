// Windows fit (not upstream): Herdr's exec has a minimal PATH without Git's sh, so local commands
// use Git for Windows' bin/sh.exe, which sets up its own PATH. Remote machines keep plain sh.
import { window } from "herdr";

const GIT_SH = "C:/Program Files/Git/bin/sh.exe";

export const sh = (on) => (!on && window()?.platform === "windows" ? GIT_SH : "sh");
