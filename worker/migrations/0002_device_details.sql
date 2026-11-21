-- What is known about a device besides its address, filled in by details() in src/index.js.
ALTER TABLE subscriptions ADD COLUMN seen_at TEXT;
ALTER TABLE subscriptions ADD COLUMN queue TEXT;
ALTER TABLE subscriptions ADD COLUMN lang TEXT;
ALTER TABLE subscriptions ADD COLUMN device TEXT;
ALTER TABLE subscriptions ADD COLUMN user_agent TEXT;
ALTER TABLE subscriptions ADD COLUMN country TEXT;
ALTER TABLE subscriptions ADD COLUMN region TEXT;
ALTER TABLE subscriptions ADD COLUMN city TEXT;
ALTER TABLE subscriptions ADD COLUMN isp TEXT;
