# Nowcast bot

Every ten minutes (`.github/workflows/nowcast.yml`) the bot opens the live radar of the app
(`https://atmosradar.netlify.app/#l=radar&…&bot=1`) in a headless browser. In bot mode the app hides its panels and
publishes the storm cells it finds on the live IMD radar (strength, place, motion from the last hour's loop). When a cell
of **45 dBZ or more** is over a district of **Tamil Nadu or Puducherry**, the bot posts the radar picture with a short
alert to the Telegram channel **@tnweatheralerts**, a Discord channel and X (each once its keys are set):

```
⛈️ Severe thunderstorm over Kallakurichi, Puducherry
Peak 55 dBZ · moving NE ~18 km/h
Heavy rain & lightning likely in and near these areas in the next hour.
IMD radar 15:40 IST · automated nowcast, not an official warning
#TamilNaduRains #TNWeather
```

**Where**, in the alert's words: every district a storm covers (sampled over its whole size, so a storm on a border names
both sides); a storm over the sea within 25 km of the coast is *off the Cuddalore coast*; a storm just across a state border
is *near Krishnagiri*; and the districts it reaches in the next 30-60 minutes along its measured motion are named after the
arrow (*→ Chennai within the hour*). A storm still outside the region but heading into it within the hour is alerted too
(*approaching Chennai*). A storm over Bengaluru, say, is not: it is not on the border and not coming in.

It does not repeat itself: after a post it keeps quiet for an hour, unless the storms get clearly stronger (+5 dBZ) or reach
new districts. It never posts about a radar picture older than 40 minutes, or the same picture twice.

| Peak | Headline |
|---|---|
| 45-49 dBZ | 🌧️ Heavy rain / thunderstorms |
| 50-53 dBZ | ⛈️ Strong thunderstorms |
| 54+ dBZ | ⛈️ Severe thunderstorm |

The thresholds, the region, the cooldown and the wording are at the top of `lib.mjs`.

## Turning it on: Telegram (free)

1. **The bot in the channel.** In Telegram, open the channel @tnweatheralerts → *Administrators* → *Add Admin* → search for
   your bot (its username ends in `bot`) → allow **Post Messages**. A bot can only post to a channel it is an admin of.
2. **The token as a secret.** In GitHub: *Settings → Secrets and variables → Actions → New repository secret*, name
   `TELEGRAM_BOT_TOKEN`, value the token @BotFather gave you. Never put the token in the code or a commit: anyone with it
   controls the bot. (If it was ever shared, send `/revoke` to @BotFather for a new one and store that instead.)
3. **Try it.** *Actions → nowcast → Run workflow* with **dry_run off** and **force on**: one post in the channel, even without
   a storm, to check the whole chain. If it fails, the run's log says why in Telegram's words (for example *bot is not a
   member of the channel chat*: step 1 is missing).
4. **Go live.** *Settings → Secrets and variables → Actions → Variables*, add `NOWCAST_LIVE` = `true`.

Another channel: set the variable `TELEGRAM_CHAT_ID` (for example `@otherchannel`, or the numeric id of a private channel).

## Turning it on: Discord (free)

1. **A webhook.** In your server: *Server Settings → Integrations → Webhooks → New Webhook*, choose the channel the alerts
   should go to, name it (for example *TN Weather Alerts*), and *Copy Webhook URL*.
2. **The URL as a secret.** In GitHub, a new repository secret `DISCORD_WEBHOOK_URL` with that URL. Anyone with the URL can
   post in that channel, so it is a secret like a token.
3. **Try it** as for Telegram (*Run workflow*, dry_run off, force on), and **go live** with `NOWCAST_LIVE` = `true` (one
   switch for every outlet).

Each alert is an embed: the headline, the details, the radar picture, the radar's time, a colour bar by strength (amber
heavy rain, orange strong, red severe) and the link to the live radar. Nobody is pinged; to ping a role, say so and the bot
can mention it.

## Turning it on: X

Until keys are set, every run is a **dry run**: the radar picture and the post it would make are kept as the run's
artifact (Actions → nowcast → a run → Artifacts), so you can see what it would say before anything goes out.

