"""Collect the readers' feedback on the draft into ../chapter/feedback/round-N.md, for the AI rebuild.

Section by section and paper by paper: each claim with its verdicts, comments and suggested
wording; the paper decisions (approve, approve with additions, reject); claims and information
readers added; and conflicts for the chapter lead to decide. During section review it also
lists edits and approvals.

  python3 scripts/export_feedback.py            # next round number
  python3 scripts/export_feedback.py --round 2
"""
import argparse
import json
from collections import defaultdict
from datetime import date

from chapter_lib import SECTIONS, latest_versions
from supa import ROOT, load_env, request

OUT = ROOT.parent / "chapter" / "feedback"
VERDICT = {"supported": "supported", "needs_change": "NEEDS CHANGE", "not_supported": "NOT SUPPORTED"}
DECISION = {"approve": "approve as drafted", "approve_with_additions": "approve with additions", "reject": "REJECT the paper"}


def fetch(env, table, query="select=*"):
    status, rows = request(env, "GET", f"/rest/v1/{table}?{query}")
    if status >= 300:
        raise SystemExit(f"could not read {table} ({status}): {rows}")
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--round", type=int)
    args = ap.parse_args()
    env = load_env()
    OUT.mkdir(parents=True, exist_ok=True)
    rnd = args.round or len(list(OUT.glob("round-*.md"))) + 1

    names = {r["user_id"]: r["display_name"] for r in fetch(env, "readers")}
    papers = {p["id"]: p for p in fetch(env, "papers", "select=id,short_cite,title,section")}
    claims = fetch(env, "draft_claims", "select=*&order=section,id")
    reviews = defaultdict(list)
    for r in fetch(env, "claim_reviews"):
        reviews[r["claim_id"]].append(r)
    decisions = defaultdict(list)
    for r in fetch(env, "paper_reviews"):
        decisions[r["paper_id"]].append(r)
    readers_of = defaultdict(list)
    for c in fetch(env, "claims"):
        readers_of[c["paper_id"]].append(c["user_id"])
    stage = fetch(env, "chapter_state")[0]["stage"]

    lines = [f"# Reader feedback, round {rnd} — exported {date.today().isoformat()} (stage: {stage})", ""]
    conflicts, summary = [], defaultdict(int)
    for section in sorted({c["section"] or papers[c["paper_id"]]["section"] for c in claims}):
        in_section = [c for c in claims if (c["section"] or papers[c["paper_id"]]["section"]) == section]
        lines += [f"## §{section} {SECTIONS[section][0]}", ""]
        for pid in dict.fromkeys(c["paper_id"] for c in in_section):
            p = papers[pid]
            who = ", ".join(names.get(u, "?") for u in readers_of[pid]) or "nobody"
            lines += [f"### {p['short_cite']} — `{pid}`", f"Readers who claimed it: {who}", ""]
            kinds = {d["decision"] for d in decisions[pid]}
            for d in decisions[pid]:
                summary[d["decision"]] += 1
                lines.append(f"- **Decision — {names.get(d['user_id'], '?')}: {DECISION[d['decision']]}**")
                if d.get("reason"):
                    lines.append(f"  - Reason: {d['reason']}")
                if d.get("extra_info"):
                    lines.append(f"  - Extra information: {d['extra_info']}")
            if not decisions[pid]:
                lines.append("- No decision yet")
            if "reject" in kinds and len(kinds) > 1:
                conflicts.append(f"{p['short_cite']} (§{section}): one reader rejects it, another approves")
            for c in [c for c in in_section if c["paper_id"] == pid]:
                origin = "AI" if c["basis"] != "reader" else f"added by {names.get(c['added_by'], '?')}"
                lines.append(f"- Claim {c['id']} ({origin}, {c['basis'].replace('_', ' ')}, status {c['status']}): {c['claim']}"
                             + (f" [{c['pinpoint']}]" if c.get("pinpoint") else ""))
                if c.get("anchor"):
                    lines.append(f"  - In the text: \"{c['anchor']}\"")
                verdicts = {r["verdict"] for r in reviews[c["id"]]}
                for r in reviews[c["id"]]:
                    summary[r["verdict"]] += 1
                    detail = "; ".join(x for x in (r.get("comment"), f"suggested: {r['suggested_wording']}" if r.get("suggested_wording") else None,
                                                    f"p {r['page']}" if r.get("page") else None) if x)
                    lines.append(f"  - {names.get(r['user_id'], '?')}: {VERDICT[r['verdict']]}{' — ' + detail if detail else ''}")
                if not reviews[c["id"]] and c["basis"] != "reader":
                    lines.append("  - Not reviewed yet")
                if "supported" in verdicts and len(verdicts) > 1:
                    conflicts.append(f"Claim {c['id']} on {p['short_cite']}: readers disagree ({', '.join(sorted(verdicts))})")
            lines.append("")

    if stage in ("section_review", "final"):
        lines += ["## Section edits and approvals", ""]
        latest = latest_versions(env)
        for s, r in sorted(latest.items()):
            by = "AI" if not r["created_by"] else names.get(r["created_by"], "a reader")
            ok = "APPROVED" if len(r["approvals"]) >= 2 else "not yet approved"
            lines.append(f"- §{s} v{r['version']} by {by} ({r['change_note'] or 'no note'}): "
                         f"{len(r['approvals'])} approval(s), {ok}: {', '.join(names.get(u, '?') for u in r['approvals'])}")
        lines.append("")

    head = [f"**Summary:** {len(claims)} claims · "
            + " · ".join(f"{k.replace('_', ' ')}: {v}" for k, v in sorted(summary.items())), ""]
    if conflicts:
        head += ["**Conflicts for the chapter lead to decide:**", ""] + [f"- {c}" for c in conflicts] + [""]
    lines[2:2] = head
    out = OUT / f"round-{rnd}.md"
    out.write_text("\n".join(lines), encoding="utf-8")
    (OUT / f"round-{rnd}.json").write_text(json.dumps({"claims": claims, "reviews": reviews, "decisions": decisions},
                                                      indent=1, ensure_ascii=False, default=list), encoding="utf-8")
    print(f"wrote {out} ({len(claims)} claims, {len(conflicts)} conflicts)")


if __name__ == "__main__":
    main()
