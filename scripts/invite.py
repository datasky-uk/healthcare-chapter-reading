"""Invite collaborators by email (sign-up is disabled, so only invitees can sign in).

Usage: python3 scripts/invite.py person@uni.edu other@inst.org
       python3 scripts/invite.py --file emails.txt     (one address per line)
The invitation email links to SITE_URL from .env (the deployed tracker page).
Readers can also invite people themselves from the Members page; both are listed there.
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
    for email in (a.strip().lower() for a in args):
        for attempt in range(3):  # retry transient server errors
            status, body = request(env, "POST", path, {"email": email})
            if status < 500:
                break
            time.sleep(2 * (attempt + 1))
        if status < 300:
            print(f"invited {email}")
            # List it on the Members page (invited_by null = the chapter lead)
            saved, err = request(env, "POST", "/rest/v1/invites", {"email": email, "user_id": body.get("id")},
                                 {"Prefer": "resolution=merge-duplicates"})
            if saved >= 300:
                print(f"  (not listed on the Members page: {saved} {err}; has 004_members_and_invites.sql been run?)")
        elif status == 422:
            print(f"{email}: already has an account; they can sign in with their email on the page")
        else:
            print(f"{email}: failed ({status}) {body}")


if __name__ == "__main__":
    main()
