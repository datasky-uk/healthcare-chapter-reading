"""Find legal open-access copies for every paper in data/references.json.

Sources: OpenAlex (by DOI), Europe PMC (PubMed Central fallback), and direct
links for arXiv and open conference proceedings. No email or API key is sent.
Also compares each DOI's registered title with ours to catch wrong DOIs.
Responses are cached in data/oa_cache.json so re-runs are fast.
"""
import difflib
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REFS = ROOT / "data" / "references.json"
CACHE = ROOT / "data" / "oa_cache.json"
UA = "healthcare-chapter-reading-tracker/1.0 (literature review tooling)"

# Items cited without a URL in the bibliography (all checked to resolve, Oct 2026)
FDA = "https://www.fda.gov/regulatory-information/search-fda-guidance-documents/"
URL_OVERRIDES = {
    "PMLR 235:29575": "https://proceedings.mlr.press/v235/liang24b.html",
    "FDA-2024-D-4689": FDA + "considerations-use-artificial-intelligence-support-regulatory-decision-making-drug-and-biological",
    "Predetermined Change Control Plan": FDA + "marketing-submission-recommendations-predetermined-change-control-plan-artificial-intelligence",
    "Lifecycle Management and Marketing Submission": FDA + "artificial-intelligence-enabled-device-software-functions-lifecycle-management-and-marketing",
    "Clinical Decision Support Software": FDA + "clinical-decision-support-software",
    "978-92-4-008475-9": "https://www.who.int/publications/i/item/9789240084759",
    "MDCG 2025-6": "https://health.ec.europa.eu/medical-devices-sector/new-regulations/guidance-mdcg-endorsed-documents-and-other-guidance_en",
}
# Open versions of papers whose bibliography entry has no arXiv id
PDF_OVERRIDES = {
    "polzak2026iclr": "https://arxiv.org/pdf/2505.22787",
}


def normalise_pmcid(value):
    digits = "".join(ch for ch in (value or "").rstrip("/").rsplit("/", 1)[-1] if ch.isdigit())
    return f"PMC{digits}" if digits else None


def get_json(url, cache):
    if url in cache:
        return cache[url]
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as err:
        data = {"_error": err.code}
    except (urllib.error.URLError, TimeoutError) as err:
        print("  network error:", url, err)
        return {"_error": "network"}
    cache[url] = data
    time.sleep(0.2)
    return data


def europe_pmc(doi, cache):
    q = urllib.parse.quote(f'DOI:"{doi}"')
    data = get_json(f"https://www.ebi.ac.uk/europepmc/webservices/rest/search?query={q}&format=json&resultType=lite", cache)
    for hit in data.get("resultList", {}).get("result", []):
        if hit.get("pmcid") and "Y" in (hit.get("isOpenAccess"), hit.get("inEPMC"), hit.get("hasPDF")):
            return hit["pmcid"]
    return None


def pmc_pdf(pmcid):
    return f"https://europepmc.org/backend/ptpmcrender.fcgi?accid={pmcid}&blobtype=pdf"


def pmlr_pdf(url):
    # https://proceedings.mlr.press/v267/starace25a.html -> .../v267/starace25a/starace25a.pdf
    base, name = url.rsplit("/", 1)
    stem = name.removesuffix(".html")
    return f"{base}/{stem}/{stem}.pdf"


