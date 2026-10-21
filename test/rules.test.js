// The built-in engine on realistic dictated recaps (today is fixed to Wednesday 21 Oct 2026).
import { test } from "node:test";
import assert from "node:assert/strict";
import { extract, revise, followup, ask, wordsToNumber, findEmail, findPhone } from "../lib/rules.js";

const TODAY = "2026-10-21";

test("numbers said as words", () => {
  assert.equal(wordsToNumber("four"), 4);
  assert.equal(wordsToNumber("two point four"), 2.4);
  assert.equal(wordsToNumber("one and a half"), 1.5);
  assert.equal(wordsToNumber("twenty five"), 25);
});

test("spoken emails and phone numbers", () => {
  assert.equal(findEmail("her email is priya dot n at acme logistics dot co dot in"), "priya.n@acmelogistics.co.in");
  assert.equal(findEmail("mail me at sam@zeta.io please"), "sam@zeta.io");
  assert.equal(findPhone("his number is 98765 43210"), "+91 98765 43210");
  assert.equal(findPhone("call nine eight seven six five four three two one zero"), "+91 98765 43210");
});

test("founder recap with a proposal and lakh amount", () => {
  const r = extract("Spoke with rahul mehta from Zeta Foods, he's the founder. Supplier orders get lost in WhatsApp. He wants pricing for all three outlets, about two point four lakh a year. I'll send a revised proposal tomorrow.", TODAY);
  assert.equal(r.contact_name, "Rahul Mehta");
  assert.equal(r.company, "Zeta Foods");
  assert.equal(r.role, "Founder");
  assert.equal(r.deal_stage, "proposal");
  assert.equal(r.deal_value, "₹2,40,000/yr");
  assert.equal(r.next_step, "Send a revised proposal tomorrow");
  assert.equal(r.follow_up_date, "2026-10-22");
  assert.ok(r.pain_points.some((p) => /lost in WhatsApp/.test(p)));
});

test("negotiation in dollars, department isn't mistaken for the company", () => {
  const r = extract("Had a quick chat with Sarah Lee, VP of Sales at Northwind. Deal is around $24k per year. Legal is reviewing the contract and they asked for a discount. Follow up next week.", TODAY);
  assert.equal(r.company, "Northwind");
  assert.equal(r.role, "VP of Sales");
  assert.equal(r.deal_stage, "negotiation");
  assert.equal(r.deal_value, "$24,000/yr");
  assert.equal(r.follow_up_date, "2026-10-26"); // next Monday
});

test("lost and won deals", () => {
  assert.equal(extract("Call with Farah Khan at Nimbus Clinics. She liked it but there's no budget left this year.", TODAY).deal_stage, "lost");
  const won = extract("Met Arjun, COO at Kitebird Travel. They signed for their six person sales desk!", TODAY);
  assert.equal(won.deal_stage, "won");
  assert.equal(won.contact_name, "Arjun");
  assert.equal(won.company, "Kitebird Travel");
});

test("corrections change only what was said", () => {
  const r = extract("Call with Priya Nair at Acme Logistics. Budget is four lakh a year. Follow up Friday.", TODAY);
  assert.equal(revise(r, "change the stage to proposal", TODAY).deal_stage, "proposal");
  assert.equal(revise(r, "move the follow-up to Monday", TODAY).follow_up_date, "2026-10-26");
  const both = revise(r, "the value is five lakh and the stage is negotiation", TODAY);
  assert.equal(both.deal_value, "₹5,00,000/yr");
  assert.equal(both.deal_stage, "negotiation");
  assert.equal(both.company, "Acme Logistics");
  assert.throws(() => revise(r, "hmm okay", TODAY));
});

test("follow-up email and pipeline answers", () => {
  const r = extract("Just got off a call with Priya Nair, she's head of ops at Acme Logistics. They're losing two hours a day on manual dispatch spreadsheets. She wants a demo. I'll send the invite today and follow up Thursday.", TODAY);
  const mail = followup(r, "", "Sam");
  assert.match(mail.subject, /Demo for Acme Logistics/);
  assert.match(mail.body, /manual dispatch spreadsheets/);
  assert.match(mail.body, /Thursday 22 October/);
  const calls = [{ ...r, id: "a", created_at: "2026-10-21T10:00:00Z" }, { ...extract("Call with Farah Khan at Nimbus Clinics. Not interested, no budget left this year.", TODAY), id: "b", created_at: "2026-10-20T10:00:00Z" }];
  assert.match(ask(calls, "who should I follow up with this week?", TODAY).answer, /Priya Nair.*\[C1\]/);
  assert.match(ask(calls, "summarise my pipeline by stage", TODAY).answer, /Lost: 1/);
  assert.match(ask(calls, "what did Farah say?", TODAY).answer, /\[C2\]/);
});
