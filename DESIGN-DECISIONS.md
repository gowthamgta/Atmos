# Design decisions

What the owner of AtmosIQ has agreed, and what they have tried and turned down. Several AI assistants work on this repository; this file is
how they stay in line. **Do not change anything listed here unless the owner asks for that change in so many words.** When they want a look
changed, ask for a screenshot of what they are aiming at (usually Windy) before touching colours or filters. When a decision changes, update
this file in the same commit.

The looks marked 🔒 are fingerprinted by `src/app/core/ui/agreed-look.spec.ts`: a change to them fails that test on purpose. Update the
fingerprint only together with this file, on the owner's request.

## Satellite

- 🔒 **Visible by day: Meteosat HRV with the Windy exposure ramps** (agreed 17 Oct 2026, commit 5c8edf7). Each pixel is recoloured by
  brightness on a warm ramp (slate, sand, cream) and blended toward lavender-white by how cold its top is (`WARM_STOPS`, `COLD_STOPS`,
  `windyCloudColor` in `core/satellite/satellite-image.ts`), fitted to Windy's picture of the same frame.
- **The satellite panel shows our own pictures** (owner, 22 Oct: "i dont want our own and eumetview, lets show meteosat 9 and himawari"):
  a Meteosat-9 / Himawari-9 switch (Meteosat first: all of India), made by gowthamgta/atmos-satellite from raw data (pipeline/meteosat_rgb.py,
  himawari_rgb.py). Unless the viewer picks a kind, **infrared at night, our natural colour (Meteosat) / true colour (Himawari) by day**.
  **Infrared in Windy's colours** for both: CLOUD_TOP_STOPS applied to the measured temperature through greyScaleTempFromMeasured (the grey-
  level scale read cold tops 10-20 C too cold; measured 22 Oct, r = 0.99). Also HRV, sandwich, convection, night micro, WV difference and a
  custom WMO-formula RGB; the hover readout is measured. EUMETView's pictures are no longer offered as a choice: they remain only behind the
  3D clouds. The agreed look below stays recorded (and fingerprinted) for that path.
