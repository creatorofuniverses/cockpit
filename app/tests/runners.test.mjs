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
  const module = new SourceTextModule('export * from "./runners.js"; export { default as Runners } from "./runners.js";', { context });
  await module.link(load);
  await module.evaluate();
  return { runners: module.namespace, calls, acts };
}

/** A Runners view on a model, without the hub subscription init starts. */
function view(f, m) {
  const v = Object.create(f.runners.Runners.prototype);
  Object.assign(v, { model: m, sel: null });
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

test("no queue tile when the service sends none", async () => {
  const f = await fixture();
  const m = await model();
  assert.deepEqual(plain(f.runners.tiles(m).map((t) => t.label)), ["Servers", "Busy", "Queued", "Cost now"]);
  assert.equal(plain(f.runners.tiles(m)).find((t) => t.label === "Queued").hint, "as of 4m ago");
  m.tiles.queued = null;
  m.tiles.cost = null;
  assert.deepEqual(plain(f.runners.tiles(m).map((t) => t.label)), ["Servers", "Busy"]);
  assert.deepEqual(plain(f.runners.tiles({ state: "down" })), []);
});
