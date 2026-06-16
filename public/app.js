const $ = (id) => document.getElementById(id);

const MEAL_MIN_KCAL = 250; // entries above this count as a "meal"
let mealsById = {};
let editingId = null;

const photoInput = $("photo");
const noteInput = $("note");
const stageCard = $("stage");
const stagePreview = $("stagePreview");
const confirmBtn = $("confirmBtn");
const cancelBtn = $("cancelBtn");
const resultCard = $("result");
const preview = $("preview");
const statusEl = $("status");
const fields = $("fields");

let selectedFile = null;

// Step 1: pick/take a photo -> show the staging step (no analysis yet)
photoInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  selectedFile = file;

  stagePreview.src = URL.createObjectURL(file);
  if (noteInput) noteInput.value = "";
  resultCard.classList.add("hidden");
  stageCard.classList.remove("hidden");
  photoInput.value = ""; // allow re-picking the same file later
  stageCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
});

// Cancel / retake
cancelBtn.addEventListener("click", () => {
  selectedFile = null;
  stageCard.classList.add("hidden");
});

// Step 2: confirm -> send photo + optional note for analysis
confirmBtn.addEventListener("click", async () => {
  if (!selectedFile) return;

  stageCard.classList.add("hidden");
  resultCard.classList.remove("hidden");
  fields.classList.add("hidden");
  preview.src = stagePreview.src;
  statusEl.classList.remove("error");
  statusEl.innerHTML = '<span class="spinner"></span>Analyzing your meal…';

  const form = new FormData();
  form.append("photo", selectedFile);
  const note = (noteInput?.value || "").trim();
  if (note) form.append("note", note);

  try {
    const resp = await fetch("/api/analyze", { method: "POST", body: form });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Analysis failed");

    $("r-desc").textContent = data.description;
    $("r-cal").textContent = Math.round(data.calories);
    $("r-p").textContent = Math.round(data.protein_g);
    $("r-c").textContent = Math.round(data.carbs_g);
    $("r-f").textContent = Math.round(data.fat_g);
    // photo is not stored; the local preview above is shown only for this session

    statusEl.textContent = "";
    fields.classList.remove("hidden");

    loadSummary();
    loadHistory();
    loadTrends();
  } catch (err) {
    statusEl.classList.add("error");
    statusEl.textContent = "⚠️ " + err.message;
  } finally {
    selectedFile = null;
    if (noteInput) noteInput.value = "";
  }
});

async function loadSummary() {
  try {
    const s = await (await fetch("/api/summary")).json();
    $("t-cal").textContent = Math.round(s.calories);
    $("t-p").textContent = Math.round(s.protein_g);
    $("t-c").textContent = Math.round(s.carbs_g);
    $("t-f").textContent = Math.round(s.fat_g);
    $("t-meals").textContent = s.meals;

    const burnedEl = $("t-burned"), netEl = $("t-net"), stateEl = $("t-state");
    if (s.burned == null) {
      burnedEl.textContent = "–";
      netEl.textContent = "–";
      netEl.className = "";
      stateEl.textContent = "no watch data yet";
      stateEl.className = "te-state muted";
    } else {
      burnedEl.textContent = Math.round(s.burned);
      const net = Math.round(s.net); // <0 = deficit
      netEl.textContent = (net > 0 ? "+" : "") + net;
      const deficit = net < 0;
      netEl.className = deficit ? "good" : net > 0 ? "bad" : "";
      stateEl.textContent = net === 0 ? "maintenance" : deficit ? "deficit" : "surplus";
      stateEl.className = "te-state " + (net === 0 ? "muted" : deficit ? "good" : "bad");
    }
  } catch {}
}

