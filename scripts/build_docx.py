"""Build the final chapter as a Word file with real OSCOLA footnotes.

Takes the latest version of every section from the tracker, the abstract and the title,
turns citation keys into numbered Word footnotes (full OSCOLA form first, then short forms
and ibid), checks the word count against the publisher's limit (footnotes included) and
renders a PDF with LibreOffice so the layout can be checked.

  python3 scripts/build_docx.py                       # -> ../chapter/AI_in_Healthcare_chapter.docx
  python3 scripts/build_docx.py --reference template.docx   # use the publisher's Word template
  python3 scripts/build_docx.py --allow-unapproved    # build even if sections 2-8 lack two approvals
  python3 scripts/build_docx.py --upload              # also put it on the Materials page
"""
import argparse
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from chapter_lib import SECTIONS, TITLE, WORD_LIMIT, build_footnotes, count_words, latest_versions, load_forms, to_pandoc
from supa import ROOT, load_env, request

OUT_DIR = ROOT.parent / "chapter"
OUT = OUT_DIR / "AI_in_Healthcare_chapter.docx"
FONT = "Times New Roman"


def reference_docx(path):
    """pandoc's default styles, set to Times New Roman 12 pt, 1.5 line spacing, black headings, 10 pt footnotes."""
    default = subprocess.run(["pandoc", "--print-default-data-file", "reference.docx"], capture_output=True, check=True).stdout
    tmp = Path(tempfile.mkdtemp()) / "ref.docx"
    tmp.write_bytes(default)
    with zipfile.ZipFile(tmp) as z:
        files = {n: z.read(n) for n in z.namelist()}
    styles = files["word/styles.xml"].decode()
    fonts = f'<w:rFonts w:ascii="{FONT}" w:hAnsi="{FONT}" w:eastAsia="{FONT}" w:cs="{FONT}" />'
    styles = re.sub(r"<w:rFonts [^>]*/>", fonts, styles)
    styles = re.sub(r"<w:color [^>]*/>", "", styles)
    styles = styles.replace('<w:spacing w:before="180" w:after="180" />',
                            '<w:spacing w:before="0" w:after="160" w:line="360" w:lineRule="auto" />')
    styles = re.sub(r'(<w:style w:type="paragraph" w:styleId="FootnoteText">.*?)(</w:style>)',
                    r'\1<w:pPr><w:spacing w:after="60" /></w:pPr><w:rPr><w:sz w:val="20" /><w:szCs w:val="20" /></w:rPr>\2',
                    styles, count=1, flags=re.S)
    files["word/styles.xml"] = styles.encode()
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(name, data)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--reference", type=Path, help="Word file whose styles to use (e.g. the publisher's template)")
    ap.add_argument("--allow-unapproved", action="store_true")
    ap.add_argument("--allow-over", action="store_true", help="build even if over the word limit")
    ap.add_argument("--upload", action="store_true")
    args = ap.parse_args()
    env = load_env()
    forms = load_forms(env)
    latest = latest_versions(env)
    state = request(env, "GET", "/rest/v1/chapter_state?select=*")[1][0]

    missing = [s for s in SECTIONS if s not in latest]
    unapproved = [s for s in range(2, 9) if s in latest and len(latest[s]["approvals"]) < 2]
    if missing:
        print("WARNING: no text yet for §" + ", §".join(map(str, missing)))
    if unapproved and not args.allow_unapproved:
        sys.exit("Sections without two approvals of their latest version: §" + ", §".join(map(str, unapproved))
                 + " (use --allow-unapproved for a preview build)")

    ordered = [(s, latest[s]["body"]) for s in sorted(latest)]
    notes, unknown = build_footnotes(ordered, forms)
    if unknown:
        sys.exit("Unknown citation keys: " + ", ".join(sorted(set(unknown))))

    abstract = (state.get("abstract") or "").strip()
    parts = [f"# Abstract {{.unnumbered}}", "", abstract, ""]
    definitions = []
    text_words = count_words(abstract)
    note_words = 0
    for s, body in ordered:
        text, defs = to_pandoc(body.strip(), notes[s])
        heading = f"{s}. {SECTIONS[s][0]}"
        parts += [f"# {heading} {{.unnumbered}}", "", text, ""]
        definitions += defs
        text_words += count_words(heading) + count_words(body)
        note_words += sum(count_words(n[3]) for n in notes[s])
    total = text_words + note_words
    markdown = "\n".join(parts + [""] + definitions) + "\n"

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "chapter_build.md").write_text(markdown, encoding="utf-8")
    ref = args.reference
    if not ref:
        ref = OUT_DIR / "reference.docx"
        reference_docx(ref)
    title = state.get("title") or TITLE
    subprocess.run(["pandoc", "-f", "markdown", "-o", str(args.out), "--reference-doc", str(ref),
                    "--metadata", f"title={title}"], input=markdown.encode(), check=True)

    footnotes = sum(len(n) for n in notes.values())
    print(f"wrote {args.out}")
    print(f"words: {text_words} text (abstract and headings included) + {note_words} in {footnotes} footnotes "
          f"= {total} (limit {WORD_LIMIT[0]:,}–{WORD_LIMIT[1]:,})")
    if shutil.which("soffice"):
        subprocess.run(["soffice", "--headless", "--convert-to", "pdf", "--outdir", str(args.out.parent), str(args.out)],
                       capture_output=True, timeout=180)
        print("layout check:", args.out.with_suffix(".pdf"))
    if total > WORD_LIMIT[1] and not args.allow_over:
        sys.exit(f"OVER THE LIMIT by {total - WORD_LIMIT[1]} words")
    if total < WORD_LIMIT[0]:
        print(f"Note: {WORD_LIMIT[0] - total} words under the minimum")
    if args.upload:
        subprocess.run([sys.executable, str(ROOT / "scripts" / "add_material.py"), str(args.out),
                        "--title", "The chapter (Word)", "--order", "0",
                        "--description", f"Assembled from the approved sections with OSCOLA footnotes: {total} words including footnotes."],
                       check=True)


if __name__ == "__main__":
    main()
