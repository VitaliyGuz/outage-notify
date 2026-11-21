-- The devices on the list: when each joined and was last seen, and what is known of it.
-- npx wrangler d1 execute outage-notify --remote --file devices.sql
SELECT created_at, seen_at, queue, lang, city, region, country, isp, COALESCE(device, user_agent) AS device
FROM subscriptions
ORDER BY created_at;
