# Design decisions

What the owner of Kralveth Weather has agreed, and what they have tried and turned down. Several AI assistants work on this repository; this file is
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
  custom WMO-formula RGB; the hover readout is measured. EUMETView's pictures are gone (3 Nov 2026, with the 3D clouds that were their last
  use); the agreed Windy look below stays recorded and fingerprinted (satellite-image.ts still clears the ground with it for the loop's motion).
- **The day RGB is drawn in its own colours** (owner, 23 Oct: "why cant we apply our raw rgb"): EUMETSAT's HRV Cloud RGB from the raw
  data (pipeline hrv_clouds_rgb: EUMETView's brightness curve, highlights rolled off above 190, sun normalisation capped at 70 degrees),
  only re-spaced to Mercator (toRawMercator), not recoloured by the Windy ramps; not cleared of the ground (owner, 24 Oct: "remove land and sea colors and give raw rgb").
- **Removed: the 3D clouds, the merged Meteosat-9 + Himawari-9 picture and EUMETView's HD window** (the owner, 3 Nov 2026: "remove the
  code for 3d clouds and merged clouds, no need these two"): the 3D view (cloud-field.ts, cloud-volume.layer.ts), the measured-temperature
  frames it read, EUMETView's pictures and their closer HD window (satellite-detail.service.ts, satellite-window.ts), the merge step and
  Windy's ground under it are gone; the panel offers Meteosat-9 and Himawari-9. The **newest frame is shown first** (2b73678).
- **Removed: the HD satellite layer** (NASA GIBS, 250 m true colour once a day; the owner, 3 Nov 2026: "Completely remove ... HD satellite").
  The live satellite (our Meteosat-9 and Himawari-9 pictures) stays.
- **The loop is the last 4 hours, loaded newest first** (the owner, 1 Nov 2026): on opening, the newest picture, then the two before it
  (the slider can be dragged over those three); the rest of the 4 hours only once Play is pressed, in the background from newest to
  oldest, each batch joining the loop as it is built (`FIRST_FRAMES`, `loopFrames` in `core/satellite/satellite.service.ts`).
- 🔒 **Infrared (night, and the Visible/Infrared switch): Windy's cloud-top colours**, greys to -44 °C, then blue, cyan, green, yellow,
  orange, red and dark red (`CLOUD_TOP_STOPS`), calibrated against a Windy screenshot of the same day.
- **Turned down:** the natural-colour fusion (13 Oct); the 19 Oct rework (natural look / RGB composite blended with the map, clouds only
  with the ground see-through, Windy's dark ground under the satellite with rivers and roads hidden, unsharp mask, then denoise) was
  reverted on 20 Oct (79b4fd4); AMD CAS sharpening (no visible gain); water vapour and the Auto/IR/WV buttons; the EUMETSAT cloud mask at
  night.

## Radar (IMD Karaikal and Chennai)

- **Only Karaikal and Chennai** (the owner, 3 Nov 2026: "remove radar related code for other stations except chennai and karaikal"): the
  other IMD radars (the measured network of imd-radar-network.ts, Kochi, Thiruvananthapuram, Mangaluru and their legends) are gone from
  the app, the radar workflow and the coverage map (baked again for the two). Entries below that name other radars record how the
  generic filters were found.
- **Radar switch: Both / Karaikal / Chennai** (the owner, 4 Nov 2026: "keep switch for radars for either turning karaikal or chennai alone"): a three-way switch in the radar panel. Both shows the workflow's merged picture; one radar alone is built in the app from that radar's IMD pictures. The choice is remembered. This brings back a station choice after the 25 Oct removal below, on the owner's request.

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
- **Where radars overlap, the strongest echo is drawn** (783a81b), in full whatever its scan's age (the fading of older scans, 3a793df,
  removed on 2 Nov 2026: "remove the merge opacity from radar").
- **A station's PPI, CAZ and PPZ are blended where they meet** (the owner, 2 Nov 2026: "merge the caz, ppz or ppi boundaries"): over
  the last 25 km of the inner product's range the two are mixed with weights adding up to one (`RING_BLEND_KM`, radar-mosaic.ts).
- **PPI is shown as the whole square picture**, not cut to a circle (b7a758b, 4e951d8). **CAZ covers 250 km** for both radars (3ab5fa6).
- **All (the stack) is the default view** (the owner, 24 Oct 2026: "first ppz for coverage, on top of that caz and on top of that ppi ...
  circle inside circle"): each radar's PPI inside its range (a circle here), its CAZ around that out to the CAZ's range and its PPZ
  outside out to the PPZ's (Karaikal: 150, 250 and 500 km), so every product of every radar is on the map at once. Each picture keeps
  its own scan time and goes when it is too old, as always; a missing or old picture leaves its ground to the ring around it. The
  stations' scan times and online state are their CAZ's; the one-hour loop is IMD's CAZ animations. CAZ, PPZ and PPI on their own
  stay as before (`stackRings` in `core/services/radar.service.ts`).
- **The stack's order, exactly** (the owner, 1 Nov 2026): PPZ everywhere it reaches, CAZ inside the PPZ, PPI inside the CAZ; a missing or
  too old PPI leaves its ground to the CAZ, a missing CAZ to the PPZ; when every product is older than the limit (45 min), nothing.
  By the products' order, not their ranges (Hyderabad's PPZ reaches only 150 km and keeps its CAZ out to 250 km).
- **Radar quality control** (the owner, 1 Nov 2026: "make sure we are not missing any original rain band likewise not displaying a radar
  glitch"; `core/services/radar-qc.ts`, `removeRadialSpikes` in `radar-process.ts`, run by the radar workflow): a product whose echo is
  85%+ under a clear sky by our Meteosat cloud tops is left out; in the composite a patch is removed only when all of it is under a clear
  sky; a picture unchanged for 45+ minutes is stale; weak (under 35 dBZ) thin spikes along one ray are removed; anti-aliased map lines
  in the legend's strong colours are removed. Rain touching cloud anywhere is always kept.
  Since 2 Nov: every radar is read from 15 dBZ up (most legends start at 20; Agartala's PPI went to 7, a disc of speckle round the radar;
  Karaikal's 17 dBZ light rain stays); spikes up to 4 degrees wide, 8 from 200 km out (Visakhapatnam's wedges, Paradip's bars), with gaps
  up to 25 km (Patna's blocks), are caught, but only when the chain is at least five times longer than wide; 35 dBZ+ is always kept.
- **Echo that stays put is clutter** (the owner, 1 Nov 2026: "look for the non changing ones, keep the changing ones"; `radar-persist.ts`):
  the radar workflow remembers, from run to run (`persist.bin.gz` beside the manifest), how many scans each cell of each product has shown
  echo of the same strength (within 3 dBZ). After 18 such scans (about 3 hours; another strength takes 3 off, no echo 1) the cell's echo
  is removed, cloud or no cloud; in a patch only when steady cells are at least half of it (the whole patch from 80%), so moving rain with a
  steady spot in it stays. Checked on IMD's 3-hour loops of Karaikal and Chennai: only the clutter at Chennai's radar and on the hills west
  of Karaikal is that steady; no rain band came near.
- **The radars are fetched only while the radar is on the map**: with 45 radars, fetching
  and composing them every minute slowed the forecast maps down while the radar was not shown (the owner, 24 Oct 2026).
- **Scan times are read from the time printed on the pictures**, not IMD's file time (9d25f79).
- **Individual radar stations and product buttons removed from the radar panel** (owner request, 25 Oct 2026: "remove this options from radar menu", "dont show the radars in the menu"): with the unified all-India composite served directly, station chips and product mode buttons are no longer displayed in the radar menu. The All/CAZ/PPZ/PPI buttons were back; removed again with the radar's
  opacity slider (the owner, 1 Nov 2026: "no need the radar menus as we are by default merging all those, and remove the opacity"): the
  radar is always the merged stack at full opacity.
- **Clicking shows the radar tooltip** (the owner, 25 Oct 2026; trimmed 3 Nov: "remove the unwanted tooltip data from radar layer"): the
  dBZ, the rain rate (and the last hour's rain) and the kind of rain ("Rain aloft" where only a high beam sees it); no coordinates and no
  table of each radar's beam heights. Hidden when clicking again anywhere; not on hover.
- Radar positions: Karaikal 10.91294 N 79.84175 E, Chennai 13.0839 N 80.2901 E (as given by the owner).
- **Every IMD radar, read the way Karaikal and Chennai are** (the owner, 23 Oct 2026: "i want data from all the radar stations"): 45
  radars (Sriharikota removed on owner request, 25 Oct 2026; Pallikaranai, 1 Nov 2026: "remove the pallikaranai radar"), Karaikal and Chennai first. Kochi, Thiruvananthapuram and Mangaluru as measured before; every other
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
- **The forecast box is 5-20 N, 70-97.5 E** (the owner, 6 Nov 2026, a cropped screenshot: "i want this region alone, for all models, remove the state lines for the hidden ones, make every forecast only on this area"; was all of India, then briefly to 22 N). Every map model is built on it (`IFS_LAT_MAX`/`IFS_LON_MIN` in pipeline/config.py; `FORECAST_BOX` in derived-fields.ts). Outside it: no state or district lines (`clipOutlines` cuts them at the edge), the place card says "Outside the forecast area" and the meteogram fetches nothing. The cyclone tracks keep their wider region.
- **Temperature on Windy's scale, pinned to degrees, -100 to +50 °C** (the owner, 6 Nov 2026: "temperature below 15 looks same ... we may also have negative values up to -100"). Read from Windy's legend (one colour every 5 °C: violet -20, pale cyan -15, teal -10/-5, blue 0, green 5, olive 10, mustard 15, yellow 20, orange 25, red 30, brick 35, dark red 40), colder with Windy's upper-air purples (`TEMP_ANCHORS`, `tempStops`). Every temperature layer (temperature, lowest/highest, feels like, dew point, every level) and the place card's day bars use it; the map is drawn from -20 to 45 °C at the ground and opaque. The pipeline stores wider ranges so nothing clips: t2m and the 24 h extremes -40..50, feels -50..60, dew -50..40, 200 hPa down to -100.
- **Rain and rain accumulation in Windy's colours, pinned to amounts** (the owner, 6 Nov 2026: "rain accumulation and rain layer was also not good ... fix those with correct color and values"). Read from Windy's own legends that day. **Rain uses the accumulation's colours** (the owner, 6 Nov 2026: "also use the same rain accumulation colors for rain"; `RAIN_ANCHORS`: violet-blue to 0.5 mm/h, blue 1, cyan 2, aqua 3, aqua-green 5, lime 10, orange 20, red 35, dark red 50; the map to 50 mm/h); accumulation (`RAIN_ACCUMULATION_ANCHORS`: violet-blue to 3 mm, blue 5.5, cyan 10, aqua 16, aqua-green 25, lime 50, orange 100, red 173, dark red 300). Both opaque. **The pin's rain number is the model's, as the map draws it**: the hills' lift factor (up to 2.6x) was on the number only, so the pin said 0.4 mm/h over clear map.
- **Wind in Windy's own colour scale, opaque** (the owner, 6 Nov 2026, Windy's 700 hPa wind beside ours: "look at windy color palette vs ours, fix ours"): the colours are pinned to speeds as Windy's are (`WIND_ANCHORS` in windy-palettes.ts: blue-violet calm, blue 1 m/s, teal 3, sea-green 5, green 7-9, olive 11, ochre 13, brown-red 15, wine 17, magenta 19, violet 21, then jet-stream blues, purple and pale), so a speed has the same colour at every level; wind and gusts are drawn at full opacity (were 0.8 and 0.85, which dulled them over the dark map).
- **Humidity is blue only above 75 %** (the owner, 5 Nov 2026: "make the humidity palette blue only after 75 percent"): the Windy colours are pinned to values (`humidityStops` in windy-palettes.ts: brown 30, olive 40, green 50, teal-green 65 to 75, then blue from 80 to slate at 100), at ground level and aloft alike.

- **Only national and state highways on the map** (the owner, 1 Nov 2026): OSM's motorway and trunk (India's national highways) and
  primary (mostly state highways); secondary, tertiary and minor roads are not drawn.
- **Wind particles as tuned on 19 Oct** (27c7414), **faster since 1 Nov 2026** (the owner: "the wind particle animation is dead slow"):
  10 px/s per m/s instead of 4.5 (`PX_PER_MS`), shorter tails in time so the streaks stay about as long, and a slow device's frames no
  longer slow the flow down (time step up to 0.1 s). **A little slower again, curved and soft since 2 Nov** (the owner: "make the wind
  particles little slow and smooth edges while curving or turning"): 7 px/s per m/s; each tail follows the particle's recent path (its
  velocity a moment ago, TRAIL_MEMORY_S) as a smooth curve of six pieces, its sides softened over a pixel.
- **Rain probability: the ECMWF ensemble** (share of members with rain), models' agreement only as the fallback (5b7da55). Meteologix was
  not used (its charts are not open data).
- **No weather stations, airports or rain gauges in the app** (15128ce): the owner asked for them removed.
- **UK Met Office is not drawn on the map** (owner, 23 Oct: "lets compramise UK MET"): the published site was 1.077 GB, over GitHub Pages' 1 GB, and UKMO's
  folder was about 205 MB; without it the site is about 0.87 GB. The place forecast and the Kralveth Blend still read UKMO from Open-Meteo.
- **GFS, AIGFS and AIFS maps reach 10 days** (the owner, 4 Nov 2026: "reduce the atmos data size"): the forecast site was 838 MB of GitHub Pages' 1 GB (ECMWF IFS 360 MB, GFS 127, AIGFS 77, ICON 62, AIFS 55, terrain 132; only the newest run of each model is kept). Days 11 to 16 of those three were about 95 MB, so the map stops at +240 h (`MAP_REACH_H` in models_regular.py). The place forecast already shows 10 days, so the two now match.
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

- **The rain rate in the radar readout uses each radar's Z-R relation as last fitted to the Tamil Nadu gauges** (public/data/verification/
  radar.json, kept as it was when the fitting stopped; Z = 200 R^1.6 for a radar without one). With the loop in, it also gives the last
  hour's radar rain.
- **No nowcast at all** (the owner, 3 Nov 2026: "Remove ... Nowcast workflow"; after the bot that posted storms, 1 Nov): the radar slid ahead
  in the time bar, its line and score in the radar panel, the place card's rain line, nowcast.yml and its radar sampler (bot/), and the
  daily radar scoring that read the sampler (verify_radar.py) are gone. The radar is fetched only while it is on the map.
- **On phones the radar animations are not downloaded in the background** (about 8 MB): storm motion from the wind until live pictures
  or Play give the radar's own (measured with e2e/perf.mjs).
- **The satellite loop moves the clouds between pictures** (motion from block matching) instead of cross-fading; the pictures' own
  colours are unchanged.

## Performance

- **Terrain relief off by default** (the owner, 3 Nov 2026: "turn off the terrain relief default for max performance"); the layer menu still
  switches it on, and that choice is remembered. A weak device (2 cores or fewer, 2 GB or less, a software GPU, or under 36 frames a second
  once the map is loaded) also draws the map at 1.5x at most and keeps relief off unless chosen (`LowPowerService`).
- **The place card's rain line waits for the page to settle** before it fetches the radars' composite (it competed with the first forecast).

## Name and hosting

- **The project is Kralveth Weather** (the owner, 1 Nov 2026: "change the project name to kralveth weather"; AtmosIQ before): the page title,
  the installed app's name (Kralveth on the home screen), the About card and the Kralveth Blend. Stored settings keep their atmosiq.* keys and
  the GitHub repositories their names, so nothing saved is lost.
- **Cloudflare hosts the site** (the owner, 1-2 Nov 2026): on Pages at https://kralveth-weather.pages.dev (functions/), the address the
  Android app opens; also as a Worker at https://weather.kralveth.workers.dev (worker/index.js, wrangler.toml); Netlify still works. README.md has the setup. Our functions are
  at /api/ on every host, written with web APIs only so no host needs Node compatibility.

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
- **Removed: the Kralveth Blend in the app** (the owner, 6 Nov 2026: "the blend is not accurate so lets remove it"): no Blend line on the place card, no Blend days, no Blend row or line in the meteogram, no "Atmos Blend" choice for the probability of rain (the ECMWF ensemble only). Each model's airport correction stays. The pipeline still writes the Blend's weights in corrections.json (unused by the app). The entry below records how it worked.
- **The Kralveth Blend**: the corrected models weighted by recent error (rain by the square of the threat score), only in the meteogram's
  comparison and the place card (its next days while its backtest beats every model), not a map layer.
- **DWD ICON is a map model again** (22 Oct): 00Z and 12Z to +120 h on the 0.25 degree grid (the site must stay under Pages' 1 GB).
- Commits go straight to `main`; if a push is rejected, `git pull --rebase origin main` first (the Actions bot commits data to `main`).
