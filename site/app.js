import { runChecks, runEvals, shortDate, formatValue } from "./engine.js";

const OWNER_ORDER = { Licensed: 0, Customer: 1, Agent: 2 };
const STORE_KEY = "sold-to-covered:v1";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let config, orders, planted, usage, practice, flags, evals, byOrder, checkById;
let filter = "all";
let showAll = false;
const FIRST_ROWS = 12;
let openOrder = null;
let pendingReason = null; // { key, kind } while a reason box is open

// What happened to each flag in this browser. Wrapped: storage can be blocked.
let actions = {};
function loadActions() {
  try { actions = JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {}; } catch { actions = {}; }
}
function saveActions() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(actions)); } catch { /* page still works */ }
}

async function getJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`Could not load ${path}`);
  return r.json();
}

async function start() {
  try {
    [config, orders, planted, usage] = await Promise.all([
      getJSON("data/checks.json"),
      getJSON("data/orders.json").then((d) => d.orders),
      getJSON("data/planted.json").then((d) => d.planted),
      getJSON("data/usage.json"),
    ]);
    practice = await getJSON("data/practice.json");
  } catch (e) {
    document.querySelector("main").innerHTML = `<section class="band"><div class="wrap"><h2>The sample data did not load.</h2><p class="body-text">Start the page with <code>./run.sh</code> so it is served from a local address, then reload.</p></div></section>`;
    return;
  }
  loadActions();
  checkById = Object.fromEntries(config.checks.map((c) => [c.id, c]));
  const orderById = Object.fromEntries(orders.map((o) => [o.id, o]));
  flags = runChecks(config, orders).map((f) => ({ ...f, o: orderById[f.order] }));
  flags.sort((a, b) =>
    a.o.effective_date.localeCompare(b.o.effective_date) ||
    OWNER_ORDER[a.owner] - OWNER_ORDER[b.owner] ||
    a.order.localeCompare(b.order));
  byOrder = {};
  for (const f of flags) (byOrder[f.order] ||= []).push(f);
  evals = runEvals(flags, planted, orders);

  renderQueueStatic();
  renderAll();
  renderAdoption();
  startPractice();
  window.addEventListener("hashchange", route);
  route();
}

function route() {
  const view = ["#adoption", "#practice"].includes(location.hash) ? location.hash.slice(1) : "queue";
  for (const v of ["queue", "adoption", "practice"]) $(`view-${v}`).hidden = view !== v;
  document.querySelectorAll(".views a").forEach((a) => a.classList.toggle("on", a.dataset.view === view));
  if (view === "adoption") renderSession();
  window.scrollTo(0, 0);
}

function renderAll() {
  renderQueue();
  renderSession();
  if (openOrder) renderPanel(openOrder);
}

/* ---------- Queue ---------- */

function counts() {
  const c = { Agent: 0, Customer: 0, Licensed: 0 };
  flags.forEach((f) => c[f.owner]++);
  return c;
}

function renderQueueStatic() {
  const nOrders = Object.keys(byOrder).length;
  $("q-day").textContent = shortDate(orders[0].sold_at);
  const nChecks = config.checks.length;
  $("q-lead").innerHTML = `${orders.length} orders were sold today. ${nChecks} checks ran on every one. <b>${nOrders} orders</b> need a fix before they move to binding.`;
  $("q-title").textContent = `${flags.length} problems on ${nOrders} orders`;
  $("q-strip").innerHTML = `
    <div class="cell"><span class="n">${nChecks} <em>checks</em></span><span class="d">run on all ${orders.length} orders</span></div>
    <div class="cell"><span class="n">${evals.found} of ${evals.planted} <em>found</em></span><span class="d">planted problems caught</span></div>
    <div class="cell"><span class="n">${evals.falseFlags.length} <em>false flags</em></span><span class="d">on ${evals.cleanOrders} clean orders · ${evals.pass ? "run passes" : "run fails"}</span></div>`;

  $("c-rows").innerHTML = config.checks.map((ch) => {
    const n = flags.filter((f) => f.check === ch.id).length;
    return `<div class="check"><span class="name">${esc(ch.name)}</span><span class="why">${esc(ch.why)}</span><span class="count">${n} today</span><span class="who">${esc(config.owners[ch.owner])}</span></div>`;
  }).join("");
}

