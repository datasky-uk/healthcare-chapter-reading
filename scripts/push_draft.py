"""Post AI-written section text and its claims to the tracker, and move the chapter between stages.

  python3 scripts/push_draft.py                       # push ../chapter/draft/s*.md and claims.json
  python3 scripts/push_draft.py --dry-run             # check keys, anchors and word counts only
  python3 scripts/push_draft.py --note "Rebuilt from round 1 feedback"
  python3 scripts/push_draft.py --stage claim_review  # reading | claim_review | section_review | final
  python3 scripts/push_draft.py --status              # word counts and approvals of the current text

claims.json is a list. New claims: {"paper_id", "section", "anchor", "claim", "pinpoint", "basis"}
(basis: full_text or abstract; the anchor must appear word for word in that section's text).
Changes to existing claims after a rebuild: {"id": 12, "status": "addressed" | "dropped"}.
A section whose text is unchanged is not given a new version.
"""
import argparse
import json
import sys
from pathlib import Path

from chapter_lib import SECTIONS, TITLE, WORD_LIMIT, CITE_RE, build_footnotes, count_words, latest_versions, load_forms, parse_cite
from supa import ROOT, load_env, request

DRAFT = ROOT.parent / "chapter" / "draft"
ABSTRACT = ROOT.parent / "materials" / "chapter_abstract.md"
STAGES = ("reading", "claim_review", "section_review", "final")


def call(env, method, path, body=None, headers=None):
    status, data = request(env, method, path, body, headers)
    if status >= 300:
        sys.exit(f"{method} {path} failed ({status}): {data}")
    return data


def abstract_text():
    text = ABSTRACT.read_text(encoding="utf-8")
    return text.split("## Abstract", 1)[1].strip() if "## Abstract" in text else text.strip()


def report(env, forms, bodies=None):
    """Word counts per section (text + footnotes) against the budgets, for the given or current text."""
    if bodies is None:
        bodies = {s: r["body"] for s, r in latest_versions(env).items()}
    ordered = [(s, bodies[s]) for s in sorted(bodies)]
    notes, unknown = build_footnotes(ordered, forms)
    abstract_words = count_words(abstract_text())
    total = abstract_words
    print(f"{'section':<58} {'text':>6} {'budget':>7} {'notes':>6} {'cites':>6}")
    for s, body in ordered:
        text_words = count_words(body)
        note_words = sum(count_words(n[3]) for n in notes[s])
        keys = {k for m in CITE_RE.finditer(body) for k, _ in parse_cite(m.group(1))}
        total += text_words + note_words
        title, budget, cites = SECTIONS[s]
        flag = "  over" if text_words > budget * 1.1 else ""
        print(f"§{s} {title[:54]:<55} {text_words:>6} {budget:>7} {note_words:>6} {len(keys):>3}/{cites:<2}{flag}")
    print(f"abstract {abstract_words} · total {total} words including footnotes (limit {WORD_LIMIT[0]:,}–{WORD_LIMIT[1]:,})")
    if unknown:
        print("UNKNOWN citation keys:", ", ".join(sorted(set(unknown))))
    return total, unknown


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", type=Path, default=DRAFT)
    ap.add_argument("--note", default="AI draft")
    ap.add_argument("--stage", choices=STAGES)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--status", action="store_true")
    args = ap.parse_args()
    env = load_env()
    forms = load_forms(env)

    if args.status:
        report(env, forms)
        for s, r in sorted(latest_versions(env).items()):
            print(f"§{s} v{r['version']} by {'AI' if not r['created_by'] else 'a reader'}: {len(r['approvals'])} approval(s)")
        return

    files = sorted(args.dir.glob("s[1-9].md")) if args.dir.exists() else []
    drafts = {int(f.stem[1:]): f.read_text(encoding="utf-8").strip() + "\n" for f in files}
    claims_file = args.dir / "claims.json"
    claims = json.loads(claims_file.read_text(encoding="utf-8")) if claims_file.exists() else []

    # Checks before anything is written
    problems = []
    for c in claims:
        if "id" in c:
            if c.get("status") not in ("open", "addressed", "dropped"):
                problems.append(f"claim {c['id']}: status must be open, addressed or dropped")
            continue
        if c.get("paper_id") not in forms:
            problems.append(f"claim on unknown paper {c.get('paper_id')}")
        if c.get("basis") not in ("full_text", "abstract"):
            problems.append(f"claim on {c.get('paper_id')}: basis must be full_text or abstract")
        body = drafts.get(c.get("section"))
        if body is None:
            problems.append(f"claim on {c.get('paper_id')}: no draft for §{c.get('section')}")
        elif c.get("anchor") not in body:
            problems.append(f"claim on {c.get('paper_id')} in §{c['section']}: anchor not found: {c.get('anchor', '')[:80]!r}")
    current = latest_versions(env)
    bodies = {s: r["body"] for s, r in current.items()}
    bodies.update(drafts)
    if drafts:
        _, unknown = report(env, forms, bodies)
        problems += [f"unknown citation key {k}" for k in sorted(set(unknown))]
    if problems:
        sys.exit("Not pushed:\n- " + "\n- ".join(problems))
    if args.dry_run:
        print("dry run: everything checks out")
        return

    call(env, "POST", "/rest/v1/chapter_sections?on_conflict=section",
         [{"section": s, "title": t, "word_budget": w, "citation_budget": c} for s, (t, w, c) in SECTIONS.items()],
         {"Prefer": "resolution=merge-duplicates,return=minimal"})
    call(env, "PATCH", "/rest/v1/chapter_state?id=eq.true", {"title": TITLE, "abstract": abstract_text()})

    version_ids = {}
    for s, body in sorted(drafts.items()):
        if s in current and current[s]["body"] == body:
            print(f"§{s}: unchanged, kept v{current[s]['version']}")
            version_ids[s] = current[s]["id"]
            continue
        row = call(env, "POST", "/rest/v1/section_versions",
                   {"section": s, "body": body, "change_note": args.note, "created_by": None},
                   {"Prefer": "return=representation"})[0]
        version_ids[s] = row["id"]
        print(f"§{s}: pushed v{row['version']}")
    # Re-running with the same claims.json must not add the same claims twice
    existing = {(c["paper_id"], c["section"], c["anchor"], c["claim"])
                for c in call(env, "GET", "/rest/v1/draft_claims?select=paper_id,section,anchor,claim&added_by=is.null")}
    new = [{"paper_id": c["paper_id"], "section": c["section"], "section_version_id": version_ids[c["section"]],
            "anchor": c["anchor"], "claim": c["claim"], "pinpoint": c.get("pinpoint") or None, "basis": c["basis"]}
           for c in claims if "id" not in c and (c["paper_id"], c["section"], c["anchor"], c["claim"]) not in existing]
    if new:
        call(env, "POST", "/rest/v1/draft_claims", new, {"Prefer": "return=minimal"})
    for c in claims:
        if "id" in c:
            call(env, "PATCH", f"/rest/v1/draft_claims?id=eq.{int(c['id'])}", {"status": c["status"]})
    print(f"claims: {len(new)} added, {sum('id' in c for c in claims)} updated")
    if args.stage:
        call(env, "PATCH", "/rest/v1/chapter_state?id=eq.true", {"stage": args.stage})
        print("stage is now", args.stage)


if __name__ == "__main__":
    main()
