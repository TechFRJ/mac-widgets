"use strict";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const api = (path, body) => fetch(path, {
  method: body === undefined ? "GET" : "POST",
  headers: { "X-Token": window.TOKEN, "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then((r) => r.json());

const TYPES = {
  clock: { name: "Relógio", desc: "Analógico, digital ou com fusos", icon: "🕐", color: "#3a3a3c", sizes: ["s", "m", "l"] },
  calendar: { name: "Calendário", desc: "Dia de hoje e o mês", icon: "📅", color: "#ff453a", sizes: ["s", "m", "l"] },
  quotes: { name: "Cotações", desc: "Dólar, euro, bitcoin e mais", icon: "💱", color: "#30d158", sizes: ["s", "m", "l"] },
  photos: { name: "Fotos", desc: "Suas fotos em slideshow", icon: "🌄", color: "#ff9f0a", sizes: ["s", "m", "l"] },
  youtube: { name: "YouTube", desc: "Mostra o vídeo que você assiste", icon: "▶", color: "#ff0033", sizes: ["s", "m", "l"] },
  spotify: { name: "Spotify", desc: "Tocando agora + controles", icon: "♫", color: "#1db954", sizes: ["s", "m", "l"] },
  ai: { name: "IA", desc: "Claude, Codex, OpenCode…", icon: "✳", color: "#d97757", sizes: ["s", "m", "l"] },
  system: { name: "Sistema", desc: "CPU, RAM, disco, bateria", icon: "◔", color: "#0a84ff", sizes: ["s", "m"] },
  notes: { name: "Notas", desc: "Lembrete rápido", icon: "✎", color: "#ffd60a", sizes: ["s", "m", "l"] },
};
const SIZE_LBL = { s: "Pequeno", m: "Médio", l: "Grande" };
const CURRENCIES = {
  USD: "🇺🇸 Dólar", EUR: "🇪🇺 Euro", GBP: "🇬🇧 Libra", BTC: "₿ Bitcoin", ETH: "Ξ Ethereum", SOL: "◎ Solana",
  JPY: "🇯🇵 Iene", ARS: "🇦🇷 Peso arg.", CAD: "🇨🇦 Dólar can.", CHF: "🇨🇭 Franco", CNY: "🇨🇳 Yuan", AUD: "🇦🇺 Dólar aus.",
};
const ZONES = {
  "America/New_York": "Nova York", "Europe/Lisbon": "Lisboa", "Europe/London": "Londres", "Europe/Paris": "Paris",
  "Asia/Tokyo": "Tóquio", "America/Los_Angeles": "Los Angeles", "Asia/Dubai": "Dubai", "Australia/Sydney": "Sydney",
  "America/Sao_Paulo": "São Paulo",
};

let cfg = null;
let current = new URLSearchParams(location.search).get("focus") || "general";
let photos = [], aiTools = [];

const toast = (() => {
  const el = document.createElement("div");
  el.className = "toast";
  document.body.appendChild(el);
  let t;
  return (msg) => { el.textContent = msg; el.classList.add("show"); clearTimeout(t); t = setTimeout(() => el.classList.remove("show"), 1400); };
})();

async function op(o, quiet) {
  cfg = await api("/api/desktop", o);
  renderList();
  if (!quiet) toast("Salvo");
  return cfg;
}
const widget = (id) => cfg.widgets.find((w) => w.id === id);
const sw = (on) => `<button class="switch ${on ? "on" : ""}"></button>`;

// ------------------------------------------------------------ lista lateral
function renderList() {
  $("#list").innerHTML = cfg.widgets.map((w) => {
    const t = TYPES[w.type] ?? { name: w.type, icon: "?", color: "#444" };
    return `<button class="nav" data-pane="${w.id}"><span class="ni" style="background:${t.color}">${t.icon}</span>${t.name}<span class="sz">${w.size.toUpperCase()}${w.scale && w.scale !== 1 ? " · " + Math.round(w.scale * 100) + "%" : ""}</span></button>`;
  }).join("") || `<div class="hint" style="padding:6px 10px">Nenhum widget. Use “Adicionar widget”.</div>`;
  document.querySelectorAll(".nav").forEach((b) => {
    b.classList.toggle("on", b.dataset.pane === current);
    b.onclick = () => { current = b.dataset.pane; renderList(); renderPane(); };
  });
}

// ------------------------------------------------------------ painéis
function renderPane() {
  const pane = $("#pane");
  if (current === "general") return paneGeneral(pane);
  if (current === "add") return paneAdd(pane);
  if (current === "panel") return panePanel(pane);
  const w = widget(current);
  if (!w) { current = "general"; renderList(); return paneGeneral(pane); }
  paneWidget(pane, w);
}

function paneGeneral(pane) {
  pane.innerHTML = `<h1><span class="ni" style="background:#8e8e93">⚙</span>Geral</h1>
    <div class="group">
      <div class="row"><div class="lbl">Mostrar widgets na área de trabalho</div>${sw(cfg.enabled !== false)}</div>
      <div class="row"><div class="lbl">Aparência</div><div class="seg" id="theme">
        ${[["dark", "Escuro"], ["light", "Claro"], ["glass", "Vidro"]].map(([v, n]) => `<button data-v="${v}" class="${cfg.theme === v ? "on" : ""}">${n}</button>`).join("")}</div></div>
      <div class="row"><div class="lbl">Opacidade do fundo</div><input type="range" id="opacity" min="0.2" max="1" step="0.02" value="${cfg.opacity ?? 0.82}"><span class="val" id="opv">${Math.round((cfg.opacity ?? 0.82) * 100)}%</span></div>
      <div class="row"><div class="lbl">Travar posições<small>Impede mover e redimensionar sem querer</small></div>${sw(cfg.locked)}</div>
      <div class="row"><div class="lbl">Ímã e grade<small>Alinha com outros widgets ao arrastar</small></div>${sw(cfg.snap !== false)}</div>
      <div class="row"><div class="lbl">Reorganizar automaticamente<small>Coloca todos os widgets em ordem no monitor principal</small></div><button class="btn" id="relayout">Reorganizar</button></div>
    </div>
    <h2>Como usar na área de trabalho</h2>
    <div class="group"><div class="row col"><ul class="tips">
      <li><b>Mover:</b> clique e arraste o widget.</li>
      <li><b>Redimensionar livre:</b> passe o mouse e arraste o cantinho inferior direito (60% a 220%).</li>
      <li><b>Pequeno / Médio / Grande:</b> botão direito no widget.</li>
      <li><b>Configurar ou remover:</b> botão direito → “Configurar widget…” ou “Remover widget”.</li>
      <li><b>YouTube tocando e perguntas à IA:</b> painel com <b>Super+W</b>.</li>
    </ul></div></div>`;
  const switches = pane.querySelectorAll(".switch");
  const keys = ["enabled", "locked", "snap"];
  switches.forEach((s, i) => s.onclick = () => {
    s.classList.toggle("on");
    op({ op: "global", patch: { [keys[i]]: s.classList.contains("on") } });
  });
  pane.querySelectorAll("#theme button").forEach((b) => b.onclick = () => {
    pane.querySelectorAll("#theme button").forEach((x) => x.classList.toggle("on", x === b));
    op({ op: "global", patch: { theme: b.dataset.v } });
  });
  const opInput = $("#opacity");
  let t;
  opInput.oninput = () => {
    $("#opv").textContent = Math.round(opInput.value * 100) + "%";
    clearTimeout(t);
    t = setTimeout(() => op({ op: "global", patch: { opacity: +opInput.value } }, true), 120);
  };
  $("#relayout").onclick = () => op({ op: "relayout" });
}

function paneAdd(pane) {
  pane.innerHTML = `<h1><span class="ni" style="background:#0a84ff">+</span>Adicionar widget</h1>
    <p class="hint" style="margin-bottom:16px">Clique para colocar na área de trabalho. Depois arraste para onde quiser.</p>
    <div class="gallery">${Object.entries(TYPES).map(([k, t]) =>
      `<button class="gal" data-t="${k}"><div class="ni" style="background:${t.color}">${t.icon}</div><b>${t.name}</b><span>${t.desc}</span></button>`).join("")}</div>`;
  pane.querySelectorAll(".gal").forEach((b) => b.onclick = async () => {
    const before = new Set(cfg.widgets.map((w) => w.id));
    const t = b.dataset.t;
    await op({ op: "add", type: t, size: t === "photos" || t === "youtube" ? "m" : TYPES[t].sizes.includes("m") ? "m" : "s" }, true);
    toast(`${TYPES[t].name} adicionado`);
    const added = cfg.widgets.find((w) => !before.has(w.id));
    if (added) { current = added.id; renderList(); renderPane(); }
  });
}

function panePanel(pane) {
  pane.innerHTML = `<h1><span class="ni" style="background:#5e5ce6">⌘</span>Painel Super+W</h1>
    <div class="group">
      <div class="row"><div class="lbl">Painel flutuante<small>Tela cheia com YouTube tocando, perguntas ao Claude/Codex e todos os widgets. Edite por lá em “Editar widgets”.</small></div><button class="btn blue" id="open-panel">Abrir painel</button></div>
      <div class="row"><div class="lbl">Atalho<small>Para trocar: Configurações do Ubuntu → Teclado → Atalhos personalizados → “Widgets”</small></div><b>Super + W</b></div>
    </div>`;
  $("#open-panel").onclick = () => api("/api/panel", {});
}

function paneWidget(pane, w) {
  const t = TYPES[w.type];
  const scale = w.scale ?? 1;
  pane.innerHTML = `<h1><span class="ni" style="background:${t.color}">${t.icon}</span>${t.name}</h1>
    <div class="group">
      <div class="row"><div class="lbl">Tamanho</div><div class="seg" id="size">
        ${t.sizes.map((s) => `<button data-v="${s}" class="${w.size === s ? "on" : ""}">${SIZE_LBL[s]}</button>`).join("")}</div></div>
      <div class="row"><div class="lbl">Escala<small>Mesmo efeito de arrastar o canto do widget</small></div>
        <input type="range" id="scale" min="0.6" max="2.2" step="0.05" value="${scale}"><span class="val" id="scv">${Math.round(scale * 100)}%</span></div>
      <div class="row"><div class="lbl">Posição na tela<small>Ou arraste o widget direto na área de trabalho</small></div>
        X <input type="number" id="px" value="${w.x ?? ""}"> Y <input type="number" id="py" value="${w.y ?? ""}"></div>
    </div>
    <div id="opts"></div>
    <h2></h2>
    <div class="group"><div class="row"><div class="lbl">Remover este widget</div><button class="btn red" id="remove">Remover</button></div></div>`;
  pane.querySelectorAll("#size button").forEach((b) => b.onclick = () => {
    pane.querySelectorAll("#size button").forEach((x) => x.classList.toggle("on", x === b));
    op({ op: "set", id: w.id, patch: { size: b.dataset.v } });
  });
  const sc = $("#scale");
  let tm;
  sc.oninput = () => {
    $("#scv").textContent = Math.round(sc.value * 100) + "%";
    clearTimeout(tm);
    tm = setTimeout(() => op({ op: "set", id: w.id, patch: { scale: +sc.value } }, true), 150);
  };
  const pos = () => op({ op: "set", id: w.id, patch: { x: +$("#px").value, y: +$("#py").value } });
  $("#px").onchange = pos;
  $("#py").onchange = pos;
  $("#remove").onclick = async () => { await op({ op: "remove", id: w.id }); current = "general"; renderList(); renderPane(); };
  OPTS[w.type]?.($("#opts"), w);
}

// ------------------------------------------------------------ opções por tipo
const setOpts = (w, patch, quiet) => op({ op: "set", id: w.id, patch: { opts: patch } }, quiet);

function chipPicker(el, items, selected, max, onChange) {
  let sel = [...selected];
  const draw = () => {
    el.innerHTML = `<div class="chips">${Object.entries(items).map(([k, n]) => {
      const i = sel.indexOf(k);
      return `<button class="chip ${i >= 0 ? "on" : ""}" data-k="${k}">${i >= 0 ? `<span class="ord">${i + 1}</span>` : ""}${esc(n)}</button>`;
    }).join("")}</div><p class="hint" style="margin-top:8px">Até ${max}. A ordem dos números é a ordem no widget.</p>`;
    el.querySelectorAll(".chip").forEach((c) => c.onclick = () => {
      const k = c.dataset.k;
      if (sel.includes(k)) { if (sel.length > 1) sel = sel.filter((x) => x !== k); }
      else if (sel.length < max) sel.push(k);
      else return toast(`Máximo de ${max}`);
      draw(); onChange(sel);
    });
  };
  draw();
}

const OPTS = {
  clock(el, w) {
    el.innerHTML = `<h2>Fusos horários (tamanho Grande)</h2><div class="group"><div class="row col" id="z"></div></div>`;
    chipPicker($("#z", el), ZONES, w.opts?.zones ?? ["America/New_York", "Europe/Lisbon", "Asia/Tokyo"], 3, (v) => setOpts(w, { zones: v }));
  },
  quotes(el, w) {
    el.innerHTML = `<h2>Moedas</h2><div class="group"><div class="row col" id="c"></div></div>
      <p class="hint" style="margin:8px 4px">Pequeno e Médio mostram 3 moedas. Grande mostra até 6 com gráfico de 15 dias.</p>`;
    chipPicker($("#c", el), CURRENCIES, w.opts?.codes ?? ["USD", "EUR", "BTC"], 6, (v) => setOpts(w, { codes: v }));
  },
  async photos(el, w) {
    photos = await api("/api/photos");
    el.innerHTML = `<h2>Fotos (${photos.length})</h2><div class="group"><div class="row col">
      <div class="thumbs">${photos.map((p) => `<div class="thumb"><img src="/photo/${encodeURIComponent(p)}"><button data-del="${esc(p)}" title="Apagar">✕</button></div>`).join("")}
      <div class="thumb add" title="Adicionar fotos">+</div></div></div>
      <div class="row"><div class="lbl">Trocar foto a cada</div><input type="number" id="iv" min="3" max="3600" value="${w.opts?.interval ?? 10}"> segundos</div></div>`;
    $(".thumb.add", el).onclick = () => { photoTarget = w; $("#photo-input").click(); };
    el.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => {
      await api("/api/photos/delete", { name: b.dataset.del });
      await bumpPhotos();
      OPTS.photos(el, widget(w.id));
    });
    $("#iv", el).onchange = (e) => setOpts(w, { interval: Math.max(3, +e.target.value || 10) });
  },
  youtube(el, w) {
    el.innerHTML = `<h2>Detecção automática</h2><div class="group"><div class="row"><div class="lbl">Mostrar o vídeo que estou assistindo<small>Quando um vídeo toca no navegador (Brave, Chrome, Firefox…), ele aparece no widget com play/pause. Clicar na imagem traz o navegador para frente.</small></div>${sw(w.opts?.auto !== false)}</div></div>
      <h2>Vídeo fixo (quando nada estiver tocando)</h2><div class="group"><div class="row col">
      <input type="text" class="wide" id="url" placeholder="https://youtube.com/watch?v=…" value="${esc(w.opts?.url ?? "")}" spellcheck="false">
      <div class="yt-prev" id="prev"></div>
      <p class="hint">Aparece a miniatura; clicar abre o vídeo no navegador. Para tocar dentro do widget use o painel Super+W.</p></div></div>`;
    const prev = async (url) => {
      if (!url) return ($("#prev", el).innerHTML = "");
      const d = await api("/api/yt?url=" + encodeURIComponent(url));
      $("#prev", el).innerHTML = d.id ? `<img src="https://i.ytimg.com/vi/${esc(d.id)}/mqdefault.jpg"><div><b>${esc(d.title || "Vídeo")}</b><div class="hint">${esc(d.author)}</div></div>` : `<span class="hint">Link não reconhecido</span>`;
    };
    $(".switch", el).onclick = (e) => { e.target.classList.toggle("on"); setOpts(w, { auto: e.target.classList.contains("on") }); };
    $("#url", el).onchange = (e) => { setOpts(w, { url: e.target.value.trim() }); prev(e.target.value.trim()); };
    prev(w.opts?.url);
  },
  async ai(el, w) {
    aiTools = aiTools.length ? aiTools : await api("/api/ai");
    const items = Object.fromEntries(aiTools.map((t) => [t.id, `${t.name}${t.cli ? " (terminal)" : t.web ? " (web)" : " (não instalado)"}`]));
    el.innerHTML = `<h2>Ferramentas</h2><div class="group"><div class="row col" id="t"></div></div>
      <p class="hint" style="margin:8px 4px">Clique no ícone abre a CLI no terminal (se instalada) ou o site. Pequeno e Médio mostram 4; Grande mostra 6.</p>`;
    chipPicker($("#t", el), items, w.opts?.tools ?? aiTools.map((t) => t.id), 6, (v) => setOpts(w, { tools: v }));
  },
  notes(el, w) {
    el.innerHTML = `<h2>Texto</h2><div class="group"><div class="row col"><textarea id="tx" placeholder="Escreva sua nota…">${esc(w.opts?.text ?? "")}</textarea></div></div>`;
    let t;
    $("#tx", el).oninput = (e) => { clearTimeout(t); t = setTimeout(() => setOpts(w, { text: e.target.value }, true), 400); };
    $("#tx", el).focus();
  },
};

// força os widgets de fotos a recarregar a lista
async function bumpPhotos() {
  for (const w of cfg.widgets.filter((x) => x.type === "photos")) await setOpts(w, { rev: Date.now() }, true);
}
let photoTarget = null;
$("#photo-input").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  for (const f of files) await fetch("/api/photos", { method: "POST", headers: { "X-Token": window.TOKEN, "X-Filename": f.name }, body: f });
  e.target.value = "";
  await bumpPhotos();
  toast(`${files.length} foto(s) adicionada(s)`);
  if (photoTarget) OPTS.photos($("#opts"), widget(photoTarget.id));
});

// ------------------------------------------------------------ início + sincronização
(async () => {
  cfg = await api("/api/desktop");
  renderList();
  renderPane();
  // acompanha mudanças feitas direto na área de trabalho (arrastar, redimensionar, menu)
  setInterval(async () => {
    const fresh = await api("/api/desktop").catch(() => null);
    if (!fresh || JSON.stringify(fresh) === JSON.stringify(cfg)) return;
    const structural = JSON.stringify(fresh.widgets.map((w) => [w.id, w.size, w.scale])) !== JSON.stringify(cfg.widgets.map((w) => [w.id, w.size, w.scale]));
    cfg = fresh;
    renderList();
    if (current === "general" && !document.activeElement?.matches("input")) renderPane();
    const w = widget(current);
    if (w && !document.activeElement?.matches("input, textarea")) {
      if (structural) renderPane();
      else { const px = $("#px"), py = $("#py"); if (px) { px.value = w.x ?? ""; py.value = w.y ?? ""; } }
    }
  }, 2000);
})();
