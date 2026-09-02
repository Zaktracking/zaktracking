/**
 * Where India's towns are.
 *
 * Indian couriers do not give GPS. What they give is a place name on each
 * scan - "Bhiwandi Hub", "Patna_Bihar", "New Delhi". That is enough to draw
 * an honest map: a real point on the ground for every scan, joined in the
 * order they happened. Nothing here pretends to know where the van is.
 *
 * Only the names couriers actually use are worth carrying. Anything not
 * found simply drops out of the map instead of guessing.
 */

export type Point = { name: string; lat: number; lon: number };

const CITIES: Record<string, [number, number]> = {
  delhi: [28.61, 77.21], "new delhi": [28.61, 77.21], gurgaon: [28.46, 77.03],
  gurugram: [28.46, 77.03], noida: [28.54, 77.39], faridabad: [28.41, 77.31],
  ghaziabad: [28.67, 77.43], sonipat: [28.99, 77.02], mumbai: [19.08, 72.88],
  bhiwandi: [19.30, 73.06], thane: [19.22, 72.98], "navi mumbai": [19.03, 73.03],
  pune: [18.52, 73.86], nashik: [19.997, 73.79], nagpur: [21.15, 79.09],
  aurangabad: [19.88, 75.34], kolhapur: [16.70, 74.24], solapur: [17.66, 75.91],
  bengaluru: [12.97, 77.59], bangalore: [12.97, 77.59], mysuru: [12.30, 76.64],
  mysore: [12.30, 76.64], hubli: [15.36, 75.12], mangaluru: [12.91, 74.86],
  belgaum: [15.85, 74.50], chennai: [13.08, 80.27], coimbatore: [11.02, 76.96],
  madurai: [9.92, 78.12], salem: [11.66, 78.15], tiruchirappalli: [10.79, 78.70],
  trichy: [10.79, 78.70], tirupur: [11.11, 77.34], erode: [11.34, 77.72],
  hyderabad: [17.39, 78.49], secunderabad: [17.44, 78.50], warangal: [17.97, 79.59],
  vijayawada: [16.51, 80.65], visakhapatnam: [17.69, 83.22], vizag: [17.69, 83.22],
  guntur: [16.31, 80.44], tirupati: [13.63, 79.42], nellore: [14.44, 79.99],
  kolkata: [22.57, 88.36], howrah: [22.59, 88.31], durgapur: [23.52, 87.31],
  siliguri: [26.73, 88.40], asansol: [23.68, 86.98], kharagpur: [22.35, 87.32],
  patna: [25.59, 85.13], gaya: [24.79, 85.00], muzaffarpur: [26.12, 85.39],
  bhagalpur: [25.24, 86.98], darbhanga: [26.15, 85.90], bettiah: [26.80, 84.50],
  motihari: [26.65, 84.92], chhapra: [25.78, 84.73], purnia: [25.78, 87.47],
  begusarai: [25.42, 86.13], hajipur: [25.69, 85.21], siwan: [26.22, 84.36],
  ranchi: [23.34, 85.31], jamshedpur: [22.80, 86.20], dhanbad: [23.80, 86.43],
  bokaro: [23.67, 85.96], lucknow: [26.85, 80.95], kanpur: [26.45, 80.33],
  varanasi: [25.32, 82.97], allahabad: [25.44, 81.85], prayagraj: [25.44, 81.85],
  agra: [27.18, 78.01], meerut: [28.98, 77.71], bareilly: [28.37, 79.43],
  gorakhpur: [26.76, 83.37], aligarh: [27.90, 78.08], moradabad: [28.84, 78.77],
  jhansi: [25.45, 78.57], mathura: [27.49, 77.67], ayodhya: [26.80, 82.20],
  jaipur: [26.91, 75.79], jodhpur: [26.24, 73.02], udaipur: [24.58, 73.71],
  kota: [25.21, 75.86], ajmer: [26.45, 74.64], bikaner: [28.02, 73.31],
  alwar: [27.55, 76.63], ahmedabad: [23.02, 72.57], surat: [21.17, 72.83],
  vadodara: [22.31, 73.18], rajkot: [22.30, 70.80], bhavnagar: [21.76, 72.15],
  jamnagar: [22.47, 70.06], gandhinagar: [23.22, 72.65], bhopal: [23.26, 77.41],
  indore: [22.72, 75.86], jabalpur: [23.18, 79.99], gwalior: [26.22, 78.18],
  ujjain: [23.18, 75.78], raipur: [21.25, 81.63], bilaspur: [22.08, 82.15],
  bhubaneswar: [20.30, 85.82], cuttack: [20.46, 85.88], rourkela: [22.26, 84.85],
  puri: [19.81, 85.83], berhampur: [19.31, 84.79], guwahati: [26.14, 91.74],
  dibrugarh: [27.47, 94.91], silchar: [24.83, 92.79], agartala: [23.83, 91.28],
  shillong: [25.58, 91.89], imphal: [24.82, 93.94], aizawl: [23.73, 92.72],
  itanagar: [27.08, 93.61], kohima: [25.67, 94.11], gangtok: [27.33, 88.61],
  chandigarh: [30.73, 76.78], ludhiana: [30.90, 75.86], amritsar: [31.63, 74.87],
  jalandhar: [31.33, 75.58], patiala: [30.34, 76.39], bathinda: [30.21, 74.95],
  ambala: [30.38, 76.78], panipat: [29.39, 76.97], hisar: [29.15, 75.72],
  karnal: [29.69, 76.99], rohtak: [28.90, 76.61], dehradun: [30.32, 78.03],
  haridwar: [29.95, 78.16], haldwani: [29.22, 79.52], shimla: [31.10, 77.17],
  jammu: [32.73, 74.87], srinagar: [34.08, 74.80], kochi: [9.93, 76.27],
  ernakulam: [9.98, 76.28], thiruvananthapuram: [8.52, 76.94], trivandrum: [8.52, 76.94],
  kozhikode: [11.26, 75.78], calicut: [11.26, 75.78], thrissur: [10.53, 76.21],
  kollam: [8.89, 76.61], kannur: [11.87, 75.37], panaji: [15.50, 73.83],
  goa: [15.30, 74.08], vasco: [15.40, 73.81], pondicherry: [11.94, 79.83],
  puducherry: [11.94, 79.83], vellore: [12.92, 79.13], hosur: [12.74, 77.83],
  tumkur: [13.34, 77.10], davangere: [14.47, 75.92], gulbarga: [17.33, 76.83],
  nanded: [19.15, 77.32], amravati: [20.93, 77.75], akola: [20.71, 77.00],
  latur: [18.40, 76.58], sangli: [16.85, 74.58], ratlam: [23.33, 75.04],
  sagar: [23.84, 78.74], satna: [24.60, 80.83], rewa: [24.53, 81.30],
  korba: [22.35, 82.68], jagdalpur: [19.08, 82.03], dispur: [26.14, 91.79],
};

/** Courier scans look like "Bhiwandi_Maharashtra (HUB)" or "Patna, Bihar". */
export function place(raw: string | null | undefined): Point | null {
  const text = String(raw || "").toLowerCase();
  if (!text.trim()) return null;

  // Every word-ish chunk, longest first, so "new delhi" wins over "delhi".
  const chunks = text
    .split(/[^a-z]+/)
    .filter((w) => w.length > 2);

  for (let i = 0; i < chunks.length - 1; i++) {
    const pair = `${chunks[i]} ${chunks[i + 1]}`;
    const hit = CITIES[pair];
    if (hit) return { name: title(pair), lat: hit[0], lon: hit[1] };
  }
  for (const w of chunks) {
    const hit = CITIES[w];
    if (hit) return { name: title(w), lat: hit[0], lon: hit[1] };
  }
  return null;
}

function title(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
