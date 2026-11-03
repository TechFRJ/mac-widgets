#!/usr/bin/env python3
"""Painel de widgets estilo macOS para GNOME (Wayland/X11).

Uma janela transparente em tela cheia (GTK3 + WebKit2) mostra os widgets.
Rodar de novo o comando alterna mostrar/esconder (atalho Super+W).
Um servidor HTTP local (127.0.0.1, protegido por token) fornece dados ao front-end.
"""
import json
import mimetypes
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gdk, Gio, GLib, Gtk, WebKit2  # noqa: E402

APP_ID = "br.com.barnswallow.MacWidgets"
ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
CONF_DIR = Path(GLib.get_user_config_dir()) / "mac-widgets"
CONF_FILE = CONF_DIR / "config.json"
PHOTOS = CONF_DIR / "photos"
DESK_FILE = CONF_DIR / "desktop.json"
SERVER_FILE = CONF_DIR / "server.json"
CACHE = Path(GLib.get_user_cache_dir()) / "mac-widgets"
TOKEN = secrets.token_hex(16)
PHOTO_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"}

AI_TOOLS = [
    # id, nome, comando de terminal, url web
    ("claude", "Claude", "claude", "https://claude.ai/new"),
    ("codex", "Codex", "codex", "https://chatgpt.com/codex"),
    ("opencode", "OpenCode", "opencode", "https://opencode.ai"),
    ("gemini", "Gemini", "gemini", "https://gemini.google.com/app"),
    ("chatgpt", "ChatGPT", None, "https://chatgpt.com"),
    ("ollama", "Ollama", "ollama", None),
]


# ---------------------------------------------------------------- dados

def which(cmd):
    extra = [str(Path.home() / ".local/bin")]
    nvm = Path.home() / ".nvm/versions/node"
    if nvm.is_dir():
        extra += [str(p / "bin") for p in sorted(nvm.iterdir(), reverse=True)]
    path = os.pathsep.join([os.environ.get("PATH", "")] + extra)
    return shutil.which(cmd, path=path)


def ai_tools():
    out = []
    for tid, name, cmd, url in AI_TOOLS:
        out.append({
            "id": tid, "name": name, "web": url,
            "cli": bool(cmd and which(cmd)), "cmd": cmd,
        })
    return out


def ai_launch(tid):
    tool = next((t for t in AI_TOOLS if t[0] == tid), None)
    if not tool or not tool[2] or not which(tool[2]):
        return False
    exe = which(tool[2])
    term = which("ptyxis") or which("gnome-terminal") or which("x-terminal-emulator")
    subprocess.Popen([term, "--new-window", "-d", str(Path.home()), "--",
                      "bash", "-lc", f"'{exe}'; exec bash"],
                     start_new_session=True)
    return True


def ai_ask(engine, prompt):
    if engine == "claude" and which("claude"):
        r = subprocess.run([which("claude"), "-p", prompt], capture_output=True,
                           text=True, timeout=300, cwd=Path.home())
        return (r.stdout or r.stderr).strip()
    if engine == "codex" and which("codex"):
        with tempfile.NamedTemporaryFile("r", suffix=".txt") as f:
            r = subprocess.run([which("codex"), "exec", "--skip-git-repo-check",
                                "--output-last-message", f.name, prompt],
                               capture_output=True, text=True, timeout=300,
                               cwd=Path.home(), stdin=subprocess.DEVNULL)
            return (f.read() or r.stderr[-2000:]).strip()
    if engine == "opencode" and which("opencode"):
        r = subprocess.run([which("opencode"), "run", prompt], capture_output=True,
                           text=True, timeout=300, cwd=Path.home())
        return re.sub(r"\x1b\[[0-9;]*m", "", r.stdout or r.stderr).strip()
    return f"{engine} não está instalado."


_quotes_cache = {"t": 0, "data": None}


def http_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "mac-widgets/1.0"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)


