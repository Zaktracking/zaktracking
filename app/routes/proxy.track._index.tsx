import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { shopFromProxy, esc, liquid } from "../lib/proxy.server";
import { STATUS_LABEL } from "../lib/track.server";
import { money } from "../lib/templates.server";

/**
 * The actual tracking page - zakdor.com/apps/track
 *
 * This is a resource route (no default export), so the Response that
 * leaves here goes straight to the browser. Serving it with Content-Type
 * application/liquid makes Shopify place it between the theme header and
 * footer - the page looks like the rest of the store on its own. It also
 * means Liquid written here is rendered by Shopify, which is how the
 * "You may also like" row below reaches real products.
 *
 * It opens in two ways:
 *   /apps/track?n=<tracking number>   - from the WhatsApp button
 *   /apps/track?order=Z1005&pin=8695  - customer types it in
 *
 * The order number alone is not enough. Guessing Z1006 after Z1005 is far
 * too easy, and that would expose someone else's address. So we also ask
 * for the last 4 digits of the phone number. A tracking number is long and
 * random enough to stand on its own.
 *
 * The page is one column, top to bottom: the globe, the form, then the
 * result under it, then the products. Nothing navigates away - the form
 * submits back to this same URL and the answer appears below the button.
 */

const STEPS = ["Confirmed", "Shipped", "In transit", "Out for delivery", "Delivered"];

/**
 * One mark per stage, in the order above. A tick, a box, a lorry, a
 * scooter and a front door - the same five pictures a customer already
 * knows from every other parcel they have waited for, so the row reads
 * even before the words do.
 */
const ICONS = [
  '<svg viewBox="0 0 24 24"><path d="M4 12.5l5 5L20 6.5"/></svg>',
  '<svg viewBox="0 0 24 24"><path d="M3 7.6l9-4.6 9 4.6v8.8l-9 4.6-9-4.6z"/><path d="M3 7.6l9 4.6 9-4.6"/><path d="M12 12.2V21"/></svg>',
  '<svg viewBox="0 0 24 24"><rect x="1.5" y="6" width="13" height="10" rx="1.6"/><path d="M14.5 9H19l3 3.4V16h-7.5"/><circle cx="6" cy="18.5" r="2.1"/><circle cx="18" cy="18.5" r="2.1"/></svg>',
  '<svg viewBox="0 0 24 24"><circle cx="5.5" cy="17.5" r="3.1"/><circle cx="18.5" cy="17.5" r="3.1"/><path d="M8.6 17.5h6.8"/><path d="M15.4 17.5L13 9.2H9.8"/><path d="M13 9.2h4.4l1.5 8.3"/></svg>',
  '<svg viewBox="0 0 24 24"><path d="M3.2 10.6L12 3.2l8.8 7.4"/><path d="M5.4 9.3V20.8h13.2V9.3"/><path d="M9.6 20.8v-5.9h4.8v5.9"/></svg>',
];

/** A pin, for a scan whose words match nothing else. */
const PIN_ICON =
  '<svg viewBox="0 0 24 24"><path d="M12 21.5s7-6.1 7-11.2A7 7 0 0 0 5 10.3c0 5.1 7 11.2 7 11.2z"/><circle cx="12" cy="10.2" r="2.4"/></svg>';

/**
 * Couriers write their own words, so the mark is chosen from them. Order
 * matters here - "out for delivery" has to be tested before "delivered",
 * or every line would end up as a doorstep.
 */
function markFor(desc: any): string {
  const d = String(desc || "").toLowerCase();
  if (/out for delivery|with the rider|dispatched for delivery/.test(d)) return ICONS[3];
  if (/delivered|handed over|received by/.test(d)) return ICONS[4];
  if (/pick|collected|manifest|booked|shipped|dispatch/.test(d)) return ICONS[1];
  if (/transit|hub|facility|departed|arrived|reached|forward|bag/.test(d)) return ICONS[2];
  if (/confirm|placed|order/.test(d)) return ICONS[0];
  return PIN_ICON;
}


/**
 * How much cash the customer still owes, or null if nothing is due.
 *
 * The COD flag alone is not enough. A partial-payment COD app can create the
 * order with no gateway name at all, and an order written before that was
 * understood is still sitting in the database with isCod false. The balance
 * is the fact that matters: if money is outstanding, it is collected at the
 * door, whatever the flag says.
 */
function cashDue(rec: any): string | null {
  const out = Number(rec?.outstanding);
  if (Number.isFinite(out) && out > 0) return String(rec.outstanding);
  if (!rec?.isCod) return null;
  const total = Number(rec?.totalPrice);
  return Number.isFinite(total) && total > 0 ? String(rec.totalPrice) : null;
}

const STEP_OF: Record<string, number> = {
  pending: 1,
  info_received: 1,
  in_transit: 2,
  out_for_delivery: 3,
  delivered: 4,
  exception: 2,
  returned: 2,
};

function fmt(d: any): string {
  if (!d) return "";
  const x = new Date(d);
  if (isNaN(x.getTime())) return "";
  return x.toLocaleString("en-IN", {
    day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true,
  });
}

/* ---------------------------------------------------------------- */
/*  where the parcel is                                              */
/* ---------------------------------------------------------------- */

/**
 * Coordinates for the towns this store actually ships to. Only the pin on
 * the globe uses these, so a few kilometres either way changes nothing -
 * but a town that is missing would drop the pin in the wrong country, so
 * anything not on this list falls back to the middle of India and the pin
 * is drawn without a name.
 */