- **The day RGB is drawn in its own colours** (owner, 23 Oct: "why cant we apply our raw rgb"): EUMETSAT's HRV Cloud RGB from the raw
  data (pipeline hrv_clouds_rgb: EUMETView's brightness curve, highlights rolled off above 190, sun normalisation capped at 70 degrees),
  only re-spaced to Mercator (toRawMercator), not recoloured by the Windy ramps; not cleared of the ground (owner, 24 Oct: "remove land and sea colors and give raw rgb").
- **3D clouds** (the panel's Flat / 3D clouds switch, off by default, 22 Oct): the live frame raised into lit cloud volumes over a tilted map
  (core/satellite/cloud-field.ts, core/rendering/cloud-volume.layer.ts). Tops from the infrared temperature, thickness from the HRV
  brightness, bases by cloud kind; heights True / x3 / x6 (x3 default). The flat picture and its agreed colours are unchanged.
- **The HD 1.25 km window loads by default** on desktop and phone (b4afa62), and the **newest frame is shown first** (2b73678).
- **Never ask EUMETView for pixels finer than about 1.25 km**: the HRV is built from 1.2 to 1.5 km pixels and a finer request is padded
  into streaks and rectangles.
- 🔒 **Infrared (night, and the Visible/Infrared switch): Windy's cloud-top colours**, greys to -44 °C, then blue, cyan, green, yellow,
  orange, red and dark red (`CLOUD_TOP_STOPS`), calibrated against a Windy screenshot of the same day.
- **Turned down:** the natural-colour fusion (13 Oct); the 19 Oct rework (natural look / RGB composite blended with the map, clouds only
  with the ground see-through, Windy's dark ground under the satellite with rivers and roads hidden, unsharp mask, then denoise) was
  reverted on 20 Oct (79b4fd4); AMD CAS sharpening (no visible gain); water vapour and the Auto/IR/WV buttons; the EUMETSAT cloud mask at
  night.

## Radar (IMD Karaikal and Chennai)

- **The echoes are drawn as IMD's own pictures have them**: no filtering of echoes at all (789e9a3; the spoke remover and the far-range
  filter were removed), intense cores always kept (166aade), intensity the same as the picture.
  **The map printed over the echoes is filled in** (the owner, 23 Oct 2026: Chennai's district lines and names showed in the rain): a pixel
  of boundary, name, ring or grid line inside rain takes the rain around it (`fillOverlayGaps` in `core/services/radar-process.ts`); rain
  edges and scattered clutter stay as the picture has them.
  **Map drawn in the legend's own colours is taken off** (the owner, 24 Oct 2026: district boundaries from the radars of Odisha and
  Andhra Pradesh): a patch of one legend colour that is almost not bordered by rain (under 15%) and is thin or of 4+ pixels, in a colour
  above the legend's weakest third (Visakhapatnam's state lines and coast in red, Sambalpur's continental shelf in cyan, city markers;
  `removeMapDrawings` in `core/services/radar-process.ts`). Light echoes (the weakest third) and lines inside rain are never taken off.
  Visakhapatnam's pictures are read with their own Selex legend.
- **Faint echoes where the beams pass high are drawn see-through, never removed** ("rain aloft": may not reach the ground). Under
  25 dBZ where the lowest beam of every radar that reaches the place is 3.5 km or more up: 45% opacity; full from 30 dBZ or under a 2 km
  beam, with smooth steps between (`aloftOpacity` in `core/services/radar-beam.ts`). The hover says "Rain aloft" there.
- 🔒 **Colours: the Windy-style radar palette with red and orange cores** (08c6184).
- **Where radars overlap, the strongest echo is drawn** (783a81b); an echo from an older scan is drawn fainter (3a793df).
- **PPI is shown as the whole square picture**, not cut to a circle (b7a758b, 4e951d8). **CAZ covers 250 km** for both radars (3ab5fa6).
- **All (the stack) is the default view** (the owner, 24 Oct 2026: "first ppz for coverage, on top of that caz and on top of that ppi ...
  circle inside circle"): each radar's PPI inside its range (a circle here), its CAZ around that out to the CAZ's range and its PPZ
  outside out to the PPZ's (Karaikal: 150, 250 and 500 km), so every product of every radar is on the map at once. Each picture keeps
  its own scan time and goes when it is too old, as always; a missing or old picture leaves its ground to the ring around it. The
  stations' scan times and online state are their CAZ's; the one-hour loop is IMD's CAZ animations. CAZ, PPZ and PPI on their own
  stay as before (`stackRings` in `core/services/radar.service.ts`).
- **The radars are fetched only while the radar is on the map** (or the place card needs the rain nowcast): with 45 radars, fetching
  and composing them every minute slowed the forecast maps down while the radar was not shown (the owner, 24 Oct 2026).
- **Scan times are read from the time printed on the pictures**, not IMD's file time (9d25f79).
- **Each radar can be turned off and on** in the panel, both off allowed; the map does not move when toggling (ef6d868, b6f48f9).
- **Hovering shows the height of each radar's beam** over the place (28e1541).
- Radar positions: Karaikal 10.91294 N 79.84175 E, Chennai 13.0839 N 80.2901 E (as given by the owner).
- **Every IMD radar, read the way Karaikal and Chennai are** (the owner, 23 Oct 2026: "i want data from all the radar stations"): 45
  radars, Karaikal and Chennai first. Pallikaranai, Sriharikota, Kochi, Thiruvananthapuram and Mangaluru as measured before; every other
  one from its own pictures of 23 Oct (`core/domain/models/imd-radar-network.ts`, copies kept by the radar-pictures workflow on the
  imd-radar-samples branch): the map square, the range printed on the picture, the legend's colours with their values. A product whose
  picture could not be measured (the radar down, no range printed) is never fetched. Machilipatnam is left out (shut down, nothing to
  measure). Only Karaikal, Chennai and Kochi download the loop's animations; the others join the loop with their live pictures.
- **Where no working radar reaches, the map is a little grey** (the owner, 23 Oct 2026), so the radars' coverage shows: outside every
  working radar's range for the product on the map (`features/map/radar-reach-overlay.ts`), under the echoes; a radar down, too old or
  turned off leaves its ground grey; with no radar picture on the map at all, all of it is grey.
- **Turned down: the synthetic radar from the satellite** (23 Oct 2026, the owner: "lets remove this synthetic radar changes completely"):
  the estimate drawn outside the radars' range, its learning from the radars and the bot's pairs were all removed.

## Forecast and the rest of the map

- **Wind particles as tuned on 19 Oct** (27c7414): the owner chose to keep them.
- **Rain probability: the ECMWF ensemble** (share of members with rain), models' agreement only as the fallback (5b7da55). Meteologix was
  not used (its charts are not open data).
- **No weather stations, airports or rain gauges in the app** (15128ce): the owner asked for them removed.
- **UK Met Office is not drawn on the map** (owner, 23 Oct: "lets compramise UK MET"): the published site was 1.077 GB, over GitHub Pages' 1 GB, and UKMO's
  folder was about 205 MB; without it the site is about 0.87 GB. The place forecast and the AtmosIQ Blend still read UKMO from Open-Meteo.
- The Clouds layer was left out on purpose (6cddf45).
- **Clouds in 3D** (public/clouds/, linked from Settings > Map): the owner asked for a realistic 3D presentation of the cloud types. It is
  a standalone WebGL 2 page outside the Angular bundle (the service worker leaves /clouds alone). Heights are the WMO Cloud Atlas tropical
  levels; temperatures come from the day's GFS profile over Chennai (Open-Meteo); clouds are ray-marched volumes drawn to scale.
- UI: modelled on Windy (dark) and meteoblue (light); colours only through the tokens in `src/styles.css`; no text under 11 px (a test
  enforces it).
- Personal, non-commercial project; every data source must stay free with no billing account.

## Data that is late or missing

- **A badge on the map says when the live picture is old**: radar scan 30+ min, satellite 90+ min, or no radar picture at all.
- **The last good radar picture is kept in the browser** and shown with its real age when IMD cannot be reached (the 3 h limit stays).
- **A service worker (production only) keeps the app, forecast data (network first), basemap tiles and point forecast** for use offline;
  the app is installable. A new release is put in place the next time the page is out of sight.

## Radar rain and alerts

- **The rain rate in the radar readout uses each radar's Z-R relation fitted to the Tamil Nadu gauges** (verify_radar.py, daily, kept
  only when it beats Marshall-Palmer on held-back days; until then Z = 200 R^1.6). With the loop in, it also gives the last hour's radar rain.
- **The radar nowcast is scored daily** against the pictures that followed, beside a picture that does not move (radar panel).
- **The owner's own rain alerts** go to their Telegram chat only (ALERT_PLACES, TELEGRAM_ALERT_CHAT_ID), at most once a place in 3 h.
- **On phones the radar animations are not downloaded in the background** (about 8 MB): storm motion from the wind until live pictures
  or Play give the radar's own (measured with e2e/perf.mjs).
- **The satellite loop moves the clouds between pictures** (motion from block matching) instead of cross-fading; the pictures' own
  colours are unchanged.

## Pipeline

- **The map's ECMWF IFS rain factor is learned daily from the Tamil Nadu gauges** (learn_bias.py; 0.57 on 22 Oct, replacing the fixed
  0.785), applied only when it lowers the error on held-back days.
