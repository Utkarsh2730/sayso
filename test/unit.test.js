import { test } from "node:test";
import assert from "node:assert/strict";
import { completeness, CALL_SCHEMA } from "../lib/extract.js";
import { toCsv } from "../lib/store.js";

test("completeness counts filled key fields", () => {
  assert.equal(completeness({ contact_name: "Priya", company: "Acme", email: "", next_step: "Send proposal" }), 3 / 8);
});

test("schema requires every property", () => {
  assert.deepEqual([...CALL_SCHEMA.required].sort(), Object.keys(CALL_SCHEMA.properties).sort());
});

test("csv neutralises spreadsheet formulas", () => {
  const row = toCsv([{ contact_name: "=HYPERLINK(\"http://evil\")", company: "-2+3" }]).split("\n")[1];
  assert.match(row, /^,"'=HYPERLINK/);
  assert.match(row, /,'-2\+3,/);
});

test("csv escapes commas, quotes and lists", () => {
  const csv = toCsv([{ contact_name: 'Priya "P" Nair', summary: "a, b", pain_points: ["x", "y"] }]);
  const row = csv.split("\n")[1];
  assert.match(row, /"Priya ""P"" Nair"/);
  assert.match(row, /"a, b"/);
  assert.match(row, /x; y/);
});

