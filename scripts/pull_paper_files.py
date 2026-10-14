"""Download PDFs that readers shared in the tracker into ../papers/<paper id>.pdf (local use only),
so the drafting can work from the full text rather than the abstract.

  python3 scripts/pull_paper_files.py              # skip papers that already have a local PDF
  python3 scripts/pull_paper_files.py --overwrite
"""
import argparse
import urllib.error
import urllib.parse
import urllib.request

from supa import ROOT, load_env, request

PAPERS = ROOT.parent / "papers"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--overwrite", action="store_true")
    args = ap.parse_args()
    env = load_env()
    status, files = request(env, "GET", "/rest/v1/paper_files?select=*&order=created_at")
    if status >= 300:
        raise SystemExit(f"could not list shared PDFs ({status}): {files}")
    PAPERS.mkdir(exist_ok=True)
    done = set()
    for f in files:
        target = PAPERS / f"{f['paper_id']}.pdf"
        if f["paper_id"] in done or (target.exists() and not args.overwrite):
            continue
        url = f"{env['SUPABASE_URL']}/storage/v1/object/authenticated/papers/{urllib.parse.quote(f['storage_path'])}"
        req = urllib.request.Request(url, headers={"apikey": env["SUPABASE_SERVICE_KEY"],
                                                   "Authorization": f"Bearer {env['SUPABASE_SERVICE_KEY']}"})
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = resp.read()
        except urllib.error.HTTPError as err:
            print(f"{f['paper_id']}: download failed ({err.code})")
            continue
        if not data.startswith(b"%PDF"):
            print(f"{f['paper_id']}: not a PDF, skipped")
            continue
        target.write_bytes(data)
        done.add(f["paper_id"])
        print(f"{f['paper_id']}: saved {target.name} ({len(data) // 1024} KB)")
    print(f"{len(done)} PDF(s) saved to {PAPERS}")


if __name__ == "__main__":
    main()