async function loadTrends() {
  const chart = $("tr-chart");
  try {
    // fetch 15 days so we can show 14 bars AND average the 14 completed days
    const rows = await (await fetch("/api/daily?days=15")).json();
    const byDay = {};
    for (const r of rows) byDay[r.day] = r;

    // build the last 15 local days (oldest -> newest); index 14 = today
    const days = [];
    const now = new Date();
    for (let i = 14; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const key = d.toLocaleDateString("en-CA");
      const r = byDay[key];
      days.push({
        date: d, key,
        cal: r ? Math.round(r.calories) : 0,
        p: r ? r.protein_g : 0, c: r ? r.carbs_g : 0, f: r ? r.fat_g : 0,
        meals: r ? r.meals : 0,
        burned: r && r.burned != null ? r.burned : null,
      });
    }

    const today = days[days.length - 1];
    const yesterday = days[days.length - 2];
    // Completed days only (exclude today) for all averages, so a partial day
    // doesn't drag the numbers down.
    const prior = days.slice(0, 14);     // 14 completed days before today
    const last7 = prior.slice(7);        // the 7 most recent completed days
    const prev7 = prior.slice(0, 7);     // the 7 before those

    // "logged day" = a completed day you ate something (calories > 0)
    const avgOf = (arr) => {
      const logged = arr.filter((d) => d.cal > 0);
      if (!logged.length) return null;
      return Math.round(logged.reduce((s, d) => s + d.cal, 0) / logged.length);
    };
    const avg7 = avgOf(last7);
    const avgPrev = avgOf(prev7);

    $("tr-avg").textContent = avg7 == null ? "–" : avg7;

    // trend chip vs the previous 7 completed days
    const chip = $("tr-chip");
    if (avg7 != null && avgPrev) {
      const pct = Math.round(((avg7 - avgPrev) / avgPrev) * 100);
      const up = pct > 0;
      chip.textContent = `${up ? "▲" : pct < 0 ? "▼" : "■"} ${Math.abs(pct)}% vs prev 7d`;
      chip.className = "trend-chip " + (pct === 0 ? "flat" : up ? "up" : "down");
    } else {
      chip.textContent = "";
      chip.className = "trend-chip";
    }

    // bar chart: last 14 days incl. today (today highlighted)
    const chartDays = days.slice(1);
    const max = Math.max(1, ...chartDays.map((d) => d.cal));
    chart.innerHTML = chartDays
      .map((d, i) => {
        const h = Math.round((d.cal / max) * 100);
        const isToday = i === chartDays.length - 1;
        const lbl = d.date.toLocaleDateString([], { weekday: "short" }).slice(0, 1);
        const full = d.date.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
        return `<div class="bar-col${isToday ? " today" : ""}" title="${full}: ${d.cal} kcal · ${d.meals} meal${d.meals === 1 ? "" : "s"}">
          <div class="bar-wrap"><div class="bar" style="height:${h}%"></div></div>
          <div class="bar-lbl">${lbl}</div>
        </div>`;
      })
      .join("");

    // footer: macros + net + burned summary, all over completed days
    const loggedLast7 = last7.filter((d) => d.cal > 0);
    const foot = $("tr-foot");
    if (loggedLast7.length) {
      const a = (k) => Math.round(loggedLast7.reduce((s, d) => s + d[k], 0) / loggedLast7.length);
      let txt = `Avg macros/day (last 7 days): P ${a("p")}g · C ${a("c")}g · F ${a("f")}g`;

      const withBurn = loggedLast7.filter((d) => d.burned != null);
      if (withBurn.length) {
        const avgNet = Math.round(
          withBurn.reduce((s, d) => s + (d.cal - d.burned), 0) / withBurn.length
        );
        const word = avgNet < 0 ? "deficit" : avgNet > 0 ? "surplus" : "maintenance";
        const cls = avgNet < 0 ? "good" : avgNet > 0 ? "bad" : "muted";
        txt += `<br><span class="${cls}">Avg net: ${avgNet > 0 ? "+" : ""}${avgNet} kcal/day (${word})</span>`;
      }
      foot.innerHTML = txt;
    } else {
      foot.textContent = "Log a few full days to see your weekly trend.";
    }

    // burned summary: yesterday + 7-day average (completed days with watch data)
    const burnEl = $("tr-burn");
    if (burnEl) {
      const burn7 = last7.filter((d) => d.burned != null);
      const avgBurn = burn7.length
        ? Math.round(burn7.reduce((s, d) => s + d.burned, 0) / burn7.length)
        : null;
      const yBurn = yesterday && yesterday.burned != null ? Math.round(yesterday.burned) : null;
      if (yBurn != null || avgBurn != null) {
        burnEl.innerHTML =
          `Burned yesterday: <b>${yBurn != null ? yBurn : "–"}</b> kcal` +
          ` · Avg burned (7d): <b>${avgBurn != null ? avgBurn : "–"}</b> kcal/day`;
      } else {
        burnEl.textContent = "";
      }
    }
  } catch {
    chart.innerHTML = '<div class="empty error">Could not load trends.</div>';
  }
}

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// "Today" / "Yesterday" / "Mon, 9 Jun" for a day's meals (local time)
function dayKey(iso) {
  return new Date(iso).toLocaleDateString("en-CA"); // YYYY-MM-DD in local time
}
function dayLabel(key) {
  const today = new Date().toLocaleDateString("en-CA");
  const y = new Date(Date.now() - 86400000).toLocaleDateString("en-CA");
  if (key === today) return "Today";
  if (key === y) return "Yesterday";
  const [yr, mo, da] = key.split("-").map(Number);
  return new Date(yr, mo - 1, da).toLocaleDateString([], {
    weekday: "short", day: "numeric", month: "short",
  });
}

