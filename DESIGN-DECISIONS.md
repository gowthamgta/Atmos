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
- **Faint echoes where the beams pass high are drawn see-through, never removed** ("rain aloft": may not reach the ground; see Radar
  notes in the app). Strong echoes stay solid.
- 🔒 **Colours: the Windy-style radar palette with red and orange cores** (08c6184).
- **Where radars overlap, the strongest echo is drawn** (783a81b); an echo from an older scan is drawn fainter (3a793df).
- **PPI is shown as the whole square picture**, not cut to a circle (b7a758b, 4e951d8). **CAZ covers 250 km** for both radars (3ab5fa6).
- **Scan times are read from the time printed on the pictures**, not IMD's file time (9d25f79).
- **Each radar can be turned off and on** in the panel, both off allowed; the map does not move when toggling (ef6d868, b6f48f9).
- **Hovering shows the height of each radar's beam** over the place (28e1541).
- Radar positions: Karaikal 10.91294 N 79.84175 E, Chennai 13.0839 N 80.2901 E (as given by the owner). Sriharikota was removed.

## Forecast and the rest of the map

- **Wind particles as tuned on 19 Oct** (27c7414): the owner chose to keep them.
- **Rain probability: the ECMWF ensemble** (share of members with rain), models' agreement only as the fallback (5b7da55). Meteologix was
  not used (its charts are not open data).
- **No weather stations, airports or rain gauges in the app** (15128ce): the owner asked for them removed.
- The Clouds layer was left out on purpose (6cddf45).
- UI: modelled on Windy (dark) and meteoblue (light); colours only through the tokens in `src/styles.css`; no text under 11 px (a test
  enforces it).
- Personal, non-commercial project; every data source must stay free with no billing account.

## Pipeline

- **The nwp workflow runs at 05:00, 10:00, 13:30, 17:30, 21:00 and 00:00 IST** (403de3a). Each run builds the newest cycle surely
  published by then.
- Commits go straight to `main`; if a push is rejected, `git pull --rebase origin main` first (the Actions bot commits data to `main`).
