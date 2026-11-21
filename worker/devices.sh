#!/bin/sh
# The devices on the list: when each joined and was last seen, and what is known of it.
# (The query is given as a command: for a remote database wrangler prints no rows of a --file.)
cd "$(dirname "$0")" && npx wrangler d1 execute outage-notify --remote --command "
  SELECT created_at, seen_at, queue, lang, city, region, country, isp, COALESCE(device, user_agent) AS device
  FROM subscriptions
  ORDER BY created_at"
