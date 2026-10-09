// Skunk — data is saved to your claude.ai account when published as an
// Artifact (the `db` capability), with localStorage as a fast local copy.
// Opened as a plain file, it falls back to localStorage only.

const STORAGE_KEY = "skunk-v2";

const state = load();
let weekOffset = 0; // 0 = this week, -1 = last week, ...
let editingHobbyId = null;
let selectedDay = null; // ISO date picked in the daily chart

// Mid-tone colors that read well on both light and dark backgrounds
const COLORS = ["#2f9e7d", "#3b7dd8", "#d9822b", "#c2477a", "#8a5cd1", "#c9a227", "#d4554a", "#3aa6b9"];

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { hobbies: [], sessions: [] };
}

// ---------- account sync ----------

let cloudDoc = null; // the viewer's private document, once connected
let writing = false;
let dirty = false;

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
  pushToCloud();
}

// One write at a time; edits made during a write are sent right after it
async function pushToCloud() {
  if (!cloudDoc) return;
  if (writing) {
    dirty = true;
    return;
  }
  writing = true;
  try {
    do {
      dirty = false;
      await cloudDoc.set({ hobbies: state.hobbies, sessions: state.sessions });
    } while (dirty);
    setSyncStatus("synced");
  } catch (e) {
    setSyncStatus(e?.code === "quota_exceeded" ? "full" : "error");
  } finally {
    writing = false;
  }
}

function setSyncStatus(status) {
  const text = {
    local: "Saved on this device only. Export a backup now and then.",
    synced: "Saved to your claude.ai account. It's there on any device you sign in on.",
    error: "Couldn't reach your account just now. Your changes are saved on this device and will sync when you make the next change.",
    full: "Your account storage for Skunk is full. Export a backup and delete old sessions.",
  }[status];
  $("#sync-status").textContent = text;
}

async function connectCloud() {
  const [db, user] = await Promise.all([claude.use("db"), claude.use("user")]);
  const id = db && user ? await user.id() : null;
  if (!id) return;
  const ref = db.doc(`data/users/${id}/skunk`);

  // Bring this device's data along the first time the account is empty
  const first = await ref.get().catch(() => null);
  if (!first) return;
  cloudDoc = ref;
  if (!first.exists && (state.hobbies.length || state.sessions.length)) await pushToCloud();
  setSyncStatus("synced");

  ref.onSnapshot((snap) => {
    if (!snap.exists || writing || dirty) return;
    const data = snap.data();
    state.hobbies = structuredClone(data.hobbies || []);
    state.sessions = structuredClone(data.sessions || []);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {}
    render();
  });
}

// ---------- helpers ----------

const $ = (sel) => document.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const money = (n) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: n % 1 ? 2 : 0 });
const hobbyById = (id) => state.hobbies.find((h) => h.id === id);
const colorOf = (h) => h?.color || "#8a8a92";
const isSkunk = (h) => h?.kind === "skunk";
const goodHobbies = () => state.hobbies.filter((h) => !isSkunk(h));
const skunks = () => state.hobbies.filter(isSkunk);
const iconHtml = (h) =>
  `<span class="icon" style="--c:${colorOf(h)}">${escapeHtml(h?.emoji || "")}</span>`;

// First color no other hobby is using yet (cycles once all are taken)
function nextColor() {
  const used = state.hobbies.map((h) => h.color);
  return COLORS.find((c) => !used.includes(c)) || COLORS[state.hobbies.length % COLORS.length];
}
const totalMin = (list) => list.reduce((t, s) => t + s.minutes, 0);
const totalCost = (list) => list.reduce((t, s) => t + (s.cost || 0), 0);
const byDateDesc = (a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id);
const sessionsOf = (list, hobbies) => {
  const ids = new Set(hobbies.map((h) => h.id));
  return list.filter((s) => ids.has(s.hobbyId));
};

