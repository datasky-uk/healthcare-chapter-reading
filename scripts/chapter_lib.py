"""Shared helpers for writing the chapter: citation keys, OSCOLA footnotes and word counts.

Section text is Markdown with citation keys: [@s3-han-r-2024] or [@s3-han-r-2024, e370], and
several sources in one footnote as [@a, 12; @b]. Footnotes are numbered across the whole chapter:
the first mention of a source gets its full OSCOLA form, later ones the short form with a
cross-reference ("Han and others (n 5) e371"), and a repeat of the source in the footnote
just before gets "ibid". web/app.js implements the same rules for the page.
"""
import json
import re

from supa import ROOT, request

# Chapter structure: title, main-text word budget and planned first citations (Part A of the outline)
SECTIONS = {
    1: ("Introduction and approach", 300, 2),
    2: ("Technological foundations", 400, 4),
    3: ("Diagnostics: imaging, signals and clinical reasoning", 550, 9),
    4: ("Clinical decision support, workflow and operations", 450, 6),
    5: ("Biomedical research and drug discovery", 450, 6),
    6: ("AI and the expanding biomedical literature", 700, 11),
    7: ("Emerging models of evidence synthesis", 650, 7),
    8: ("Cross-cutting challenges: bias, safety and governance", 400, 8),
    9: ("Conclusions and future directions", 200, 0),
}
TITLE = ("Artificial Intelligence in Healthcare: Current Capabilities and Emerging Directions "
         "for Clinical Practice and Biomedical Research")
WORD_LIMIT = (5000, 6000)

CITE_RE = re.compile(r"\[@([^\]]+)\]")
WORD_RE = re.compile(r"[0-9A-Za-zÀ-ÿ]")


def parse_cite(inner):
    """'@a, 12; @b' -> [('a', '12'), ('b', '')]"""
    out = []
    for part in inner.split(";"):
        part = part.strip().lstrip("@").strip()
        if not part:
            continue
        key, _, pin = part.partition(",")
        out.append((key.strip(), pin.strip()))
    return out


def count_words(text):
    """Words as a word processor counts them: whitespace-separated tokens with a letter or digit."""
    text = CITE_RE.sub(" ", text)
    text = re.sub(r"[#*_>`]", " ", text)
    return sum(1 for token in text.split() if WORD_RE.search(token))


def with_pin(full, pin):
    full = full.rstrip().rstrip(".")
    if not pin:
        return full
    if " <http" in full:  # pinpoint goes before the web address
        i = full.index(" <http")
        return f"{full[:i]} {pin}{full[i:]}"
    return f"{full}, {pin}"


def load_forms(env=None):
    """OSCOLA {id: {full, short}} from data/oscola.json, plus the papers table for papers readers added."""
    forms = json.loads((ROOT / "data" / "oscola.json").read_text(encoding="utf-8"))
    if env is not None:
        status, rows = request(env, "GET", "/rest/v1/papers?select=id,oscola,oscola_short,citation,short_cite")
        if status < 300:
            for r in rows:
                if r["id"] not in forms:
                    forms[r["id"]] = {"full": r["oscola"] or r["citation"], "short": r["oscola_short"] or r["short_cite"] or r["id"]}
    return forms


def build_footnotes(bodies, forms):
    """bodies: [(section, text)] in chapter order. Returns {section: [(match_start, match_end, number, text)]}
    and a list of unknown keys."""
    first, unknown, out = {}, [], {}
    n, previous = 0, None
    for section, body in bodies:
        notes = []
        for m in CITE_RE.finditer(body):
            n += 1
            cites = parse_cite(m.group(1))
            parts = []
            for key, pin in cites:
                if key not in forms:
                    unknown.append(key)
                    parts.append(f"[unknown reference: {key}]")
                elif len(cites) == 1 and previous and len(previous) == 1 and previous[0][0] == key:
                    parts.append(f"ibid {pin}".strip())
                elif key not in first:
                    first[key] = n
                    parts.append(with_pin(forms[key]["full"], pin))
                else:
                    parts.append(f"{forms[key]['short']} (n {first[key]}){' ' + pin if pin else ''}")
            notes.append((m.start(), m.end(), n, "; ".join(parts) + "."))
            previous = cites
        out[section] = notes
    return out, unknown


def to_pandoc(body, notes):
    """Replace citation keys with pandoc footnote references; return (text, footnote definitions)."""
    pieces, defs, last = [], [], 0
    for start, end, number, text in notes:
        pieces.append(body[last:start].rstrip(" "))
        pieces.append(f"[^{number}]")
        defs.append(f"[^{number}]: {text}")
        last = end
    pieces.append(body[last:])
    return "".join(pieces), defs


def latest_versions(env):
    """{section: row} for the newest version of each section, with 'approvals' (user ids) attached."""
    status, rows = request(env, "GET", "/rest/v1/section_versions?select=*&order=section,version")
    if status >= 300:
        raise SystemExit(f"could not read section_versions ({status}): {rows}")
    latest = {}
    for r in rows:
        latest[r["section"]] = r
    status, approvals = request(env, "GET", "/rest/v1/section_approvals?select=*")
    for r in latest.values():
        r["approvals"] = [a["user_id"] for a in approvals if a["section_version_id"] == r["id"]]
    return latest
