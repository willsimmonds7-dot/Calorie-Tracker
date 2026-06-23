import express from "express";
import multer from "multer";
import pg from "pg";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
// Time zone used to decide what counts as "today" for the daily totals.
const TZ_NAME = process.env.TZ_NAME || "Europe/Amsterdam";
// Optional shared secret to protect the energy-ingest endpoint (recommended).
const INGEST_TOKEN = process.env.INGEST_TOKEN || "";
// Entries above this many kcal count as a "meal"; smaller ones (coffee, fruit)
// are still logged and counted in totals, just not in the meal tally.
const MEAL_MIN_KCAL = Number(process.env.MEAL_MIN_KCAL) || 250;

// --- database (Postgres, e.g. free Supabase) ---
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not set. Put your Supabase connection string in .env (see .env.example).");
}
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  // Supabase requires SSL. Set PGSSL=disable for a plain local Postgres.
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meals (
      id          BIGSERIAL PRIMARY KEY,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      description TEXT,
      calories    DOUBLE PRECISION,
      protein_g   DOUBLE PRECISION,
      carbs_g     DOUBLE PRECISION,
      fat_g       DOUBLE PRECISION
    );
  `);
  // Persist the user's context note (added on capture or via re-analyse).
  await pool.query(`ALTER TABLE meals ADD COLUMN IF NOT EXISTS note TEXT;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_energy (
      day          TEXT PRIMARY KEY,            -- 'YYYY-MM-DD' local date
      active_kcal  DOUBLE PRECISION DEFAULT 0,
      resting_kcal DOUBLE PRECISION DEFAULT 0,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

// local date (YYYY-MM-DD) in the configured time zone, offset by N days ago
function localDate(daysAgo = 0) {
  const d = new Date(Date.now() - daysAgo * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ_NAME }).format(d);
}
function localToday() {
  return localDate(0);
}

// Resolve which day a payload targets: explicit YYYY-MM-DD, or the keywords
// "yesterday"/"today" (computed server-side so the client needn't format dates).
function resolveDay(src) {
  if (src.date && /^\d{4}-\d{2}-\d{2}$/.test(src.date)) return src.date;
  const kw = (src.day || "").toString().trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(kw)) return kw;
  if (kw === "yesterday") return localDate(1);
  if (kw === "today" || kw === "") return localDate(0);
  return localDate(0);
}

// Parse an optional timestamp (ISO string) for logging meals on a past day.
// Returns an ISO string the DB can store, or null to fall back to now().
function parseWhen(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Photo is parsed in memory, sent to the AI, then discarded (nothing stored).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
});

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Lightweight health check for an uptime pinger to keep the free instance warm.
// Deliberately does NOT touch the database, so frequent pings cost nothing.
app.get("/healthz", (req, res) => res.type("text").send("ok"));

const NUTRITION_SYSTEM_PROMPT =
  "You are a nutrition estimator. Estimate the meal's nutrition for the full " +
  "portion. Respond ONLY with JSON matching this shape: " +
  '{"description": string, "calories": number, "protein_g": number, "carbs_g": number, "fat_g": number}. ' +
  "If you cannot tell, make your best reasonable estimate. Do not include any text outside the JSON.";

// Shared OpenAI call: takes the user message content, returns parsed estimate.
async function runEstimate(userContent) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set. Add it to .env (local) or your host's env vars.");
  }

  const body = {
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: NUTRITION_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
    response_format: { type: "json_object" },
    max_tokens: 400,
  };

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenAI error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || "{}";
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Could not parse the AI response as JSON.");
  }

  return {
    description: String(parsed.description ?? "Unknown meal"),
    calories: Number(parsed.calories) || 0,
    protein_g: Number(parsed.protein_g) || 0,
    carbs_g: Number(parsed.carbs_g) || 0,
    fat_g: Number(parsed.fat_g) || 0,
  };
}

// Estimate from a photo (+ optional note).
async function estimateFromImage(base64DataUrl, note = "") {
  const text = note
    ? `Estimate the calories and macros for this meal. Context from the user (use it, especially for things not visible in the photo such as hidden fillings, sauces, cooking method, or portion size): ${note}`
    : "Estimate the calories and macros for this meal.";
  return runEstimate([
    { type: "text", text },
    { type: "image_url", image_url: { url: base64DataUrl } },
  ]);
}

// Re-estimate from a saved description + a user comment (no photo available).
async function estimateFromText(description, note = "") {
  const text =
    `Re-estimate the calories and macros for this meal.\n` +
    `Previously logged as: ${description}\n` +
    (note ? `User correction / extra context (weigh this heavily): ${note}\n` : "") +
    `Give an updated description that reflects the correction.`;
  return runEstimate(text);
}

// Estimate a meal from a fresh free-text description (no photo, no prior entry).
async function estimateFromDescription(description, note = "") {
  const text =
    `Estimate the calories and macros for this meal described in words.\n` +
    `Meal: ${description}\n` +
    (note ? `Extra context (use it, e.g. portion size, cooking method, sauces): ${note}\n` : "") +
    `Give a concise, clean description of the meal.`;
  return runEstimate(text);
}

