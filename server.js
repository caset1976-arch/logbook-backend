import express from "express";
import cors from "cors";
import sqlite3 from "sqlite3";

const app = express();
app.use(cors());
app.use(express.json());

const DB = new sqlite3.Database("./logbook.db");

DB.serialize(() => {
  DB.run(`
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
});

const USER="admin";
const PASS="1234";
const TOKEN="token123";

function auth(req,res,next){
  const h=req.headers.authorization||"";
  const t=h.replace("Bearer ","");
  if(t!==TOKEN) return res.status(401).json({error:"unauthorized"});
  next();
}

app.get("/",(req,res)=>res.json({ok:true}));

app.post("/api/auth/login",(req,res)=>{
  if(req.body.username!==USER || req.body.password!==PASS)
    return res.status(401).json({error:"bad login"});
  res.json({token:TOKEN});
});

app.get("/api/qsos",auth,(req,res)=>{
  DB.all("SELECT * FROM qsos ORDER BY id DESC",(e,rows)=>{
    res.json(rows);
  });
});

app.post("/api/qsos",auth,(req,res)=>{
  const q=req.body;

  DB.run(`
  INSERT INTO qsos (
    call,station_callsign,qso_date,time_on,
    band,freq,mode,rst_sent,rst_rcvd,
    name,qth,country,grid,comment,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `,
  [
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
  ],
  function(){
    res.json({id:this.lastID});
  });

});

app.listen(3000,()=>console.log("SQLite backend ready"));