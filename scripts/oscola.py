"""Write OSCOLA first-citation footnotes for every reference to ../oscola_references.md
(and data/oscola.json), using Crossref metadata for DOIs and hand-written forms for the rest.

Run fetch first if new DOIs were added:  python3 scripts/oscola.py --fetch
The chapter uses OSCOLA footnotes with no bibliography, and footnotes count towards
the 5,000-6,000-word limit, so the file also gives each footnote's word count.
"""
import html
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from supa import ROOT

REFS = ROOT / "data" / "references.json"
CACHE = ROOT / "data" / "crossref_cache.json"
OUT_MD = ROOT.parent / "oscola_references.md"
OUT_JSON = ROOT / "data" / "oscola.json"
ACCESSED = "accessed 14 October 2026"
FDA = "https://www.fda.gov/regulatory-information/search-fda-guidance-documents/"

# The citation plan: first citations in chapter order (about 53, see Part A of the outline)
PLANNED = {
    1: ["s2-topol-ej-2019", "s2-stanford-hai-2026"],
    2: ["s2-moor-m-2023", "s2-singhal-k-2025", "s2-gao-s-2024", "s2-zou-j-2025"],
    3: ["s3-han-r-2024", "s3-gommers-j-2026", "s3-eisemann-n-2025", "s3-chen-rj-2024", "s3-goh-e-2024",
        "s3-tu-t-2025", "s3-brodeur-pg-2026", "s3-bean-am-2026", "s3-budzyn-k-2025"],
    4: ["s4-wong-a-2021", "s4-adams-r-2022", "s4-patel-h-2026", "s4-nong-p-2025", "s4-lukac-pj-2025", "s4-afshar-m-2025"],
    5: ["s5-abramson-j-2024", "s5-xu-z-2025", "s5-jayatunga-mkp-2024", "s5-gottweis-j-2026", "s5-swanson-k-2025",
        "s5-ahlmann-eltze-c-2025"],
    6: ["s6-bastian-h-2010", "s6-hanson-ma-2024", "s6-suchak-t-2025", "s6-kobak-d-2025", "s6-khraisha-q-2024",
        "s6-lieberum-jl-2025", "s6-cao-c-2025", "s6-polzak-c-2026", "s6-errington-tm-2021", "s6-starace-g-2025",
        "s6-liang-w-2024"],
    7: ["s7-elliott-jh-2014", "s7-thomas-j-2017", "s7-siemieniuk-ra-2020", "s7-asai-a-2026", "s7-skarlinski-md-2024",
        "s6-walters-wh-2023", "s6-flemyng-e-2025"],
    8: ["s8-obermeyer-z-2019", "s8-finlayson-sg-2021", "s8-asgari-e-2025", "s8-regulation-nd", "s8-us-fda-2024",
        "s8-world-health-organizatio-2024", "s8-collins-gs-2024", "s8-gallifant-j-2025"],
}

PREPRINT_NOTE = "Preprint: say so in the text or footnote."

