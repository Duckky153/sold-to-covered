#!/usr/bin/env python3
"""Make one sample day of sold orders, with known problems hidden in some of them.

Everything here is made up: businesses, people, carriers, amounts. The fixed seed means the same day
comes out every time, so the screens, the tests and the evals all agree.

Writes into site/data/:
  orders.json   the 115 sold orders the checks run on
  planted.json  the answer key: which order has which hidden problem (the checks never read this)
  usage.json    a simulated two-week rollout, for the Adoption view (labeled simulated on screen)

Run:  python3 generate.py
"""
import json
import random
from pathlib import Path

SEED = 1113
DAY = "2026-11-13"
N_ORDERS = 115  # Harper's Atlanta posting: "About 115 deals a day go from sold to covered."
OUT = Path(__file__).resolve().parent / "site" / "data"

# How many orders get each hidden problem. Some orders get two.
PLANT = {
    "pay_type": 8,
    "po_box": 6,
    "carrier_docs": 10,
    "amounts": 5,
    "billing": 6,
    "source": 5,
    "certificate": 4,
}

INDUSTRIES = [
    ("Roofing contractor", "Roofing"), ("General contractor", "Builders"), ("Electrician", "Electric"),
    ("Restaurant", "Kitchen"), ("Food truck", "Eats"), ("Used car dealer", "Motors"),
    ("Auto repair garage", "Auto Repair"), ("Childcare center", "Little Learners"),
    ("Home care agency", "Home Care"), ("Machine shop", "Machining"), ("Motel", "Inn"),
    ("Security guard company", "Security"), ("Trucking company", "Freight"), ("Landscaper", "Landscaping"),
    ("Plumber", "Plumbing"), ("Cleaning company", "Cleaning Co"),
]
NAME_FIRST = [
    "Ridgeline", "Bluebird", "Oak Street", "Summit", "Harbor", "Red Clay", "Pine Hollow", "Northgate",
    "Silver Creek", "Magnolia", "Ironwood", "Lakeside", "Copper", "Westfield", "Brightway", "Stonebridge",
    "Cedar Point", "Fairmont", "Maple Row", "Golden Gate", "Riverbend", "Highline", "Sunrise", "Tall Pines",
]
SUFFIX = ["LLC", "Inc", "Co", "LLC", "LLC"]
CONTACTS = ["Marcus", "Dana", "Luis", "Keisha", "Tom", "Anita", "Ray", "Mei", "Carlos", "Brenda",
            "Omar", "Janet", "Victor", "Sofia", "Earl", "Grace", "Hector", "Linda", "Dev", "Rosa"]
STREETS = ["Cedar Ave", "Peachtree Rd", "Main St", "Industrial Blvd", "Mill Rd", "Broad St", "Oak Ln",
           "Commerce Dr", "Market St", "Spring St", "Lake Rd", "Highland Ave"]
CITIES = [("Atlanta", "GA", "303"), ("Marietta", "GA", "300"), ("Austin", "TX", "787"),
          ("Phoenix", "AZ", "850"), ("Charlotte", "NC", "282"), ("Tampa", "FL", "336"),
          ("Denver", "CO", "802"), ("Columbus", "OH", "432"), ("Nashville", "TN", "372"),
          ("Sacramento", "CA", "958")]
CARRIERS = ["Northfield Mutual", "Granite Casualty", "Bayline Specialty", "Keystone Assurance",
            "Prairie Indemnity", "Harborline Insurance"]
LINES = {
    "General liability": ["Signed application", "Loss runs", "Subcontractor agreements"],
    "Workers' comp": ["Signed application", "Payroll estimate", "Owner exclusion form"],
    "Commercial auto": ["Signed application", "Driver list", "Vehicle list"],
    "Commercial property": ["Signed application", "Property photos"],
    "Professional liability": ["Signed application", "Resumes of key staff"],
}
# Made-up specialists who work the queue, by shift.
TEAM = {"Early": ["Maya", "Jordan", "Priya"], "Late": ["Luis", "Tasha", "Sam"]}


def money(x):
    return round(x / 5) * 5


