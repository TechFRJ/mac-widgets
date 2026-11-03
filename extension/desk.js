// Widgets da área de trabalho. Ficam acima do papel de parede / ícones e abaixo das janelas.
// Arrastar = mover · canto inferior direito = redimensionar · botão direito = menu.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const HOME = GLib.get_home_dir();
const CONF = `${GLib.get_user_config_dir()}/mac-widgets`;
const DESK_FILE = `${CONF}/desktop.json`;
const PHOTOS = `${CONF}/photos`;
const BACKEND = `${HOME}/mac-widgets/widgets.py`;

const CELL = 150, GAP = 14, SNAP = 10;
const SIZES = {s: [1, 1], m: [2, 1], l: [2, 2]};
const SIZE_NAMES = {s: 'Pequeno', m: 'Médio', l: 'Grande'};
const MIN_SCALE = 0.6, MAX_SCALE = 2.2;
const STOP = Clutter.EVENT_STOP, PROPAGATE = Clutter.EVENT_PROPAGATE;

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const log = (...a) => console.log('[mac-widgets]', ...a);

function readJSON(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return JSON.parse(decoder.decode(bytes));
    } catch {
        return null;
    }
}

const dims = (size, scale) => {
    const [cw, ch] = SIZES[size] ?? SIZES.s;
    return [Math.round((cw * CELL + (cw - 1) * GAP) * scale), Math.round((ch * CELL + (ch - 1) * GAP) * scale)];
};

// ------------------------------------------------------------------ backend HTTP

class Api {
    constructor() {
        this._session = new Soup.Session({timeout: 20});
        this._spawned = 0;
    }

    _server() {
        const s = readJSON(`${CONF}/server.json`);
        if (s?.pid && GLib.file_test(`/proc/${s.pid}`, GLib.FileTest.EXISTS))
            return s;
        // backend parado: inicia (no máximo a cada 15 s)
        if (Date.now() - this._spawned > 15000) {
            this._spawned = Date.now();
            try {
                Gio.Subprocess.new(['python3', BACKEND, '--hidden'], Gio.SubprocessFlags.NONE);
            } catch (e) {
                log('não consegui iniciar o backend', e);
            }
        }
        return null;
    }

