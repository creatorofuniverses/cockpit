import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import { test } from "node:test";

// The hub's runners model for the acme demo servers, as the Rust side's snapshot test writes it.
const SNAPSHOT = new URL("../../herdr/tui/runners/src/snapshots/cockpit_runners__model__tests__the_live_status_becomes_tiles_rows_and_a_line.snap", import.meta.url);

async function model() {
  const text = await readFile(SNAPSHOT, "utf8");
  return JSON.parse(text.split("---\n").slice(2).join("---\n"));
}

async function fixture() {
  const calls = [], acts = [];
  const context = createContext({ console });
  const imports = {
    herdr: { run: (...args) => calls.push(args), setShared: (...args) => calls.push(["shared", ...args]), panes: () => [], spaces: () => [] },
    "./hub.js": { act: async (...args) => (acts.push(args), { note: "ok" }), openUrl: async () => ({ code: 0 }) },
  };
  const sources = new Map(), modules = new Map();
  const folder = new URL("../mods/cockpit/", import.meta.url);
  for (const name of await readdir(folder)) {
    if (!name.endsWith(".js")) continue;
    const text = await readFile(new URL(name, folder), "utf8");
    sources.set(`./${name}`, text);
    for (const match of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*"(herdr|gpui-kit|gpui-base)"/g)) {
      const exports = imports[match[2]] ??= {};
      for (const word of match[1].split(",")) {
        const key = word.trim().split(/\s+as\s+/)[0];
        exports[key] ??= () => { throw new Error(`unexpected native call: ${key}`); };
      }
    }
  }
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    const native = imports[name];
    const module = native
      ? new SyntheticModule(Object.keys(native), function () {
        for (const [key, value] of Object.entries(native)) this.setExport(key, value);
      }, { context })
      : new SourceTextModule(sources.get(name), { context, identifier: name });
    modules.set(name, module);
    return module;
  }
  const module = new SourceTextModule('export * from "./runners.js"; export { default as Runners } from "./runners.js"; export { autoApps } from "./sidebar.js";', { context });
  await module.link(load);
  await module.evaluate();
  return { runners: module.namespace, calls, acts };
}

/** A Runners view on a model, without the hub subscription init starts. */
function view(f, m) {
  const v = Object.create(f.runners.Runners.prototype);
  Object.assign(v, { model: m, sel: null, historyWindow: "24h", historyHover: null });
  return v;
}

const cx = { notify() {} };
/** A value from the mod's context as plain JSON, so deepEqual compares it across realms. */
const plain = (x) => JSON.parse(JSON.stringify(x));

test("rows follow the model's servers", async () => {
  const f = await fixture();
  const m = await model();
  assert.deepEqual(plain(f.runners.serverRows(m).map((r) => r.server.name)), ["sel-ci-demo1", "sel-ci-demo2", "sel-img-demo"]);
  assert.deepEqual(plain(f.runners.serverRows({ state: "down" })), []);
  assert.deepEqual(plain(f.runners.serverRows(null)), []);
});

test("line and badge come from the model as they are", async () => {
  const f = await fixture();
  const m = await model();
  assert.deepEqual(plain(f.runners.runnersLine(m)), m.line);
  assert.deepEqual(plain(f.runners.runnersBadge(m)), m.badge);
  assert.equal(f.runners.runnersLine(null), null);
  assert.equal(f.runners.runnersBadge(null), null);
});

test("j and k walk the servers", async () => {
  const f = await fixture();
  const v = view(f, await model());
  const name = () => v.server(v.sel)?.name;
  v.select(v.rows()[0].key, cx);
  v.key({ keystroke: "j" }, cx);
  assert.equal(name(), "sel-ci-demo2");
  v.key({ keystroke: "j" }, cx);
  v.key({ keystroke: "j" }, cx);
  assert.equal(name(), "sel-img-demo");
  v.key({ keystroke: "k" }, cx);
  assert.equal(name(), "sel-ci-demo2");
  assert.equal(v.key({ keystroke: "x" }, cx), false);
});

test("the Autoscale badge names and colors all service states", async () => {
  const f = await fixture();
  const m = await model();
  for (const [state, label, variant] of [
    ["on", "On", "success"],
    ["blocked", "On · blocked", "warning"],
    ["error", "On · error", "destructive"],
    ["paused", "Paused", "warning"],
    ["off", "Off in config", "secondary"],
  ]) {
    assert.deepEqual(plain(f.runners.autoscaleBadge({ ...m, autoscale: { ...m.autoscale, state } })), { label, variant });
  }
  assert.equal(f.runners.autoscaleBadge({ ...m, autoscale: null }), null);
});

