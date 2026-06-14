const $ = (id) => document.getElementById(id);

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
  } catch {}
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

    // group meals (already newest-first) by local day
    const groups = [];
    const byKey = {};
    for (const m of meals) {
      const k = dayKey(m.created_at);
      if (!byKey[k]) {
        byKey[k] = { key: k, meals: [], cal: 0, p: 0, c: 0, f: 0 };
        groups.push(byKey[k]);
      }
      const g = byKey[k];
      g.meals.push(m);
      g.cal += m.calories || 0;
      g.p += m.protein_g || 0;
      g.c += m.carbs_g || 0;
      g.f += m.fat_g || 0;
    }

    wrap.innerHTML = groups
      .map(
        (g) => `
      <div class="day-group">
        <div class="day-head">
          <span class="day-name">${dayLabel(g.key)}</span>
          <span class="day-total">${Math.round(g.cal)} kcal</span>
        </div>
        <div class="day-macros">P ${Math.round(g.p)}g · C ${Math.round(g.c)}g · F ${Math.round(g.f)}g · ${g.meals.length} meal${g.meals.length > 1 ? "s" : ""}</div>
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

    wrap.querySelectorAll(".del").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        const id = e.target.closest(".meal").dataset.id;
        await fetch("/api/meals/" + id, { method: "DELETE" });
        loadSummary();
        loadHistory();
      });
    });
  } catch {
    wrap.innerHTML = '<div class="empty error">Could not load history.</div>';
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

loadSummary();
loadHistory();
