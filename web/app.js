"use strict";

// ------------------------------------------------------------------ util
const $ = (s, el = document) => el.querySelector(s);
const h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const api = (path, body) => fetch(path, {
  method: body === undefined ? "GET" : "POST",
  headers: { "X-Token": window.TOKEN, "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then((r) => r.json());
const uid = () => Math.random().toString(36).slice(2, 10);
const native = (msg) => window.webkit?.messageHandlers?.mw?.postMessage(msg);
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const CELL = 164, GAP = 18, TOP = 84;
const SIZES = { s: [1, 1], m: [2, 1], l: [2, 2] };
let visible = true;

// ------------------------------------------------------------------ estado
let state = { widgets: [] };
let saveTimer;
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => api("/api/config", state), 300); };

const DEFAULT = [
  { type: "clock", size: "m", col: 0, row: 0 },
  { type: "quotes", size: "l", col: 0, row: 1, opts: { codes: ["USD", "EUR", "BTC", "GBP"] } },
  { type: "photos", size: "l", col: 2, row: 0 },
  { type: "spotify", size: "m", col: 2, row: 2 },
  { type: "youtube", size: "l", col: 4, row: 0 },
  { type: "system", size: "m", col: 4, row: 2 },
  { type: "ai", size: "l", col: 6, row: 0 },
  { type: "calendar", size: "s", col: 6, row: 2 },
  { type: "notes", size: "s", col: 7, row: 2 },
];

// ------------------------------------------------------------------ grade
function grid() {
  const cols = Math.max(2, Math.floor((innerWidth - 80 + GAP) / (CELL + GAP)));
  const used = Math.max(...state.widgets.map((w) => w.col + SIZES[w.size][0]), 0);
  const span = Math.min(cols, Math.max(used, 1));
  const x0 = Math.round((innerWidth - (span * (CELL + GAP) - GAP)) / 2);
  return { cols, rows: Math.max(1, Math.floor((innerHeight - TOP - 20 + GAP) / (CELL + GAP))), x0 };
}
const px = (col, row, g = grid()) => [g.x0 + col * (CELL + GAP), TOP + row * (CELL + GAP)];

function overlaps(a, col, row, size) {
  const [w, hh] = SIZES[size];
  return state.widgets.some((b) => {
    if (b === a) return false;
    const [bw, bh] = SIZES[b.size];
    return col < b.col + bw && b.col < col + w && row < b.row + bh && b.row < row + hh;
  });
}
function fits(a, col, row, size, g = grid()) {
  const [w] = SIZES[size];
  return col >= 0 && row >= 0 && col + w <= g.cols && !overlaps(a, col, row, size);
}
function findFree(a, size) {
  const g = grid();
  for (let row = 0; row < 50; row++)
    for (let col = 0; col < g.cols; col++)
      if (fits(a, col, row, size, g)) return [col, row];
  return [0, 0];
}

// ------------------------------------------------------------------ widgets
const mounted = new Map(); // id -> {el, inst}

function render() {
  const board = $("#board");
  const ids = new Set(state.widgets.map((w) => w.id));
  for (const [id, m] of mounted) if (!ids.has(id)) { m.inst?.destroy?.(); m.el.remove(); mounted.delete(id); }
  for (const w of state.widgets) {
    let m = mounted.get(w.id);
    if (!m || m.size !== w.size) {
      m?.inst?.destroy?.(); m?.el.remove();
      m = mount(w);
      board.appendChild(m.el);
      mounted.set(w.id, m);
    }
    place(m.el, w);
  }
}

function place(el, w) {
  const [x, y] = px(w.col, w.row);
  const [cw, ch] = SIZES[w.size];
  Object.assign(el.style, { left: x + "px", top: y + "px", width: cw * CELL + (cw - 1) * GAP + "px", height: ch * CELL + (ch - 1) * GAP + "px" });
}

function mount(w) {
  const T = TYPES[w.type];
  w.opts ??= {};
  const el = h(`<div class="widget w-${w.type} ${w.size}" data-id="${w.id}">
    <div class="body"></div>
    <button class="w-ctrl w-remove" title="Remover">−</button>
    ${T.settings?.(w) ? '<button class="w-ctrl w-gear" title="Configurar">⚙</button>' : ""}
    <div class="w-sizes">${T.sizes.map((s) => `<button data-s="${s}" class="${s === w.size ? "on" : ""}">${s.toUpperCase()}</button>`).join("")}</div>
  </div>`);
  el.querySelector(".w-remove").onclick = (e) => { e.stopPropagation(); state.widgets = state.widgets.filter((x) => x !== w); render(); save(); };
  el.querySelector(".w-gear")?.addEventListener("click", (e) => { e.stopPropagation(); openSettings(w); });
  el.querySelectorAll(".w-sizes button").forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    const s = b.dataset.s;
    if (s === w.size) return;
    if (!fits(w, w.col, w.row, s)) {
      const [c, r] = findFree(w, s);
      w.col = c; w.row = r;
    }
    w.size = s; render(); save();
  });
  el.addEventListener("pointerdown", (e) => startDrag(e, w, el));
  const inst = T.mount(el.querySelector(".body"), w, el);
  return { el, inst, size: w.size };
}

