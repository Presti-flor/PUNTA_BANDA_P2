const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

/* ============================
   CONFIG
============================ */



const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

/* ============================
   SERVIR FRONTEND (Railway)
============================ */

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ============================
   WORKERS BASE
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

/* ============================
   SSE CLIENTES
============================ */

const clients = new Set();

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

  res.write(
    `data: ${JSON.stringify({
      kind: "snapshot",
      snapshot: scans,
      pending,
      workers: workers.map(w => ({ code: w, name: w }))
    })}\n\n`
  );

  req.on("close", () => {
    clients.delete(res);
  });
});

/* ============================
   HELPERS PARSEO
============================ */

function parseWorker(code) {
  const m = code.match(/^B(\d{2})$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (n < WORKER_MIN || n > WORKER_MAX) return null;
  return `B${n}`;
}

function parseProduct(code) {
  const m = code.match(/^V(\d{2})-(\d{1,3})-(\d{1,3})$/);
  if (!m) return null;
  return {
    variedad_id: `V${m[1]}`,
    grado_cm: parseInt(m[2], 10),
    tallos: parseInt(m[3], 10),
    raw: code
  };
}

/* ============================
   PENDIENTES
============================ */

let pendingAByWorker = {};   // B16 -> A
let globalPendingB = null;   // Vxx esperando A

/* ============================
   RUTAS API
============================ */

app.get("/api/workers", (req, res) => {
  res.json(workers.map(w => ({ code: w, name: w })));
});

app.get("/api/scans", async (req, res) => {
  const limit = parseInt(req.query.limit || "100", 10);
  const rows = await getScans(limit);
  res.json(rows);
});

app.get("/api/pendingAll", async (req, res) => {
  const p = await getPendingAll();
  res.json(p);
});

/* ============================
   POST SCAN
============================ */

app.post("/api/scan", async (req, res) => {
  try {
    const { barcode, worker } = req.body;
    if (!barcode) return res.status(400).json({ error: "barcode requerido" });

    const code = barcode.trim().toUpperCase();

    const workerCode = parseWorker(code);
    const productCode = parseProduct(code);

    // ===== ESCANEO A (B16..B25) =====
    if (workerCode) {
      pendingAByWorker[workerCode] = workerCode;

      if (globalPendingB) {
        const result = await saveScan(workerCode, globalPendingB);
        globalPendingB = null;
        broadcast({ kind: "scan", reg: result });
      }

      return res.json({ ok: true });
    }

    // ===== ESCANEO B (Vxx-gg-tt) =====
    if (productCode) {
      if (worker) {
        const w = parseWorker(worker);
        if (!w) return res.status(400).json({ error: "worker inválido" });

        const result = await saveScan(w, productCode);
        broadcast({ kind: "scan", reg: result });
        return res.json({ ok: true });
      }

      globalPendingB = productCode;
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: "Código no reconocido" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error interno" });
  }
});

/* ============================
   DB FUNCTIONS
============================ */

async function saveScan(worker, product) {
  const client = await pool.connect();
  try {
    const variedad = await client.query(
      "SELECT nombre FROM variedades WHERE id = $1",
      [product.variedad_id]
    );

    const variedad_nombre = variedad.rows[0]
      ? variedad.rows[0].nombre
      : product.variedad_id;

    const result = await client.query(
      `INSERT INTO scans
       (ts, worker, tallos, variedad_id, grado_cm, raw_a, raw_b, variedad_nombre)
       VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        worker,
        product.tallos,
        product.variedad_id,
        product.grado_cm,
        worker,
        product.raw,
        variedad_nombre
      ]
    );

    return result.rows[0];

  } finally {
    client.release();
  }
}

async function getScans(limit) {
  const result = await pool.query(
    "SELECT * FROM scans ORDER BY ts DESC LIMIT $1",
    [limit]
  );
  return result.rows;
}

async function getPendingAll() {
  const obj = {};
  workers.forEach(w => {
    obj[w] = pendingAByWorker[w] || {};
  });
  return obj;
}

/* ============================
   START SERVER
============================ */
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor activo en puerto ${PORT}`);
});