const CITY: Record<string, [number, number]> = {
  mumbai: [19.08, 72.88], delhi: [28.61, 77.21], "new delhi": [28.61, 77.21],
  bengaluru: [12.97, 77.59], bangalore: [12.97, 77.59], hyderabad: [17.39, 78.49],
  chennai: [13.08, 80.27], kolkata: [22.57, 88.36], pune: [18.52, 73.86],
  ahmedabad: [23.03, 72.58], surat: [21.17, 72.83], jaipur: [26.91, 75.79],
  lucknow: [26.85, 80.95], kanpur: [26.45, 80.33], nagpur: [21.15, 79.09],
  indore: [22.72, 75.86], bhopal: [23.26, 77.41], patna: [25.59, 85.14],
  vadodara: [22.31, 73.18], ludhiana: [30.9, 75.86], agra: [27.18, 78.01],
  nashik: [19.99, 73.79], varanasi: [25.32, 82.97], srinagar: [34.08, 74.8],
  aurangabad: [19.88, 75.34], rajkot: [22.3, 70.8], meerut: [28.98, 77.71],
  jabalpur: [23.18, 79.99], jodhpur: [26.24, 73.02], raipur: [21.25, 81.63],
  kota: [25.21, 75.86], guwahati: [26.14, 91.74], chandigarh: [30.73, 76.78],
  thiruvananthapuram: [8.52, 76.94], kochi: [9.93, 76.27], coimbatore: [11.02, 76.96],
  madurai: [9.93, 78.12], visakhapatnam: [17.69, 83.22], vijayawada: [16.51, 80.65],
  bhubaneswar: [20.3, 85.82], ranchi: [23.34, 85.31], jamshedpur: [22.8, 86.2],
  dhanbad: [23.8, 86.43], amritsar: [31.63, 74.87], jalandhar: [31.33, 75.58],
  gwalior: [26.22, 78.18], allahabad: [25.44, 81.85], prayagraj: [25.44, 81.85],
  ghaziabad: [28.67, 77.43], noida: [28.54, 77.39], gurugram: [28.46, 77.03],
  gurgaon: [28.46, 77.03], faridabad: [28.41, 77.31], howrah: [22.59, 88.31],
  ranchi_: [23.34, 85.31], solapur: [17.66, 75.91], hubli: [15.36, 75.12],
  mysuru: [12.3, 76.64], mysore: [12.3, 76.64], mangaluru: [12.91, 74.86],
  tiruchirappalli: [10.79, 78.7], salem: [11.66, 78.15], warangal: [17.98, 79.59],
  guntur: [16.31, 80.44], nellore: [14.44, 79.99], kurnool: [15.83, 78.04],
  udaipur: [24.58, 73.71], ajmer: [26.45, 74.64], bikaner: [28.02, 73.31],
  bareilly: [28.37, 79.43], moradabad: [28.84, 78.77], aligarh: [27.9, 78.09],
  gorakhpur: [26.76, 83.37], saharanpur: [29.97, 77.55], dehradun: [30.32, 78.03],
  jammu: [32.73, 74.86], shimla: [31.1, 77.17], siliguri: [26.73, 88.4],
  ranchi__: [23.34, 85.31], cuttack: [20.46, 85.88], rourkela: [22.26, 84.85],
  bhilai: [21.19, 81.35], bilaspur: [22.08, 82.15], ujjain: [23.18, 75.78],
  sagar: [23.84, 78.74], satna: [24.58, 80.83], muzaffarpur: [26.12, 85.39],
  gaya: [24.79, 85.0], bhagalpur: [25.24, 86.99], darbhanga: [26.15, 85.9],
  purnia: [25.78, 87.47], katihar: [25.54, 87.57], asansol: [23.68, 86.99],
  durgapur: [23.52, 87.31], "kalyan": [19.24, 73.13], thane: [19.22, 72.98],
  "navi mumbai": [19.03, 73.03], "vasai": [19.39, 72.83], panaji: [15.5, 73.83],
  goa: [15.3, 74.12], puducherry: [11.94, 79.83], pondicherry: [11.94, 79.83],
  imphal: [24.82, 93.94], shillong: [25.58, 91.89], agartala: [23.83, 91.28],
  aizawl: [23.73, 92.72], kohima: [25.67, 94.11], itanagar: [27.08, 93.61],
  gangtok: [27.33, 88.61], dispur: [26.14, 91.79], raebareli: [26.23, 81.23],
  jhansi: [25.45, 78.57], firozabad: [27.15, 78.4], mathura: [27.49, 77.67],
  "greater noida": [28.47, 77.5], sonipat: [28.99, 77.02], panipat: [29.39, 76.97],
  karnal: [29.69, 76.99], hisar: [29.15, 75.72], rohtak: [28.9, 76.61],
  ambala: [30.38, 76.78], patiala: [30.34, 76.39], bathinda: [30.21, 74.95],
  "vijaywada": [16.51, 80.65], tirupati: [13.63, 79.42], rajahmundry: [17.0, 81.78],
  kakinada: [16.99, 82.25], anantapur: [14.68, 77.6], "hubballi": [15.36, 75.12],
  belagavi: [15.85, 74.5], davangere: [14.47, 75.92], kollam: [8.89, 76.61],
  thrissur: [10.53, 76.21], kozhikode: [11.25, 75.78], kannur: [11.87, 75.37],
  alappuzha: [9.5, 76.34], kottayam: [9.59, 76.52], erode: [11.34, 77.72],
  vellore: [12.92, 79.13], tirunelveli: [8.71, 77.76], thoothukudi: [8.76, 78.13],
  nanded: [19.15, 77.32], latur: [18.4, 76.58], amravati: [20.93, 77.75],
  akola: [20.71, 77.0], jalgaon: [21.0, 75.56], sangli: [16.85, 74.58],
  kolhapur: [16.7, 74.24], ahmednagar: [19.09, 74.75], satara: [17.69, 74.0],
  bhavnagar: [21.76, 72.15], jamnagar: [22.47, 70.07], junagadh: [21.52, 70.46],
  gandhinagar: [23.22, 72.65], anand: [22.56, 72.96], bharuch: [21.71, 72.99],
  navsari: [20.95, 72.93], valsad: [20.6, 72.93], silvassa: [20.27, 73.01],
  daman: [20.4, 72.83], "port blair": [11.62, 92.73], kavaratti: [10.57, 72.64],
};

