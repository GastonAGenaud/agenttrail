// Acting on the Map: which live Herdr agent a card, task or run belongs to, the words
// sent to it, cards moved by hand, and tasks added to PLAN.md. Pure: no Herdr imports,
// so the tests run it as it is.

export const PROMPTS = {
  status: "Dame un status corto: qué hiciste, qué sigue, qué te bloquea.",
  next: "Seguí con el siguiente paso.",
};

const words = (s) => String(s ?? "").toLowerCase().split(/[^a-z0-9áéíóúñ]+/).filter(Boolean);
const nameOf = (a) => [a.tab_name, a.pane_name, a.title].filter(Boolean).join(" ").toLowerCase();

// A plan's `by:` names who did a task (claude, lead-terrapoint). Herdr knows its agents
// by address and by the names people gave their tabs and panes. A pick someone made by
// hand wins; then an address; then the one agent whose names hold every word of `by`.
export function agentFor(by, agents, picks = {}) {
  if (!by) return null;
  const key = String(by).toLowerCase();
  const picked = Object.prototype.hasOwnProperty.call(picks, key) ? picks[key] : null;
  const live = (addr) => agents.find((a) => a.address === addr) ?? null;
  if (picked && live(picked)) return live(picked);
  if (live(by)) return live(by);
  const need = words(by);
  if (!need.length) return null;
  const hits = agents.filter((a) => { const n = nameOf(a); return need.every((w) => n.includes(w)); });
  return hits.length === 1 ? hits[0] : null;
}

// Map's own sessions carry the agent and its folder: the Herdr agent running the same
// program in that folder, when there is exactly one.
export function agentForRun(run, agents, panes, picks = {}) {
  const viaBy = agentFor(run.agent, agents, picks);
  if (viaBy && Object.prototype.hasOwnProperty.call(picks, String(run.agent).toLowerCase())) return viaBy;
  const cwd = typeof run.cwd === "string" ? run.cwd.replace(/\/+$/, "") : "";
  const app = String(run.agent).toLowerCase();
  const hits = agents.filter((a) => {
    const pane = panes.find((p) => p.pane === a.pane);
    const here = pane?.cwd ? pane.cwd.replace(/\/+$/, "") : "";
    return (!cwd || here === cwd) && String(a.app ?? "").toLowerCase().startsWith(app);
  });
  return hits.length === 1 ? hits[0] : viaBy;
}

// Who a selection reaches: a task's `by`, else the `by` of a card's live or stuck tasks,
// else the most recent `by` on the card.
export function ownerOf(b, sel) {
  if (!sel) return null;
  if (sel.kind === "run") return sel.run?.agent ?? null;
  const node = b.plan.find((n) => n.id === sel.id);
  if (!node) return null;
  if (node.level !== "component") return node.by ?? null;
  const tasks = b.plan.filter((n) => n.parent === node.id && n.by);
  const hot = tasks.find((n) => n.status === "blocked") ?? tasks.find((n) => n.status === "active");
  return (hot ?? tasks.at(-1))?.by ?? null;
}

// The text sent: the task in a line of context, so a lead with several knows which one.
export function promptFor(kind, node, free = "") {
  const body = kind === "free" ? String(free).trim() : PROMPTS[kind];
  if (!body) return "";
  if (!node || node.level === "component" && kind !== "free") return body;
  return node.title ? `Sobre "${node.title}": ${body}` : body;
}

// A permission or choice dialog on screen: answering it is the person's call, not the Map's.
export function looksLikeDialog(screen) {
  return /do you want to|allow (this|once|always)|❯\s*1\.\s*yes|\(y\/n\)|press enter to confirm|approve\?/i.test(String(screen ?? ""));
}

// ---- cards moved by hand: offsets in world units, kept per repo.

const clampOff = (o) => ({ dx: Math.round(Number(o?.dx) || 0), dy: Math.round(Number(o?.dy) || 0) });

export function moveLayout(L, offsets = {}) {
  const pos = {};
  let right = 0, bottom = 0;
  for (const [id, p] of Object.entries(L.pos)) {
    const o = Object.prototype.hasOwnProperty.call(offsets, id) ? clampOff(offsets[id]) : { dx: 0, dy: 0 };
    const dx = Math.max(o.dx, 16 - p.x), dy = Math.max(o.dy, 16 - p.y); // never off the region's top or left
    pos[id] = { ...p, x: p.x + dx, y: p.y + dy, nodeX: p.nodeX + dx, nodeY: p.nodeY + dy };
    right = Math.max(right, pos[id].x + p.w + 64);
    bottom = Math.max(bottom, pos[id].y + p.h + 64);
  }
  return { ...L, pos, width: Math.max(L.width, right), height: Math.max(L.height, bottom) };
}

export function readOffsets(raw) {
  try {
    const v = JSON.parse(raw ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([k]) => !(k in Object.prototype)).map(([k, o]) => [k, clampOff(o)]));
  } catch { return {}; }
}

// ---- a new task in PLAN.md, written under its card and nowhere else.

export const slug = (s) => words(s).join("-").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9-]/g, "").slice(0, 32).replace(/-+$/, "");

export function addTask(text, componentId, title, by = null) {
  const clean = String(title ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!clean || !componentId) return null;
  const lines = String(text).split("\n");
  const head = lines.findIndex((l) => /^##\s/.test(l) && l.includes(`{#${componentId}}`));
  if (head < 0) return null;
  let end = lines.length;
  for (let i = head + 1; i < lines.length; i++) if (/^##?\s/.test(lines[i])) { end = i; break; }
  while (end > head + 1 && !lines[end - 1].trim()) end -= 1; // after the last line of the section, not its blank gap
  const taken = new Set([...String(text).matchAll(/\{#([^}]+)\}/g)].map((m) => m[1]));
  const base = `${componentId}-${slug(clean) || "tarea"}`.slice(0, 40);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  const add = [`- [ ] ${clean} {#${id}}`, ...(by ? [`  by: ${by}`] : []), "  from: roadmap"];
  lines.splice(end, 0, ...add);
  return { text: lines.join("\n"), id };
}

// by: names matched to a terminal address by hand, kept as plain strings.
export function readPicks(raw) {
  try {
    const v = JSON.parse(raw ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([k, a]) => !(k in Object.prototype) && typeof a === "string"));
  } catch { return {}; }
}