def make_clean_order(rng, i):
    industry, word = rng.choice(INDUSTRIES)
    name = f"{rng.choice(NAME_FIRST)} {word} {rng.choice(SUFFIX)}"
    city, state, zip3 = rng.choice(CITIES)
    line = rng.choice(list(LINES))
    required = [d for d in LINES[line] if d == "Signed application" or rng.random() < 0.6]
    received, requested = [], []
    for d in required:
        (received if rng.random() < 0.55 else requested).append(d)
    financed = rng.random() < 0.4
    premium = money(rng.uniform(900, 14000))
    source = rng.choice(["Instant quote", "Instant quote", "Broker"])
    billing = rng.choice(["Agency bill", "Direct bill"])
    starts_today = rng.random() < 0.15  # same-day coverage: bound and active today
    status = "Active" if starts_today else "Ready to bind"
    shift = rng.choice(["Early", "Late"])
    hour = rng.randint(7, 19)
    order = {
        "id": f"SO-{24100 + i}",
        "business": name,
        "industry": industry,
        "contact": rng.choice(CONTACTS),
        "address": f"{rng.randint(100, 9800)} {rng.choice(STREETS)}",
        "city": city,
        "state": state,
        "zip": f"{zip3}{rng.randint(10, 99)}",
        "line": line,
        "carrier": rng.choice(CARRIERS),
        "source": source,
        "carrier_source": source,
        "pay_type": "Financed" if financed else "Paid in full",
        "finance_agreement": "On file" if financed else "None",
        "down_payment_pct": rng.choice([20, 25]) if financed else 100,
        "billing": billing,
        "carrier_billing": billing,
        "premium_sold": premium,
        "carrier_invoice": premium,
        "docs_required": required,
        "docs_received": received,
        "docs_requested": requested,
        "policy_status": status,
        "certificate_request": None,
        "effective_date": DAY if starts_today else f"2026-11-{rng.randint(14, 21)}",
        "sold_at": f"{DAY} {hour:02d}:{rng.randint(0, 59):02d}",
        "shift": shift,
        "owner": rng.choice(TEAM[shift]),
    }
    if status == "Active" and rng.random() < 0.5:
        order["certificate_request"] = {"holder": f"{rng.choice(NAME_FIRST)} Property Management",
                                        "requested_at": f"{DAY} {min(hour + 1, 20):02d}:15"}
    return order


def make_unbound(rng, order):
    """Problems are caught before binding, so a broken order is one still waiting to bind."""
    if order["policy_status"] != "Ready to bind":
        order["policy_status"] = "Ready to bind"
        order["effective_date"] = f"2026-11-{rng.randint(14, 21)}"
        order["certificate_request"] = None


def plant(rng, order, problem):
    """Break one thing in a clean order. Returns a note on what was broken (for the answer key)."""
    make_unbound(rng, order)
    if problem == "pay_type":
        if order["pay_type"] == "Financed":
            order["pay_type"] = "Paid in full"  # financed deal marked paid in full
            return "Financed deal recorded as paid in full"
        order["pay_type"] = "Financed"
        return "Paid-in-full deal recorded as financed"
    if problem == "po_box":
        order["address"] = f"PO Box {rng.randint(100, 9999)}"
        return "PO box used as the business address"
    if problem == "carrier_docs":
        missing = rng.choice([d for d in LINES[order["line"]] if d != "Signed application"])
        if missing not in order["docs_required"]:
            order["docs_required"].append(missing)
        for key in ("docs_received", "docs_requested"):
            if missing in order[key]:
                order[key].remove(missing)
        return f"Carrier needs '{missing}' and nobody asked for it"
    if problem == "amounts":
        gap = money(rng.uniform(120, 900)) * rng.choice([1, -1])
        order["carrier_invoice"] = order["premium_sold"] + gap
        return f"Carrier invoice differs from the sold premium by ${abs(gap)}"
    if problem == "billing":
        order["carrier_billing"] = "Direct bill" if order["billing"] == "Agency bill" else "Agency bill"
        return "Recorded billing differs from how the carrier bills"
    if problem == "source":
        if rng.random() < 0.5:
            order["source"] = None
            return "Source (instant or broker) missing"
        order["carrier_source"] = "Broker" if order["source"] == "Instant quote" else "Instant quote"
        return "Source differs between our record and the carrier's"
    if problem == "certificate":
        order["certificate_request"] = {"holder": f"{rng.choice(NAME_FIRST)} General Contractors",
                                        "requested_at": f"{DAY} 16:40"}
        return "Certificate requested before the policy is bound and active"
    raise ValueError(problem)


def make_day():
    rng = random.Random(SEED)
    orders = [make_clean_order(rng, i) for i in range(N_ORDERS)]
    # Choose which orders get problems: 38 distinct orders, six of them get a second problem.
    broken_ids = rng.sample(range(N_ORDERS), 38)
    slots = [p for p, n in PLANT.items() for _ in range(n)]  # 44 problems
    rng.shuffle(slots)
    assignment = {i: [] for i in broken_ids}
    order_cycle = broken_ids + rng.sample(broken_ids, len(slots) - len(broken_ids))
    for idx, problem in zip(order_cycle, slots):
        if problem in assignment[idx]:  # never the same problem twice on one order
            spare = next(i for i in broken_ids if problem not in assignment[i] and len(assignment[i]) < 2)
            idx = spare
        assignment[idx].append(problem)
    planted = []
    for idx in sorted(assignment):
        for problem in assignment[idx]:
            note = plant(rng, orders[idx], problem)
            planted.append({"order": orders[idx]["id"], "check": problem, "note": note})
    return orders, planted


