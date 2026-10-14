"""Build data/references.json from ../chapter_outline_and_literature.md.

Parses Part C (full bibliography, one "- " line per reference under each
"### §N ..." heading) and joins ranks, tags and "why read it" text from the
Part B table. Ranked rows are matched to bibliography entries by a unique
substring (usually the DOI), listed in RANK_KEYS below.
"""
import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT.parent / "chapter_outline_and_literature.md"
OUT = ROOT / "data" / "references.json"

# rank -> substring that identifies exactly one Part C entry
RANK_KEYS = {
    1: "S2589-7500(24)00047-5", 2: "s41586-023-05881-4", 3: "S0140-6736(25)02464-X",
    4: "jamanetworkopen.2024.40969", 5: "s41591-025-04074-y", 6: "S0140-6736(26)01535-7",
    7: "jamainternmed.2021.2626", 8: "hlthaff.2024.00842", 9: "s41586-024-07487-w",
    10: "s41591-025-03743-2", 11: "qss_a_00327", 12: "j.jclinepi.2025.111746",
    13: "2025.06.13.25329541", 14: "JBIES-25-00480", 15: "journal.pmed.1001603",
    16: "s41586-025-10072-4", 17: "s41591-018-0300-7", 18: "s41591-024-03423-7",
    19: "s41586-025-08866-7", 20: "s41591-024-03408-6", 21: "S2468-1253(25)00133-5",
    22: "s41591-024-02857-3", 23: "s41591-022-01894-0", 24: "s11606-026-10381-y",
    25: "AIoa2500945", 26: "AIoa2501000", 27: "science.aax2342", 28: "NEJMc2104626",
    29: "j.drudis.2024.104009", 30: "s41586-026-10644-y", 31: "s41586-025-09442-9",
    32: "s41592-025-02772-6", 33: "journal.pmed.1000326", 34: "journal.pbio.3003152",
    35: "jrsm.1715", 36: "polzak2026iclr", 37: "j.jclinepi.2017.08.011",
    38: "starace25a", 39: "AIoa2400196", 40: "bmj-2023-078378", 41: "s41591-024-03425-5",
    42: "2506.22405", 43: "s41586-026-10265-5", 44: "science.ads0018",
    45: "s41586-026-10176-5", 46: "s41586-025-09529-3", 47: "j.cell.2025.07.033",
    48: "AIdbp2300040", 49: "sciadv.adt3813", 50: "2409.13740", 51: "s42256-026-01188-x",
    52: "d41586-025-00648-5", 53: "2604.21965",
}

# Extra "check before citing" notes from Part D, keyed by a unique substring
EXTRA_CHECKS = {
    "S0140-6736(26)01535-7": "Online first: volume and pages pending.",
    "s11606-026-10381-y": "Online first: volume and pages pending.",
    "d41586-025-00648-5": "Black Spatula / YesNoError details come from secondary coverage.",
    "2026/1744": "Confirm against the Official Journal text.",
    "MDCG 2025-6": "Confirm against the primary MDCG text.",
}

# Author fields that end in capitals but are organisations, not "Surname INITIALS"
ORGANISATIONS = ("US ", "Stanford HAI", "Joint Commission", "CHART Collaborative")

TAG_NAMES = {"essential read": "essential", "should read": "should", "mildly interesting": "mildly"}


def slug(text):
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def plain(text):
    return text.replace("**", "").replace("*", "")


def parse_rank_table(md):
    part_b = md.split("## Part B", 1)[1].split("## Part C", 1)[0]
    rows = {}
    for line in part_b.splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) == 4 and cells[0].isdigit():
            rows[int(cells[0])] = {
                "short_cite": plain(cells[1]).replace(" [PREPRINT]", ""),
                "why_read": cells[2],
                "tag": TAG_NAMES[cells[3]],
            }
    return rows


def parse_entries(md):
    part_c = md.split("## Part C", 1)[1].split("## Part D", 1)[0]
    entries, section, title = [], None, None
    for line in part_c.splitlines():
        heading = re.match(r"### §(\d+) (.+)", line)
        if heading:
            section, title = int(heading.group(1)), heading.group(2).strip()
        elif line.startswith("- ") and section:
            entries.append({"section": section, "section_title": title, "raw": line[2:].strip()})
    return entries


def verify_flag(raw):
    flags = re.findall(r"\*\*\[([^\]]+)\]\*\*", raw)
    if not flags or "claim of" in raw:
        return "verified"
    flag = flags[-1].upper()
    if flag.startswith("PREPRINT, UNVERIFIED") or flag.startswith("UNVERIFIED"):
        return "unverified"
    if flag.startswith("PARTLY"):
        return "partly"
    if flag.startswith("PREPRINT"):
        return "preprint"
    return "verified"