# References without a Crossref record (no DOI, or a DataCite DOI)
MANUAL = {
    "s2-stanford-hai-2026": "Stanford Institute for Human-Centered Artificial Intelligence, *AI Index Report 2026* (Stanford University 2026) ch 6 'Medicine' <https://hai.stanford.edu/ai-index/2026-ai-index-report/medicine> " + ACCESSED + ".",
    "s3-nori-h-2025": "Harsha Nori and others, 'Sequential Diagnosis with Language Models' (arXiv:2506.22405, 2025) <https://arxiv.org/abs/2506.22405> " + ACCESSED + ".",
    "s3-us-fda-artificial-intell-nd": "US Food and Drug Administration, 'Artificial Intelligence-Enabled Medical Devices' (FDA, 4 September 2026) <https://www.fda.gov/medical-devices/artificial-intelligence-enabled-medical-devices/list-artificial-intelligence-enabled-medical-devices> " + ACCESSED + ".",
    "s4-american-medical-associa-2026": "American Medical Association, *2026 Physician Survey on Augmented Intelligence* (AMA 2026) <https://www.ama-assn.org/practice-management/digital-health/more-80-physicians-use-ai-professionally-ama-survey> " + ACCESSED + ".",
    "s5-royal-swedish-academy-of-2024": "Royal Swedish Academy of Sciences, 'The Nobel Prize in Chemistry 2024' (press release, 9 October 2024) <https://www.nobelprize.org/prizes/chemistry/2024/press-release/> " + ACCESSED + ".",
    "s5-ema-chmp-2022": "European Medicines Agency, Committee for Medicinal Products for Human Use, *Qualification Opinion for Prognostic Covariate Adjustment (PROCOVA™)* (EMA 2022) <https://www.ema.europa.eu/documents/regulatory-procedural-guideline/qualification-opinion-prognostic-covariate-adjustment-procovatm_en.pdf> " + ACCESSED + ".",
    "s5-us-fda-2025": "US Food and Drug Administration, *Considerations for the Use of Artificial Intelligence to Support Regulatory Decision-Making for Drug and Biological Products* (Draft Guidance for Industry, January 2025) <" + FDA + "considerations-use-artificial-intelligence-support-regulatory-decision-making-drug-and-biological> " + ACCESSED + ".",
    "s6-national-library-of-medi-nd": "National Library of Medicine, 'MEDLINE/PubMed Production Statistics' (NLM) <https://www.nlm.nih.gov/bsd/medline_pubmed_production_stats.html> " + ACCESSED + ".",
    "s6-polzak-c-2026": "Christopher Polzak and others, 'Can Large Language Models Match the Conclusions of Systematic Reviews?' (International Conference on Learning Representations, 2026) <https://mlanthology.org/iclr/2026/polzak2026iclr-large/> " + ACCESSED + ".",
    "s6-thomas-j-2024": "James Thomas, Ella Flemyng and Anna Noel-Storr, 'Responsible Use of AI in Evidence SynthEsis (RAISE): Recommendations and Guidance' (OSF, 2025) <https://doi.org/10.17605/OSF.IO/FWAUD> " + ACCESSED + ".",
    "s6-starace-g-2025": "Giulio Starace and others, 'PaperBench: Evaluating AI's Ability to Replicate AI Research' in *Proceedings of the 42nd International Conference on Machine Learning* (PMLR 267, 2025) 56843.",
    "s6-siegel-zs-2024": "Zachary S Siegel and others, 'CORE-Bench: Fostering the Credibility of Published Research Through a Computational Reproducibility Agent Benchmark' [2024] Transactions on Machine Learning Research <https://arxiv.org/abs/2409.11363> " + ACCESSED + ".",
    "s6-kohler-b-2026": "Benjamin Kohler and others, 'Read the Paper, Write the Code: Agentic Reproduction of Social-Science Results' (arXiv:2604.21965, 2026) <https://arxiv.org/abs/2604.21965> " + ACCESSED + ".",
    "s6-alizadeh-m-2026": "Meysam Alizadeh and others, 'AI Coding Agents Can Reproduce Social Science Findings' (arXiv:2606.11447, 2026) <https://arxiv.org/abs/2606.11447> " + ACCESSED + ".",
    "s6-holtdirk-t-2026": "Tobias Holtdirk and others, 'Automated Reproducibility Assessments in the Social and Behavioral Sciences Using Large Language Models' (arXiv:2606.13670, 2026) <https://arxiv.org/abs/2606.13670> " + ACCESSED + ".",
    "s6-liang-w-2024-2": "Weixin Liang and others, 'Monitoring AI-Modified Content at Scale: A Case Study on the Impact of ChatGPT on AI Conference Peer Reviews' in *Proceedings of the 41st International Conference on Machine Learning* (PMLR 235, 2024) 29575.",
    "s7-skarlinski-md-2024": "Michael D Skarlinski and others, 'Language Agents Achieve Superhuman Synthesis of Scientific Knowledge' (arXiv:2409.13740, 2024) <https://arxiv.org/abs/2409.13740> " + ACCESSED + ".",
    "s7-rao-d-2026": "Delip Rao, Eric Wong and Chris Callison-Burch, 'Detecting and Correcting Reference Hallucinations in Commercial LLMs and Deep Research Agents' (arXiv:2604.03173, 2026) <https://arxiv.org/abs/2604.03173> " + ACCESSED + ".",
    "s8-joint-commission-coaliti-2025": "The Joint Commission and Coalition for Health AI, *Guidance on the Responsible Use of AI in Healthcare (RUAIH)* (2025) <https://www.chai.org/news/joint-commission-and-coalition-for-health-ai-chai-release-initial-guidance> " + ACCESSED + ".",
    "s8-regulation-nd": "Regulation (EU) 2024/1689 of the European Parliament and of the Council of 13 June 2024 laying down harmonised rules on artificial intelligence (Artificial Intelligence Act) [2024] OJ L2024/1689.",
    "s8-regulation-nd-2": "Regulation (EU) 2026/1744 [full title and date to be confirmed against the Official Journal] [2026] OJ L2026/1744.",
    "s8-mdcg-2025-6-ai-board-2025": "Medical Device Coordination Group and Artificial Intelligence Board, 'MDCG 2025-6: FAQ on Interplay between the MDR/IVDR and the AI Act' (European Commission 2025) <https://health.ec.europa.eu/medical-devices-sector/new-regulations/guidance-mdcg-endorsed-documents-and-other-guidance_en> " + ACCESSED + ".",
    "s8-us-fda-2024": "US Food and Drug Administration, *Marketing Submission Recommendations for a Predetermined Change Control Plan for Artificial Intelligence-Enabled Device Software Functions* (Guidance for Industry and Food and Drug Administration Staff, December 2024) <" + FDA + "marketing-submission-recommendations-predetermined-change-control-plan-artificial-intelligence> " + ACCESSED + ".",
    "s8-us-fda-2025": "US Food and Drug Administration, *Artificial Intelligence-Enabled Device Software Functions: Lifecycle Management and Marketing Submission Recommendations* (Draft Guidance for Industry and Food and Drug Administration Staff, January 2025) <" + FDA + "artificial-intelligence-enabled-device-software-functions-lifecycle-management-and-marketing> " + ACCESSED + ".",
    "s8-us-fda-2026": "US Food and Drug Administration, *Clinical Decision Support Software* (Guidance for Industry and Food and Drug Administration Staff, January 2026) <" + FDA + "clinical-decision-support-software> " + ACCESSED + ".",
    "s8-world-health-organizatio-2024": "World Health Organization, *Ethics and Governance of Artificial Intelligence for Health: Guidance on Large Multi-Modal Models* (WHO 2024) <https://www.who.int/publications/i/item/9789240084759> " + ACCESSED + ".",
}

