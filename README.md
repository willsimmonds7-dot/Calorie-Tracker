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
| `GET` | `/api/summary` | today's totals (UTC) |
| `DELETE` | `/api/meals/:id` | delete a meal |

## Notes & ideas

- **Accuracy:** estimates are approximate — AI can't weigh your food. Treat the numbers as a guide.
- **Time zone:** the "today" totals use your local time zone (default `Europe/Amsterdam`, DST-aware). Change it with the `TZ_NAME` env var (any IANA name, e.g. `America/New_York`).
- **Want photos back?** They can be stored in free Supabase Storage later if you change your mind.

## Tech

Node.js, Express, multer, `pg` (Postgres), and the OpenAI Chat Completions vision API. No build step, no frontend framework.
