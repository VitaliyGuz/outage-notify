#!/usr/bin/env python3
"""Web Push that keeps the installed app's status notification current.

The push is an empty nudge: the schedule's source does not answer GitHub's servers, so the app's
service worker loads the schedule on the phone and shows the status itself.
Run by .github/workflows/status-push.yml. Environment:

    VAPID_PRIVATE_KEY    private half of the key pair whose public half is in web/index.html
    PUSH_SUBSCRIPTIONS   one subscription per line, as the app's "copy subscription" button gives it
    SITE_URL             the sender's contact for the push service: an https origin with no path
                         (default: the repository owner's GitHub Pages origin)
"""
import json
import os
import sys

from pywebpush import WebPushException, webpush

# A nudge the device has not fetched within TTL is dropped, and a newer one under the same topic
# replaces it, so a phone that was asleep wakes up to a single nudge.
TTL = 15 * 60
TOPIC = "status"


def warn(text):
    # The ::warning:: prefix puts the line on the run's summary page in GitHub Actions.
    print(f"::warning::{text}")


def main():
    subscriptions = [line for line in os.environ.get("PUSH_SUBSCRIPTIONS", "").splitlines() if line.strip()]
    if not subscriptions:
        warn("PUSH_SUBSCRIPTIONS is empty: nobody to send the status to")
        return
    private_key = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
    if not private_key:
        sys.exit("VAPID_PRIVATE_KEY is not set")
    site = os.environ.get("SITE_URL") or "https://{}.github.io".format(os.environ["GITHUB_REPOSITORY_OWNER"].lower())

    for number, line in enumerate(subscriptions, 1):
        try:
            # pywebpush writes the endpoint's origin into the claims, so each call gets its own dict.
            webpush(json.loads(line), vapid_private_key=private_key, vapid_claims={"sub": site},
                    ttl=TTL, headers={"Topic": TOPIC, "Urgency": "normal"})
            print(f"subscription {number}: sent")
        except WebPushException as e:
            code = getattr(e.response, "status_code", None)
            if code in (404, 410):
                warn(f"subscription {number} has expired: copy a new one from the app into PUSH_SUBSCRIPTIONS")
            else:
                warn(f"subscription {number}: push service answered {code}: {e}")


if __name__ == "__main__":
    main()