function renderQueue() {
  const c = counts();
  const tabs = [["all", `All ${flags.length}`], ...["Agent", "Customer", "Licensed"].map((k) => [k, `${config.owners[k]} ${c[k]}`])];
  $("q-tabs").innerHTML = tabs.map(([k, label]) =>
    `<button role="tab" aria-selected="${filter === k}" class="${filter === k ? "on" : ""}" data-tab="${k}">${esc(label)}</button>`).join("");
  $("q-tabs").onclick = (e) => {
    const b = e.target.closest("button[data-tab]");
    if (b) { filter = b.dataset.tab; renderQueue(); }
  };

  const open = flags.filter((f) => !actions[f.key]).length;
  $("q-progress").innerHTML = `<b>${open}</b> open · ${flags.length - open} done`;

  const all = flags.filter((f) => filter === "all" || f.owner === filter);
  const shown = showAll ? all : all.slice(0, FIRST_ROWS);
  const head = `<div class="row head"><span>Starts</span><span>Order</span><span>What's wrong</span><span>Who fixes</span><span class="status">Status</span></div>`;
  $("q-rows").innerHTML = head + (shown.length ? shown.map(rowHTML).join("") : `<p class="empty">Nothing in this group.</p>`);
  $("q-more").innerHTML = all.length > FIRST_ROWS
    ? `<button class="btn" data-more>${showAll ? "Show the first " + FIRST_ROWS : `Show all ${all.length}`}</button>`
    : "";
  $("q-more").onclick = (e) => { if (e.target.closest("[data-more]")) { showAll = !showAll; renderQueue(); } };
  $("q-rows").onclick = (e) => {
    const btn = e.target.closest("button[data-fix]");
    if (btn) { e.stopPropagation(); setAction(btn.dataset.fix, "fixed"); return; }
    const row = e.target.closest(".row[data-order]");
    if (row) openPanel(row.dataset.order, row);
  };
}

function rowHTML(f) {
  const a = actions[f.key];
  // A licensed person's flag is never closed in one click: it opens the order for review.
  const status = a
    ? `<span class="state">${esc(stateLabel(a.kind))}</span>`
    : f.owner === "Licensed"
      ? `<span class="btn ghost">Review</span>`
      : `<button class="btn" data-fix="${esc(f.key)}">Mark fixed</button>`;
  return `<div class="row${a ? " done" : ""}" data-order="${esc(f.order)}" tabindex="0" role="button" aria-label="Open ${esc(f.order)}: ${esc(f.says)}">
    <span class="date">${esc(shortDate(f.o.effective_date))}</span>
    <span class="ord">${esc(f.order)}<span class="biz">${esc(f.o.business)}</span></span>
    <span class="what">${esc(f.says)}</span>
    <span class="who">${esc(config.owners[f.owner])}</span>
    <span class="status">${status}</span>
  </div>`;
}

function stateLabel(kind) {
  return { fixed: "Fixed", dismissed: "Dismissed", overridden: "Bind overridden" }[kind] || kind;
}

function setAction(key, kind, reason = "") {
  actions[key] = { kind, reason, at: new Date().toISOString() };
  pendingReason = null;
  saveActions();
  renderAll();
}

function undoAction(key) {
  delete actions[key];
  saveActions();
  renderAll();
}

/* ---------- Side panel ---------- */

let returnFocus = null;

function openPanel(orderId, from) {
  openOrder = orderId;
  pendingReason = null;
  returnFocus = from || document.activeElement;
  renderPanel(orderId);
  $("panel").hidden = false;
  $("scrim").hidden = false;
  $("panel").scrollTop = 0;
  $("panel").focus();
}

function closePanel() {
  openOrder = null;
  $("panel").hidden = true;
  $("scrim").hidden = true;
  const back = returnFocus && document.querySelector(`.row[data-order="${CSS.escape(returnFocus.dataset?.order || "")}"]`);
  if (back) back.focus();
  returnFocus = null;
}

function field(label, value, cls = "") {
  return `<div class="field ${cls}"><span class="l">${esc(label)}</span><span class="v">${esc(value)}</span></div>`;
}

