import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {NoteStore} from './noteStore.js';
import {NoteEditor} from './editor.js';
import {QuickNotesIndicator} from './indicator.js';

export default class QuickNotesExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        this._noteStore = new NoteStore();
        this._editor = new NoteEditor(this._noteStore);

        this._indicator = new QuickNotesIndicator(
            this,
            this._noteStore,
            this._editor,
            this._settings
        );

        Main.panel.addToStatusArea(
            this.uuid,
            this._indicator,
            1,
            'right'
        );
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        if (this._editor) {
            this._editor.destroy();
            this._editor = null;
        }

        if (this._noteStore) {
            this._noteStore.flushSave();
            this._noteStore = null;
        }

        this._settings = null;
    }
}