// POST /api/analyze  -> estimate macros AND save the meal (photo is NOT stored).
app.post("/api/analyze", upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No photo uploaded." });

    const mime = req.file.mimetype || "image/jpeg";
    const dataUrl = `data:${mime};base64,${req.file.buffer.toString("base64")}`;

    const note = (req.body?.note || "").toString().slice(0, 500);
    const est = await estimateFromImage(dataUrl, note);

    const { rows } = await pool.query(
      `INSERT INTO meals (description, calories, protein_g, carbs_g, fat_g, note)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at`,
      [est.description, est.calories, est.protein_g, est.carbs_g, est.fat_g, note || null]
    );

    res.json({ id: rows[0].id, created_at: rows[0].created_at, note, ...est });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/meals  -> add a meal manually (e.g. typed from a packet label)
app.post("/api/meals", async (req, res) => {
  try {
    const b = req.body || {};
    const description = (b.description || "Manual entry").toString().slice(0, 200);
    const calories = Number(b.calories) || 0;
    const protein_g = Number(b.protein_g) || 0;
    const carbs_g = Number(b.carbs_g) || 0;
    const fat_g = Number(b.fat_g) || 0;
    const when = parseWhen(b.created_at);
    const { rows } = await pool.query(
      `INSERT INTO meals (created_at, description, calories, protein_g, carbs_g, fat_g)
       VALUES (COALESCE($6::timestamptz, now()), $1, $2, $3, $4, $5)
       RETURNING id, created_at, description, calories, protein_g, carbs_g, fat_g, note`,
      [description, calories, protein_g, carbs_g, fat_g, when]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/describe -> AI-estimate a meal from a free-text description and save it.
// Body JSON: { description: string, note?: string }
app.post("/api/describe", async (req, res) => {
  try {
    const description = (req.body?.description || "").toString().trim().slice(0, 300);
    if (!description) return res.status(400).json({ error: "Describe what you ate." });
    const note = (req.body?.note || "").toString().slice(0, 500);
    const when = parseWhen(req.body?.created_at);

    const est = await estimateFromDescription(description, note);

    const { rows } = await pool.query(
      `INSERT INTO meals (created_at, description, calories, protein_g, carbs_g, fat_g, note)
       VALUES (COALESCE($7::timestamptz, now()), $1, $2, $3, $4, $5, $6)
       RETURNING id, created_at, description, calories, protein_g, carbs_g, fat_g, note`,
      [est.description, est.calories, est.protein_g, est.carbs_g, est.fat_g, note || null, when]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/meals/:id  -> manually override fields (only those provided)
app.patch("/api/meals/:id", async (req, res) => {
  try {
    const b = req.body || {};
    const num = (v) => (v === undefined || v === null || v === "" || isNaN(Number(v)) ? null : Number(v));
    const when = parseWhen(b.created_at);
    const { rows } = await pool.query(
      `UPDATE meals SET
         description = COALESCE($1, description),
         calories    = COALESCE($2, calories),
         protein_g   = COALESCE($3, protein_g),
         carbs_g     = COALESCE($4, carbs_g),
         fat_g       = COALESCE($5, fat_g),
         created_at  = COALESCE($7::timestamptz, created_at)
       WHERE id = $6
       RETURNING id, created_at, description, calories, protein_g, carbs_g, fat_g, note`,
      [
        b.description != null ? String(b.description).slice(0, 200) : null,
        num(b.calories), num(b.protein_g), num(b.carbs_g), num(b.fat_g),
        req.params.id, when,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: "Meal not found." });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET/POST /api/settings -> daily calorie goal
app.get("/api/settings", async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT key, value FROM settings`);
    const s = {};
    for (const r of rows) s[r.key] = r.value;
    res.json({ daily_goal: s.daily_goal ? Number(s.daily_goal) : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/settings", async (req, res) => {
  try {
    const g = req.body?.daily_goal;
    if (g === null || g === "" || g === undefined) {
      await pool.query(`DELETE FROM settings WHERE key = 'daily_goal'`);
      return res.json({ daily_goal: null });
    }
    const n = Math.round(Number(g));
    if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: "Invalid goal." });
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('daily_goal', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [String(n)]
    );
    res.json({ daily_goal: n });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/meals  -> history (newest first)
app.get("/api/meals", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, created_at, description, calories, protein_g, carbs_g, fat_g, note
       FROM meals ORDER BY created_at DESC LIMIT 500`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/summary -> totals for today, in the configured local time zone
app.get("/api/summary", async (req, res) => {
  try {
    // Start of "today" in TZ_NAME, expressed as an absolute instant (timestamptz).
    const { rows } = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN calories > $2 THEN 1 ELSE 0 END),0)::int AS meals,
         COUNT(*)::int                AS entries,
         COALESCE(SUM(calories),0)    AS calories,
         COALESCE(SUM(protein_g),0)   AS protein_g,
         COALESCE(SUM(carbs_g),0)     AS carbs_g,
         COALESCE(SUM(fat_g),0)       AS fat_g
       FROM meals
       WHERE created_at >= (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1)`,
      [TZ_NAME, MEAL_MIN_KCAL]
    );
    const today = localToday();
    const e = await pool.query(
      `SELECT active_kcal, resting_kcal FROM daily_energy WHERE day = $1`,
      [today]
    );
    const burned = e.rows.length ? (e.rows[0].active_kcal || 0) + (e.rows[0].resting_kcal || 0) : null;
    const calories = rows[0].calories;
    const net = burned == null ? null : calories - burned; // <0 = deficit
    res.json({ date: today, ...rows[0], burned, net });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/daily?days=N -> per-day eaten + burned for the last N days (local TZ)
app.get("/api/daily", async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 90);
    const meals = await pool.query(
      `SELECT to_char((created_at AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS day,
              COALESCE(SUM(CASE WHEN calories > $3 THEN 1 ELSE 0 END),0)::int AS meals,
              COUNT(*)::int               AS entries,
              COALESCE(SUM(calories),0)   AS calories,
              COALESCE(SUM(protein_g),0)  AS protein_g,
              COALESCE(SUM(carbs_g),0)    AS carbs_g,
              COALESCE(SUM(fat_g),0)      AS fat_g
       FROM meals
       WHERE created_at >= (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1)
                           - (($2 || ' days')::interval)
       GROUP BY day
       ORDER BY day`,
      [TZ_NAME, days - 1, MEAL_MIN_KCAL]
    );
    const energy = await pool.query(
      `SELECT day, active_kcal, resting_kcal FROM daily_energy
       WHERE day >= to_char(((date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1)
                             - (($2 || ' days')::interval)) AT TIME ZONE $1, 'YYYY-MM-DD')`,
      [TZ_NAME, days - 1]
    );
    const burnByDay = {};
    for (const r of energy.rows) burnByDay[r.day] = (r.active_kcal || 0) + (r.resting_kcal || 0);

    const out = meals.rows.map((r) => ({
      ...r,
      burned: r.day in burnByDay ? burnByDay[r.day] : null,
    }));
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Energy ingest (from Apple Health via a Shortcut).
// Accepts BOTH GET (query params) and POST (JSON body), because the iOS
// Shortcuts app can't reliably POST through some CDNs but GET works fine.
// Params: date?='YYYY-MM-DD', active?, resting?, total?  (numbers)
// Auth: Authorization: Bearer <INGEST_TOKEN>  OR  ?token=<INGEST_TOKEN>
function energyAuthorized(req) {
  if (!INGEST_TOKEN) return true;
  const auth = req.get("authorization") || "";
  let token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) token = (req.query.token || "").toString();
  return token === INGEST_TOKEN;
}

async function ingestEnergy(src) {
  const day = resolveDay(src);
  let active = Number(src.active);
  let resting = Number(src.resting);
  const total = Number(src.total);
  // If only a single total was sent, store it whole in active_kcal.
  if ((!Number.isFinite(active) && !Number.isFinite(resting)) && Number.isFinite(total)) {
    active = total;
    resting = 0;
  }
  active = Number.isFinite(active) ? active : 0;
  resting = Number.isFinite(resting) ? resting : 0;

  await pool.query(
    `INSERT INTO daily_energy (day, active_kcal, resting_kcal, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (day) DO UPDATE
       SET active_kcal = EXCLUDED.active_kcal,
           resting_kcal = EXCLUDED.resting_kcal,
           updated_at = now()`,
    [day, active, resting]
  );
  return { ok: true, day, active, resting, burned: active + resting };
}

async function handleEnergy(req, res, src) {
  try {
    if (!energyAuthorized(req)) return res.status(401).json({ error: "Unauthorized" });
    res.set("Cache-Control", "no-store");
    res.json(await ingestEnergy(src));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}

app.get("/api/energy", (req, res) => handleEnergy(req, res, req.query || {}));
app.post("/api/energy", (req, res) => handleEnergy(req, res, req.body || {}));

// POST /api/meals/:id/reanalyze -> re-estimate from description + a user comment
// Body JSON: { note: string }. (No photo is stored, so this is text-based.)
app.post("/api/meals/:id/reanalyze", async (req, res) => {
  try {
    const note = (req.body?.note || "").toString().slice(0, 500);
    const existing = await pool.query(
      `SELECT description FROM meals WHERE id = $1`,
      [req.params.id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: "Meal not found." });

    const est = await estimateFromText(existing.rows[0].description, note);

    const { rows } = await pool.query(
      `UPDATE meals
         SET description = $1, calories = $2, protein_g = $3, carbs_g = $4, fat_g = $5, note = $6
       WHERE id = $7
       RETURNING id, created_at, description, calories, protein_g, carbs_g, fat_g, note`,
      [est.description, est.calories, est.protein_g, est.carbs_g, est.fat_g, note || null, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/meals/:id
app.delete("/api/meals/:id", async (req, res) => {
  try {
    await pool.query(`DELETE FROM meals WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`CalorieSnap running at http://localhost:${PORT}`);
      if (!OPENAI_API_KEY) console.log("WARNING: OPENAI_API_KEY not set — analysis will fail until you add it.");
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err.message);
    process.exit(1);
  });