function hobbyOptions() {
  const opts = (list) =>
    list.map((h) => `<option value="${h.id}">${escapeHtml(h.emoji || "")} ${escapeHtml(h.name)}</option>`).join("");
  const good = goodHobbies();
  const bad = skunks();
  return (
    (good.length ? `<optgroup label="Hobbies">${opts(good)}</optgroup>` : "") +
    (bad.length ? `<optgroup label="🦨 Skunks">${opts(bad)}</optgroup>` : "")
  );
}

function duration(min) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const today = () => isoDate(new Date());

function parseDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// Weeks run Monday–Sunday. Returns { start, end } as ISO date strings.
function weekRange(offset) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset * 7);
  const end = new Date(d);
  end.setDate(d.getDate() + 6);
  return { start: isoDate(d), end: isoDate(end) };
}

const inRange = (s, { start, end }) => s.date >= start && s.date <= end;

function prettyDate(iso, opts = { weekday: "short", month: "short", day: "numeric" }) {
  return parseDate(iso).toLocaleDateString(undefined, opts);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// In-page confirmation sheet (browser confirm() dialogs don't show inside Artifacts)
function askConfirm(message, okLabel = "Delete") {
  return new Promise((resolve) => {
    const sheet = $("#confirm");
    $("#confirm-text").textContent = message;
    $("#confirm-ok").textContent = okLabel;
    sheet.hidden = false;
    const done = (answer) => {
      sheet.hidden = true;
      sheet.onclick = null;
      resolve(answer);
    };
    sheet.onclick = (ev) => {
      if (ev.target.id === "confirm-ok") done(true);
      else if (ev.target.id === "confirm-cancel" || ev.target === sheet) done(false);
    };
  });
}

function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), 1800);
}

// ---------- navigation ----------

const TITLES = { week: "This week", hobbies: "Hobbies", log: "Log time", history: "History" };

function show(view) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $("#view-title").textContent = view === "week" ? weekTitle() : TITLES[view];
  window.scrollTo(0, 0);
}

document.querySelectorAll(".tabbar button").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));

function weekTitle() {
  if (weekOffset === 0) return "This week";
  if (weekOffset === -1) return "Last week";
  return `${-weekOffset} weeks ago`;
}

// ---------- rendering ----------

function sessionRow(s) {
  const h = hobbyById(s.hobbyId);
  const sub = [prettyDate(s.date), s.cost ? money(s.cost) : "", s.note].filter(Boolean).map(escapeHtml).join(" · ");
  return `
    <li>
      ${iconHtml(h)}
      <div class="main">
        <div class="title">${escapeHtml(h?.name || "Deleted hobby")}${isSkunk(h) ? ' <span class="tag">skunk</span>' : ""}</div>
        <div class="sub">${sub}</div>
      </div>
      <span class="amt">${duration(s.minutes)}</span>
      <button class="icon-btn" data-del-session="${s.id}" aria-label="Delete session">✕</button>
    </li>`;
}

