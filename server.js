const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "1234";

const QRZ_USER = process.env.QRZ_USER || "IN3JIE";
const QRZ_PASSWORD = process.env.QRZ_PASSWORD || "Tremalzo1976";
const QRZ_LOGBOOK_API_KEY = process.env.QRZ_LOGBOOK_API_KEY || "11B1-E407-55B1-866C";
const MY_GRID = process.env.MY_GRID || "JN55";

const fetchFn = (...args) => {
  if (typeof fetch === "function") return fetch(...args);
  return import("node-fetch").then(({ default: fetch }) => fetch(...args));
};

const DATABASE_URL = process.env.DATABASE_URL || "";
if (!DATABASE_URL) {
  console.error("DATABASE_URL mancante");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false
});

pool.on("error", (err) => {
  console.error("Postgres pool error:", err);
});

app.use(cors());
app.use(express.json({ limit: "10mb" }));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS qsos (
      id SERIAL PRIMARY KEY,
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
      qrz_status TEXT DEFAULT 'local'
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_qsos_order ON qsos(qso_date DESC, time_on DESC, id DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_qsos_call ON qsos(call)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_qsos_band ON qsos(band)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_qsos_status ON qsos(qrz_status)`);
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token mancante" });
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Token non valido" });
  }
}

function U(v) {
  return String(v || "").trim().toUpperCase();
}

function xmlTag(xml, tag) {
  const m = String(xml || "").match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1] : "";
}

function buildWhere({ search, status, band, call, excludeId }) {
  const where = [];
  const params = [];
  let i = 1;

  if (search) {
    const q = `%${U(search)}%`;
    where.push(`(
      UPPER(COALESCE(call,'')) LIKE $${i}
      OR UPPER(COALESCE(name,'')) LIKE $${i + 1}
      OR UPPER(COALESCE(qth,'')) LIKE $${i + 2}
      OR UPPER(COALESCE(country,'')) LIKE $${i + 3}
      OR UPPER(COALESCE(grid,'')) LIKE $${i + 4}
      OR UPPER(COALESCE(comment,'')) LIKE $${i + 5}
    )`);
    params.push(q, q, q, q, q, q);
    i += 6;
  }

  if (status) {
    where.push(`COALESCE(qrz_status,'local') = $${i}`);
    params.push(String(status).trim());
    i += 1;
  }

  if (band) {
    where.push(`COALESCE(band,'') = $${i}`);
    params.push(String(band).trim());
    i += 1;
  }

  if (call) {
    where.push(`UPPER(COALESCE(call,'')) = $${i}`);
    params.push(U(call));
    i += 1;
  }

  if (excludeId) {
    where.push(`id <> $${i}`);
    params.push(Number(excludeId));
    i += 1;
  }

  return {
    clause: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params,
    nextIndex: i
  };
}

function adifField(name, value) {
  const v = String(value || "");
  if (!v) return "";
  return `<${name}:${v.length}>${v}`;
}

function qsoToAdif(q) {
  return (
    adifField("CALL", q.call) +
    adifField("STATION_CALLSIGN", q.station_callsign || "IN3JIE") +
    adifField("QSO_DATE", q.qso_date) +
    adifField("TIME_ON", q.time_on) +
    adifField("BAND", q.band) +
    adifField("FREQ", q.freq) +
    adifField("MODE", q.mode) +
    adifField("RST_SENT", q.rst_sent) +
    adifField("RST_RCVD", q.rst_rcvd) +
    adifField("NAME", q.name) +
    adifField("QTH", q.qth) +
    adifField("COUNTRY", q.country) +
    adifField("GRIDSQUARE", q.grid) +
    adifField("COMMENT", q.comment) +
    "<EOR>"
  );
}

function parseAdif(adifText) {
  const records = [];
  const chunks = String(adifText || "").split(/<eor>/i);

  for (const chunk of chunks) {
    const rec = {};
    const regex = /<([^:>]+):(\d+)(?::[^>]+)?>/gi;
    let match;

    while ((match = regex.exec(chunk)) !== null) {
      const field = match[1].toLowerCase();
      const len = parseInt(match[2], 10);
      const start = regex.lastIndex;
      const value = chunk.substring(start, start + len);
      rec[field] = value;
      regex.lastIndex = start + len;
    }

    if (Object.keys(rec).length) records.push(rec);
  }

  return records;
}

function deg2rad(d) {
  return d * Math.PI / 180;
}

function rad2deg(r) {
  return r * 180 / Math.PI;
}

function normalizeBearing(deg) {
  return (deg % 360 + 360) % 360;
}

function maidenheadToLatLon(grid) {
  const g = String(grid || "").trim().toUpperCase();
  if (g.length < 4) return null;

  const A = "A".charCodeAt(0);
  const lonField = g.charCodeAt(0) - A;
  const latField = g.charCodeAt(1) - A;
  const lonSquare = parseInt(g[2], 10);
  const latSquare = parseInt(g[3], 10);

  if ([lonField, latField, lonSquare, latSquare].some(v => Number.isNaN(v))) return null;

  let lon = lonField * 20 - 180 + lonSquare * 2;
  let lat = latField * 10 - 90 + latSquare;

  if (g.length >= 6) {
    const lonSub = g.charCodeAt(4) - A;
    const latSub = g.charCodeAt(5) - A;
    if (!Number.isNaN(lonSub) && !Number.isNaN(latSub)) {
      lon += lonSub * (2 / 24);
      lat += latSub * (1 / 24);
      lon += (2 / 24) / 2;
      lat += (1 / 24) / 2;
      return { lat, lon };
    }
  }

  lon += 1;
  lat += 0.5;
  return { lat, lon };
}

function calcDistanceAndBearing(from, to) {
  const R = 6371;
  const lat1 = deg2rad(from.lat);
  const lon1 = deg2rad(from.lon);
  const lat2 = deg2rad(to.lat);
  const lon2 = deg2rad(to.lon);

  const dLat = lat2 - lat1;
  const dLon = lon2 - lon1;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance_km = R * c;

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

  const bearing = normalizeBearing(rad2deg(Math.atan2(y, x)));
  const long_path = normalizeBearing(bearing + 180);

  return {
    distance_km: Math.round(distance_km),
    bearing: Math.round(bearing),
    long_path: Math.round(long_path)
  };
}

let qrzSessionKey = "";

async function qrzXmlLogin() {
  const url =
    `https://xmldata.qrz.com/xml/current/?username=${encodeURIComponent(QRZ_USER)}` +
    `;password=${encodeURIComponent(QRZ_PASSWORD)}` +
    `;agent=${encodeURIComponent("IN3JIE-Logbook/1.0")}`;

  const r = await fetchFn(url);
  const text = await r.text();

  const key = xmlTag(text, "Key");
  const error = xmlTag(text, "Error");

  if (!key) throw new Error(error || "QRZ login fallito");

  qrzSessionKey = key;
  return key;
}

async function qrzXmlLookup(callsign) {
  if (!qrzSessionKey) await qrzXmlLogin();

  let url =
    `https://xmldata.qrz.com/xml/current/?s=${encodeURIComponent(qrzSessionKey)}` +
    `;callsign=${encodeURIComponent(callsign)}`;

  let r = await fetchFn(url);
  let text = await r.text();

  const error1 = xmlTag(text, "Error");
  if (!xmlTag(text, "call") && /session|password|authorization|timeout|invalid/i.test(error1 || "")) {
    await qrzXmlLogin();
    url =
      `https://xmldata.qrz.com/xml/current/?s=${encodeURIComponent(qrzSessionKey)}` +
      `;callsign=${encodeURIComponent(callsign)}`;
    r = await fetchFn(url);
    text = await r.text();
  }

  const error = xmlTag(text, "Error");
  if (error && !xmlTag(text, "call")) throw new Error(error);

  return {
    callsign: xmlTag(text, "call") || callsign,
    name: xmlTag(text, "fname"),
    surname: xmlTag(text, "name"),
    qth: xmlTag(text, "addr2"),
    country: xmlTag(text, "country"),
    grid: xmlTag(text, "grid")
  };
}

async function syncOneQsoToQrz(q) {
  if (!QRZ_LOGBOOK_API_KEY) {
    return { ok: false, reason: "QRZ_LOGBOOK_API_KEY mancante" };
  }

  const body = new URLSearchParams({
    KEY: QRZ_LOGBOOK_API_KEY,
    ACTION: "INSERT",
    ADIF: qsoToAdif(q)
  });

  const r = await fetchFn("https://logbook.qrz.com/api", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "IN3JIE-Logbook/1.0 (IN3JIE)"
    },
    body: body.toString()
  });

  const text = await r.text();
  const ok = /(?:^|&)RESULT=(OK|REPLACE)(?:&|$)/i.test(text);

  if (ok) return { ok: true, raw: text };
  return { ok: false, raw: text };
}