def quotes(codes):
    key = ",".join(codes)
    if _quotes_cache["data"] and _quotes_cache.get("k") == key and time.time() - _quotes_cache["t"] < 45:
        return _quotes_cache["data"]
    out = {}
    try:
        pairs = ",".join(f"{c}-BRL" for c in codes)
        data = http_json(f"https://economia.awesomeapi.com.br/json/last/{pairs}")
        for c in codes:
            d = data.get(f"{c}BRL")
            if d:
                out[c] = {"bid": float(d["bid"]), "pct": float(d["pctChange"]),
                          "name": d["name"].split("/")[0]}
    except Exception:
        pass
    missing = [c for c in codes if c not in out]
    if missing:  # fallback sem variação diária
        try:
            rates = http_json("https://open.er-api.com/v6/latest/BRL")["rates"]
            for c in missing:
                if c in rates:
                    out[c] = {"bid": 1 / rates[c], "pct": None, "name": c}
        except Exception:
            pass
        crypto = {"BTC": "bitcoin", "ETH": "ethereum", "SOL": "solana"}
        ids = [crypto[c] for c in missing if c in crypto and c not in out]
        if ids:
            try:
                d = http_json("https://api.coingecko.com/api/v3/simple/price?vs_currencies=brl"
                              "&include_24hr_change=true&ids=" + ",".join(ids))
                for c, cid in crypto.items():
                    if cid in d:
                        out[c] = {"bid": d[cid]["brl"], "pct": d[cid].get("brl_24h_change"), "name": c}
            except Exception:
                pass
    _quotes_cache.update(t=time.time(), data=out, k=key)
    return out


def history(code):
    data = http_json(f"https://economia.awesomeapi.com.br/json/daily/{code}-BRL/15")
    return [float(d["bid"]) for d in reversed(data)]


_cpu_prev = [0, 0]


def system():
    with open("/proc/stat") as f:
        v = [int(x) for x in f.readline().split()[1:]]
    idle, total = v[3] + v[4], sum(v)
    di, dt = idle - _cpu_prev[0], total - _cpu_prev[1]
    _cpu_prev[:] = [idle, total]
    cpu = round(100 * (1 - di / dt)) if dt else 0
    mem = {}
    with open("/proc/meminfo") as f:
        for line in f:
            k, val = line.split(":")
            mem[k] = int(val.split()[0])
    ram = round(100 * (1 - mem["MemAvailable"] / mem["MemTotal"]))
    bat = None
    for b in Path("/sys/class/power_supply").glob("BAT*"):
        try:
            bat = {"pct": int((b / "capacity").read_text()),
                   "status": (b / "status").read_text().strip()}
        except OSError:
            pass
    disk = shutil.disk_usage(Path.home())
    return {"cpu": cpu, "ram": ram, "bat": bat,
            "disk": round(100 * disk.used / disk.total)}


# ---- Spotify (MPRIS via D-Bus)

BROWSERS = ("brave", "chromium", "chrome", "firefox", "edge", "vivaldi", "opera", "epiphany")


def _mpris_names():
    bus = Gio.bus_get_sync(Gio.BusType.SESSION)
    names = bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus",
                          "org.freedesktop.DBus", "ListNames", None, None,
                          Gio.DBusCallFlags.NONE, 2000).unpack()[0]
    return bus, [n for n in names if n.startswith("org.mpris.MediaPlayer2.")]


def _is_browser(name):
    return any(b in name.lower() for b in BROWSERS)


def _player_info(bus, name):
    def prop(p, iface="org.mpris.MediaPlayer2.Player"):
        return bus.call_sync(name, "/org/mpris/MediaPlayer2", "org.freedesktop.DBus.Properties",
                             "Get", GLib.Variant("(ss)", (iface, p)),
                             None, Gio.DBusCallFlags.NONE, 2000).unpack()[0]
    meta = prop("Metadata")
    try:
        pos = prop("Position")
    except GLib.Error:
        pos = 0
    art = meta.get("mpris:artUrl", "")
    if art.startswith("http"):
        art_file = cache_file(art, "art")
    elif art.startswith("file://"):
        art_file = copy_art(art[7:], meta.get("xesam:title", ""))
    else:
        art_file = ""
    return {
        "running": True,
        "bus": name,
        "player": name.split(".")[3] if name.count(".") >= 3 else name,
        "browser": _is_browser(name),
        "status": prop("PlaybackStatus"),
        "title": meta.get("xesam:title", ""),
        "artist": ", ".join(meta.get("xesam:artist") or [""]),
        "album": meta.get("xesam:album", ""),
        "url": meta.get("xesam:url", ""),
        "artFile": art_file,
        "length": meta.get("mpris:length", 0) / 1e6,
        "position": pos / 1e6,
    }


def copy_art(path, key):
    """Navegadores apagam a miniatura temporária ao trocar de vídeo: guarda uma cópia."""
    d = CACHE / "art"
    d.mkdir(parents=True, exist_ok=True)
    dest = d / (uuid.uuid5(uuid.NAMESPACE_URL, "local:" + key).hex + ".png")
    if not dest.exists():
        try:
            shutil.copyfile(path, dest)
        except OSError:
            return path
    return str(dest)