async function loadHistory() {
  const wrap = $("history");
  try {
    const meals = await (await fetch("/api/meals")).json();
    if (!meals.length) {
      wrap.innerHTML = '<div class="empty">No meals logged yet.</div>';
      return;
    }

    mealsById = {};
    // group meals (already newest-first) by local day
    const groups = [];
    const byKey = {};
    for (const m of meals) {
      mealsById[m.id] = m;
      const k = dayKey(m.created_at);
      if (!byKey[k]) {
        byKey[k] = { key: k, meals: [], cal: 0, p: 0, c: 0, f: 0, mealCount: 0 };
        groups.push(byKey[k]);
      }
      const g = byKey[k];
      g.meals.push(m);
      g.cal += m.calories || 0;
      g.p += m.protein_g || 0;
      g.c += m.carbs_g || 0;
      g.f += m.fat_g || 0;
      if ((m.calories || 0) > MEAL_MIN_KCAL) g.mealCount += 1;
    }

    wrap.innerHTML = groups
      .map(
        (g) => `
      <div class="day-group">
        <div class="day-head">
          <span class="day-name">${dayLabel(g.key)}</span>
          <span class="day-total">${Math.round(g.cal)} kcal</span>
        </div>
        <div class="day-macros">P ${Math.round(g.p)}g · C ${Math.round(g.c)}g · F ${Math.round(g.f)}g · ${g.mealCount} meal${g.mealCount === 1 ? "" : "s"}</div>
        ${g.meals
          .map(
            (m) => `
          <div class="meal" data-id="${m.id}">
            <div class="meal-info">
              <div class="desc">${escapeHtml(m.description || "Meal")}</div>
              <div class="meta">${fmtTime(m.created_at)} · P${Math.round(m.protein_g)} C${Math.round(m.carbs_g)} F${Math.round(m.fat_g)}</div>
            </div>
            <div class="meal-cal">${Math.round(m.calories)}</div>
            <button class="del" title="Delete">✕</button>
          </div>`
          )
          .join("")}
      </div>`
      )
      .join("");

    wrap.querySelectorAll(".meal").forEach((row) => {
      row.addEventListener("click", (e) => {
        if (e.target.closest(".del")) return; // let delete handle itself
        openEdit(row.dataset.id);
      });
    });

    wrap.querySelectorAll(".del").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = e.target.closest(".meal").dataset.id;
        await fetch("/api/meals/" + id, { method: "DELETE" });
        loadSummary();
        loadHistory();
        loadTrends();
      });
    });
  } catch {
    wrap.innerHTML = '<div class="empty error">Could not load history.</div>';
  }
}

// ---- edit / re-analyse modal ----
function renderVals(m) {
  return `<span class="big">${Math.round(m.calories)}</span> kcal · P ${Math.round(m.protein_g)}g · C ${Math.round(m.carbs_g)}g · F ${Math.round(m.fat_g)}g`;
}

function openEdit(id) {
  const m = mealsById[id];
  if (!m) return;
  editingId = id;
  $("em-desc").textContent = m.description || "Meal";
  $("em-vals").innerHTML = renderVals(m);
  $("em-note").value = m.note || "";
  const st = $("em-status");
  st.textContent = "";
  st.className = "em-status";
  $("editModal").classList.remove("hidden");
}

function closeEdit() {
  $("editModal").classList.add("hidden");
  editingId = null;
}

async function reanalyse() {
  if (!editingId) return;
  const note = ($("em-note").value || "").trim();
  const st = $("em-status");
  st.className = "em-status";
  st.innerHTML = '<span class="spinner"></span>Re-analysing…';
  try {
    const resp = await fetch(`/api/meals/${editingId}/reanalyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Re-analysis failed");

    mealsById[editingId] = { ...mealsById[editingId], ...data };
    $("em-desc").textContent = data.description || "Meal";
    $("em-vals").innerHTML = renderVals(data);
    st.textContent = "Updated ✓";
    st.className = "em-status good";

    loadSummary();
    loadHistory();
    loadTrends();
  } catch (err) {
    st.textContent = "⚠️ " + err.message;
    st.className = "em-status error";
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// register service worker for PWA / add-to-home-screen
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// modal wiring
$("em-cancel").addEventListener("click", closeEdit);
$("em-reanalyse").addEventListener("click", reanalyse);
$("editModal").addEventListener("click", (e) => {
  if (e.target.id === "editModal") closeEdit(); // tap backdrop to close
});

loadSummary();
loadHistory();
loadTrends();
