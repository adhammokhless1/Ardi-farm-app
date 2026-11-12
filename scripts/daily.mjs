// Runs once a day (GitHub Actions). For each field in fields.json it appends
// yesterday's weather, ET0, irrigation need and soil moisture to data/<id>.csv,
// plus the NDVI of any new cloud-free Sentinel-2 scene to data/<id>-ndvi.csv.
import fs from "fs";
import { fromUrl } from "geotiff";
import proj4 from "proj4";

const KC = { tomato:[0.6,1.15,0.8], potato:[0.5,1.15,0.75], wheat:[0.3,1.15,0.25], maize:[0.3,1.2,0.6], rice:[1.05,1.2,0.9],
  cotton:[0.35,1.18,0.6], banana:[1.0,1.2,1.1], citrus:[0.7,0.65,0.7], mango:[0.6,0.75,0.7], olive:[0.65,0.7,0.7], grape:[0.3,0.7,0.45],
  strawberry:[0.4,0.85,0.75], cucumber:[0.6,1.0,0.75], pepper:[0.6,1.05,0.9], onion:[0.7,1.05,0.75] };
const ECE = { tomato:2.5, potato:1.7, wheat:6, maize:1.7, rice:3, cotton:7.7, banana:1, citrus:1.7, mango:1.5, olive:4, grape:1.5, strawberry:1, cucumber:2.5, pepper:1.5, onion:1.2 };
const kcFor = (k, st) => { const [a,b,e] = KC[k] || KC.tomato; return st==="ini"?a: st==="dev"?(a+b)/2: st==="end"?e: b; };

const fields = JSON.parse(fs.readFileSync("fields.json", "utf8"));
fs.mkdirSync("data", { recursive: true });
const num = x => x==null||Number.isNaN(x) ? "" : (+x).toFixed(3).replace(/\.?0+$/, "");
function appendRow(file, header, row) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, header.join(",") + "\n");
  const txt = fs.readFileSync(file, "utf8");
  if (txt.split("\n").some(l => l.startsWith(row[0] + ","))) return false;   // already logged
  fs.appendFileSync(file, row.join(",") + "\n"); return true;
}
const centroid = c => [c.reduce((s,p)=>s+p[0],0)/c.length, c.reduce((s,p)=>s+p[1],0)/c.length];
const pip = (x,y,poly) => { let ins=false; for(let i=0,j=poly.length-1;i<poly.length;j=i++){ const [xi,yi]=poly[i],[xj,yj]=poly[j]; if(((yi>y)!==(yj>y)) && (x<(xj-xi)*(y-yi)/(yj-yi)+xi)) ins=!ins; } return ins; };

async function weather(f) {
  const [lat, lon] = centroid(f.coords);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
    + "&hourly=soil_moisture_3_to_9cm,soil_moisture_9_to_27cm,soil_moisture_27_to_81cm"
    + "&daily=temperature_2m_max,temperature_2m_min,relative_humidity_2m_mean,precipitation_sum,wind_speed_10m_max,shortwave_radiation_sum,et0_fao_evapotranspiration"
    + "&timezone=auto&past_days=1&forecast_days=1";
  const j = await (await fetch(url)).json();
  const d = j.daily, i = 0, day = d.time[i];                    // index 0 = yesterday (complete day)
  const soil = k => { const v = j.hourly.time.map((t,n)=>t.startsWith(day)?j.hourly[k][n]:null).filter(x=>x!=null); return v.length ? v.reduce((a,b)=>a+b,0)/v.length : null; };
  const kc = kcFor(f.crop, f.stage), eff = +f.sys || 0.9, ece = ECE[f.crop] || 2, ecw = +f.ec || 0;
  const rain = d.precipitation_sum[i] || 0, etc = d.et0_fao_evapotranspiration[i] * kc;
  const net = Math.max(0, etc - (rain >= 2 ? rain*0.8 : 0));
  const lr = ecw > 0 ? Math.min(0.5, ecw / Math.max(ecw, 5*ece - ecw)) : 0;
  const m3 = net / eff / (1 - lr) * 4.2;
  const hrs = f.plants && f.emit && f.flow ? m3*1000/f.plants/(f.emit*f.flow) : null;
  return [day, d.temperature_2m_max[i], d.temperature_2m_min[i], d.relative_humidity_2m_mean[i], rain, d.wind_speed_10m_max[i],
    d.shortwave_radiation_sum[i], d.et0_fao_evapotranspiration[i], etc, m3, hrs,
    soil("soil_moisture_3_to_9cm"), soil("soil_moisture_9_to_27cm"), soil("soil_moisture_27_to_81cm")];
}

