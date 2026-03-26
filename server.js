import express from "express";
import sqlite3 from "sqlite3";
import cors from "cors";
import fs from "fs";

const app = express();
app.use(cors());
app.use(express.json());

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
      created_at TEXT
    )
  `);
});

app.get("/", (req,res)=>{
  res.send("LOGBOOK BACKEND OK");
});

app.post("/login",(req,res)=>{
  const {user,pass} = req.body;
  if(user==="admin" && pass==="1234"){
    res.json({ok:true});
  } else {
    res.status(401).json({ok:false});
  }
});

app.post("/qso",(req,res)=>{
  const q=req.body;

  db.run(`
    INSERT INTO qsos
    (call,station_callsign,qso_date,time_on,band,freq,mode,
     rst_sent,rst_rcvd,name,qth,country,grid,comment,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `,[
    q.call,
    q.station_callsign,
    q.qso_date,
    q.time_on,
    q.band,
    q.freq,
    q.mode,
    q.rst_sent,
    q.rst_rcvd,
    q.name,
    q.qth,
    q.country,
    q.grid,
    q.comment,
    new Date().toISOString()
  ]);

  res.json({ok:true});
});

app.get("/qsos",(req,res)=>{
  db.all("SELECT * FROM qsos ORDER BY id DESC",(e,r)=>{
    res.json(r);
  });
});

app.get("/export",(req,res)=>{
  db.all("SELECT * FROM qsos",(e,rows)=>{
    let adif="";
    rows.forEach(q=>{
      adif+=`<CALL:${q.call.length}>${q.call}`;
      adif+=` <QSO_DATE:8>${q.qso_date}`;
      adif+=` <TIME_ON:4>${q.time_on}`;
      adif+=` <BAND:${q.band.length}>${q.band}`;
      adif+=` <MODE:${q.mode.length}>${q.mode}`;
      if(q.freq) adif+=` <FREQ:${q.freq.length}>${q.freq}`;
      if(q.rst_sent) adif+=` <RST_SENT:${q.rst_sent.length}>${q.rst_sent}`;
      if(q.rst_rcvd) adif+=` <RST_RCVD:${q.rst_rcvd.length}>${q.rst_rcvd}`;
      adif+=" <EOR>\n";
    });
    res.send(adif);
  });
});

app.post("/import",(req,res)=>{
  const {adif}=req.body;
  const qsos = adif.split("<EOR>");

  qsos.forEach(r=>{
    const call = (r.match(/<CALL:\d+>(\S+)/)||[])[1];
    const date = (r.match(/<QSO_DATE:\d+>(\S+)/)||[])[1];
    const time = (r.match(/<TIME_ON:\d+>(\S+)/)||[])[1];
    const band = (r.match(/<BAND:\d+>(\S+)/)||[])[1];
    const mode = (r.match(/<MODE:\d+>(\S+)/)||[])[1];

    if(call){
      db.run(`
        INSERT INTO qsos
        (call,qso_date,time_on,band,mode,created_at)
        VALUES (?,?,?,?,?,?)
      `,[call,date,time,band,mode,new Date().toISOString()]);
    }
  });

  res.json({ok:true});
});

app.listen(3000,()=>{
  console.log("LOGBOOK BACKEND READY");
});
