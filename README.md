# أرضي (Ardi): farm map, weather and irrigation

Live app: https://adhammokhless1.github.io/Ardi-farm-app/

An Arabic web app for small and mid-size farmers:
- Draw your field on a satellite map and see its area in feddans
- Crop health (NDVI) from Sentinel-2
- Surface soil moisture from Sentinel-1 radar, plus model soil moisture
- 7-day weather, spray windows, and alerts for disease, frost, heat, wind and rain
- Irrigation calculator (FAO-56: ET0 × Kc, leaching, drip hours)
- Daily log with Excel (CSV) export

## Automatic daily data
`.github/workflows/daily.yml` runs every day at 06:00 Cairo time. For each field in `fields.json` it saves:
- `data/<id>.csv`: weather, ET0, irrigation need and soil moisture
- `data/<id>-ndvi.csv`: NDVI from any new clear satellite image

To add your fields, open the app's **السجل** tab, tap **انسخ بيانات أراضيّ**, and paste the result into `fields.json`.

Data: Open-Meteo (free for non-commercial use), Element84 Earth Search (Sentinel-2), Microsoft Planetary Computer (Sentinel-1 RTC), Esri World Imagery.
