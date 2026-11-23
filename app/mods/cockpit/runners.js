// The Runners space shows autoscale controls and offline history above current CI runner servers.

import { div } from "gpui-kit";
import * as base from "gpui-base";
import { h_flex, v_flex } from "gpui-base";
import * as hub from "./hub.js";
import { Chart, SERIES } from "./plot.js";
import { tokens, TEXT, RADIUS, Icon, Badge, Button, Card, Tabs, PageHeader, KeyHints, Toaster, Empty, ErrorState, Skeleton, SidePanel, Mono, Metric, Tiles, alpha } from "./ui.js";

const SIDE_AT = 960;
const SIDE_WIDTH = 400;
const HISTORY_WINDOWS = [{ value: "24h", label: "24 h" }, { value: "7d", label: "7 d" }];
const BADGES = {
  on: { label: "On", variant: "success" },
  blocked: { label: "On · blocked", variant: "warning" },
  error: { label: "On · error", variant: "destructive" },
  paused: { label: "Paused", variant: "warning" },
  off: { label: "Off in config", variant: "secondary" },
};

/** The servers as they show, in the model's order; empty unless the model is live. */
export function serverRows(model) {
  if (model?.state !== "live") return [];
  return (model.servers ?? []).map((server) => ({ key: server.id, server }));
}

/** Home's line for the runners view: null when ci-runners is not on this machine. */
export function runnersLine(v) {
  return v?.line ?? null;
}

/** The sidebar's bubble: the service's warnings counted, or a bang when it cannot be read. */
export function runnersBadge(v) {
  return v?.badge ?? null;
}

/** The tiles above the list, with queue and cost figures when the service provides them. */
export function tiles(model) {
  const t = model?.tiles;
  if (model?.state !== "live" || !t) return [];
  const out = [
    { id: "servers", label: "Servers", value: t.servers, icon: "server" },
    { id: "busy", label: "Busy", value: `${t.busy} / ${t.runners}`, icon: "play", hint: "runners working" },
  ];
  if (t.queued != null) out.push({ id: "queued", label: t.queue_label ?? "Queued", value: t.queued, icon: "hourglass", hint: t.queue_ago ? `as of ${t.queue_ago} ago` : undefined, hintWarn: Boolean(t.queue_stale) });
  if (t.cost != null) out.push({ id: "cost", label: "Cost now", value: t.cost, icon: "gauge", hint: "estimate" });
  return out;
}

/** The autoscale badge label and tone from the hub's state. */
export function autoscaleBadge(model) {
  const state = model?.autoscale?.state;
  return Object.hasOwn(BADGES, state) ? BADGES[state] : null;
}

/** The configured maximum's source and cap. */
export function maxCaption(model) {
  const a = model?.autoscale;
  if (!a) return null;
  return `${a.max_source === "set-max" ? "set here" : "from config"} · cap ${a.max_vms ?? "—"}`;
}

/** The waiting count and its tooltip when the service has not read it. */
export function waitingFigure(model) {
  const waiting = model?.autoscale?.waiting;
  if (!waiting) return null;
  return waiting.count == null ? { value: "—", hint: "not read" } : { value: String(waiting.count) };
}

/** The actor, age and reason for a pause. */
export function pauseCaption(model) {
  const a = model?.autoscale;
  if (!a?.on || !a.paused) return null;
  const by = [a.paused_by ? `by ${a.paused_by}` : null, a.paused_ago ? `${a.paused_ago} ago` : null].filter(Boolean).join(" ");
  return [by, a.pause_reason].filter(Boolean).join(" · ") || null;
}

/** The chart, tiles and notices for a history window. */
export function historyView(model, win) {
  const history = model?.history;
  if (!history) return null;
  if (history.error) return { error: history.error };
  const notes = history.notes ?? [];
  if (history.empty) return { empty: true, notes };
  const window = history.windows?.[win];
  const chart = history.charts?.[win];
  if (!window || !chart) return null;
  return { chart, tiles: window.tiles, notes: [...(window.notes ?? []), ...notes] };
}

/** The available controls and their keyboard shortcuts. */
export function autoscaleControls(model) {
  const a = model?.autoscale;
  if (!a?.on) return [];
  const out = [];
  if (a.can_pause) out.push(a.paused ? { id: "resume", label: "Resume", key: "p", disabled: false } : { id: "pause", label: "Pause", key: "p", disabled: false });
  if (a.can_set_max) {
    out.push({ id: "less", label: "Max −", key: "-", disabled: !Number.isInteger(a.max) || a.max <= 0 });
    out.push({ id: "more", label: "Max +", key: "+", disabled: !Number.isInteger(a.max) || !Number.isInteger(a.max_vms) || a.max >= a.max_vms });
    if (a.max_source === "set-max") out.push({ id: "reset", label: "Reset max", key: "0", disabled: false });
  }
  return out;
}

