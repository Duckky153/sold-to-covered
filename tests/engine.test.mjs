// Tests for the check engine: every check gets a clean order and a broken one,
// and the full sample day must pass its evals (every hidden problem found, no false flags).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluate, runChecks, runEvals, fill } from "../site/engine.js";

const load = (p) => JSON.parse(readFileSync(new URL(`../site/data/${p}`, import.meta.url)));
const config = load("checks.json");
const rule = (id) => config.checks.find((c) => c.id === id).rule;

const clean = {
  id: "T-1", business: "Test Roofing LLC", contact: "Ann", line: "General liability", effective_date: "2026-11-14",
  address: "120 Main St", pay_type: "Paid in full", finance_agreement: "None", down_payment_pct: 100,
  docs_required: ["Signed application", "Loss runs"], docs_received: ["Signed application"], docs_requested: ["Loss runs"],
  premium_sold: 1000, carrier_invoice: 1000, billing: "Agency bill", carrier_billing: "Agency bill",
  source: "Broker", carrier_source: "Broker", certificate_request: null, policy_status: "Ready to bind",
};

test("a clean order raises no flags", () => {
  assert.deepEqual(runChecks(config, [clean]), []);
});

test("pay type is derived from the paperwork, both directions", () => {
  assert.equal(evaluate(rule("pay_type"), { ...clean, finance_agreement: "On file", down_payment_pct: 25 }).derived, "Financed");
  assert.equal(evaluate(rule("pay_type"), { ...clean, pay_type: "Financed" }).derived, "Paid in full");
  assert.equal(evaluate(rule("pay_type"), { ...clean, pay_type: "Financed", finance_agreement: "On file", down_payment_pct: 20 }), null);
});

test("a carrier installment plan (down payment under 100%, no finance agreement) is not financing", () => {
  assert.equal(evaluate(rule("pay_type"), { ...clean, down_payment_pct: 25 }), null);
});

test("PO box addresses are caught in common spellings, street names are not", () => {
  for (const a of ["PO Box 12", "P.O. Box 9", "po box 7", "Post Office Box 3", "POB 12", "PMB 220", "Box 14", "Suite 2, PO Box 9"]) {
    assert.ok(evaluate(rule("po_box"), { ...clean, address: a }), a);
  }
  for (const a of ["12 Boxwood Ln", "40 Post Rd", "7 Pobst Ave", "300 Box Elder Rd"]) {
    assert.equal(evaluate(rule("po_box"), { ...clean, address: a }), null, a);
  }
});

test("a carrier document counts as handled once it is received or asked for", () => {
  const hit = evaluate(rule("carrier_docs"), { ...clean, docs_requested: [] });
  assert.deepEqual(hit.missing, ["Loss runs"]);
  assert.equal(evaluate(rule("carrier_docs"), { ...clean, docs_received: ["Signed application", "Loss runs"], docs_requested: [] }), null);
});

test("amounts within $25 pass, larger gaps either way are flagged", () => {
  assert.equal(evaluate(rule("amounts"), { ...clean, carrier_invoice: 1025 }), null);
  assert.ok(evaluate(rule("amounts"), { ...clean, carrier_invoice: 1030 }));
  assert.ok(evaluate(rule("amounts"), { ...clean, carrier_invoice: 700 }));
  assert.ok(evaluate(rule("amounts"), { ...clean, carrier_invoice: null }), "a missing invoice is flagged");
});

test("billing and source must agree with the carrier, and source must be known", () => {
  assert.ok(evaluate(rule("billing"), { ...clean, carrier_billing: "Direct bill" }));
  assert.ok(evaluate(rule("source"), { ...clean, source: null }));
  assert.ok(evaluate(rule("source"), { ...clean, carrier_source: "Instant quote" }));
});

test("a certificate is only allowed on an active policy", () => {
  const req = { holder: "Test Property Management" };
  assert.ok(evaluate(rule("certificate"), { ...clean, certificate_request: req, policy_status: "Bound" }));
  assert.equal(evaluate(rule("certificate"), { ...clean, certificate_request: req, policy_status: "Active" }), null);
  assert.equal(evaluate(rule("certificate"), { ...clean, policy_status: "Bound" }), null);
});

test("flags explain themselves and mark the fields that caused them", () => {
  const [f] = runChecks(config, [{ ...clean, finance_agreement: "On file", down_payment_pct: 25 }]);
  assert.equal(f.says, "Marked paid in full, but the paperwork says financed.");
  assert.deepEqual(f.evidence.filter((e) => e.hit).map((e) => e.field), ["pay_type"]);
  assert.equal(f.owner, "Agent");
});

test("customer messages list what is missing and never mention coverage", () => {
  const [f] = runChecks(config, [{ ...clean, docs_requested: [] }]);
  assert.match(f.customer_message, /needs your loss runs/);
  assert.doesNotMatch(f.customer_message, /cover/i);
  assert.equal(fill("{missing}", clean, { missing: ["A", "B", "C"] }), "A, B and C");
});

test("one message lists every missing document: the new one, plus a reminder for ones already asked for (issue #1)", () => {
  // SO-24109: application received, owner exclusion form asked for, payroll estimate asked for by nobody.
  const magnolia = {
    ...clean, contact: "Linda", line: "Workers' comp", effective_date: "2026-11-15",
    docs_required: ["Signed application", "Payroll estimate", "Owner exclusion form"],
    docs_received: ["Signed application"], docs_requested: ["Owner exclusion form"],
  };
  const [f] = runChecks(config, [magnolia]);
  assert.equal(f.says, "The carrier still needs the payroll estimate, and nobody has asked for it.");
  assert.equal(f.customer_message,
    "Hi Linda, before your workers' comp policy can start on Nov 15, the insurance company needs your payroll estimate. " +
    "We're also still waiting on your owner exclusion form. You can reply to this message with them.");

  // SO-24113: nothing received; application and subcontractor agreements asked for; loss runs asked for by nobody.
  const kitchen = {
    ...clean, docs_required: ["Signed application", "Subcontractor agreements", "Loss runs"],
    docs_received: [], docs_requested: ["Signed application", "Subcontractor agreements"],
  };
  const [k] = runChecks(config, [kitchen]);
  assert.match(k.customer_message, /needs your loss runs\. We're also still waiting on your signed application and subcontractor agreements\. You can reply to this message with them\.$/);

  // Nothing else outstanding: no reminder sentence, and "it" for a single document.
  const [single] = runChecks(config, [{ ...clean, docs_requested: [] }]);
  assert.match(single.customer_message, /needs your loss runs\. You can reply to this message with it\.$/);
  assert.doesNotMatch(single.customer_message, /also still waiting/);
});

test("the sample day passes its evals: every hidden problem found, no false flags", () => {
  const orders = load("orders.json").orders;
  const planted = load("planted.json").planted;
  const result = runEvals(runChecks(config, orders), planted, orders);
  assert.equal(result.missed.length, 0, `missed: ${result.missed}`);
  assert.equal(result.falseFlags.length, 0, `false flags: ${result.falseFlags}`);
  assert.equal(result.found, planted.length);
  assert.ok(result.pass);
});

test("the practice round's answer key matches what the checks find", () => {
  const pr = load("practice.json");
  const result = runEvals(runChecks(config, pr.orders), pr.planted, pr.orders);
  assert.ok(result.pass, `missed ${result.missed} false ${result.falseFlags}`);
  assert.equal(pr.orders.length, 10);
});
