// Drawing the Git panel. Each function draws from what it's given and keeps no state; the panel owns that.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { ago, plural, refLabel } from "./parse.js";

export const ROW = 28;        // a file or commit row
export const TREE_ROW = 44;   // a worktree row: branch, then its path
const STATUS = { A: "ansi2", D: "ansi1", U: "ansi1", M: "blocked" };

// The diff was laid out for 11px text: 20px rows, 7px characters.
const rowHeight = (size) => Math.ceil(size * 1.8);
const charWidth = (size) => size * 0.64;
const gutter = (size, chars) => Math.ceil(chars * charWidth(size)) + 2;

const small = (text, color) => div().flex_none().text_size(11).text_color(color).child(text);
const badge = (text, color, t) => div().flex_none().px(5).rounded(4).border_1().border_color(t.border).text_size(10).text_color(color).child(text);

/** Lines added and removed, each left out when zero. */
const delta = (add, del, t) => [add > 0 && small(`+${add}`, t.ansi2), del > 0 && small(`−${del}`, t.ansi1)].filter(Boolean);

/** Fill box with a scrolling list, or the empty message when there are no rows. */
function scrolling(box, id, rows, empty, t) {
  return box.relative()
    .child(v_flex().id(id).absolute().inset_0().overflow_y_scroll().p(6).children(rows)
      .when(Boolean(empty), (e) => e.child(div().p(8).text_color(t.dim).child(empty))))
    .child(Scrollbar.vertical(id).absolute().inset_0());
}

/** The branch, its distance from the upstream, and the Fetch, Pull and Push it allows. */
export function branchBar(b, { menu, syncing }, t, on) {
  const name = b.branch ?? (b.headSha ? `detached ${b.headSha.slice(0, 7)}` : "no commits");
  const publishable = Boolean(b.branch && b.remote && b.headSha);
  const action = (op, label, tip) => div().id(`sync-${op}`).h(24).px(8).flex().flex_none().items_center().rounded(6).border_1().border_color(t.border).text_size(12)
    .text_color(syncing ? t.dim : t.foreground).when(!syncing, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover))).tooltip(tip)
    .on_click((_e, cx) => on.sync(op, cx)).child(syncing === op ? `${label}ing…` : label);
  return h_flex().h(38).flex_none().px(8).gap(6).items_center().border_b(1).border_color(t.border)
    .child(h_flex().id("branch").min_w(72).h(26).px(6).gap(6).items_center().rounded(6).cursor_pointer().when(menu, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .tooltip(b.upstream ? `Tracks ${b.upstream}. Click for worktrees` : "Click for worktrees").on_click((_e, cx) => on.toggle(cx))
      .child(svg("mods/changes-fp/branch.svg").size(14).flex_none().text_color(t.muted))
      .child(div().min_w(0).truncate().font_semibold().child(name))
      .child(svg(`mods/changes-fp/chevron-${menu ? "up" : "down"}.svg`).size(12).flex_none().text_color(t.dim)))
    .when(b.ahead > 0, (e) => e.child(small(`↑${b.ahead}`, t.ansi3)))
    .when(b.behind > 0, (e) => e.child(small(`↓${b.behind}`, t.ansi4)))
    .child(div().flex_1())
    .when(Boolean(b.remote), (e) => e.child(action("fetch", "Fetch", `Fetch from ${b.upstream?.split("/")[0] ?? b.remote}`)))
    .when(Boolean(b.upstream) && b.behind > 0, (e) => e.child(action("pull", "Pull", `Fast-forward ${plural(b.behind, "commit")} from ${b.upstream}; never merges`)))
    .when(publishable && (!b.upstream || b.ahead > 0), (e) => e.child(b.upstream
      ? action("push", "Push", `Push ${plural(b.ahead, "commit")} to ${b.upstream}`)
      : action("push", "Publish", `Publish ${b.branch} to ${b.remote}`)));
}

