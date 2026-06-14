# 📸 CalorieSnap

Take a photo of your meal, get an AI estimate of its calories and macros (protein / carbs / fat), and store it with a timestamp. Runs as a mobile web app you "Add to Home Screen" on your iPhone so it behaves like a native app — no App Store or Apple Developer account needed.

This version is built to run **for free**:
- **Frontend:** a mobile web app (PWA). Opens the camera, shows the estimate, keeps a history.
- **Backend:** a small Node/Express server (free Render web service) that holds your OpenAI key and talks to the database.
- **Database:** a free **Supabase** Postgres database stores each meal.
- **Photos are not stored.** Each photo is sent to the AI for the estimate and then discarded — only the description, calories, macros, and timestamp are saved. (This keeps everything within free limits.)

---

## 1. Get an OpenAI API key

1. Go to **https://platform.openai.com/api-keys** and sign in (or create an account).
2. Add a payment method under **Settings → Billing** and set a low monthly limit, e.g. $5, so you can't be surprised.
3. Click **Create new secret key**, copy it (starts with `sk-...`). You only see it once.

**Cost:** the AI itself isn't free — each photo is one `gpt-4o` vision call, roughly **$0.005–$0.02 per meal**. ~3 meals/day is about $1–2/month. To spend less, set `OPENAI_MODEL=gpt-4o-mini`. Everything else (hosting + database) is free.

## 2. Create the free database (Supabase)

1. Go to **https://supabase.com**, sign up (free), and **New project**. Pick a name and a database password — **save that password**.
2. Wait ~2 minutes for it to provision.
3. Go to **Project Settings → Database → Connection string → URI**. Copy it. It looks like:
   `postgresql://postgres:[YOUR-PASSWORD]@db.xxxx.supabase.co:5432/postgres`
4. Replace `[YOUR-PASSWORD]` with the password from step 1. This whole string is your `DATABASE_URL`.

That's it — the app creates the `meals` table automatically on first run.

## 3. Go live on Render (free, HTTPS, works anywhere)

This puts the app on the internet with a real `https://…` URL (which also makes the live camera work on iPhone). You'll need a free **GitHub** account and a free **Render** account. The included `render.yaml` does the wiring.

### Step 1 — Put the code on GitHub
1. Create a new, empty repo at https://github.com/new (e.g. `calorie-snap`; Private is fine).
2. In Terminal, inside the `calorie-snap` folder:
   ```bash
   git init
   git add .
   git commit -m "CalorieSnap"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/calorie-snap.git
   git push -u origin main
   ```
   (`.gitignore` keeps `node_modules` and `.env` out of the repo.)

### Step 2 — Deploy
1. Go to https://dashboard.render.com → **New** → **Blueprint**.
2. Connect GitHub and pick the `calorie-snap` repo. Render reads `render.yaml`.
3. It will ask you to fill in two secrets:
   - **`OPENAI_API_KEY`** — your OpenAI key.
   - **`DATABASE_URL`** — your Supabase connection string from step 2.
4. Click **Apply** / **Create** and wait for the build. You'll get a URL like `https://caloriesnap.onrender.com`.

### Step 3 — Put it on your iPhone
Open that `https://…` URL in Safari → **Share** → **Add to Home Screen**. It now works on cellular or any Wi-Fi, with your laptop closed.

> **Free-tier note:** a free Render service goes to sleep after ~15 minutes of no use. The first time you open the app each day it may take **30–60 seconds** to wake up, then it's normal speed. That's the trade-off for $0 hosting. (Upgrading Render to the $7/mo Starter plan removes the sleep if it ever bugs you.)

### Updating later
Change the code and `git push` again — Render redeploys automatically. Your meals in Supabase are untouched.

---

## Connect your Apple Watch (deficit / surplus)

The app can show **calories in − calories out**: it compares what you logged
against your **total** energy burned (Active + Resting) from Apple Health.
A web app can't read Apple Health directly, so an **Apple Shortcut** pushes the
number to the app once a day.

### One-time: get your ingest token
The app protects the burn-data endpoint with a secret. On Render → your service →
**Environment**, copy the value of **`INGEST_TOKEN`** (Render generated it for you).
You'll paste it into the Shortcut below.