const remount = (w) => { const m = mounted.get(w.id); if (m) m.size = null; render(); };

// ------------------------------------------------------------------ arrastar (modo edição)
function startDrag(e, w, el) {
  if (!document.body.classList.contains("editing") || e.target.closest(".w-ctrl, .w-sizes")) return;
  e.preventDefault();
  const ghost = $("#ghost"), board = $("#board");
  const g = grid();
  const r = el.getBoundingClientRect();
  const dx = e.clientX - r.left, dy = e.clientY - r.top;
  let target = [w.col, w.row];
  el.classList.add("dragging");
  el.setPointerCapture(e.pointerId);
  Object.assign(ghost.style, { display: "block", width: el.style.width, height: el.style.height });
  const move = (ev) => {
    const x = ev.clientX - dx, y = ev.clientY - dy + board.scrollTop;
    el.style.left = x + "px"; el.style.top = y + "px";
    const col = Math.round((x - g.x0) / (CELL + GAP)), row = Math.round((y - TOP) / (CELL + GAP));
    target = [col, row];
    const [gx, gy] = px(col, row, g);
    ghost.style.left = gx + "px"; ghost.style.top = gy + "px";
    ghost.classList.toggle("bad", !fits(w, col, row, w.size, g));
  };
  const up = () => {
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.classList.remove("dragging");
    ghost.style.display = "none";
    if (fits(w, target[0], target[1], w.size, g)) { [w.col, w.row] = target; save(); }
    render();
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
}

// ------------------------------------------------------------------ tipos
const TYPES = {};
const tickers = new Set();
const every = (ms, fn, immediate = true) => {
  const t = { ms, fn, last: 0 };
  if (immediate) { fn(); t.last = Date.now(); }
  tickers.add(t);
  return () => tickers.delete(t);
};
setInterval(() => {
  if (!visible) return;
  const now = Date.now();
  for (const t of tickers) if (now - t.last >= t.ms) { t.last = now; try { t.fn(); } catch (e) { console.error(e); } }
}, 250);

// ---- relógio
const ZONES = {
  "America/Sao_Paulo": "São Paulo", "America/New_York": "Nova York", "Europe/Lisbon": "Lisboa",
  "Europe/London": "Londres", "Europe/Paris": "Paris", "Asia/Tokyo": "Tóquio",
  "America/Los_Angeles": "Los Angeles", "Asia/Dubai": "Dubai", "Australia/Sydney": "Sydney",
};
TYPES.clock = {
  name: "Relógio", desc: "Hora e fusos", icon: "🕐", color: "#1c1c1e", sizes: ["s", "m", "l"], def: "m",
  mount(body, w) {
    if (w.size === "s") {
      const ticks = Array.from({ length: 12 }, (_, i) => {
        const a = (i * 30 - 60) * Math.PI / 180, r = 39;
        return `<text x="${50 + r * Math.cos(a)}" y="${50 + r * Math.sin(a) + 4}" text-anchor="middle" font-size="11" font-weight="600" fill="#1c1c1e">${i + 1}</text>`;
      }).join("");
      body.innerHTML = `<svg class="clock-analog" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="49" fill="#f5f5f7"/>${ticks}
        <line id="hh" x1="50" y1="50" x2="50" y2="28" stroke="#1c1c1e" stroke-width="3.6" stroke-linecap="round"/>
        <line id="mm" x1="50" y1="50" x2="50" y2="16" stroke="#1c1c1e" stroke-width="2.6" stroke-linecap="round"/>
        <line id="ss" x1="50" y1="58" x2="50" y2="13" stroke="#ff9f0a" stroke-width="1.2" stroke-linecap="round"/>
        <circle cx="50" cy="50" r="2.6" fill="#ff9f0a"/></svg>`;
      body.style.padding = "10px";
      const [hh, mm, ss] = ["#hh", "#mm", "#ss"].map((s) => $(s, body));
      return { destroy: every(1000, () => {
        const d = new Date(), s = d.getSeconds(), m = d.getMinutes() + s / 60, hr = (d.getHours() % 12) + m / 60;
        hh.setAttribute("transform", `rotate(${hr * 30} 50 50)`);
        mm.setAttribute("transform", `rotate(${m * 6} 50 50)`);
        ss.setAttribute("transform", `rotate(${s * 6} 50 50)`);
      }) };
    }
    const zones = w.opts.zones ?? ["America/New_York", "Europe/Lisbon", "Asia/Tokyo"];
    body.innerHTML = `<div class="clock-city">${esc((() => { const z = Intl.DateTimeFormat().resolvedOptions().timeZone; return ZONES[z] ?? z.split("/").pop().replace(/_/g, " "); })())}</div>
      <div class="clock-digital"><span class="t"></span><span class="s"></span><div class="d"></div></div>
      ${w.size === "l" ? `<div class="world">${zones.map((z) => `<div><b data-z="${z}"></b><span>${ZONES[z] ?? z}</span></div>`).join("")}</div>` : ""}`;
    const t = $(".t", body), s = $(".s", body), d = $(".d", body);
    return { destroy: every(1000, () => {
      const now = new Date();
      t.textContent = now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      s.textContent = ":" + String(now.getSeconds()).padStart(2, "0");
      d.textContent = now.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
      body.querySelectorAll("[data-z]").forEach((b) => b.textContent = now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: b.dataset.z }));
    }) };
  },
  settings: (w) => w.size === "l" && ({
    html: `<label>Fusos horários (até 3)</label><div class="chips">${Object.entries(ZONES).map(([z, n]) =>
      `<button type="button" class="chip ${(w.opts.zones ?? ["America/New_York", "Europe/Lisbon", "Asia/Tokyo"]).includes(z) ? "on" : ""}" data-v="${z}">${n}</button>`).join("")}</div>`,
    read: (f) => { w.opts.zones = [...f.querySelectorAll(".chip.on")].map((c) => c.dataset.v).slice(0, 3); },
    chips: 3,
  }),
};

