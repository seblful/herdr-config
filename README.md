# herdr-config

My [Herdr](https://herdr.dev) app setup: the mods, layouts and keys I changed, kept in Git so
every machine gets the same window. `scripts/herdr.mjs` copies them between this repo and the
live Herdr home (`~/.config/herdr-app`, or `HERDR_APP_HOME`).

## What's in it

| Path | What it is |
|:--|:--|
| `home/layouts/main-fp.json` | The layout: Herdr's `main` with my Files and Git panels |
| `home/mods/tabs-fp/` | Tab bar; the Changes button is called Git and shows how many files are uncommitted. Dividers separate the tabs and `+`, the panel buttons, and the window buttons |
| `home/mods/files-fp/` | Files panel: edit text files, also in spaces on other machines (ctrl-s saves; Markdown has Edit/Preview), Markdown, Mermaid and image preview, Show in Explorer; files changed in Git, and the folders holding them, are coloured by status |
| `home/mods/changes-fp/` | Git panel. On top, the branch with ↑/↓ against its upstream and Fetch, Pull (fast-forward only) and Push or Publish; click the branch for every branch and where it is checked out: switch this folder to one (uncommitted changes in the way can be stashed first), find or create one by typing, go to a branch's own worktree, or make, open and remove worktrees with Herdr's dialog. Below, Changes and History tabs, with the latest commits under a clean tree; Commit all commits every listed file and, when a hook refuses the commit, puts back what was staged before. ↻ reads the folder again; a read that fails says so, and one that hangs is dropped after a minute. `git.js` runs git, `parse.js` reads its output, `ui.js` draws, `main.js` holds the state |
| `home/mods/file-preview/` | [bborrero14/herdr-file-preview](https://github.com/bborrero14/herdr-file-preview) (MIT), fitted to Windows. The others use its Mermaid renderer (`.pele/`) and its enlarged view |
| `home/keys.json` | Keyboard shortcuts |
| `scripts/` | The sync tool, Node only, no dependencies |
| `test/` | Tests for the mods' code that runs without Herdr: `npm test` |

`home/` mirrors the Herdr home. Anything under it is deployed to the same place.

## New machine

Needs Herdr (opened once), Node.js 20+, Git. On Windows also Git for Windows: the mods run
commands through its `sh.exe`.

```sh
git clone <this repo> herdr-config
cd herdr-config
npm run deploy
herdr-app do layout.switch '{"name":"main-fp"}'
```

`deploy` copies the files, runs `npm ci` for mods that need packages (the Mermaid renderer),
and runs `herdr-app check` on each mod. If it replaces files the machine already had (its own
`keys.json`, say), it backs them up in `.backups/` first.

## Everyday use

| You did | Run |
|:--|:--|
| Changed something in the app, or Claude changed a mod | `npm run capture`, then commit and push |
| Pulled changes on another machine | `npm run deploy` |
| Not sure which side changed | `npm run status` |
| Changed a mod's parsing | `npm test` |

`status` lists every file that differs and which side is newer. It also lists mods, layouts and
themes you have that the repo doesn't track yet.

## Adding something

```sh
npm run add -- mods/my-mod                 # a mod folder
npm run add -- layouts/my-layout.json      # a layout
npm run add -- themes/my-theme.json settings.json
```

`add` copies it from the Herdr home into `home/`, and from then on `capture` and `deploy` include
it. It tracks whole units: a mod folder, a layout file, a root file. To stop tracking one,
`git rm -r` it from `home/`.

## Never tracked

- Files Herdr writes for itself: `shared.json`, `data/`, `installed.json`, `window.json`,
  `view.json`, `telemetry/`, `AGENTS.md`, the `.d.ts` files. `add` refuses them.
- Inside mod folders: `.cache/`, `node_modules/`, and `jsconfig.json` and `gpui-kit.d.ts` (Herdr
  writes these). npm packages are built per platform, so every machine installs its own.

The rules are in `scripts/lib/rules.mjs`.

## Options

- `--dry-run` on `deploy`, `capture` and `add`: show what would happen, change nothing.
- `deploy --prune` also deletes files in tracked mods that the repo no longer has. Without it,
  `deploy` only lists them.
- `capture` deletes files from `home/` that are gone from a tracked mod. Git keeps the history.

## Platforms

Built and tested on Windows. The Windows-only parts fall back on their own: plain `sh` instead
of Git's, `node` from the PATH, `open -R` or `xdg-open` instead of Explorer. They haven't
been tried on macOS or Linux.
