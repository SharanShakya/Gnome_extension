import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class QuickNotesPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'dialog-information-symbolic',
        });

        window.add(page);

        const appearanceGroup = new Adw.PreferencesGroup({
            title: 'Appearance',
        });

        page.add(appearanceGroup);

        const countRow = new Adw.SwitchRow({
            title: 'Show note count',
            subtitle: 'Show the number of notes beside the panel icon',
        });

        settings.bind(
            'show-note-count',
            countRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        appearanceGroup.add(countRow);

        const notesGroup = new Adw.PreferencesGroup({
            title: 'Notes',
        });

        page.add(notesGroup);

        const sortModel = new Gtk.StringList();

        sortModel.append('Recently modified');
        sortModel.append('Created date');
        sortModel.append('Alphabetical');

        const sortRow = new Adw.ComboRow({
            title: 'Sort notes by',
            model: sortModel,
        });

        const settingToIndex = {
            'modified': 0,
            'created': 1,
            'alpha': 2,
        };

        const indexToSetting = [
            'modified',
            'created',
            'alpha',
        ];

        const current = settings.get_string('sort-order');

        sortRow.selected = settingToIndex[current] ?? 0;

        sortRow.connect('notify::selected', () => {
            const value = indexToSetting[sortRow.selected] ?? 'modified';

            settings.set_string('sort-order', value);
        });

        notesGroup.add(sortRow);
    }
}
