// Runs the activation checks (data/checks.json) on every order and explains each flag.
// No AI model and no guessing: the same order always gets the same answer.
// Works in the browser (as a module) and in Node (for the tests).

const MONEY_FIELDS = new Set(["premium_sold", "carrier_invoice"]);

function isEmpty(v) {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

function test(cond, order) {
  const v = order[cond.field];
  if ("eq" in cond) return v === cond.eq;
  if ("lt" in cond) return typeof v === "number" && v < cond.lt;
  if ("present" in cond) return cond.present ? !isEmpty(v) : isEmpty(v);
  throw new Error(`Unknown condition on ${cond.field}`);
}

// Returns null when the rule passes, or an object with what the rule found when it fails.
export function evaluate(rule, order) {
  switch (rule.kind) {
    case "derive_mismatch": {
      const d = rule.derive;
      const derived = d.when_any.some((c) => test(c, order)) ? d.then : d.else;
      return order[rule.field] === derived ? null : { derived, fields: [rule.field] };
    }
    case "matches": {
      const re = new RegExp(rule.pattern, rule.flags || "");
      return re.test(String(order[rule.field] ?? "")) ? { fields: [rule.field] } : null;
    }
    case "list_not_covered": {
      const covered = new Set(rule.covered_by.flatMap((f) => order[f] || []));
      const missing = (order[rule.field] || []).filter((x) => !covered.has(x));
      if (!missing.length) return null;
      // Items already asked for but not yet in (remind_from), so one message can list everything still owed.
      const waiting = rule.remind_from
        ? (order[rule.field] || []).filter((x) => (order[rule.remind_from] || []).includes(x)
            && !rule.covered_by.some((f) => f !== rule.remind_from && (order[f] || []).includes(x)))
        : [];
      return { missing, waiting, fields: [rule.field] };
    }
    case "differs_by_more_than": {
      if (isEmpty(order[rule.a]) || isEmpty(order[rule.b])) {
        return rule.missing_counts ? { fields: [rule.a, rule.b].filter((f) => isEmpty(order[f])) } : null;
      }
      const gap = Math.abs(order[rule.a] - order[rule.b]);
      return gap > rule.amount ? { gap, fields: [rule.a, rule.b] } : null;
    }
    case "fields_differ":
      return order[rule.a] !== order[rule.b] ? { fields: [rule.a, rule.b] } : null;
    case "is_empty":
      return isEmpty(order[rule.field]) ? { fields: [rule.field] } : null;
    case "any": {
      for (const r of rule.rules) {
        const hit = evaluate(r, order);
        if (hit) return hit;
      }
      return null;
    }
    case "when_then":
      if (!test(rule.when, order)) return null;
      return test(rule.require, order) ? null : { fields: [rule.require.field] };
    default:
      throw new Error(`Unknown rule kind: ${rule.kind}`);
  }
}

export function formatValue(field, v) {
  if (isEmpty(v)) return field.startsWith("docs_") ? "None" : "Missing";
  if (MONEY_FIELDS.has(field)) return "$" + Number(v).toLocaleString("en-US");
  if (field === "down_payment_pct") return `${v}%`;
  if (field === "certificate_request") return `Requested for ${v.holder}`;
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

function joinList(items) {
  if (items.length <= 1) return items.join("");
  return items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
}

// Placeholders: {field}, {derived}, {missing}, {waiting}, {it_or_them}, {effective_date}; add |lower to lowercase.
// [[ ... ]] is an optional part: it is left out when a placeholder inside it has nothing to show.
export function fill(template, order, found) {
  const value = (key) => {
    if (key === "derived") return found.derived ?? "";
    if (key === "missing") return joinList(found.missing || []);
    if (key === "waiting") return joinList(found.waiting || []);
    if (key === "it_or_them") return (found.missing || []).length + (found.waiting || []).length > 1 ? "them" : "it";
    if (key === "effective_date") return shortDate(order.effective_date);
    if (key in order) return formatValue(key, order[key]);
    return null;
  };
  const sub = (text) => text.replace(/\{(\w+)(\|lower)?\}/g, (_, key, lower) => {
    const out = value(key);
    if (out === null) return `{${key}}`;
    return lower ? out.toLowerCase() : out;
  });
  const optional = template.replace(/\[\[(.*?)\]\]/g, (_, part) =>
    [...part.matchAll(/\{(\w+)/g)].every(([, key]) => value(key)) ? part : "");
  return sub(optional);
}

export function shortDate(iso) {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[m - 1]} ${d}`;
}

// Every check on every order. One flag per failed check, with its evidence.
export function runChecks(config, orders) {
  const flags = [];
  for (const order of orders) {
    for (const check of config.checks) {
      const found = evaluate(check.rule, order);
      if (!found) continue;
      const hitFields = new Set(found.fields);
      flags.push({
        key: `${order.id}:${check.id}`,
        order: order.id,
        check: check.id,
        owner: check.owner,
        says: fill(check.says, order, found),
        next_step: fill(check.next_step, order, found),
        customer_message: check.customer_message ? fill(check.customer_message, order, found) : null,
        evidence: check.evidence.map((f) => ({
          field: f,
          label: config.fields[f] || f,
          value: formatValue(f, order[f]),
          hit: hitFields.has(f),
        })),
      });
    }
  }
  return flags;
}

// Compares the flags with the answer key. The run passes only if every planted problem was found
// and nothing else was flagged. This is a regression test: it proves the checks still catch every
// kind of problem they are meant to catch after a change. It does not measure accuracy on real orders.
export function runEvals(flags, planted, orders) {
  const want = new Set(planted.map((p) => `${p.order}:${p.check}`));
  const got = new Set(flags.map((f) => f.key));
  const found = [...want].filter((k) => got.has(k));
  const missed = [...want].filter((k) => !got.has(k));
  const falseFlags = [...got].filter((k) => !want.has(k));
  const brokenOrders = new Set(planted.map((p) => p.order));
  return {
    planted: want.size,
    found: found.length,
    missed,
    falseFlags,
    cleanOrders: orders.filter((o) => !brokenOrders.has(o.id)).length,
    pass: missed.length === 0 && falseFlags.length === 0,
  };
}
