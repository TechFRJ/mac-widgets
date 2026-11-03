// Ganchos de teste (só carregam se ~/.config/mac-widgets/dev existir).
// Comandos em ~/.config/mac-widgets/dev-cmd.json; resultado em dev-out.json.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

const CONF = `${GLib.get_user_config_dir()}/mac-widgets`;
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => r() ?? GLib.SOURCE_REMOVE));

export class Dev {
    constructor(desk) {
        this.desk = desk;
        const seat = Clutter.get_default_backend().get_default_seat();
        this.ptr = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        this.mon = Gio.File.new_for_path(`${CONF}/dev-cmd.json`).monitor_file(Gio.FileMonitorFlags.WATCH_MOVES, null);
        this.mon.connect('changed', (m, f, o, ev) => {
            if (ev === Gio.FileMonitorEvent.CHANGES_DONE_HINT || ev === Gio.FileMonitorEvent.RENAMED || ev === Gio.FileMonitorEvent.MOVED_IN)
                this.run();
        });
    }

    t() {
        return GLib.get_monotonic_time();
    }

    move(x, y) {
        this.ptr.notify_absolute_motion(this.t(), x, y);
    }

    button(b, down) {
        this.ptr.notify_button(this.t(), b, down ? Clutter.ButtonState.PRESSED : Clutter.ButtonState.RELEASED);
    }

    async run() {
        let cmds;
        try {
            const [, b] = GLib.file_get_contents(`${CONF}/dev-cmd.json`);
            cmds = JSON.parse(new TextDecoder().decode(b));
        } catch {
            return;
        }
        if (this.busy)
            return;
        this.busy = true;
        const out = [];
        try {
            for (const c of cmds) {
                if (c.cmd === 'move')
                    this.move(...c.at);
                else if (c.cmd === 'click') {
                    this.move(...c.at);
                    await sleep(60);
                    this.button(c.button ?? 1, true);
                    await sleep(60);
                    this.button(c.button ?? 1, false);
                } else if (c.cmd === 'drag') {
                    this.move(...c.from);
                    await sleep(80);
                    this.button(1, true);
                    const n = 12;
                    for (let i = 1; i <= n; i++) {
                        await sleep(25);
                        this.move(c.from[0] + (c.to[0] - c.from[0]) * i / n, c.from[1] + (c.to[1] - c.from[1]) * i / n);
                    }
                    await sleep(80);
                    this.button(1, false);
                } else if (c.cmd === 'wdrag') {
                    // arrasta um widget pelo meio (move) ou pelo canto (resize), calculando a posição na hora
                    const w = [...this.desk.widgets.values()].find(x => x.cfg.type === c.type);
                    const a = w.actor;
                    const before = {x: a.x, y: a.y, w: a.width, scale: w.scale};
                    const from = c.corner ? [a.x + a.width - 12, a.y + a.height - 12] : [a.x + a.width / 2, a.y + 20];
                    this.move(a.x + a.width / 2, a.y + a.height / 2);
                    await sleep(250);
                    this.move(...from);
                    await sleep(250);
                    this.button(1, true);
                    for (let i = 1; i <= 12; i++) {
                        await sleep(25);
                        this.move(from[0] + c.dx * i / 12, from[1] + (c.dy ?? 0) * i / 12);
                    }
                    await sleep(80);
                    this.button(1, false);
                    await sleep(400);
                    const w2 = [...this.desk.widgets.values()].find(x => x.cfg.id === w.cfg.id);
                    out.push({type: c.type, corner: !!c.corner, before, after: {x: w2.actor.x, y: w2.actor.y, w: w2.actor.width, scale: w2.scale}});
                } else if (c.cmd === 'pick') {
                    const res = [];
                    for (const w of this.desk.widgets.values()) {
                        const a = w.actor;
                        const x = a.x + a.width / 2, y = a.y + 20;
                        let hit = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
                        const chain = [];
                        for (let h = hit; h && chain.length < 6; h = h.get_parent())
                            chain.push(`${h.constructor.name}${h.meta_window ? `(${h.meta_window.get_title()})` : ''}${h === a ? '*' : ''}`);
                        res.push({type: w.cfg.type, at: [x, y], chain});
                    }
                    out.push(res);
                } else if (c.cmd === 'key') {
                    const kb = Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
                    kb.notify_keyval(this.t(), c.keyval, Clutter.KeyState.PRESSED);
                    kb.notify_keyval(this.t(), c.keyval, Clutter.KeyState.RELEASED);
                } else if (c.cmd === 'wait') {
                    await sleep(c.ms);
                } else if (c.cmd === 'dump') {
                    const ws = [...this.desk.widgets.values()].map(w => ({id: w.cfg.id, type: w.cfg.type, size: w.cfg.size, scale: w.scale,
                        x: w.actor.x, y: w.actor.y, w: w.actor.width, h: w.actor.height, visible: w.actor.visible,
                        index: global.window_group.get_children().indexOf(w.actor)}));
                    const wins = global.get_window_actors().map(a => ({title: a.meta_window?.get_title(), layer: a.meta_window?.get_layer(),
                        type: a.meta_window?.get_window_type(), index: global.window_group.get_children().indexOf(a)}));
                    const kids = global.window_group.get_children().map((a, i) => ({i, type: a.constructor.name, name: a.name,
                        title: a.meta_window?.get_title?.(), wmclass: a.meta_window?.get_wm_class?.(), layer: a.meta_window?.get_layer?.(),
                        wtype: a.meta_window?.get_window_type?.(), x: a.x, y: a.y, w: a.width, h: a.height, visible: a.visible, reactive: a.reactive}));
                    out.push({kids, widgets: ws, windows: wins, monitors: global.display.get_n_monitors(),
                        primary: Main_primary(), stage: [global.stage.width, global.stage.height]});
                } else if (c.cmd === 'shot') {
                    const file = Gio.File.new_for_path(c.path);
                    const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
                    const shooter = new Shell.Screenshot();
                    await new Promise((res, rej) => {
                        const cb = (o, r) => {
                            try {
                                o.screenshot_finish(r);
                                res();
                            } catch (e) {
                                rej(e);
                            }
                        };
                        if (c.area)
                            shooter.screenshot_area(...c.area, stream, cb);
                        else
                            shooter.screenshot(false, stream, cb);
                    });
                    stream.close(null);
                    out.push({shot: c.path});
                }
            }
        } catch (e) {
            out.push({error: `${e}`, stack: e.stack});
        }
        GLib.file_set_contents(`${CONF}/dev-out.json`, JSON.stringify(out, null, 1));
        this.busy = false;
    }

    destroy() {
        this.mon.cancel();
        this.ptr.run_dispose?.();
    }
}

function Main_primary() {
    return global.display.get_primary_monitor();
}