test("the maximum, waiting figure and pause reason reflect the service", async () => {
  const f = await fixture();
  const m = await model();
  const edit = (a) => ({ ...m, autoscale: { ...m.autoscale, ...a } });
  assert.equal(f.runners.maxCaption(m), "from config · cap 6");
  assert.equal(f.runners.maxCaption(edit({ max_source: "set-max" })), "set here · cap 6");
  assert.deepEqual(plain(f.runners.waitingFigure(m)), { value: "2" });
  assert.deepEqual(plain(f.runners.waitingFigure(edit({ waiting: { count: null } }))), { value: "—", hint: "not read" });
  assert.deepEqual(plain(f.runners.waitingFigure(edit({ waiting: { count: 0 } }))), { value: "0" });
  const { waiting, ...older } = m.autoscale;
  assert.equal(f.runners.waitingFigure({ ...m, autoscale: older }), null);
  assert.equal(f.runners.pauseCaption(edit({ paused: true, paused_by: "cockpit", paused_ago: "5m", pause_reason: "deploy freeze" })), "by cockpit 5m ago · deploy freeze");
  assert.equal(f.runners.pauseCaption(edit({ paused: true, pause_reason: "control.json: unexpected end of JSON input" })), "control.json: unexpected end of JSON input");
  assert.equal(f.runners.pauseCaption(m), null);
});

test("History selects the window chart, tiles and notes", async () => {
  const f = await fixture();
  const m = await model();
  const daily = plain(f.runners.historyView(m, "24h"));
  assert.equal(daily.tiles.length, 6);
  assert.equal(daily.tiles[0].label, "Launched");
  assert.match(daily.tiles[0].hint, /1 still running/);
  assert.equal(daily.tiles[2].label, "Wasted");
  assert.equal(daily.tiles[2].value, 2);
  assert.equal(daily.tiles[2].tone, "warning");
  assert.equal(daily.chart.series.find((s) => s.key === "waiting").line, true);
  assert.deepEqual(daily.notes.map((n) => n.text), [
    "data covers 73% of the period",
    "partly estimated from snapshots",
    "some server lifetimes are bounded",
    "≈ at 4.34 ₽ per started server-hour",
  ]);
  assert.equal(f.runners.historyView(m, "7d").chart.labels.at(-1), "today");
  assert.deepEqual(plain(f.runners.historyView({ history: { error: "boom" } }, "24h")), { error: "boom" });
  assert.equal(f.runners.historyView({ history: null }, "24h"), null);

  m.history.windows["24h"].tiles[3] = { id: "spent", label: "Spent", value: "—", hint: "no price in config" };
  assert.equal(f.runners.historyView(m, "24h").tiles[3].hint, "no price in config");
  const notes = [{ text: "no-journal", tone: "warning" }];
  assert.deepEqual(plain(f.runners.historyView({ history: { empty: true, notes } }, "24h")), { empty: true, notes });
});

test("w toggles History windows only when the choices are available", async () => {
  const f = await fixture();
  const m = await model();
  const v = view(f, m);
  v.historyHover = 12;
  assert.equal(v.key({ keystroke: "w" }, cx), true);
  assert.equal(v.historyWindow, "7d");
  assert.equal(v.historyHover, null);
  assert.equal(v.key({ keystroke: "w" }, cx), true);
  assert.equal(v.historyWindow, "24h");
  for (const history of [null, { empty: true }, { error: "boom" }]) {
    const hidden = view(f, { ...m, history });
    assert.equal(hidden.key({ keystroke: "w" }, cx), false);
    assert.equal(hidden.historyWindow, "24h");
  }
});

test("the Autoscale controls follow the service's state and features", async () => {
  const f = await fixture();
  const m = await model();
  const all = (a) => f.runners.autoscaleControls({ ...m, autoscale: { ...m.autoscale, ...a } });
  const ids = (a) => plain(all(a).map((c) => c.id));
  assert.deepEqual(ids({}), ["pause", "less", "more"]);
  assert.deepEqual(ids({ max_source: "set-max" }), ["pause", "less", "more", "reset"]);
  assert.deepEqual(ids({ paused: true }), ["resume", "less", "more"]);
  assert.deepEqual(ids({ can_pause: false }), ["less", "more"]);
  assert.deepEqual(ids({ can_set_max: false, max_source: "set-max" }), ["pause"]);
  assert.deepEqual(ids({ on: false }), []);
  assert.equal(all({ max: 0 }).find((c) => c.id === "less").disabled, true);
  assert.equal(all({ max: 6 }).find((c) => c.id === "more").disabled, true);
  assert.equal(all({}).find((c) => c.id === "less").disabled, false);
  assert.equal(all({}).find((c) => c.id === "pause").key, "p");
});