### Build the Shortcut
Open the **Shortcuts** app → **+** → add these actions in order:

1. **Find Health Samples** — Type: **Active Energy**. Add a filter so Start Date
   is **Today** (or "is after" the start of today). Tap to allow Health access.
2. **Calculate Statistics** — Operation: **Sum**, input: the Health Samples from
   step 1. Then **Set Variable** → name it `Active`.
3. **Find Health Samples** — Type: **Resting Energy**, same Today filter.
4. **Calculate Statistics** — **Sum** of step 3 → **Set Variable** `Resting`.
5. **Calculate** — `Active` **+** `Resting`, then **Round** to nearest 1 →
   **Set Variable** `Total`.
6. **Get Contents of URL** (use **GET** — see note below):
   - Method: **GET**
   - URL: `https://YOUR-APP.onrender.com/api/energy?total=` and then insert the
     **Total** variable right after `total=` (so it becomes `...?total=2345`).
   - Headers: `Authorization` = `Bearer YOUR_INGEST_TOKEN`
   - No Request Body.

Run it once — you should see `{"ok":true,...}`. Open the app and today's card now
shows **Burned** and **Net** (green = deficit, red = surplus).

> **Why GET, not POST?** The iOS Shortcuts app can't reliably send POST requests
> through some CDNs (the request just times out), but GET works perfectly. The
> server accepts the burn data either way, so the Shortcut uses GET. If you'd
> rather not put the token in a header, you can instead append it to the URL:
> `?total=...&token=YOUR_INGEST_TOKEN` (only do this if your token has no
> `+` or `/` characters, which break in URLs).

### Make it automatic
Shortcuts → **Automation** → **+** → **Time of Day** → **23:55**, Daily → Run your
shortcut, and turn **off** "Ask Before Running". Now it posts every night.

> **Units gotcha:** make sure Health is showing energy in **kcal**, not kJ. In the
> Health app, an Active/Resting Energy entry should read e.g. "520 kcal". If yours
> shows kJ, either switch units or add a **Calculate** step dividing `Total` by
> 4.184 before posting. (1 kcal = 4.184 kJ.)
>
> You can re-run the Shortcut anytime to refresh the day; posting the same date
> just overwrites it. No watch data? The app simply hides the Net figure.

### Quick manual test (optional)
```bash
# GET (what the Shortcut uses)
curl -i "https://YOUR-APP.onrender.com/api/energy?total=2400" \
  -H "Authorization: Bearer YOUR_INGEST_TOKEN"

# POST also works (e.g. from curl, which has no CDN issue)
curl -X POST https://YOUR-APP.onrender.com/api/energy \
  -H "Authorization: Bearer YOUR_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"total": 2400}'
```

---

## Run it locally (optional, for testing)

You need [Node.js](https://nodejs.org) 18+.

```bash
cd calorie-snap
npm install
cp .env.example .env     # paste your OpenAI key AND your Supabase DATABASE_URL
npm start
```

Open http://localhost:3000. (Local runs use the same Supabase database.)

## Where your data lives

Every meal is a row in your Supabase `meals` table (id, timestamp, description, calories, protein/carbs/fat). You can browse or export it anytime from the Supabase dashboard → **Table editor**. Photos are never stored anywhere.

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/analyze` | multipart `photo` → estimates macros, saves the row, returns it |
| `GET` | `/api/meals` | list meals, newest first |
| `GET` | `/api/summary` | today's totals + burned/net (local time zone) |
| `GET` | `/api/daily?days=N` | per-day eaten + burned for the last N days |
| `GET`/`POST` | `/api/energy` | upsert a day's burned energy (Bearer `INGEST_TOKEN`); GET takes `?total=` etc. |
| `DELETE` | `/api/meals/:id` | delete a meal |

## Notes & ideas

- **Accuracy:** estimates are approximate — AI can't weigh your food. Treat the numbers as a guide.
- **Time zone:** the "today" totals use your local time zone (default `Europe/Amsterdam`, DST-aware). Change it with the `TZ_NAME` env var (any IANA name, e.g. `America/New_York`).
- **Want photos back?** They can be stored in free Supabase Storage later if you change your mind.

## Tech

Node.js, Express, multer, `pg` (Postgres), and the OpenAI Chat Completions vision API. No build step, no frontend framework.