async function readWindow(href, bbox) {
  const img = await (await fromUrl(href)).getImage();
  const [ox, oy] = img.getOrigin(), [rx, ry] = img.getResolution();
  const x0=Math.max(0,Math.floor((bbox[0]-ox)/rx)), x1=Math.min(img.getWidth(),Math.ceil((bbox[2]-ox)/rx));
  const y0=Math.max(0,Math.floor((bbox[3]-oy)/ry)), y1=Math.min(img.getHeight(),Math.ceil((bbox[1]-oy)/ry));
  const [data] = await img.readRasters({ window: [x0,y0,x1,y1] });
  return { data, w:x1-x0, h:y1-y0, ox:ox+x0*rx, oy:oy+y0*ry, rx, ry };
}
async function ndvi(f) {
  const ring = f.coords.map(([la,ln])=>[ln,la]); ring.push(ring[0]);
  const to = new Date(), from = new Date(to - 6*864e5);
  const r = await fetch("https://earth-search.aws.element84.com/v1/search", { method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ collections:["sentinel-2-l2a"], intersects:{type:"Polygon",coordinates:[ring]}, datetime:from.toISOString()+"/"+to.toISOString(),
      query:{"eo:cloud_cover":{"lt":60}}, sortby:[{field:"properties.datetime",direction:"desc"}], limit:5 }) });
  const out = [];
  for (const it of (await r.json()).features || []) {
    const epsg = it.properties["proj:epsg"], zone = epsg%100, south = Math.floor(epsg/100)===327;
    const pj = proj4("EPSG:4326", `+proj=utm +zone=${zone} ${south?"+south ":""}+datum=WGS84 +units=m +no_defs`);
    const poly = f.coords.map(([la,ln])=>pj.forward([ln,la])), xs = poly.map(p=>p[0]), ys = poly.map(p=>p[1]);
    const bbox = [Math.min(...xs)-20, Math.min(...ys)-20, Math.max(...xs)+20, Math.max(...ys)+20];
    const [red, nir, scl] = await Promise.all([readWindow(it.assets.red.href,bbox), readWindow(it.assets.nir.href,bbox), it.assets.scl?readWindow(it.assets.scl.href,bbox).catch(()=>null):null]);
    const sc = a => { const b = a["raster:bands"]?.[0]; return { s:b?.scale||1e-4, o:b?.offset||0 }; };
    const rs = sc(it.assets.red), ns = sc(it.assets.nir);
    let n=0, sum=0, weak=0, cloudy=0;
    for (let y=0; y<Math.min(red.h,nir.h); y++) for (let x=0; x<Math.min(red.w,nir.w); x++) {
      const px = red.ox+(x+.5)*red.rx, py = red.oy+(y+.5)*red.ry; if (!pip(px,py,poly)) continue;
      const R = red.data[y*red.w+x], N = nir.data[y*nir.w+x]; if (!R || !N) continue;
      if (scl) { const sx=Math.floor((px-scl.ox)/scl.rx), sy=Math.floor((py-scl.oy)/scl.ry); const c=(sx>=0&&sy>=0&&sx<scl.w&&sy<scl.h)?scl.data[sy*scl.w+sx]:0; if ([3,8,9,10,11].includes(c)) { cloudy++; continue; } }
      const rr=R*rs.s+rs.o, nn=N*ns.s+ns.o, v=(nn-rr)/(nn+rr||1); n++; sum+=v; if (v<0.35) weak++;
    }
    if (n && cloudy <= n) out.push([it.properties.datetime.slice(0,10), sum/n, weak/n*100, n, cloudy/(n+cloudy)*100]);
  }
  return out;
}

for (const f of fields) {
  try {
    const row = await weather(f);
    appendRow(`data/${f.id}.csv`, ["date","tmax_c","tmin_c","rh_mean_pct","rain_mm","wind_max_kmh","radiation_MJm2","et0_mm","etc_mm","irrigation_m3_per_feddan","drip_hours","soil_moist_3_9cm","soil_moist_9_27cm","soil_moist_27_81cm"], row.map((v,k)=>k?num(v):v));
    console.log(f.name, "weather", row[0]);
  } catch (e) { console.error(f.name, "weather failed", e.message); }
  try {
    for (const s of await ndvi(f)) if (appendRow(`data/${f.id}-ndvi.csv`, ["date","ndvi_mean","weak_area_pct","pixels","cloud_pct"], s.map((v,k)=>k?num(v):v))) console.log(f.name, "ndvi", s[0]);
  } catch (e) { console.error(f.name, "ndvi failed", e.message); }
}
