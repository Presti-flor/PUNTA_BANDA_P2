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
let workerNameMap = {}; // Guarda los nombres asignados: {"B16": "Juan"}
let pendingAByWorker = {}; 
let globalPendingB = null; 
const clients = new Set();

/* ============================
    SERVIR FRONTEND
============================ */
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ============================
    RUTAS DE TRABAJADORES (API)
============================ */

// Obtener lista de trabajadores con sus nombres actuales
app.get("/api/workers", (req, res) => {
  res.json(workers.map((w) => ({ 
    code: w, 
    name: workerNameMap[w] || w 
  })));
});

// ESTA ES LA RUTA QUE TE FALTABA (Soluciona el error 404)
app.post("/api/workers", (req, res) => {
  const { code, name } = req.body;
  if (!code || !name) {
    return res.status(400).json({ error: "Código y nombre requeridos" });
  }
  const upCode = code.trim().toUpperCase();
  workerNameMap[upCode] = name.trim();
  console.log(`Nombre actualizado: ${upCode} -> ${name}`);
  res.json({ ok: true });
});

/* ============================
    SISTEMA DE ESCANEO Y SSE
============================ */

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(msg);
  }
}

app.get("/api/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  clients.add(res);

  const scans = await getScans(200);
  const pending = await getPendingAll();

  res.write(`data: ${JSON.stringify({
    kind: "snapshot",
    snapshot: scans,
    pending,
    workers: workers.map((w) => ({ code: w, name: workerNameMap[w] || w })),
  })}\n\n`);

  const pingInterval = setInterval(() => res.write("data: ping\n\n"), 20000);

  req.on("close", () => {
    clients.delete(res);
    clearInterval(pingInterval);
  });
});

/* ============================
    LÓGICA DE ESCANEO
============================ */

function parseWorker(code) {
  const m = code.match(/^B(\d{2})$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return (n >= WORKER_MIN && n <= WORKER_MAX) ? `B${n}` : null;
}

function parseProduct(code) {
  const m = code.match(/^V(\d{2})-(\d{1,3})-(\d{1,3})$/);
  if (!m) return null;
  return {
    variedad_id: `V${m[1]}`,
    grado_cm: parseInt(m[2], 10),
    tallos: parseInt(m[3], 10),
    raw: code,
  };
}

app.post("/api/scan", async (req, res) => {
  try {
    const { barcode, worker } = req.body;
    const code = (barcode || "").trim().toUpperCase();

    const workerCode = parseWorker(code);
    const productCode = parseProduct(code);

    if (workerCode) {
      pendingAByWorker[workerCode] = workerCode;
      if (globalPendingB) {
        const result = await saveScan(workerCode, globalPendingB);
        globalPendingB = null;
        broadcast({ kind: "scan", reg: result });
      }
      return res.json({ ok: true });
    }

    if (productCode) {
      if (worker) {
        const w = parseWorker(worker);
        if (w) {
          const result = await saveScan(w, productCode);
          broadcast({ kind: "scan", reg: result });
          return res.json({ ok: true });
        }
      }
      globalPendingB = productCode;
      return res.json({ ok: true });
    }

    res.status(400).json({ error: "Código no reconocido" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error interno" });
  }
});

/* ============================
    FUNCIONES DE BASE DE DATOS
============================ */

async function saveScan(worker, product) {
  const client = await pool.connect();
  try {
    const varRes = await client.query("SELECT nombre FROM variedades WHERE id = $1", [product.variedad_id]);
    const varNombre = varRes.rows[0] ? varRes.rows[0].nombre : product.variedad_id;
    
    // Obtenemos el nombre actual del mapa para guardarlo en el registro
    const wName = workerNameMap[worker] || worker;

    const result = await client.query(
      `INSERT INTO scans 
       (ts, worker, worker_name, tallos, variedad_id, grado_cm, raw_a, raw_b, variedad_nombre)
       VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [worker, wName, product.tallos, product.variedad_id, product.grado_cm, worker, product.raw, varNombre]
    );
    return result.rows[0];
  } finally {
    client.release();
  }
}

async function getScans(limit) {
  const result = await pool.query("SELECT * FROM scans ORDER BY ts DESC LIMIT $1", [limit]);
  return result.rows;
}

async function getPendingAll() {
  const obj = {};
  workers.forEach(w => { obj[w] = pendingAByWorker[w] || {}; });
  return obj;
}

/* ============================
    INICIO DEL SERVIDOR
============================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor activo en puerto ${PORT}`);
});