// ---- calendário
function monthGrid(date) {
  const y = date.getFullYear(), m = date.getMonth(), today = date.getDate();
  const first = new Date(y, m, 1).getDay(), days = new Date(y, m + 1, 0).getDate(), prev = new Date(y, m, 0).getDate();
  let cells = "DSTQQSS".split("").map((c) => `<span class="h">${c}</span>`).join("");
  for (let i = first - 1; i >= 0; i--) cells += `<span class="o">${prev - i}</span>`;
  for (let d = 1; d <= days; d++) cells += d === today ? `<span><div class="today">${d}</div></span>` : `<span>${d}</span>`;
  const rest = (7 - ((first + days) % 7)) % 7;
  for (let d = 1; d <= rest; d++) cells += `<span class="o">${d}</span>`;
  return `<div class="cal-month"><div class="mh">${date.toLocaleDateString("pt-BR", { month: "long" })}</div><div class="cal-grid">${cells}</div></div>`;
}
TYPES.calendar = {
  name: "Calendário", desc: "Dia e mês", icon: "📅", color: "#fff", sizes: ["s", "m", "l"], def: "s",
  mount(body, w) {
    const draw = () => {
      const d = new Date();
      const day = `<div class="cal-day" style="display:flex;flex-direction:column;height:100%">
        <div class="wd">${d.toLocaleDateString("pt-BR", { weekday: "long" })}</div><div class="n">${d.getDate()}</div>
        <div class="m">${d.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}</div></div>`;
      if (w.size === "s") body.innerHTML = day;
      else if (w.size === "m") body.innerHTML = `<div class="cal-split"><div>${day}</div><div>${monthGrid(d)}</div></div>`;
      else { body.innerHTML = monthGrid(d); body.style.fontSize = "15px"; body.querySelector(".cal-grid").style.cssText = "font-size:15px;gap:14px 0"; }
    };
    return { destroy: every(60000, draw) };
  },
};

// ---- cotações
const CURRENCIES = {
  USD: ["🇺🇸", "Dólar americano"], EUR: ["🇪🇺", "Euro"], GBP: ["🇬🇧", "Libra esterlina"],
  BTC: ["₿", "Bitcoin"], ETH: ["Ξ", "Ethereum"], SOL: ["◎", "Solana"],
  JPY: ["🇯🇵", "Iene"], ARS: ["🇦🇷", "Peso argentino"], CAD: ["🇨🇦", "Dólar canadense"],
  CHF: ["🇨🇭", "Franco suíço"], CNY: ["🇨🇳", "Yuan"], AUD: ["🇦🇺", "Dólar australiano"],
};
const histCache = {};
const brl = (v) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: v >= 1000 ? 0 : v < 1 ? 4 : 2, maximumFractionDigits: v >= 1000 ? 0 : v < 1 ? 4 : 2 });
function spark(vals, up) {
  if (!vals?.length) return "";
  const min = Math.min(...vals), max = Math.max(...vals), r = max - min || 1;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * 80},${26 - ((v - min) / r) * 24}`).join(" ");
  const c = up ? "#30d158" : "#ff453a";
  return `<svg class="q-spark" viewBox="0 0 80 28"><polyline points="${pts}" fill="none" stroke="${c}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
