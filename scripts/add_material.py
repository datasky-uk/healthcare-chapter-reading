"""Add the chapter lead's documents to the tracker's "Materials" page (service key).

  python3 scripts/add_material.py FILE --title "Chapter outline" [--description "..."] [--order 1]
  python3 scripts/add_material.py --link URL --title "Shared draft" [--description "..."] [--order 2]
  python3 scripts/add_material.py --list
  python3 scripts/add_material.py --remove ID

Files go to the private "materials" bucket under chapter/. Re-running with the same
file name replaces the file and updates its title, description and order.
"""
import argparse
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from supa import load_env, request

TYPES = {
    "pdf": "application/pdf", "md": "text/markdown", "txt": "text/plain", "csv": "text/csv",
    "bib": "text/plain", "ris": "text/plain", "doc": "application/msword",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "ppt": "application/vnd.ms-powerpoint",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "xls": "application/vnd.ms-excel", "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "odt": "application/vnd.oasis.opendocument.text", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
}


def upload(env, path, data, content_type):
    url = f"{env['SUPABASE_URL']}/storage/v1/object/materials/{urllib.parse.quote(path)}"
    req = urllib.request.Request(url, data=data, method="POST", headers={
        "apikey": env["SUPABASE_SERVICE_KEY"], "Authorization": f"Bearer {env['SUPABASE_SERVICE_KEY']}",
        "Content-Type": content_type, "x-upsert": "true"})
    try:
        with urllib.request.urlopen(req, timeout=300):
            pass
    except urllib.error.HTTPError as err:
        sys.exit(f"upload failed ({err.code}): {err.read().decode(errors='replace')}")


def save_row(env, match, row):
    status, existing = request(env, "GET", f"/rest/v1/materials?select=id&{match}")
    if status >= 300:
        sys.exit(f"could not read materials ({status}): {existing} (has 002_added_papers_and_materials.sql been run?)")
    if existing:
        status, body = request(env, "PATCH", f"/rest/v1/materials?id=eq.{existing[0]['id']}", row)
    else:
        status, body = request(env, "POST", "/rest/v1/materials", row)
    if status >= 300:
        sys.exit(f"could not save ({status}): {body}")
    return "updated" if existing else "added"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", nargs="?", type=Path)
    ap.add_argument("--link")
    ap.add_argument("--title")
    ap.add_argument("--description")
    ap.add_argument("--order", type=int, default=100, help="position on the page (lower comes first)")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--remove", type=int, metavar="ID")
    args = ap.parse_args()
    env = load_env()

    if args.list:
        status, rows = request(env, "GET", "/rest/v1/materials?select=*&order=sort_order.asc.nullslast,created_at")
        for r in rows:
            who = "chapter lead" if r["sort_order"] is not None else "reader"
            print(f"{r['id']:>4}  [{who}, order {r['sort_order']}]  {r['title']}  ->  {r['storage_path'] or r['url']}")
        return
    if args.remove:
        status, rows = request(env, "DELETE", f"/rest/v1/materials?id=eq.{args.remove}", headers={"Prefer": "return=representation"})
        if status >= 300 or not rows:
            sys.exit(f"nothing removed ({status}): {rows}")
        if rows[0]["storage_path"]:
            request(env, "DELETE", "/storage/v1/object/materials", {"prefixes": [rows[0]["storage_path"]]})
        print(f"removed {rows[0]['title']}")
        return

    if not args.title or bool(args.file) == bool(args.link):
        ap.error("give a FILE or --link, and a --title")
    row = {"title": args.title, "description": args.description, "sort_order": args.order, "added_by": None}
    if args.link:
        row["url"] = args.link
        print(save_row(env, f"url=eq.{urllib.parse.quote(args.link, safe='')}&sort_order=not.is.null", row), args.title)
        return
    ext = args.file.suffix.lstrip(".").lower()
    if ext not in TYPES:
        sys.exit(f"{args.file.name}: file type .{ext} is not accepted ({', '.join(sorted(TYPES))})")
    data = args.file.read_bytes()
    path = f"chapter/{args.file.name}"
    upload(env, path, data, TYPES[ext])
    row.update({"storage_path": path, "file_name": args.file.name, "size_bytes": len(data)})
    print(save_row(env, f"storage_path=eq.{urllib.parse.quote(path, safe='')}", row), args.title, f"({len(data) // 1024} KB)")


if __name__ == "__main__":
    main()