def make_usage():
    """A simulated two-week rollout. Every number here is invented to show what gets tracked."""
    days = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09",
            "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]
    # Per day and shift: flags raised, fixed before bind, dismissed, overridden, moved with flag open,
    # median minutes to fix. None = that shift was not on the checks yet.
    early = [(9, 8, 1, 0, 0, 7), (10, 9, 1, 0, 0, 6), (21, 17, 3, 0, 1, 6), (20, 16, 3, 0, 1, 5),
             (22, 18, 3, 1, 0, 5), (21, 19, 1, 1, 0, 5), (20, 19, 1, 0, 0, 4), (22, 21, 0, 1, 0, 4),
             (21, 20, 1, 0, 0, 4), (22, 21, 0, 0, 1, 4)]
    late = [None, None, None, (19, 6, 2, 1, 10, 9), (20, 5, 1, 1, 13, 10), (18, 15, 1, 1, 1, 6),
            (19, 17, 1, 0, 1, 5), (20, 19, 0, 1, 0, 5), (19, 18, 1, 0, 0, 4), (21, 20, 0, 0, 1, 4)]
    keys = ["flags", "fixed", "dismissed", "overridden", "moved_open", "median_min"]
    rows = []
    for d, e, l in zip(days, early, late):
        rows.append({"day": d,
                     "early": dict(zip(keys, e)),
                     "late": dict(zip(keys, l)) if l else None})
    return {
        "simulated": True,
        "note": "Simulated rollout. Every number on this view is invented to show what gets tracked.",
        "days": rows,
        "found_after_bind_note": "Counted 30 days after each week, because problems after binding take time to surface. Includes problems the seven checks do not look for (about 8 a week).",
        "uncovered_per_week": 8,
        "found_after_bind": [
            {"label": "Week before", "value": 41, "detail": "Sep 28 to Oct 2, no checks"},
            {"label": "Week 1", "value": 38, "detail": "Oct 5 to 9, late shift skipping flags"},
            {"label": "Week 2", "value": 12, "detail": "Oct 12 to 16, both shifts"},
        ],
        "log": [
            {"day": "2026-10-05", "text": "Pilot: Maya and Jordan on the early shift work the checklist. 15 minutes of training with the How to fix cards."},
            {"day": "2026-10-07", "text": "Whole early shift on the checks."},
            {"day": "2026-10-08", "text": "Late shift added."},
            {"day": "2026-10-09", "text": "Late shift moved 13 orders with a flag still open. Cause: they work from the email queue, and the checklist only showed in the order view."},
            {"day": "2026-10-12", "text": "Checklist added to the email queue view. 10-minute walkthrough with the late shift. Moved-open drops to 1."},
            {"day": "2026-10-13", "text": "Subjectivities check changed: 9 dismissals said \"customer already sent it\". Documents that arrive by email now count as received."},
        ],
        "dismiss_reasons": [
            {"check": "carrier_docs", "reason": "Customer already sent it", "week1": 9, "week2": 1},
            {"check": "amounts", "reason": "Carrier fee, not a mistake", "week1": 3, "week2": 3},
            {"check": "source", "reason": "Broker deal entered by hand", "week1": 2, "week2": 2},
        ],
    }


# Practice round: ten orders a new teammate works through and is scored on. Every check appears
# once, one order has two problems, and two orders are clean (spotting "nothing wrong" is a skill too).
PRACTICE_SEED = 2026
PRACTICE_PLAN = [["pay_type"], ["po_box"], [], ["carrier_docs"], ["amounts"],
                 ["billing", "carrier_docs"], ["source"], [], ["certificate"], ["pay_type"]]
PASS_MARK = 9


def make_practice():
    rng = random.Random(PRACTICE_SEED)
    orders, planted = [], []
    for i, problems in enumerate(PRACTICE_PLAN):
        o = make_clean_order(rng, i)
        o["id"] = f"PR-{i + 1:02d}"
        for problem in problems:
            planted.append({"order": o["id"], "check": problem, "note": plant(rng, o, problem)})
        orders.append(o)
    return orders, planted


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    p_orders, p_planted = make_practice()
    (OUT / "practice.json").write_text(json.dumps(
        {"sample": True, "pass_mark": PASS_MARK, "orders": p_orders, "planted": p_planted}, indent=1))
    orders, planted = make_day()
    (OUT / "orders.json").write_text(json.dumps({"day": DAY, "sample": True, "orders": orders}, indent=1))
    (OUT / "planted.json").write_text(json.dumps({"day": DAY, "planted": planted}, indent=1))
    (OUT / "usage.json").write_text(json.dumps(make_usage(), indent=1))
    print(f"{len(orders)} orders, {len(planted)} hidden problems in "
          f"{len({p['order'] for p in planted})} orders -> {OUT}")


if __name__ == "__main__":
    main()
