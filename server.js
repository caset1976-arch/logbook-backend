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

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const t = h.replace("Bearer ", "");
  if (t !== TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
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

app.post("/api/lookup", auth, (req, res) => {
  const { callsign } = req.body || {};
  res.json({
    callsign: (callsign || "").toUpperCase(),
    name: "Demo",
    surname: "User",
    qth: "Trento",
    country: "Italy",
    grid: "JN56"
  });
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
      name, qth, country, grid, comment, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    new Date().toISOString()
  );

  res.json({ id: info.lastInsertRowid });
});

app.listen(3000, () => {
  console.log("LOGBOOK BACKEND READY");
});
