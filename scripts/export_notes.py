"""Export every reader's notes to ../notes_export.md, grouped by chapter section.

Used to bring the team's reading back into the chapter drafting.
"""
from collections import defaultdict
from datetime import date

from supa import ROOT, load_env, request

TAG_LABEL = {"essential": "essential read", "should": "should read", "mildly": "mildly interesting",
             "reference": "reference"}


def fetch(env, table):
    status, body = request(env, "GET", f"/rest/v1/{table}?select=*")
    if status >= 300:
        raise SystemExit(f"could not read {table} ({status}): {body}")
    return body


def main():
    env = load_env()
    papers = {p["id"]: p for p in fetch(env, "papers")}
    names = {r["user_id"]: r["display_name"] for r in fetch(env, "readers")}
    claims = fetch(env, "claims")
    notes = fetch(env, "notes")

    by_paper = defaultdict(list)
    for n in notes:
        by_paper[n["paper_id"]].append(n)
    done = {(c["paper_id"], c["user_id"]) for c in claims if c["status"] == "done"}

    lines = [f"# Team reading notes — exported {date.today().isoformat()}", ""]
    ranked = [p for p in papers.values() if p["rank"]]
    lines.append(f"Notes on {len(by_paper)} of {len(papers)} papers; "
                 f"{sum(p['id'] in by_paper for p in ranked)} of {len(ranked)} ranked papers covered.")
    lines.append("")

    sections = sorted({(p["section"], p["section_title"]) for p in papers.values()})
    for number, title in sections:
        in_section = sorted((p for p in papers.values() if p["section"] == number and p["id"] in by_paper),
                            key=lambda p: (p["rank"] or 999, p["short_cite"] or ""))
        if not in_section:
            continue
        lines += [f"## §{number} {title}", ""]
        for p in in_section:
            rank = f"#{p['rank']} · " if p["rank"] else ""
            origin = f" · added by {names.get(p['added_by'], 'a reader')}" if p.get("added_by") else ""
            lines += [f"### {p['short_cite']} — {p['title'] or ''}".rstrip(" —"),
                      f"{rank}{TAG_LABEL[p['tag']]}{origin} · {p['url'] or ''}", ""]
            for n in sorted(by_paper[p["id"]], key=lambda n: names.get(n["user_id"], "")):
                who = names.get(n["user_id"], "Unknown reader")
                status = "done" if (p["id"], n["user_id"]) in done else "in progress"
                lines.append(f"**{who}** ({status}, updated {n['updated_at'][:10]})")
                for label, key in (("Key finding", "key_finding"), ("Design and sample", "design_sample"),
                                   ("Key numbers", "key_numbers"), ("Limitations", "limitations"),
                                   ("Use in the chapter", "chapter_use"), ("Quotable", "quotable")):
                    if n.get(key):
                        extra = " (checked against full text)" if key == "key_numbers" and n["numbers_verified"] else ""
                        lines.append(f"- {label}{extra}: {n[key].strip()}")
                if n.get("chapter_section") and n["chapter_section"] != number:
                    lines.append(f"- Suggested for §{n['chapter_section']} instead")
                if n.get("suggested_tag") and n["suggested_tag"] != p["tag"]:
                    lines.append(f"- Suggests re-tagging as: {TAG_LABEL[n['suggested_tag']]}")
                lines.append("")

    added = sorted((p for p in papers.values() if p.get("added_by")), key=lambda p: (p["section"], p["created_at"]))
    if added:
        lines += ["## Papers added by readers", "",
                  "Not in the original bibliography: add the ones worth citing to chapter_outline_and_literature.md.", ""]
        for p in added:
            why = f" — {p['why_read']}" if p.get("why_read") else ""
            lines.append(f"- §{p['section']} · {TAG_LABEL[p['tag']]} · {p['citation']}"
                         f" (added by {names.get(p['added_by'], 'a reader')}){why}")
        lines.append("")

    out = ROOT.parent / "notes_export.md"
    out.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {out} ({len(notes)} notes from {len({n['user_id'] for n in notes})} readers)")


if __name__ == "__main__":
    main()