TYPES.quotes = {
  name: "Cotações", desc: "Dólar, euro, bitcoin…", icon: "💱", color: "#30d158", sizes: ["s", "m", "l"], def: "m",
  mount(body, w) {
    const codes = w.opts.codes ?? ["USD", "EUR", "BTC"];
    const max = { s: 3, m: 3, l: 6 }[w.size];
    const list = codes.slice(0, max);
    body.innerHTML = `<div class="title-row"><span class="ico" style="background:#30d158">R$</span><span class="label">Cotações em real</span></div>
      <div class="q-list ${w.size === "s" ? "q-small" : ""}"><div class="empty">Carregando…</div></div><div class="q-updated"></div>`;
    if (w.size === "s") body.querySelector(".title-row").style.marginBottom = "4px";
    const listEl = $(".q-list", body), upd = $(".q-updated", body);
    const load = async () => {
      try {
        const q = await api("/api/quotes?codes=" + list.join(","));
        if (w.size === "l") await Promise.all(list.map(async (c) => {
          if (!histCache[c] || Date.now() - histCache[c].t > 600000) {
            try { histCache[c] = { t: Date.now(), v: await api("/api/history?code=" + c) }; } catch { /* sem histórico */ }
          }
        }));
        listEl.innerHTML = list.map((c) => {
          const d = q[c], [flag, name] = CURRENCIES[c] ?? ["¤", c];
          if (!d) return `<div class="q-row"><div class="q-flag">${flag}</div><div class="q-name"><b>${c}</b><span>indisponível</span></div></div>`;
          const up = (d.pct ?? 0) >= 0;
          const pct = d.pct == null ? "" : `<span class="${up ? "up" : "down"}">${up ? "▲" : "▼"} ${Math.abs(d.pct).toFixed(2)}%</span>`;
          return `<div class="q-row"><div class="q-flag">${flag}</div>
            <div class="q-name"><b>${c}</b>${w.size === "s" ? "" : `<span>${name}</span>`}</div>
            ${w.size === "l" ? spark(histCache[c]?.v, up) : ""}
            <div class="q-val"><b>${brl(d.bid)}</b>${w.size === "s" ? "" : pct}</div></div>`;
        }).join("");
        upd.textContent = w.size === "s" ? "" : "Atualizado " + new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      } catch {
        listEl.innerHTML = `<div class="empty">Sem conexão</div>`;
      }
    };
    return { destroy: every(60000, load), refresh: load };
  },
  settings: (w) => ({
    html: `<label>Moedas (a ordem segue a seleção)</label><div class="chips">${Object.entries(CURRENCIES).map(([c, [f]]) =>
      `<button type="button" class="chip ${(w.opts.codes ?? ["USD", "EUR", "BTC"]).includes(c) ? "on" : ""}" data-v="${c}">${f} ${c}</button>`).join("")}</div>
      <div class="hint">Tamanho P e M mostram 3 moedas; G mostra até 6 com gráfico de 15 dias.</div>`,
    read: (f) => { const v = [...f.querySelectorAll(".chip.on")].map((c) => c.dataset.v); if (v.length) w.opts.codes = v; },
    chips: 6,
  }),
};