/** The hub act a control sends: its action and arguments. */
function autoscaleAct(model, id) {
  const max = model.autoscale.max;
  if (id === "less") return ["set-max", [max - 1]];
  if (id === "more") return ["set-max", [max + 1]];
  if (id === "reset") return ["reset-max", []];
  return [id, []];
}

/** A server's phase in words. */
export function phaseWords(server) {
  switch (server.phase) {
    case "busy":
      return "busy";
    case "idle":
      return server.runner?.idle ? `idle ${server.runner.idle}` : "idle";
    case "booting":
      return "booting";
    case "draining":
      return "draining";
    case "building":
      return "building image";
    case "unowned":
      return "not managed by tick";
    case "unknown":
      return "runner unknown";
    default:
      return "other";
  }
}

/** The header's tick label with how the last run ended, or null when the tick has no last run to count from. */
export function tickText(model) {
  const tick = model?.tick;
  if (!tick?.ago) return null;
  if (tick.ok !== false) return `tick ${tick.ago} ago`;
  const errors = tick.errors > 0 ? `${tick.errors} ${tick.errors === 1 ? "error" : "errors"}` : "failed";
  return `tick ${tick.ago} ago · ${errors}`;
}

/** A server's cost with the word that marks it as an estimate. */
export function costWords(cost) {
  return cost ? `${cost} estimate` : null;
}

/** A server's status in lower case, with its drain flag. */
function statusWords(server) {
  const status = String(server.status ?? "").toLowerCase();
  return server.drain ? `${status} · drain` : status;
}

export default class Runners {
  init(_props, cx) {
    this.model = null;
    this.status = "connecting";
    this.sel = null;
    this.visible = false;
    this.width = 1200;
    this.height = 800;
    this.scroll = base.ScrollHandle?.new() ?? null;
    this.historyWindow = "24h";
    this.historyHover = null;
    this.historyHidden = { "24h": new Set(), "7d": new Set() };
    this.toasts = new Toaster();
    this.busy = false;
    this.handle = cx.focus_handle();
    this.sub = hub.subscribe(
      cx,
      { views: ["runners"], focus: "runners" },
      (m, cx) => {
        if (m.view === "runners") this.take(m.value);
        cx.notify();
      },
      (s, cx) => ((this.status = s), cx.notify()),
    );
  }

  close() {
    this.sub?.stop();
  }

  /** A view command: focusing the space takes the keyboard; showing another view gives it up. */
  command(c, cx) {
    if (c === "focus" || c === "show:runners") {
      this.visible = true;
      this.handle.focus();
    } else if (c.startsWith("show:") && this.visible) this.visible = false;
    cx.notify();
  }

  take(model) {
    this.model = model;
    if (!this.sel || !this.server(this.sel)) this.sel = this.rows()[0]?.key ?? null;
  }

  rows() {
    return serverRows(this.model);
  }

  server(id) {
    return this.rows().find((r) => r.key === id)?.server ?? null;
  }

  select(id, _cx) {
    this.sel = id;
  }

  move(by, cx) {
    const rows = this.rows();
    if (!rows.length) return;
    const at = rows.findIndex((r) => r.key === this.sel);
    const next = Math.max(0, Math.min(rows.length - 1, (at < 0 ? 0 : at) + by));
    this.select(rows[next].key, cx);
    // The cards and current metrics occupy the first scroll item.
    this.scroll?.scroll_to_item(next + 1);
  }

  historyWindows() {
    const history = this.model?.history;
    if (this.model?.state !== "live" || history?.error || history?.empty) return [];
    return HISTORY_WINDOWS.filter(({ value }) => history?.windows?.[value] && history.charts?.[value]);
  }

  setHistoryWindow(win, cx) {
    this.historyWindow = win;
    this.historyHover = null;
    cx.notify();
  }

  key(e, cx) {
    const s = e.keystroke;
    if (s === "w") {
      const items = this.historyWindows();
      if (items.length < 2) return false;
      const next = items.find(({ value }) => value !== this.historyWindow);
      this.setHistoryWindow(next.value, cx);
      return true;
    }
    if (s === "j" || s === "down") this.move(1, cx);
    else if (s === "k" || s === "up") this.move(-1, cx);
    else {
      const want = { p: "p", "+": "more", "=": "more", "shift-=": "more", "shift-+": "more", "-": "less", "0": "reset" }[s];
      if (!want) return false;
      const c = autoscaleControls(this.model).find((x) => (want === "p" ? x.key === "p" : x.id === want));
      if (c && !c.disabled) this.run(c.id, cx);
      return true;
    }
    cx.notify();
    return true;
  }

