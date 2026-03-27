// server.js
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const app = express();
const PORT = process.env.PORT || 3000;

// =========================
// CONFIG
// =========================
const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "1234";

// QRZ XML LOOKUP
const QRZ_USER = process.env.QRZ_USER || "IN3JIE";
const QRZ_PASSWORD = process.env.QRZ_PASSWORD || "PASSWORD_QRZ";

// QRZ LOGBOOK API KEY (se la userai dopo per sync reale)
const QRZ_LOGBOOK_API_KEY = process.env.QRZ_LOGBOOK_API_KEY || "";

// fetch compatibile sia con Node recente sia con node-fetch
const fetchFn = (...args) => {
  if (typeof fetch === "function") return fetch(...args);
  return import("node-fetch").then(({ default: fetch }) => fetch(...args));
};

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// =========================
// DATABASE
// =========================
const db = new sqlite3.Database("./logbook.db");

db.serialize(() => {
  db.run(`
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
      qrz_status TEXT DEFAULT 'local'
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_qsos_order ON qsos(qso_date DESC, time_on DESC, id DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_qsos_call ON qsos(call)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_qsos_band ON qsos(band)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_qsos_status ON qsos(qrz_status)`);
});

// =========================
// HELPERS
// =========================
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

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
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

  if (search) {
    const q = `%${U(search)}%`;
    where.push(`(
      UPPER(COALESCE(call,'')) LIKE ?
      OR UPPER(COALESCE(name,'')) LIKE ?
      OR UPPER(COALESCE(qth,'')) LIKE ?
      OR UPPER(COALESCE(country,'')) LIKE ?
      OR UPPER(COALESCE(grid,'')) LIKE ?
      OR UPPER(COALESCE(comment,'')) LIKE ?
    )`);
    params.push(q, q, q, q, q, q);
  }

  if (status) {
    where.push(`COALESCE(qrz_status,'local') = ?`);
    params.push(String(status).trim());
  }

  if (band) {
    where.push(`COALESCE(band,'') = ?`);
    params.push(String(band).trim());
  }

  if (call) {
    where.push(`UPPER(COALESCE(call,'')) = ?`);
    params.push(U(call));
  }

  if (excludeId) {
    where.push(`id <> ?`);
    params.push(Number(excludeId));
  }

  return {
    clause: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params
  };
}

// =========================
// QRZ XML SESSION
// =========================
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

  if (!key) {
    throw new Error(error || "QRZ login fallito");
  }

  qrzSessionKey = key;
  return key;
}

async function qrzXmlLookup(callsign) {
  if (!qrzSessionKey) {
    await qrzXmlLogin();
  }

  let url =
    `https://xmldata.qrz.com/xml/current/?s=${encodeURIComponent(qrzSessionKey)}` +
    `;callsign=${encodeURIComponent(callsign)}`;

  let r = await fetchFn(url);
  let text = await r.text();

  const error1 = xmlTag(text, "Error");
  if (
    !xmlTag(text, "call") &&
    /session|password|authorization|timeout|invalid/i.test(error1 || "")
  ) {
    await qrzXmlLogin();
    url =
      `https://xmldata.qrz.com/xml/current/?s=${encodeURIComponent(qrzSessionKey)}` +
      `;callsign=${encodeURIComponent(callsign)}`;
    r = await fetchFn(url);
    text = await r.text();
  }

  const error = xmlTag(text, "Error");
  if (error && !xmlTag(text, "call")) {
    throw new Error(error);
  }

  return {
    raw: text,
    callsign: xmlTag(text, "call") || callsign,
    name: xmlTag(text, "fname"),
    surname: xmlTag(text, "name"),
    qth: xmlTag(text, "addr2"),
    country: xmlTag(text, "country"),
    grid: xmlTag(text, "grid")
  };
}

// =========================
// AUTH
// =========================
app.post("/api/auth/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    if (username !== ADMIN_USER) {
      return res.status(401).json({ error: "Credenziali non valide" });
    }

    let ok = false;
    if (
      ADMIN_PASS.startsWith("$2a$") ||
      ADMIN_PASS.startsWith("$2b$") ||
      ADMIN_PASS.startsWith("$2y$")
    ) {
      ok = await bcrypt.compare(password, ADMIN_PASS);
    } else {
      ok = password === ADMIN_PASS;
    }

    if (!ok) {
      return res.status(401).json({ error: "Credenziali non valide" });
    }

    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore login" });
  }
});

