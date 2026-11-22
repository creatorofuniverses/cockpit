// The Runners space: the cloud CI servers and runners that ci-runners manages, as the hub's `runners` view gives them.
// Above, the counts and the estimated cost now; below, one row per server with what it does and what the service will
// do next; beside the list, the selected server's facts. The screen only reads: ci-runners does the work.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import * as hub from "./hub.js";
import { tokens, TEXT, RADIUS, Icon, Badge, PageHeader, KeyHints, Empty, ErrorState, Skeleton, Scroller, SidePanel, Mono, Metric, Tiles, alpha } from "./ui.js";

const SIDE_AT = 960;
const STATS_NOTE = "Stats over a period will show here once ci-runners has stats --json.";

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

/** The tiles above the list; Queued and Cost now appear only when the service sends them. */
export function tiles(model) {
  const t = model?.tiles;
  if (model?.state !== "live" || !t) return [];
  const out = [
    { id: "servers", label: "Servers", value: t.servers, icon: "server" },
    { id: "busy", label: "Busy", value: `${t.busy} / ${t.runners}`, icon: "play", hint: "runners working" },
  ];
  if (t.queued != null) out.push({ id: "queued", label: "Queued", value: t.queued, icon: "hourglass", hint: t.queue_ago ? `as of ${t.queue_ago} ago` : undefined, hintWarn: Boolean(t.queue_stale) });
  if (t.cost != null) out.push({ id: "cost", label: "Cost now", value: t.cost, icon: "gauge", hint: "estimate" });
  return out;
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
    this.scroller = new Scroller();
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
    this.select(rows[Math.max(0, Math.min(rows.length - 1, (at < 0 ? 0 : at) + by))].key, cx);
  }

  key(e, cx) {
    const s = e.keystroke;
    if (s === "j" || s === "down") this.move(1, cx);
    else if (s === "k" || s === "up") this.move(-1, cx);
    else return false;
    cx.notify();
    return true;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Drawing

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

  list(k) {
    const rows = this.rows();
    if (!rows.length) return Empty({ icon: "server", title: "No servers", description: "ci-runners has no cloud servers right now." });
    const at = rows.findIndex((r) => r.key === this.sel);
    const items = rows.map((row) => ({
      height: 50,
      el: this.serverRow(row, k, row.key === this.sel).on_click((_e, cx) => {
        this.select(row.key, cx);
        this.handle.focus();
        cx.notify();
      }),
    }));
    return this.scroller.view("runners-list", items, at, { gap: 2, padding: 4 });
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
      width: 400,
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
    return h_flex()
      .flex_1()
      .min_h(0)
      .child(
        v_flex()
          .flex_1()
          .h_full()
          .min_w(0)
          .min_h(0)
          .child(
            v_flex()
              .px(24)
              .pt(16)
              .pb(8)
              .gap(12)
              .flex_none()
              .child(this.warnings(k) ?? div())
              .when(Boolean(asOf), (e) => e.child(div().text_size(TEXT.xs).text_color(k.warning).child(asOf)))
              .when(Boolean(failed), (e) => e.child(div().text_size(TEXT.xs).text_color(k.warning).whitespace_normal().child(failed)))
              .child(v_flex().when(stale, (e) => e.opacity(0.5)).child(this.tiles())),
          )
          .child(v_flex().flex_1().min_h(0).px(20).when(stale, (e) => e.opacity(0.5)).child(this.list(k)))
          .child(div().px(24).py(8).flex_none().text_size(TEXT.xs).text_color(k.mutedFg).child(STATS_NOTE)),
      )
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
    return v_flex()
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
      .child(KeyHints([["j k", "move"]]));
  }
}