const INDIA: [number, number] = [22.5, 79.0];

/**
 * The newest place we can name. A courier scan wins over the delivery
 * town, because the scan says where the parcel *is* and the town only
 * says where it is going - showing the town while the box sits in another
 * state is how a tracking page starts lying.
 */
function whereIs(rec: any, scans: any[]): { lat: number; lon: number; name: string; live: boolean } {
  for (const s of scans) {
    const hit = lookup(s?.location);
    if (hit) return { ...hit, live: true };
  }
  const home = lookup(rec?.city);
  if (home) return { ...home, live: false };
  return { lat: INDIA[0], lon: INDIA[1], name: "", live: false };
}

/** "Bhiwandi Hub, Mumbai, MH" - try the whole thing, then each part. */
function lookup(raw: any): { lat: number; lon: number; name: string } | null {
  if (!raw) return null;
  const text = String(raw);
  for (const part of [text, ...text.split(/[,\-/|]/)]) {
    const key = part.trim().toLowerCase().replace(/\s+/g, " ");
    if (CITY[key]) return { lat: CITY[key][0], lon: CITY[key][1], name: part.trim() };
  }
  return null;
}
/* ---------------------------------------------------------------- */
/*  the globe                                                        */
/* ---------------------------------------------------------------- */

/**
 * A dotted Earth, drawn on a canvas, that turns on its own and can be
 * dragged by hand.
 *
 * The land is a bitmap, not an image: one bit per 2 degrees of latitude
 * and longitude, packed and base64'd. That is 1.8 KB for the whole world -
 * far lighter than a map library, and it draws in a few milliseconds.
 * Every dot is projected by hand (orthographic), so there is no WebGL and
 * nothing to download.
 */
const LAND ="AB//////zAAwf///////////////+AAAB//////4AAB///////////////8AAAAADAH///AAAB//////////////+AAAAAAA" +
  "GABWAAAAf//////////////wAAAAAAAAAeAAAAAAIB//+f//////4AAAAAAAAAAEAAAAAAAAD/+B/////wAAAAAAAAAAACAA" +
  "AAAAAAAMAAAGIAAAAAAAAAAAAAABwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAABwgAAAAAAAAAAAAAAAAAAAAAAAAAAAB4AAAAAAAAAAAAAAAAAAAAAAAAAAAAA8AAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAB4AAAAAAAAAAAAAAAAAAAwAAAAAAAAA8AAAAAAAAAAAAAAAAAAAQAAAAAAAAB8AAAAAAAAAAAAAAAAAYAMAAAAAA" +
  "AAA+AAAAAAAAAAAAAAAAAoACAAAAAAAAA/wAAAAAAAAAAAAAAABwADAAAAAAAAA/wAAAAAAAAAAAAAAAD8AEAAAAAAAAAf8A" +
  "AAAADgAAAAAADAP8AAAAAAAAAAAf+AAAAAD4AAAAAAD+f+AAAAAAAAAAAf+AAAAAH8AAAAAAD//+AAAAAAAAAAAf/AAAAAP+" +
  "AAAAAAD//+AAAAAAAAAAAf/AAAAAP+AAAAAAD//+AAAAAAAAAAAf/gAAAAP/DAAAAAH//8AAAAAAAAAAAf/8AAAAP/DgAAAA" +
  "H//4AAAAAAAAAAAf/8AAAAf/BgAAAAA//4AAAAAAAAAAAf/+AAAA//hgAAAAAP/wABAAAAAAAAB//+AAAA//5gAAAAAH5gAA" +
  "AAAAAAAAD//+AAAAf/4wAAAAABxAAAAAAAAAAAD///AAAAf/4AAAAAAARAAAAAAAAAAAH///AAAAf/wAAAAAAoAIAAAAAAAA" +
  "AAH///gAAAf/wAAAAAMAHQAAAAAAAAAAP///gAAAf/wAAAABAAD0AAAAAAAAAAP//+AAAA//wAAAACAwPgAAAAAAAAAAP//w" +
  "AAAB//4AAAAHOh0AAAAAAAAAAAP//AAAAB//8AAAAMegAAAAAAAAAAAAH/+AAAAB//+AAAAKOAAAAAAAAAAAAAD/+AAAAB//" +
  "/AAAAUmAAAAAAAAAAAAAD/wAAAfn///gAAAEBAAAAAAAAAAAAAH/gAAA/////gACAIAMAAAAAAAAAAAAheAAAB/////wAEAB" +
  "AAAAAAAAAAAAABgwAAAD////8AAMADgoAAAAAAAAAAAHgAAAAD////7AAOAPgAAAAAAAAAAAA8AAAAAD////74AeAfggAAAA" +
  "AAAAAAH8AEAAAD////3+AfA/AQAAAAAAAAAAPGCAAAAD////n+Afx/AAAAAAAAAAAAPAoAAAAD////v/B///4AAAAAAAAAAB" +
  "fAAAAAAB////P2D///+AAAAAAAAAAC/AAAAAAB////fx/////AAAAAAAAAAF/AQAAAAA/////v/////gAAAAAAAAAD/8QAAA" +
  "AAP////v/////gAAAAAAAAAP//wAAAAAP/zg///////gAAAAAAAAAf//8AAAAAH/AA///////g4AAAAAAAA///8AAAAAAfAA" +
  "///////iOAAAAAAAB///+AAAAAPAZv///////GCAAAAAAAD///+AAAAAPoLv///////eCAAAAAAAD////gAAAAPwz4H/////" +
  "/+AAAAAAAAD////0AAAAA+v4P///////xgAAAAAAB////8gAAAA//9f///////5EAAAAAAD////4cAAAD///////////8AAA" +
  "AAAAH////4AAAAAf//////////+AAAAAAAP///3/4AAAbn///////////AQAAAAA////n/wAAAZBv/////////6AwAACAA//" +
  "/+D/AAAACBx/////////4A8AAAgC///wD+AAAACA4f////////+AMAAf0P///gDgAAAAAH8D//////////EAAP/////wPAA4" +
  "AAAH5///////////98AD/////908B8AcAA+/v///////////+f/////+h7B+geAAf/H///////////wP///4Zcj8D/wAAAP/" +
  "xb/v////////AH/gYP8434F//gAAA4AAj///////wAAAAADfTC+AH/9gAAAAAMBi///+D4AAAAAADwBUAAP//gAAAAADAAv/" +
  "gAIAAAAAAAA+xMAA///wAAAAAAcAB/4ABAAAAAAAADCg+////wAAdAAAAAAIAAAAAAAAAAAAC//h///0AALwAAAADgAAAAAA" +
  "AAAAAAAD/+ev7UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** The grid the bitmap was made on. Both ends matter - the rows start at
 *  -78 and step by 2, and there are 180 columns of 2 degrees each. */