// ---- fotos
let photoLib = [];
const photoListeners = new Set();
async function refreshPhotos() { photoLib = await api("/api/photos"); photoListeners.forEach((f) => f()); }
async function uploadPhotos(files) {
  for (const f of files) {
    await fetch("/api/photos", { method: "POST", headers: { "X-Token": window.TOKEN, "X-Filename": f.name }, body: f });
  }
  await refreshPhotos();
}
$("#photo-input").addEventListener("change", async (e) => { await uploadPhotos([...e.target.files]); e.target.value = ""; });
TYPES.photos = {
  name: "Fotos", desc: "Suas fotos em slideshow", icon: "🌄", color: "linear-gradient(135deg,#ff9f0a,#ff375f,#bf5af2)", sizes: ["s", "m", "l"], def: "l",
  mount(body, w) {
    let idx = 0, layer = 0;
    const draw = () => {
      if (!photoLib.length) {
        body.innerHTML = `<div class="empty"><div class="big">🌄</div>Nenhuma foto ainda<br><button class="btn-soft">Adicionar fotos</button></div>`;
        $(".btn-soft", body).onclick = () => $("#photo-input").click();
        return;
      }
      if (!$(".photo-layer", body)) {
        body.innerHTML = `<div class="photo-layer"></div><div class="photo-layer"></div><button class="photo-add" title="Adicionar fotos">+</button>`;
        $(".photo-add", body).onclick = () => $("#photo-input").click();
      }
      next();
    };
    const next = () => {
      if (!photoLib.length) return;
      const ls = body.querySelectorAll(".photo-layer");
      if (!ls.length) return;
      idx = (idx + 1) % photoLib.length;
      layer = 1 - layer;
      ls[layer].style.backgroundImage = `url("/photo/${encodeURIComponent(photoLib[idx])}")`;
      ls[layer].classList.add("on");
      ls[1 - layer].classList.remove("on");
    };
    idx = Math.floor(Math.random() * Math.max(photoLib.length, 1)) - 1;
    photoListeners.add(draw);
    draw();
    const stop = every((w.opts.interval ?? 8) * 1000, next, false);
    return { destroy: () => { stop(); photoListeners.delete(draw); } };
  },
  settings: (w) => ({
    html: `<label>Fotos</label><div class="thumbs">${photoLib.map((p) =>
      `<div class="thumb"><img src="/photo/${encodeURIComponent(p)}"><button type="button" data-del="${esc(p)}">✕</button></div>`).join("")}
      <div class="thumb add" data-add>+</div></div>
      <label>Trocar foto a cada (segundos)</label><input type="number" name="interval" min="3" max="600" value="${w.opts.interval ?? 8}">`,
    bind: (f) => {
      f.querySelector("[data-add]").onclick = () => $("#photo-input").click();
      f.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => {
        await api("/api/photos/delete", { name: b.dataset.del });
        b.parentElement.remove();
        refreshPhotos();
      });
      const redraw = () => { if (!$("#modal").hidden) openSettings(w, true); };
      photoListeners.add(redraw);
      return () => photoListeners.delete(redraw);
    },
    read: (f) => { w.opts.interval = Math.max(3, +f.interval.value || 8); },
  }),
};

