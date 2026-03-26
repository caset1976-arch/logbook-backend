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
  Queste NON sono la API key logbook.
*/
const QRZ_USER = "IL_TUO_USERNAME_QRZ";
const QRZ_PASS = "LA_TUA_PASSWORD_QRZ";

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
  // sessione riusata per 30 minuti circa
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

  // se la sessione è scaduta, rifai login una volta
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

  return {
    callsign: xmlValue(text, "call") || callsign.toUpperCase(),
    name: xmlValue(text, "fname"),
    surname: xmlValue(text, "name"),
    qth: xmlValue(text, "addr2"),
    country: xmlValue(text, "country"),
    grid: xmlValue(text, "grid")
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
