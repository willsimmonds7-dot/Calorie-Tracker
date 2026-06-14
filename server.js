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
}

// Photo is parsed in memory, sent to the AI, then discarded (nothing stored).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
});

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Ask OpenAI to estimate calories + macros from an image.
async function estimateFromImage(base64DataUrl) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set. Add it to .env (local) or your host's env vars.");
  }

  const body = {
    model: OPENAI_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are a nutrition estimator. Look at the food photo and estimate the meal's " +
          "nutrition for the full portion shown. Respond ONLY with JSON matching this shape: " +
          '{"description": string, "calories": number, "protein_g": number, "carbs_g": number, "fat_g": number}. ' +
          "Numbers are for the whole meal in the image. If you cannot see food, set calories to 0 and " +
          'describe what you see. Do not include any text outside the JSON.',
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Estimate the calories and macros for this meal." },
          { type: "image_url", image_url: { url: base64DataUrl } },
        ],
      },
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

// POST /api/analyze  -> estimate macros AND save the meal (photo is NOT stored).
app.post("/api/analyze", upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No photo uploaded." });

    const mime = req.file.mimetype || "image/jpeg";
    const dataUrl = `data:${mime};base64,${req.file.buffer.toString("base64")}`;

    const est = await estimateFromImage(dataUrl);

    const { rows } = await pool.query(
      `INSERT INTO meals (description, calories, protein_g, carbs_g, fat_g)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [est.description, est.calories, est.protein_g, est.carbs_g, est.fat_g]
    );

    res.json({ id: rows[0].id, created_at: rows[0].created_at, ...est });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/meals  -> history (newest first)
app.get("/api/meals", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, created_at, description, calories, protein_g, carbs_g, fat_g
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
         COUNT(*)::int                AS meals,
         COALESCE(SUM(calories),0)    AS calories,
         COALESCE(SUM(protein_g),0)   AS protein_g,
         COALESCE(SUM(carbs_g),0)     AS carbs_g,
         COALESCE(SUM(fat_g),0)       AS fat_g
       FROM meals
       WHERE created_at >= (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1)`,
      [TZ_NAME]
    );
    const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: TZ_NAME }).format(new Date());
    res.json({ date: localDate, ...rows[0] });
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
