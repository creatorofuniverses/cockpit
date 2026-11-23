import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

async function fixture() {
  const paths = [], text = [], dots = [];
  const create = () => {
    const el = new Proxy({}, {
      get: (_target, name) => (...args) => {
        if (name === "when" && args[0]) args[1](el);
        if (name === "child" && typeof args[0] === "string") text.push(args[0]);
        if (name === "size" && args[0] === 6) dots.push(el);
        return el;
      },
    });
    return el;
  };
  const stroke = (width) => {
    const points = [];
    const path = {
      move_to: (x, y) => (points.push(["move", x, y]), path),
      line_to: (x, y) => (points.push(["line", x, y]), path),
      build: () => ({ width, points }),
    };
    return path;
  };
  const context = createContext({ window: { paint_path: (path) => (paths.push(path), create()) } });
  const imports = {
    "gpui-kit": { div: create, PathBuilder: { stroke }, Background: {} },
    "gpui-base": { h_flex: create, v_flex: create },
    herdr: { settings: () => ({ zoom: 1 }) },
    "./ui.js": {
      tokens: () => ({}), alpha: (color) => color, TEXT: {}, RADIUS: {}, StatTile() {}, Tiles() {},
    },
  };
  const source = await readFile(new URL("../mods/cockpit/plot.js", import.meta.url), "utf8");
  const module = new SourceTextModule(source, { context });
  await module.link((name) => {
    const native = imports[name];
    return new SyntheticModule(Object.keys(native), function () {
      for (const [key, value] of Object.entries(native)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  return { plot: module.namespace, paths, text, dots };
}

const plain = (x) => JSON.parse(JSON.stringify(x));

const model = {
  kind: "bar", stacked: true, labels: ["one", "two", "three"],
  series: [
    { name: "A", values: [1, 2, 3], color: "#123456" },
    { name: "B", values: [5, 6, 7] },
    { name: "W", values: [8, null, 16], line: true },
  ],
};

test("an overlay line keeps its values out of the stacked bases and totals", async () => {
  const { plot } = await fixture();
  const { series, totals } = plot.prepared(model, null, new Set());
  assert.deepEqual(plain(totals), [6, 8, 10]);
  assert.deepEqual(plain(series[0].base), [0, 0, 0]);
  assert.deepEqual(plain(series[1].base), [1, 2, 3]);
  assert.equal(series[2].base, undefined);
  assert.deepEqual(plain(series[2].values), [8, null, 16]);
});

test("series colors fall back to their place in the palette", async () => {
  const { plot } = await fixture();
  const { series } = plot.prepared(model, null, new Set(["A"]));
  assert.deepEqual(plain(series.map((s) => s.color)), ["#123456", plot.SERIES[1], plot.SERIES[2]]);
});

test("the overlay uses the chart scale and breaks at unknown rows", async () => {
  const { plot, paths, dots } = await fixture();
  plot.Chart("history", {
    ...model,
    labels: ["a", "b", "c", "d", "e"],
    series: [
      { name: "A", values: [1, 2, 3, 4, 5] },
      { name: "W", values: [10, 20, null, null, 15], line: true },
    ],
  });
  const [stroke] = paths.filter((p) => p.width === 2);
  assert.ok(stroke);
  assert.deepEqual(plain(stroke.points), [["move", "10%", "50%"], ["line", "30%", "0%"]]);
  assert.equal(dots.length, 1);
});

test("a chart with no measured rows can show a no-data row note", async () => {
  const { plot, text } = await fixture();
  plot.Chart("history", {
    ...model, labels: ["one", "two", "three"], notes: [null, null, "no data"],
    series: model.series.map((s) => ({ ...s, values: [null, null, null] })),
  }, { window: { start: 1, len: 2 }, hover: 2 });
  assert.ok(text.includes("no data"));
  assert.ok(text.includes("W"));
  assert.ok(!text.includes("Total"));
});

test("a missing history bar does not turn into a measured total", async () => {
  const { plot, text } = await fixture();
  const series = [{ name: "A", values: [null] }, { name: "B", values: [2] }];
  plot.Chart("history", { ...model, labels: ["one"], notes: [null], series }, { hover: 0 });
  assert.ok(text.includes("—"));
  assert.ok(!text.includes("Total"));
});