function renderPanel(orderId) {
  const o = orders.find((x) => x.id === orderId);
  const fs = byOrder[orderId] || [];
  const top = `<div class="panel-top"><div><h3>${esc(o.id)}</h3><p class="sub">${esc(o.business)} · sample</p></div><button class="close" data-close>Close</button></div>
    <div class="fields">
      ${field("Industry", o.industry)}${field("Line", o.line)}
      ${field("Carrier", o.carrier)}${field("Policy starts", shortDate(o.effective_date))}
      ${field("Contact", o.contact)}${field("Our owner", `${o.owner}, ${o.shift.toLowerCase()} shift`)}
      ${field("Location", `${o.city}, ${o.state}`, "wide")}
    </div>`;
  $("panel-body").innerHTML = top + fs.map(flagHTML).join("");
}

function flagHTML(f) {
  const ch = checkById[f.check];
  const a = actions[f.key];
  const ev = f.evidence.map((e) => field(e.label, e.value, (e.hit ? "hit" : "") + (e.value.length > 26 ? " wide" : ""))).join("");
  const how = ch.how_to_fix;
  const msg = f.customer_message
    ? `<div class="msg"><span class="l">Message to the customer (draft, not sent)</span><p id="msg-${esc(f.key)}">${esc(f.customer_message)}</p>
       <div class="row-btns"><button class="btn" data-copy="${esc(f.key)}">Copy</button><span class="state" data-copied="${esc(f.key)}"></span></div></div>`
    : "";
  let act;
  if (a) {
    act = `<p class="done-note">${esc(stateLabel(a.kind))}${a.reason ? `: "${esc(a.reason)}"` : ""}. <button class="link" data-undo="${esc(f.key)}">Undo</button></p>`;
  } else if (pendingReason && pendingReason.key === f.key) {
    const label = {
      dismissed: "Why is this not a problem?",
      overridden: "Why bind with this open?",
      fixed: "Which licensed teammate confirmed it?",
    }[pendingReason.kind];
    act = `<form class="reason" data-reason="${esc(f.key)}"><input name="r" required placeholder="${esc(label)}" aria-label="${esc(label)}"><button class="btn primary" type="submit">Save</button><button class="link" type="button" data-cancel>Cancel</button></form>`;
  } else {
    act = `<div class="actions"><button class="btn primary" data-act="fixed" data-key="${esc(f.key)}">Mark fixed</button>
      <button class="btn" data-act="dismissed" data-key="${esc(f.key)}">Dismiss</button>
      <button class="btn" data-act="overridden" data-key="${esc(f.key)}">Override bind</button></div>`;
  }
  return `<div class="flag${a ? " done" : ""}">
    <p class="says">${esc(f.says)}</p>
    <p class="meta">${esc(ch.name)} · ${esc(config.owners[f.owner])}</p>
    <div class="fields">${ev}</div>
    <div class="next"><span class="l">Next step</span>${esc(f.next_step)}</div>
    ${msg}
    <details class="howto"><summary>How to fix</summary><dl>
      <dt>What it means</dt><dd>${esc(how.means)}</dd>
      <dt>Confirm</dt><dd>${esc(how.confirm)}</dd>
      <dt>Tell the customer</dt><dd>${esc(how.tell_customer)}</dd>
      <dt>Hand off when</dt><dd>${esc(how.hand_off)}</dd>
    </dl></details>
    ${act}
  </div>`;
}

$("panel").addEventListener("click", async (e) => {
  const t = e.target;
  if (t.closest("[data-close]")) return closePanel();
  if (t.dataset.undo) return undoAction(t.dataset.undo);
  if (t.closest("[data-cancel]")) { pendingReason = null; return renderPanel(openOrder); }
  if (t.dataset.act) {
    const owner = flags.find((f) => f.key === t.dataset.key)?.owner;
    if (t.dataset.act === "fixed" && owner !== "Licensed") return setAction(t.dataset.key, "fixed");
    pendingReason = { key: t.dataset.key, kind: t.dataset.act };
    renderPanel(openOrder);
    const input = $("panel").querySelector(".reason input");
    if (input) input.focus();
    return;
  }
  if (t.dataset.copy) {
    const key = t.dataset.copy;
    const text = $(`msg-${key}`).textContent;
    const note = $("panel").querySelector(`[data-copied="${CSS.escape(key)}"]`);
    try {
      await navigator.clipboard.writeText(text);
      note.textContent = "Copied. Nothing was sent.";
    } catch {
      const range = document.createRange();
      range.selectNodeContents($(`msg-${key}`));
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      note.textContent = "Selected. Press Cmd+C to copy.";
    }
  }
});
$("panel").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.target.closest("form[data-reason]");
  const reason = form.r.value.trim();
  if (!reason) return;
  setAction(form.dataset.reason, pendingReason.kind, reason);
});
$("scrim").addEventListener("click", closePanel);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openOrder) closePanel();
  if ((e.key === "Enter" || e.key === " ") && e.target.matches(".row[data-order]")) {
    e.preventDefault();
    openPanel(e.target.dataset.order, e.target);
  }
  // Keep Tab inside the open panel.
  if (e.key === "Tab" && openOrder) {
    const items = [...$("panel").querySelectorAll("button, input, summary, [href]")].filter((x) => !x.disabled);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === $("panel"))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

