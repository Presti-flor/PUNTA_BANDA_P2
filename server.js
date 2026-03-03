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
let workerNameMap = {}; 
let pendingAByWorker = {}; 
const clients = new Set();

/* ============================
    SERVIR FRONTEND
============================ */
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ============================
    RUTAS DE API (CORREGIDAS)
============================ */

// Obtener lista de trabajadores
app.get("/api/workers", (req, res) => {
  res.json(workers.map((w) => ({ 
    code: w, 
    name: workerNameMap[w] || w 
  })));
});

// Guardar nombres de bonchadores
app.post("/api/workers", (req, res) => {
  const { code, name } = req.body;
  if (!code || !name) return res.status(400).json({ error: "Datos faltantes" });
  const upCode = code.trim().toUpperCase();
  workerNameMap[upCode] = name.trim();
  res.json({ ok: true });
});

// NUEVA: Obtener últimos registros (Evita error 404 en la tabla)
app.get("/api/scans", async (req, res) => {
  try {
    const limit = req.query.limit || 150;
    const scans = await getScans(limit);
    res.json(scans);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener registros" });
  }
});

// NUEVA: Obtener pendientes (Evita error 404 en el cuadro de texto)
app.get("/api/pendingAll", async (req, res) => {
  const obj = {};
  workers.forEach(w => {
    obj[w] = { variedad: "---", grado: "--", tallos: "--" }; 
  });
  res.json(obj);
});

/* ============================
    SISTEMA DE ESCANEO (LA CLAVE)
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
  // Regex flexible para V1 o V01
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

    // CASO 1: Envío completo desde el HTML (Registro directo)
    if (worker && barcode) {
      const wCode = parseWorker(worker);
      const pCode = parseProduct(barcode);
      if (wCode && pCode) {
        const result = await saveScan(wCode, pCode);
        broadcast({ kind: "scan", reg: result });
        return res.json({ ok: true });
      }
    }

    // CASO 2: Escaneo individual (Respaldo)
    const code = (barcode || "").trim().toUpperCase();
    const isW = parseWorker(code);
    const isP = parseProduct(code);

    if (isW || isP) {
      return res.json({ ok: true, message: "Pendiente de pareja" });
    }

    res.status(400).json({ error: "Código no reconocido" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

/* ============================
    BASE DE DATOS Y SSE
============================ */

async function saveScan(worker, product) {
  const client = await pool.connect();
  try {
    // Buscar nombre de variedad si existe la tabla, si no usa el ID
    let varNombre = product.variedad_id;
    try {
        const varRes = await client.query("SELECT nombre FROM variedades WHERE id = $1", [product.variedad_id]);
        if (varRes.rows[0]) varNombre = varRes.rows[0].nombre;
    } catch (e) { /* Variedades table might not exist yet */ }

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