  /** Sends an autoscale control's act to the hub, unless one is already running. */
  run(id, cx) {
    if (this.busy) return;
    const [action, args] = autoscaleAct(this.model, id);
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => this.send(cx, action, args));
  }

  async send(cx, action, args) {
    try {
      const r = await hub.act("runners", action, args, cx);
      if (r.error) this.toasts.push(cx, r.error, { kind: "error" });
      else if (r.note) this.toasts.push(cx, r.note, { kind: "success" });
    } catch (e) {
      this.toasts.push(cx, "The hub did not answer", { kind: "error", description: String(e?.message ?? e) });
    }
    this.busy = false;
    cx.notify();
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Drawing

  /** The autoscale state, current demand and available controls. */
  autoscale(k) {
    const badge = autoscaleBadge(this.model);
    if (!badge) return null;
    const a = this.model.autoscale;
    const controls = autoscaleControls(this.model);
    const control = (id, options) => {
      const c = controls.find((c) => c.id === id);
      return c ? Button(`runners-autoscale-${id}`, {
        label: c.label,
        size: "sm",
        variant: "outline",
        disabled: c.disabled || this.busy,
        onClick: (_e, cx) => this.run(id, cx),
        ...options,
      }) : null;
    };
    const action = control(a.paused ? "resume" : "pause", { kbd: "p" });
    const paused = pauseCaption(this.model);
    const waiting = waitingFigure(this.model);
    const heading = (label) => div().text_size(TEXT.xs).font_semibold().text_color(k.mutedFg).child(label);
    const number = (value) => div().text_size(26).font_semibold().text_color(k.foreground).child(String(value ?? "—"));
    const words = (text, color = k.mutedFg) => div().text_size(TEXT.xs).text_color(color).whitespace_normal().child(text);
    const dot = { secondary: k.mutedFg, success: k.success, warning: k.warning, destructive: k.destructive }[badge.variant];
    const status = v_flex().min_w(0).gap(4).items_start()
      .child(Badge(badge.label, badge.variant, { dot }))
      .when(Boolean(paused), (e) => e.child(words(paused, k.warning)));
    const max = a.on ? v_flex().flex_none().gap(2).items_center()
      .child(heading("Max servers"))
      .child(h_flex().gap(8).items_center().children([
        control("less", { label: "−", tooltip: "Decrease max servers" }),
        number(a.max),
        control("more", { label: "+", tooltip: "Increase max servers" }),
      ].filter(Boolean)))
      .child(h_flex().gap(6).items_center().children([
        words(maxCaption(this.model)),
        control("reset", { label: "Reset", variant: "link", tooltip: "Use the config maximum" }),
      ].filter(Boolean))) : null;
    const demand = waiting ? v_flex().flex_none().gap(2).items_center()
      .child(heading("Waiting heavy jobs"))
      .child(number(waiting.value).when(Boolean(waiting.hint), (e) => e.id("runners-waiting").tooltip(waiting.hint))) : null;
    const last = a.last?.text ? `last${a.last.ago ? ` ${a.last.ago} ago` : ""}: ${a.last.text}` : null;

    return Card({
      id: "runners-autoscale",
      title: "Autoscale",
      action,
      children: [
        h_flex().gap(20).items_start().flex_wrap().children([status, max, demand].filter(Boolean)),
        a.on && (a.trigger || last) ? h_flex().gap(6).flex_wrap().children([
          a.trigger ? words(`trigger ${a.trigger}`) : null,
          last ? words(a.trigger ? `· ${last}` : last, a.last.tone === "warning" ? k.warning : k.mutedFg) : null,
        ].filter(Boolean)) : null,
      ].filter(Boolean),
    });
  }

  /** The selected history chart, window totals and service notes. */
  history(k) {
    const items = this.historyWindows();
    const win = items.some((item) => item.value === this.historyWindow) ? this.historyWindow : items[0]?.value;
    const history = historyView(this.model, win);
    if (!history) return null;
    const notes = (history.notes ?? []).map((n) =>
      div().text_size(TEXT.xs).text_color(n.tone === "warning" ? k.warning : k.mutedFg).whitespace_normal().child(n.text));
    if (history.empty || history.error) {
      return Card({
        id: "runners-history",
        title: "History",
        children: [
          div().text_size(TEXT.sm).text_color(history.error ? k.warning : k.mutedFg).whitespace_normal().child(history.error ?? "No history yet"),
          ...notes,
        ],
      });
    }

    const colors = {
      busy: SERIES[5], idle: k.warning, booting: SERIES[0], waiting: k.foreground,
      stopped: k.mutedFg, expired: SERIES[4], builder: SERIES[3], unknown: k.dim,
    };
    const chart = { ...history.chart, series: history.chart.series.map((s) => ({ ...s, color: colors[s.key] })) };
    const hidden = this.historyHidden[win];
    const side = this.width >= SIDE_AT && this.sel !== null ? SIDE_WIDTH : 0;
    return Card({
      id: "runners-history",
      title: "History",
      action: items.length > 1 ? Tabs("runners-history-window", { items, value: win, onChange: (next, cx) => this.setHistoryWindow(next, cx) }) : null,
      children: [
        Chart(`runners-history-${win}`, chart, {
          height: 140,
          width: Math.max(0, this.width - side - 80),
          hover: this.historyHover,
          hidden,
          onHover: (at, cx) => {
            this.historyHover = at;
            cx.notify();
          },
          onToggle: (name, cx) => {
            if (!hidden.delete(name)) hidden.add(name);
            cx.notify();
          },
        }),
        Tiles(history.tiles.map((t) => {
          const tone = t.tone === "warning" ? k.warning : undefined;
          return Metric(`runners-history-tile-${t.id}`, { label: t.label, value: t.value, tone, hint: t.hint, hintTone: tone, tooltip: t.hint });
        })),
        ...notes,
      ],
    });
  }

  tiles() {
    return Tiles(tiles(this.model).map((t) => Metric(`runners-tile-${t.id}`, { label: t.label, value: t.value, icon: t.icon, hint: t.hint, hintTone: t.hintWarn ? tokens().warning : undefined })));
  }

  warnings(k) {
    const list = this.model.warnings ?? [];
    if (!list.length) return null;
    return v_flex()
      .gap(6)
      .children(
        list.map((w, i) =>
          h_flex()
            .id(`runners-warning-${i}`)
            .gap(8)
            .px(12)
            .py(8)
            .items_center()
            .rounded(RADIUS.md)
            .border_1()
            .border_color(alpha(k.warning, 0.4))
            .bg(alpha(k.warning, 0.06))
            .child(Icon("triangle-alert", { size: 14, color: k.warning }))
            .child(div().flex_1().min_w(0).text_size(TEXT.sm).child(w.text)),
        ),
      );
  }

  serverRow(row, k, sel) {
    const s = row.server;
    return h_flex()
      .id(`runners-row-${row.key}`)
      .h(50)
      .px(12)
      .gap(10)
      .items_center()
      .rounded(RADIUS.md)
      .cursor_pointer()
      .bg(sel ? k.selected : k.background)
      .when(!sel, (e) => e.hover((x) => x.bg(k.accent)))
      .child(s.warned ? Icon("triangle-alert", { size: 14, color: k.warning }) : Icon("server", { size: 14, color: k.mutedFg }))
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
              .child(div().truncate().text_size(TEXT.base).font_medium().child(s.name))
              .child(div().text_size(TEXT.xs).text_color(k.mutedFg).child(s.role))
              .child(div().text_size(TEXT.xs).text_color(k.mutedFg).child(statusWords(s))),
          )
          .child(
            div()
              .truncate()
              .text_size(TEXT.xs)
              .text_color(s.next?.overdue ? k.warning : k.mutedFg)
              .child([phaseWords(s), s.age, s.next?.text].filter(Boolean).join(" · ")),
          ),
      )
      .when(this.width >= 760 && Boolean(s.cost), (e) => e.child(div().flex_none().text_size(TEXT.xs).text_color(k.mutedFg).child(costWords(s.cost))));
  }

  list(k, stale) {
    const rows = this.rows();
    if (!rows.length) return [Empty({ icon: "server", title: "No servers", description: "ci-runners has no cloud servers right now." })];
    return rows.map((row) => v_flex().flex_none().px(4).h(50).when(stale, (e) => e.opacity(0.5))
      .child(this.serverRow(row, k, row.key === this.sel).on_click((_e, cx) => {
        this.select(row.key, cx);
        this.handle.focus();
        cx.notify();
      })));
  }

  fact(label, value, k, { mono = false } = {}) {
    if (value === null || value === undefined || value === "") return null;
    return h_flex()
      .gap(12)
      .items_start()
      .child(div().w(84).flex_none().text_size(TEXT.xs).text_color(k.mutedFg).child(label))
      .child(mono ? Mono(String(value), { size: TEXT.xs }) : div().flex_1().min_w(0).whitespace_normal().text_size(TEXT.sm).child(String(value)));
  }

  side(k) {
    const s = this.server(this.sel);
    if (!s) return null;
    const runner = s.runner ? [s.runner.online ? "online" : "offline", s.runner.busy ? "busy" : "idle"].join(" · ") : null;
    return SidePanel("runners-side", {
      title: s.name,
      description: s.role,
      width: SIDE_WIDTH,
      children: [
        v_flex()
          .gap(6)
          .children(
            [
              this.fact("Status", statusWords(s), k),
              this.fact("Phase", phaseWords(s), k),
              this.fact("Age", s.age, k),
              this.fact("Next", s.next?.text, k),
              this.fact("Cost (estimate)", s.cost, k),
              this.fact("Runner", s.runner?.name, k, { mono: true }),
              this.fact("Runner is", runner, k),
              this.fact("Flavor", s.flavor, k, { mono: true }),
              this.fact("Size", s.size, k),
              this.fact("Image", s.image, k, { mono: true }),
              this.fact("Trial", s.trial_label, k, { mono: true }),
              this.fact("Server", s.id, k, { mono: true }),
            ].filter(Boolean),
          ),
      ],
    });
  }

  /** The live data: warnings, tiles and the list, dimmed and labelled when the tick is stale. */
  live(k) {
    const m = this.model;
    const stale = Boolean(m.tick?.stale);
    const asOf = stale && m.tick.ago ? `as of ${m.tick.ago} ago` : null;
    const failed = m.tick?.error_text ? `last tick: ${m.tick.error_text}` : null;
    const header = v_flex().pb(6).gap(12).flex_none()
      .children([this.warnings(k), this.autoscale(k), this.history(k)].filter(Boolean))
      .when(Boolean(asOf), (e) => e.child(div().text_size(TEXT.xs).text_color(k.warning).child(asOf)))
      .when(Boolean(failed), (e) => e.child(div().text_size(TEXT.xs).text_color(k.warning).whitespace_normal().child(failed)))
      .child(v_flex().when(stale, (e) => e.opacity(0.5)).child(this.tiles()));
    let body = v_flex().id("runners-body").flex_1().h_full().min_w(0).min_h(0).px(24).py(16).gap(2)
      .overflow_y_scrollbar().child(header).children(this.list(k, stale));
    if (this.scroll) body = body.track_scroll(this.scroll);
    return h_flex().flex_1().min_h(0).child(body)
      .when(this.width >= SIDE_AT, (e) => e.child(this.side(k) ?? div()));
  }

  body(k) {
    const m = this.model;
    if (!m) {
      if (this.status.startsWith("error")) return ErrorState({ title: "Cannot reach the cockpit hub", message: this.status.slice(7) });
      return v_flex().flex_1().p(24).gap(16).child(h_flex().gap(12).children([0, 1, 2, 3].map(() => Skeleton({ h: 96 })))).children([0, 1, 2, 3].map(() => Skeleton({ h: 50 })));
    }
    if (m.state === "absent")
      return Empty({
        icon: "server",
        title: "ci-runners is not installed here",
        description: "Install ci-runners on the machine the hub runs on (or set CI_RUNNERS_BIN), and its cloud runners show here.",
      });
    if (m.state === "outdated" || m.state === "newer" || m.state === "down") return ErrorState({ title: m.line?.text ?? "ci-runners cannot be read", message: m.error ?? "" });
    if (m.state === "no-tick") return Empty({ icon: "server", title: "The tick has not run yet", description: "Install the tick with: ci-runners tick install" });
    return this.live(k);
  }

  render(_cx) {
    const k = tokens();
    const m = this.model;
    const description = m?.state === "live" ? m.line?.text : "Cloud CI runners from ci-runners";
    const tick = m?.tick;
    const keys = [["j k", "move"], ...autoscaleControls(m).filter((c) => !c.disabled).map((c) => [c.key, c.label.toLowerCase()])];
    if (this.historyWindows().length > 1) keys.push(["w", "24 h / 7 d"]);
    const out = v_flex()
      .id("runners")
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
      .child(
        PageHeader({
          icon: "server",
          title: "Runners",
          description,
          actions: tickText(m) ? [Badge(tickText(m), tick.stale || tick.ok === false ? "warning" : "outline", { icon: "clock" })] : [],
        }),
      )
      .child(this.body(k))
      .child(KeyHints(keys));
    const toasts = this.toasts.render();
    return toasts ? out.child(toasts) : out;
  }
}
