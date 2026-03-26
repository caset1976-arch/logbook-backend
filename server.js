import express from "express";
import cors from "cors";
import Database from "better-sqlite3";

const app = express();
app.use(cors());
app.use(express.json());

const db = new Database("./logbook.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS qsos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call TEXT,
    station_callsign TEXT,
    qso_date TEXT,
    time_on TEXT,
    band TEXT,
    freq TEXT,
    mode TEXT,
    rst_sent TEXT,
    rst_rcvd TEXT,
    name TEXT,
    qth TEXT,
    country TEXT,
    grid TEXT,
    comment TEXT,
    qrz_status TEXT DEFAULT 'local',
    created_at TEXT
  )
`);

const USER = "admin";
const PASS = "1234";
const TOKEN = "token123";

/*
  METTI QUI LE TUE CREDENZIALI QRZ XML
  NON è la logbook API key.
*/
const QRZ_USER = "in3jie";
const QRZ_PASS = "Tremalzo1976";

/*
  METTI QUI LA TUA POSIZIONE STAZIONE
  Se vuoi, dopo possiamo usare il tuo grid locator invece di lat/lon.
*/
const MY_LAT = 45.83;
const MY_LON = 10.69;

let qrzSessionKey = "";
let qrzSessionTime = 0;

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const t = h.replace("Bearer ", "");
  if (t !== TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
}

function xmlValue(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1].trim() : "";
}

function toRad(d) {
  return d * Math.PI / 180;
}

function toDeg(r) {
  return r * 180 / Math.PI;
}

function calcBearing(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

  let θ = toDeg(Math.atan2(y, x));
  return (θ + 360) % 360;
}

function calcDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function qrzLogin() {
  const url =
    `https://xmldata.qrz.com/xml/current/?username=${encodeURIComponent(QRZ_USER)}` +
    `&password=${encodeURIComponent(QRZ_PASS)}`;

  const r = await fetch(url);
  const text = await r.text();

  const key = xmlValue(text, "Key");
  const error = xmlValue(text, "Error");

  if (!key) {
    throw new Error(error || "QRZ login failed");
  }

  qrzSessionKey = key;
  qrzSessionTime = Date.now();
  return key;
}

async function ensureQrzSession() {
  if (qrzSessionKey && Date.now() - qrzSessionTime < 30 * 60 * 1000) {
    return qrzSessionKey;
  }
  return await qrzLogin();
}

async function qrzLookupCallsign(callsign) {
  let session = await ensureQrzSession();

  let url =
    `https://xmldata.qrz.com/xml/current/?s=${encodeURIComponent(session)}` +
    `&callsign=${encodeURIComponent(callsign)}`;

  let r = await fetch(url);
  let text = await r.text();

  let error = xmlValue(text, "Error");

  if (error && /session/i.test(error)) {
    session = await qrzLogin();
    url =
      `https://xmldata.qrz.com/xml/current/?s=${encodeURIComponent(session)}` +
      `&callsign=${encodeURIComponent(callsign)}`;
    r = await fetch(url);
    text = await r.text();
    error = xmlValue(text, "Error");
  }

  if (error) {
    throw new Error(error);
  }

  const lat = parseFloat(xmlValue(text, "lat"));
  const lon = parseFloat(xmlValue(text, "lon"));

  let bearing = null;
  let distance_km = null;
  let long_path = null;

  if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
    bearing = Math.round(calcBearing(MY_LAT, MY_LON, lat, lon));
    long_path = (bearing + 180) % 360;
    distance_km = Math.round(calcDistanceKm(MY_LAT, MY_LON, lat, lon));
  }

  return {
    callsign: xmlValue(text, "call") || callsign.toUpperCase(),
    name: xmlValue(text, "fname"),
    surname: xmlValue(text, "name"),
    qth: xmlValue(text, "addr2"),
    country: xmlValue(text, "country"),
    grid: xmlValue(text, "grid"),
    lat: Number.isNaN(lat) ? null : lat,
    lon: Number.isNaN(lon) ? null : lon,
    bearing,
    long_path,
    distance_km
  };
}

app.get("/", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username !== USER || password !== PASS) {
    return res.status(401).json({ error: "bad login" });
  }
  res.json({ token: TOKEN });
});

app.post("/api/lookup", auth, async (req, res) => {
  try {
    const { callsign } = req.body || {};

    if (!callsign) {
      return res.status(400).json({ error: "callsign mancante" });
    }

    const data = await qrzLookupCallsign(callsign);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message || "lookup failed" });
  }
});

app.get("/api/qsos", auth, (req, res) => {
  const rows = db.prepare("SELECT * FROM qsos ORDER BY id DESC").all();
  res.json(rows);
});

app.post("/api/qsos", auth, (req, res) => {
  const q = req.body || {};

  const stmt = db.prepare(`
    INSERT INTO qsos (
      call, station_callsign, qso_date, time_on,
      band, freq, mode, rst_sent, rst_rcvd,
      name, qth, country, grid, comment, qrz_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const info = stmt.run(
    q.call || "",
    q.station_callsign || "",
    q.qso_date || "",
    q.time_on || "",
    q.band || "",
    q.freq || "",
    q.mode || "",
    q.rst_sent || "",
    q.rst_rcvd || "",
    q.name || "",
    q.qth || "",
    q.country || "",
    q.grid || "",
    q.comment || "",
    q.qrz_status || "local",
    new Date().toISOString()
  );

  res.json({ id: info.lastInsertRowid });
});

app.delete("/api/qsos/:id", auth, (req, res) => {
  const id = req.params.id;

  const stmt = db.prepare("DELETE FROM qsos WHERE id = ?");
  const info = stmt.run(id);

  if (info.changes === 0) {
    return res.status(404).json({ error: "QSO non trovato" });
  }

  res.json({ ok: true, deleted: id });
});

app.listen(3000, () => {
  console.log("LOGBOOK BACKEND READY");
});