- Actions run on Node 24 actions, pinned to ubuntu-24.04.
- **The map's ECMWF IFS rain factor is learned daily from the Tamil Nadu gauges** (learn_bias.py; 0.57 on 22 Oct, replacing the fixed
  0.785), applied only when it lowers the error on held-back days.
- Actions run on Node 24 actions, pinned to ubuntu-24.04.
- **The nwp workflow runs at 05:00, 10:00, 13:30, 17:30, 21:00 and 00:00 IST** (403de3a). Each run builds the newest cycle surely
  published by then.
- **Forecast accuracy is scored daily** (verify workflow, 07:00 IST): ten models and the Blend at 13 South Indian airports, 1 to 3 days
  ahead, and their rain against the TN-SMART gauges (0.5 degree cells). The model list shows the last 14 days a day ahead.
- **Corrections are learned daily** (learn_bias.py): each model's usual temperature and humidity error by airport and hour, kept only where
  it lowers the error on held-back days. They correct the meteogram and the comparison table for every model, and the ECMWF IFS map
  near the airports (the other map models are not corrected).
- **The AtmosIQ Blend**: the corrected models weighted by recent error (rain by the square of the threat score), only in the meteogram's
  comparison and the place card (its next days while its backtest beats every model), not a map layer.
- **DWD ICON is a map model again** (22 Oct): 00Z and 12Z to +120 h on the 0.25 degree grid (the site must stay under Pages' 1 GB).
- Commits go straight to `main`; if a push is rejected, `git pull --rebase origin main` first (the Actions bot commits data to `main`).