def make_short_cite(raw, text, year):
    """'Surname et al. 2024, Journal' in the style of the ranked list; organisations keep their name."""
    authors = text.split(" (", 1)[0]
    first = authors.split(",")[0].strip()
    initials = re.match(r"^([^()]+?) ([A-Z]{1,3}|II)$", first)
    if not initials or first.startswith(ORGANISATIONS):  # organisation or legal document
        segment = re.split(r"\.\s", text, 1)[0]
        if segment.startswith("Regulation"):
            return segment
        name = re.sub(r"\s*\([^)]*\)", "", segment).strip()
        short = f"{name} {year}" if year else name
        if name == "US FDA":  # several FDA guidances: add the title to tell them apart
            title = re.split(r"\.\s", text.split(". ", 1)[1], 1)[0]
            short += ", " + (title if len(title) <= 50 else title[:48].rstrip() + "…")
        return short
    surname = initials.group(1)
    many = authors.count(",") >= 1 or "et al" in authors
    unflagged = re.sub(r"\*\*\[[^\]]+\]\*\*", "", raw)
    journal = re.search(r"\*([^*]+)\*", unflagged.split("). ", 1)[-1])
    cite = f"{surname}{' et al.' if many else ''} {year or 'n.d.'}"
    return f"{cite}, {journal.group(1)}" if journal else cite


def enrich(entry):
    raw = entry["raw"]
    text = plain(re.sub(r"\s*\*\*\[[^\]]+\]\*\*", "", raw))
    year = re.search(r"\((?:[A-Z][a-z]{2} )?(\d{4})", raw)
    doi = re.search(r"doi:(10\.\S+?)(?=[\s,;]|\.(?:\s|$)|$)", raw)
    arxiv = re.search(r"arXiv:(\d{4}\.\d{4,5})", raw)
    url = re.search(r"https?://[^\s)]+", raw)
    authors = text.split(" (", 1)[0]
    first_author = re.split(r",| \(| et al", authors)[0].strip()
    title_match = re.search(r"\)\.\s(.+?(?:\?(?=\s)|(?=\.\s)|(?=\.$)))", text)
    tail = text[doi.end():] if doi else ""
    checks = [s.strip() for s in re.split(r"(?<=\.)\s", tail) if re.search(r"onfirm|heck", s)]
    entry.update({
        "citation": text,
        "auto_short_cite": make_short_cite(raw, text, int(year.group(1)) if year else None),
        "first_author": first_author,
        "year": int(year.group(1)) if year else None,
        "title": title_match.group(1).strip() if title_match else "",
        "doi": doi.group(1).rstrip(".") if doi else None,
        "arxiv": arxiv.group(1) if arxiv else None,
        "url": url.group(0).rstrip(".,") if url else None,
        "verify_flag": verify_flag(raw),
        "check_notes": checks,
    })
    for key, note in EXTRA_CHECKS.items():
        if key in raw and note not in entry["check_notes"]:
            entry["check_notes"].append(note)
    return entry


def main():
    md = SOURCE.read_text(encoding="utf-8")
    ranks = parse_rank_table(md)
    entries = [enrich(e) for e in parse_entries(md)]

    for rank, key in RANK_KEYS.items():
        hits = [e for e in entries if key in e["raw"]]
        if len(hits) != 1:
            sys.exit(f"rank {rank}: key {key!r} matched {len(hits)} entries")
        hits[0].update({"rank": rank, **ranks[rank]})

    # Keep ids stable across rebuilds: claims and notes in the tracker point at them
    previous = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else []
    old_ids = {}
    for p in previous:
        old_ids[("doi", (p.get("doi") or "").lower())] = p["id"]
        old_ids[("cite", p["citation"])] = p["id"]
    old_ids.pop(("doi", ""), None)

    seen = set()
    papers = []
    for e in entries:
        pid = old_ids.get(("doi", (e["doi"] or "").lower())) or old_ids.get(("cite", e["citation"]))
        if not pid or pid in seen:
            base = f"s{e['section']}-{slug(e['first_author'])[:24]}-{e['year'] or 'nd'}"
            pid, n = base, 2
            while pid in seen or pid in old_ids.values():
                pid, n = f"{base}-{n}", n + 1
        seen.add(pid)
        papers.append({
            "id": pid,
            "section": e["section"],
            "section_title": e["section_title"],
            "rank": e.get("rank"),
            "tag": e.get("tag", "reference"),
            "short_cite": e.get("short_cite") or e["auto_short_cite"],
            "why_read": e.get("why_read", ""),
            "title": e["title"],
            "citation": e["citation"],
            "first_author": e["first_author"],
            "year": e["year"],
            "doi": e["doi"],
            "arxiv": e["arxiv"],
            "url": e["url"],
            "verify_flag": e["verify_flag"],
            "check_notes": e["check_notes"],
        })

    tags = {t: sum(p["tag"] == t for p in papers) for t in ("essential", "should", "mildly", "reference")}
    assert len(papers) == 204, len(papers)
    assert sorted(p["rank"] for p in papers if p["rank"]) == list(range(1, 54))
    assert tags == {"essential": 16, "should": 25, "mildly": 12, "reference": 151}, tags

    OUT.write_text(json.dumps(papers, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    flags = {f: sum(p["verify_flag"] == f for p in papers) for f in ("verified", "preprint", "partly", "unverified")}
    print(f"wrote {len(papers)} papers to {OUT.relative_to(ROOT)}")
    print("tags:", tags)
    print("flags:", flags)
    print("with DOI:", sum(bool(p["doi"]) for p in papers), "| arXiv only:",
          sum(bool(p["arxiv"]) and not p["doi"] for p in papers))


if __name__ == "__main__":
    main()
