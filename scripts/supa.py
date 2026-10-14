"""Shared helpers: read .env and call the Supabase REST and Auth admin APIs."""
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = ("SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_KEY")
OPTIONAL = ("SITE_URL", "CONTACT_NAME")


def load_env():
    env_file = ROOT / ".env"
    values = {}
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                values[key.strip()] = value.strip().strip('"').strip("'")
    values.update({k: os.environ[k] for k in REQUIRED + OPTIONAL if k in os.environ})
    missing = [k for k in REQUIRED if not values.get(k)]
    if missing:
        sys.exit(f"Missing {', '.join(missing)}: copy .env.example to .env and fill it in.")
    values["SUPABASE_URL"] = values["SUPABASE_URL"].rstrip("/")
    return values


def request(env, method, path, body=None, headers=None, key="SUPABASE_SERVICE_KEY"):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(env["SUPABASE_URL"] + path, data=data, method=method, headers={
        "apikey": env[key],
        "Authorization": f"Bearer {env[key]}",
        "Content-Type": "application/json",
        **(headers or {}),
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
            return resp.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as err:
        raw = err.read()
        try:
            return err.code, json.loads(raw)
        except ValueError:
            return err.code, raw.decode(errors="replace")
