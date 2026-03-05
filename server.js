const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const path = require("path");

// FORZAR ZONA HORARIA COLOMBIA
process.env.TZ = "America/Bogota";

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

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

// GET SCANS: nombre de variedad desde tabla 'variedades'
app.get("/api/scans", async (req, res) => {
  try {
    const limit = req.query.limit || 200;
    const query = `
      SELECT 
        s.ts, 
        s.worker, 
        s.tallos, 
        s.variedad_id, 
        s.grado_cm,
        COALESCE(v.nombre, s.variedad_id) AS variedad_nombre
      FROM scans s
      LEFT JOIN variedades v ON s.variedad_id = v.id
      ORDER BY s.ts DESC 
      LIMIT $1
    `;
    const result = await pool.query(query, [limit]);

    const finalData = result.rows.map(row => ({
      ...row,
      worker_name: workerNameMap[row.worker] || row.worker
    }));

    res.json(finalData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error en DB" });
  }
});

app.get("/api/pendingAll", (req, res) => {
  res.json({});
});

/* ============================
    LÓGICA DE ESCANEO (Bxx-Tyy & Vxx-gg)
============================ */

// Bonchador: B16-T20 (B=bonchador, T=tallos)
function parseWorker(code) {
  const up = String(code || "").trim().toUpperCase();
  const m = up.match(/^B(\d{2})-T(\d{1,3})$/);
  if (!m) return null;

  const n = parseInt(m[1], 10);
  const tallos = parseInt(m[2], 10);

  if (!(n >= WORKER_MIN && n <= WORKER_MAX)) return null;
  if (!Number.isFinite(tallos) || tallos <= 0) return null;

  return {
    code: `B${n}`,   // para DB/estadísticas y nombres (ej: "B16")
    tallos,          // proviene del bonchador
    raw: up          // el crudo escaneado (ej: "B16-T20")
  };
}

// Producto: V01-60 (variedad + grado; SIN tallos)
function parseProduct(code) {
  const up = String(code || "").trim().toUpperCase();
  const m = up.match(/^V(\d{1,2})-(\d{1,3})$/);
  if (!m) return null;

  const variedad_id = `V${m[1]}`;
  const grado_cm = parseInt(m[2], 10);
  if (!Number.isFinite(grado_cm)) return null;

  return {
    variedad_id,
    grado_cm,
    raw: up
  };
}

app.post("/api/scan", async (req, res) => {
  try {
    const { barcode, worker } = req.body;
    const wObj = parseWorker(worker);
    const pObj = parseProduct(barcode);

    if (wObj && pObj) {
      const savedReg = await saveScan(wObj, pObj);

      // Nombre de la variedad para SSE
      const varRes = await pool.query("SELECT nombre FROM variedades WHERE id = $1", [pObj.variedad_id]);
      const varNombre = varRes.rows[0] ? varRes.rows[0].nombre : pObj.variedad_id;

      const broadcastData = {
        ...savedReg,
        variedad_nombre: varNombre,
        worker_name: workerNameMap[savedReg.worker] || savedReg.worker
      };

      broadcast({ kind: "scan", reg: broadcastData });
      return res.json({ ok: true });
    }
    res.status(400).json({ error: "Datos inválidos" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error interno" });
  }
});

async function saveScan(wObj, pObj) {
  const client = await pool.connect();
  try {
    const localTimestamp = new Date();
    const query = `
      INSERT INTO scans (ts, worker, tallos, variedad_id, grado_cm, raw_a, raw_b)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `;
    const values = [
      localTimestamp,
      wObj.code,          // guardamos "B16"
      wObj.tallos,        // tallos vienen del bonchador
      pObj.variedad_id,
      pObj.grado_cm,
      wObj.raw,           // raw_a = bonchador crudo (B16-T20)
      pObj.raw            // raw_b = producto crudo (V01-60)
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
app.listen(PORT, '0.0.0.0', () => console.log(`Servidor en puerto ${PORT} (Formatos: Bxx-Tyy y Vxx-gg)`));