_yt_search_cache = {}


def yt_lookup(title, channel):
    """Acha o vídeo pelo título+canal (o navegador não informa a URL) e devolve id e miniatura."""
    key = f"{title}|{channel}"
    if key in _yt_search_cache:
        return _yt_search_cache[key]
    found = {"id": None, "thumb": "", "url": ""}
    try:
        q = urllib.parse.quote(f"{title} {channel}")
        req = urllib.request.Request(f"https://www.youtube.com/results?search_query={q}",
                                     headers={"User-Agent": "Mozilla/5.0", "Accept-Language": "pt-BR"})
        with urllib.request.urlopen(req, timeout=8) as r:
            html = r.read().decode("utf-8", "ignore")
        m = re.search(r'"videoRenderer":\{"videoId":"([\w-]{11})"', html) or re.search(r'"videoId":"([\w-]{11})"', html)
        if m:
            vid = m.group(1)
            found = {"id": vid, "url": f"https://www.youtube.com/watch?v={vid}",
                     "thumb": cache_file(f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg", "yt")}
    except Exception:
        pass
    if len(_yt_search_cache) > 200:
        _yt_search_cache.clear()
    _yt_search_cache[key] = found
    return found


def media(action=None, kind="music", bus_name=None):
    """kind=music: Spotify/players de música · kind=video: vídeo tocando no navegador."""
    bus, names = _mpris_names()
    if kind == "video":
        names = [n for n in names if _is_browser(n)]
    else:
        names = [n for n in names if not _is_browser(n)]
        names.sort(key=lambda n: "spotify" not in n)
    infos = []
    for n in names:
        try:
            info = _player_info(bus, n)
        except GLib.Error:
            continue
        if info["title"]:
            infos.append(info)
    if kind == "video":  # prioriza o que está tocando
        infos.sort(key=lambda i: i["status"] != "Playing")
    if not infos:
        return {"running": False}
    cur = next((i for i in infos if i["bus"] == bus_name), infos[0])
    if kind == "video" and not action:
        cur = with_video(cur)
    if action in ("PlayPause", "Next", "Previous", "Raise"):
        iface = "org.mpris.MediaPlayer2" if action == "Raise" else "org.mpris.MediaPlayer2.Player"
        try:
            bus.call_sync(cur["bus"], "/org/mpris/MediaPlayer2", iface, action, None, None,
                          Gio.DBusCallFlags.NONE, 2000)
        except GLib.Error:
            pass
        time.sleep(0.25)
        cur = _player_info(bus, cur["bus"])
        if kind == "video":
            cur = with_video(cur)
    return cur


def with_video(info):
    yt = yt_lookup(info["title"], info["artist"])
    if yt["id"]:
        info["videoId"] = yt["id"]
        info["url"] = info["url"] or yt["url"]
        if not info["artFile"] or not os.path.exists(info["artFile"]):
            info["artFile"] = yt["thumb"]
    elif info["artFile"] and not os.path.exists(info["artFile"]):
        info["artFile"] = ""
    return info


# ---- cache de imagens remotas (capa do Spotify, miniatura do YouTube)

def cache_file(url, sub):
    if not url:
        return ""
    d = CACHE / sub
    d.mkdir(parents=True, exist_ok=True)
    path = d / (uuid.uuid5(uuid.NAMESPACE_URL, url).hex + ".jpg")
    if not path.exists():
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "mac-widgets/1.0"})
            with urllib.request.urlopen(req, timeout=10) as r:
                path.write_bytes(r.read())
        except Exception:
            return ""
        files = sorted(d.iterdir(), key=lambda p: p.stat().st_mtime)
        for old in files[:-60]:  # mantém o cache pequeno
            old.unlink(missing_ok=True)
    return str(path)


def yt_id(url):
    m = re.search(r"(?:v=|youtu\.be/|shorts/|embed/|live/)([\w-]{11})", url or "")
    if m:
        return m.group(1)
    return url if re.fullmatch(r"[\w-]{11}", url or "") else None


_yt_cache = {}


