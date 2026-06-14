const $ = (id) => document.getElementById(id);

const photoInput = $("photo");
const resultCard = $("result");
const preview = $("preview");
const statusEl = $("status");
const fields = $("fields");

photoInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  // show local preview immediately
  resultCard.classList.remove("hidden");
  fields.classList.add("hidden");
  preview.src = URL.createObjectURL(file);
  statusEl.classList.remove("error");
  statusEl.innerHTML = '<span class="spinner"></span>Analyzing your meal…';

  const form = new FormData();
  form.append("photo", file);

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
    photoInput.value = ""; // allow re-taking the same photo
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
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

async function loadHistory() {
  const wrap = $("history");
  try {
    const meals = await (await fetch("/api/meals")).json();
    if (!meals.length) {
      wrap.innerHTML = '<div class="empty">No meals logged yet.</div>';
      return;
    }
    wrap.innerHTML = meals
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