const G_LAT0 = -78, G_LAT_STEP = 2, G_ROWS = 82;
const G_LON0 = -180, G_LON_STEP = 2, G_COLS = 180;

/**
 * The globe's markup and its script. The land bitmap is handed in as a
 * string and unpacked in the browser - about 1.8 KB of data for the whole
 * world, and no library at all.
 */
function globeBlock(lat: number, lon: number, name: string, live: boolean): string {
  const js = [
    '(function(){',
    'var c=document.getElementById("ztG");if(!c||!c.getContext)return;',
    'var x=c.getContext("2d");',
    'var L=' + JSON.stringify(LAND) + ',R=' + G_ROWS + ',C=' + G_COLS + ';',
    'var LA0=' + G_LAT0 + ',LAS=' + G_LAT_STEP + ',LO0=' + G_LON0 + ',LOS=' + G_LON_STEP + ';',
    'var PLAT=' + lat + ',PLON=' + lon + ',PNAME=' + JSON.stringify(name) + ';',
    // unpack the bitmap into unit vectors, thinning each row so the dots
    // stay evenly spread instead of bunching up towards the poles
    'var b=atob(L),P=[];',
    'function bit(i){return (b.charCodeAt(i>>3)>>(7-(i&7)))&1}',
    'for(var r=0;r<R;r++){',
    ' var la=LA0+r*LAS,cs=Math.cos(la*Math.PI/180);',
    ' var st=Math.max(1,Math.round(1/Math.max(cs,0.17)));',
    ' for(var q=0;q<C;q+=st){',
    '  if(!bit(r*C+q))continue;',
    '  var lo=LO0+q*LOS,p=la*Math.PI/180,t=lo*Math.PI/180;',
    '  P.push([Math.cos(p)*Math.sin(t),Math.sin(p),Math.cos(p)*Math.cos(t)]);',
    ' }',
    '}',
    'function vec(la,lo){var p=la*Math.PI/180,t=lo*Math.PI/180;',
    ' return [Math.cos(p)*Math.sin(t),Math.sin(p),Math.cos(p)*Math.cos(t)]}',
    'var PIN=vec(PLAT,PLON);',
    // yaw brings the pin to the middle; pitch tilts it up a little
    'var yaw=-PLON*Math.PI/180,pit=Math.max(-0.6,Math.min(0.6,PLAT*Math.PI/180));',
    'var drag=false,px=0,py=0,idle=0;',
    'var slow=window.matchMedia&&window.matchMedia("(prefers-reduced-motion:reduce)").matches;',
    'var S=0,DPR=1,cx=0,cy=0,rad=0;',
    'function size(){',
    ' var w=Math.max(200,Math.min(c.parentNode.clientWidth-36,300));',
    ' S=w;DPR=Math.min(window.devicePixelRatio||1,2);',
    ' c.width=S*DPR;c.height=S*DPR;c.style.width=S+"px";c.style.height=S+"px";',
    ' x.setTransform(DPR,0,0,DPR,0,0);cx=S/2;cy=S/2;rad=S/2-8;',
    '}',
    'function turn(v){',
    ' var a=v[0],e=v[1],z=v[2],cy1=Math.cos(yaw),sy=Math.sin(yaw);',
    ' var a2=a*cy1+z*sy,z2=-a*sy+z*cy1;',
    ' var cp=Math.cos(pit),sp=Math.sin(pit);',
    ' return [a2,e*cp-z2*sp,e*sp+z2*cp];',
    '}',
    'function draw(){',
    ' x.clearRect(0,0,S,S);',
    ' var g=x.createRadialGradient(cx-rad*0.35,cy-rad*0.4,rad*0.1,cx,cy,rad);',
    ' g.addColorStop(0,"#1B3A73");g.addColorStop(1,"#0B1C3D");',
    ' x.fillStyle=g;x.beginPath();x.arc(cx,cy,rad,0,6.2832);x.fill();',
    ' x.strokeStyle="rgba(44,92,197,.22)";x.lineWidth=1;x.stroke();',
    ' for(var i=0;i<P.length;i++){',
    '  var v=turn(P[i]);if(v[2]<=0.02)continue;',
    '  x.globalAlpha=0.30+0.70*v[2];',
    '  x.fillStyle="#7FB0FF";',
    '  x.fillRect(cx+v[0]*rad-0.9,cy-v[1]*rad-0.9,1.8,1.8);',
    ' }',
    ' x.globalAlpha=1;',
    ' var pv=turn(PIN);',
    ' if(pv[2]>0.02){',
    '  var mx=cx+pv[0]*rad,my=cy-pv[1]*rad;',
    '  x.beginPath();x.arc(mx,my,7,0,6.2832);',
    '  x.fillStyle="rgba(44,92,197,.28)";x.fill();',
    '  x.beginPath();x.arc(mx,my,3.4,0,6.2832);',
    '  x.fillStyle="#2C5CC5";x.fill();',
    '  if(PNAME){',
    '   x.font="600 11px -apple-system,Segoe UI,Roboto,sans-serif";',
    '   var w=x.measureText(PNAME).width+16,lx=mx-w/2,ly=my-26;',
    '   if(lx<2)lx=2;if(lx+w>S-2)lx=S-2-w;if(ly<2)ly=my+14;',
    '   x.fillStyle="rgba(255,255,255,.94)";',
    '   if(x.roundRect){x.beginPath();x.roundRect(lx,ly,w,18,9);x.fill()}',
    '   else x.fillRect(lx,ly,w,18);',
    '   x.fillStyle="#0A1730";x.textBaseline="middle";',
    '   x.fillText(PNAME,lx+8,ly+9);',
    '  }',
    ' }',
    '}',
    'function tick(){',
    ' if(!drag&&!slow&&idle<=0)yaw+=0.0016;',
    ' if(idle>0)idle--;',
    ' draw();requestAnimationFrame(tick);',
    '}',
    'c.addEventListener("pointerdown",function(e){drag=true;px=e.clientX;py=e.clientY;',
    ' if(c.setPointerCapture)c.setPointerCapture(e.pointerId)});',
    'c.addEventListener("pointermove",function(e){if(!drag)return;',
    ' yaw+=(e.clientX-px)*0.006;',
    ' pit=Math.max(-1.1,Math.min(1.1,pit+(e.clientY-py)*0.006));',
    ' px=e.clientX;py=e.clientY;e.preventDefault()});',
    'function stop(){if(drag){drag=false;idle=180}}',
    'c.addEventListener("pointerup",stop);c.addEventListener("pointercancel",stop);',
    'window.addEventListener("resize",size);',
    'size();tick();',
    '})();',
  ].join("");

  const cap = !name
    ? "Track your Zakdor order"
    : live
      ? `Parcel is near <b>${esc(name)}</b>`
      : `Heading to <b>${esc(name)}</b>`;

  return `
  <div class="zt-globe">
    <canvas id="ztG" width="300" height="300" aria-hidden="true"></canvas>
    <p class="zt-gcap">${cap}</p>
    <span class="zt-ghint">drag to spin</span>
  </div>
  <script>${js}</script>`;
}

