const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

/* ============================
    CONFIGURACIÓN DE BASE DE DATOS
============================ */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

/* ============================
    ESTADO EN MEMORIA
============================ */
const WORKER_MIN = 16;
const WORKER_MAX = 25;

function generateWorkers() {
  const arr = [];
  for (let i = WORKER_MIN; i <= WORKER_MAX; i++) {
    arr.push(`B${i}`);
  }
  return arr;
}

let workers = generateWorkers();
let workerNameMap = {}; // Los nombres se guardan aquí en RAM, no en la DB
const clients = new Set();

/* ============================
    SERVIR FRONTEND
============================ */
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ============================
    RUTAS DE API
============================ */

app.get("/api/workers", (req, res) => {
  res.json(workers.map((w) => ({ 
    code: w, 
    name: workerNameMap[w] || w 
  })));
});

app.post("/api/workers", (req, res) => {
  const { code, name } = req.body;
  if (!code || !name) return res.status(400).json({ error: "Datos faltantes" });
  const upCode = code.trim().toUpperCase();
  workerNameMap[upCode] = name.trim();
  res.json({ ok: true });
});

app.get("/api/scans", async (req, res) => {
  try {
    const limit = req.query.limit || 200;
    // Seleccionamos solo las columnas que SÍ existen
    const result = await pool.query("SELECT ts, worker, tallos, variedad_id, grado_cm, raw_a, raw_b FROM scans ORDER BY ts DESC LIMIT $1", [limit]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener registros" });
  }
});

app.get("/api/pendingAll", (req, res) => {
  const obj = {};
  workers.forEach(w => {
    obj[w] = { variedad: "---", grado: "--", tallos: "--" }; 
  });
  res.json(obj);
});

/* ============================
    LÓGICA DE ESCANEO
============================ */

function parseWorker(code) {
  if (!code) return null;
  const m = code.trim().toUpperCase().match(/^B(\d{2})$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return (n >= WORKER_MIN && n <= WORKER_MAX) ? `B${n}` : null;
}

function parseProduct(code) {
  if (!code) return null;
  const m = code.trim().toUpperCase().match(/^V(\d{1,2})-(\d{1,3})-(\d{1,3})$/);
  if (!m) return null;
  return {
    variedad_id: `V${m[1]}`,
    grado_cm: parseInt(m[2], 10),
    tallos: parseInt(m[3], 10),
    raw: code.toUpperCase(),
  };
}

app.post("/api/scan", async (req, res) => {
  try {
    const { barcode, worker } = req.body;

    if (worker && barcode) {
      const wCode = parseWorker(worker);
      const pCode = parseProduct(barcode);
      if (wCode && pCode) {
        const result = await saveScan(wCode, pCode);
        broadcast({ kind: "scan", reg: result });
        return res.json({ ok: true });
      }
    }
    res.status(400).json({ error: "Datos inválidos" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error interno" });
  }
});

/* ============================
    BASE DE DATOS (VERSIÓN SIN COLUMNA NOMBRE)
============================ */

async function saveScan(worker, product) {
  const client = await pool.connect();
  try {
    // AQUÍ ESTÁ EL CAMBIO: No mencionamos ni worker_name ni variedad_nombre
    const query = `
      INSERT INTO scans 
      (ts, worker, tallos, variedad_id, grado_cm, raw_a, raw_b)
      VALUES (NOW(), $1, $2, $3, $4, $5, $6)
      RETURNING *
    `;
    
    const values = [
      worker, 
      product.tallos, 
      product.variedad_id, 
      product.grado_cm, 
      worker, 
      product.raw
    ];

    const result = await client.query(query, values);
    return result.rows[0];
  } finally {
    client.release();
  }
}

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => res.write(msg));
}

app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor activo en puerto ${PORT}`);
});