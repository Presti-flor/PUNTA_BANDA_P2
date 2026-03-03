const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

/* ============================
    DICCIONARIO DE VARIEDADES
    (Aquí puedes cambiar los nombres)
============================ */
const VARIEDAD_MAP = {
  "V01": "FREEDOM",
  "V02": "EXPLORER",
  "V03": "MONDIAL",
  "V04": "PINK FLOYD",
  "V05": "ALBA",
  // Agrega todas las que necesites...
};

const WORKER_MIN = 16;
const WORKER_MAX = 25;
let workerNameMap = {}; 
const clients = new Set();

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ============================
    RUTAS DE API
============================ */

app.get("/api/workers", (req, res) => {
  const workers = [];
  for (let i = WORKER_MIN; i <= WORKER_MAX; i++) {
    const code = `B${i}`;
    workers.push({ code, name: workerNameMap[code] || code });
  }
  res.json(workers);
});

app.post("/api/workers", (req, res) => {
  const { code, name } = req.body;
  if (!code || !name) return res.status(400).json({ error: "Faltan datos" });
  workerNameMap[code.toUpperCase()] = name.trim();
  res.json({ ok: true });
});

// GET SCANS: Aquí "inyectamos" el nombre de la variedad para el HTML
app.get("/api/scans", async (req, res) => {
  try {
    const limit = req.query.limit || 200;
    const result = await pool.query("SELECT ts, worker, tallos, variedad_id, grado_cm FROM scans ORDER BY ts DESC LIMIT $1", [limit]);
    
    // Mapeamos los resultados para agregar el nombre de la variedad "al vuelo"
    const finalData = result.rows.map(row => ({
      ...row,
      variedad_nombre: VARIEDAD_MAP[row.variedad_id] || row.variedad_id,
      worker_name: workerNameMap[row.worker] || row.worker
    }));

    res.json(finalData);
  } catch (err) {
    res.status(500).json({ error: "Error en DB" });
  }
});

app.get("/api/pendingAll", (req, res) => {
  res.json({});
});

/* ============================
    LÓGICA DE ESCANEO
============================ */

function parseWorker(code) {
  const m = String(code).toUpperCase().match(/^B(\d{2})$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return (n >= WORKER_MIN && n <= WORKER_MAX) ? `B${n}` : null;
}

function parseProduct(code) {
  const m = String(code).toUpperCase().match(/^V(\d{1,2})-(\d{1,3})-(\d{1,3})$/);
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
    const wCode = parseWorker(worker);
    const pCode = parseProduct(barcode);

    if (wCode && pCode) {
      const result = await saveScan(wCode, pCode);
      
      // Enviamos el nombre por SSE también
      const broadcastData = {
        ...result,
        variedad_nombre: VARIEDAD_MAP[result.variedad_id] || result.variedad_id,
        worker_name: workerNameMap[result.worker] || result.worker
      };

      broadcast({ kind: "scan", reg: broadcastData });
      return res.json({ ok: true });
    }
    res.status(400).json({ error: "Datos inválidos" });
  } catch (err) {
    res.status(500).json({ error: "Error interno" });
  }
});

async function saveScan(worker, product) {
  const client = await pool.connect();
  try {
    const query = `
      INSERT INTO scans (ts, worker, tallos, variedad_id, grado_cm, raw_a, raw_b)
      VALUES (NOW(), $1, $2, $3, $4, $5, $6)
      RETURNING *
    `;
    const values = [worker, product.tallos, product.variedad_id, product.grado_cm, worker, product.raw];
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
app.listen(PORT, '0.0.0.0', () => console.log(`Puerto ${PORT}`));