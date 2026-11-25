// Agenttrail Map drawn natively in Herdr. Docks as a side panel, expands to a
// full view, and follows the repo of the focused terminal. See graph.js for the layout,
// ported from the page. This fork also acts: a card, task or session can send its agent a
// prompt (after a confirm naming the terminal), cards can be dragged, and "+ Flujo" adds a
// task to PLAN.md. See act.js.

import { View, div, svg, image, PathBuilder } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { agents, appHome, exec, focused, home, layout, nextCommand, panes, props, readTextFile, run, settings, setShared, shared, spaces, writeTextFile } from "herdr";
import * as fs from "fs/promises";
import { Feed, POLL_MS, PORT_BASE, focusFolder, repoName } from "./feed.js";
import { addTask, agentFor, agentForRun, looksLikeDialog, moveLayout, ownerOf, promptFor, readOffsets, readPicks } from "./act.js";
import { REGION_HEAD, REGION_X, REGION_Y, ago, boardEdges, boardLayout, cardAgents, cardAge, cardCommits, cardLine, hostOf, inferredNote, kids, liveCard, openingCard, statusLabel, taskDetails, taskIsOpen, touched } from "./graph.js";

const MOD = "agenttrail";
const ASSET = `mods/${MOD}`;
const TAB = "Map"; // the expanded tab's name, how a docked copy finds it again
const VIEW = `${MOD}.view`; // shared: the view handed between the panel and its tab
const FOLDER = `${MOD}.folder`; // shared: the last terminal folder, for a copy that has focus itself
const START_COMMAND = ["npx", "-y", "agenttrail@0.4.1"]; // this release: updating the mod updates the Map it starts
const START_WAIT_MS = 60000; // a first npx download takes a while; past this, offer the button again
const NARROW = 560; // below this the whole graph is unreadable, so open on one card
const SIDE_DOCK = 1040; // below this a run dock at the top right would sit on a centred card
const AWAY_H = 30; // the strip saying a Map was picked by hand
const SANS = "Geist";
const MONO = "Geist Mono";
const DOT = 24; // Map's background dots: fixed to the screen, they neither pan nor zoom
const MAX_ZOOM = 1.8;
// Herdr kills a render at 50 ms and never calls it again, so a slow frame must shed
// detail rather than finish. Past this, task rows stop being drawn for that frame.
const RENDER_BUDGET_MS = 28;
const UNFOLD_AT = 1.05, FOLD_AT = 0.85; // zooming in opens every card, as on the page
const PICKS = `${MOD}.picks`; // localStorage: by: names matched to a terminal by hand
const LAYOUT = `${MOD}.layout.`; // localStorage, per repo: cards moved by hand
const PANEL_W = 360;
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* a view without storage still works */ } },
};

// Map's own tokens (public/index.html :root), so the two read as one product.
const DARK = { bg: "#000000", surface: "#181818", raised: "#1f1f1f", hover: "#272727", line: "#313131", text: "#ffffff", soft: "#d1d1d1", dim: "#9b9b9b", faint: "#686868", accent: "#e9a23b", danger: "#db6b67", success: "#7aa36a", done: "#3f7f57", completeText: "#70a784", completeBg: "#3f7f572e", region: "#18181880", overlay: "#181818", card: "#181818", cardLive: "#2f271c", cardHover: "#1f1f1f", human: "#5fb8c9", knowledge: "#a189e0", dot: "#31313159", openai: "#e8e8ea" };
const LIGHT = { ...DARK, bg: "#ffffff", surface: "#f9f8f7", raised: "#f3f2f0", hover: "#eeecea", line: "#00000024", text: "#000000", soft: "#000000c7", dim: "#666666", faint: "#0000007a", accent: "#955f12", success: "#3f7f57", region: "#f9f8f780", overlay: "#ffffff", card: "#ffffff", cardLive: "#fdf5e9", cardHover: "#f9f8f7", dot: "#00000018", openai: "#111111" };
const AGENT = { claude: "#d97757", cursor: "#5b7fd6", human: "#8b8b93", k: "#8b8b93" };
const MARK = { claude: "claude", codex: "codex", chatgpt: "codex", openai: "codex" };
const SOURCE = { hook: "hooks", "claude-log": "local log", "codex-log": "local log", "hook+claude-log": "hooks + log" };

const own = (table, key) => (Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined); // a name from Map is never a built-in key
const lit = () => settings()?.dark === false;
const shortPath = (p) => { const h = home(); return h && p?.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p ?? ""; };
const hasCards = (b) => Boolean(b?.plan.some((n) => n.level === "component"));
const inferred = (b) => Boolean(b?.derived && hasCards(b));
const gitRoot = async (cwd) => {
  const git = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
  return git.code === 0 ? git.stdout.trim() : null;
};
const agentColor = (c, name) => {
  const k = String(name).toLowerCase();
  if (["codex", "chatgpt", "openai"].includes(k)) return c.openai;
  return own(AGENT, k) ?? c.dim;
};