    request(path, body) {
        const s = this._server();
        if (!s)
            return Promise.reject(new Error('backend indisponível'));
        const msg = Soup.Message.new(body === undefined ? 'GET' : 'POST', `http://127.0.0.1:${s.port}${path}`);
        msg.request_headers.append('X-Token', s.token);
        if (body !== undefined)
            msg.set_request_body_from_bytes('application/json', new GLib.Bytes(encoder.encode(JSON.stringify(body))));
        return new Promise((resolve, reject) => {
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
                try {
                    const bytes = sess.send_and_read_finish(res);
                    if (msg.get_status() !== 200)
                        throw new Error(`HTTP ${msg.get_status()} ${path}`);
                    resolve(JSON.parse(decoder.decode(bytes.get_data())));
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    get(path) {
        return this.request(path);
    }

    post(path, body = {}) {
        return this.request(path, body);
    }

    destroy() {
        this._session.abort();
    }
}

// ------------------------------------------------------------------ helpers de UI

const VERT = Clutter.Orientation.VERTICAL, HORIZ = Clutter.Orientation.HORIZONTAL;

function label(text, cls = '', style = '', props = {}) {
    const l = new St.Label({text: String(text ?? ''), style_class: cls, style, y_align: Clutter.ActorAlign.CENTER, ...props});
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}

function box(vertical, cls = '', style = '', props = {}) {
    return new St.BoxLayout({orientation: vertical ? VERT : HORIZ, style_class: cls, style, ...props});
}

const spacer = () => new St.Widget({x_expand: true, y_expand: true});

function button(child, cls, onClick, props = {}) {
    const b = new St.Button({child, style_class: cls, can_focus: false, ...props});
    b.connect('clicked', () => onClick());
    return b;
}

function icon(name, px, cls = '') {
    return new St.Icon({icon_name: name, style_class: cls, style: `icon-size: ${Math.round(px)}px;`});
}

function drawing(style, paint, props = {}) {
    const a = new St.DrawingArea({style, ...props});
    a.connect('repaint', area => {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        try {
            paint(cr, w, h);
        } catch (e) {
            log('paint', e);
        }
        cr.$dispose();
    });
    return a;
}

const fileUrl = p => `url("file://${p.replace(/"/g, '%22')}")`;

function rgba(cr, hex, a = 1) {
    const n = parseInt(hex.slice(1), 16);
    cr.setSourceRGBA((n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255, a);
}

const brl = v => {
    const d = v >= 1000 ? 0 : v < 1 ? 4 : 2;
    const [i, f] = v.toFixed(d).split('.');
    return `R$ ${i.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${f ? `,${f}` : ''}`;
};
const pad2 = n => String(n).padStart(2, '0');
const fmtTime = s => `${Math.floor(s / 60)}:${pad2(Math.floor(s % 60))}`;
const WEEK = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

function zoneTime(zone) {
    try {
        const tz = GLib.TimeZone.new_identifier(zone);
        return tz ? GLib.DateTime.new_now(tz).format('%H:%M') : '--:--';
    } catch {
        return '--:--';
    }
}

const ZONES = {
    'America/Sao_Paulo': 'São Paulo', 'America/New_York': 'Nova York', 'Europe/Lisbon': 'Lisboa',
    'Europe/London': 'Londres', 'Europe/Paris': 'Paris', 'Asia/Tokyo': 'Tóquio',
    'America/Los_Angeles': 'Los Angeles', 'Asia/Dubai': 'Dubai', 'Australia/Sydney': 'Sydney',
};

const CURRENCIES = {
    USD: ['🇺🇸', 'Dólar americano'], EUR: ['🇪🇺', 'Euro'], GBP: ['🇬🇧', 'Libra esterlina'],
    BTC: ['₿', 'Bitcoin'], ETH: ['Ξ', 'Ethereum'], SOL: ['◎', 'Solana'],
    JPY: ['🇯🇵', 'Iene'], ARS: ['🇦🇷', 'Peso argentino'], CAD: ['🇨🇦', 'Dólar canadense'],
    CHF: ['🇨🇭', 'Franco suíço'], CNY: ['🇨🇳', 'Yuan'], AUD: ['🇦🇺', 'Dólar australiano'],
};

const AI_LOOK = {
    claude: ['background-color: #d97757; color: #fff;', '✳'],
    codex: ['background-color: #0d0d0d; color: #fff; font-family: monospace;', '>_'],
    opencode: ['background-color: #f1ecec; color: #211e1e; font-family: monospace;', 'oc'],
    gemini: ['background-gradient-direction: horizontal; background-gradient-start: #4285f4; background-gradient-end: #d96570; color: #fff;', '✦'],
    chatgpt: ['background-color: #10a37f; color: #fff;', '◎'],
    ollama: ['background-color: #ffffff; color: #000;', '🦙'],
};

// ------------------------------------------------------------------ tipos de widget
// Cada build(w) monta o conteúdo em w.body. Medidas em "em" acompanham a escala do widget.

const TYPES = {};

TYPES.clock = {
    name: 'Relógio', sizes: ['s', 'm', 'l'],
    build(w) {
        if (w.cfg.size === 's') {
            w.pad(8);
            const light = w.theme === 'light';
            const area = drawing('', (cr, W, H) => {
                const r = Math.min(W, H) / 2, cx = W / 2, cy = H / 2;
                const now = GLib.DateTime.new_now_local();
                rgba(cr, light ? '#ffffff' : '#1c1c1e');
                cr.arc(cx, cy, r, 0, 2 * Math.PI);
                cr.fill();
                rgba(cr, light ? '#1c1c1e' : '#f5f5f7');
                cr.selectFontFace('Ubuntu Sans', 0, 1);
                cr.setFontSize(r * 0.22);
                for (let i = 1; i <= 12; i++) {
                    const a = (i * 30 - 90) * Math.PI / 180, t = String(i);
                    const e = cr.textExtents(t);
                    cr.moveTo(cx + r * 0.78 * Math.cos(a) - e.width / 2 - e.xBearing, cy + r * 0.78 * Math.sin(a) - e.height / 2 - e.yBearing);
                    cr.showText(t);
                }
                const s = now.get_second(), m = now.get_minute() + s / 60, hr = now.get_hour() % 12 + m / 60;
                const hand = (ang, len, width, color, back = 0) => {
                    const a = (ang - 90) * Math.PI / 180;
                    rgba(cr, color);
                    cr.setLineWidth(width);
                    cr.setLineCap(1);
                    cr.moveTo(cx - Math.cos(a) * back, cy - Math.sin(a) * back);
                    cr.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
                    cr.stroke();
                };
                const fg = light ? '#1c1c1e' : '#f5f5f7';
                hand(hr * 30, r * 0.48, r * 0.07, fg);
                hand(m * 6, r * 0.72, r * 0.05, fg);
                hand(s * 6, r * 0.8, r * 0.022, '#ff9f0a', r * 0.15);
                rgba(cr, '#ff9f0a');
                cr.arc(cx, cy, r * 0.05, 0, 2 * Math.PI);
                cr.fill();
            }, {x_expand: true, y_expand: true});
            w.body.add_child(area);
            w.every(1000, () => area.queue_repaint());
            return;
        }
        const col = w.col();
        const tz = GLib.TimeZone.new_local().get_identifier();
        col.add_child(label(ZONES[tz] ?? tz.split('/').pop().replace(/_/g, ' '), 'mw-muted', 'font-size: 0.85em;'));
        col.add_child(spacer());
        const row = box(false);
        const time = label('', 'mw-time');
        const secs = label('', 'mw-muted mw-secs', '', {y_align: Clutter.ActorAlign.END});
        row.add_child(time);
        row.add_child(secs);
        col.add_child(row);
        const date = label('', 'mw-muted', 'font-size: 1.1em;');
        col.add_child(date);
        col.add_child(spacer());
        const world = [];
        if (w.cfg.size === 'l') {
            const zones = w.cfg.opts.zones ?? ['America/New_York', 'Europe/Lisbon', 'Asia/Tokyo'];
            const wr = box(false, 'mw-world', '', {x_expand: true});
            for (const z of zones) {
                const c = box(true, '', '', {x_expand: true});
                const t = label('', 'mw-world-time', '', {x_align: Clutter.ActorAlign.CENTER});
                c.add_child(t);
                c.add_child(label(ZONES[z] ?? z, 'mw-muted', 'font-size: 0.8em;', {x_align: Clutter.ActorAlign.CENTER}));
                wr.add_child(c);
                world.push([t, z]);
            }
            col.add_child(wr);
        }
        w.every(1000, () => {
            const now = GLib.DateTime.new_now_local();
            time.text = now.format('%H:%M');
            secs.text = `:${now.format('%S')}`;
            date.text = `${cap(WEEK[now.get_day_of_week() % 7])}, ${now.get_day_of_month()} de ${MONTHS[now.get_month() - 1]}`;
            for (const [t, z] of world)
                t.text = zoneTime(z);
        });
    },
};

function monthGrid(w, big) {
    const now = GLib.DateTime.new_now_local();
    const y = now.get_year(), m = now.get_month(), today = now.get_day_of_month();
    const first = GLib.DateTime.new_local(y, m, 1, 0, 0, 0).get_day_of_week() % 7;
    const days = GLib.Date.get_days_in_month(m, y);
    const col = box(true, '', '', {x_expand: true, y_expand: true});
    col.add_child(label(MONTHS[m - 1].toUpperCase(), 'mw-red mw-bold', `font-size: ${big ? 1 : 0.85}em; margin-bottom: 0.4em;`));
    const lm = new Clutter.GridLayout({column_homogeneous: true, row_homogeneous: true});
    const grid = new St.Widget({layout_manager: lm, x_expand: true, y_expand: true, style: `font-size: ${big ? 1.15 : 0.82}em;`});
    'DSTQQSS'.split('').forEach((c, i) => lm.attach(label(c, 'mw-muted mw-bold', '', {x_align: Clutter.ActorAlign.CENTER}), i, 0, 1, 1));
    for (let d = 1; d <= days; d++) {
        const idx = first + d - 1;
        const l = label(String(d), d === today ? 'mw-today' : 'mw-bold', '', {x_align: Clutter.ActorAlign.CENTER});
        lm.attach(l, idx % 7, 1 + Math.floor(idx / 7), 1, 1);
    }
    col.add_child(grid);
    return col;
}

TYPES.calendar = {
    name: 'Calendário', sizes: ['s', 'm', 'l'],
    build(w) {
        const draw = () => {
            w.body.destroy_all_children();
            const now = GLib.DateTime.new_now_local();
            const day = box(true, '', '', {y_expand: true});
            day.add_child(label(WEEK[now.get_day_of_week() % 7].toUpperCase(), 'mw-red mw-bold', 'font-size: 0.9em;'));
            day.add_child(label(String(now.get_day_of_month()), 'mw-bigday'));
            day.add_child(spacer());
            day.add_child(label(`${cap(MONTHS[now.get_month() - 1])} de ${now.get_year()}`, 'mw-muted'));
            if (w.cfg.size === 's') {
                w.col().add_child(day);
            } else if (w.cfg.size === 'm') {
                const row = box(false, '', 'spacing: 1.2em;', {x_expand: true, y_expand: true});
                row.add_child(day);
                row.add_child(monthGrid(w, false));
                w.body.add_child(row);
            } else {
                w.body.add_child(monthGrid(w, true));
            }
        };
        w.every(60000, draw);
    },
};

const histCache = {};
function spark(vals, up) {
    return drawing('width: 5.5em; height: 2em;', (cr, W, H) => {
        if (!vals?.length)
            return;
        const min = Math.min(...vals), max = Math.max(...vals), r = max - min || 1;
        rgba(cr, up ? '#30d158' : '#ff453a');
        cr.setLineWidth(Math.max(1.5, H / 16));
        cr.setLineJoin(1);
        cr.setLineCap(1);
        vals.forEach((v, i) => {
            const x = (i / (vals.length - 1)) * (W - 2) + 1, y = H - 2 - ((v - min) / r) * (H - 4);
            if (i)
                cr.lineTo(x, y);
            else
                cr.moveTo(x, y);
        });
        cr.stroke();
    });
}

TYPES.quotes = {
    name: 'Cotações', sizes: ['s', 'm', 'l'],
    build(w) {
        const size = w.cfg.size;
        const codes = (w.cfg.opts.codes ?? ['USD', 'EUR', 'BTC']).slice(0, size === 'l' ? 6 : 3);
        const col = w.col();
        const head = box(false, '', 'spacing: 0.5em; margin-bottom: 0.3em;');
        head.add_child(label('R$', 'mw-badge', 'background-color: #30d158;'));
        head.add_child(label('COTAÇÕES', 'mw-muted mw-bold', 'font-size: 0.8em;'));
        if (size !== 's')
            col.add_child(head);
        const list = box(true, '', '', {y_expand: true});
        list.add_child(label('Carregando…', 'mw-muted'));
        col.add_child(list);
        const load = async () => {
            let q;
            try {
                q = await w.api.get(`/api/quotes?codes=${codes.join(',')}`);
                if (size === 'l') {
                    await Promise.all(codes.map(async c => {
                        if (!histCache[c] || Date.now() - histCache[c].t > 600000)
                            histCache[c] = {t: Date.now(), v: await w.api.get(`/api/history?code=${c}`).catch(() => null)};
                    }));
                }
            } catch {
                if (!w.alive)
                    return;
                list.destroy_all_children();
                list.add_child(label('Sem conexão', 'mw-muted', '', {y_expand: true, x_align: Clutter.ActorAlign.CENTER}));
                return;
            }
            if (!w.alive)
                return;
            list.destroy_all_children();
            codes.forEach((c, i) => {
                const d = q[c];
                const [flag, name] = CURRENCIES[c] ?? ['¤', c];
                const row = box(false, i ? 'mw-qrow mw-sep' : 'mw-qrow', '', {y_expand: true});
                row.add_child(label(flag, 'mw-flag'));
                const nm = box(true, '', '', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
                nm.add_child(label(c, 'mw-bold'));
                if (size !== 's')
                    nm.add_child(label(d ? name : 'indisponível', 'mw-muted', 'font-size: 0.8em;'));
                row.add_child(nm);
                if (!d) {
                    list.add_child(row);
                    return;
                }
                const up = (d.pct ?? 0) >= 0;
                if (size === 'l')
                    row.add_child(spark(histCache[c]?.v, up));
                const val = box(true, '', '', {y_align: Clutter.ActorAlign.CENTER});
                val.add_child(label(brl(d.bid), 'mw-bold', `font-size: ${size === 's' ? 0.95 : 1.05}em;`, {x_align: Clutter.ActorAlign.END}));
                if (size !== 's' && d.pct != null)
                    val.add_child(label(`${up ? '▲' : '▼'} ${Math.abs(d.pct).toFixed(2)}%`, up ? 'mw-pill-up' : 'mw-pill-down', '', {x_align: Clutter.ActorAlign.END}));
                row.add_child(val);
                list.add_child(row);
            });
        };
        w.every(60000, load);
    },
};

function listPhotos() {
    const out = [];
    try {
        const en = Gio.File.new_for_path(PHOTOS).enumerate_children('standard::name,time::modified', 0, null);
        let info;
        while ((info = en.next_file(null))) {
            if (/\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(info.get_name()))
                out.push(info.get_name());
        }
        en.close(null);
    } catch {}
    return out.sort();
}

TYPES.photos = {
    name: 'Fotos', sizes: ['s', 'm', 'l'],
    build(w) {
        w.pad(0);
        const photos = listPhotos();
        if (!photos.length) {
            const col = w.col('', {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
            col.add_child(label('🌄', '', 'font-size: 2.6em;', {x_align: Clutter.ActorAlign.CENTER}));
            col.add_child(label('Nenhuma foto', 'mw-muted', '', {x_align: Clutter.ActorAlign.CENTER}));
            col.add_child(button(label('Adicionar fotos'), 'mw-btn', () => w.openSettings(), {x_align: Clutter.ActorAlign.CENTER}));
            return;
        }
        const radius = w.radius;
        const layers = [0, 1].map(() => {
            const l = new St.Widget({x_expand: true, y_expand: true, opacity: 0});
            w.body.add_child(l);
            return l;
        });
        let idx = Math.floor(Math.random() * photos.length), cur = 0;
        const show = () => {
            idx = (idx + 1) % photos.length;
            cur = 1 - cur;
            const top = layers[cur], bottom = layers[1 - cur];
            top.style = `background-image: ${fileUrl(`${PHOTOS}/${photos[idx]}`)}; background-size: cover; border-radius: ${radius}px;`;
            w.body.set_child_above_sibling(top, bottom);
            top.opacity = 0;
            top.ease({opacity: 255, duration: 1200, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    bottom.opacity = 0;
                }});
        };
        w.every((w.cfg.opts.interval ?? 10) * 1000, show);
    },
};

// Mostra o vídeo que está tocando no navegador; sem vídeo, mostra o link configurado.
TYPES.youtube = {
    name: 'YouTube', sizes: ['s', 'm', 'l'],
    build(w) {
        w.pad(0);
        const auto = w.cfg.opts.auto !== false;
        let st = null, at = 0, key = null, bar = null, cur = null, playIcon = null, badge = null;

        const act = async a => {
            try {
                st = await w.api.post('/api/media', {action: a, kind: 'video', bus: st?.bus});
                at = Date.now();
                draw();
            } catch {}
        };

        const fallback = () => {
            const url = w.cfg.opts.url;
            if (!url) {
                const col = w.col('', {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
                col.add_child(new St.Bin({style_class: 'mw-yt-logo', child: icon('media-playback-start-symbolic', 18 * w.scale), x_align: Clutter.ActorAlign.CENTER}));
                col.add_child(label('YouTube', 'mw-bold', 'margin-top: 0.5em;', {x_align: Clutter.ActorAlign.CENTER}));
                if (w.cfg.size !== 's')
                    col.add_child(label(auto ? 'Aparece aqui quando você assistir' : 'Nenhum vídeo escolhido', 'mw-muted', 'font-size: 0.8em; margin-top: 0.2em;', {x_align: Clutter.ActorAlign.CENTER}));
                col.add_child(button(label('Escolher vídeo'), 'mw-btn', () => w.openSettings(), {x_align: Clutter.ActorAlign.CENTER}));
                return;
            }
            const card = videoCard(null, () => w.api.post('/api/browser', {url}).catch(() => {}));
            w.api.get(`/api/yt?url=${encodeURIComponent(url)}`).then(d => {
                if (!w.alive || key !== 'cfg')
                    return;
                card.setThumb(d.thumb);
                card.setText(d.title, d.author);
            }).catch(() => {});
        };

        // cartão: miniatura + sombra + textos; onOpen ao clicar na imagem
        const videoCard = (info, onOpen) => {
            const inner = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
            const card = button(inner, 'mw-yt-card', onOpen, {x_expand: true, y_expand: true});
            const thumb = new St.Widget({x_expand: true, y_expand: true, style: `border-radius: ${w.radius}px; background-color: #000;`});
            inner.add_child(thumb);
            inner.add_child(new St.Widget({x_expand: true, y_expand: true, style_class: 'mw-yt-shade', style: `border-radius: ${w.radius}px;`}));
            const info2 = box(true, '', 'padding: 0.9em;', {x_expand: true, y_align: Clutter.ActorAlign.END});
            const title = label('', 'mw-bold mw-shadow');
            title.clutter_text.line_wrap = w.cfg.size === 'l';
            const author = label('', 'mw-shadow', 'font-size: 0.8em; color: rgba(255,255,255,0.75);');
            if (w.cfg.size !== 's') {
                info2.add_child(title);
                info2.add_child(author);
            }
            inner.add_child(info2);
            w.body.add_child(card);
            return {
                inner, info: info2,
                setThumb: f => {
                    if (f)
                        thumb.style = `border-radius: ${w.radius}px; background-image: ${fileUrl(f)}; background-size: cover;`;
                },
                setText: (t, a) => {
                    title.text = t ?? '';
                    author.text = a ?? '';
                },
            };
        };

        const nowPlaying = () => {
            const card = videoCard(st, () => act('Raise'));
            card.setThumb(st.artFile);
            card.setText(st.title, st.artist);
            badge = label('', 'mw-yt-badge', '', {x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.START, x_expand: true, y_expand: true});
            badge.style = 'margin: 0.8em;';
            card.inner.add_child(badge);
            if (w.cfg.size !== 's') {
                bar = drawing('height: 0.3em; margin-top: 0.6em;', (cr, W, H) => {
                    cr.setSourceRGBA(1, 1, 1, 0.25);
                    cr.rectangle(0, 0, W, H);
                    cr.fill();
                    cr.setSourceRGBA(1, 0, 0.2, 1);
                    cr.rectangle(0, 0, W * (bar._p ?? 0), H);
                    cr.fill();
                }, {x_expand: true});
                card.info.add_child(bar);
                const times = box(false, '', 'font-size: 0.72em; margin-top: 0.2em;');
                cur = label('', 'mw-shadow');
                times.add_child(cur);
                times.add_child(spacer());
                times.add_child(label(st.length ? fmtTime(st.length) : '', 'mw-shadow'));
                card.info.add_child(times);
            }
            playIcon = icon('media-playback-start-symbolic', 16 * w.scale);
            const pb = button(playIcon, 'mw-play', () => act('PlayPause'),
                {x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.START, x_expand: true, y_expand: true});
            pb.style = 'margin: 0.7em;';
            w.body.add_child(pb);
        };

        const draw = () => {
            if (!w.alive)
                return;
            const live = auto && st?.running;
            const k = live ? `v|${st.title}|${st.artFile}` : 'cfg';
            if (k !== key) {
                key = k;
                bar = cur = playIcon = badge = null;
                w.body.destroy_all_children();
                if (live)
                    nowPlaying();
                else
                    fallback();
            }
            if (!live)
                return;
            const playing = st.status === 'Playing';
            playIcon.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
            badge.text = playing ? '●  ASSISTINDO' : '❚❚  PAUSADO';
            badge.style_class = playing ? 'mw-yt-badge' : 'mw-yt-badge mw-yt-paused';
            const pos = Math.min(st.length || 0, st.position + (playing ? (Date.now() - at) / 1000 : 0));
            if (bar) {
                bar._p = st.length ? pos / st.length : 0;
                bar.queue_repaint();
                cur.text = fmtTime(pos);
            }
        };

        if (!auto) {
            draw();
            return;
        }
        w.every(2500, async () => {
            try {
                st = await w.api.get('/api/media?kind=video');
                at = Date.now();
            } catch {
                st = null;
            }
            draw();
        });
        w.every(1000, () => st?.running && draw(), false);
    },
};

function spotifyLogo(px) {
    return drawing(`width: ${px}px; height: ${px}px;`, (cr, W) => {
        const r = W / 2;
        rgba(cr, '#1ed760');
        cr.arc(r, r, r, 0, 2 * Math.PI);
        cr.fill();
        rgba(cr, '#000000');
        cr.setLineCap(1);
        [[0.62, 0.36, 0.11], [0.5, 0.52, 0.09], [0.4, 0.66, 0.075]].forEach(([wd, y, lw]) => {
            cr.setLineWidth(W * lw);
            cr.moveTo(r - r * wd, W * y);
            cr.curveTo(r - r * wd * 0.3, W * (y - 0.08), r + r * wd * 0.3, W * (y - 0.08), r + r * wd, W * y + W * 0.03);
            cr.stroke();
        });
    });
}

TYPES.spotify = {
    name: 'Spotify', sizes: ['s', 'm', 'l'],
    build(w) {
        const size = w.cfg.size, s = w.scale;
        let st = null, at = 0, key = '';
        let bar = null, cur = null, playIcons = [];
        const act = async a => {
            try {
                st = await w.api.post('/api/media', {action: a});
                at = Date.now();
                key = '';
                draw();
            } catch {}
        };
        const ctrlBtn = (name, a, px, cls = 'mw-ctrl') => {
            const ic = icon(name, px);
            const b = button(ic, cls, () => act(a));
            if (a === 'PlayPause')
                playIcons.push(ic);
            return b;
        };
        const draw = () => {
            if (!w.alive)
                return;
            if (!st?.running) {
                if (key === 'off')
                    return;
                key = 'off';
                w.body.destroy_all_children();
                const col = w.col('', {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
                const logo = spotifyLogo(Math.round(40 * s));
                logo.x_align = Clutter.ActorAlign.CENTER;
                col.add_child(logo);
                if (size !== 's')
                    col.add_child(label('Spotify fechado', 'mw-muted', 'margin-top: 0.5em;', {x_align: Clutter.ActorAlign.CENTER}));
                col.add_child(button(label('Abrir'), 'mw-btn', () => w.api.post('/api/spotify/open').catch(() => {}), {x_align: Clutter.ActorAlign.CENTER}));
                return;
            }
            const k = `${st.title}|${st.artFile}`;
            if (k !== key) {
                key = k;
                playIcons = [];
                w.body.destroy_all_children();
                const artStyle = st.artFile ? `background-image: ${fileUrl(st.artFile)}; background-size: cover;` : 'background-color: #282828;';
                const logo = spotifyLogo(Math.round(18 * s));
                logo.x_align = Clutter.ActorAlign.END;
                logo.y_align = Clutter.ActorAlign.START;
                logo.x_expand = logo.y_expand = true;
                if (size === 's') {
                    w.pad(0);
                    const art = new St.Widget({x_expand: true, y_expand: true, style: `${artStyle} border-radius: ${w.radius}px;`});
                    w.body.add_child(art);
                    const pb = ctrlBtn('media-playback-start-symbolic', 'PlayPause', 16 * s, 'mw-play');
                    pb.x_align = Clutter.ActorAlign.END;
                    pb.y_align = Clutter.ActorAlign.END;
                    pb.x_expand = pb.y_expand = true;
                    pb.style = 'margin: 0.6em;';
                    w.body.add_child(pb);
                    logo.style += 'margin: 0.7em;';
                    w.body.add_child(logo);
                } else {
                    const wrap = box(size === 'l', '', 'spacing: 1em;', {x_expand: true, y_expand: true});
                    const artPx = size === 'l' ? null : Math.round(112 * s);
                    const art = new St.Widget({style: `${artStyle} border-radius: ${Math.round(10 * s)}px; ${artPx ? `width: ${artPx}px; height: ${artPx}px;` : ''}`,
                        x_expand: size === 'l', y_expand: size === 'l', y_align: Clutter.ActorAlign.CENTER});
                    wrap.add_child(art);
                    const info = box(true, '', '', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
                    info.add_child(label(st.title || '—', 'mw-bold', 'font-size: 1.15em;'));
                    info.add_child(label(st.artist, 'mw-muted'));
                    bar = drawing('height: 0.35em; margin-top: 0.8em;', (cr, W, H) => {
                        const p = bar._p ?? 0;
                        cr.setSourceRGBA(1, 1, 1, 0.22);
                        cr.rectangle(0, 0, W, H);
                        cr.fill();
                        cr.setSourceRGBA(1, 1, 1, 1);
                        cr.rectangle(0, 0, W * p, H);
                        cr.fill();
                    }, {x_expand: true});
                    info.add_child(bar);
                    const times = box(false, '', 'font-size: 0.75em; margin-top: 0.2em;');
                    cur = label('', 'mw-muted');
                    times.add_child(cur);
                    times.add_child(spacer());
                    times.add_child(label(fmtTime(st.length), 'mw-muted'));
                    info.add_child(times);
                    const ctrls = box(false, '', 'spacing: 1.2em; margin-top: 0.3em;', {x_align: Clutter.ActorAlign.CENTER});
                    ctrls.add_child(ctrlBtn('media-skip-backward-symbolic', 'Previous', 18 * s));
                    ctrls.add_child(ctrlBtn('media-playback-start-symbolic', 'PlayPause', 16 * s, 'mw-play'));
                    ctrls.add_child(ctrlBtn('media-skip-forward-symbolic', 'Next', 18 * s));
                    info.add_child(ctrls);
                    wrap.add_child(info);
                    w.body.add_child(wrap);
                    w.body.add_child(logo);
                }
            }
            const playing = st.status === 'Playing';
            for (const ic of playIcons)
                ic.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
            const pos = Math.min(st.length, st.position + (playing ? (Date.now() - at) / 1000 : 0));
            if (bar && size !== 's') {
                bar._p = st.length ? pos / st.length : 0;
                bar.queue_repaint();
                cur.text = fmtTime(pos);
            }
        };
        w.every(2500, async () => {
            try {
                st = await w.api.get('/api/media');
                at = Date.now();
            } catch {
                st = null;
            }
            draw();
        });
        w.every(1000, () => st?.running && draw(), false);
    },
};

let aiTools = null;
TYPES.ai = {
    name: 'IA', sizes: ['s', 'm', 'l'],
    build(w) {
        const size = w.cfg.size;
        const col = w.col();
        const head = box(false, '', 'spacing: 0.5em; margin-bottom: 0.5em;');
        head.add_child(label('✳', 'mw-badge', 'background-color: #d97757;'));
        head.add_child(label('ASSISTENTES DE IA', 'mw-muted mw-bold', 'font-size: 0.8em;', {x_expand: true}));
        if (size !== 's') {
            head.add_child(button(label('Perguntar'), 'mw-btn mw-btn-sm', () => w.api.post('/api/panel').catch(() => {})));
            col.add_child(head);
        }
        const fill = tools => {
            if (!w.alive)
                return;
            const n = {s: 4, m: 4, l: 6}[size];
            const chosen = w.cfg.opts.tools ? w.cfg.opts.tools.map(id => tools.find(t => t.id === id)).filter(Boolean) : tools;
            const shown = chosen.slice(0, n);
            const cols = {s: 2, m: 4, l: 3}[size];
            const lm = new Clutter.GridLayout({column_homogeneous: true, row_homogeneous: true, column_spacing: Math.round(6 * w.scale), row_spacing: Math.round(6 * w.scale)});
            const grid = new St.Widget({layout_manager: lm, x_expand: true, y_expand: true});
            shown.forEach((t, i) => {
                const [style, glyph] = AI_LOOK[t.id] ?? ['background-color: #444;', '?'];
                const c = box(true, '', 'spacing: 0.3em;', {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
                c.add_child(label(glyph, 'mw-ai-tile', style, {x_align: Clutter.ActorAlign.CENTER}));
                if (size !== 's')
                    c.add_child(label(t.name, 'mw-bold', 'font-size: 0.85em;', {x_align: Clutter.ActorAlign.CENTER}));
                if (size === 'l')
                    c.add_child(label(t.cli ? 'terminal' : t.web ? 'web' : 'não instalado', 'mw-muted', 'font-size: 0.7em;', {x_align: Clutter.ActorAlign.CENTER}));
                const b = button(c, 'mw-ai-btn', () => {
                    if (t.cli)
                        w.api.post('/api/ai/launch', {id: t.id}).catch(() => {});
                    else if (t.web)
                        w.api.post('/api/browser', {url: t.web}).catch(() => {});
                }, {x_expand: true, y_expand: true, opacity: t.cli || t.web ? 255 : 110});
                lm.attach(b, i % cols, Math.floor(i / cols), 1, 1);
            });
            col.add_child(grid);
            if (size === 'l') {
                col.add_child(button(label('✳  Perguntar à IA  ·  Super+W', 'mw-bold'), 'mw-btn mw-ask', () => w.api.post('/api/panel').catch(() => {}), {x_expand: true}));
            }
        };
        if (aiTools)
            fill(aiTools);
        else
            w.api.get('/api/ai').then(t => fill(aiTools = t)).catch(() => col.add_child(label('Backend indisponível', 'mw-muted')));
    },
};

function ring(pct, color, text, px) {
    return drawing(`width: ${px}px; height: ${px}px;`, (cr, W) => {
        const r = W / 2, lw = W * 0.12;
        cr.setLineWidth(lw);
        cr.setLineCap(1);
        cr.setSourceRGBA(1, 1, 1, 0.12);
        cr.arc(r, r, r - lw / 2, 0, 2 * Math.PI);
        cr.stroke();
        rgba(cr, color);
        const p = Math.max(0.001, Math.min(1, (pct ?? 0) / 100));
        cr.arc(r, r, r - lw / 2, -Math.PI / 2, -Math.PI / 2 + p * 2 * Math.PI);
        cr.stroke();
        cr.setSourceRGBA(0.96, 0.96, 0.97, 1);
        cr.selectFontFace('Ubuntu Sans', 0, 1);
        cr.setFontSize(W * 0.22);
        const e = cr.textExtents(text);
        cr.moveTo(r - e.width / 2 - e.xBearing, r - e.height / 2 - e.yBearing);
        cr.showText(text);
    });
}

TYPES.system = {
    name: 'Sistema', sizes: ['s', 'm'],
    build(w) {
        const size = w.cfg.size;
        const col = w.col();
        if (size === 'm') {
            const head = box(false, '', 'spacing: 0.5em; margin-bottom: 0.4em;');
            head.add_child(label('◔', 'mw-badge', 'background-color: #0a84ff;'));
            head.add_child(label('SISTEMA', 'mw-muted mw-bold', 'font-size: 0.8em;'));
            col.add_child(head);
        }
        const lm = new Clutter.GridLayout({column_homogeneous: true, row_homogeneous: true});
        const grid = new St.Widget({layout_manager: lm, x_expand: true, y_expand: true});
        col.add_child(grid);
        const px = Math.round((size === 's' ? 46 : 58) * w.scale);
        w.every(2500, async () => {
            let d;
            try {
                d = await w.api.get('/api/system');
            } catch {
                return;
            }
            if (!w.alive)
                return;
            grid.destroy_all_children();
            const items = [['CPU', d.cpu, '#0a84ff'], ['RAM', d.ram, '#bf5af2'], ['Disco', d.disk, '#ff9f0a']];
            if (d.bat)
                items.push([d.bat.status === 'Charging' ? '⚡Bat' : 'Bateria', d.bat.pct, d.bat.pct < 20 ? '#ff453a' : '#30d158']);
            items.forEach(([n, v, c], i) => {
                const cell = box(true, '', 'spacing: 0.2em;', {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
                const r = ring(v, c, `${Math.round(v)}%`, px);
                r.x_align = Clutter.ActorAlign.CENTER;
                cell.add_child(r);
                if (size === 'm')
                    cell.add_child(label(n.toUpperCase(), 'mw-muted mw-bold', 'font-size: 0.72em;', {x_align: Clutter.ActorAlign.CENTER}));
                const cols = size === 's' ? 2 : 4;
                lm.attach(cell, i % cols, Math.floor(i / cols), 1, 1);
            });
        });
    },
};

TYPES.notes = {
    name: 'Notas', sizes: ['s', 'm', 'l'],
    build(w) {
        w.pad(0);
        const col = w.col('mw-notes');
        col.add_child(label('Notas', 'mw-notes-head', `border-radius: ${w.radius}px ${w.radius}px 0 0;`));
        const text = new St.Label({text: w.cfg.opts.text || 'Clique para escrever…', style_class: 'mw-notes-text', y_expand: true});
        text.clutter_text.line_wrap = true;
        text.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        col.add_child(button(text, 'mw-notes-btn', () => w.openSettings(), {x_expand: true, y_expand: true}));
    },
};

// ------------------------------------------------------------------ widget (moldura comum)

class DeskWidget {
    constructor(desk, cfg) {
        this.desk = desk;
        this.api = desk.api;
        this.alive = true;
        this._timers = [];
        this.actor = new St.Widget({reactive: true, track_hover: true, layout_manager: new Clutter.BinLayout(), style_class: 'mw-widget'});
        this.actor._macWidget = true;
        this.actor.connect('captured-event', (a, ev) => this._onEvent(ev));
        this.actor.connect('notify::hover', () => this._handle?.ease({opacity: this.actor.hover && !this.desk.cfg.locked ? 255 : 0, duration: 150}));
        this.update(cfg, true);
    }

    get scale() {
        return this.cfg.scale ?? 1;
    }

    get theme() {
        return this.desk.cfg.theme ?? 'dark';
    }

    get radius() {
        return Math.round(22 * this.scale);
    }

    key(cfg) {
        const d = this.desk.cfg;
        return JSON.stringify([cfg.type, cfg.size, cfg.scale, cfg.opts, d.theme, d.opacity]);
    }

    update(cfg, force = false) {
        const k = this.key(cfg);
        this.cfg = cfg;
        if (force || k !== this._key) {
            this._key = k;
            this.build();
        }
        if (!this._dragging && cfg.x != null)
            this.actor.set_position(cfg.x, cfg.y);
    }

    build() {
        this._clearTimers();
        this.actor.destroy_all_children();
        const [w, h] = dims(this.cfg.size, this.scale);
        this.actor.set_size(w, h);
        const op = this.desk.cfg.opacity ?? 0.82;
        const bg = {dark: `rgba(28,28,32,${op})`, light: `rgba(246,246,248,${op})`, glass: `rgba(255,255,255,${Math.min(op, 0.5) * 0.36})`}[this.theme] ?? `rgba(28,28,32,${op})`;
        this.actor.style_class = `mw-widget mw-${this.theme} mw-t-${this.cfg.type}`;
        const ownBg = ['spotify', 'notes'].includes(this.cfg.type); // cores próprias no desk.css
        this.actor.style = `font-size: ${(13 * this.scale).toFixed(2)}px; border-radius: ${this.radius}px;${ownBg ? '' : ` background-color: ${bg};`}`;
        this.body = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true, style: `padding: ${Math.round(14 * this.scale)}px;`});
        this.actor.add_child(this.body);
        try {
            TYPES[this.cfg.type]?.build(this);
        } catch (e) {
            log(`erro no widget ${this.cfg.type}`, e, e.stack);
            this.body.add_child(label(`Erro: ${e.message}`, 'mw-muted'));
        }
        this._handle = drawing('width: 24px; height: 24px; margin: 3px;', (cr, W, H) => {
            cr.setSourceRGBA(1, 1, 1, 0.85);
            cr.setLineWidth(2.4);
            cr.setLineCap(1);
            cr.arc(0, 0, W - 2, 0, Math.PI / 2);
            cr.stroke();
        }, {reactive: true, opacity: 0, x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.END, x_expand: true, y_expand: true});
        this.actor.add_child(this._handle);
    }

    pad(px) {
        this.body.style = `padding: ${Math.round(px * this.scale)}px;`;
    }

    col(cls = '', props = {}) {
        const c = box(true, cls, '', {x_expand: true, y_expand: true, ...props});
        this.body.add_child(c);
        return c;
    }

    every(ms, fn, now = true) {
        const run = () => {
            try {
                const r = fn();
                r?.catch?.(e => log('timer', e));
            } catch (e) {
                log('timer', e);
            }
        };
        if (now)
            run();
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            run();
            return GLib.SOURCE_CONTINUE;
        });
        this._timers.push(id);
    }

    _clearTimers() {
        this._timers.forEach(id => GLib.source_remove(id));
        this._timers = [];
    }

    openSettings() {
        this.api.post('/api/settings', {id: this.cfg.id}).catch(() => {});
    }

    // ---- interação: mover, redimensionar, menu

    _onEvent(ev) {
        const type = ev.type();
        if (type === Clutter.EventType.BUTTON_PRESS) {
            const btn = ev.get_button();
            if (btn === Clutter.BUTTON_SECONDARY) {
                this._openMenu(ev);
                return STOP;
            }
            if (btn !== Clutter.BUTTON_PRIMARY || this.desk.cfg.locked)
                return PROPAGATE;
            const [x, y] = ev.get_coords();
            const src = global.stage.get_event_actor(ev);
            const resize = src === this._handle;
            this._press = {x, y, ax: this.actor.x, ay: this.actor.y, w: this.actor.width, src, resize, scale: this.scale};
            if (resize) {
                this._begin();
                return STOP;
            }
            return PROPAGATE;
        }
        if (type === Clutter.EventType.MOTION && this._press) {
            const p = this._press;
            const [x, y] = ev.get_coords();
            const dx = x - p.x, dy = y - p.y;
            if (!this._dragging) {
                if (Math.hypot(dx, dy) < 6)
                    return PROPAGATE;
                this._begin();
                for (let a = p.src; a && a !== this.actor; a = a.get_parent()) {
                    if (a instanceof St.Button)
                        a.fake_release();
                }
                this.actor.set_pivot_point(0.5, 0.5);
                this.actor.ease({scale_x: 1.03, scale_y: 1.03, duration: 120});
            }
            if (p.resize)
                this._resizeBy(dx);
            else
                this._moveTo(p.ax + dx, p.ay + dy, x, y);
            return STOP;
        }
        if (type === Clutter.EventType.BUTTON_RELEASE && this._press) {
            const p = this._press;
            this._press = null;
            if (this._dragging) {
                this._end(p);
                return STOP;
            }
        }
        return PROPAGATE;
    }

    _begin() {
        this._dragging = true;
        this._grab = global.stage.grab(this.actor);
        this.desk.raise(this);
    }

    _end(p) {
        this._grab?.dismiss();
        this._grab = null;
        this._dragging = false;
        this.desk._raised = null;
        this.actor.ease({scale_x: 1, scale_y: 1, duration: 150});
        if (p.resize) {
            if (this.scale !== p.scale)
                this.desk.save({op: 'set', id: this.cfg.id, patch: {scale: this.scale}});
            this.desk.ensureOnScreen(this);
        }
        this.cfg.x = Math.round(this.actor.x);
        this.cfg.y = Math.round(this.actor.y);
        this.desk.save({op: 'set', id: this.cfg.id, patch: {x: this.cfg.x, y: this.cfg.y}});
    }

    _moveTo(x, y, px, py) {
        const snap = this.desk.cfg.snap !== false;
        if (snap) {
            x = Math.round(x / SNAP) * SNAP;
            y = Math.round(y / SNAP) * SNAP;
            [x, y] = this.desk.magnet(this, x, y);
        }
        const wa = this.desk.workAreaAt(px, py);
        x = Math.max(wa.x, Math.min(x, wa.x + wa.width - this.actor.width));
        y = Math.max(wa.y, Math.min(y, wa.y + wa.height - this.actor.height));
        this.actor.set_position(x, y);
    }

    _resizeBy(dx) {
        const p = this._press;
        const [bw] = dims(this.cfg.size, 1);
        let s = (p.w + dx) / bw;
        s = Math.round(Math.max(MIN_SCALE, Math.min(MAX_SCALE, s)) * 20) / 20;
        if (s === this.scale)
            return;
        this.cfg.scale = s;
        this._key = this.key(this.cfg);
        this.build();
    }

    setSize(size) {
        if (size === this.cfg.size)
            return;
        this.cfg.size = size;
        this.update(this.cfg);
        this.desk.ensureOnScreen(this);
        this.desk.save({op: 'set', id: this.cfg.id, patch: {size, x: this.cfg.x, y: this.cfg.y}});
    }

    _openMenu(ev) {
        const [x, y] = ev.get_coords();
        this.desk.openMenu(this, x, y);
    }

    destroy() {
        this.alive = false;
        this._clearTimers();
        this._grab?.dismiss();
        this.actor.destroy();
    }
}

// ------------------------------------------------------------------ gerenciador

export class Desk {
    constructor(ext) {
        this.ext = ext;
        this.api = new Api();
        this.widgets = new Map();
        this.cfg = {widgets: []};
        this._signals = [];
        this._loadCss();

        this._menu = new PopupMenu.PopupMenu(Main.layoutManager.dummyCursor, 0, St.Side.TOP);
        Main.uiGroup.add_child(this._menu.actor);
        this._menu.actor.hide();
        this._menuMgr = new PopupMenu.PopupMenuManager(Main.layoutManager.dummyCursor);
        this._menuMgr.addMenu(this._menu);

        this._connect(global.display, 'restacked', () => this._queueRestack());
        this._connect(global.display, 'window-created', () => this._queueRestack());
        this._connect(Main.layoutManager, 'monitors-changed', () => this.widgets.forEach(w => this.ensureOnScreen(w)));

        const file = Gio.File.new_for_path(DESK_FILE);
        this._monitor = file.monitor_file(Gio.FileMonitorFlags.WATCH_MOVES, null);
        this._monitor.connect('changed', () => this._queueReload());
        this._reload();
        if (!GLib.file_test(DESK_FILE, GLib.FileTest.EXISTS))
            this._waitBackend();

        if (GLib.file_test(`${CONF}/dev`, GLib.FileTest.EXISTS)) {
            import(`file://${ext.path}/dev.js?v=${Date.now()}`)
                .then(m => {
                    this._dev = new m.Dev(this);
                }).catch(e => log('dev', e));
        }
    }

    _connect(obj, sig, fn) {
        this._signals.push([obj, obj.connect(sig, fn)]);
    }

    _loadCss() {
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        this._css = Gio.File.new_for_path(`${this.ext.path}/desk.css`);
        theme.load_stylesheet(this._css);
    }

    _waitBackend() {
        // primeira execução: pede ao backend para criar desktop.json
        let tries = 0;
        this._waitId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            this.api.get('/api/desktop').then(() => this._reload()).catch(() => {});
            if (++tries > 15 || GLib.file_test(DESK_FILE, GLib.FileTest.EXISTS)) {
                this._waitId = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _queueReload() {
        if (this._reloadId)
            GLib.source_remove(this._reloadId);
        this._reloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._reloadId = 0;
            this._reload();
            return GLib.SOURCE_REMOVE;
        });
    }

    _reload() {
        const cfg = readJSON(DESK_FILE);
        if (!cfg)
            return;
        const globalChanged = JSON.stringify([cfg.theme, cfg.opacity]) !== JSON.stringify([this.cfg.theme, this.cfg.opacity]);
        this.cfg = cfg;
        const ids = new Set();
        const enabled = cfg.enabled !== false;
        for (const wc of cfg.widgets ?? []) {
            if (!TYPES[wc.type])
                continue;
            wc.opts ??= {};
            wc.scale ??= 1;
            if (!TYPES[wc.type].sizes.includes(wc.size))
                wc.size = TYPES[wc.type].sizes[0];
            ids.add(wc.id);
            let w = this.widgets.get(wc.id);
            if (w) {
                if (w._dragging)
                    continue;
                w.update(wc, globalChanged);
            } else {
                w = new DeskWidget(this, wc);
                global.window_group.add_child(w.actor);
                this.widgets.set(wc.id, w);
            }
            w.actor.visible = enabled;
        }
        for (const [id, w] of this.widgets) {
            if (!ids.has(id)) {
                w.destroy();
                this.widgets.delete(id);
            }
        }
        this._autoPlace();
        this._restack();
    }

    save(op, tries = 0) {
        // logo após o login o backend pode ainda não estar no ar: tenta de novo
        this.api.post('/api/desktop', op).catch(e => {
            if (tries < 8)
                GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
                    this.save(op, tries + 1);
                    return GLib.SOURCE_REMOVE;
                });
            else
                log('save', e);
        });
    }

    // posiciona widgets novos (x == null) em espaços livres do monitor principal
    _autoPlace() {
        const pending = [...this.widgets.values()].filter(w => w.cfg.x == null);
        if (!pending.length)
            return;
        const wa = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        const placed = [...this.widgets.values()].filter(w => w.cfg.x != null).map(w => this.rect(w));
        const positions = {};
        const step = Math.round((CELL + GAP) / 2);
        for (const w of pending) {
            const [ww, hh] = dims(w.cfg.size, w.scale);
            let found = null;
            for (let x = wa.x + 30; x + ww <= wa.x + wa.width - 20 && !found; x += step) {
                for (let y = wa.y + 30; y + hh <= wa.y + wa.height - 20; y += step) {
                    const r = {x, y, w: ww, h: hh};
                    if (!placed.some(o => overlap(r, o, GAP))) {
                        found = r;
                        break;
                    }
                }
            }
            found ??= {x: wa.x + 30, y: wa.y + 30, w: ww, h: hh};
            placed.push(found);
            w.cfg.x = found.x;
            w.cfg.y = found.y;
            w.actor.set_position(found.x, found.y);
            positions[w.cfg.id] = [found.x, found.y];
        }
        this.save({op: 'move', positions});
    }

    rect(w) {
        return {x: w.actor.x, y: w.actor.y, w: w.actor.width, h: w.actor.height};
    }

    // ímã: alinha às bordas de outros widgets quando estiver perto
    magnet(self, x, y) {
        const R = 12;
        const W = self.actor.width, H = self.actor.height;
        let bx = null, by = null;
        for (const o of this.widgets.values()) {
            if (o === self || !o.actor.visible)
                continue;
            const r = this.rect(o);
            for (const c of [r.x, r.x + r.w + GAP, r.x + r.w - W, r.x - GAP - W])
                if (Math.abs(c - x) < R && (bx === null || Math.abs(c - x) < Math.abs(bx - x)))
                    bx = c;
            for (const c of [r.y, r.y + r.h + GAP, r.y + r.h - H, r.y - GAP - H])
                if (Math.abs(c - y) < R && (by === null || Math.abs(c - y) < Math.abs(by - y)))
                    by = c;
        }
        return [bx ?? x, by ?? y];
    }

    workAreaAt(px, py) {
        const lm = Main.layoutManager;
        const i = lm.monitors.findIndex(m => px >= m.x && px < m.x + m.width && py >= m.y && py < m.y + m.height);
        return lm.getWorkAreaForMonitor(i >= 0 ? i : lm.primaryIndex);
    }

    ensureOnScreen(w) {
        const a = w.actor;
        const cx = a.x + a.width / 2, cy = a.y + a.height / 2;
        const lm = Main.layoutManager;
        let i = lm.monitors.findIndex(m => cx >= m.x && cx < m.x + m.width && cy >= m.y && cy < m.y + m.height);
        if (i < 0)
            i = lm.primaryIndex;
        const wa = lm.getWorkAreaForMonitor(i);
        const x = Math.max(wa.x, Math.min(a.x, wa.x + wa.width - a.width));
        const y = Math.max(wa.y, Math.min(a.y, wa.y + wa.height - a.height));
        if (x !== a.x || y !== a.y) {
            a.set_position(x, y);
            w.cfg.x = Math.round(x);
            w.cfg.y = Math.round(y);
            this.save({op: 'set', id: w.cfg.id, patch: {x: w.cfg.x, y: w.cfg.y}});
        }
    }

    // mantém widgets logo acima do papel de parede/ícones (DING) e abaixo das janelas normais
    _queueRestack() {
        if (this._restackId)
            return;
        this._restackId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._restackId = 0;
            this._restack();
            return GLib.SOURCE_REMOVE;
        });
    }

    _restack() {
        const group = global.window_group;
        let ref = Main.layoutManager._backgroundGroup;
        // percorre os filhos reais: a extensão de ícones (DING) esconde suas janelas de get_window_actors()
        for (const a of group.get_children()) {
            const mw = a.meta_window;
            if (mw && (mw.get_window_type() === Meta.WindowType.DESKTOP || mw.get_layer() < Meta.StackLayer.NORMAL))
                ref = a;
        }
        if (ref?.get_parent() !== group)
            ref = null;
        for (const w of this.widgets.values()) {
            if (ref)
                group.set_child_above_sibling(w.actor, ref);
            else
                group.set_child_below_sibling(w.actor, null);
            ref = w.actor;
        }
        const r = this._raised; // widget sendo arrastado fica por cima dos outros widgets
        if (r?.alive && r.actor.get_parent() === group && r.actor !== ref)
            group.set_child_above_sibling(r.actor, ref);
    }

    raise(w) {
        this._raised = w;
        this._restack();
    }

    openMenu(w, x, y) {
        const menu = this._menu;
        menu.removeAll();
        const title = new PopupMenu.PopupMenuItem(TYPES[w.cfg.type].name, {reactive: false});
        title.label.style = 'font-weight: bold;';
        menu.addMenuItem(title);
        for (const s of TYPES[w.cfg.type].sizes) {
            const it = menu.addAction(SIZE_NAMES[s], () => w.setSize(s));
            it.setOrnament(s === w.cfg.size ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        }
        if (w.scale !== 1) {
            menu.addAction(`Escala original (está em ${Math.round(w.scale * 100)}%)`, () => {
                w.cfg.scale = 1;
                w.update(w.cfg);
                this.ensureOnScreen(w);
                this.save({op: 'set', id: w.cfg.id, patch: {scale: 1}});
            });
        }
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction('Configurar widget…', () => w.openSettings());
        menu.addAction('Adicionar widgets…', () => this.api.post('/api/settings', {}).catch(() => {}));
        const lock = new PopupMenu.PopupSwitchMenuItem('Travar posições', !!this.cfg.locked);
        lock.connect('toggled', (_i, state) => this.save({op: 'global', patch: {locked: state}}));
        menu.addMenuItem(lock);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const rm = menu.addAction('Remover widget', () => this.save({op: 'remove', id: w.cfg.id}));
        rm.label.style = 'color: #ff6b61;';
        Main.layoutManager.setDummyCursorGeometry(x, y, 0, 0);
        menu.open(true);
    }

    destroy() {
        this._dev?.destroy();
        for (const [o, id] of this._signals)
            o.disconnect(id);
        [this._reloadId, this._restackId, this._waitId].forEach(id => id && GLib.source_remove(id));
        this._monitor.cancel();
        this._menu.destroy();
        this.widgets.forEach(w => w.destroy());
        this.widgets.clear();
        this.api.destroy();
        St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this._css);
    }
}

function overlap(a, b, gap = 0) {
    return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}
