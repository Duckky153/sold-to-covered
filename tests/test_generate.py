"""The sample day is the same every time, the right size, and its answer key matches its orders."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import generate  # noqa: E402


def test_same_day_every_time():
    assert generate.make_day() == generate.make_day()


def test_day_size_and_answer_key():
    orders, planted = generate.make_day()
    assert len(orders) == 115
    assert len(planted) == sum(generate.PLANT.values()) == 44
    ids = {o["id"] for o in orders}
    assert len(ids) == 115
    assert {p["order"] for p in planted} <= ids
    assert len({p["order"] for p in planted}) == 38
    # never the same problem twice on one order, never more than two problems on one order
    keys = [(p["order"], p["check"]) for p in planted]
    assert len(keys) == len(set(keys))
    per_order = {}
    for o, _ in keys:
        per_order[o] = per_order.get(o, 0) + 1
    assert max(per_order.values()) <= 2


def test_simulated_rollout_adds_up():
    u = generate.make_usage()
    assert u["simulated"] is True
    for d in u["days"]:
        for s in (d["early"], d["late"]):
            if s:
                assert s["fixed"] + s["dismissed"] + s["overridden"] + s["moved_open"] == s["flags"]
    week2 = u["days"][5:]
    moved = sum(d[s]["moved_open"] for d in week2 for s in ("early", "late"))
    assert moved + u["uncovered_per_week"] == u["found_after_bind"][-1]["value"]
    dismissed_w1 = sum(d[s]["dismissed"] for d in u["days"][:5] for s in ("early", "late") if d[s])
    dismissed_w2 = sum(d[s]["dismissed"] for d in week2 for s in ("early", "late"))
    assert dismissed_w1 == sum(r["week1"] for r in u["dismiss_reasons"])
    assert dismissed_w2 == sum(r["week2"] for r in u["dismiss_reasons"])


def test_written_files_match_generator(tmp_path, monkeypatch):
    monkeypatch.setattr(generate, "OUT", tmp_path)
    generate.main()
    site = Path(__file__).resolve().parents[1] / "site" / "data"
    for name in ("orders.json", "planted.json", "usage.json", "practice.json"):
        assert json.loads((tmp_path / name).read_text()) == json.loads((site / name).read_text()), name


def test_practice_round():
    orders, planted = generate.make_practice()
    assert len(orders) == 10
    assert {p["check"] for p in planted} == set(generate.PLANT)  # every check appears
    broken = {p["order"] for p in planted}
    assert len([o for o in orders if o["id"] not in broken]) == 2  # two clean orders
    assert generate.make_practice() == (orders, planted)


def test_policy_status_is_possible():
    """Only orders that start today can be active; every broken order is still waiting to bind."""
    orders, planted = generate.make_day()
    broken = {p["order"] for p in planted}
    for o in orders:
        if o["policy_status"] == "Active":
            assert o["effective_date"] == generate.DAY
        else:
            assert o["policy_status"] == "Ready to bind" and o["effective_date"] > generate.DAY
        if o["id"] in broken:
            assert o["policy_status"] == "Ready to bind"
