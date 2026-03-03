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

let workers = generateWorkers();  // Este es el arreglo base de trabajadores
let workerNameMap = {};           // Mapa para almacenar los nombres de los trabajadores

// Aquí ya no solo generas los trabajadores, sino que también asignas nombres
workers.forEach(worker => {
  workerNameMap[worker] = worker; // Por defecto, asignamos el nombre igual que el código del trabajador
});

/* ============================
   RUTAS API
============================ */

// Esta ruta debería actualizar el nombre del trabajador en el mapa
app.post("/api/workers", (req, res) => {
  const { code, name } = req.body;
  if (!code || !name) {
    return res.status(400).json({ error: "Código y nombre son necesarios." });
  }

  // Actualizamos el mapa con el nombre recibido
  workerNameMap[code] = name;

  return res.status(200).json({ ok: true });
});

// Esta ruta debe devolver los trabajadores con sus códigos y nombres
app.get("/api/workers", (req, res) => {
  const workerList = Object.keys(workerNameMap).map(code => ({
    code,
    name: workerNameMap[code]
  }));
  res.json(workerList);
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