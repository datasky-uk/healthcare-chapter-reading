"""Write web/config.js from .env. Only the project URL and the public anon key
go into the page; the service key never leaves .env."""
import json

from supa import ROOT, load_env


def main():
    env = load_env()
    config = {"supabaseUrl": env["SUPABASE_URL"], "supabaseAnonKey": env["SUPABASE_ANON_KEY"],
              "contact": env.get("CONTACT_NAME", "the chapter lead")}
    (ROOT / "web" / "config.js").write_text(f"window.TRACKER_CONFIG = {json.dumps(config, indent=2)};\n")
    print("wrote web/config.js")


if __name__ == "__main__":
    main()
