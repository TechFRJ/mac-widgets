// Carregador: importa desk.js e o recarrega ao vivo quando o arquivo muda.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class MacWidgetsExtension extends Extension {
    enable() {
        this._gen = 0;
        this._load();
        const file = Gio.File.new_for_path(`${this.path}/desk.js`);
        this._monitor = file.monitor_file(Gio.FileMonitorFlags.WATCH_MOVES, null);
        this._monitor.connect('changed', () => {
            if (this._reloadId)
                GLib.source_remove(this._reloadId);
            this._reloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                this._reloadId = 0;
                this._load();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    async _load() {
        const gen = ++this._gen;
        try {
            const mod = await import(`file://${this.path}/desk.js?v=${Date.now()}`);
            if (gen !== this._gen)
                return;
            this._desk?.destroy();
            this._desk = new mod.Desk(this);
        } catch (e) {
            console.error(`[mac-widgets] falha ao carregar desk.js: ${e}\n${e.stack}`);
        }
    }

    disable() {
        this._gen++;
        if (this._reloadId)
            GLib.source_remove(this._reloadId);
        this._reloadId = 0;
        this._monitor?.cancel();
        this._monitor = null;
        this._desk?.destroy();
        this._desk = null;
    }
}