/* ---------------------------------------------------------------- */
/*  look                                                             */
/* ---------------------------------------------------------------- */

/**
 * A white page with one blue accent, and no cards anywhere - the only
 * thing separating one part from the next is a hairline.
 *
 * The white runs edge to edge even though the theme around it is navy.
 * That is the box-shadow spread plus clip-path, not width:100vw - 100vw
 * counts the scrollbar and would push the whole store sideways on a
 * desktop. clip-path lets the paint spill without adding any width.
 */
const CSS = `
<style>
.zt-wrap{--ink:#16181d;--mut:#65686f;--dim:#8a8d94;--bd:#e6e7ea;--blue:#2C5CC5;
  background:#fff;color:var(--ink);box-shadow:0 0 0 100vmax #fff;clip-path:inset(0 -100vmax);
  max-width:720px;margin:0 auto;padding:30px 18px 56px;font-family:inherit}

/* ---- the globe ---- */
.zt-globe{position:relative;text-align:center;padding:2px 0 4px}
.zt-globe:before{content:"";position:absolute;top:6%;left:50%;width:420px;height:340px;transform:translateX(-50%);background:radial-gradient(50% 50% at 50% 50%,rgba(44,92,197,.13),transparent 70%);pointer-events:none;filter:blur(8px)}
.zt-globe canvas{position:relative;display:block;margin:0 auto;touch-action:none;cursor:grab}
.zt-globe canvas:active{cursor:grabbing}
.zt-gcap{position:relative;color:var(--mut);font-size:13px;margin:12px 0 0;letter-spacing:.01em}
.zt-gcap b{color:var(--ink);font-weight:600}
.zt-ghint{position:absolute;right:0;bottom:2px;color:#b6bac1;font-size:10px;letter-spacing:.08em;text-transform:uppercase}

/* ---- tabs and form ---- */
.zt-tabs{display:flex;gap:26px;border-bottom:1px solid var(--bd);margin:26px 0 22px}
.zt-tab{background:none;border:0;padding:0 0 13px;font:inherit;font-size:14.5px;font-weight:600;color:var(--dim);cursor:pointer;position:relative;transition:color .18s}
.zt-tab[aria-selected="true"]{color:var(--ink)}
.zt-tab[aria-selected="true"]:after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;background:var(--blue);border-radius:2px}
.zt-pane[hidden]{display:none}
.zt-f{margin-bottom:14px}
.zt-lab{display:block;font-size:10.5px;font-weight:700;color:var(--dim);margin-bottom:7px;letter-spacing:.11em;text-transform:uppercase}
.zt-in{width:100%;box-sizing:border-box;padding:14px 15px;border:1px solid #d3d5da !important;border-radius:9px;font-size:15px;background:#fff !important;color:var(--ink) !important;transition:border-color .18s,box-shadow .18s}
.zt-in::placeholder{color:#9aa0a8 !important;opacity:1}
.zt-in:focus{outline:none;border-color:var(--blue) !important;box-shadow:0 0 0 3px rgba(44,92,197,.16)}
.zt-btn{width:100%;background:linear-gradient(180deg,#3B6BD4,#1E4494) !important;color:#fff !important;border:0;border-radius:9px;padding:15px 26px;font-size:12.5px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;cursor:pointer;margin-top:6px;transition:transform .15s,box-shadow .2s}
.zt-btn:hover{transform:translateY(-1px);box-shadow:0 8px 20px rgba(30,68,148,.28)}

/* ---- the result ---- */
.zt-sec{border-top:1px solid var(--bd);margin-top:30px;padding-top:26px}
.zt-hero{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:flex-start}
.zt-status{font-size:25px;font-weight:700;margin:2px 0 5px;letter-spacing:-.02em}
.zt-when{color:var(--mut);font-size:14px;margin:0}
.zt-ord{text-align:right}
.zt-ord b{display:block;font-size:16px}
.zt-ord span{color:var(--dim);font-size:13px}

/* the spine - one stage under the next, each with its own mark */
.zt-tl{list-style:none;margin:26px 0 0;padding:0}
.zt-tl li{position:relative;padding:3px 0 24px 46px;min-height:26px}
.zt-tl li:last-child{padding-bottom:0}
.zt-tl li:before{content:"";position:absolute;left:12px;top:29px;bottom:-6px;width:2px;background:#e4e6ea}
.zt-tl li:last-child:before{display:none}
.zt-tl i{position:absolute;left:0;top:0;width:26px;height:26px;border-radius:50%;background:#fff;border:1.5px solid #d8dade;box-sizing:border-box;display:flex;align-items:center;justify-content:center}
.zt-tl i svg{width:14px;height:14px;fill:none;stroke:#b6bac1;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.zt-tl li.on:before{background:var(--blue)}
.zt-tl li.on i{background:var(--blue);border-color:var(--blue)}
.zt-tl li.on i svg{stroke:#fff}
.zt-tl li.now i{box-shadow:0 0 0 5px rgba(44,92,197,.15)}
.zt-tl b{display:block;font-size:15px;font-weight:600;color:#a4a7ad;line-height:1.3}
.zt-tl li.on b{color:var(--ink)}
.zt-tl small{display:block;font-size:13px;color:var(--mut);margin-top:4px;line-height:1.55}

.zt-note{border-radius:10px;padding:13px 15px;font-size:13.5px;margin:24px 0 0;line-height:1.6;color:var(--ink)}
.zt-warn{background:#fff6e6;border-left:2px solid #b98900}
.zt-bad{background:#fdeeec;border-left:2px solid #c4262e}
.zt-good{background:#eaf4ff;border-left:2px solid var(--blue)}
.zt-meta{display:flex;gap:30px;flex-wrap:wrap;margin-top:26px}
.zt-meta div p{margin:0}
.zt-meta .k{font-size:10.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.11em;font-weight:700;margin-bottom:4px}
.zt-meta .v{font-size:14.5px;font-weight:600}

/* the courier's own scans, newest at the top, each with its own mark */
.zt-jt{font-size:10.5px;font-weight:700;color:var(--dim);letter-spacing:.11em;text-transform:uppercase;margin:0 0 18px}
.zt-hist{list-style:none;margin:0;padding:0}
.zt-hist li{position:relative;padding:1px 0 22px 46px;min-height:26px}
.zt-hist li:last-child{padding-bottom:0}
.zt-hist li:before{content:"";position:absolute;left:12px;top:29px;bottom:-6px;width:2px;background:#e4e6ea}
.zt-hist li:last-child:before{display:none}
.zt-hist i{position:absolute;left:0;top:0;width:26px;height:26px;border-radius:50%;background:#f4f6f9;border:1.5px solid #e2e4e8;box-sizing:border-box;display:flex;align-items:center;justify-content:center}
.zt-hist i svg{width:13px;height:13px;fill:none;stroke:#8a8d94;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.zt-hist li:first-child i{background:var(--blue);border-color:var(--blue);box-shadow:0 0 0 5px rgba(44,92,197,.13)}
.zt-hist li:first-child i svg{stroke:#fff}
.zt-hist .d{font-size:14.5px;font-weight:600;line-height:1.35}
.zt-hist .l{font-size:13px;color:var(--mut);margin-top:3px}
.zt-hist .t{font-size:12px;color:var(--dim);margin-top:4px}

/* ---- you may also like ---- */
.zt-recs{border-top:1px solid var(--bd);margin-top:34px;padding-top:26px}
.zt-recs h2{font-size:18px;font-weight:700;letter-spacing:-.01em;margin:0 0 18px}
.zt-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.zt-p{display:block;text-decoration:none;color:inherit}
.zt-p .im{aspect-ratio:1/1;border-radius:10px;overflow:hidden;background:#f2f4f7;margin-bottom:10px}
.zt-p .im img{width:100%;height:100%;object-fit:cover;display:block}
.zt-p .nm{font-size:13px;line-height:1.35;color:var(--mut);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.zt-p .pr{font-size:13.5px;font-weight:700;margin-top:5px}
.zt-p .pr s{font-weight:500;color:var(--dim);margin-left:6px;font-size:12px}

.zt-help{text-align:center;color:var(--mut);font-size:13.5px;margin-top:30px}
.zt-help a{color:var(--blue);font-weight:600;text-decoration:none;border-bottom:1px solid rgba(44,92,197,.35)}

@media (max-width:600px){
.zt-status{font-size:21px}
.zt-ord{text-align:left}
.zt-grid{grid-template-columns:repeat(2,1fr)}
.zt-ghint{display:none}
.zt-meta{gap:22px}
}
</style>
`;