function renderWeek() {
  const range = weekRange(weekOffset);
  const week = state.sessions.filter((s) => inRange(s, range));

  $("#week-label").textContent =
    `${prettyDate(range.start, { month: "short", day: "numeric" })} – ${prettyDate(range.end, { month: "short", day: "numeric" })}`;
  $("#next-week").disabled = weekOffset >= 0;
  if ($("#view-week").classList.contains("active")) $("#view-title").textContent = weekTitle();

  const goodWeek = sessionsOf(week, goodHobbies());
  const skunkWeek = sessionsOf(week, skunks());
  const goodMin = totalMin(goodWeek);
  const skunkMin = totalMin(skunkWeek);
  $("#stat-good").textContent = duration(goodMin);
  $("#stat-skunk").textContent = duration(skunkMin);

  // Scoreboard: hobbies vs skunks
  const spent = totalCost(goodWeek);
  const wasted = totalCost(skunkWeek);
  $("#money-good").textContent = spent ? `${money(spent)} spent` : "";
  $("#money-skunk").textContent = wasted ? `${money(wasted)} wasted` : "";

  const both = goodMin + skunkMin;
  const goodPct = both ? Math.round((goodMin / both) * 100) : 50;
  $("#balance-good").style.width = `${goodPct}%`;
  $("#balance-skunk").style.width = `${100 - goodPct}%`;
  $(".scoreboard").classList.toggle("empty-score", both === 0);

  const gap = duration(Math.abs(goodMin - skunkMin));
  let verdict = "It's a tie";
  let tone = "";
  if (!both) verdict = "No time logged yet";
  else if (goodMin > skunkMin) [verdict, tone] = [`Hobbies are winning by ${gap}`, "good"];
  else if (skunkMin > goodMin) [verdict, tone] = [`Skunks are winning by ${gap}`, "skunk"];
  $("#score-verdict").textContent = verdict;
  $("#score-verdict").className = `score-verdict ${tone}`;

  renderDaily(range, week);
  renderNudge(range, skunkMin, totalCost(skunkWeek), goodWeek);

  $("#breakdown").innerHTML = goodHobbies().length
    ? breakdownRows(goodHobbies(), week, "goal")
    : `<p class="empty">No hobbies yet. Add one on the Hobbies tab.</p>`;
  $("#skunk-title").hidden = skunks().length === 0;
  $("#skunk-breakdown").innerHTML = breakdownRows(skunks(), week, "limit");

  // 8 weeks ending at the selected week; good hobbies stack on the bottom, skunks striped on top
  const weeks = [];
  for (let i = 7; i >= 0; i--) {
    const r = weekRange(weekOffset - i);
    const sessions = state.sessions.filter((s) => inRange(s, r));
    const parts = [...skunks(), ...goodHobbies()]
      .map((h) => ({ color: colorOf(h), skunk: isSkunk(h), min: totalMin(sessions.filter((s) => s.hobbyId === h.id)) }))
      .filter((p) => p.min);
    weeks.push({ r, parts, min: totalMin(sessions), current: i === 0 });
  }
  const tMax = Math.max(1, ...weeks.map((w) => w.min));
  $("#trend").innerHTML = weeks
    .map(
      (w) => `
      <div class="trend-col ${w.current ? "current" : ""}">
        <span class="trend-val">${w.min ? duration(w.min) : ""}</span>
        <div class="trend-bar">${w.parts
          .map(
            (p) =>
              `<span class="${p.skunk ? "striped" : ""}" style="height:${(p.min / tMax) * 100}%;--c:${p.color}"></span>`
          )
          .join("")}</div>
        <span class="trend-label">${prettyDate(w.r.start, { month: "numeric", day: "numeric" })}</span>
      </div>`
    )
    .join("");

  $("#sessions-title").hidden = week.length === 0;
  $("#week-list").innerHTML = [...week].sort(byDateDesc).map(sessionRow).join("");
}

// Time per hobby for the week. For hobbies `goal` is a target; for skunks it's a limit.
function breakdownRows(hobbies, week, mode) {
  const rows = hobbies
    .map((h) => {
      const mine = week.filter((s) => s.hobbyId === h.id);
      return { h, min: totalMin(mine), cost: totalCost(mine) };
    })
    .sort((a, b) => b.min - a.min);
  const max = Math.max(1, ...rows.map((r) => r.min));

  return rows
    .map(({ h, min, cost }) => {
      const goalMin = (h.goal || 0) * 60;
      const pct = goalMin ? Math.min(100, (min / goalMin) * 100) : (min / max) * 100;
      const target = goalMin ? `<span class="budget"> / ${duration(goalMin)}</span>` : "";
      const over = mode === "limit" && goalMin && min > goalMin;
      const badge = mode === "goal" ? (goalMin && min >= goalMin ? " ✅" : "") : over ? ' <span class="over">over limit</span>' : "";
      const costText = mode === "limit" && cost ? `<span class="budget"> · ${money(cost)}</span>` : "";
      return `
        <li>
          <div class="row">
            <span>${escapeHtml(h.emoji || "")} ${escapeHtml(h.name)}${badge}</span>
            <span class="amt">${duration(min)}${target}${costText}</span>
          </div>
          <div class="bar ${over ? "over" : ""}"><span style="width:${pct}%;background:${over ? "var(--danger)" : colorOf(h)}"></span></div>
        </li>`;
    })
    .join("");
}