1. **X developer account.** At <https://developer.x.com>, sign in as the account that should post and create a Project and an
   App. Since February 2026, X API access for new developers is pay-per-use: about **$0.015 a post** (a post with a link
   costs more, about $0.20, which is why the app's address is left out unless you ask for it). Add some credit.
2. **Permissions.** In the App's *User authentication settings*, set the App permissions to **Read and write**.
3. **Keys.** Under *Keys and tokens*, copy the **API Key and Secret**, then generate an **Access Token and Secret** for
   your account. Generate the access token *after* setting Read and write, or it will be read-only.
4. **Secrets.** In GitHub: *Settings → Secrets and variables → Actions → New repository secret*, add `X_API_KEY`,
   `X_API_SECRET`, `X_ACCESS_TOKEN` and `X_ACCESS_SECRET`.
5. **Try it.** *Actions → nowcast → Run workflow* with **dry_run off** and **force on**. This posts once even without a storm,
   to check the whole chain. Delete that post afterwards if you like.
6. **Go live.** *Settings → Secrets and variables → Actions → Variables*, add `NOWCAST_LIVE` = `true`. The ten-minute runs
   then post when there are storms (to Telegram and X both, each that has its keys). Set it to anything else to pause the bot
   without removing the keys.

Optional: the variable `NOWCAST_INCLUDE_LINK` = `true` adds `atmosradar.netlify.app` to each post (at X's price for posts
with a link).

## Your own rain alerts (Telegram, free)

Besides the channel, the bot can tell you alone when rain is about to reach your places: dry there now, and the radar nowcast has rain
there within 30 or 60 minutes (at most one message a place every three hours). It sends the radar picture with a line like
"Rain likely at Kallakurichi within about 30 minutes (by 04:30 pm IST): heavy rain on the way".

1. Open a chat with your bot in Telegram and send it any message (a bot cannot write to you first).
2. Find your chat id: open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and read `"chat":{"id": ...}`.
3. In the repository: Settings, Secrets and variables, Actions: add the **secret** `TELEGRAM_ALERT_CHAT_ID` (that number), and the
   **variable** `ALERT_PLACES`, for example `Kallakurichi:11.74,78.96;Chennai:13.08,80.27`.

Nothing is sent until both are set (and, as for the channel, `NOWCAST_LIVE` is `true`).

## Radar samples for the daily verification

Each run also keeps the radar over the 0.5 degree cells of the Tamil Nadu rain gauges, and the nowcast 30 and 60 minutes ahead
(bot/samples.mjs), in the Actions cache (saved once an hour, the last four days). The verify workflow reads them to fit each radar's
rain rate to the gauges and to score the nowcast (pipeline/verify_radar.py).

## Satellite against radar, for learning the synthetic radar

Each run also asks the app for the newest Meteosat frame's inputs at every 3 km pixel Chennai or Karaikal see well (20 to 250 km out),
beside what the radar saw there in the picture nearest the frame's time (the live one or a step of the last hour's loop, at most 6 minutes
apart) and what the hand-set rules drew (`src/app/core/satellite/rain-features.ts`, bot/pairs.mjs). Every rainy pixel is kept (up to
2000 a look) and 800 dry ones, each weighed for the pixels it stands for: about 20 to 80 kB gzipped a frame, one file a frame at
`YYYY/MM/DD/HHMM.json.gz` in the **rain-pairs** branch (the workflow commits it there, never to main). The verify workflow learns the
synthetic radar from them (pipeline/learn_rain.py).

## Running it yourself

```
cd bot && npm ci && npx playwright install chromium
node nowcast.mjs                 # dry run: writes out/radar.png, out/post.txt, out/decision.json
FORCE=1 node nowcast.mjs         # the same, as if there were a storm
npm test                         # the decisions and the wording
```

The radar is IMD's (India Meteorological Department), credited in every post. The alerts are an automated reading of
the radar, not official warnings; for those, follow IMD and the Tamil Nadu State Disaster Management Authority.