/* ---------------------------------------------------------------- */
/*  the form                                                         */
/* ---------------------------------------------------------------- */

/**
 * Two ways in, side by side. The order number needs the last four digits
 * of the phone with it; a tracking number is long enough to stand alone.
 */
function tabs(order: string, pin: string, num: string, err: string): string {
  const onNum = Boolean(num) && !order;
  const js =
    '(function(){var t=document.querySelectorAll(".zt-tab");' +
    'for(var i=0;i<t.length;i++)t[i].addEventListener("click",function(){' +
    'var k=this.getAttribute("data-k");' +
    'var a=document.querySelectorAll(".zt-tab");' +
    'for(var j=0;j<a.length;j++)a[j].setAttribute("aria-selected",a[j].getAttribute("data-k")===k?"true":"false");' +
    'document.getElementById("ztPo").hidden=(k!=="o");' +
    'document.getElementById("ztPn").hidden=(k!=="n");' +
    '})})();';

  return `
  ${err ? `<div class="zt-note zt-bad" style="margin:22px 0 0">${esc(err)}</div>` : ""}
  <div class="zt-tabs" role="tablist">
    <button type="button" class="zt-tab" data-k="o" role="tab" aria-selected="${onNum ? "false" : "true"}">Order Number</button>
    <button type="button" class="zt-tab" data-k="n" role="tab" aria-selected="${onNum ? "true" : "false"}">Tracking Number</button>
  </div>

  <div class="zt-pane" id="ztPo"${onNum ? " hidden" : ""}>
    <form method="get" action="/apps/track">
      <div class="zt-f">
        <label class="zt-lab" for="zt-o">Order number</label>
        <input class="zt-in" id="zt-o" name="order" value="${esc(order)}" placeholder="e.g. Z1001" autocomplete="off" required>
      </div>
      <div class="zt-f">
        <label class="zt-lab" for="zt-p">Phone - last 4 digits</label>
        <input class="zt-in" id="zt-p" name="pin" value="${esc(pin)}" placeholder="e.g. 8695" inputmode="numeric" maxlength="4" autocomplete="off" required>
      </div>
      <button class="zt-btn" type="submit">Track Order</button>
    </form>
  </div>

  <div class="zt-pane" id="ztPn"${onNum ? "" : " hidden"}>
    <form method="get" action="/apps/track">
      <div class="zt-f">
        <label class="zt-lab" for="zt-n">Tracking number</label>
        <input class="zt-in" id="zt-n" name="n" value="${esc(num)}" placeholder="the number your courier gave" autocomplete="off" required>
      </div>
      <button class="zt-btn" type="submit">Track Order</button>
    </form>
  </div>
  <script>${js}</script>`;
}

