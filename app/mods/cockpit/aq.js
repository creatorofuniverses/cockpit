// The aq space: the heavy commands agents queued through aq (a local queue that starts them when memory is free), as the
// hub's `aq` view gives them. Above, the pool's memory and CPU committed and the host's memory in use, with aq's
// pressure flags; then what runs (its memory against its limit), what waits (its place and why), the reservations with
// the tasks inside them, and what ended lately. Beside the list, the selected item's facts and its log; it cancels,
// extends and releases through aq, and goes to the agent that queued it. A remote desk reads only: logs and results,
// no buttons that change the queue.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import * as hub from "./hub.js";
import { rowsOf, goToAgent } from "./fleet.js";
import { openReader } from "./reader.js";
import {
  tokens, TEXT, RADIUS, Icon, Badge, Button, PageHeader, KeyHints, Empty, ErrorState, Skeleton, Toaster, Flashes, Scroller,
  SidePanel, AlertDialog, Chip, Mono, Metric, StageHeading, Progress, Pills, Spinner, openMenu, alpha, Overline, Tiles,
} from "./ui.js";

const SIDE_AT = 960;
const TTLS = ["30m", "1h", "2h", "4h"];
const OUTCOME = {
  ok: ["circle-check", (k) => k.success],
  failed: ["circle-x", (k) => k.destructive],
  oom: ["circle-x", (k) => k.destructive],
  timeout: ["timer", (k) => k.destructive],
  cancelled: ["circle-stop", (k) => k.mutedFg],
  rejected: ["triangle-alert", (k) => k.warning],
  released: ["layers", (k) => k.mutedFg],
  other: ["circle-dashed", (k) => k.mutedFg],
};

/** The list as it shows: a heading per non-empty group, then its items; a reservation's tasks right under it. */
export function listRows(model) {
  if (model?.state !== "live") return [];
  const out = [];
  const group = (label, items, nested = false) => {
    if (!items?.length) return;
    out.push({ kind: "heading", key: `h:${label}`, label, count: items.length });
    for (const item of items) {
      out.push({ kind: "item", key: item.id, item, nested: false });
      if (nested) for (const t of item.tasks ?? []) out.push({ kind: "item", key: t.id, item: t, nested: true });
    }
  };
  group("Running", model.running);
  group("Queued", model.queued);
  group("Reservations", model.reservations, true);
  group("Recent", model.recent);
  return out;
}

/** The agent that queued an item: the agents view's row with its session, or null. */
export function agentFor(agentsValue, session) {
  if (!session) return null;
  return rowsOf(agentsValue).find((r) => r.session === session) ?? null;
}

/** Home's line for the aq view: null when aq is not on this machine. */
export function aqLine(v) {
  return v?.line ?? null;
}

/** The sidebar's bubble: what runs and waits, red after a failure, yellow when the queue stalls. */
export function aqBadge(v) {
  return v?.badge ?? null;
}