app.post("/api/auth/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    if (username !== ADMIN_USER) {
      return res.status(401).json({ error: "Credenziali non valide" });
    }

    let ok = false;
    if (ADMIN_PASS.startsWith("$2a$") || ADMIN_PASS.startsWith("$2b$") || ADMIN_PASS.startsWith("$2y$")) {
      ok = await bcrypt.compare(password, ADMIN_PASS);
    } else {
      ok = password === ADMIN_PASS;
    }

    if (!ok) return res.status(401).json({ error: "Credenziali non valide" });

    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore login" });
  }
});

app.post("/api/lookup", authMiddleware, async (req, res) => {
  try {
    const callsign = U(req.body.callsign);
    if (!callsign) {
      return res.status(400).json({ error: "Callsign mancante" });
    }

    const info = await qrzXmlLookup(callsign);

    let bearing = null;
    let long_path = null;
    let distance_km = null;

    const myPos = maidenheadToLatLon(MY_GRID);
    const hisPos = maidenheadToLatLon(info.grid);

    if (myPos && hisPos) {
      const geo = calcDistanceAndBearing(myPos, hisPos);
      bearing = geo.bearing;
      long_path = geo.long_path;
      distance_km = geo.distance_km;
    }

    res.json({
      callsign: info.callsign || callsign,
      name: info.name || "",
      surname: info.surname || "",
      qth: info.qth || "",
      country: info.country || "",
      grid: info.grid || "",
      bearing,
      long_path,
      distance_km
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Errore lookup QRZ" });
  }
});

app.post("/api/qsos", authMiddleware, async (req, res) => {
  try {
    const q = req.body || {};

    const result = await pool.query(
      `
      INSERT INTO qsos (
        call, station_callsign, qso_date, time_on, band, freq, mode,
        rst_sent, rst_rcvd, name, qth, country, grid, comment, qrz_status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING id
      `,
      [
        U(q.call),
        q.station_callsign || "IN3JIE",
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
        "local"
      ]
    );

    res.json({ ok: true, id: result.rows[0].id, qrz_status: "local" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore salvataggio qso" });
  }
});

app.get("/api/qsos", authMiddleware, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "50", 10), 1), 200);
    const offset = (page - 1) * limit;

    const where = buildWhere({
      search: req.query.search || "",
      status: req.query.status || "",
      band: req.query.band || ""
    });

    const countRow = await pool.query(
      `SELECT COUNT(*) AS total FROM qsos ${where.clause}`,
      where.params
    );

    const rows = await pool.query(
      `
      SELECT
        id, call, station_callsign, qso_date, time_on, band, freq, mode,
        rst_sent, rst_rcvd, name, qth, country, grid, comment, qrz_status
      FROM qsos
      ${where.clause}
      ORDER BY qso_date DESC, time_on DESC, id DESC
      LIMIT $${where.nextIndex} OFFSET $${where.nextIndex + 1}
      `,
      [...where.params, limit, offset]
    );

    const total = Number(countRow.rows[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / limit));

    res.json({
      page,
      limit,
      total,
      totalPages,
      rows: rows.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore caricamento qsos" });
  }
});

app.get("/api/qsos/check-duplicate", authMiddleware, async (req, res) => {
  try {
    const call = U(req.query.call);
    const excludeId = req.query.excludeId ? Number(req.query.excludeId) : null;

    if (!call) return res.json({ count: 0, matches: [] });

    const where = buildWhere({ call, excludeId });

    const countRow = await pool.query(
      `SELECT COUNT(*) AS total FROM qsos ${where.clause}`,
      where.params
    );

    const rows = await pool.query(
      `
      SELECT id, call, qso_date, time_on, band, mode, grid
      FROM qsos
      ${where.clause}
      ORDER BY qso_date DESC, time_on DESC, id DESC
      LIMIT 8
      `,
      where.params
    );

    res.json({
      count: Number(countRow.rows[0]?.total || 0),
      matches: rows.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore controllo duplicati" });
  }
});

app.delete("/api/qsos/:id", authMiddleware, async (req, res) => {
  try {
    await pool.query(`DELETE FROM qsos WHERE id = $1`, [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore eliminazione qso" });
  }
});

app.post("/api/adif/import", authMiddleware, async (req, res) => {
  try {
    const adif = String(req.body.adif || "");
    const source = String(req.body.source || "other").toLowerCase();
    const importedStatus = source === "qrz" ? "synced" : "local";

    const records = parseAdif(adif);

    let imported = 0;
    let duplicates = 0;
    const total_read = records.length;

    for (const r of records) {
      const call = U(r.call);
      const qso_date = r.qso_date || "";
      const time_on = r.time_on || "";
      const band = r.band || "";
      const mode = r.mode || "";

      if (!call) continue;

      const exists = await pool.query(
        `
        SELECT id FROM qsos
        WHERE UPPER(COALESCE(call,'')) = $1
          AND COALESCE(qso_date,'') = $2
          AND COALESCE(time_on,'') = $3
          AND COALESCE(band,'') = $4
          AND COALESCE(mode,'') = $5
        LIMIT 1
        `,
        [call, qso_date, time_on, band, mode]
      );

      if (exists.rows.length) {
        duplicates++;
        continue;
      }

      await pool.query(
        `
        INSERT INTO qsos (
          call, station_callsign, qso_date, time_on, band, freq, mode,
          rst_sent, rst_rcvd, name, qth, country, grid, comment, qrz_status
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        `,
        [
          call,
          r.station_callsign || "IN3JIE",
          qso_date,
          time_on,
          band,
          r.freq || "",
          mode,
          r.rst_sent || "",
          r.rst_rcvd || "",
          r.name || "",
          r.qth || "",
          r.country || "",
          r.gridsquare || r.grid || "",
          r.comment || "",
          importedStatus
        ]
      );

      imported++;
    }

    res.json({ imported, duplicates, total_read });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore import ADIF" });
  }
});

app.get("/api/adif/export", authMiddleware, async (req, res) => {
  try {
    const rows = await pool.query(
      `
      SELECT
        call, station_callsign, qso_date, time_on, band, freq, mode,
        rst_sent, rst_rcvd, name, qth, country, grid, comment
      FROM qsos
      ORDER BY qso_date DESC, time_on DESC, id DESC
      `
    );

    let out = "IN3JIE LOGBOOK EXPORT\n<EOH>\n";

    for (const q of rows.rows) {
      out +=
        adifField("CALL", q.call) +
        adifField("STATION_CALLSIGN", q.station_callsign) +
        adifField("QSO_DATE", q.qso_date) +
        adifField("TIME_ON", q.time_on) +
        adifField("BAND", q.band) +
        adifField("FREQ", q.freq) +
        adifField("MODE", q.mode) +
        adifField("RST_SENT", q.rst_sent) +
        adifField("RST_RCVD", q.rst_rcvd) +
        adifField("NAME", q.name) +
        adifField("QTH", q.qth) +
        adifField("COUNTRY", q.country) +
        adifField("GRIDSQUARE", q.grid) +
        adifField("COMMENT", q.comment) +
        "<EOR>\n";
    }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="logbook.adi"');
    res.send(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore export ADIF" });
  }
});

app.post("/api/qrz/sync", authMiddleware, async (req, res) => {
  try {
    if (!QRZ_LOGBOOK_API_KEY) {
      return res.status(400).json({ error: "QRZ_LOGBOOK_API_KEY mancante" });
    }

    const rows = await pool.query(`
      SELECT
        id, call, station_callsign, qso_date, time_on, band, freq, mode,
        rst_sent, rst_rcvd, name, qth, country, grid, comment, qrz_status
      FROM qsos
      WHERE COALESCE(qrz_status,'local') <> 'synced'
      ORDER BY qso_date ASC, time_on ASC, id ASC
    `);

    let synced = 0;
    let errors = 0;

    for (const q of rows.rows) {
      try {
        const syncRes = await syncOneQsoToQrz(q);

        if (syncRes.ok) {
          await pool.query(`UPDATE qsos SET qrz_status = 'synced' WHERE id = $1`, [q.id]);
          synced++;
        } else {
          await pool.query(`UPDATE qsos SET qrz_status = 'error' WHERE id = $1`, [q.id]);
          errors++;
          console.error("QRZ sync fail QSO", q.id, syncRes.raw || syncRes.reason);
        }
      } catch (e) {
        await pool.query(`UPDATE qsos SET qrz_status = 'error' WHERE id = $1`, [q.id]);
        errors++;
        console.error("QRZ sync error QSO", q.id, e);
      }
    }

    res.json({
      total: rows.rows.length,
      synced,
      errors
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore sync QRZ" });
  }
});

app.get("/", (req, res) => {
  res.send("Logbook backend OK");
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server attivo sulla porta ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Errore inizializzazione Postgres:", err);
    process.exit(1);
  });
