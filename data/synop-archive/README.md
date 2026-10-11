# SYNOP archive

Every SYNOP report of the Tamil Nadu weather stations that the observations workflow has fetched (via Ogimet), one CSV per month: temperature, dew point, humidity, wind, pressure, rain, the day extremes, and the raw report. Kept outside `public/` and `pipeline/data/`, like the METAR archive, so adding to it neither grows the site nor triggers a forecast rebuild.