def from_openalex(paper, cache):
    work = get_json("https://api.openalex.org/works/doi:" + urllib.parse.quote(paper["doi"], safe="/"), cache)
    if "_error" in work:
        return {"oa_status": "unknown", "lookup_error": f"OpenAlex {work['_error']}"}
    oa = work.get("open_access") or {}
    best = work.get("best_oa_location") or {}
    pmcid = normalise_pmcid((work.get("ids") or {}).get("pmcid"))
    if not pmcid and "/pmc/articles/" in (oa.get("oa_url") or ""):
        pmcid = normalise_pmcid(oa["oa_url"])
    if not pmcid:
        pmcid = europe_pmc(paper["doi"], cache)

    pdf = None
    if pmcid:
        pdf = pmc_pdf(pmcid)
    else:
        for loc in [best] + (work.get("locations") or []):
            if loc and loc.get("pdf_url"):
                pdf = loc["pdf_url"]
                break
    if not pdf and (oa.get("oa_url") or "").endswith("/pdf"):
        pdf = oa["oa_url"]
    # Every free PDF copy OpenAlex knows of; repositories first, as publishers often block scripts
    locations = sorted((loc for loc in work.get("locations") or [] if loc.get("pdf_url")),
                       key=lambda loc: (loc.get("source") or {}).get("type") != "repository")
    candidates = list(dict.fromkeys([pdf] + [loc["pdf_url"] for loc in locations] if pdf else
                                    [loc["pdf_url"] for loc in locations]))
    if paper["doi"].startswith("10.1101/") and not pdf:
        pdf = f"https://doi.org/{paper['doi']}"  # bioRxiv/medRxiv landing; full text is free

    status = oa.get("oa_status") or "unknown"
    if paper["doi"].startswith("10.1101/"):
        status = "preprint"
    is_oa = bool(oa.get("is_oa")) or bool(pmcid) or status == "preprint"
    their_title = work.get("title") or work.get("display_name") or ""
    match = difflib.SequenceMatcher(None, paper["title"].lower(), their_title.lower()).ratio() if paper["title"] else None
    return {
        "is_oa": is_oa,
        "oa_status": status if is_oa or status != "unknown" else "closed",
        "oa_url": oa.get("oa_url") or best.get("landing_page_url") or (pmcid and f"https://europepmc.org/article/PMC/{pmcid}"),
        "pdf_url": pdf if is_oa else None,
        "pdf_candidates": candidates if is_oa else [],
        "license": best.get("license"),
        "pmcid": pmcid,
        "openalex_id": work.get("id"),
        "registered_title": their_title,
        "title_match": round(match, 2) if match is not None else None,
    }


def lookup(paper, cache):
    url = paper["url"]
    for key, override in URL_OVERRIDES.items():
        if key in paper["citation"]:
            url = override
    if paper["doi"]:
        return from_openalex(paper, cache)
    if paper["arxiv"]:
        return {"is_oa": True, "oa_status": "preprint", "oa_url": f"https://arxiv.org/abs/{paper['arxiv']}",
                "pdf_url": f"https://arxiv.org/pdf/{paper['arxiv']}", "license": None}
    if url and "proceedings.mlr.press" in url:
        return {"is_oa": True, "oa_status": "proceedings", "oa_url": url, "pdf_url": pmlr_pdf(url), "license": None}
    if url and ("mlanthology.org" in url or "aclanthology.org" in url):
        pdf = next((v for k, v in PDF_OVERRIDES.items() if k in paper["citation"]), None)
        return {"is_oa": True, "oa_status": "proceedings", "oa_url": url, "pdf_url": pdf, "license": None}
    if url:
        return {"is_oa": True, "oa_status": "web", "oa_url": url, "pdf_url": None, "license": None}
    return {"is_oa": False, "oa_status": "unknown", "oa_url": None, "pdf_url": None, "license": None}


def main():
    papers = json.loads(REFS.read_text(encoding="utf-8"))
    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    for i, paper in enumerate(papers, 1):
        paper.update({"is_oa": False, "oa_status": None, "oa_url": None, "pdf_url": None, "pdf_candidates": [], "license": None,
                      "pmcid": None, "openalex_id": None, "registered_title": None, "title_match": None,
                      "lookup_error": None})
        paper.update(lookup(paper, cache))
        if i % 25 == 0:
            print(f"  {i}/{len(papers)}")
            CACHE.write_text(json.dumps(cache))
    CACHE.write_text(json.dumps(cache))
    REFS.write_text(json.dumps(papers, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")

    counts = {}
    for p in papers:
        counts[p["oa_status"]] = counts.get(p["oa_status"], 0) + 1
    print("open-access status:", dict(sorted(counts.items(), key=lambda kv: -kv[1])))
    print(f"open access: {sum(p['is_oa'] for p in papers)} / {len(papers)}"
          f" | with a PDF link: {sum(bool(p['pdf_url']) for p in papers)}")
    for tag in ("essential", "should", "mildly"):
        group = [p for p in papers if p["tag"] == tag]
        print(f"  {tag}: {sum(p['is_oa'] for p in group)}/{len(group)} open access")
    errors = [p for p in papers if p.get("lookup_error")]
    if errors:
        print("lookup errors:", [(p["id"], p["lookup_error"]) for p in errors])
    mismatches = [p for p in papers if p["title_match"] is not None and p["title_match"] < 0.6]
    if mismatches:
        print("possible DOI/title mismatches:")
        for p in mismatches:
            print(f"  {p['id']} ({p['title_match']}): ours={p['title'][:70]!r} registered={p['registered_title'][:70]!r}")


if __name__ == "__main__":
    main()
