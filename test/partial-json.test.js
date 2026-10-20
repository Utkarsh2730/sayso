import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePartialJson } from "../lib/partial-json.js";

const full = JSON.stringify({ a: "hello \"world\"", list: ["x", "y"], b: "₹4,00,000", nested: { c: "d" } });

test("every prefix parses to null or a consistent partial object", () => {
  for (let i = 0; i <= full.length; i++) {
    const p = parsePartialJson(full.slice(0, i));
    if (p === null) continue;
    assert.equal(typeof p, "object");
    if ("b" in p) assert.ok("₹4,00,000".startsWith(p.b));
    if (p.list) for (const item of p.list) assert.ok(["x", "y"].some((v) => v.startsWith(item)));
  }
  assert.deepEqual(parsePartialJson(full), JSON.parse(full));
});

test("streams value strings as they're typed", () => {
  assert.deepEqual(parsePartialJson('{"summary":"Acme lose'), { summary: "Acme lose" });
});

test("drops half-written keys", () => {
  assert.deepEqual(parsePartialJson('{"a":"x","comp'), { a: "x" });
});

test("handles a dangling escape", () => {
  assert.deepEqual(parsePartialJson('{"a":"say \\'), { a: "say " });
});
