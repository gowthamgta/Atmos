# METAR archive

Every airport report the observations workflow has fetched, one CSV per month (station, time, temperature, dew point, humidity, wind, visibility, pressure, weather, raw report). Kept outside `public/` and `pipeline/data/` on purpose, so adding to it neither grows the site nor triggers a forecast rebuild. It is the history a temperature correction needs before it can be tested (see pipeline/bias.py).