// =========================
// LOOKUP QRZ
// =========================
app.post("/api/lookup", authMiddleware, async (req, res) => {
  try {
    const callsign = U(req.body.callsign);
    if (!callsign) {
      return res.status(400).json({ error: "Callsign mancante" });
    }

    const info = await qrzXmlLookup(callsign);

    res.json({
      callsign: info.callsign || callsign,
      name: info.name || "",
      surname: info.surname || "",
      qth: info.qth || "",
      country: info.country || "",
      grid: info.grid || "",
      bearing: null,
      long_path: null,
      distance_km: null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Errore lookup QRZ" });
  }
});

// =========================
// CREATE QSO
// =========================
app.post("/api/qsos", authMiddleware, async (req, res) => {
  try {
    const q = req.body || {};

    const result = await runAsync(
      `
      INSERT INTO qsos (
        call, station_callsign, qso_date, time_on, band, freq, mode,
        rst_sent, rst_rcvd, name, qth, country, grid, comment, qrz_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        q.qrz_status || "local"
      ]
    );

    res.json({ ok: true, id: result.lastID });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore salvataggio qso" });
  }
});

// =========================
// LISTA QSOS PAGINATA
// =========================
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

    const countRow = await getAsync(
      `SELECT COUNT(*) AS total FROM qsos ${where.clause}`,
      where.params
    );

    const rows = await allAsync(
      `
      SELECT
        id, call, station_callsign, qso_date, time_on, band, freq, mode,
        rst_sent, rst_rcvd, name, qth, country, grid, comment, qrz_status
      FROM qsos
      ${where.clause}
      ORDER BY qso_date DESC, time_on DESC, id DESC
      LIMIT ? OFFSET ?
      `,
      [...where.params, limit, offset]
    );

    const total = Number(countRow?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / limit));

    res.json({
      page,
      limit,
      total,
      totalPages,
      rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore caricamento qsos" });
  }
});

// =========================
// CONTROLLO DUPLICATI
// =========================
app.get("/api/qsos/check-duplicate", authMiddleware, async (req, res) => {
  try {
    const call = U(req.query.call);
    const excludeId = req.query.excludeId ? Number(req.query.excludeId) : null;

    if (!call) {
      return res.json({ count: 0, matches: [] });
    }

    const where = buildWhere({ call, excludeId });

    const countRow = await getAsync(
      `SELECT COUNT(*) AS total FROM qsos ${where.clause}`,
      where.params
    );

    const rows = await allAsync(
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
      count: Number(countRow?.total || 0),
      matches: rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore controllo duplicati" });
  }
});

// =========================
// DELETE QSO
// =========================
app.delete("/api/qsos/:id", authMiddleware, async (req, res) => {
  try {
    await runAsync(`DELETE FROM qsos WHERE id = ?`, [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore eliminazione qso" });
  }
});

// =========================
// ADIF IMPORT
// =========================
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

    if (Object.keys(rec).length) {
      records.push(rec);
    }
  }

  return records;
}

app.post("/api/adif/import", authMiddleware, async (req, res) => {
  try {
    const adif = String(req.body.adif || "");
    const records = parseAdif(adif);

    let imported = 0;
    let duplicates = 0;
    let total_read = records.length;

    for (const r of records) {
      const call = U(r.call);
      const qso_date = r.qso_date || "";
      const time_on = r.time_on || "";
      const band = r.band || "";
      const mode = r.mode || "";

      if (!call) continue;

      const exists = await getAsync(
        `
        SELECT id FROM qsos
        WHERE UPPER(COALESCE(call,'')) = ?
          AND COALESCE(qso_date,'') = ?
          AND COALESCE(time_on,'') = ?
          AND COALESCE(band,'') = ?
          AND COALESCE(mode,'') = ?
        LIMIT 1
        `,
        [call, qso_date, time_on, band, mode]
      );

      if (exists) {
        duplicates++;
        continue;
      }

      await runAsync(
        `
        INSERT INTO qsos (
          call, station_callsign, qso_date, time_on, band, freq, mode,
          rst_sent, rst_rcvd, name, qth, country, grid, comment, qrz_status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          "local"
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

// =========================
// ADIF EXPORT
// =========================
function adifField(name, value) {
  const v = String(value || "");
  if (!v) return "";
  return `<${name}:${v.length}>${v}`;
}

app.get("/api/adif/export", authMiddleware, async (req, res) => {
  try {
    const rows = await allAsync(
      `
      SELECT
        call, station_callsign, qso_date, time_on, band, freq, mode,
        rst_sent, rst_rcvd, name, qth, country, grid, comment
      FROM qsos
      ORDER BY qso_date DESC, time_on DESC, id DESC
      `
    );

    let out = "IN3JIE LOGBOOK EXPORT\n<EOH>\n";

    for (const q of rows) {
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

// =========================
// QRZ SYNC PLACEHOLDER
// =========================
app.post("/api/qrz/sync", authMiddleware, async (req, res) => {
  try {
    // Qui puoi integrare la Logbook API key in un secondo momento
    // senza toccare il frontend.
    if (!QRZ_LOGBOOK_API_KEY) {
      const totalUnsynced = await getAsync(
        `SELECT COUNT(*) AS total FROM qsos WHERE COALESCE(qrz_status,'local') <> 'synced'`
      );

      return res.json({
        total: Number(totalUnsynced?.total || 0),
        synced: 0,
        errors: 0
      });
    }

    // Placeholder compatibile col frontend anche se metti la key.
    const totalUnsynced = await getAsync(
      `SELECT COUNT(*) AS total FROM qsos WHERE COALESCE(qrz_status,'local') <> 'synced'`
    );

    return res.json({
      total: Number(totalUnsynced?.total || 0),
      synced: 0,
      errors: 0
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore sync QRZ" });
  }
});

// =========================
// HEALTH
// =========================
app.get("/", (req, res) => {
  res.send("Logbook backend OK");
});

app.listen(PORT, () => {
  console.log(`Server attivo sulla porta ${PORT}`);
});