export default class Aq {
  init(_props, cx) {
    this.model = null;
    this.agents = null;
    this.status = "connecting";
    this.sel = null;
    this.stream = "stdout";
    this.log = null;
    this.logKey = null;
    this.logSub = null;
    this.confirm = null;
    this.remote = false;
    this.visible = false;
    this.width = 1200;
    this.height = 800;
    this.toasts = new Toaster();
    this.flashes = new Flashes();
    this.scroller = new Scroller();
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      try {
        this.remote = Boolean((await hub.install()).machine);
      } catch {}
      cx.notify();
    });
    this.sub = hub.subscribe(
      cx,
      { views: ["aq", "agents"], focus: "aq" },
      (m, cx) => {
        if (m.view === "aq") this.take(m.value, cx);
        if (m.view === "agents") this.agents = m.value;
        if (m.focus === "aq" && m.target?.key) this.select(m.target.key, cx);
        cx.notify();
      },
      (s, cx) => ((this.status = s), cx.notify()),
    );
  }

  close() {
    this.sub?.stop();
    this.logSub?.stop();
  }

  command(c, cx) {
    if (c === "focus" || c === "show:aq") {
      this.visible = true;
      this.handle.focus();
    } else if (c.startsWith("show:") && this.visible) this.visible = false;
    const [scope, what, id, ...rest] = c.split(":");
    if (scope === "aq" && what === "act") this.act(id, rest[0], rest[1], cx);
    cx.notify();
  }

  take(model, cx) {
    const before = this.model;
    this.model = model;
    const k = tokens();
    if (before?.state === "live" && model?.state === "live") {
      const was = new Map(listRows(before).filter((r) => r.kind === "item").map((r) => [r.key, r.item.phase]));
      for (const r of listRows(model)) {
        if (r.kind !== "item" || !was.has(r.key) || was.get(r.key) === r.item.phase) continue;
        const [, color] = OUTCOME[r.item.outcome] ?? [null, (k) => k.working];
        this.flashes.start(cx, r.key, color(k));
      }
    }
    if (!this.sel || !this.item(this.sel)) this.select(this.items()[0]?.key ?? null, cx);
  }

  items() {
    return listRows(this.model).filter((r) => r.kind === "item");
  }

  item(id) {
    return this.items().find((r) => r.key === id)?.item ?? null;
  }

  /** Picks a row and follows its log. */
  select(id, cx) {
    this.sel = id;
    this.follow(cx);
  }

  follow(cx) {
    const id = this.sel;
    const key = id ? `${id}:${this.stream}` : null;
    if (key === this.logKey) return;
    this.logKey = key;
    this.logSub?.stop();
    this.logSub = null;
    this.log = null;
    if (!id) return;
    const args = { id, stream: this.stream, tail: 200 };
    this.logSub = hub.subscribe(cx, { views: [{ name: "aq-log", args }] }, (m, cx) => {
      if (m.view === "aq-log" && m.args?.id === this.sel && m.args?.stream === this.stream) this.log = m.value;
      cx.notify();
    });
  }

  move(by, cx) {
    const items = this.items();
    if (!items.length) return;
    const at = items.findIndex((r) => r.key === this.sel);
    const next = items[Math.max(0, Math.min(items.length - 1, (at < 0 ? 0 : at) + by))];
    this.select(next.key, cx);
  }

  /** The first item of the next group (`by` 1) or of the one before the selected item's group (`by` -1). */
  moveGroup(by, cx) {
    const rows = listRows(this.model);
    const firsts = rows.flatMap((r, i) => (r.kind === "heading" && rows[i + 1]?.kind === "item" ? [i + 1] : []));
    const at = rows.findIndex((r) => r.key === this.sel);
    const group = firsts.filter((i) => i <= at).length - 1;
    const next = firsts[Math.max(0, Math.min(firsts.length - 1, group + by))];
    if (next !== undefined) this.select(rows[next].key, cx);
  }

  agentOf(item) {
    return agentFor(this.agents, item?.session);
  }

  /** What the selected item offers here: the read ones always, the ones that change the queue only on this machine. */
  acts(item) {
    if (!item) return [];
    const out = [];
    if (this.agentOf(item)) out.push({ id: "agent", label: "Go to agent", icon: "bot", key: "enter" });
    if (item.acts.includes("logs")) out.push({ id: "logs", label: "Logs", icon: "file-text", key: "l" });
    if (item.acts.includes("result")) out.push({ id: "result", label: "Result", icon: "scroll-text", key: "o" });
    if (this.remote) return out;
    if (item.acts.includes("extend")) out.push({ id: "extend", label: "Extend 1h", icon: "alarm-clock", key: "e" });
    if (item.acts.includes("release")) out.push({ id: "release", label: "Release", icon: "layers", key: "r", confirm: true });
    if (item.acts.includes("cancel")) out.push({ id: "cancel", label: "Cancel", icon: "circle-stop", key: "x", confirm: true });
    return out;
  }

  /** Runs one of the item's acts: `ttl` for extend; the destructive ones ask first unless `sure`. */
  act(id, itemId, ttl, cx, sure = false) {
    const item = this.item(itemId ?? this.sel);
    if (!item) return;
    const a = this.acts(item).find((x) => x.id === id) ?? (id === "extend" && !this.remote && item.acts.includes("extend") ? { id } : null);
    if (!a) return;
    if (a.id === "agent") return goToAgent(this.agentOf(item));
    if (a.id === "logs" || a.id === "result") return this.openLog(item, a.id === "result" ? "result" : this.stream === "result" ? "stdout" : this.stream, cx);
    if (a.confirm && !sure) {
      this.confirm = { ...a, item };
      cx.notify();
      return;
    }
    const args = a.id === "extend" ? [item.id, ttl || "1h"] : [item.id];
    cx.spawn(async (cx) => this.send(cx, a.id, args));
  }

  async send(cx, action, args) {
    try {
      const r = await hub.act("aq", action, args);
      if (r.error) this.toasts.push(cx, r.error, { kind: "error" });
      else if (r.note) this.toasts.push(cx, r.note, { kind: "success" });
    } catch (e) {
      this.toasts.push(cx, "The hub did not answer", { kind: "error", description: String(e?.message ?? e) });
    }
    cx.notify();
  }

  /** The whole log (or result) in the reader, fetched once. */
  openLog(item, stream, cx) {
    cx.spawn(async (cx) => {
      try {
        const v = await hub.view("aq-log", { id: item.id, stream, tail: 2000 });
        if (v?.error && !v.text) this.toasts.push(cx, v.error, { kind: "error" });
        else openReader({ text: "```\n" + (v?.text || "(empty)") + "\n```", title: `${item.name} · ${stream}`, meta: [item.project, item.agent, item.short].filter(Boolean).join(" · ") });
      } catch (e) {
        this.toasts.push(cx, "The hub did not answer", { kind: "error", description: String(e?.message ?? e) });
      }
      cx.notify();
    });
  }

  menu(item) {
    const acts = this.acts(item);
    const items = acts.map((a) => ({ label: a.confirm ? `${a.label}…` : a.label, icon: a.icon, kbd: a.key, destructive: a.id === "cancel", command: `aq:act:${a.id}:${item.id}` }));
    if (!this.remote && item.acts.includes("extend")) {
      items.push("separator", ...TTLS.map((t) => ({ label: `Extend by ${t}`, icon: "alarm-clock", command: `aq:act:extend:${item.id}:${t}` })));
    }
    if (items.length) openMenu(items);
  }

  key(e, cx) {
    const s = e.keystroke;
    if (this.confirm) {
      if (s === "escape") this.confirm = null;
      else if (s === "enter") {
        const c = this.confirm;
        this.confirm = null;
        this.act(c.id, c.item.id, null, cx, true);
      } else return false;
      cx.notify();
      return true;
    }
    const item = this.item(this.sel);
    if (s === "j" || s === "down") this.move(1, cx);
    else if (s === "k" || s === "up") this.move(-1, cx);
    else if (s === "]") this.moveGroup(1, cx);
    else if (s === "[") this.moveGroup(-1, cx);
    else if (s === "g") this.select(this.items()[0]?.key ?? null, cx);
    else if (s === "shift-g") this.select(this.items().at(-1)?.key ?? null, cx);
    else if (s === "s") this.setStream(this.stream === "stdout" ? "stderr" : "stdout", cx);
    else if (s === "m" && item) this.menu(item);
    else {
      const a = this.acts(item).find((x) => x.key === s);
      if (!a) return false;
      this.act(a.id, item.id, null, cx);
    }
    cx.notify();
    return true;
  }

  setStream(stream, cx) {
    this.stream = stream;
    this.follow(cx);
    cx.notify();
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Drawing

  tiles(k) {
    const m = this.model;
    const flags = [m.host.pressure_closed ? "admission closed: memory pressure" : null, m.host.guard_active ? "host guard is trimming aq" : null].filter(Boolean);
    const bar = (label, text, ratio, color) =>
      v_flex()
        .gap(4)
        .child(h_flex().gap(8).child(div().flex_1().text_size(TEXT.xs).text_color(k.mutedFg).child(label)).child(Mono(text, { size: TEXT.xs })))
        .child(Progress(ratio, { color, h: 6 }));
    const memColor = m.pool.ratio >= 0.9 ? k.destructive : m.pool.ratio >= 0.75 ? k.warning : k.primary;
    return Tiles([
      v_flex()
        .id("aq-tile-pool")
        .flex_1()
        .min_w(260)
        .px(16)
        .py(12)
        .gap(8)
        .rounded(RADIUS.lg)
        .border_1()
        .border_color(flags.length ? alpha(k.warning, 0.4) : k.border)
        .bg(flags.length ? alpha(k.warning, 0.06) : k.card)
        .child(h_flex().gap(6).items_center().child(Icon("gauge", { size: 13, color: k.mutedFg })).child(div().flex_1().text_size(TEXT.xs).font_semibold().text_color(k.mutedFg).child("POOL")).when(Boolean(m.daemon), (e) => e.child(div().text_size(TEXT.xs).text_color(k.dim ?? k.mutedFg).child(`aq ${m.daemon}`))))
        .child(bar("Memory committed", m.pool.text, m.pool.ratio, memColor))
        .child(bar("CPU committed", m.pool.cpus_text, m.pool.cpus_ratio, k.info ?? k.primary))
        .child(bar("Host memory in use", m.host.text, m.host.ratio, m.host.ratio >= 0.9 ? k.destructive : k.mutedFg))
        .when(flags.length > 0, (e) => e.child(h_flex().gap(6).flex_wrap().children(flags.map((f, i) => Badge(f, "warning", { id: `aq-flag-${i}`, icon: "triangle-alert" }))))),
      Metric("aq-tile-running", {
        label: "Running",
        value: m.counts.running,
        icon: "play",
        spin: m.counts.running > 0,
        tone: m.counts.running ? k.working : k.foreground,
        hint: m.counts.reservations ? `${m.counts.reservations} reservation${m.counts.reservations === 1 ? "" : "s"} held` : "no reservation held",
      }),
      Metric("aq-tile-queued", {
        label: "Queued",
        value: m.counts.queued,
        icon: "hourglass",
        tone: m.queued.some((q) => q.late) ? k.warning : k.foreground,
        tint: m.queued.some((q) => q.late),
        hint: m.head || (m.counts.queued ? "starting soon" : "nothing waits"),
        tooltip: m.head || undefined,
      }),
      Metric("aq-tile-day", {
        label: "Last 24 h",
        value: m.day.text,
        icon: "activity",
        tone: m.day.oom || m.day.failed ? k.destructive : k.foreground,
        hint: [m.day.oom ? `${m.day.oom} OOM` : null, m.day.failed ? `${m.day.failed} failed` : null, m.day.wait_median ? `median wait ${m.day.wait_median}` : null, m.day.run_total ? `ran ${m.day.run_total}` : null].filter(Boolean).join(" · "),
      }),
    ]);
  }

  mark(item, k) {
    if (item.phase === "running") return Spinner({ size: 14, color: k.working });
    if (item.phase === "queued") return Icon("hourglass", { size: 14, color: item.late ? k.warning : k.mutedFg });
    if (item.phase === "held") return Icon("layers", { size: 14, color: item.expiring ? k.warning : k.info ?? k.primary });
    const [icon, color] = OUTCOME[item.outcome] ?? OUTCOME.other;
    return Icon(icon, { size: 14, color: color(k) });
  }

  /** The line under an item's name: what it does now, in its phase's words. */
  meta(item) {
    if (item.phase === "running") return [item.time && `running ${item.time}`, `${item.cpus} CPU`, item.timeout && `timeout ${item.timeout}`].filter(Boolean).join(" · ");
    if (item.phase === "queued") return [`#${item.position}`, item.blocked && `waits on ${item.blocked}`, `queued ${item.waited} ago`, item.expected && `starts ${item.expected}`].filter(Boolean).join(" · ");
    if (item.phase === "held") return [item.ttl, item.budget, item.docker && `stand ${item.docker}`].filter(Boolean).join(" · ");
    return [item.words, item.took && `took ${item.took}`, item.ended, item.diagnostic].filter(Boolean).join(" · ");
  }

  itemRow(row, k, sel) {
    const item = row.item;
    const flash = this.flashes.of(row.key);
    const wide = this.width >= 760;
    const tone = item.phase === "done" ? (OUTCOME[item.outcome] ?? OUTCOME.other)[1](k) : null;
    const right =
      item.phase === "running" || item.phase === "held"
        ? v_flex().w(140).flex_none().gap(4).child(div().text_size(TEXT.xs).text_color(item.mem.high ? k.destructive : k.mutedFg).child(item.mem.text)).child(Progress(item.mem.ratio, { color: item.mem.high ? k.destructive : k.primary, h: 4 }))
        : div().flex_none().text_size(TEXT.xs).text_color(k.mutedFg).child(item.phase === "queued" ? item.mem.text : item.peak ? `peak ${item.peak}` : "");
    return h_flex()
      .id(`aq-row-${row.key}`)
      .h(50)
      .pl(row.nested ? 40 : 12)
      .pr(12)
      .gap(10)
      .items_center()
      .rounded(RADIUS.md)
      .relative()
      .cursor_pointer()
      .bg(sel ? k.selected : k.background)
      .when(!sel, (e) => e.hover((s) => s.bg(k.accent)))
      .when(row.nested, (e) => e.child(div().absolute().left(20).top(0).w(1).h(25).bg(k.border)).child(div().absolute().left(20).top(25).w(12).h(1).bg(k.border)))
      .child(this.mark(item, k))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .min_w(0)
              .child(div().truncate().text_size(TEXT.base).font_medium().child(item.name))
              .when(Boolean(item.project), (e) => e.child(Chip(item.project, { icon: "folder", mono: true })))
              .when(wide && Boolean(item.agent), (e) => e.child(div().text_size(TEXT.xs).text_color(k.mutedFg).child(item.agent)))
              .when(item.phase === "queued" && item.late, (e) => e.child(Badge("waiting long", "warning")))
              .when(item.phase === "held" && item.expiring, (e) => e.child(Badge("expiring", "warning"))),
          )
          .child(div().truncate().text_size(TEXT.xs).text_color(tone && item.outcome !== "ok" ? tone : k.mutedFg).child(this.meta(item))),
      )
      .when(wide, (e) => e.child(right))
      .when(Boolean(flash), (e) => e.child(div().id(`aq-fl-${row.key}`).absolute().inset_0().rounded(RADIUS.md).bg(alpha(flash?.color ?? k.ring, 0.25)).opacity(flash?.on ? 1 : 0).transition("opacity", { duration: 1100, easing: "ease-out" })));
  }

  list(k) {
    const rows = listRows(this.model);
    if (!rows.length) return Empty({ icon: "hourglass", title: "Nothing in the queue", description: "Agents run heavy commands through aq: tests, builds, stands. They show here while they run and for a day after." });
    const at = rows.findIndex((r) => r.key === this.sel);
    const items = rows.map((row) => {
      if (row.kind === "heading") {
        const color = row.label === "Running" ? k.working : row.label === "Queued" ? k.warning : k.mutedFg;
        return { height: 34, el: div().pt(8).child(StageHeading(`aq-head-${row.label}`, row.label, { color, count: row.count, spin: row.label === "Running" })) };
      }
      const el = this.itemRow(row, k, row.key === this.sel)
        .on_click((e, cx) => {
          this.select(row.key, cx);
          this.handle.focus();
          if (e.click_count > 1) {
            const agent = this.agentOf(row.item);
            if (agent) goToAgent(agent);
            else if (row.item.acts.includes("logs")) this.openLog(row.item, "stdout", cx);
          }
          cx.notify();
        })
        .on_mouse_down("right", (_e, cx) => {
          this.select(row.key, cx);
          this.menu(row.item);
          cx.notify();
        });
      return { height: 50, el };
    });
    return this.scroller.view("aq-list", items, at, { gap: 2, padding: 4 });
  }

  fact(label, value, k, { mono = false } = {}) {
    if (value === null || value === undefined || value === "") return null;
    return h_flex()
      .gap(12)
      .items_start()
      .child(div().w(84).flex_none().text_size(TEXT.xs).text_color(k.mutedFg).child(label))
      .child(mono ? Mono(String(value), { size: TEXT.xs }) : div().flex_1().min_w(0).whitespace_normal().text_size(TEXT.sm).child(String(value)));
  }

  actionButtons(prefix, item) {
    return h_flex()
      .gap(6)
      .flex_wrap()
      .children(
        this.acts(item).map((a, i) =>
          Button(`${prefix}-${a.id}`, {
            label: a.label,
            icon: a.icon,
            kbd: a.key === "enter" ? "⏎" : a.key,
            size: "sm",
            variant: i === 0 ? "default" : a.id === "cancel" ? "ghost" : "outline",
            onClick: (_e, cx) => this.act(a.id, item.id, null, cx),
          }),
        ),
      );
  }

  logBox(item, k) {
    const has = item.acts.includes("logs");
    const streams = [has ? ["stdout", "stdout"] : null, has ? ["stderr", "stderr"] : null, item.acts.includes("result") ? ["result", "result"] : null].filter(Boolean);
    if (!streams.length) return null;
    if (!streams.some(([s]) => s === this.stream)) return Button("aq-show-result", { label: "Show the result", icon: "scroll-text", variant: "outline", size: "sm", onClick: (_e, cx) => this.setStream("result", cx) });
    const v = this.log;
    const lines = (v?.text ?? "").split("\n");
    const shown = lines.slice(-60).join("\n").trimEnd();
    return v_flex()
      .gap(8)
      .child(h_flex().gap(8).items_center().child(Overline("Output")).child(div().flex_1()).child(Pills("aq-stream", streams, this.stream, (s, cx) => this.setStream(s, cx))))
      .child(
        v_flex()
          .id("aq-log")
          .max_h(360)
          .p(10)
          .rounded(RADIUS.md)
          .border_1()
          .border_color(k.border)
          .bg(k.muted)
          .overflow_y_scrollbar()
          .child(
            !v
              ? Skeleton({ h: 14 })
              : v.error && !v.text
                ? div().text_size(TEXT.xs).text_color(k.destructive).whitespace_normal().child(v.error)
                : div().text_size(TEXT.xs).font_family("JetBrains Mono").whitespace_normal().text_color(k.foreground).child(shown || "(empty)"),
          ),
      );
  }

  side(k) {
    const item = this.item(this.sel);
    if (!item) return null;
    const agent = this.agentOf(item);
    const where = [item.project, item.agent].filter(Boolean).join(" · ");
    return SidePanel("aq-side", {
      title: item.name,
      description: where || item.kind,
      width: 400,
      children: [
        this.actionButtons("aq-side", item),
        v_flex()
          .gap(6)
          .children(
            [
              this.fact("State", item.phase === "done" ? item.words : item.state.toLowerCase().replace(/_/g, " "), k),
              this.fact("Memory", item.mem?.text ?? (item.peak ? `peak ${item.peak}` : null), k),
              this.fact("CPU", item.cpus ? `${item.cpus}` : null, k),
              this.fact("Queue", item.phase === "queued" ? this.meta(item) : null, k),
              this.fact("Time left", item.ttl, k),
              this.fact("Budget", item.budget, k),
              this.fact("Stand", item.docker, k, { mono: true }),
              this.fact("Agent", agent ? agent.title ?? agent.name ?? item.agent : item.agent, k),
              this.fact("Exit", item.exit_code ?? null, k, { mono: true }),
              this.fact("Diagnostic", item.diagnostic, k),
              this.fact("Folder", item.path, k, { mono: true }),
              this.fact("Item", item.id, k, { mono: true }),
            ].filter(Boolean),
          ),
        this.logBox(item, k),
      ].filter(Boolean),
    });
  }

  body(k) {
    const m = this.model;
    if (!m) {
      if (this.status.startsWith("error")) return ErrorState({ title: "Cannot reach the cockpit hub", message: this.status.slice(7) });
      return v_flex().flex_1().p(24).gap(16).child(h_flex().gap(12).children([0, 1, 2, 3].map(() => Skeleton({ h: 96 })))).children([0, 1, 2, 3].map(() => Skeleton({ h: 50 })));
    }
    if (m.state === "absent")
      return Empty({ icon: "hourglass", title: "aq is not installed here", description: "aq queues the heavy commands agents run (tests, builds, stands) and starts them when memory is free. Install it on the machine the hub runs on, and its queue shows here." });
    if (m.state === "down") return ErrorState({ title: "aq is down", message: m.error ?? "the aq daemon does not answer" });
    return h_flex()
      .flex_1()
      .min_h(0)
      .child(
        v_flex()
          .flex_1()
          .h_full()
          .min_w(0)
          .min_h(0)
          .child(v_flex().px(24).pt(16).pb(8).flex_none().child(this.tiles(k)))
          .child(v_flex().flex_1().min_h(0).px(20).child(this.list(k))),
      )
      .when(this.width >= SIDE_AT, (e) => e.child(this.side(k) ?? div()));
  }

  render(cx) {
    const k = tokens();
    const m = this.model;
    const item = this.item(this.sel);
    const description = m?.state === "live" ? m.line?.text : m?.state === "down" ? "the aq daemon does not answer" : "The heavy commands agents queued through aq";
    let out = v_flex()
      .id("aq")
      .track_focus(this.handle)
      .size_full()
      .relative()
      .bg(k.background)
      .text_color(k.foreground)
      .text_size(TEXT.base)
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) > 4 || Math.abs(size.height - this.height) > 4) {
          this.width = size.width;
          this.height = size.height;
          cx.notify();
        }
      })
      .on_mouse_down("left", () => {
        this.visible = true;
        this.handle.focus();
      })
      .on_key_down((ev, cx) => {
        if (this.key(ev, cx)) cx.stop_propagation();
      })
      .child(PageHeader({ icon: "cpu", title: "aq", description, actions: this.remote ? [Badge("read-only", "outline", { icon: "eye", tooltip: "A remote desk reads the runner's queue; cancel, extend and release run on that machine" })] : [] }))
      .child(this.body(k))
      .when(this.width < SIDE_AT && Boolean(item), (x) => x.child(h_flex().px(24).py(10).gap(8).flex_none().items_center().border_t_1().border_color(k.border).bg(alpha(k.muted, 0.5)).child(this.actionButtons("aq-bar", item))))
      .child(KeyHints([["j k", "move"], ["[ ]", "groups"], ["⏎", "agent"], ["l", "logs"], ["s", "stderr"], ...(this.remote ? [] : [["x", "cancel"], ["e", "extend"], ["r", "release"]]), ["m", "menu"]]));
    const toasts = this.toasts.render();
    if (toasts) out = out.child(toasts);
    if (this.confirm) {
      const c = this.confirm;
      const words = c.id === "cancel" ? `aq stops ${c.item.name}${c.item.phase === "running" ? " and its processes" : ""}; its agent hears it was cancelled.` : `aq frees ${c.item.name}'s memory without running its teardown script; shut its stand down first.`;
      out = out.child(
        AlertDialog("aq-confirm", {
          title: `${c.label} ${c.item.name}?`,
          description: words,
          confirmLabel: c.label,
          destructive: true,
          onCancel: (_e, cx) => ((this.confirm = null), cx.notify()),
          onConfirm: (_e, cx) => {
            this.confirm = null;
            this.act(c.id, c.item.id, null, cx, true);
            cx.notify();
          },
        }),
      );
    }
    return out;
  }
}
