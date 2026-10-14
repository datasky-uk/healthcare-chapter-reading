"""Upsert data/references.json into the Supabase `papers` table (service key)."""
import json
import sys

from supa import ROOT, load_env, request

COLUMNS = ("id", "section", "section_title", "rank", "tag", "short_cite", "why_read", "title",
           "citation", "doi", "url", "is_oa", "oa_status", "oa_url", "pdf_url", "verify_flag", "check_notes")


def row(paper):
    out = {c: paper.get(c) for c in COLUMNS}
    # Prefer the full registered title where ours is a shortened form of it
    if paper.get("registered_title") and paper.get("title_match") is not None:
        out["title"] = paper["registered_title"]
    out["is_oa"] = bool(out["is_oa"])
    out["check_notes"] = out["check_notes"] or []
    if not out["url"] and out["doi"]:
        out["url"] = f"https://doi.org/{out['doi']}"
    return out


def main():
    env = load_env()
    papers = json.loads((ROOT / "data" / "references.json").read_text(encoding="utf-8"))
    rows = [row(p) for p in papers]
    status, body = request(env, "POST", "/rest/v1/papers?on_conflict=id", rows,
                           {"Prefer": "resolution=merge-duplicates,return=minimal"})
    if status >= 300:
        sys.exit(f"seed failed ({status}): {body}")
    # Papers no longer in the bibliography: remove them unless someone has claimed or noted them
    wanted = {r["id"] for r in rows}
    status, body = request(env, "GET", "/rest/v1/papers?select=id,claims(paper_id),notes(paper_id)")
    if status >= 300:
        sys.exit(f"could not list papers ({status}): {body}")
    kept = []
    for paper in body:
        if paper["id"] in wanted:
            continue
        if paper["claims"] or paper["notes"]:
            kept.append(paper["id"])
        else:
            request(env, "DELETE", f"/rest/v1/papers?id=eq.{paper['id']}")
            print(f"removed stale paper {paper['id']}")
    if kept:
        print("WARNING: these papers are no longer in the bibliography but have claims or notes, so they were kept:",
              ", ".join(kept))
    status, body = request(env, "GET", "/rest/v1/papers?select=id")
    print(f"seeded {len(rows)} papers; table now holds {len(body)}")


if __name__ == "__main__":
    main()