/* ---------- Adoption ---------- */

function renderSession() {
  const kinds = { fixed: 0, dismissed: 0, overridden: 0 };
  flags.forEach((f) => { const a = actions[f.key]; if (a) kinds[a.kind]++; });
  const open = flags.length - kinds.fixed - kinds.dismissed - kinds.overridden;
  $("a-session").innerHTML = `Your clicks in the queue are tracked the same way: <b>${kinds.fixed}</b> fixed, <b>${kinds.dismissed}</b> dismissed, <b>${kinds.overridden}</b> bind overridden, <b>${open}</b> still open. They stay in this browser.`;
}

function renderAdoption() {
  const w = usage.found_after_bind;
  $("a-weeks").innerHTML = w.map((x, i) =>
    `<div class="week${i === w.length - 1 ? " best" : ""}"><div class="n">${x.value}</div><div class="l">${esc(x.label)}</div><div class="d">${esc(x.detail)}</div></div>`).join("");

  const cell = (s) => s
    ? `<td class="num${s.moved_open >= 5 ? " bad" : ""}">${s.moved_open}</td>`
    : `<td class="num off">Not on the checks yet</td>`;
  $("a-days").innerHTML = `<thead><tr><th>Day</th><th class="num">Early shift</th><th class="num">Late shift</th></tr></thead>
    <tbody>${usage.days.map((d) => `<tr><td>${esc(dayLabel(d.day))}</td>${cell(d.early)}${cell(d.late)}</tr>`).join("")}</tbody>`;

  $("a-log").innerHTML = usage.log.map((l) => `<li><span class="when">${esc(shortDate(l.day))}</span><span>${esc(l.text)}</span></li>`).join("");

  $("a-dismiss").innerHTML = `<thead><tr><th>Check</th><th>Reason given</th><th class="num">Week 1</th><th class="num">Week 2</th></tr></thead><tbody>${
    usage.dismiss_reasons.map((r) => `<tr><td>${esc(checkById[r.check].name)}</td><td>${esc(r.reason)}</td><td class="num${r.week1 >= 5 ? " bad" : ""}">${r.week1}</td><td class="num">${r.week2}</td></tr>`).join("")}</tbody>`;}

function dayLabel(iso) {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short" }) + " " + shortDate(iso);
}

/* ---------- Practice ---------- */

const PRACTICE_FIELDS = [
  ["line", "Line"], ["address", "Business address"],
  ["pay_type", "Pay type"], ["finance_agreement", "Finance agreement"], ["down_payment_pct", "Down payment"],
  ["docs_required", "Carrier needs"], ["docs_received", "Received"], ["docs_requested", "Asked for"],
  ["premium_sold", "Sold premium"], ["carrier_invoice", "Carrier invoice"],
  ["billing", "Billing on our record"], ["carrier_billing", "Carrier bills as"],
  ["source", "Source on our record"], ["carrier_source", "Source on carrier record"],
  ["certificate_request", "Certificate request"], ["policy_status", "Policy status"],
];
let pr; // practice state: current order, score, the boxes ticked

function startPractice() {
  $("p-mark").textContent = practice.pass_mark;
  pr = { i: 0, right: 0, answered: false, lastOk: false, picked: new Set(), results: [] };
  renderPractice();
}

function practiceTruth(order) {
  return new Set(practice.planted.filter((p) => p.order === order.id).map((p) => p.check));
}