/** The repository's checkouts under the branch bar: open one as a space, remove one, or make a new one. */
export function worktreeList(trees, empty, t, on) {
  const rows = trees.map((w, i) => h_flex().id(`tree-${i}`).h(TREE_ROW).flex_none().pl(8).pr(4).gap(4).items_center().rounded(7)
    .when(w.here, (e) => e.bg(t.selected)).when(!w.here, (e) => e.hover((s) => s.bg(t.hover)))
    .child(v_flex().id(`tree-open-${i}`).flex_1().min_w(0).h_full().justify_center().cursor_pointer().on_click((_e, cx) => on.open(w, cx))
      .child(h_flex().gap(6).items_center()
        .child(div().min_w(0).truncate().when(w.here, (e) => e.font_semibold()).child(w.branch ?? `detached ${w.head.slice(0, 7)}`))
        .when(w.main, (e) => e.child(badge("main", t.dim, t)))
        .when(Boolean(w.locked), (e) => e.child(badge("locked", t.blocked, t)))
        .child(div().flex_1())
        .when(w.dirty > 0, (e) => e.child(small(`${w.dirty} changed`, t.blocked)))
        .when(w.ahead > 0, (e) => e.child(small(`↑${w.ahead}`, t.ansi3)))
        .when(w.behind > 0, (e) => e.child(small(`↓${w.behind}`, t.ansi4)))
        .when(w.here, (e) => e.child(small("here", t.accent)))
        .when(w.open, (e) => e.child(small("open", t.accent))))
      .child(div().truncate().text_size(11).text_color(t.dim).child(w.shown)))
    .when(!w.main, (e) => e.child(div().id(`tree-remove-${i}`).size(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer().text_color(t.dim)
      .tooltip("Remove this worktree").hover((s) => s.bg(t.raised)).on_click(() => on.remove(w)).child("×"))));
  return v_flex().flex_none().border_b(1).border_color(t.border)
    .child(div().px(14).pt(8).text_size(11).text_color(t.dim).child("Worktrees"))
    .child(scrolling(div().h(Math.min(Math.max(rows.length, 1), 5) * TREE_ROW + 12).flex_none(), "tree-list", rows, empty, t))
    .child(div().id("new-worktree").h(30).mx(6).mb(6).px(8).flex().items_center().rounded(7).cursor_pointer().text_size(12).text_color(t.accent)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => on.create(cx)).child("+ New worktree"));
}

/** Changes and History, and a summary of the files the open tab shows. */
export function tabBar(mode, files, t, onMode) {
  const tab = (id, label) => div().id(`changes-tab-${id}`).px(8).py(3).rounded(6).cursor_pointer().text_color(mode === id ? t.foreground : t.muted)
    .when(mode === id, (e) => e.bg(t.selected).font_semibold()).hover((s) => s.bg(t.hover)).on_click((_e, cx) => onMode(id, cx)).child(label);
  const add = files.reduce((n, f) => n + (f.add ?? 0), 0), del = files.reduce((n, f) => n + (f.del ?? 0), 0);
  return h_flex().h(36).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border)
    .child(tab("changes", "Changes")).child(tab("history", "History"))
    .child(div().flex_1())
    .when(files.length > 0, (e) => e.child(h_flex().gap(6).items_center().child(small(plural(files.length, "file"), t.muted)).children(delta(add, del, t))));
}

/** A changed file: its status letter, folder, name, and lines added and removed. */
export function fileRow(f, selected, onPick, t, id) {
  const parts = f.path.split("/"), name = parts.pop();
  return h_flex().id(id).h(ROW).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(selected, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => onPick(cx))
    .child(div().w(14).text_size(11).text_color(t[STATUS[f.status] ?? "blocked"]).child(f.status))
    .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
    .children(delta(f.add, f.del, t));
}

/** A list of rows that grows with them, up to the space the diff leaves it. */
export const listBox = (id, rows, count, empty, t) =>
  scrolling(div().flex_1().min_h(44).max_h(count * ROW + 12).border_b(1).border_color(t.border), id, rows, empty, t);