# Short forms for later footnotes ("Topol (n 3)") where the author list doesn't give one
SHORT = {
    "s2-stanford-hai-2026": "Stanford HAI, *AI Index Report 2026*",
    "s3-us-fda-artificial-intell-nd": "FDA, 'AI-Enabled Medical Devices'",
    "s4-american-medical-associa-2026": "American Medical Association",
    "s5-royal-swedish-academy-of-2024": "Royal Swedish Academy of Sciences",
    "s5-ema-chmp-2022": "EMA, *PROCOVA Qualification Opinion*",
    "s5-us-fda-2025": "FDA, *AI to Support Regulatory Decision-Making*",
    "s6-national-library-of-medi-nd": "National Library of Medicine",
    "s8-joint-commission-coaliti-2025": "Joint Commission and CHAI",
    "s8-regulation-nd": "AI Act",
    "s6-open-science-collaborati-2015": "Open Science Collaboration",
    "s8-chart-collaborative-2025": "CHART Collaborative",
    "s8-regulation-nd-2": "Regulation (EU) 2026/1744",
    "s8-mdcg-2025-6-ai-board-2025": "MDCG 2025-6",
    "s8-us-fda-2024": "FDA, *PCCP Guidance*",
    "s8-us-fda-2025": "FDA, *AI-Enabled Device Software Functions*",
    "s8-us-fda-2026": "FDA, *Clinical Decision Support Software*",
    "s8-world-health-organizatio-2024": "WHO, *Guidance on Large Multi-Modal Models*",
}