export default class AgenttrailMap extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.debug = Boolean(p.debug);
    this.expanded = Boolean(p.expanded);
    this.from = p.from ?? null; // the tab an expanded copy goes back to
    this.uid = Math.random().toString(36).slice(2, 7);
    this.size = null;
    this.zoom = 1;
    this.minZoom = 0.06;
    this.pan = { x: 0, y: 0 };
    this.placed = false;
    this.auto = true; // no one has moved this view yet, so a narrow one follows live work
    this.pending = null;
    this.seenView = this.expanded ? null : shared(VIEW)?.seq ?? null; // a new tab takes the view that opened it
    this.unfolded = false;
    this.ui = { open: new Set(), closed: new Set(), openTasks: new Set(), closedTasks: new Set() };
    this.press = null;
    this.drag = null; // a card being moved: { id, x, y, dx, dy, moved }
    this.offsets = {};
    this.layoutKey = null;
    this.moves = 0; // bumps when a card moves, so connectors are rebuilt
    this.sel = null; // { kind: "node", id } or { kind: "run", run }
    this.act = { mode: null, confirm: null, note: null, busy: false };
    this.flow = null; // "+ Flujo": { comp } while the form is open
    this.picks = readPicks(store.get(PICKS));
    this.promptIn = InputState.new({ value: "" });
    this.flowIn = InputState.new({ value: "" });
    this.flowIn.on("submit", (_e, cx) => { this.addFlow(cx); });
    this.stats = { renders: 0, totalMs: 0, maxMs: 0, moves: 0, wheels: 0, worstNarrow: 0, worstFull: 0 };
    this.command = Array.isArray(p.command) && p.command.length && p.command.every((a) => typeof a === "string") ? p.command : START_COMMAND;
    this.starting = new Set();
    this.feed = new Feed({ fetch: (url) => fetch(url), sleep: (ms) => this.sleep(ms), root: gitRoot, folder: () => this.here(), base: p.portBase ?? PORT_BASE, port: p.port ?? null, eager: () => this.starting.size > 0 });
    cx.spawn(async (cx) => {
      this.sleep = (ms) => cx.sleep(ms);
      for (;;) {
        const changed = await this.feed.tick();
        if (this.feed.at && this.feed.at !== shared(FOLDER)) setShared(FOLDER, this.feed.at);
        if (changed) this.shown();
        // Ages ("13s") and the 60s live window move with the clock, so a board with
        // recent work redraws at the poll rate, not once a second as the page does.
        if (changed || this.isLive()) cx.notify();
        await Promise.race([cx.sleep(POLL_MS), new Promise((wake) => { this.wake = wake; })]);
      }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "zoom-in") this.nudge(1.18);
        else if (command === "zoom-out") this.nudge(0.85);
        else if (command === "fit") { this.auto = false; this.fit(); }
        else if (command === "live") this.goLive();
        else if (command === "flow") { if (this.feed.board) this.openFlow(this.feed.board); }
        else if (command === "stuck") {
          const b = this.feed.board, n = b?.plan.find((x) => x.level !== "component" && x.status === "blocked");
          if (n) this.select({ kind: "node", id: n.id }, b);
        }
        else if (command === "close-panel") this.closePanel();
        // Sent to every shown copy, so each acts only where the word applies to it.
        else if (command === "expand") { if (!this.isExpanded(this.host())) this.toggleSize(); }
        else if (command === "collapse") { if (this.isExpanded(this.host())) this.toggleSize(); }
        else continue;
        cx.notify();
      }
    });
    if (this.debug) cx.spawn(async (cx) => {
      for (;;) {
        await cx.sleep(500);
        await fs.writeFile(`${appHome()}/map-stats-${this.uid}.json`, JSON.stringify({ ...this.stats, state: this.feed.state, host: this.host(), auto: this.auto, centre: this.size && this.geo ? this.view() : null, zoom: this.zoom, pan: this.pan, size: this.size, at: Date.now() }));
      }
    });
  }

  // Render runs on every focus change, so this is the follow: no polling of Herdr's data.
  here() {
    return focusFolder(focused(), spaces(), shared(FOLDER) ?? null);
  }

  // A different Map is a different world: its cards start fresh, not at the last one's zoom.
  shown() {
    if (this.feed.port !== this.mapPort) {
      this.mapPort = this.feed.port;
      this.ui = { open: new Set(), closed: new Set(), openTasks: new Set(), closedTasks: new Set() };
      Object.assign(this, { unfolded: false, placed: false, auto: true, zoom: 1 });
    }
    this.reshape();
  }

  // Map outlives this view in a terminal of its own.
  startMap(repo, cx) {
    this.starting.add(repo);
    run("terminal.open", { argv: [...this.command, repo, "--no-open"], folder: repo, place: "tab", name: "Agenttrail Map" });
    this.wake?.();
    cx.notify();
    cx.spawn(async (cx) => {
      await cx.sleep(START_WAIT_MS);
      this.starting.delete(repo);
      cx.notify();
    });
  }

  isLive() {
    const b = this.feed.board;
    return Boolean(b && (Date.now() - (b.activity?.at ?? 0) < 120000 || b.plan.some((n) => n.level === "component" && n.touchedAt && Date.now() - n.touchedAt < 120000) || (b.runs ?? []).some((r) => !r.ended)));
  }

  // Everything that does not depend on pan: done again only when the board, an open
  // card or a zoom threshold changes, never on a drag.
  reshape() {
    const b = this.feed.board;
    this.geo = null;
    this.edgeCache = null;
    if (!hasCards(b)) return;
    const now = Date.now();
    this.loadOffsets();
    const L = moveLayout(boardLayout(b, this.ui, now), this.offsets);
    const width = REGION_X + L.width + 80, height = REGION_Y + L.height + REGION_HEAD + 80;
    this.minZoom = Math.max(0.06, Math.min(920 / width, 700 / height) * 0.75);
    this.geo = { L, ...boardEdges(b, L, now), region: { w: L.width, h: L.height + REGION_HEAD } };
    if (!this.placed) this.place();
    else if (this.auto && this.narrow()) { const id = liveCard(b, now); if (id) this.focusCard(id); }
  }

  // ---- where this copy lives, and moving between panel and full size.

  host() {
    const f = focused();
    return hostOf({ layout: layout(), props: props(), panes: panes(), tab: f?.tab, focusedPane: f?.pane, mod: MOD });
  }

  isExpanded(host) {
    return host.kind === "tab" || Boolean(host.zoomed);
  }

  // Everything another copy needs to show the same thing: the world point at the middle
  // of the stage, and the open cards, since those move what is below them.
  view() {
    const box = this.stage();
    return {
      zoom: this.zoom, x: (box.width / 2 - this.pan.x) / this.zoom, y: (box.height / 2 - this.pan.y) / this.zoom,
      auto: this.auto, unfolded: this.unfolded,
      open: [...this.ui.open], closed: [...this.ui.closed], openTasks: [...this.ui.openTasks], closedTasks: [...this.ui.closedTasks],
    };
  }

  applyView(v) {
    this.ui = { open: new Set(v.open), closed: new Set(v.closed), openTasks: new Set(v.openTasks), closedTasks: new Set(v.closedTasks) };
    this.unfolded = v.unfolded;
    this.auto = false; // reshape must not follow live work before this view lands
    this.reshape();
    const box = this.stage();
    this.zoom = Math.max(this.minZoom, Math.min(MAX_ZOOM, v.zoom));
    this.pan = { x: box.width / 2 - v.x * this.zoom, y: box.height / 2 - v.y * this.zoom };
    this.auto = v.auto;
  }

  sendView(to) {
    this.seenView = Date.now();
    setShared(VIEW, { ...this.view(), to, seq: this.seenView });
  }

  takeView() {
    const v = shared(VIEW);
    if (!v || v.seq === this.seenView) return;
    this.seenView = v.seq;
    if (v.to !== (this.expanded ? "tab" : "dock") || (!this.expanded && this.host().kind !== "block")) return;
    this.pending = v;
    this.placed = false;
    this.place();
  }

  toggleSize() {
    const host = this.host();
    if (host.kind === "pane") return run("pane.zoom", { pane: host.pane }); // same copy: the resize keeps the view
    if (host.kind === "lone") return null;
    const f = focused();
    if (host.kind === "tab") {
      this.sendView("dock");
      if (this.from && spaces().some((s) => s.tabs.some((t) => t.id === this.from))) run("tab.select", { id: this.from });
      return run("tab.close", { id: f.tab });
    }
    this.sendView("tab");
    const tabs = spaces().find((s) => s.id === f?.space)?.tabs ?? [];
    const open = tabs.find((t) => t.name === TAB && t.panes === 1 && panes().some((p) => p.tab === t.id && p.mod === MOD));
    if (open) return run("tab.select", { id: open.id });
    return run("tab.new", { name: TAB, mod: MOD, props: { ...props(), expanded: true, from: f?.tab ?? null } });
  }

  // ---- what the view shows.

  narrow() {
    return (this.size?.width ?? 0) < NARROW;
  }

  // First placement: a handed-over view, else the live card when narrow, else fit.
  place() {
    if (!this.geo || !this.size) return;
    this.placed = true;
    const b = this.feed.board;
    if (this.pending) {
      const v = this.pending;
      this.pending = null;
      this.applyView(v);
      return;
    }
    const id = this.narrow() ? openingCard(b, Date.now()) : null;
    if (id) this.focusCard(id);
    else this.fit();
  }

  // A card at a readable size: as wide as the panel allows, its top clear of the tools,
  // and centred in what the run dock leaves when there is room.
  focusCard(id) {
    const box = this.stage();
    this.zoom = Math.max(this.minZoom, Math.min(1, (box.width - 32) / 400));
    this.applyThresholds();
    const pos = this.geo.L.pos[id];
    if (!pos) return;
    const z = this.zoom;
    const free = box.height - (box.width < SIDE_DOCK && (this.feed.board.runs ?? []).length ? 120 : 0);
    const top = this.feed.board.derived ? 60 : Math.max(60, (free - pos.h * z) / 2); // a card from git heads a list, so the rest stay in view
    this.pan = { x: box.width / 2 - (REGION_X + pos.nodeX + pos.nodeW / 2) * z, y: top - (REGION_Y + REGION_HEAD + pos.nodeY) * z };
  }

  goLive() {
    const id = this.feed.board && liveCard(this.feed.board, Date.now());
    if (!id || !this.geo || !this.size) return;
    this.auto = true;
    this.focusCard(id);
  }

  nudge(factor) {
    this.auto = false;
    this.zoomBy(factor);
  }

  applyThresholds() {
    if (!this.unfolded && this.zoom >= UNFOLD_AT) {
      this.unfolded = true;
      for (const n of this.feed.board?.plan ?? []) if (n.level === "component") this.ui.open.add(n.id);
      this.reshape();
    } else if (this.unfolded && this.zoom <= FOLD_AT) {
      this.unfolded = false;
      this.ui.open.clear();
      this.reshape();
    }
  }

  fit() {
    if (!this.geo || !this.size) return;
    const { w, h } = this.geo.region;
    const box = this.stage();
    const margin = this.narrow() ? 32 : 128;
    const best = Math.min(1.2, (box.width - margin) / w, (box.height - margin) / h);
    if (this.narrow()) this.minZoom = Math.min(this.minZoom, best); // a panel can only fit by going under the page's floor
    this.zoom = Math.max(this.narrow() ? this.minZoom : 0.45, best);
    this.pan = { x: (box.width - w * this.zoom) / 2 - REGION_X * this.zoom, y: (box.height - h * this.zoom) / 2 - REGION_Y * this.zoom };
    this.applyThresholds();
  }

  stage() {
    return { width: this.size?.width ?? 0, height: Math.max(0, (this.size?.height ?? 0) - this.headH()) };
  }

  headH() {
    return (this.narrow() ? 44 : 64) + (this.feed.state.away ? AWAY_H : 0) + (inferred(this.feed.board) ? this.noteH() : 0);
  }

  noteH() {
    return this.narrow() ? 46 : AWAY_H; // two lines fit a panel, where the note will not go on one
  }

  // The stage changed under a view that is already placed: its middle stays its middle,
  // so a pane zooming in or out keeps the same card in view.
  resized(size) {
    const before = this.stage();
    this.size = size;
    if (!this.placed) return this.place();
    const after = this.stage();
    this.pan = { x: this.pan.x + (after.width - before.width) / 2, y: this.pan.y + (after.height - before.height) / 2 };
    if (this.auto && this.narrow() && this.feed.board) {
      const id = liveCard(this.feed.board, Date.now());
      if (id) this.focusCard(id);
    }
  }

  zoomBy(factor, origin) {
    const box = this.stage();
    const point = origin ?? { x: box.width / 2, y: box.height / 2 };
    const next = Math.max(this.minZoom, Math.min(MAX_ZOOM, this.zoom * factor));
    const wx = (point.x - this.pan.x) / this.zoom, wy = (point.y - this.pan.y) / this.zoom;
    this.pan = { x: point.x - wx * next, y: point.y - wy * next };
    this.zoom = next;
    this.applyThresholds();
  }

  toggle(p) {
    this.auto = false;
    const live = this.geo.L.pos[p.id].h > 128;
    if (live) { this.ui.open.delete(p.id); this.ui.closed.add(p.id); }
    else { this.ui.closed.delete(p.id); this.ui.open.add(p.id); }
    this.reshape();
  }

  // ---- connectors: real GPU paths, built at this zoom and only moved by a pan.

  stroke(c, e) {
    const z = this.zoom;
    const { x1, y1, ax, ay, bx, by, x2, y2 } = e.curve;
    const style = { need: [1.5, null, c.line], active: [1.5, [5, 8], c.accent], link: [1.5, [2, 7], c.faint + "cc"], handoff: [2.5, [9, 7], agentColor(c, e.agent ?? "")] }[e.kind];
    const [width, dash, color] = style;
    let path = PathBuilder.stroke(width);
    if (dash) path = path.dash_array(dash);
    path = path.move_to(x1 * z, y1 * z).cubic_bezier_to(x2 * z, y2 * z, ax * z, ay * z, bx * z, by * z).build();
    return { path, color };
  }

  edgeLayer(c) {
    const key = `${this.zoom}|${lit()}|${this.moves}`;
    if (this.edgeCache?.key !== key) {
      const z = this.zoom;
      const trails = this.geo.trails.map((t) => {
        let path = PathBuilder.stroke(2.5).dash_array([2.5, 5.5]);
        t.points.forEach(([x, y], i) => { path = i ? path.line_to(x * z, y * z) : path.move_to(x * z, y * z); });
        return { path: path.build(), color: agentColor(c, t.agent) + (t.ended ? "33" : "8c") };
      });
      const lines = this.geo.edges.map((e) => this.stroke(c, e));
      const heads = this.geo.edges.filter((e) => e.arrow).map((e) => {
        const { x2, y2 } = e.curve;
        const s = 7 * 1.5; // the page's marker: 7 units of a 1.5 stroke
        return PathBuilder.fill().add_polygon([[(x2 - s) * z, (y2 - s / 2) * z], [x2 * z, y2 * z], [(x2 - s) * z, (y2 + s / 2) * z]], true).build();
      });
      this.edgeCache = { key, paths: [...trails, ...lines, ...heads.map((path) => ({ path, color: c.line }))] };
    }
    const { w, h } = this.geo.region;
    const layer = (p) => window.paint_path(p.path, p.color).absolute().left(0).top(0).w(w * this.zoom + REGION_X * this.zoom).h(h * this.zoom + REGION_Y * this.zoom);
    return div().absolute().left(this.pan.x + REGION_X * this.zoom).top(this.pan.y + (REGION_Y + REGION_HEAD) * this.zoom).w(1).h(1).children(this.edgeCache.paths.map(layer));
  }

  grid(c) {
    const { width, height } = this.size;
    const key = `${width}x${height}|${lit()}`;
    if (this.gridCache?.key !== key) {
      let path = PathBuilder.stroke(2).dash_array([2, DOT - 2]);
      for (let y = 1; y < height; y += DOT) path = path.move_to(0, y).line_to(width, y);
      this.gridCache = { key, path: path.build() };
    }
    return window.paint_path(this.gridCache.path, c.dot).absolute().left(0).top(0).size_full();
  }

  // ---- cards: every length is a world length times the zoom, since a mod has no
  // transform to scale a group with.

  text(str, { x, y, size, color, mono = false, weight = 400, right = null }) {
    const z = this.zoom;
    const el = div().absolute().top((y - size * 0.975) * z).whitespace_nowrap().text_size(size * z).line_height(`${size * 1.25 * z}px`)
      .font_family(mono ? MONO : SANS).font_weight(weight).text_color(color).child(str);
    return right == null ? el.left(x * z) : el.right(right * z);
  }

  ring(size, x, y, color, width) {
    const z = this.zoom;
    return div().absolute().left((x - size / 2) * z).top((y - size / 2) * z).w(size * z).h(size * z).rounded(size * z).border(width * z).border_color(color);
  }

  statusIcon(c, p, w) {
    const z = this.zoom, x = w - 26, y = 26;
    const disc = (color) => div().absolute().left((x - 9) * z).top((y - 9) * z).w(18 * z).h(18 * z).rounded(18 * z).bg(color).flex().items_center().justify_center();
    const mark = (color) => disc(color).text_size(12 * z).font_weight(700).font_family(SANS).text_color(color === c.accent ? "#141414" : "#ffffff").child("!");
    if (p.kind === "human" && p.status !== "done") return [mark(c.accent)];
    if (p.status === "done") return [disc(c.done).child(svg(`${ASSET}/check.svg`).w(18 * z).h(18 * z).text_color("#ffffff"))];
    if (p.status === "active") return [this.ring(18, x, y, c.line, 2), svg(`${ASSET}/arc-status.svg`).absolute().left((x - 11) * z).top((y - 11) * z).w(22 * z).h(22 * z).text_color(c.accent).spin(1100)];
    if (p.status === "blocked") return [mark(c.danger)];
    return [this.ring(18, x, y, c.faint, 2)];
  }

  agentMark(c, name, x, y, size) {
    const z = this.zoom, key = own(MARK, String(name).toLowerCase());
    const box = (el) => el.absolute().left((x - size / 2) * z).top((y - size / 2) * z).w(size * z).h(size * z);
    if (key) return box(svg(`${ASSET}/agent-${key}.svg`)).text_color(agentColor(c, name));
    return box(div()).flex().items_center().justify_center().text_size(11 * z).font_weight(700).font_family(SANS).text_color(agentColor(c, name)).child(String(name)[0].toUpperCase());
  }

  // Its latest commits, for a card someone opened.
  gitDetail(c, p, pos, now) {
    const z = this.zoom;
    const x = this.pan.x + (REGION_X + pos.x) * z, y = this.pan.y + (REGION_Y + REGION_HEAD + pos.nodeY + pos.nodeH + 24) * z;
    const tail = (a) => h_flex().flex_none().gap(8 * z).items_center()
      .when(Boolean(a.landed), (el) => el.child(div().h(22 * z).px(8 * z).rounded(22 * z).bg(c.completeBg).text_color(c.completeText).text_size(11 * z).flex().items_center().child("Landed")))
      .child(div().text_size(12 * z).text_color(c.dim).child(ago(a.at, now)));
    const list = cardCommits(p);
    return [
      div().absolute().left(x + pos.nodeW / 2 * z).top(y - 24 * z).w(1).h(24 * z).bg(c.faint),
      div().id(`d-${p.id}`).absolute().left(x).top(y).w(pos.detailW * z).h(pos.detailH * z).rounded(16 * z).bg(c.surface).overflow_hidden()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .children(list.length
          ? list.map((a, i) => this.plainRow(c, i * 45, this.rowMarker(c, a.landed ? "done" : "pending", String(i + 1)), a.s, tail(a)))
          : [this.text("No commits in this window.", { x: 16, y: 38, size: 12, color: c.dim })]),
    ];
  }

  card(c, b, p, pos, now) {
    const z = this.zoom, w = pos.nodeW, h = pos.nodeH;
    const list = kids(b, p.id);
    const done = p.derived ? p.landed : list.filter((n) => n.status === "done").length;
    const [filled, total] = p.derived ? [p.bar?.n ?? 0, p.bar?.of ?? 0] : [done, list.length]; // a plan counts tasks, and git measures something else
    const unit = p.derived ? "COMMITS" : "TASKS";
    const foot = p.derived ? p.foot : "";
    const open = pos.h > h;
    const live = touched(p, now);
    const tint = p.kind === "knowledge" ? c.knowledge : p.kind === "human" ? c.human : c.accent;
    const edge = p.kind === "knowledge" ? c.knowledge : p.kind === "human" ? c.human : p.status === "blocked" ? c.danger : open || live || p.status === "active" ? c.accent : c.line;
    const picked = this.sel?.kind === "node" && this.sel.id === p.id;
    const strong = edge !== c.line || picked;
    const word = p.status === "done" ? "Revising" : p.status === "blocked" ? "Retrying" : "Editing";
    const names = cardAgents(b, p);
    const label = p.title.length > 28 ? `${p.title.slice(0, 27)}…` : p.title;
    const recent = (p.recent ?? [])[0];
    const chip = live && recent ? `${recent.file.split("/").pop()}${recent.n > 1 ? ` ×${recent.n}` : ""} · ${ago(recent.at, now)}` : "";
    const age = p.derived && !chip ? cardAge(p, (at) => ago(at, now)) : "";
    const barW = (w - 32) * z;
    const hasPlan = list.some((k) => k.status === "pending" && k.src === "agent");
    const ports = [0, w].map((x) => div().absolute().left((x - 4) * z).top((h / 2 - 4) * z).w(8 * z).h(8 * z).rounded(8 * z).bg(c.raised).border(1).border_color(c.faint));
    return div().id(`n-${p.id}`).absolute()
      .left(this.pan.x + (REGION_X + pos.nodeX) * z).top(this.pan.y + (REGION_Y + REGION_HEAD + pos.nodeY) * z).w(w * z).h(h * z)
      .rounded(12 * z).bg(live && !p.kind ? c.cardLive : c.card).border(picked ? 2.5 : strong ? 1.5 : 1).border_color(picked ? c.text : edge).cursor_pointer()
      .when(p.kind === "human", (el) => el.border_dashed())
      .hover((s) => s.bg(c.cardHover).border_color(picked ? c.text : strong ? edge : c.faint))
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.grab(p.id, e); })
      .on_click((_e, cx) => {
        if (this.dragged === p.id) { this.dragged = null; return; } // the end of a move, not a click
        this.toggle(p);
        this.select({ kind: "node", id: p.id }, b);
        cx.notify();
      })
      .child(this.text((p.tech || `#${p.id}`).slice(0, Math.min(42, Math.floor((w - 170) / 6.8))), { x: 16, y: 24, size: 11, color: p.kind ? tint : c.faint, mono: true, weight: 500 }))
      .children(this.statusIcon(c, p, w))
      .when(live, (el) => el
        .child(svg(`${ASSET}/arc-live.svg`).absolute().left((w - 41) * z).top(11 * z).w(30 * z).h(30 * z).text_color(tint).spin(1300))
        .child(this.text(word, { right: 44 + 24 * Math.min(names.length, 3), y: 30, size: 11, color: tint, weight: 600 }))
        .when(Boolean(chip), (e2) => e2.child(this.text(chip, { right: 16, y: 76, size: 11, color: tint, mono: true }))))
      .when(Boolean(age), (el) => el.child(this.text(age, { right: 16, y: 76, size: 11, color: c.faint, mono: true })))
      .children(names.map((n, i) => this.agentMark(c, n, w - 26 - 24 * (i + 1), 26, 13)))
      .child(this.text(label, { x: 16, y: 52, size: 15, color: c.text, weight: 600 }))
      .child(this.text(p.derived ? cardLine(p.meta, chip || age) : `${done} of ${list.length} tasks · ${p.status === "pending" && done > 0 ? "Underway" : statusLabel(p.status)}`, { x: 16, y: 76, size: 12, color: c.dim }))
      .when(!p.derived || Boolean(p.bar), (el) => el
        .child(div().absolute().left(16 * z).top(92 * z).w(barW).h(4 * z).rounded(2 * z).bg(c.hover))
        .child(div().absolute().left(16 * z).top(92 * z).w(total ? barW * filled / total : 0).h(4 * z).rounded(2 * z).bg(p.status === "active" ? c.accent : c.soft)))
      .child(this.text(open ? `HIDE ${unit} ↑` : `SHOW ${unit} ↓`, { x: 16, y: 116, size: 11, color: open ? c.accent : c.faint, mono: true, weight: 500 }))
      .when(Boolean(foot), (el) => el.child(this.text(foot, { right: 16, y: 116, size: 11, color: c.faint, mono: true })))
      .when(hasPlan, (el) => el.child(this.text("SESSION PLAN", { right: 16, y: 116, size: 10, color: "#e08bb8", mono: true, weight: 700 })))
      .children(ports);
  }

  rowMarker(c, status, n) {
    const z = this.zoom;
    if (status === "done") return div().w(22 * z).h(22 * z).rounded(22 * z).bg(c.done).flex().items_center().justify_center().flex_none().child(svg(`${ASSET}/check.svg`).w(18 * z).h(18 * z).text_color("#ffffff"));
    return div().w(22 * z).h(22 * z).rounded(22 * z).border(1.5 * z).border_color(status === "active" ? c.accent : c.faint).flex().items_center().justify_center().flex_none().text_size(10 * z).font_weight(600).text_color(c.text).child(n);
  }

  plainRow(c, top, marker, copy, tail) {
    const z = this.zoom;
    return h_flex().absolute().left(0).top(top * z).w(400 * z).h(44 * z).px(8 * z).gap(8 * z).items_center()
      .child(div().w(24 * z).h(24 * z).flex().items_center().justify_center().flex_none().child(marker))
      .child(div().flex_1().min_w(0).truncate().text_size(12 * z).font_weight(500).font_family(SANS).text_color(c.text).child(copy))
      .child(tail);
  }

  taskRow(c, b, task, i, top, now) {
    const z = this.zoom;
    const open = taskIsOpen(task, this.ui);
    const details = taskDetails(b, task, (at) => ago(at, now));
    const rows = open ? 16 + Math.max(details.rows.length, 5) * 20 : 0;
    const marker = this.rowMarker(c, task.status, String(i + 1));
    const pill = task.status === "done" ? ["Completed", c.completeText, c.completeBg] : task.status === "blocked" ? ["Blocked", c.danger, c.danger + "2e"] : null;
    const chip = task.by ? MARK[String(task.by).toLowerCase()] : null;
    const picked = this.sel?.kind === "node" && this.sel.id === task.id;
    return v_flex().id(`t-${task.id}`).absolute().left(0).top(top * z).w(400 * z).h((44 + rows) * z).cursor_pointer()
      .when(picked, (el) => el.bg(c.hover))
      .on_click((_e, cx) => {
        this.auto = false;
        if (open) { this.ui.openTasks.delete(task.id); this.ui.closedTasks.add(task.id); }
        else { this.ui.closedTasks.delete(task.id); this.ui.openTasks.add(task.id); }
        this.reshape();
        this.select({ kind: "node", id: task.id }, b);
        cx.notify();
      })
      .child(h_flex().h(44 * z).px(8 * z).gap(8 * z).items_center().flex_none()
        .child(div().w(24 * z).h(24 * z).flex().items_center().justify_center().flex_none().child(marker))
        .child(div().flex_1().min_w(0).truncate().text_size(12 * z).font_weight(500).font_family(SANS).text_color(c.text).child(task.title))
        .when(Boolean(chip), (el) => el.child(svg(`${ASSET}/agent-${chip}.svg`).w(14 * z).h(14 * z).flex_none().text_color(agentColor(c, task.by)).opacity(task.status === "done" ? 0.45 : 1)))
        .when(task.status === "active", (el) => el.child(div().flex_none().text_size(12 * z).text_color(c.dim).child("Editing now")))
        .when(Boolean(pill), (el) => el.child(div().flex_none().h(22 * z).px(8 * z).rounded(22 * z).bg(pill[2]).text_color(pill[1]).text_size(11 * z).flex().items_center().child(pill[0])))
        .child(svg(`${ASSET}/chevron.svg`).w(14 * z).h(14 * z).flex_none().text_color(c.faint)))
      .when(open, (el) => el.child(v_flex().px(40 * z).children(details.rows.map((r) => h_flex().h(20 * z).items_center().justify_between().gap(8 * z).text_size(11 * z).font_family(MONO).text_color(c.dim)
        .child(div().min_w(0).truncate().child(r.label)).child(div().flex_none().text_color(c.faint).child(r.meta))))));
  }

  detail(c, b, p, pos, now) {
    if (p.derived) return this.gitDetail(c, p, pos, now);
    const z = this.zoom;
    const list = kids(b, p.id);
    const stageH = this.stage().height;
    const originY = this.pan.y + (REGION_Y + REGION_HEAD + pos.nodeY + pos.nodeH + 24) * z;
    let top = 0;
    const rows = list.flatMap((task, i) => {
      const height = 45 + (taskIsOpen(task, this.ui) ? 16 + Math.max(taskDetails(b, task, () => "").rows.length, 5) * 20 : 0);
      const y = originY + top * z;
      const onScreen = y < stageH && y + height * z > 0;
      const late = Date.now() - this.t0 > RENDER_BUDGET_MS;
      if (late && onScreen) this.shed += 1;
      const row = onScreen && !late ? [this.taskRow(c, b, task, i, top, now)] : [];
      top += height;
      return row;
    });
    for (const r of (b.runs ?? []).filter((x) => x.componentId === p.id)) (r.todos ?? []).forEach((t, i) => {
      const st = t.status === "completed" ? "done" : t.status === "in_progress" ? "active" : "pending";
      rows.push(this.plainRow(c, top, this.rowMarker(c, st, String(i + 1)), t.content, div().flex_none().h(22 * z).px(8 * z).rounded(22 * z).bg("#e08bb82e").text_color("#e08bb8").text_size(11 * z).flex().items_center().child("Session plan")));
      top += 45;
    });
    const declared = list.some((k) => k.status === "active" || k.status === "blocked");
    const liveSession = (b.runs ?? []).some((r) => r.componentId === p.id && !r.ended && (r.todos ?? []).length);
    const a0 = (p.recent ?? [])[0];
    if (touched(p, now) && !declared && !liveSession && a0) rows.push(this.plainRow(c, top, this.rowMarker(c, "pending", ""), `Revising · ${a0.file.split("/").pop()}${a0.n > 1 ? ` ×${a0.n}` : ""}`, div().flex_none().text_size(12 * z).text_color(c.dim).child(ago(a0.at, now))));
    const x = this.pan.x + (REGION_X + pos.x) * z, y = this.pan.y + (REGION_Y + REGION_HEAD + pos.nodeY + pos.nodeH + 24) * z;
    const cx0 = x + pos.nodeW / 2 * z;
    return [
      div().absolute().left(cx0).top(y - 24 * z).w(1).h(24 * z).bg(c.faint),
      div().id(`d-${p.id}`).absolute().left(x).top(y).w(pos.detailW * z).h(pos.detailH * z).rounded(16 * z).bg(c.surface).overflow_hidden()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .children(list.length ? rows : [this.text("No tasks in this phase.", { x: 16, y: 38, size: 12, color: c.dim })]),
    ];
  }

  // ---- cards moved by hand, kept per repo in this mod's localStorage.

  loadOffsets() {
    const key = `${LAYOUT}${this.feed.state.repo ?? this.feed.board?.project ?? ""}`;
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    this.offsets = readOffsets(store.get(key));
    this.moves += 1;
  }

  grab(id, e) {
    const o = this.offsets[id] ?? { dx: 0, dy: 0 };
    this.drag = { id, x: e.position.x, y: e.position.y, dx: o.dx, dy: o.dy, moved: false };
    this.dragged = null;
  }

  dragTo(e) {
    const d = this.drag;
    if (e.pressed_button !== "left") return this.drop(); // released outside the window
    const mx = (e.position.x - d.x) / this.zoom, my = (e.position.y - d.y) / this.zoom;
    if (!d.moved && Math.hypot(mx * this.zoom, my * this.zoom) < 4) return;
    d.moved = true;
    this.auto = false;
    this.offsets = { ...this.offsets, [d.id]: { dx: d.dx + mx, dy: d.dy + my } };
    this.moves += 1;
    this.reshape();
  }

  drop() {
    const d = this.drag;
    this.drag = null;
    if (!d?.moved) return;
    this.dragged = d.id; // the click that ends a move doesn't open the card
    this.offsets = readOffsets(JSON.stringify(this.offsets));
    store.set(this.layoutKey, JSON.stringify(this.offsets));
  }

  resetMoves() {
    this.offsets = {};
    this.moves += 1;
    store.set(this.layoutKey, "{}");
    this.reshape();
  }

  // ---- acting: who a selection reaches, and the confirm before anything is sent.

  panelOpen() {
    return Boolean(this.sel || this.flow);
  }

  selNode(b) {
    return this.sel?.kind === "node" ? b.plan.find((n) => n.id === this.sel.id) ?? null : null;
  }

  target(b) {
    const live = agents();
    if (this.sel?.kind === "run") return { by: this.sel.run.agent, agent: agentForRun(this.sel.run, live, panes(), this.picks) };
    const by = ownerOf(b, this.sel);
    return { by, agent: agentFor(by, live, this.picks) };
  }

  select(sel, b) {
    this.flow = null;
    this.sel = sel;
    this.act = { mode: null, confirm: null, note: null, busy: false };
    if (this.selNode(b)?.status === "blocked") this.openPrompt(); // a stuck task opens on the prompt that unsticks it
  }

  closePanel() {
    this.sel = null;
    this.flow = null;
    this.promptIn.blur();
    this.flowIn.blur();
  }

  openPrompt() {
    this.act.mode = "prompt";
    this.act.confirm = null;
    this.promptIn.set_value("");
    this.promptIn.focus();
  }

  pick(by, address) {
    this.picks = { ...this.picks, [String(by).toLowerCase()]: address };
    store.set(PICKS, JSON.stringify(this.picks));
  }

  ask(kind, b) {
    const { agent } = this.target(b);
    const text = promptFor(kind, this.selNode(b), kind === "free" ? this.promptIn.value() : "");
    if (!agent || !text) return;
    this.act.confirm = { text, address: agent.address, name: agent.tab_name || agent.pane_name || agent.address };
    this.act.note = null;
  }

  // The terminal's screen is read first: a dialog there is the person's to answer, and
  // `hc send` without its force flag refuses to type into one anyway.
  send(cx) {
    const cf = this.act.confirm;
    if (!cf || this.act.busy) return;
    this.act.busy = true;
    cx.spawn(async (cx) => {
      let note;
      try {
        const screen = await exec("hc", ["read", cf.address, "--lines", "25"], { timeout: 10000 });
        if (looksLikeDialog(screen.stdout)) note = { bad: true, text: `${cf.name} tiene un diálogo abierto: aprobalo en su terminal.` };
        else {
          const r = await exec("hc", ["send", cf.address, cf.text], { timeout: 20000 });
          note = r.code === 0 ? { bad: false, text: `Enviado a ${cf.name} (${cf.address}).` } : { bad: true, text: (r.stderr || r.stdout).trim().slice(0, 200) || `hc send salió con ${r.code}` };
        }
      } catch (err) {
        note = { bad: true, text: String(err?.message ?? err).slice(0, 200) };
      }
      this.act = { mode: note.bad ? this.act.mode : null, confirm: null, note, busy: false };
      if (!note.bad) this.promptIn.set_value("");
      cx.notify();
    });
  }

  openFlow(b) {
    const comps = b.plan.filter((n) => n.level === "component");
    const node = this.selNode(b);
    const here = node ? (node.level === "component" ? node.id : node.parent) : null;
    this.sel = null;
    this.flow = { comp: here ?? comps[0]?.id ?? null, by: null, note: null, busy: false };
    this.flowIn.set_value("");
    this.flowIn.focus();
  }

  // Written only if PLAN.md is still what was read: Map redraws it on its own.
  addFlow(cx) {
    const f = this.flow;
    const repo = this.feed.state.repo;
    if (!f || f.busy || !repo || !f.comp || !this.flowIn.value().trim()) return;
    f.busy = true;
    cx.spawn(async (cx) => {
      const file = `${repo}/PLAN.md`;
      try {
        const before = await readTextFile(file);
        const next = before == null ? null : addTask(before, f.comp, this.flowIn.value(), f.by);
        if (!next) f.note = { bad: true, text: "No encontré esa tarjeta en PLAN.md." };
        else {
          await writeTextFile(file, next.text, before);
          f.note = { bad: false, text: `Agregada {#${next.id}} en PLAN.md.` };
          this.flowIn.set_value("");
          this.wake?.();
        }
      } catch (err) {
        f.note = { bad: true, text: `PLAN.md cambió o no se pudo escribir: ${String(err?.message ?? err).slice(0, 120)}` };
      }
      f.busy = false;
      cx.notify();
    });
  }

  chip(c, id, text, action, { tone = c.dim, solid = false, off = false } = {}) {
    return div().id(id).h(28).px(10).flex().flex_none().items_center().rounded(8).border(1).border_color(solid ? tone : c.line)
      .bg(solid ? tone : c.surface).text_size(12).font_weight(600).text_color(solid ? "#141414" : off ? c.faint : tone)
      .when(!off, (el) => el.cursor_pointer().hover((s) => s.bg(solid ? tone : c.hover)).on_click(action)).child(text);
  }

  panel(c, b, now) {
    const low = (this.size?.width ?? 0) < SIDE_DOCK;
    const box = v_flex().id("act").absolute().p(14).gap(10).rounded(14).border(1).border_color(c.line).bg(c.overlay).shadow_lg()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation());
    const placed = low ? box.left(8).right(8).bottom(8) : box.left(24).bottom(24).w(PANEL_W);
    const head = (title, sub) => h_flex().gap(8).items_start()
      .child(v_flex().flex_1().min_w(0).child(div().truncate().text_size(13.5).font_weight(600).text_color(c.text).child(title))
        .when(Boolean(sub), (el) => el.child(div().truncate().text_size(11.5).font_family(MONO).text_color(c.faint).child(sub))))
      .child(this.tool(c, "act-close", "×", (_e, cx) => { this.closePanel(); cx.notify(); }));
    const note = (n) => div().text_size(12).text_color(n.bad ? c.danger : c.success).child(n.text);
    const field = (state) => Input.new(state).h(34).px(10).rounded(8).border(1).border_color(c.accent).bg(c.bg).text_size(12.5).text_color(c.text);
    if (this.flow) return placed.child(this.flowForm(c, b, head, note, field));
    const node = this.selNode(b);
    const run = this.sel?.kind === "run" ? this.sel.run : null;
    if (!node && !run) return div();
    const { by, agent } = this.target(b);
    const stuck = agent?.status === "blocked";
    const title = node ? node.title : `${run.agent} · sesión`;
    const sub = node ? `#${node.id} · ${statusLabel(node.status)}${by ? ` · by: ${by}` : ""}` : `${ago(run.startedAt, now)} · ${shortPath(run.cwd)}`;
    const cf = this.act.confirm;
    const choices = agents().slice(0, 8);
    return placed
      .child(head(title, sub))
      .child(agent
        ? h_flex().gap(6).items_center().text_size(12).text_color(c.dim)
          .child(div().w(7).h(7).rounded(7).flex_none().bg(stuck ? c.danger : agent.status === "working" ? c.accent : agent.status === "done" ? c.success : c.faint))
          .child(div().flex_1().min_w(0).truncate().child(`→ ${agent.tab_name || agent.address} · ${agent.address} · ${agent.status}`))
        : v_flex().gap(6).child(div().text_size(12).text_color(c.dim).child(by ? `Ningún agente vivo para by: ${by}. Elegí uno:` : "Esta tarjeta no dice quién la hace (by:)."))
          .when(Boolean(by), (el) => el.child(h_flex().flex_wrap().gap(6).children(choices.map((a) =>
            this.chip(c, `pick-${a.address}`, a.tab_name || a.address, (_e, cx) => { this.pick(by, a.address); cx.notify(); }))))))
      .when(stuck, (el) => el.child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(12).text_color(c.danger).child("Necesita tu aprobación en su terminal."))
        .child(this.chip(c, "focus-stuck", "Enfocar", (_e, cx) => { run("agent.focus", { terminal: agent.address }); cx.notify(); }, { tone: c.danger }))))
      .when(Boolean(agent) && !stuck && !cf, (el) => el.child(h_flex().flex_wrap().gap(6)
        .child(this.chip(c, "a-status", "Status", (_e, cx) => { this.ask("status", b); cx.notify(); }))
        .child(this.chip(c, "a-next", "Seguí", (_e, cx) => { this.ask("next", b); cx.notify(); }))
        .child(this.chip(c, "a-focus", "Enfocar", (_e, cx) => { run("agent.focus", { terminal: agent.address }); cx.notify(); }))
        .child(this.chip(c, "a-prompt", "Prompt…", (_e, cx) => { this.openPrompt(); cx.notify(); }, { tone: c.accent }))))
      .when(Boolean(agent) && !stuck && !cf && this.act.mode === "prompt", (el) => el.child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).child(field(this.promptIn)))
        .child(this.chip(c, "a-free", "Enviar", (_e, cx) => { this.ask("free", b); cx.notify(); }, { tone: c.accent, solid: true }))))
      .when(Boolean(cf), (el) => el.child(v_flex().gap(8).p(10).rounded(10).bg(c.surface)
        .child(div().text_size(12).text_color(c.text).child(`¿Mandar a ${cf.name} (${cf.address})?`))
        .child(div().text_size(11.5).font_family(MONO).text_color(c.dim).child(cf.text.length > 220 ? `${cf.text.slice(0, 219)}…` : cf.text))
        .child(h_flex().gap(6).justify_end()
          .child(this.chip(c, "a-cancel", "Cancelar", (_e, cx) => { this.act.confirm = null; cx.notify(); }))
          .child(this.chip(c, "a-send", this.act.busy ? "Enviando…" : "Confirmar", (_e, cx) => { this.send(cx); cx.notify(); }, { tone: c.accent, solid: true, off: this.act.busy })))))
      .when(Boolean(this.act.note), (el) => el.child(note(this.act.note)));
  }

  flowForm(c, b, head, note, field) {
    const f = this.flow;
    const comps = b.plan.filter((n) => n.level === "component");
    const bys = [...new Set(b.plan.filter((n) => n.by).map((n) => n.by))].slice(0, 8);
    const label = (t) => div().text_size(11).font_family(MONO).font_weight(500).text_color(c.faint).child(t);
    return v_flex().gap(10)
      .child(head("+ Flujo", "Agrega una tarea a PLAN.md"))
      .child(label("TARJETA"))
      .child(h_flex().flex_wrap().gap(6).children(comps.map((p) =>
        this.chip(c, `fc-${p.id}`, p.title.length > 22 ? `${p.title.slice(0, 21)}…` : p.title, (_e, cx) => { f.comp = p.id; cx.notify(); }, { tone: f.comp === p.id ? c.accent : c.dim }))))
      .child(label("QUIÉN (by:)"))
      .child(h_flex().flex_wrap().gap(6)
        .child(this.chip(c, "fb-none", "nadie", (_e, cx) => { f.by = null; cx.notify(); }, { tone: f.by ? c.dim : c.accent }))
        .children(bys.map((n) => this.chip(c, `fb-${n}`, n, (_e, cx) => { f.by = n; cx.notify(); }, { tone: f.by === n ? c.accent : c.dim }))))
      .child(label("TAREA"))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).child(field(this.flowIn)))
        .child(this.chip(c, "f-add", f.busy ? "…" : "Agregar", (_e, cx) => { this.addFlow(cx); cx.notify(); }, { tone: c.accent, solid: true, off: f.busy })))
      .when(Boolean(f.note), (el) => el.child(note(f.note)));
  }

  // ---- overlays: fixed to the pane, like the page's.

  tool(c, id, child, action) {
    return div().id(id).w(28).h(28).flex().flex_none().items_center().justify_center().rounded(8).text_color(c.dim).text_size(16).cursor_pointer()
      .hover((s) => s.bg(c.hover).text_color(c.text)).on_click(action).child(child);
  }

  tools(c, b, now) {
    const stuck = b.plan.filter((n) => n.level !== "component" && n.status === "blocked");
    const inset = this.narrow() ? 8 : 24;
    return h_flex().id("tools").absolute().left(inset).top(inset).p(4).gap(4).items_center().rounded(12).border(1).border_color(c.line).bg(c.overlay).shadow_lg()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(this.tool(c, "zoom-out", "−", (_e, cx) => { this.nudge(0.85); cx.notify(); }))
      .child(div().w(44).text_center().text_size(11).font_family(MONO).text_color(c.dim).child(`${Math.round(this.zoom * 100)}%`))
      .child(this.tool(c, "zoom-in", "+", (_e, cx) => { this.nudge(1.18); cx.notify(); }))
      .child(div().w(1).h(16).mx(4).bg(c.line))
      .child(this.tool(c, "fit", svg(`${ASSET}/fit.svg`).w(14).h(14), (_e, cx) => { this.auto = false; this.fit(); cx.notify(); }))
      .when(Boolean(liveCard(b, now)), (el) => el.child(this.tool(c, "live", svg(`${ASSET}/live.svg`).w(14).h(14), (_e, cx) => { this.goLive(); cx.notify(); })))
      .when(Object.keys(this.offsets).length > 0, (el) => el.child(this.tool(c, "unmove", "↺", (_e, cx) => { this.resetMoves(); cx.notify(); })))
      .child(div().w(1).h(16).mx(4).bg(c.line))
      .when(stuck.length > 0, (el) => el.child(div().id("stuck").h(28).px(8).flex().items_center().rounded(8).text_size(12).font_weight(600).text_color(c.danger).cursor_pointer()
        .hover((s) => s.bg(c.hover)).on_click((_e, cx) => { this.select({ kind: "node", id: stuck[0].id }, b); cx.notify(); })
        .child(`${stuck.length} ${stuck.length === 1 ? "bloqueada" : "bloqueadas"}`)))
      .child(div().id("flow").h(28).px(8).flex().items_center().rounded(8).text_size(12).font_weight(600).text_color(c.accent).cursor_pointer()
        .hover((s) => s.bg(c.hover)).on_click((_e, cx) => { this.openFlow(b); cx.notify(); }).child("+ Flujo"));
  }

  runCard(c, b, r, now) {
    const cur = (r.todos ?? []).find((t) => t.status === "in_progress");
    const tool = r.currentTool ?? r.recentTools?.[0];
    const comp = r.componentId ? b.plan.find((x) => x.id === r.componentId) : null;
    const key = own(MARK, String(r.agent).toLowerCase());
    const picked = this.sel?.kind === "run" && this.sel.run.id === r.id;
    return v_flex().id(`run-${r.id ?? r.startedAt}`).px(14).py(12).rounded(14).border(picked ? 1.5 : 1).border_color(picked ? c.accent : c.line).bg(c.overlay).shadow_lg().flex_none()
      .cursor_pointer().hover((s) => s.border_color(c.faint))
      .on_click((_e, cx) => { this.select({ kind: "run", run: r }, b); cx.notify(); })
      .child(h_flex().gap(8).items_center()
        .child(key ? svg(`${ASSET}/agent-${key}.svg`).w(16).h(16).flex_none().text_color(agentColor(c, r.agent)) : div().w(16).h(16).flex_none())
        .child(div().flex_none().text_size(13).font_weight(600).text_color(c.text).child(r.agent))
        .when(!this.narrow(), (el) => el.child(div().flex_none().text_size(11.5).text_color(c.faint).child(`· ${own(SOURCE, r.source) ?? "hooks"} · ${b.project}`)))
        .child(div().flex_none().w(6).h(6).rounded(6).bg(r.ended ? c.faint : c.success).when(!r.ended, (el) => el.loop("opacity", { from: 0.35, to: 1, period: 1600 })))
        .child(h_flex().flex_1().min_w(0).justify_end().gap(4).text_size(11.5).text_color(c.faint)
          .child(div().flex_none().child(`${ago(r.startedAt, now)}${comp ? " · in" : ""}`))
          .when(Boolean(comp), (el) => el.child(div().min_w(0).truncate().text_color(c.accent).child(comp?.title ?? "")))))
      .when(Boolean(cur) || Boolean(r.ended), (el) => el.child(div().mt(6).truncate().text_size(12.5).text_color(cur ? c.text : c.dim).child(cur ? cur.content : "Idle, waiting for you")))
      .when(Boolean(tool), (el) => el.child(h_flex().mt(5).gap(8).text_size(11.5).font_family(MONO).text_color(c.dim).min_w(0)
        .child(div().flex_none().text_color(c.accent).child(tool.name))
        .child(div().flex_1().min_w(0).truncate().child(tool.detail ?? ""))
        .child(div().flex_none().text_color(c.faint).child(ago(tool.at, now)))));
  }

  runs(c, b, now) {
    const all = [...(b.runs ?? [])].sort((a, r) => a.startedAt - r.startedAt).slice(-4);
    const low = (this.size?.width ?? 0) < SIDE_DOCK;
    if (low && b.derived && !all.some((r) => !r.ended)) return div(); // cards say who was there; a finished session must not cover them
    const list = low ? (all.filter((r) => !r.ended).length ? all.filter((r) => !r.ended) : all).slice(-1) : all; // along the bottom there is room for one
    const dock = v_flex().id("runs").absolute().gap(low ? 6 : 10);
    // The label sits on a solid chip: bare text over a card reads as part of the card.
    return (low ? dock.left(8).right(8).bottom(8) : dock.right(24).top(24).w(340))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .when(all.length > 1, (el) => el.child(div().px(10).py(5).rounded(10).border(1).border_color(c.line).bg(c.overlay).truncate().text_size(10.5).font_weight(600).font_family(MONO).text_color(c.faint).child(`${all.some((r) => !r.ended) ? "NOW" : "EARLIER"} · ${String(b.project).toUpperCase()} · ${all.length} SESSIONS`)))
      .children(list.map((r) => this.runCard(c, b, r, now)));
  }

  // What is on screen, in words, whatever the state: never a repo without its name.
  title(b) {
    const s = this.feed.state;
    if (b) return b.project;
    return s.kind === "off" ? repoName(s.repo) : s.kind === "plain" ? "No repo" : "Agenttrail Map";
  }

  subtitle() {
    const s = this.feed.state;
    if (this.feed.fixed) return `Port ${this.feed.fixed}`;
    return s.repo ? shortPath(s.repo) : "Follows the focused terminal";
  }

  header(c, b, now) {
    const working = b?.activity && now - b.activity.at < 60000;
    const narrow = this.narrow();
    const host = this.host();
    const big = this.isExpanded(host);
    return h_flex().h(narrow ? 44 : 64).px(narrow ? 12 : 24).gap(narrow ? 8 : 10).items_center().flex_none().bg(c.bg).border_b(1).border_color(c.hover)
      .child(image(`${ASSET}/mark-${lit() ? "light" : "dark"}.svg`).w(narrow ? 22 : 28).h(narrow ? 22 : 28).flex_none())
      .child(v_flex().flex_1().min_w(0).child(div().truncate().text_size(14).font_weight(600).text_color(c.text).child(this.title(b)))
        .when(!narrow, (el) => el.child(div().truncate().text_size(12).text_color(c.dim).child(this.subtitle()))))
      .when(Boolean(b), (el) => el.child(h_flex().flex_none().h(24).px(8).gap(6).items_center().rounded(8).border(1).border_color(c.line).text_size(12).text_color(working ? c.success : c.dim)
        .child(div().w(6).h(6).rounded(6).bg(working ? c.success : c.faint))
        .child(working ? (narrow ? `${ago(b.activity.at, now)} ago` : `Working · ${ago(b.activity.at, now)} ago`) : !hasCards(b) ? "Watching" : b.derived ? "Inferred" : narrow ? "Live" : "Plan is live")))
      .when(host.kind !== "lone", (el) => el.child(this.tool(c, "size", svg(`${ASSET}/${big ? "collapse" : "expand"}.svg`).w(14).h(14), (_e, cx) => { this.toggleSize(); cx.notify(); })));
  }

  away(c) {
    const repo = repoName(this.feed.state.away);
    return h_flex().id("away").h(AWAY_H).px(this.narrow() ? 12 : 24).gap(8).items_center().flex_none().bg(c.surface).border_b(1).border_color(c.hover).text_size(12)
      .child(div().flex_1().min_w(0).truncate().text_color(c.dim).child(`Not your terminal's repo, ${repo}`))
      .child(div().id("back").flex_none().text_color(c.accent).cursor_pointer().hover((s) => s.text_color(c.text)).child("Back")
        .on_click((_e, cx) => { this.feed.back(); this.wake?.(); cx.notify(); }));
  }

  // Map's honesty rule: never let a guess read as a plan.
  inferredNote(c, b) {
    const narrow = this.narrow();
    return v_flex().id("inferred").h(this.noteH()).px(narrow ? 12 : 24).justify_center().flex_none().bg(c.surface).border_b(1).border_color(c.hover)
      .text_size(12).text_color(c.dim).child(div().w_full().when(!narrow, (el) => el.truncate()).child(inferredNote(b, narrow)));
  }

  button(c, id, text, action) {
    return div().id(id).h(32).px(12).flex().flex_none().items_center().rounded(8).border(1).border_color(c.accent).text_size(13).font_weight(600).text_color(c.accent)
      .cursor_pointer().hover((s) => s.bg(c.hover)).on_click(action).child(text);
  }

  // Other Maps are things to switch to, never something shown by default.
  others(c, list) {
    return v_flex().mt(20).gap(2).child(div().pb(4).text_size(11).font_family(MONO).font_weight(500).text_color(c.faint).child("RUNNING ELSEWHERE"))
      .children(list.map((m) => h_flex().id(`map-${m.port}`).h(36).px(8).gap(8).items_center().rounded(8).cursor_pointer().hover((s) => s.bg(c.hover))
        .on_click((_e, cx) => { this.feed.choose(m.port); this.wake?.(); cx.notify(); })
        .child(div().flex_none().text_size(13).font_weight(600).text_color(c.text).child(m.project))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(c.faint).child(shortPath(m.repoPath)))
        .child(div().flex_none().text_size(12).text_color(c.accent).child("Show"))));
  }

  notice(c, s) {
    const repo = repoName(s.repo);
    const words = {
      scanning: ["Scanning for Map…", null],
      none: ["No terminal in focus", "Click a terminal and Map shows its repo."],
      plain: ["Not in a git repo", `${shortPath(s.repo)} isn't inside one. Map follows the repo of the focused terminal.`],
      off: [`Map isn't running for ${repo}`, null],
      gone: [`Map isn't answering on port ${s.port}`, null],
    }[s.kind];
    const start = (_e, cx) => this.startMap(s.repo, cx);
    return v_flex().id("notice").size_full().min_h(0).p(this.narrow() ? 16 : 24).overflow_y_scrollbar()
      .child(div().text_size(s.kind === "scanning" ? 13 : 15).font_weight(s.kind === "scanning" ? 400 : 600).text_color(s.kind === "scanning" ? c.dim : c.text).child(words[0]))
      .when(Boolean(words[1]), (el) => el.child(div().mt(6).text_size(13).text_color(c.dim).child(words[1])))
      .when(s.kind === "off", (el) => el.child(h_flex().mt(14).child(this.starting.has(s.repo)
        ? div().h(32).flex().items_center().text_size(13).text_color(c.dim).child("Starting…")
        : this.button(c, "start", "Start Map here", start))))
      .when(s.others.length > 0, (el) => el.child(this.others(c, s.others)));
  }

  // A real Map with no plan: what the page shows there, its runs and the files it saw.
  noPlan(c, b, now) {
    const runs = [...(b.runs ?? [])].sort((a, r) => r.startedAt - a.startedAt).slice(0, 4);
    const files = (b.recentActivity ?? []).slice(0, 8);
    const label = (text) => div().mt(20).pb(6).text_size(11).font_family(MONO).font_weight(500).text_color(c.faint).child(text);
    const quiet = (text) => div().text_size(13).text_color(c.dim).child(text);
    return v_flex().id("no-plan").size_full().min_h(0).p(this.narrow() ? 16 : 24).overflow_y_scrollbar()
      .child(v_flex().w_full().max_w(640).flex_none()
        .child(div().text_size(15).font_weight(600).text_color(c.text).child(`Watching ${b.project}`))
        .child(div().mt(6).text_size(13).text_color(c.dim).child(b.derived ? (b.derived.git === false ? "This folder isn't in git, so there is no history to draw." : "Nothing to draw yet. Cards appear after the first commit.") : "The component map needs a plan: run npx agenttrail init in this repo."))
        .child(label("SESSIONS"))
        .child(v_flex().gap(8).children(runs.map((r) => this.runCard(c, b, r, now))))
        .when(!runs.length, (el) => el.child(quiet("No agent sessions seen yet.")))
        .child(label("RECENT FILES"))
        .children(files.map((a) => h_flex().h(24).gap(8).items_center().text_size(12).font_family(MONO)
          .child(div().flex_1().min_w(0).truncate().text_color(c.soft).child(`${a.file}${a.n > 1 ? ` ×${a.n}` : ""}`))
          .child(div().flex_none().text_color(c.faint).child(ago(a.at, now)))))
        .when(!files.length, (el) => el.child(quiet("Waiting for the first file write."))));
  }

  canvas(c, b, now) {
    const { width, height } = this.stage();
    const z = this.zoom;
    const { L, region } = this.geo;
    const nodes = L.phases.flatMap((p) => {
      if (Date.now() - this.t0 > RENDER_BUDGET_MS) { this.shed += 1; return []; } // see RENDER_BUDGET_MS: a missing card beats a dead view
      const pos = L.pos[p.id];
      const x = this.pan.x + (REGION_X + pos.x) * z, y = this.pan.y + (REGION_Y + REGION_HEAD + pos.y) * z;
      if (x > width || y > height || x + pos.w * z < 0 || y + pos.h * z < 0) return []; // a mod pays per element, so off-screen ones go
      return [this.card(c, b, p, pos, now), ...(pos.h > pos.nodeH ? this.detail(c, b, p, pos, now) : [])];
    });
    this.parts.nodes = Date.now() - this.t0;
    const edges = this.edgeLayer(c);
    this.parts.edges = Date.now() - this.t0;
    return [
      div().absolute().left(this.pan.x + REGION_X * z).top(this.pan.y + REGION_Y * z).w(region.w * z).h(region.h * z).rounded(26 * z).bg(c.region).border(1.5).border_color(c.line)
        .child(this.text(`${String(b.project ?? "").toUpperCase()}${b.derived ? " · INFERRED" : ""}`, { x: 28, y: 38, size: 15, color: c.faint, mono: true, weight: 600 })),
      edges,
      ...this.geo.edges.filter((e) => e.agent).map((e) => {
        const mx = (e.curve.x1 + e.curve.x2) / 2, my = (e.curve.y1 + e.curve.y2) / 2 - (e.arrow ? 10 : 8);
        return div().absolute().left(this.pan.x + (REGION_X + mx - 60) * z).top(this.pan.y + (REGION_Y + REGION_HEAD + my - 11) * z).w(120 * z).text_center()
          .text_size(10.5 * z).font_weight(650).font_family(MONO).text_color(agentColor(c, e.agent)).child(`${e.agent} ⇢`);
      }),
      ...nodes,
    ];
  }

  render() {
    const started = Date.now();
    this.t0 = started;
    this.parts = {};
    this.shed = 0;
    this.takeView();
    if (!this.feed.fixed && this.here() !== this.feed.at) this.wake?.();
    const c = lit() ? LIGHT : DARK;
    const b = this.feed.board;
    const now = Date.now();
    const ready = Boolean(hasCards(b) && this.geo && this.size);
    const root = v_flex().id("root").size_full().min_h(0).bg(c.bg).font_family(SANS)
      .on_size_change((size, cx) => {
        if (size.width === this.size?.width && size.height === this.size?.height) return;
        this.resized(size);
        cx.notify();
      })
      .child(this.header(c, b, now))
      .when(Boolean(this.feed.state.away), (el) => el.child(this.away(c)))
      .when(inferred(b), (el) => el.child(this.inferredNote(c, b)))
      .child(div().id("canvas").relative().flex_1().min_h(0).overflow_hidden().bg(c.bg)
        .when(Boolean(this.press), (el) => el.cursor_grabbing())
        .when(ready && !this.press, (el) => el.cursor_grab())
        .on_mouse_down("left", (e, cx) => { this.press = { x: e.position.x, y: e.position.y, px: this.pan.x, py: this.pan.y }; cx.notify(); })
        .on_mouse_move((e, cx) => {
          if (!this.press) return;
          this.stats.moves += 1;
          this.auto = false;
          this.pan = { x: this.press.px + e.position.x - this.press.x, y: this.press.py + e.position.y - this.press.y };
          cx.notify();
        })
        .on_mouse_up("left", (_e, cx) => { this.press = null; cx.notify(); })
        .on_window_mouse_move((e, cx) => { if (this.drag) { this.dragTo(e); cx.notify(); } })
        .on_window_mouse_up("left", (_e, cx) => { if (this.drag) { this.drop(); cx.notify(); } })
        .on_hover((hovered, cx) => { if (!hovered && this.press) { this.press = null; cx.notify(); } })
        .on_scroll_wheel((e, cx) => {
          this.stats.wheels += 1;
          this.auto = false;
          if (e.modifiers.platform || e.modifiers.control) {
            const local = e.local_position ?? { x: e.position.x, y: e.position.y - this.headH() };
            this.zoomBy(Math.exp(Math.max(-60, Math.min(60, e.delta.y)) * 0.004), local);
          } else this.pan = { x: this.pan.x + e.delta.x, y: this.pan.y + e.delta.y };
          cx.notify();
        })
        .when(ready, (el) => { const g = el.child(this.grid(c)); this.parts.grid = Date.now() - this.t0; return g; })
        .when(ready, (el) => el.children(this.canvas(c, b, now)).child(this.tools(c, b, now)))
        .when(ready && !(this.panelOpen() && (this.size?.width ?? 0) < SIDE_DOCK), (el) => el.child(this.runs(c, b, now)))
        .when(ready && this.panelOpen(), (el) => el.child(this.panel(c, b, now)))
        .when(Boolean(b) && !hasCards(b), (el) => el.child(this.noPlan(c, b, now)))
        .when(!b, (el) => el.child(this.notice(c, this.feed.state))));
    const ms = Date.now() - started;
    this.stats.renders += 1;
    this.stats.totalMs += ms;
    this.stats.shed = (this.stats.shed ?? 0) + (this.shed ? 1 : 0);
    if (ms >= this.stats.maxMs) { this.stats.maxMs = ms; this.stats.worst = { ...this.parts, ms }; }
    const worst = this.narrow() ? "worstNarrow" : "worstFull";
    this.stats[worst] = Math.max(this.stats[worst], ms);
    return root;
  }
}