// Grid-line spacing that gives at most 4 lines for the busiest day
function axisStep(maxMin) {
  return [15, 30, 60, 120, 180, 240, 360, 480].find((step) => maxMin / step <= 4) || 720;
}

// Screen Time–style chart: one column per day, height = actual time, split by hobby
function renderDaily(range, week) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = parseDate(range.start);
    d.setDate(d.getDate() + i);
    const date = isoDate(d);
    const sessions = week.filter((s) => s.date === date);
    days.push({ date, sessions, min: totalMin(sessions) });
  }

  const now = today();
  if (!days.some((d) => d.date === selectedDay)) selectedDay = days.some((d) => d.date === now) ? now : null;

  const maxMin = Math.max(...days.map((d) => d.min));
  const step = axisStep(maxMin || 60);
  const top = Math.max(step, Math.ceil(maxMin / step) * step);
  const pct = (min) => (min / top) * 100;

  const lines = [];
  for (let m = 0; m <= top; m += step) {
    lines.push(`<div class="grid-line" style="bottom:${pct(m)}%"><span>${m ? duration(m) : "0"}</span></div>`);
  }

  const logged = days.filter((d) => d.date <= now);
  const avg = logged.length ? totalMin(week) / logged.length : 0;
  const avgLine = avg
    ? `<div class="avg-line" style="bottom:${pct(avg)}%"><span>avg</span></div>`
    : "";

  // Good hobbies on the bottom, skunks striped on top
  const order = [...skunks(), ...goodHobbies()];
  const cols = days
    .map((d) => {
      const segs = order
        .map((h) => ({ h, min: totalMin(d.sessions.filter((s) => s.hobbyId === h.id)) }))
        .filter((p) => p.min)
        .map(
          ({ h, min }) =>
            `<span class="${isSkunk(h) ? "striped" : ""}" style="height:${pct(min)}%;--c:${colorOf(h)}"></span>`
        )
        .join("");
      const cls = [d.date === selectedDay && "selected", d.date > now && "future"].filter(Boolean).join(" ");
      return `<button class="daily-col ${cls}" data-day="${d.date}" aria-label="${prettyDate(d.date)}: ${duration(d.min)}">${segs}</button>`;
    })
    .join("");

  $("#daily-chart").innerHTML = `${lines.join("")}${avgLine}<div class="daily-cols">${cols}</div>`;
  $("#daily-days").innerHTML = days
    .map((d) => {
      const cls = [d.date === selectedDay && "selected", d.date === now && "today"].filter(Boolean).join(" ");
      return `<span class="${cls}">${prettyDate(d.date, { weekday: "narrow" })}</span>`;
    })
    .join("");

  // Breakdown for the selected day, or the weekly average
  const day = days.find((d) => d.date === selectedDay);
  if (!day) {
    $("#day-detail").innerHTML = `<p class="hint">Daily average ${duration(avg)} · tap a day for details</p>`;
    return;
  }
  const rows = state.hobbies
    .map((h) => ({ h, min: totalMin(day.sessions.filter((s) => s.hobbyId === h.id)) }))
    .filter((r) => r.min)
    .sort((a, b) => b.min - a.min)
    .map(
      ({ h, min }) => `
        <li>
          <span class="dot" style="--c:${colorOf(h)}"></span>
          <span class="name">${escapeHtml(h.emoji || "")} ${escapeHtml(h.name)}${isSkunk(h) ? ' <span class="tag">skunk</span>' : ""}</span>
          <span class="amt">${duration(min)}</span>
        </li>`
    )
    .join("");
  $("#day-detail").innerHTML = `
    <div class="day-head">
      <span>${prettyDate(day.date, { weekday: "long", month: "short", day: "numeric" })}</span>
      <span class="amt">${duration(day.min)}</span>
    </div>
    ${rows ? `<ul class="day-rows">${rows}</ul>` : `<p class="hint">Nothing logged${day.date > now ? " yet" : ""}.</p>`}`;
}

