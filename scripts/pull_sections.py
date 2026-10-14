"""Save the latest text of every section to ../chapter/curated/, with its approval status.

Used before writing the introduction and conclusion from the approved text, and to see
what readers changed.
"""
from chapter_lib import SECTIONS, latest_versions
from supa import ROOT, load_env, request

OUT = ROOT.parent / "chapter" / "curated"


def main():
    env = load_env()
    names = {r["user_id"]: r["display_name"] for r in request(env, "GET", "/rest/v1/readers?select=*")[1]}
    OUT.mkdir(parents=True, exist_ok=True)
    lines = ["# Section status", ""]
    for s, r in sorted(latest_versions(env).items()):
        (OUT / f"s{s}.md").write_text(r["body"], encoding="utf-8")
        by = "AI" if not r["created_by"] else names.get(r["created_by"], "a reader")
        approved = len(r["approvals"]) >= 2
        lines.append(f"- §{s} {SECTIONS[s][0]}: v{r['version']} by {by} — {len(r['approvals'])} approval(s)"
                     f"{' (approved)' if approved else ''}: {', '.join(names.get(u, '?') for u in r['approvals'])}")
        print(lines[-1][2:])
    (OUT / "status.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"saved to {OUT}")


if __name__ == "__main__":
    main()
