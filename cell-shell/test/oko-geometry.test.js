const test = require("node:test");
const assert = require("node:assert");
const { viewportToDevice } = require("../oko-geometry");

test("viewport CSS → device px (scale 1)", () => {
  const r = viewportToDevice({ left: 10, top: 20, w: 100, h: 50 },
                             { x: 960, y: 96, width: 2560, height: 1440 }, 1);
  assert.deepStrictEqual(r, { x: 970, y: 116, w: 100, h: 50 });
});

test("HiDPI scale 2", () => {
  const r = viewportToDevice({ left: 5, top: 5, w: 10, h: 10 },
                             { x: 0, y: 0, width: 800, height: 600 }, 2);
  assert.deepStrictEqual(r, { x: 10, y: 10, w: 20, h: 20 });
});
