import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json());

const APP_USER = "admin";
const APP_PASS = "1234";
const APP_TOKEN = "token123";

let qsos = [];

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (token !== APP_TOKEN) {
    return res.status(401).json({ error: "Non autorizzato" });
  }
  next();
}

app.get("/", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/auth/login", (req, res) => {
  const { username, password, station_callsign } = req.body || {};

  if (username !== APP_USER || password !== APP_PASS) {
    return res.status(401).json({ error: "Credenziali non valide" });
  }

  res.json({
    token: APP_TOKEN,
    user: {
      username,
      station_callsign: station_callsign || "IN3JIE"
    }
  });
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
  res.json(qsos);
});

app.post("/api/qsos", auth, (req, res) => {
  const qso = {
    id: Date.now().toString(),
    call: (req.body.call || "").toUpperCase(),
    qso_date: req.body.qso_date || "",
    time_on: req.body.time_on || "",
    band: req.body.band || "",
    mode: req.body.mode || "",
    station_callsign: req.body.station_callsign || "IN3JIE",
    qrz_status: "local"
  };

  qsos.unshift(qso);
  res.json(qso);
});

app.listen(3000, () => {
  console.log("Server attivo su porta 3000");
});
