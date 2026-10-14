"""Invite collaborators by email (sign-up is disabled, so only invitees can sign in).

Usage: python3 scripts/invite.py person@uni.edu other@inst.org
       python3 scripts/invite.py --file emails.txt     (one address per line)
The invitation email links to SITE_URL from .env (the deployed tracker page).
"""
import sys
import time
import urllib.parse

from supa import load_env, request


def main():
    args = sys.argv[1:]
    if args[:1] == ["--file"]:
        args = [l.strip() for l in open(args[1]) if l.strip() and not l.startswith("#")]
    if not args:
        sys.exit(__doc__)
    env = load_env()
    site = env.get("SITE_URL")
    if not site:
        sys.exit("Set SITE_URL in .env to the deployed tracker URL first.")
    path = "/auth/v1/invite?redirect_to=" + urllib.parse.quote(site, safe="")
    for email in args:
        for attempt in range(3):  # retry transient server errors
            status, body = request(env, "POST", path, {"email": email})
            if status < 500:
                break
            time.sleep(2 * (attempt + 1))
        if status < 300:
            print(f"invited {email}")
        elif status == 422:
            print(f"{email}: already has an account; they can sign in with their email on the page")
        else:
            print(f"{email}: failed ({status}) {body}")


if __name__ == "__main__":
    main()
