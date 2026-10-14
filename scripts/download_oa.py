"""Download open-access PDFs listed in data/references.json.

Saves to ../../papers/<id>.pdf (next to the chapter files, outside the
tracker repo, so PDFs are never committed or deployed). Only follows the
open-access links found by oa_lookup.py; never tries to get round a paywall.
Writes data/download_log.json with the outcome for every paper.
"""
import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REFS = ROOT / "data" / "references.json"
LOG = ROOT / "data" / "download_log.json"
PAPERS = ROOT.parent / "papers"
UA = "healthcare-chapter-reading-tracker/1.0 (downloading open-access literature for a review)"


PMC_BUCKET = "https://pmc-oa-opendata.s3.amazonaws.com"


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/pdf,*/*"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def pmc_dataset_pdf(pmcid):
    """URL of the latest article PDF in NIH's PMC open-access dataset on AWS, if present.
    Europe PMC's and PMC's own PDF links refuse automated requests; this dataset is
    the route NCBI provides for machine access."""
    listing = fetch(f"{PMC_BUCKET}/?list-type=2&prefix={pmcid}.&max-keys=200").decode()
    pdfs = re.findall(rf"<Key>({pmcid}\.(\d+)/{pmcid}\.\2\.pdf)</Key>", listing)
    if not pdfs:
        return None
    key = max(pdfs, key=lambda m: int(m[1]))[0]
    return f"{PMC_BUCKET}/{key}"


def write_index(papers, log):
    """papers/INDEX.md: what each file is, plus links for papers without a local copy."""
    tag_label = {"essential": "essential read", "should": "should read", "mildly": "mildly interesting",
                 "reference": "reference"}
    lines = ["# Full texts", "",
             "Open-access copies for personal use. Paywalled papers are not included: use library access.", "",
             "| Rank | Tag | Paper | Local copy or link |", "|---|---|---|---|"]
    for p in sorted(papers, key=lambda p: (p["rank"] or 999, p["section"], p["id"])):
        title = (p.get("registered_title") or p["title"] or "").replace("|", "/")
        if log.get(p["id"], "").startswith("ok"):
            where = f"[{p['id']}.pdf]({p['id']}.pdf)"
        elif p.get("is_oa") and p.get("oa_url"):
            where = f"free online: {p['oa_url']}"
        else:
            where = "paywalled" + (f": https://doi.org/{p['doi']}" if p.get("doi") else "")
        lines.append(f"| {p['rank'] or ''} | {tag_label[p['tag']]} | {p['short_cite'] or p['first_author']} — {title} | {where} |")
    (PAPERS / "INDEX.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main():
    papers = json.loads(REFS.read_text(encoding="utf-8"))
    PAPERS.mkdir(exist_ok=True)
    log = {}
    for p in papers:
        target = PAPERS / f"{p['id']}.pdf"
        if not p.get("pdf_url"):
            log[p["id"]] = "no open-access PDF" if not p.get("is_oa") else "open access, no direct PDF link"
            continue
        if target.exists() and target.read_bytes()[:4] == b"%PDF":
            log[p["id"]] = "ok (already downloaded)"
            continue
        urls = list(dict.fromkeys([p["pdf_url"]] + (p.get("pdf_candidates") or [])))
        if p.get("pmcid"):
            try:
                urls.insert(0, pmc_dataset_pdf(p["pmcid"]))
            except Exception:
                pass
        outcome = "failed: no candidate URL"
        for url in filter(None, urls):
            try:
                data = fetch(url)
                if data[:4] == b"%PDF":
                    target.write_bytes(data)
                    outcome = "ok"
                    break
                outcome = "failed: response was not a PDF (publisher page or bot check)"
            except urllib.error.HTTPError as err:
                outcome = f"failed: HTTP {err.code}"
            except Exception as err:  # network errors, timeouts
                outcome = f"failed: {type(err).__name__}"
            finally:
                time.sleep(1)
        log[p["id"]] = outcome

    LOG.write_text(json.dumps(log, indent=1) + "\n")
    write_index(papers, log)
    ok = sum(v.startswith("ok") for v in log.values())
    failed = {k: v for k, v in log.items() if v.startswith("failed")}
    print(f"downloaded {ok} PDFs to {PAPERS}; {len(failed)} failed; "
          f"{sum(v == 'no open-access PDF' for v in log.values())} paywalled")
    for k, v in failed.items():
        print(" ", k, "-", v)


if __name__ == "__main__":
    main()
