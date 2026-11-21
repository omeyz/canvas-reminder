# canvas-reminder

Cloudflare Worker (no public URL) that reads Canvas calendar feeds every
15 minutes and posts to a Discord webhook:

- **8 AM and 6 PM Pacific digests** of everything due in the next 7 days
- Escalating pings at **3d, 2d, 24h, 12h, 6h, 3h, 2h, 1h, 30m, 15m** before each due time, with an @mention when `DISCORD_USER_ID` is set
- **New assignment posted** / **due date moved** alerts
- An alert if a feed has been unreadable for 2h. Until it recovers, reminders keep running from the last good copy.

Canvas exports 11:59 PM due dates as all-day events; those are read as 11:59 PM Pacific.
The feed can't see whether you've submitted something, so reminders fire either way.

## Secrets

| name | what |
|---|---|
| `DISCORD_WEBHOOK` | webhook URL |
| `DISCORD_USER_ID` | optional, your user ID so reminders ping you |
| `FEED_<NAME>` | one per school: Canvas → Calendar → Calendar Feed URL (`FEED_CSUCI`, `FEED_VCCCD`) |

Add another school with `npx wrangler@4 secret put FEED_<NAME>`. Its existing assignments are
seeded silently on the first sync, so it won't flood "new assignment" messages.

## Setup

1. Create a KV namespace: `npx wrangler@4 kv namespace create STATE`, then put its id in
   `wrangler.jsonc` in place of `<your-kv-namespace-id>`.
2. Set the secrets above with `npx wrangler@4 secret put <NAME>`.
3. `npx wrangler@4 deploy`.

## Ops

```sh
npx wrangler@4 deploy
npx wrangler@4 tail                     # watch the next cron tick
npx wrangler@4 kv key get state --binding STATE --remote   # dedup state
node test/sim.mjs CSUCI=a.ics VCCCD=b.ics --days 8         # replay saved feeds on a fake clock
```