// ---- youtube
const YT_LOGO = `<svg class="yt-logo" viewBox="0 0 46 32"><rect width="46" height="32" rx="9" fill="#ff0033"/><path d="M18 9.5v13l11.5-6.5z" fill="#fff"/></svg>`;
function ytEmbed(url) {
  if (!url) return null;
  try {
    const u = new URL(url.includes("://") ? url : "https://" + url);
    const list = u.searchParams.get("list");
    let id = u.searchParams.get("v");
    if (u.hostname.includes("youtu.be")) id = u.pathname.slice(1);
    const m = u.pathname.match(/\/(shorts|embed|live)\/([\w-]{6,})/);
    if (m) id = m[2];
    const p = "rel=0&playsinline=1&modestbranding=1";
    if (id) return `https://www.youtube.com/embed/${id}?${p}${list ? "&list=" + list : ""}`;
    if (list) return `https://www.youtube.com/embed/videoseries?list=${list}&${p}`;
  } catch { /* url inválida */ }
  if (/^[\w-]{11}$/.test(url)) return `https://www.youtube.com/embed/${url}?rel=0`;
  return null;
}
TYPES.youtube = {
  name: "YouTube", desc: "Vídeo ou playlist", icon: "▶", color: "#ff0033", sizes: ["m", "l"], def: "l",
  mount(body, w) {
    const src = ytEmbed(w.opts.url);
    if (src) {
      body.innerHTML = `<iframe src="${esc(src)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
      return {};
    }
    body.innerHTML = `<div class="yt-empty">${YT_LOGO}<div style="margin-top:10px;font-weight:600">YouTube</div>
      <input placeholder="Cole o link de um vídeo ou playlist" spellcheck="false"></div>`;
    const inp = $("input", body);
    inp.onkeydown = (e) => {
      if (e.key !== "Enter") return;
      if (!ytEmbed(inp.value.trim())) { inp.style.borderColor = "var(--red)"; return; }
      w.opts.url = inp.value.trim(); save(); remount(w);
    };
    return {};
  },
  settings: (w) => ({
    html: `<label>Link do vídeo ou playlist</label><input type="text" name="url" value="${esc(w.opts.url ?? "")}" placeholder="https://youtube.com/watch?v=…" spellcheck="false">
      <div class="hint">Aceita youtube.com/watch, youtu.be, shorts e playlists.</div>`,
    read: (f) => { w.opts.url = f.url.value.trim(); },
  }),
};

// ---- spotify
const SP_LOGO = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#1ed760"/><path d="M6.5 9.3c3.6-1 7.7-.7 11 1.1M7.2 12.4c3-.8 6.3-.5 9 1M7.8 15.3c2.4-.6 4.9-.4 7 .8" stroke="#000" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>`;
TYPES.spotify = {
  name: "Spotify", desc: "Tocando agora", icon: SP_LOGO, color: "#121212", sizes: ["s", "m", "l"], def: "m",
  mount(body, w) {
    let st = null, at = 0, key = "";
    const act = async (a) => { st = await api("/api/media", { action: a }); at = Date.now(); draw(true); };
    const draw = (force) => {
      if (!st?.running) {
        if (key === "off") return; key = "off";
        body.innerHTML = `<div class="empty"><div style="width:44px;margin:0 auto 8px">${SP_LOGO}</div>Spotify fechado<br><button class="btn-soft">Abrir Spotify</button></div>`;
        $(".btn-soft", body).onclick = () => api("/api/spotify/open", {});
        return;
      }
      const k = st.title + st.art + w.size;
      if (k !== key || force) {
        key = k;
        body.innerHTML = `<div class="sp-logo">${SP_LOGO}</div><div class="sp-wrap">
          <div class="sp-art" style="background-image:url('${esc(st.art)}')"></div>
          <div class="sp-info"><div class="sp-title">${esc(st.title || "—")}</div><div class="sp-artist">${esc(st.artist)}</div>
            <div class="sp-bar"><i></i></div><div class="sp-times"><span class="cur"></span><span>${fmtTime(st.length)}</span></div>
            <div class="sp-ctrls"><button data-a="Previous">⏮</button><button class="play" data-a="PlayPause"></button><button data-a="Next">⏭</button></div></div>
          ${w.size === "s" ? `<div class="sp-ctrls"><button class="play" data-a="PlayPause"></button></div>` : ""}</div>`;
        body.querySelectorAll("[data-a]").forEach((b) => b.onclick = () => act(b.dataset.a));
      }
      const playing = st.status === "Playing";
      body.querySelectorAll(".play").forEach((b) => b.textContent = playing ? "⏸" : "▶");
      const pos = Math.min(st.length, st.position + (playing ? (Date.now() - at) / 1000 : 0));
      const bar = $(".sp-bar i", body), cur = $(".cur", body);
      if (bar) bar.style.width = (st.length ? (100 * pos) / st.length : 0) + "%";
      if (cur) cur.textContent = fmtTime(pos);
    };
    const poll = async () => { try { st = await api("/api/media"); at = Date.now(); } catch { st = null; } draw(); };
    const stop1 = every(3000, poll), stop2 = every(1000, () => st && draw(), false);
    return { destroy: () => { stop1(); stop2(); }, refresh: poll };
  },
};

// ---- IA
const AI_LOOK = {
  claude: ["#d97757", "#fff", `<svg viewBox="0 0 24 24" width="24"><path fill="#fff" d="M12 2l1.6 6.2L19 4.6l-3.6 5.3L22 12l-6.6 2.1 3.6 5.3-5.4-3.6L12 22l-1.6-6.2L5 19.4l3.6-5.3L2 12l6.6-2.1L5 4.6l5.4 3.6z"/></svg>`],
  codex: ["#0d0d0d", "#fff", `<span style="font-family:monospace;font-size:16px">&gt;_</span>`],
  opencode: ["#f1ecec", "#211e1e", `<span style="font-family:monospace;font-size:15px">oc</span>`],
  gemini: ["linear-gradient(135deg,#4285f4,#9b72cb,#d96570)", "#fff", "✦"],
  chatgpt: ["#10a37f", "#fff", "◎"],
  ollama: ["#fff", "#000", "🦙"],
};
let aiTools = null;
const getAi = async () => (aiTools ??= await api("/api/ai"));
TYPES.ai = {
  name: "IA", desc: "Claude, Codex, OpenCode…", icon: AI_LOOK.claude[2], color: "#d97757", sizes: ["s", "m", "l"], def: "l",
  mount(body, w) {
    body.innerHTML = `<div class="title-row"><span class="ico" style="background:#d97757">✳</span><span class="label">Assistentes de IA</span></div><div class="ai-grid"></div>`;
    (async () => {
      const tools = await getAi();
      const n = { s: 4, m: 6, l: 6 }[w.size];
      const shown = (w.opts.tools ? w.opts.tools.map((id) => tools.find((t) => t.id === id)).filter(Boolean) : tools).slice(0, n);
      const gridEl = $(".ai-grid", body);
      gridEl.style.setProperty("--ai-cols", { s: 2, m: 6, l: 3 }[w.size]);
      if (w.size === "s") { body.querySelector(".title-row").remove(); gridEl.style.cssText += ";gap:4px;margin:auto 0"; }
      gridEl.innerHTML = shown.map((t) => {
        const [bg, fg, logo] = AI_LOOK[t.id];
        const where = t.cli ? "terminal" : t.web ? "web" : "não instalado";
        return `<button class="ai-btn ${t.cli || t.web ? "" : "off"}" data-id="${t.id}" title="${t.name} — ${where}">
          <div class="lg" style="background:${bg};color:${fg}">${logo}</div>
          ${w.size === "s" ? "" : `<div class="nm">${t.name}</div><div class="tag">${where}</div>`}</button>`;
      }).join("");
      gridEl.querySelectorAll(".ai-btn").forEach((b) => {
        const t = tools.find((x) => x.id === b.dataset.id);
        b.onclick = () => {
          if (t.cli) { api("/api/ai/launch", { id: t.id }); native("hide"); }
          else if (t.web) api("/api/open", { url: t.web });
        };
        b.oncontextmenu = (e) => { e.preventDefault(); if (t.web) api("/api/open", { url: t.web }); };
      });
      if (w.size !== "l") return;
      const engines = tools.filter((t) => t.cli && ["claude", "codex", "opencode"].includes(t.id));
      if (!engines.length) return;
      const ask = h(`<div class="ai-ask"><div class="ai-ask-row">
          <select>${engines.map((t) => `<option value="${t.id}" ${t.id === (w.opts.engine ?? "claude") ? "selected" : ""}>${t.name}</option>`).join("")}</select>
          <input placeholder="Pergunte algo…" spellcheck="false"></div>
        <div class="ai-answer wait">${esc(w.opts.last ?? "Enter para enviar. Clique num ícone para abrir no terminal; botão direito abre na web.")}</div></div>`);
      body.appendChild(ask);
      const sel = $("select", ask), inp = $("input", ask), out = $(".ai-answer", ask);
      sel.onchange = () => { w.opts.engine = sel.value; save(); };
      inp.onkeydown = async (e) => {
        if (e.key !== "Enter" || !inp.value.trim() || inp.disabled) return;
        const q = inp.value.trim();
        inp.disabled = true; out.className = "ai-answer wait";
        let dots = 0;
        const timer = setInterval(() => out.textContent = `${sel.selectedOptions[0].text} pensando${".".repeat(1 + (dots++ % 3))}`, 400);
        try {
          const r = await api("/api/ai/ask", { engine: sel.value, prompt: q });
          out.textContent = r.answer ?? r.error; out.className = "ai-answer";
          w.opts.last = out.textContent.slice(0, 4000); save();
          inp.value = "";
        } catch (err) { out.textContent = "Erro: " + err; }
        clearInterval(timer); inp.disabled = false; inp.focus();
      };
    })();
    return {};
  },
  settings: (w) => ({
    html: `<label>Ferramentas exibidas (na ordem selecionada)</label><div class="chips">${(aiTools ?? []).map((t) =>
      `<button type="button" class="chip ${(w.opts.tools ?? aiTools.map((x) => x.id)).includes(t.id) ? "on" : ""}" data-v="${t.id}">${t.name}${t.cli ? "" : t.web ? " (web)" : " (não instalado)"}</button>`).join("")}</div>
      <div class="hint">Ícone abre a CLI no terminal se instalada, senão a versão web. Botão direito sempre abre a web.</div>`,
    read: (f) => { const v = [...f.querySelectorAll(".chip.on")].map((c) => c.dataset.v); if (v.length) w.opts.tools = v; },
    chips: 6,
  }),
};

// ---- sistema
function ring(label, pct, color, text) {
  const c = 2 * Math.PI * 26, off = c * (1 - Math.min(100, pct ?? 0) / 100);
  return `<div class="ring"><svg viewBox="0 0 60 60"><circle class="bg" cx="30" cy="30" r="26"/>
    <circle class="fg" cx="30" cy="30" r="26" stroke="${color}" stroke-dasharray="${c}" stroke-dashoffset="${off}"/></svg>
    <div class="v">${text ?? Math.round(pct) + "%"}</div><div class="n">${label}</div></div>`;
}
TYPES.system = {
  name: "Sistema", desc: "CPU, memória, bateria", icon: "📊", color: "#0a84ff", sizes: ["s", "m"], def: "m",
  mount(body, w) {
    body.innerHTML = w.size === "s" ? `<div class="rings"></div>` : `<div class="title-row"><span class="ico" style="background:#0a84ff">◔</span><span class="label">Sistema</span></div><div class="rings"></div>`;
    const el = $(".rings", body);
    const load = async () => {
      const s = await api("/api/system");
      const b = s.bat;
      el.innerHTML = ring("CPU", s.cpu, "#0a84ff") + ring("RAM", s.ram, "#bf5af2") + ring("Disco", s.disk, "#ff9f0a")
        + (b ? ring(b.status === "Charging" ? "⚡ Bat" : "Bateria", b.pct, b.pct < 20 ? "#ff453a" : "#30d158") : "");
    };
    return { destroy: every(2000, load) };
  },
};

// ---- notas
TYPES.notes = {
  name: "Notas", desc: "Lembrete rápido", icon: "📝", color: "#ffd60a", sizes: ["s", "m", "l"], def: "s",
  mount(body, w) {
    body.innerHTML = `<div class="notes-h">Notas</div><textarea placeholder="Escreva algo…" spellcheck="false"></textarea>`;
    const ta = $("textarea", body);
    ta.value = w.opts.text ?? "";
    ta.oninput = () => { w.opts.text = ta.value; save(); };
    return {};
  },
};

// ------------------------------------------------------------------ configurações
let unbind;
function openSettings(w, keep) {
  const cfg = TYPES[w.type].settings?.(w);
  if (!cfg) return;
  unbind?.();
  $("#modal-title").textContent = "Configurar " + TYPES[w.type].name;
  $("#modal-body").innerHTML = cfg.html;
  const form = $("#modal-card");
  form.querySelectorAll(".chip").forEach((c) => c.onclick = () => {
    if (!c.classList.contains("on") && cfg.chips && form.querySelectorAll(".chip.on").length >= cfg.chips) return;
    c.classList.toggle("on");
    // mantém ordem de seleção: move selecionado para o fim dos ativos
    if (c.classList.contains("on")) { const on = form.querySelectorAll(".chip.on"); on[on.length - 1].after(c); }
  });
  unbind = cfg.bind?.(form);
  form.onsubmit = (e) => { e.preventDefault(); cfg.read(form); closeModal(); remount(w); save(); };
  $("#modal").hidden = false;
  if (!keep) form.querySelector("input[type=text]")?.focus();
}
function closeModal() { $("#modal").hidden = true; unbind?.(); unbind = null; }
$("#modal-cancel").onclick = closeModal;
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

// ------------------------------------------------------------------ edição / galeria
function setEditing(on) {
  document.body.classList.toggle("editing", on);
  $("#gallery").hidden = !on;
  $("#btn-edit").textContent = on ? "Concluído" : "Editar widgets";
}
$("#btn-edit").onclick = () => setEditing(!document.body.classList.contains("editing"));
$("#btn-done").onclick = () => setEditing(false);
$("#btn-close").onclick = () => native("hide");
$("#gallery-list").innerHTML = Object.entries(TYPES).map(([k, t]) =>
  `<button class="g-item" data-t="${k}"><div class="g-icon" style="background:${t.color}">${t.icon}</div>
    <div class="g-name">${t.name}</div><div class="g-desc">${t.desc}</div></button>`).join("");
$("#gallery-list").querySelectorAll(".g-item").forEach((b) => b.onclick = () => {
  const t = TYPES[b.dataset.t];
  const w = { id: uid(), type: b.dataset.t, size: t.def, opts: {} };
  [w.col, w.row] = findFree(w, w.size);
  state.widgets.push(w); render(); save();
});
$("#board").addEventListener("click", (e) => {
  if (e.target.id !== "board") return;
  if (document.body.classList.contains("editing")) setEditing(false);
  else native("hide");
});

window.onEscape = () => {
  if (!$("#modal").hidden) closeModal();
  else if (document.body.classList.contains("editing")) setEditing(false);
  else native("hide");
};
window.onShow = () => {
  visible = true;
  document.body.classList.remove("hiding");
  for (const { inst } of mounted.values()) inst?.refresh?.();
};
window.onHide = () => { visible = false; closeModal(); setEditing(false); };
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !window.webkit) window.onEscape(); });

every(1000, () => {
  $("#top-time").textContent = new Date().toLocaleString("pt-BR", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
});
// corrige posições inválidas (tela menor etc.) só quando a janela já tem tamanho real
let normalized = false;
function normalize() {
  if (normalized || innerWidth < 600) return;
  normalized = true;
  const all = state.widgets.filter((w) => TYPES[w.type]);
  state.widgets = [];
  let moved = false;
  for (const w of all) {
    if (!TYPES[w.type].sizes.includes(w.size)) w.size = TYPES[w.type].def;
    if (!fits(w, w.col, w.row, w.size)) { [w.col, w.row] = findFree(w, w.size); moved = true; }
    state.widgets.push(w);
  }
  if (moved) save();
}
addEventListener("resize", () => { normalize(); render(); });

// ------------------------------------------------------------------ início
(async () => {
  const [cfg] = await Promise.all([api("/api/config"), refreshPhotos(), getAi().catch(() => null)]);
  if (cfg?.widgets?.length) state = cfg;
  else { state.widgets = DEFAULT.map((w) => ({ id: uid(), opts: {}, ...w })); save(); }
  normalize();
  render();
})();
