import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

const DOUBLE_CLICK_DELAY_MS = 300;
const UNDO_TIMEOUT_MS = 8000;

export const QuickNotesIndicator = GObject.registerClass(
class QuickNotesIndicator extends PanelMenu.Button {
    _init(extension, store, editor, settings) {
        super._init(0.0, 'Quick Notes', false);

        this._extension = extension;
        this._store = store;
        this._editor = editor;
        this._settings = settings;

        /*
         * GNOME 50's PanelMenu.Button has its own ClickGesture.
         * Remove it so this extension can distinguish:
         *   left click        -> notes popup
         *   double left click -> new note
         *   right click       -> panel context menu
         *
         * ClickAction is intentionally not used; it was removed in
         * GNOME 49.
         */
        if (this._clickGesture) {
            this.remove_action(this._clickGesture);
            this._clickGesture = null;
        }

        this._panelButtonPressId = this.connect(
            'button-press-event',
            (_actor, event) => this._onPanelButtonPress(event)
        );

        this._box = new St.BoxLayout({
            style_class: 'quick-notes-panel-box',
        });

        this._icon = new St.Icon({
            icon_name: 'document-edit-symbolic',
            style_class: 'system-status-icon quick-notes-icon',
        });

        this._countLabel = new St.Label({
            text: '',
            style_class: 'quick-notes-count-label',
        });

        this._countLabel.hide();

        this._box.add_child(this._icon);
        this._box.add_child(this._countLabel);
        this.add_child(this._box);

        this.menu.actor.add_style_class_name('quick-notes-menu');

        this._notesSection = null;

        this._contextMenu = null;
        this._openNoteSubmenu = null;

        this._menuManager = new PopupMenu.PopupMenuManager(this);

        this._aboutDialog = null;

        this._notesChangedId = 0;
        this._showCountChangedId = 0;

        this._refreshPending = false;
        this._refreshTimeoutId = 0;

        this._panelClickTimeoutId = 0;

        this._noteClickTimeoutId = 0;
        this._noteClickNoteId = null;

        this._undoTimeoutId = 0;
        this._undoVisible = false;

        this._buildMenu();
        this._buildContextMenu();

        if (this._store) {
            this._notesChangedId = this._store.connect(
                'notes-changed',
                () => {
                    this._updateCountLabel();
                    this._scheduleRefresh();
                }
            );
        }

        if (this._settings) {
            this._showCountChangedId = this._settings.connect(
                'changed::show-note-count',
                () => this._updateCountLabel()
            );
        }

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open && this._contextMenu)
                this._contextMenu.close();
        });

        if (this._contextMenu) {
            this._contextMenu.connect(
                'open-state-changed',
                (_menu, open) => {
                    if (open && this.menu)
                        this.menu.close();
                }
            );
        }

        this._updateCountLabel();
        this._rebuildNotesSection();
    }

    _onPanelButtonPress(event) {
        const button = event.get_button();

        if (button === Clutter.BUTTON_SECONDARY) {
            this._cancelPanelClick();
            this._toggleContextMenu();
            return Clutter.EVENT_STOP;
        }

        if (button !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        if (
            this.menu.isOpen ||
            (this._contextMenu && this._contextMenu.isOpen)
        ) {
            this._closeMenus();
            return Clutter.EVENT_STOP;
        }

        if (this._panelClickTimeoutId > 0) {
            GLib.source_remove(this._panelClickTimeoutId);
            this._panelClickTimeoutId = 0;

            this._openEditorForNewNote();
            return Clutter.EVENT_STOP;
        }

        this._panelClickTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            DOUBLE_CLICK_DELAY_MS,
            () => {
                this._panelClickTimeoutId = 0;
                this._openNotesMenu();
                return GLib.SOURCE_REMOVE;
            }
        );

        return Clutter.EVENT_STOP;
    }

    _buildMenu() {
        this.menu.removeAll();

        const header = new PopupMenu.PopupMenuItem('Quick Notes');
        header.setSensitive(false);
        header.actor.add_style_class_name('quick-notes-header');
        this.menu.addMenuItem(header);

        const newNoteItem = new PopupMenu.PopupMenuItem('+ New note');
        newNoteItem.connect('activate', () => {
            this._openEditorForNewNote();
        });
        this.menu.addMenuItem(newNoteItem);

        this.menu.addMenuItem(
            new PopupMenu.PopupSeparatorMenuItem()
        );

        this._notesSection = new PopupMenu.PopupMenuSection();
        this._notesSection.actor.add_style_class_name(
            'quick-notes-note-list'
        );
        this.menu.addMenuItem(this._notesSection);

        this.menu.addMenuItem(
            new PopupMenu.PopupSeparatorMenuItem()
        );

        const preferencesItem =
            new PopupMenu.PopupMenuItem('Preferences');

        preferencesItem.connect('activate', () => {
            this._openPreferences();
        });

        this.menu.addMenuItem(preferencesItem);
    }

    _buildContextMenu() {
        this._contextMenu = new PopupMenu.PopupMenu(
            this,
            0.0,
            St.Side.TOP
        );

        this._contextMenu.actor.add_style_class_name(
            'quick-notes-context-menu'
        );

        Main.uiGroup.add_child(this._contextMenu.actor);
        this._contextMenu.actor.hide();
        this._menuManager.addMenu(this._contextMenu);

        const newNoteItem =
            new PopupMenu.PopupMenuItem('New Note');

        newNoteItem.connect('activate', () => {
            this._openEditorForNewNote();
        });

        this._contextMenu.addMenuItem(newNoteItem);

        const preferencesItem =
            new PopupMenu.PopupMenuItem('Preferences');

        preferencesItem.connect('activate', () => {
            this._openPreferences();
        });

        this._contextMenu.addMenuItem(preferencesItem);

        const aboutItem =
            new PopupMenu.PopupMenuItem('About Quick Notes');

        aboutItem.connect('activate', () => {
            this._showAbout();
        });

        this._contextMenu.addMenuItem(aboutItem);
    }

    _rebuildNotesSection() {
        if (!this._notesSection)
            return;

        this._closeOpenNoteSubmenu();
        this._notesSection.removeAll();

        if (
            this._undoVisible &&
            this._store &&
            this._store.canUndoDelete
        ) {
            const undoItem =
                new PopupMenu.PopupMenuItem(
                    'Note deleted — Undo'
                );

            undoItem.actor.add_style_class_name(
                'quick-notes-undo-row'
            );

            undoItem.connect('activate', () => {
                this._undoDelete();
            });

            this._notesSection.addMenuItem(undoItem);
        }

        if (!this._store || this._store.count === 0) {
            const emptyItem =
                new PopupMenu.PopupMenuItem('No notes yet');

            emptyItem.setSensitive(false);

            emptyItem.actor.add_style_class_name(
                'quick-notes-empty'
            );

            this._notesSection.addMenuItem(emptyItem);
            return;
        }

        const notes = this._store.getSortedNotes();

        for (const note of notes) {
            this._notesSection.addMenuItem(
                this._createNoteRow(note)
            );
        }
    }

    _createNoteRow(note) {
        /*
         * This is a native GNOME Shell submenu. The submenu belongs to the
         * note row and therefore remains inside the main Quick Notes menu's
         * actor hierarchy. That lets the parent menu stay open while the
         * Edit/Delete submenu is interactive.
         */
        const item = new PopupMenu.PopupSubMenuMenuItem(
            '',
            false
        );

        item.add_style_class_name('quick-notes-note-row');

        // We do not want PopupSubMenuMenuItem's normal left-click behavior.
        // The note itself uses our single/double-click logic instead.
        if (item._clickGesture)
            item._clickGesture.enabled = false;

        item.activate = () => {};

        if (item.label)
            item.label.hide();

        if (item._triangle)
            item._triangle.hide();

        const noteButton = new St.Button({
            label: this._noteSummary(note),
            style_class: 'quick-notes-note-button',
            reactive: true,
            can_focus: true,
            x_expand: true,
        });

        noteButton.set_button_mask(
            St.ButtonMask.ONE | St.ButtonMask.THREE
        );

        noteButton.connect(
            'clicked',
            (_buttonActor, clickedButton) => {
                this._onNoteClicked(
                    note.id,
                    item,
                    clickedButton
                );
            }
        );

        item.add_child(noteButton);

        // Style the real nested submenu as our small Edit/Delete popup.
        if (item.menu && item.menu.actor) {
            item.menu.actor.add_style_class_name(
                'quick-notes-note-context-menu'
            );
        }

        const editItem = new PopupMenu.PopupMenuItem('Edit');
        editItem.connect('activate', () => {
            GLib.idle_add_once(
                GLib.PRIORITY_DEFAULT_IDLE,
                () => {
                    this._openEditorForNote(note.id);
                }
            );
        });
        item.menu.addMenuItem(editItem);

        const deleteItem = new PopupMenu.PopupMenuItem('Delete');
        deleteItem.connect('activate', () => {
            GLib.idle_add_once(
                GLib.PRIORITY_DEFAULT_IDLE,
                () => {
                    this._deleteNote(note.id);
                }
            );
        });
        item.menu.addMenuItem(deleteItem);

        return item;
    }

    _onNoteClicked(noteId, item, clickedButton) {
        if (clickedButton === Clutter.BUTTON_SECONDARY) {
            this._cancelNoteClick();
            this._openNoteSubmenuForItem(item);
            return;
        }

        if (clickedButton !== Clutter.BUTTON_PRIMARY)
            return;

        if (
            this._noteClickTimeoutId > 0 &&
            this._noteClickNoteId === noteId
        ) {
            GLib.source_remove(this._noteClickTimeoutId);
            this._noteClickTimeoutId = 0;
            this._noteClickNoteId = null;

            this._openEditorForNote(noteId);
            return;
        }

        this._cancelNoteClick();
        this._noteClickNoteId = noteId;

        this._noteClickTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            DOUBLE_CLICK_DELAY_MS,
            () => {
                this._noteClickTimeoutId = 0;
                this._noteClickNoteId = null;
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _openNoteSubmenuForItem(item) {
        if (!item || !item.menu)
            return;

        this._closeOpenNoteSubmenu();
        this._openNoteSubmenu = item.menu;

        GLib.idle_add_once(
            GLib.PRIORITY_DEFAULT_IDLE,
            () => {
                if (
                    this._openNoteSubmenu === item.menu &&
                    this.menu &&
                    this.menu.isOpen
                ) {
                    item.menu.open();
                }
            }
        );
    }

    _closeOpenNoteSubmenu() {
        if (!this._openNoteSubmenu)
            return;

        this._openNoteSubmenu.close();
        this._openNoteSubmenu = null;
    }

    _noteSummary(note) {
        if (!note)
            return 'Empty note';

        const text = note.text || '';

        if (!text.trim())
            return 'Empty note';

        for (const line of text.split('\n')) {
            const trimmed = line.trim();

            if (trimmed) {
                const maxLength = 60;

                if (trimmed.length <= maxLength)
                    return trimmed;

                return `${trimmed.slice(0, maxLength - 1)}…`;
            }
        }

        return 'Empty note';
    }

    _openNotesMenu() {
        this._closeOpenNoteSubmenu();

        if (this._contextMenu)
            this._contextMenu.close();

        this.menu.open();
    }

    _openEditorForNewNote() {
        this._closeMenus();

        GLib.idle_add_once(
            GLib.PRIORITY_DEFAULT_IDLE,
            () => {
                if (this._editor)
                    this._editor.openNewNote();
            }
        );
    }

    _openEditorForNote(id) {
        this._closeMenus();

        GLib.idle_add_once(
            GLib.PRIORITY_DEFAULT_IDLE,
            () => {
                if (this._editor)
                    this._editor.openNote(id);
            }
        );
    }

    _openPreferences() {
        this._closeMenus();

        if (
            this._extension &&
            typeof this._extension.openPreferences === 'function'
        ) {
            this._extension.openPreferences();
        } else {
            log('Quick Notes: preferences could not be opened');
        }
    }

    _showAbout() {
        this._closeMenus();

        if (this._aboutDialog)
            return;

        const dialog = new ModalDialog.ModalDialog({
            styleClass: 'quick-notes-about',
        });

        const title = new St.Label({
            text: 'Quick Notes',
            style_class: 'quick-notes-about-title',
        });

        const body = new St.Label({
            text:
                'Version 1\nLocal plain-text notes for GNOME Shell.',
            style_class: 'quick-notes-about-body',
        });

        dialog.contentLayout.add_child(title);
        dialog.contentLayout.add_child(body);

        dialog.setButtons([
            {
                label: 'Close',
                action: () => {
                    dialog.close(global.get_current_time());
                },
            },
        ]);

        dialog.connect('closed', () => {
            if (this._aboutDialog === dialog)
                this._aboutDialog = null;

            dialog.destroy();
        });

        this._aboutDialog = dialog;
        dialog.open(global.get_current_time());
    }

    _deleteNote(id) {
        if (!this._store)
            return;

        if (!this._store.deleteNote(id))
            return;

        this._undoVisible = true;
        this._startUndoTimeout();
        this._scheduleRefresh();

        GLib.idle_add_once(
            GLib.PRIORITY_DEFAULT_IDLE,
            () => {
                if (this.menu)
                    this.menu.open();
            }
        );
    }

    _undoDelete() {
        if (!this._store)
            return;

        this._store.undoDelete();
        this._undoVisible = false;

        if (this._undoTimeoutId > 0) {
            GLib.source_remove(this._undoTimeoutId);
            this._undoTimeoutId = 0;
        }

        this._scheduleRefresh();
    }

    _startUndoTimeout() {
        if (this._undoTimeoutId > 0)
            GLib.source_remove(this._undoTimeoutId);

        this._undoTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            UNDO_TIMEOUT_MS,
            () => {
                this._undoTimeoutId = 0;
                this._undoVisible = false;
                this._scheduleRefresh();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _scheduleRefresh() {
        if (this._refreshPending)
            return;

        this._refreshPending = true;

        this._refreshTimeoutId = GLib.idle_add_once(
            GLib.PRIORITY_DEFAULT_IDLE,
            () => {
                this._refreshTimeoutId = 0;
                this._refreshPending = false;
                this._rebuildNotesSection();
            }
        );
    }

    _updateCountLabel() {
        if (!this._countLabel)
            return;

        let show = false;

        if (this._settings && this._store) {
            try {
                show =
                    this._settings.get_boolean(
                        'show-note-count'
                    ) &&
                    this._store.count > 0;
            } catch (error) {
                show = false;
            }
        }

        if (show) {
            this._countLabel.set_text(
                String(this._store.count)
            );
            this._countLabel.show();
        } else {
            this._countLabel.set_text('');
            this._countLabel.hide();
        }
    }

    _toggleContextMenu() {
        if (!this._contextMenu)
            return;

        if (this._contextMenu.isOpen) {
            this._contextMenu.close();
            return;
        }

        this.menu.close();
        this._closeOpenNoteSubmenu();
        this._contextMenu.open();
    }

    _closeMenus() {
        this._cancelPanelClick();

        if (this.menu)
            this.menu.close();

        if (this._contextMenu)
            this._contextMenu.close();

        this._closeOpenNoteSubmenu();
    }

    _cancelPanelClick() {
        if (this._panelClickTimeoutId > 0) {
            GLib.source_remove(this._panelClickTimeoutId);
            this._panelClickTimeoutId = 0;
        }
    }

    _cancelNoteClick() {
        if (this._noteClickTimeoutId > 0) {
            GLib.source_remove(this._noteClickTimeoutId);
            this._noteClickTimeoutId = 0;
        }

        this._noteClickNoteId = null;
    }

    destroy() {
        this._cancelPanelClick();
        this._cancelNoteClick();

        if (this._refreshTimeoutId > 0) {
            GLib.source_remove(this._refreshTimeoutId);
            this._refreshTimeoutId = 0;
        }

        if (this._undoTimeoutId > 0) {
            GLib.source_remove(this._undoTimeoutId);
            this._undoTimeoutId = 0;
        }

        if (this._store && this._notesChangedId > 0) {
            this._store.disconnect(this._notesChangedId);
            this._notesChangedId = 0;
        }

        if (this._settings && this._showCountChangedId > 0) {
            this._settings.disconnect(this._showCountChangedId);
            this._showCountChangedId = 0;
        }

        this._closeMenus();

        if (this._panelButtonPressId > 0) {
            this.disconnect(this._panelButtonPressId);
            this._panelButtonPressId = 0;
        }

        if (this._contextMenu) {
            this._contextMenu.destroy();
            this._contextMenu = null;
        }

        this._openNoteSubmenu = null;
        this._menuManager = null;

        if (this._aboutDialog) {
            this._aboutDialog.destroy();
            this._aboutDialog = null;
        }

        this._notesSection = null;
        this._store = null;
        this._editor = null;
        this._extension = null;
        this._settings = null;
        this._icon = null;
        this._countLabel = null;
        this._box = null;

        super.destroy();
    }
});