/**
 * Four products, straight from the store. This works because the response
 * is served as Liquid - Shopify renders these tags before the page ever
 * reaches the browser, so there is no extra request from the customer's
 * phone.
 */
function recs(): string {
  return `
  <div class="zt-recs">
    {%- assign zrc = collections['best-sellers'] -%}
    {%- if zrc.products_count == 0 -%}{%- assign zrc = collections.all -%}{%- endif -%}
    {%- if zrc.products_count > 0 -%}
    <h2>You may also like</h2>
    <div class="zt-grid">
      {%- for zp in zrc.products limit: 4 -%}
        <a class="zt-p" href="{{ zp.url }}">
          <div class="im">{%- if zp.featured_image -%}<img src="{{ zp.featured_image | image_url: width: 400 }}" alt="{{ zp.title | escape }}" loading="lazy" width="400" height="400">{%- endif -%}</div>
          <div class="nm">{{ zp.title }}</div>
          <div class="pr">{{ zp.price | money_without_trailing_zeros }}{%- if zp.compare_at_price > zp.price -%}<s>{{ zp.compare_at_price | money_without_trailing_zeros }}</s>{%- endif -%}</div>
        </a>
      {%- endfor -%}
    </div>
    {%- endif -%}
  </div>`;
}

function shell(inner: string) {
  return `${CSS}<div class="zt-wrap">${inner}</div>`;
}

/** Globe, then the form, then whatever came back, then the products. */
function page(o: {
  lat: number; lon: number; name: string; live?: boolean;
  order?: string; pin?: string; num?: string; err?: string; result?: string;
}) {
  return shell(
    globeBlock(o.lat, o.lon, o.name, Boolean(o.live)) +
    tabs(o.order ?? "", o.pin ?? "", o.num ?? "", o.err ?? "") +
    (o.result ?? "") +
    recs() +
    `<p class="zt-help">Something not right? <a href="/pages/contact">Tell us</a> - we will speak to the courier ourselves.</p>`,
  );
}

