#!/usr/bin/env python3
"""Web Push that keeps the installed app's status notification current.

Sends today's (and, once published, tomorrow's) schedule of every queue to each subscribed device;
the app's service worker turns it into "power is on until 15:00" for the queue selected there.
Run by .github/workflows/status-push.yml. Environment:

    VAPID_PRIVATE_KEY    private half of the key pair whose public half is in web/index.html
    PUSH_SUBSCRIPTIONS   one subscription per line, as the app's "copy subscription" button gives it
    SITE_URL             the sender's contact for the push service: an https origin with no path
                         (default: the repository owner's GitHub Pages origin)

    send_status.py --dry-run    print the message instead of sending it
"""
import json
import os
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from outage_notify import KYIV, fetch, parse_schedule  # noqa: E402

QUEUES = [f"{group}.{half}" for group in range(1, 7) for half in (1, 2)]
# A message the device has not fetched within TTL is dropped, and a newer one under the same topic
# replaces it, so a phone that was asleep wakes up to the latest status only.
TTL = 15 * 60
TOPIC = "status"


def message(html, today):
    days = {}
    for queue in QUEUES:
        for day, cells in parse_schedule(html, queue).items():
            if day >= today:
                days.setdefault(day, {})[queue] = cells
    return json.dumps({"days": days}, separators=(",", ":"))


def warn(text):
    # The ::warning:: prefix puts the line on the run's summary page in GitHub Actions.
    print(f"::warning::{text}")


def send(payload, subscriptions, private_key, site):
    from pywebpush import WebPushException, webpush

    for number, line in enumerate(subscriptions, 1):
        try:
            # pywebpush writes the endpoint's origin into the claims, so each call gets its own dict.
            webpush(json.loads(line), payload, vapid_private_key=private_key, vapid_claims={"sub": site},
                    ttl=TTL, headers={"Topic": TOPIC, "Urgency": "normal"})
            print(f"subscription {number}: sent")
        except WebPushException as e:
            code = getattr(e.response, "status_code", None)
            if code in (404, 410):
                warn(f"subscription {number} has expired: copy a new one from the app into PUSH_SUBSCRIPTIONS")
            else:
                warn(f"subscription {number}: push service answered {code}: {e}")


def main():
    try:
        payload = message(fetch(), datetime.now(KYIV).date().isoformat())
    except (OSError, ValueError) as e:
        # The source being down is not this job's failure; the next run tries again.
        warn(f"schedule not loaded: {e}")
        return
    if "--dry-run" in sys.argv:
        print(payload)
        print(f"{len(payload.encode())} bytes", file=sys.stderr)
        return

    subscriptions = [line for line in os.environ.get("PUSH_SUBSCRIPTIONS", "").splitlines() if line.strip()]
    if not subscriptions:
        warn("PUSH_SUBSCRIPTIONS is empty: nobody to send the status to")
        return
    private_key = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
    if not private_key:
        sys.exit("VAPID_PRIVATE_KEY is not set")
    site = os.environ.get("SITE_URL") or "https://{}.github.io".format(os.environ["GITHUB_REPOSITORY_OWNER"].lower())
    send(payload, subscriptions, private_key, site)


if __name__ == "__main__":
    main()