def yt_info(url):
    if url in _yt_cache:
        return _yt_cache[url]
    vid = yt_id(url)
    info = {"id": vid, "title": "", "author": "", "thumb": ""}
    try:
        d = http_json("https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote(url, safe=""))
        info.update(title=d.get("title", ""), author=d.get("author_name", ""))
        info["thumb"] = cache_file(d.get("thumbnail_url", ""), "yt")
    except Exception:
        pass
    if not info["thumb"] and vid:
        info["thumb"] = cache_file(f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg", "yt")
    _yt_cache[url] = info
    return info


# ---- widgets da área de trabalho (lidos pela extensão do GNOME)

DESK_DEFAULT = {
    "theme": "dark", "opacity": 0.82, "locked": False, "snap": True, "enabled": True,
    "widgets": [
        {"type": "clock", "size": "m"},
        {"type": "quotes", "size": "m", "opts": {"codes": ["USD", "EUR", "BTC"]}},
        {"type": "calendar", "size": "s"},
        {"type": "system", "size": "s"},
        {"type": "spotify", "size": "m"},
        {"type": "photos", "size": "m"},
        {"type": "ai", "size": "m"},
    ],
}
DESK_GLOBAL = {"theme", "opacity", "locked", "snap", "enabled"}
DESK_FIELDS = {"size", "scale", "x", "y", "opts"}
_desk_lock = threading.Lock()


def desk_load():
    try:
        return json.loads(DESK_FILE.read_text())
    except (OSError, ValueError):
        d = json.loads(json.dumps(DESK_DEFAULT))
        for w in d["widgets"]:
            w.update(id=uuid.uuid4().hex[:8], scale=1.0, x=None, y=None)
            w.setdefault("opts", {})
        desk_save(d)
        return d


def desk_save(d):
    CONF_DIR.mkdir(parents=True, exist_ok=True)
    tmp = DESK_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, ensure_ascii=False, indent=1))
    tmp.replace(DESK_FILE)


def desk_op(op):
    """Alterações atômicas (ler-modificar-gravar) vindas da extensão ou do painel."""
    with _desk_lock:
        d = desk_load()
        kind = op.get("op")
        if kind == "global":
            d.update({k: v for k, v in op["patch"].items() if k in DESK_GLOBAL})
        elif kind == "add":
            w = {"id": uuid.uuid4().hex[:8], "type": op["type"], "size": op.get("size", "s"),
                 "scale": 1.0, "x": None, "y": None, "opts": op.get("opts", {})}
            d["widgets"].append(w)
        elif kind == "remove":
            d["widgets"] = [w for w in d["widgets"] if w["id"] != op["id"]]
        elif kind == "set":
            for w in d["widgets"]:
                if w["id"] == op["id"]:
                    patch = {k: v for k, v in op["patch"].items() if k in DESK_FIELDS}
                    if "opts" in patch:
                        patch["opts"] = {**w.get("opts", {}), **patch["opts"]}
                    w.update(patch)
        elif kind == "move":  # várias posições de uma vez
            pos = op["positions"]
            for w in d["widgets"]:
                if w["id"] in pos:
                    w["x"], w["y"] = pos[w["id"]]
        elif kind == "relayout":
            for w in d["widgets"]:
                w["x"] = w["y"] = None
        desk_save(d)
        return d


# ---- config

def load_config():
    try:
        return json.loads(CONF_FILE.read_text())
    except (OSError, ValueError):
        return None


def save_config(cfg):
    CONF_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CONF_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=1))
    tmp.replace(CONF_FILE)