/* ---------------------------------------------------------------- */
/*  the page                                                         */
/* ---------------------------------------------------------------- */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // The signature is checked right here. If it is wrong, this throws a
  // 401 by itself and nothing below ever runs.
  await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const blank = { lat: INDIA[0], lon: INDIA[1], name: "" };

  const domain = shopFromProxy(url);
  if (!domain) {
    return liquid(page({ ...blank, err: "Something went wrong. Please open the page again." }));
  }

  const shop = await db.shop.findUnique({ where: { domain } });
  if (!shop) return liquid(page(blank));

  const num = (url.searchParams.get("n") ?? "").trim();
  const orderQ = (url.searchParams.get("order") ?? "").trim();
  const pin = (url.searchParams.get("pin") ?? "").trim();

  if (!num && !orderQ) return liquid(page(blank));

  /* ---------------- look it up ---------------- */
  let rec: any = null;

  if (num) {
    const sh = await db.shipment.findFirst({
      where: { trackingNo: num, order: { shopId: shop.id } },
      orderBy: { createdAt: "desc" },
      include: { order: { include: { shipments: { orderBy: { createdAt: "desc" } } } } },
    });
    rec = sh?.order ?? null;
  } else {
    // Z1005, z1005, #1005, 1005 - all of these should work.
    const bare = orderQ.replace(/^[#Zz]+/, "");
    const cands = await db.orderRecord.findMany({
      where: {
        shopId: shop.id,
        OR: [
          { orderNumber: orderQ },
          { orderNumber: orderQ.toUpperCase() },
          { orderNumber: `Z${bare}` },
          { orderNumber: `#${bare}` },
          { orderNumber: bare },
        ],
      },
      include: { shipments: { orderBy: { createdAt: "desc" } } },
      take: 5,
    });

    // A second proof. Without it, anyone could type Z1006 after Z1005
    // and see someone else's address.
    const four = pin.replace(/\D/g, "").slice(-4);
    rec = cands.find((c: any) => {
      const ph = (c.phone ?? "").replace(/\D/g, "");
      return four.length === 4 && ph.endsWith(four);
    }) ?? null;

    if (!rec && cands.length > 0) {
      return liquid(page({
        ...blank, order: orderQ, pin,
        err: "Those last 4 digits do not match the phone number on this order.",
      }));
    }
  }

  if (!rec) {
    return liquid(page({
      ...blank, order: orderQ, pin, num,
      err: "Nothing matched that. Please check the number and try again.",
    }));
  }

  /* ---------------- show it ---------------- */
  const ship = (rec.shipments ?? [])[0] ?? null;
  const st = ship?.status ?? "pending";
  const step = STEP_OF[st] ?? 0;
  const label = ship ? STATUS_LABEL[st] ?? "In progress" : "Order confirmed";

  let scans: any[] = [];
  try {
    scans = ship?.scans ? JSON.parse(ship.scans) : [];
  } catch {
    scans = [];
  }

  const spot = whereIs(rec, scans);

  // one stage under the next, so the eye runs down the page
  const spine = STEPS.map((s, i) => {
    const cls = i < step ? "on" : i === step ? "on now" : "";
    const under =
      i === step && ship?.lastEventAt
        ? `<small>${esc(`${ship.lastEventDesc || "Updated"} · ${fmt(ship.lastEventAt)}`)}</small>`
        : "";
    return `<li class="${cls}"><i>${ICONS[i]}</i><b>${esc(s)}</b>${under}</li>`;
  }).join("");

  let note = "";
  if (st === "delivered") {
    note = `<div class="zt-note zt-good">This order has been delivered. If it has not reached you, tell us right away and we will look into it.</div>`;
  } else if (st === "exception") {
    note = `<div class="zt-note zt-warn">The courier could not complete the delivery. They will try again. If the address or number needs to change, tell us now.</div>`;
  } else if (st === "returned") {
    note = `<div class="zt-note zt-bad">The parcel is on its way back to us. We can send it out again if you want - just message us.</div>`;
  } else if (st === "out_for_delivery") {
    note = `<div class="zt-note zt-good">It should reach you today. ${cashDue(rec) ? `Keep ${money(cashDue(rec), rec.currency)} ready.` : "Payment is done, nothing to pay on delivery."}</div>`;
  }

  const meta = [
    ship?.carrier ? { k: "Courier", v: ship.carrier } : null,
    ship?.trackingNo ? { k: "Tracking number", v: ship.trackingNo } : null,
    cashDue(rec)
      ? { k: "Payment", v: `Cash on delivery - ${money(cashDue(rec), rec.currency)}` }
      : { k: "Payment", v: "Prepaid" },
    rec.city ? { k: "Delivering to", v: rec.city } : null,
  ]
    .filter(Boolean)
    .map((m: any) => `<div><p class="k">${esc(m.k)}</p><p class="v">${esc(m.v)}</p></div>`)
    .join("");

  const hist = scans.length
    ? `<div class="zt-sec">
        <p class="zt-jt">Journey</p>
        <ul class="zt-hist">${scans
          .map(
            (e: any) => `<li><i>${markFor(e.desc)}</i>
              <div class="d">${esc(e.desc || "Update")}</div>
              ${e.location ? `<div class="l">${esc(e.location)}</div>` : ""}
              <div class="t">${esc(fmt(e.time))}</div>
            </li>`,
          )
          .join("")}</ul>
      </div>`
    : "";

  const result = `
  <div class="zt-sec">
    <div class="zt-hero">
      <div>
        <p class="zt-lab" style="margin-bottom:2px">Status</p>
        <p class="zt-status">${esc(label)}</p>
        <p class="zt-when">${
          ship?.lastEventAt
            ? esc(`${ship.lastEventDesc || "Updated"} · ${fmt(ship.lastEventAt)}`)
            : "We are getting your parcel ready"
        }</p>
      </div>
      <div class="zt-ord">
        <b>${esc(rec.orderNumber)}</b>
        <span>${esc(rec.itemLine || "")}</span>
      </div>
    </div>

    <ul class="zt-tl">${spine}</ul>
    ${note}
    ${meta ? `<div class="zt-meta">${meta}</div>` : ""}
  </div>
  ${hist}`;

  return liquid(page({
    lat: spot.lat, lon: spot.lon, name: spot.name, live: spot.live,
    order: orderQ, pin, num, result,
  }));
};