test("p, plus, minus and 0 send the autoscale acts, once at a time", async () => {
  const f = await fixture();
  const m = await model();
  const press = (a, keystrokes) => {
    const v = view(f, { ...m, autoscale: { ...m.autoscale, ...a } });
    const sent = [];
    v.send = (_cx, action, args) => sent.push(plain([action, args]));
    const cx2 = { notify() {}, spawn: (fn) => fn(cx2) };
    for (const keystroke of keystrokes) v.key({ keystroke }, cx2);
    return sent;
  };
  assert.deepEqual(press({}, ["p"]), [["pause", []]]);
  assert.deepEqual(press({ paused: true }, ["p"]), [["resume", []]]);
  assert.deepEqual(press({}, ["+"]), [["set-max", [4]]]);
  assert.deepEqual(press({}, ["="]), [["set-max", [4]]]);
  assert.deepEqual(press({}, ["-"]), [["set-max", [2]]]);
  assert.deepEqual(press({}, ["0"]), []);
  assert.deepEqual(press({ max_source: "set-max" }, ["0"]), [["reset-max", []]]);
  assert.deepEqual(press({ max: 0 }, ["-"]), []);
  assert.deepEqual(press({}, ["p", "+", "-"]), [["pause", []]]);
});

test("no queue tile when the service sends none", async () => {
  const f = await fixture();
  const m = await model();
  assert.deepEqual(plain(f.runners.tiles(m).map((t) => t.label)), ["Servers", "Busy", "Waiting", "Cost now"]);
  assert.equal(plain(f.runners.tiles(m)).find((t) => t.label === "Waiting").hint, "as of 4m ago");
  const queued = (stale) => plain(f.runners.tiles({ ...m, tiles: { ...m.tiles, queue_stale: stale } })).find((t) => t.label === "Waiting");
  assert.equal(queued(true).hintWarn, true);
  assert.equal(queued(false).hintWarn, false);
  assert.equal(f.runners.tiles({ ...m, tiles: { ...m.tiles, queue_label: "Queued" } })[2].label, "Queued");
  m.tiles.queued = null;
  m.tiles.cost = null;
  assert.deepEqual(plain(f.runners.tiles(m).map((t) => t.label)), ["Servers", "Busy"]);
  assert.deepEqual(plain(f.runners.tiles({ state: "down" })), []);
});

test("the header says nothing about the tick when it has not run", async () => {
  const f = await fixture();
  const m = await model();
  assert.equal(f.runners.tickText(m), "tick <1m ago");
  const none = { ...m, state: "no-tick", tick: { ago: null, ok: false, errors: 0, stale: false } };
  assert.equal(f.runners.tickText(none), null);
  assert.equal(f.runners.tickText({ state: "absent" }), null);
  assert.equal(f.runners.tickText({ ...m, tick: { ...m.tick, ok: false, errors: 1 } }), "tick <1m ago · 1 error");
  assert.equal(f.runners.tickText({ ...m, tick: { ...m.tick, ok: false, errors: 3 } }), "tick <1m ago · 3 errors");
  assert.equal(f.runners.tickText({ ...m, tick: { ...m.tick, ok: false, errors: 0 } }), "tick <1m ago · failed");
});

test("a server the tick leaves alone and one with unlisted runners say so", async () => {
  const f = await fixture();
  assert.equal(f.runners.phaseWords({ phase: "unowned" }), "not managed by tick");
  assert.equal(f.runners.phaseWords({ phase: "unknown" }), "runner unknown");
  const m = await model();
  assert.equal(f.runners.phaseWords(m.servers[1]), "idle 14m");
});

test("every cost on a server is marked as an estimate", async () => {
  const f = await fixture();
  assert.equal(f.runners.costWords("≈ 13 ₽"), "≈ 13 ₽ estimate");
  assert.equal(f.runners.costWords(null), null);
});

test("the sidebar shows Runners only when the hub finds ci-runners", async () => {
  const f = await fixture();
  const spaces = ["inbox", "todo"];
  assert.deepEqual(plain(f.runners.autoApps(spaces, { runners: "absent" })), ["inbox", "todo"]);
  assert.deepEqual(plain(f.runners.autoApps(spaces, {})), ["inbox", "todo"]);
  assert.deepEqual(plain(f.runners.autoApps(spaces, { runners: "live" })), ["inbox", "todo", "runners"]);
  assert.deepEqual(plain(f.runners.autoApps(spaces, { aq: "live", runners: "down" })), ["inbox", "todo", "aq", "runners"]);
  assert.deepEqual(plain(f.runners.autoApps(["runners"], { runners: "live" })), ["runners"]);
});

test("cmd-alt-9 opens Runners in the cockpit layout", async () => {
  const keys = JSON.parse(await readFile(new URL("../keys.json", import.meta.url), "utf8"));
  assert.equal(keys["layout:cockpit"]["cmd-alt-9"], "cockpit.go:runners");
  for (const layout of ["cockpit", "cockpit-chat"]) {
    const l = await readFile(new URL(`../layouts/${layout}.json`, import.meta.url), "utf8");
    assert.match(l, /"app":\s*"runners"/, `${layout} has a runners block`);
  }
});