def list_photos():
    PHOTOS.mkdir(parents=True, exist_ok=True)
    files = [p for p in PHOTOS.iterdir() if p.suffix.lower() in PHOTO_EXT]
    return [p.name for p in sorted(files, key=lambda p: p.stat().st_mtime)]


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        if not isinstance(body, (bytes, bytearray)):
            body = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path):
        if not path.is_file():
            return self._send(404, {"error": "not found"})
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self._send(200, path.read_bytes(), ctype)

    def _authed(self):
        return self.headers.get("X-Token") == TOKEN

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path in ("/", "/settings"):
            page = "index.html" if path == "/" else "settings.html"
            html = (WEB / page).read_text().replace("__TOKEN__", TOKEN)
            return self._send(200, html.encode(), "text/html; charset=utf-8")
        if path.startswith("/web/"):
            target = (WEB / path[5:]).resolve()
            if WEB in target.parents:
                return self._file(target)
            return self._send(403, {})
        if path.startswith("/photo/"):  # <img> não envia header; nome é aleatório
            name = Path(path[7:]).name
            return self._file(PHOTOS / name)
        if not self._authed():
            return self._send(403, {"error": "token"})
        try:
            if path == "/api/config":
                return self._send(200, load_config() or {})
            if path == "/api/quotes":
                codes = [c for c in query.replace("codes=", "").split(",") if re.fullmatch(r"[A-Z]{3,4}", c)]
                return self._send(200, quotes(codes or ["USD", "EUR", "BTC"]))
            if path == "/api/history":
                code = query.replace("code=", "")
                if not re.fullmatch(r"[A-Z]{3,4}", code):
                    return self._send(400, {})
                return self._send(200, history(code))
            if path == "/api/system":
                return self._send(200, system())
            if path == "/api/media":
                kind = urllib.parse.parse_qs(query).get("kind", ["music"])[0]
                return self._send(200, media(kind=kind))
            if path == "/api/photos":
                return self._send(200, list_photos())
            if path == "/api/ai":
                return self._send(200, ai_tools())
            if path == "/api/desktop":
                with _desk_lock:
                    return self._send(200, desk_load())
            if path == "/api/yt":
                url = urllib.parse.parse_qs(query).get("url", [""])[0]
                return self._send(200, yt_info(url))
        except Exception as e:  # noqa: BLE001
            return self._send(500, {"error": str(e)})
        self._send(404, {})

    def do_POST(self):
        if not self._authed():
            return self._send(403, {"error": "token"})
        path, _, query = self.path.partition("?")
        try:
            if path == "/api/config":
                save_config(json.loads(self._body()))
                return self._send(200, {"ok": True})
            if path == "/api/media":
                d = json.loads(self._body())
                return self._send(200, media(d.get("action"), d.get("kind", "music"), d.get("bus")))
            if path == "/api/photos":
                ext = Path(self.headers.get("X-Filename", "x.jpg")).suffix.lower()
                if ext not in PHOTO_EXT:
                    return self._send(400, {"error": "formato não suportado"})
                PHOTOS.mkdir(parents=True, exist_ok=True)
                name = uuid.uuid4().hex + ext
                (PHOTOS / name).write_bytes(self._body())
                return self._send(200, {"name": name})
            if path == "/api/photos/delete":
                name = Path(json.loads(self._body())["name"]).name
                (PHOTOS / name).unlink(missing_ok=True)
                return self._send(200, {"ok": True})
            if path == "/api/ai/launch":
                return self._send(200, {"ok": ai_launch(json.loads(self._body())["id"])})
            if path == "/api/ai/ask":
                d = json.loads(self._body())
                return self._send(200, {"answer": ai_ask(d["engine"], d["prompt"])})
            if path == "/api/open":
                url = json.loads(self._body())["url"]
                if url.startswith(("https://", "http://")):
                    Gio.AppInfo.launch_default_for_uri(url, None)
                    GLib.idle_add(APP.hide)
                return self._send(200, {"ok": True})
            if path == "/api/desktop":
                return self._send(200, desk_op(json.loads(self._body())))
            if path == "/api/browser":  # abre link sem mexer no painel
                url = json.loads(self._body())["url"]
                if url.startswith(("https://", "http://")):
                    Gio.AppInfo.launch_default_for_uri(url, None)
                return self._send(200, {"ok": True})
            if path == "/api/panel":
                GLib.idle_add(APP.show_panel)
                return self._send(200, {"ok": True})
            if path == "/api/settings":
                GLib.idle_add(APP.show_settings, json.loads(self._body() or b"{}").get("id"))
                return self._send(200, {"ok": True})
            if path == "/api/spotify/open":
                subprocess.Popen([which("spotify") or "spotify"], start_new_session=True)
                return self._send(200, {"ok": True})
        except subprocess.TimeoutExpired:
            return self._send(200, {"answer": "Tempo esgotado (5 min)."})
        except Exception as e:  # noqa: BLE001
            return self._send(500, {"error": str(e)})
        self._send(404, {})


def start_server():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]
    CONF_DIR.mkdir(parents=True, exist_ok=True)
    fd = os.open(SERVER_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"port": port, "token": TOKEN, "pid": os.getpid()}, f)
    return port


# ---------------------------------------------------------------- GTK

