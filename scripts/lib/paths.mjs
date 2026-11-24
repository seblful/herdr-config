// Where things live: this repo, its mirror of the Herdr home, and the live Herdr home.
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repo's root folder. */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The repo's copy of the Herdr home: everything under it is tracked and deployed. */
export const SOURCE = join(REPO, "home");

/** The live Herdr home on this machine (HERDR_APP_HOME picks another, as for herdr-app). */
export const HERDR_HOME = process.env.HERDR_APP_HOME
  ? resolve(process.env.HERDR_APP_HOME)
  : join(homedir(), ".config", "herdr-app");

/** Files that deploy or capture replace or delete are kept here first (git-ignored). */
export const BACKUPS = join(REPO, ".backups");
