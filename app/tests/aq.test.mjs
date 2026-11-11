import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import { test } from "node:test";

// The hub's aq model for the acme demo dashboard, as the Rust side's snapshot test writes it.
const SNAPSHOT = new URL("../../herdr/tui/aq/src/snapshots/cockpit_aq__model__tests__the_dashboard_splits_into_running_queued_held_and_recent.snap", import.meta.url);

async function model() {
  const text = await readFile(SNAPSHOT, "utf8");
  return JSON.parse(text.split("---\n").slice(2).join("---\n"));
}

async function fixture() {
  const calls = [], acts = [];
  const context = createContext({ console });
  const imports = {
    herdr: { run: (...args) => calls.push(args), setShared: (...args) => calls.push(["shared", ...args]), panes: () => [] },
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
  const module = new SourceTextModule('export * from "./aq.js"; export { default as Aq } from "./aq.js";', { context });
  await module.link(load);
  await module.evaluate();
  return { aq: module.namespace, calls, acts };
}

/** An Aq view on a model, without the hub subscription init starts. */
function view(f, m, { remote = false, agents = null } = {}) {
  const v = Object.create(f.aq.Aq.prototype);
  Object.assign(v, { model: m, agents, remote, sel: null, stream: "stdout", logKey: null, confirm: null, follow() {} });
  return v;
}

const cx = { notify() {}, spawn: (fn) => fn(cx) };
/** A value from the mod's context as plain JSON, so deepEqual compares it across realms. */
const plain = (x) => JSON.parse(JSON.stringify(x));

test("the list groups running, queued, reservations with their tasks, and recent", async () => {
  const f = await fixture();
  const rows = f.aq.listRows(await model());
  assert.deepEqual(plain(rows.filter((r) => r.kind === "heading").map((r) => `${r.label} ${r.count}`)), ["Running 2", "Queued 2", "Reservations 1", "Recent 5"]);
  const nested = rows.filter((r) => r.nested).map((r) => r.item.name);
  assert.deepEqual(plain(nested), ["e2e"]);
  assert.equal(rows[rows.findIndex((r) => r.item?.name === "e2e-stand") + 1].item.name, "e2e");
  assert.deepEqual(plain(f.aq.listRows({ state: "down" })), []);
});

test("an item finds the agent that queued it by session", async () => {
  const f = await fixture();
  const agents = { agents: [{ address: "t3", session: "0b7f3e9a-1c2d-4e5f-8a9b-0c1d2e3f4a5b", title: "Maya's API agent" }] };
  assert.equal(f.aq.agentFor(agents, "0b7f3e9a-1c2d-4e5f-8a9b-0c1d2e3f4a5b").address, "t3");
  assert.equal(f.aq.agentFor(agents, "thread-sam-7"), null);
  assert.equal(f.aq.agentFor({ remote: "runner", agents: agents.agents }, "0b7f3e9a-1c2d-4e5f-8a9b-0c1d2e3f4a5b").address, "runner/t3");
});

test("a remote desk offers logs and results only", async () => {
  const f = await fixture();
  const m = await model();
  const running = m.running[0], held = m.reservations[0];
  assert.deepEqual(plain(view(f, m).acts(running).map((a) => a.id)), ["logs", "cancel"]);
  assert.deepEqual(plain(view(f, m).acts(held).map((a) => a.id)), ["extend", "release"]);
  assert.deepEqual(plain(view(f, m, { remote: true }).acts(running).map((a) => a.id)), ["logs"]);
  assert.deepEqual(plain(view(f, m, { remote: true }).acts(held).map((a) => a.id)), []);
});

test("cancel asks first, then sends aq's cancel; extend sends its ttl", async () => {
  const f = await fixture();
  const m = await model();
  const v = view(f, m);
  v.toasts = { push() {} };
  v.act("cancel", m.running[0].id, null, cx);
  assert.equal(v.confirm.id, "cancel");
  assert.equal(f.acts.length, 0);
  v.act("cancel", m.running[0].id, null, cx, true);
  v.act("extend", m.reservations[0].id, "2h", cx);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(plain(f.acts), [["aq", "cancel", [m.running[0].id]], ["aq", "extend", [m.reservations[0].id, "2h"]]]);
});

test("j, k and the group keys walk the items", async () => {
  const f = await fixture();
  const m = await model();
  const v = view(f, m);
  const names = () => v.item(v.sel)?.name;
  v.select(v.items()[0].key, cx);
  v.key({ keystroke: "j" }, cx);
  assert.equal(names(), "build-web");
  v.key({ keystroke: "]" }, cx);
  assert.equal(names(), "tests");
  v.key({ keystroke: "]" }, cx);
  assert.equal(names(), "e2e-stand");
  v.key({ keystroke: "[" }, cx);
  assert.equal(names(), "tests");
});