class App(Gtk.Application):
    def __init__(self):
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.HANDLES_COMMAND_LINE)
        self.win = None
        self.settings_win = None
        self.port = None
        self.hidden_start = False

    def do_command_line(self, cmdline):
        args = cmdline.get_arguments()[1:]
        settings = next((a for a in args if a.startswith("--settings")), None)
        first = self.win is None
        if first:
            self.hidden_start = "--hidden" in args or settings is not None
            self.build()
        shot = next((a[20:] for a in args if a.startswith("--snapshot-settings=")), None)
        if shot:
            self.show_settings(next((a[8:] for a in args if a.startswith("--focus=")), None))
            GLib.timeout_add(2500, self._snapshot, shot, self.settings_view)
            return 0
        if settings is not None:
            self.show_settings(settings.partition("=")[2] or None)
        elif "--show" in args:
            self.show_panel()
        elif first:
            pass
        elif snap := next((a[11:] for a in args if a.startswith("--snapshot=")), None):
            self.show()
            GLib.timeout_add(3000, self._snapshot, snap)
        elif "--hidden" not in args:
            self.toggle()
        return 0

    def _snapshot(self, path, view=None):
        def done(view, res):
            surface = view.get_snapshot_finish(res)
            surface.write_to_png(path)
        (view or self.view).get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.TRANSPARENT_BACKGROUND,
                               None, done)
        return False

    def build(self):
        port = self.port = start_server()
        self.win = Gtk.ApplicationWindow(application=self, title="Widgets")
        self.win.set_decorated(False)
        self.win.set_skip_taskbar_hint(True)
        screen = self.win.get_screen()
        visual = screen.get_rgba_visual()
        if visual:
            self.win.set_visual(visual)
        self.win.set_app_paintable(True)
        self.win.connect("draw", self._clear)
        self.win.connect("delete-event", lambda *a: self.hide() or True)
        self.win.connect("key-press-event", self._key)

        ucm = WebKit2.UserContentManager()
        ucm.register_script_message_handler("mw")
        ucm.connect("script-message-received::mw", self._msg)
        self.view = WebKit2.WebView.new_with_user_content_manager(ucm)
        self.view.set_background_color(Gdk.RGBA(0, 0, 0, 0))
        s = self.view.get_settings()
        s.set_enable_developer_extras(True)
        s.set_media_playback_requires_user_gesture(False)
        s.set_enable_write_console_messages_to_stdout(True)
        s.set_user_agent_with_application_details("Chrome", "130")
        self.view.connect("decide-policy", self._policy)
        self.view.load_uri(f"http://127.0.0.1:{port}/")
        self.win.add(self.view)
        self.win.fullscreen()
        if not self.hidden_start:
            self.show()
        self.hold()

    @staticmethod
    def _clear(widget, cr):
        cr.set_source_rgba(0, 0, 0, 0)
        cr.set_operator(1)  # SOURCE
        cr.paint()
        return False

    def _policy(self, view, decision, kind):
        # links que tentam abrir nova janela vão para o navegador padrão
        if kind == WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION:
            uri = decision.get_navigation_action().get_request().get_uri()
            if uri.startswith("http"):
                Gio.AppInfo.launch_default_for_uri(uri, None)
                self.hide()
            decision.ignore()
            return True
        return False

    def _key(self, _w, ev):
        if ev.keyval == Gdk.KEY_Escape:
            self.view.evaluate_javascript("window.onEscape && window.onEscape()", -1, None, None, None)
            return True
        return False

    def _msg(self, _ucm, result):
        msg = result.get_js_value().to_string()
        if msg == "hide":
            self.hide()

    def show(self):
        self.win.show_all()
        self.win.fullscreen()
        self.win.present()
        self.view.evaluate_javascript("window.onShow && window.onShow()", -1, None, None, None)

    def hide(self):
        self.view.evaluate_javascript("window.onHide && window.onHide()", -1, None, None, None)
        self.win.hide()

    def show_panel(self):
        if not self.win.get_visible():
            self.show()
        return False

    def show_settings(self, focus=None):
        if self.settings_win is None:
            w = self.settings_win = Gtk.ApplicationWindow(application=self, title="Configurações dos widgets")
            w.set_default_size(1040, 720)
            w.set_icon_name("preferences-desktop-apps")
            w.connect("delete-event", lambda *a: w.hide() or True)
            self.settings_view = WebKit2.WebView()
            self.settings_view.get_settings().set_enable_developer_extras(True)
            self.settings_view.connect("decide-policy", self._policy)
            w.add(self.settings_view)
        q = f"?focus={focus}" if focus else ""
        self.settings_view.load_uri(f"http://127.0.0.1:{self.port}/settings{q}")
        self.settings_win.show_all()
        self.settings_win.present()
        return False

    def toggle(self):
        if self.win.get_visible():
            self.hide()
        else:
            self.show()


if __name__ == "__main__":
    APP = App()
    sys.exit(APP.run(sys.argv))
