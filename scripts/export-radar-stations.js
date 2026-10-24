const fs = require('fs');
const path = require('path');

const networkFile = path.resolve(__dirname, '../src/app/core/domain/models/imd-radar-network.ts');
const networkCode = fs.readFileSync(networkFile, 'utf8');

const m = networkCode.match(/export const MEASURED_STATIONS[^=]*=\s*(\[[\s\S]*?\n\];)/);
if (!m) {
  throw new Error('Could not find MEASURED_STATIONS in imd-radar-network.ts');
}

let rawArray = m[1].trim();
if (rawArray.endsWith(';')) rawArray = rawArray.slice(0, -1);

const measured = eval(rawArray);

const primaryStations = [
  {
    id: 'karaikal', name: 'Karaikal DWR', code: 'kkl', state: 'Puducherry', lat: 10.91294, lng: 79.84175, band: 'S-Band',
    products: {
      caz: { rangeKm: 250, crop: { x: 0, y: 201, w: 519, h: 519 } },
      ppi: { rangeKm: 150, crop: { x: 0, y: 0, w: 720, h: 720 } },
      ppz: { rangeKm: 500, crop: { x: 0, y: 0, w: 720, h: 720 } },
    }
  },
  {
    id: 'chennai', name: 'Chennai DWR', code: 'cni', state: 'Tamil Nadu', lat: 13.0839, lng: 80.2901, band: 'S-Band',
    products: {
      caz: { rangeKm: 250, crop: { x: 2, y: 39, w: 674, h: 674 } },
      ppi: { rangeKm: 150, crop: { x: 2, y: 39, w: 674, h: 674 } },
      ppz: { rangeKm: 500, crop: { x: 2, y: 39, w: 674, h: 674 } },
    }
  },
  {
    id: 'kochi', name: 'Kochi DWR', code: 'koc', state: 'Kerala', lat: 9.9312, lng: 76.2673, band: 'S-Band',
    products: {
      caz: { rangeKm: 255, crop: { x: 44, y: 192, w: 554, h: 554 } },
      ppi: { rangeKm: 150, crop: { x: 44, y: 46, w: 702, h: 702 } },
      ppz: { rangeKm: 500, crop: { x: 44, y: 46, w: 702, h: 702 } },
    }
  },
  {
    id: 'thiruvananthapuram', name: 'Thiruvananthapuram DWR', code: 'tvm', state: 'Kerala', lat: 8.5374, lng: 76.8657, band: 'C-Band',
    products: {
      caz: { rangeKm: 240, crop: { x: 0, y: 201, w: 519, h: 519 } },
      ppi: { rangeKm: 150, crop: { x: 0, y: 0, w: 720, h: 720 } },
      ppz: { rangeKm: 500, crop: { x: 0, y: 0, w: 720, h: 720 } },
    }
  },
  {
    id: 'mangaluru', name: 'Mangaluru DWR', code: 'mlr', state: 'Karnataka', lat: 12.901, lng: 74.856, band: 'C-Band',
    products: {
      caz: { rangeKm: 250, crop: { x: 0, y: 201, w: 519, h: 519 } },
      ppi: { rangeKm: 150, crop: { x: 0, y: 0, w: 720, h: 720 } },
      ppz: { rangeKm: 500, crop: { x: 0, y: 0, w: 720, h: 720 } },
    }
  },
  {
    id: 'sriharikota', name: 'Sriharikota DWR', code: 'shr', state: 'Andhra Pradesh', lat: 13.6646, lng: 80.2276, band: 'S-Band',
    products: {
      caz: { rangeKm: 240, crop: { x: 0, y: 0, w: 720, h: 720 } },
      ppi: { rangeKm: 150, crop: { x: 0, y: 0, w: 720, h: 720 } },
    }
  },
  {
    id: 'pallikaranai', name: 'Pallikaranai X-Band', code: 'plk', state: 'Tamil Nadu', lat: 12.9451, lng: 80.2115, band: 'X-Band',
    products: {
      caz: { rangeKm: 87, crop: { x: 0, y: 219, w: 801, h: 801 } },
      ppi: { rangeKm: 87, crop: { x: 0, y: 0, w: 880, h: 880 } },
    }
  }
];

// Combine unique by id
const map = new Map();
for (const s of primaryStations) map.set(s.id, s);
for (const s of measured) map.set(s.id, s);

const allStations = Array.from(map.values());
const outDir = path.resolve(__dirname, '../pipeline/data');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'radar_stations.json');
fs.writeFileSync(outFile, JSON.stringify(allStations, null, 2), 'utf8');

console.log(`Successfully exported ${allStations.length} radar stations to ${outFile}`);