// Turns skunk time into something concrete: what it could have done for your real hobbies
function renderNudge(range, skunkMin, skunkCost, goodWeek) {
  const nudge = $("#nudge");
  nudge.hidden = skunkMin === 0;
  if (!skunkMin) return;

  const when = weekOffset === 0 ? "this week" : "that week";
  const lines = [];
  lines.push(
    `<strong>Skunks took ${duration(skunkMin)}${skunkCost ? ` and ${money(skunkCost)}` : ""} ${when}.</strong>`
  );

  // Hobby furthest behind its goal, otherwise the one with the least time
  const good = goodHobbies().map((h) => {
    const min = totalMin(goodWeek.filter((s) => s.hobbyId === h.id));
    return { h, min, left: Math.max(0, (h.goal || 0) * 60 - min) };
  });
  const behind = good.filter((g) => g.left > 0).sort((a, b) => b.left - a.left)[0];
  const neglected = [...good].sort((a, b) => a.min - b.min)[0];
  const name = (h) => `${escapeHtml(h.emoji || "")} ${escapeHtml(h.name)}`.trim();

  if (behind && skunkMin >= behind.left) {
    lines.push(`That was enough to finish your ${name(behind.h)} goal (${duration(behind.left)} left).`);
  } else if (behind) {
    lines.push(`That could have covered ${duration(skunkMin)} of the ${duration(behind.left)} left on your ${name(behind.h)} goal.`);
  } else if (neglected) {
    lines.push(`That's ${duration(skunkMin)} you could put into ${name(neglected.h)} instead.`);
  } else {
    lines.push("Add a real hobby to put that time toward.");
  }

  // Compare with the week before
  const prev = weekRange(weekOffset - 1);
  const prevMin = totalMin(sessionsOf(state.sessions.filter((s) => inRange(s, prev)), skunks()));
  if (prevMin && skunkMin < prevMin) lines.push(`👏 ${duration(prevMin - skunkMin)} less than the week before.`);
  else if (prevMin && skunkMin > prevMin) lines.push(`${duration(skunkMin - prevMin)} more than the week before.`);

  nudge.innerHTML = lines.map((l) => `<p>${l}</p>`).join("");
}

function hobbyListRows(hobbies) {
  return hobbies
    .map((h) => {
      const mine = state.sessions.filter((s) => s.hobbyId === h.id);
      const parts = [`${duration(totalMin(mine))} total`];
      if (h.goal) parts.push(`${isSkunk(h) ? "limit" : "goal"} ${duration(h.goal * 60)}/wk`);
      if (totalCost(mine)) parts.push(isSkunk(h) ? `${money(totalCost(mine))} wasted` : money(totalCost(mine)));
      return `
        <li>
          ${iconHtml(h)}
          <div class="main">
            <div class="title">${escapeHtml(h.name)}</div>
            <div class="sub">${parts.join(" · ")}</div>
          </div>
          <button class="icon-btn" data-edit-hobby="${h.id}" aria-label="Edit hobby">✎</button>
          <button class="icon-btn" data-del-hobby="${h.id}" aria-label="Delete hobby">✕</button>
        </li>`;
    })
    .join("");
}

function renderHobbies() {
  $("#hobby-list").innerHTML = hobbyListRows(goodHobbies());
  $("#skunk-list").innerHTML = hobbyListRows(skunks());
  $("#hobby-empty").hidden = goodHobbies().length > 0;
  $("#skunk-empty").hidden = skunks().length > 0;
}