function renderPractice() {
  const body = $("p-body");
  const n = practice.orders.length;
  if (pr.i >= n) {
    const pass = pr.right >= practice.pass_mark;
    const rows = pr.results.map((r) =>
      `<div class="p-rev-row"><span>${esc(r.id)}</span><span class="${r.ok ? "" : "miss"}">${r.ok ? "Right" : "Answer: " + esc(r.want)}</span></div>`).join("");
    body.innerHTML = `<p class="eyebrow">Result</p>
      <h2>${pr.right} of ${n} right. <em>${pass ? "You pass." : "Not yet."}</em></h2>
      <p class="body-text">${pass
        ? "Ready for the live queue, with a senior teammate checking your first two weeks."
        : `The pass mark is ${practice.pass_mark}. Read the How to fix card for each check you missed, then go again.`}</p>
      <div class="p-review">${rows}</div>
      <button class="btn primary" data-p="again">Start again</button>`;
    body.onchange = null;
    body.onclick = (e) => { if (e.target.closest('[data-p="again"]')) startPractice(); };
    return;
  }
  const o = practice.orders[pr.i];
  const truth = practiceTruth(o);
  const flagsHere = pr.answered ? runChecks(config, [o]) : [];
  const hitFields = new Set(flagsHere.flatMap((f) => f.evidence.filter((e) => e.hit).map((e) => e.field)));
  const fields = PRACTICE_FIELDS.map(([k, label]) => {
    const v = o[k] === null && k === "certificate_request" ? "None" : formatValue(k, o[k]);
    return field(label, v, (hitFields.has(k) ? "hit" : "") + (v.length > 28 ? " wide" : ""));
  }).join("");
  const options = [...config.checks.map((c) => [c.id, c.name]), ["clean", "Nothing, it's clean"]];
  const choice = options.map(([id, name]) => {
    const on = pr.picked.has(id);
    let mark = "";
    if (pr.answered) {
      const should = id === "clean" ? truth.size === 0 : truth.has(id);
      mark = should ? (on ? "right" : "missed") : (on ? "wrong" : "");
    }
    const note = mark === "missed" ? '<em class="why">missed</em>' : mark === "wrong" ? '<em class="why">not a problem here</em>' : "";
    return `<label class="opt ${mark}"><input type="checkbox" value="${id}" ${on ? "checked" : ""} ${pr.answered ? "disabled" : ""}><span>${esc(name)}</span>${note}</label>`;
  }).join("");
  const found = flagsHere.length
    ? flagsHere.map((f) => `<p>${esc(f.says)}</p>`).join("")
    : "<p>This order is clean. Nothing needs fixing.</p>";
  const verdict = pr.answered
    ? `<div class="p-verdict ${pr.lastOk ? "ok" : "no"}"><p class="says-big">${pr.lastOk ? "Right." : "Not quite."}</p>${found}</div>
       <button class="btn primary" data-p="next">${pr.i + 1 === n ? "See my result" : "Next order"}</button>`
    : `<button class="btn primary" data-p="check" ${pr.picked.size ? "" : "disabled"}>Check my answer</button>`;
  body.innerHTML = `<div class="head-row"><div><p class="eyebrow">Order ${pr.i + 1} of ${n}</p>
      <h2>${esc(o.id)} <span class="sub-inline">${esc(o.business)} · sample</span></h2></div>
      <p class="progress"><b>${pr.right}</b> right so far</p></div>
    <div class="practice">
      <div class="fields">${fields}</div>
      <div class="p-side"><p class="q">What's wrong with this order? Pick every problem you see.</p>${choice}${verdict}</div>
    </div>`;
  body.onchange = (e) => {
    const box = e.target.closest("input[type=checkbox]");
    if (!box) return;
    if (box.checked) {
      if (box.value === "clean") pr.picked.clear();
      else pr.picked.delete("clean");
      pr.picked.add(box.value);
    } else pr.picked.delete(box.value);
    renderPractice();
  };
  body.onclick = (e) => {
    const b = e.target.closest("[data-p]");
    if (!b) return;
    if (b.dataset.p === "check" && pr.picked.size) {
      const want = truth.size ? truth : new Set(["clean"]);
      pr.lastOk = want.size === pr.picked.size && [...want].every((x) => pr.picked.has(x));
      if (pr.lastOk) pr.right++;
      pr.results.push({ id: o.id, ok: pr.lastOk, want: [...want].map((x) => (x === "clean" ? "it was clean" : checkById[x].name)).join(", ") });
      pr.answered = true;
      renderPractice();
    } else if (b.dataset.p === "next") {
      pr.i++;
      pr.answered = false;
      pr.picked = new Set();
      renderPractice();
      $("view-practice").scrollIntoView({ block: "start" });
    }
  };
}

start();