# Notes on specific footnotes (in addition to the verification flags)
NOTES = {
    "s8-regulation-nd-2": "Confirm the full title and date against the Official Journal before citing.",
    "s8-mdcg-2025-6-ai-board-2025": "Title as reported in secondary sources: confirm against the MDCG document.",
    "s7-rao-d-2026": "Title corrected from the arXiv record; contents not yet checked.",
}

MINOR = {"a", "an", "the", "and", "but", "or", "nor", "for", "so", "yet", "of", "on", "in", "to", "at", "by", "with",
         "from", "as", "via", "vs", "versus", "into", "over", "per", "than", "up"}


def fetch():
    refs = json.loads(REFS.read_text(encoding="utf-8"))
    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    for p in refs:
        doi = p["doi"]
        if not doi or doi in cache:
            continue
        url = "https://api.crossref.org/works/" + urllib.parse.quote(doi, safe="/()")
        req = urllib.request.Request(url, headers={"User-Agent": "chapter-reading-tracker/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                cache[doi] = json.load(resp)["message"]
        except urllib.error.HTTPError:
            cache[doi] = None
        time.sleep(0.25)
    CACHE.write_text(json.dumps(cache))


def title_case(title):
    """OSCOLA capitalises the first letter of major words; leave acronyms and mixed-case words alone."""
    if title.isupper():
        title = title.lower()
    title = re.sub(r"(\d) (st|nd|rd|th)\b", r"\1\2", title)  # "21 st" from a stripped superscript
    out, start = [], True
    for token in re.split(r"(\s+|—|–)", title):
        if not token or token.isspace() or token in ("—", "–"):
            out.append(token)
            start = start or token in ("—", "–")
            continue
        parts = []
        for i, part in enumerate(token.split("-")):
            core = part.strip("'\"‘“(")
            lower = core.lower()
            if not core or not core[0].isalpha() or any(c.isupper() for c in core[1:]) or any(c.isdigit() for c in core):
                parts.append(part)  # acronyms, GPT-4, mRNA, numbers: as written
            elif lower in MINOR and not start and i == 0:
                parts.append(part.lower())
            else:
                lead = part[:len(part) - len(part.lstrip("'\"‘“("))]
                parts.append(lead + core[0].upper() + core[1:])
        out.append("-".join(parts))
        start = token.endswith((":", "?", "—", "–")) or token in ("—", "–")
    return "".join(out)


def person(author):
    if author.get("name"):
        return author["name"]
    family = author.get("family", "")
    if family.isupper():
        family = family.title()
    given = author.get("given", "")
    if given.isupper() and len(given.replace(".", "").replace(" ", "")) > 3:
        given = given.title()
    tokens = given.replace(".", ". ").replace("-", "- ").split()
    out = []
    for t in tokens:
        bare = t.rstrip(".")
        if len(bare) == 1 and out and out[-1].isupper() and len(out[-1]) <= 3 and not out[-1].endswith("-"):
            out[-1] += bare  # consecutive initials run together: "H. L. A." -> "HLA"
        else:
            out.append(bare)
    return " ".join([" ".join(out).replace("- ", "-"), family]).strip()


def authors(meta):
    names = [person(a) for a in meta.get("author", []) if a.get("family") or a.get("name")]
    if not names:
        return ""
    if len(names) > 3:
        return f"{names[0]} and others"
    return names[0] if len(names) == 1 else f"{', '.join(names[:-1])} and {names[-1]}"


def year_of(meta):
    for key in ("published-print", "journal-issue", "issued", "published-online"):
        node = meta.get(key) or {}
        if key == "journal-issue":
            node = node.get("published-print") or {}
        parts = (node.get("date-parts") or [[None]])[0]
        if parts and parts[0]:
            return parts[0]
    return None


def clean(text):
    return " ".join(html.unescape(re.sub(r"<[^>]+>", "", text or "")).split())


def volume_page(citation):
    """'... BMJ 370:m2980. doi:...' -> ('370', 'm2980') from the bibliography's own entry."""
    match = re.search(r"\s(\d+)(?:\([^)]*\))?:([A-Za-z]*\d+)(?:[–-][A-Za-z]*\d+)?\.\s+doi:", citation)
    return match.groups() if match else (None, None)


def from_crossref(meta, doi, citation):
    who = authors(meta)
    title = clean((meta.get("title") or [""])[0])
    if meta.get("subtitle") and meta["subtitle"][0].lower() not in title.lower():
        title += ": " + clean(meta["subtitle"][0])
    title = title_case(title.rstrip("."))
    head = f"{who}, '{title}'" if who else f"'{title}'"
    year = year_of(meta)
    link = f"<https://doi.org/{doi}> {ACCESSED}"
    kind = meta["type"]
    if kind == "posted-content":
        server = (meta.get("institution") or [{}])[0].get("name") or "preprint"
        return f"{head} ({server} preprint, {year}) {link}."
    if kind == "proceedings-article":
        venue = clean((meta.get("container-title") or [""])[0])
        page = (meta.get("page") or "").split("-")[0]
        return f"{head} in *{venue}* ({meta.get('publisher', '')} {year}){' ' + page if page else ''}."
    journal = clean((meta.get("container-title") or [""])[0])
    journal = re.sub(r"^The ", "", journal)
    volume = meta.get("volume")
    page = (meta.get("page") or "").split("-")[0] or meta.get("article-number") or ""
    if not volume or not page:
        bib_volume, bib_page = volume_page(citation)
        volume, page = volume or bib_volume, page or (bib_page if (bib_volume or "") == (volume or bib_volume) else "")
    if volume and page:
        return f"{head} ({year}) {volume} {journal} {page}."
    if volume:  # no page or article number: give the DOI so the article can be found
        return f"{head} ({year}) {volume} {journal} <https://doi.org/{doi}>."
    return f"{head} [{year}] {journal} {link}."  # online first: no volume or pages yet


def surnames(full):
    """Short author form from the full footnote: 'A', 'A and B', 'A, B and C' or 'A and others'."""
    head = full.split(", '", 1)[0] if ", '" in full else full.split(", *", 1)[0]
    others = head.endswith(" and others")
    head = head.removesuffix(" and others")
    people = re.split(r", | and ", head)
    last = [re.sub(r"^(?:.*? )??((?:(?:van|de|von|der|den|la|le) )*\S+)$", r"\1", x, flags=re.I) for x in people]
    if others:
        return f"{last[0]} and others"
    return last[0] if len(last) == 1 else f"{', '.join(last[:-1])} and {last[-1]}"


def short_title(full):
    match = re.search(r"'([^']+)'", full) or re.search(r"\*([^*]+)\*", full)
    title = match.group(1).split(":")[0] if match else ""
    cut = title.split()
    return " ".join(cut[:5]) + ("…" if len(cut) > 5 else "")


def short_forms(forms):
    """OSCOLA short forms; where two sources share one, add a short title to tell them apart."""
    base = {pid: SHORT.get(pid) or surnames(full) for pid, full in forms.items()}
    seen = {}
    for pid, short in base.items():
        seen.setdefault(short, []).append(pid)
    out = {}
    for pid, short in base.items():
        if len(seen[short]) > 1 and pid not in SHORT:
            title = short_title(forms[pid])
            out[pid] = f"{short}, '{title}'" if title else short
        else:
            out[pid] = short
    return out


def words(text):
    return len(text.replace("*", "").split())


def main():
    if "--fetch" in sys.argv:
        fetch()
    refs = json.loads(REFS.read_text(encoding="utf-8"))
    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    by_id = {p["id"]: p for p in refs}
    forms = {}
    missing = []
    for p in refs:
        meta = cache.get(p["doi"]) if p["doi"] else None
        if p["id"] in MANUAL:
            forms[p["id"]] = MANUAL[p["id"]]
        elif meta:
            forms[p["id"]] = from_crossref(meta, p["doi"], p["citation"])
        else:
            missing.append(p["id"])
    if missing:
        sys.exit(f"no OSCOLA form for {missing}: run with --fetch, or add them to MANUAL")
    planned_ids = [pid for ids in PLANNED.values() for pid in ids]
    unknown = [pid for pid in planned_ids if pid not in by_id]
    if unknown:
        sys.exit(f"PLANNED lists unknown ids: {unknown}")

    def notes(p):
        out = []
        if p["verify_flag"] == "preprint":
            out.append(PREPRINT_NOTE)
        elif p["verify_flag"] in ("partly", "unverified") and p["id"] not in NOTES:
            out.append("Only partly verified: check before citing.")
        if p["id"] in NOTES:
            out.append(NOTES[p["id"]])
        if p["check_notes"]:
            out.append("Check: " + " ".join(p["check_notes"]))
        return out

    def entry(p):
        line = f"- {forms[p['id']]} *({words(forms[p['id']])} words)*"
        extra = notes(p)
        return [line] + [f"  - {n}" for n in extra]

    planned_words = sum(words(forms[pid]) for pid in planned_ids)
    titles = {p["section"]: p["section_title"] for p in refs}
    titles[1] = "Introduction and approach"
    lines = [
        "# OSCOLA footnotes for the chapter's references",
        "",
        "Generated by `reading-tracker/scripts/oscola.py` from Crossref metadata (hand-written for reports, "
        "legislation, guidance and preprints). Each entry is the **first, full citation** for a footnote; add a pinpoint "
        "page before the final full stop where needed (e.g. `… (2019) 25 Nature Medicine 44, 47.`).",
        "",
        "## House style (OSCOLA, as required by the publisher)",
        "",
        "- **Footnotes only, no bibliography.** Every source is cited in full in its first footnote.",
        "- **Later citations** use a short form with a cross-reference to the first footnote: `Topol (n 3) 47.` "
        "Use `ibid` for the same source as the immediately preceding footnote.",
        "- **Authors** are given as in the publication, without full stops after initials. Name up to three authors; "
        "for more than three, give the first followed by 'and others'.",
        "- **Titles** of articles go in single quotation marks; titles of books, reports and guidance go in italics. "
        "Journal names are in roman, not italics.",
        "- **Year:** round brackets when the journal has volume numbers, `(2019) 25 Nature Medicine 44`; square brackets "
        "when it does not, or while an article is online first, `[2026] Lancet <https://doi.org/…>`. Use the year of "
        "the volume, which settles the online-versus-print question in the outline's Part D.",
        "- **Online sources** end with the web address in angle brackets and the date accessed. Update the access "
        "dates to the date you last checked each page before submission.",
        "- **Footnotes end with a full stop.**",
        "",
        "## Word budget",
        "",
        f"Footnotes count towards the 5,000–6,000-word limit. The {len(planned_ids)} planned first citations below "
        f"come to **{planned_words:,} words** (an average of {planned_words / len(planned_ids):.1f} words each). "
        "Short-form repeats cost about 4 words each.",
        "",
        "## Planned citations, in chapter order",
        "",
    ]
    for section, ids in PLANNED.items():
        cost = sum(words(forms[pid]) for pid in ids)
        lines += [f"### §{section} {titles[section]} — {len(ids)} citations, {cost} words", ""]
        for pid in ids:
            lines += entry(by_id[pid])
        lines.append("")
    lines += ["## All other references, by section", "",
              "Available if a point needs extra support, but each one adds to the word count.", ""]
    for section in sorted({p["section"] for p in refs}):
        rest = sorted((p for p in refs if p["section"] == section and p["id"] not in planned_ids),
                      key=lambda p: (p["rank"] or 999, forms[p["id"]]))
        if not rest:
            continue
        lines += [f"### §{section} {titles[section]}", ""]
        for p in rest:
            lines += entry(p)
        lines.append("")
    OUT_MD.write_text("\n".join(lines), encoding="utf-8")
    shorts = short_forms(forms)
    OUT_JSON.write_text(json.dumps({pid: {"full": forms[pid], "short": shorts[pid]} for pid in forms},
                                   indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {OUT_MD} ({len(forms)} references; {len(planned_ids)} planned = {planned_words} words)")


if __name__ == "__main__":
    main()