function renderSwatches(selected) {
  $("#swatches").innerHTML = COLORS.map(
    (c) => `
      <label class="swatch" style="--c:${c}">
        <input type="radio" name="color" value="${c}" ${c === selected ? "checked" : ""} aria-label="Color ${c}" />
      </label>`
  ).join("");
}

// Labels change depending on whether the form is for a hobby or a skunk
function updateKindLabels() {
  const skunk = $("#hobby-form").kind.value === "skunk";
  const noun = skunk ? "skunk" : "hobby";
  $("#goal-label").textContent = skunk ? "Weekly limit in hours (optional)" : "Weekly goal in hours (optional)";
  if (!editingHobbyId) {
    $("#hobby-form-title").textContent = `Add a ${noun}`;
    $("#hobby-submit").textContent = `Add ${noun}`;
  }
  $("#hobby-form").name.placeholder = skunk ? "Scrolling" : "Guitar";
}

function resetHobbyForm() {
  editingHobbyId = null;
  const f = $("#hobby-form");
  f.reset();
  renderSwatches(nextColor());
  $("#hobby-cancel").hidden = true;
  updateKindLabels();
}

function editHobby(id) {
  const h = hobbyById(id);
  if (!h) return;
  editingHobbyId = id;
  const f = $("#hobby-form");
  f.emoji.value = h.emoji || "";
  f.name.value = h.name;
  f.goal.value = h.goal || "";
  f.kind.value = isSkunk(h) ? "skunk" : "good";
  updateKindLabels();
  renderSwatches(colorOf(h));
  $("#hobby-form-title").textContent = `Edit ${h.name}`;
  $("#hobby-submit").textContent = "Save changes";
  $("#hobby-cancel").hidden = false;
  f.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderLogForm() {
  const select = $("#session-form select[name=hobbyId]");
  const current = select.value;
  select.innerHTML = hobbyOptions();
  if (current && hobbyById(current)) select.value = current;
  const none = state.hobbies.length === 0;
  $("#no-hobby-hint").hidden = !none;
  $("#session-form button[type=submit]").disabled = none;
  const date = $("#session-form input[name=date]");
  if (!date.value) date.value = today();
}

function renderHistory() {
  const filter = $("#history-filter");
  const current = filter.value || "all";
  filter.innerHTML =
    `<option value="all">Everything</option><option value="good">All hobbies</option><option value="skunk">All skunks</option>` +
    hobbyOptions();
  filter.value = ["all", "good", "skunk"].includes(current) || hobbyById(current) ? current : "all";

  const groups = { all: state.hobbies, good: goodHobbies(), skunk: skunks() };
  const list = sessionsOf(state.sessions, groups[filter.value] || [hobbyById(filter.value)]).sort(byDateDesc);
  $("#history-totals").textContent = list.length
    ? `${list.length} sessions · ${duration(totalMin(list))} · ${money(totalCost(list))}`
    : "";
  $("#history-list").innerHTML = list.length
    ? list.map(sessionRow).join("")
    : `<li><p class="empty" style="width:100%">No sessions yet.</p></li>`;
}

function render() {
  renderWeek();
  renderHobbies();
  renderLogForm();
  renderHistory();
}

// ---------- actions ----------

$("#prev-week").addEventListener("click", () => {
  weekOffset--;
  selectedDay = null;
  renderWeek();
});

$("#next-week").addEventListener("click", () => {
  if (weekOffset < 0) weekOffset++;
  selectedDay = null;
  renderWeek();
});

$("#daily-chart").addEventListener("click", (ev) => {
  const col = ev.target.closest(".daily-col");
  if (!col) return;
  selectedDay = col.dataset.day;
  renderWeek();
});

$("#quick-time").addEventListener("click", (ev) => {
  const min = Number(ev.target.dataset.min);
  if (!min) return;
  const f = $("#session-form");
  f.hours.value = Math.floor(min / 60) || "";
  f.minutes.value = min % 60 || "";
});

$("#hobby-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const fields = {
    name: f.get("name").trim(),
    emoji: f.get("emoji").trim(),
    goal: parseFloat(f.get("goal")) || 0,
    color: f.get("color") || nextColor(),
    kind: f.get("kind") === "skunk" ? "skunk" : "good",
  };
  const existing = hobbyById(editingHobbyId);
  if (existing) Object.assign(existing, fields);
  else state.hobbies.push({ id: uid(), ...fields });
  save();
  resetHobbyForm();
  render();
  const noun = fields.kind === "skunk" ? "Skunk" : "Hobby";
  toast(existing ? `${noun} updated` : `${noun} added`);
});