/** History: one row per commit, ↑ on those not pushed, and Load more at the end. */
export function commitRows(commits, { unpushed, more, loading, mono }, t, on) {
  const rows = commits.map((c) => {
    const up = unpushed.has(c.sha), ref = refLabel(c.refs);
    return h_flex().id(`commit-${c.sha}`).h(ROW).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => on.open(c, cx))
      .child(div().w(58).flex_none().font_family(mono).text_size(11).text_color(up ? t.ansi3 : t.dim).child((up ? "↑" : " ") + c.short.slice(0, 7)))
      .child(div().flex_1().min_w(0).truncate().child(c.subject))
      .when(Boolean(ref), (e) => e.child(div().max_w(110).flex_none().truncate().px(5).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.accent).child(ref)))
      .child(small(ago(c.at), t.dim));
  });
  if (more) rows.push(h_flex().id("commits-more").h(ROW).flex_none().px(8).items_center().justify_center().rounded(7).cursor_pointer().text_size(12).text_color(t.accent)
    .hover((s) => s.bg(t.hover)).on_click((_e, cx) => on.more(cx)).child(loading ? "Loading…" : "Load more"));
  return rows;
}

/** An open commit: back, its subject, id, author and date, then the files it changed. */
export function commitDetail(c, files, openPath, mono, t, on) {
  return [
    h_flex().id("commit-back").h(ROW).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => on.back(cx))
      .child(div().w(14).flex_none().text_color(t.muted).child("←")).child(div().flex_1().min_w(0).truncate().font_semibold().child(c.subject || c.short)),
    h_flex().h(24).flex_none().px(8).gap(8).items_center().text_size(11).text_color(t.dim)
      .child(div().w(14).flex_none()).child(div().flex_none().font_family(mono).child(c.short))
      .child(div().flex_1().min_w(0).truncate().child(`${c.author} · ${new Date(c.at * 1000).toLocaleString()}`)),
    ...files.map((f) => fileRow(f, openPath === f.path, (cx) => on.file(f.path, cx), t, `cfile-${f.path}`)),
  ];
}

function diffRow({ kind, number, text }, t, size, chars) {
  const height = rowHeight(size);
  if (kind === "@") return div().w_full().px(12).h(height).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
  return h_flex().w_full().h(height).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
    .child(div().w(gutter(size, chars)).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
    .child(div().flex_1().min_w(0).truncate().child(text));
}

/** A diff that scrolls both ways and draws only the rows on screen, with a hint over it when nothing is open. */
export function diffPane(id, view, hint, { size, mono }, t) {
  const width = Math.max(300, view.longest * charWidth(size) + gutter(size, view.gutterChars) + 20);
  return div().flex_1().min_h(0).relative().font_family(mono).text_size(size)
    .child(div().id(`${id}-x`).size_full().overflow_x_scrollbar()
      .child(div().w_full().min_w(width).h_full().child(v_virtual_list(id, view.rows.length, rowHeight(size), (i) => String(i),
        (range) => view.rows.slice(range.start, range.end).map((row) => diffRow(row, t, size, view.gutterChars))).size_full())))
    .child(Scrollbar.vertical(id).viewport_from_layout().absolute().inset_0())
    .when(Boolean(hint), (e) => e.child(div().absolute().top(6).px(12).text_size(11).text_color(t.dim).child(hint)));
}

/** The commit message and Commit all, which stages every listed file first. */
export function commitBox(input, { typing, count, ready, busy }, t, onCommit) {
  return h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
    .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(typing ? t.accent : t.border).cursor_text()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(input).h_full().text_size(12).text_color(t.foreground)))
    .child(div().id("commit").h(32).px(14).flex().flex_none().items_center().rounded(8).bg(ready ? t.solid : t.raised).text_color(ready ? t.solid_foreground : t.dim).text_size(12)
      .tooltip("Stages every file in the list (git add -A), then commits").when(ready, (e) => e.cursor_pointer()).on_click((_e, cx) => onCommit(cx))
      .child(busy ? "Committing…" : count ? `Commit all · ${count}` : "Commit"));
}
