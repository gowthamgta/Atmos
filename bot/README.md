# Radar sampler

Each run (`.github/workflows/nowcast.yml`, started by cron-job.org) opens the live radar of the app
(`https://kralveth-weather.pages.dev/#l=radar&…&bot=1`) in a headless browser, waits for the radar and its last-hour loop, and
keeps the radar over the Tamil Nadu and Puducherry gauge cells (0.5 degree, 8-14 N, 76-80.5 E): the live picture and the
nowcast's 30 and 60 minute guesses (`samples.mjs`). The store (four days) is kept between runs in the workflow's cache.

The daily verification (`.github/workflows/verify.yml`, `pipeline/verify_radar.py`) uses it to set each radar's rain rate
from the rain gauges and to score the nowcast.

It posts nothing. The nowcast bot that posted storms to Telegram, Discord and X from here was removed (the owner, 1 Nov 2026).
Its repository secrets (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALERT_CHAT_ID`, `DISCORD_WEBHOOK_URL`, `X_API_KEY`, `X_API_SECRET`,
`X_ACCESS_TOKEN`, `X_ACCESS_SECRET`) and variables (`NOWCAST_LIVE`, `NOWCAST_INCLUDE_LINK`, `ALERT_PLACES`, `TELEGRAM_CHAT_ID`)
are no longer read and can be deleted in the repository's settings.

```
cd bot && npm ci && npx playwright install chromium
node sample.mjs          # SITE_URL=http://localhost:8080 for a local build
npm test
```