$("#session-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const minutes = (parseInt(f.get("hours")) || 0) * 60 + (parseInt(f.get("minutes")) || 0);
  if (minutes <= 0) {
    toast("Enter how long you spent");
    return;
  }
  state.sessions.push({
    id: uid(),
    hobbyId: f.get("hobbyId"),
    date: f.get("date"),
    minutes,
    cost: parseFloat(f.get("cost")) || 0,
    note: f.get("note").trim(),
  });
  save();
  for (const name of ["hours", "minutes", "cost", "note"]) ev.target[name].value = "";
  // Jump to the week the session was logged in
  const daysFromThisWeek = Math.round((parseDate(f.get("date")) - parseDate(weekRange(0).start)) / 864e5);
  weekOffset = Math.min(0, Math.floor(daysFromThisWeek / 7));
  selectedDay = f.get("date");
  render();
  toast(`Logged ${duration(minutes)}`);
  show("week");
});

$("#hobby-cancel").addEventListener("click", resetHobbyForm);

$("#hobby-form").addEventListener("change", (ev) => {
  if (ev.target.name === "kind") updateKindLabels();
});

$("#history-filter").addEventListener("change", renderHistory);

document.addEventListener("click", async (ev) => {
  const sessionId = ev.target.dataset?.delSession;
  const hobbyId = ev.target.dataset?.delHobby;
  if (ev.target.dataset?.editHobby) return editHobby(ev.target.dataset.editHobby);
  if (sessionId) {
    if (!(await askConfirm("Delete this session?"))) return;
    state.sessions = state.sessions.filter((s) => s.id !== sessionId);
  } else if (hobbyId) {
    const h = hobbyById(hobbyId);
    if (!(await askConfirm(`Delete ${h?.name || "this hobby"} and all its sessions?`))) return;
    state.hobbies = state.hobbies.filter((x) => x.id !== hobbyId);
    state.sessions = state.sessions.filter((s) => s.hobbyId !== hobbyId);
    if (editingHobbyId === hobbyId) resetHobbyForm();
  } else {
    return;
  }
  save();
  render();
});

$("#export-btn").addEventListener("click", async () => {
  const filename = `skunk-${today()}.json`;
  const json = JSON.stringify(state, null, 2);
  const downloads = window.claude ? await claude.use("downloads") : null;
  if (downloads) {
    try {
      await downloads.save({ filename, data: json });
    } catch (e) {
      if (e?.code !== "declined") toast("Couldn't export right now");
    }
    return;
  }
  // On phones, the share sheet lets you save the backup to Files
  const file = new File([json], filename, { type: "application/json" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch {}
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
});

$("#import-input").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.hobbies) || !Array.isArray(data.sessions)) throw new Error();
    if (!(await askConfirm("Replace your current data with this backup?", "Replace"))) return;
    state.hobbies = data.hobbies;
    state.sessions = data.sessions;
    save();
    resetHobbyForm();
    render();
    toast("Backup imported");
  } catch {
    toast("That file isn't a Skunk backup");
  } finally {
    ev.target.value = "";
  }
});

// Hobbies created before colors existed get one now
if (state.hobbies.some((h) => !h.color)) {
  for (const h of state.hobbies) if (!h.color) h.color = nextColor();
  save();
}

resetHobbyForm();
render();
setSyncStatus("local");
if (window.claude) connectCloud().catch(() => {});
else if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
