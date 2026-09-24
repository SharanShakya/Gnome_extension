import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const SortMode = {
    MODIFIED: 'modified',
    CREATED: 'created',
    ALPHA: 'alpha',
};

export const NoteStore = GObject.registerClass({
    Signals: {
        'notes-changed': {},
    },
}, class NoteStore extends GObject.Object {
    _init() {
        super._init();

        this._notes = [];
        this._sortMode = SortMode.MODIFIED;
        this._lastDeleted = null;

        this._saveTimeoutId = 0;

        this._directory = GLib.build_filenamev([
            GLib.get_user_data_dir(),
            'quick-notes',
        ]);

        this._path = GLib.build_filenamev([
            this._directory,
            'notes.json',
        ]);

        this._backupPath = `${this._path}~`;

        this._load();
    }

    get count() {
        return this._notes.length;
    }

    get sortMode() {
        return this._sortMode;
    }

    get canUndoDelete() {
        return this._lastDeleted !== null;
    }

    setSortMode(mode) {
        const valid = Object.values(SortMode).includes(mode);

        if (!valid)
            return;

        if (this._sortMode === mode)
            return;

        this._sortMode = mode;
        this.emit('notes-changed');
    }

    createNote(text) {
        const now = new Date().toISOString();

        const note = {
            id: this._generateId(),
            text: this._normalizeText(text),
            createdAt: now,
            modifiedAt: now,
        };

        this._notes.push(note);
        this._lastDeleted = null;

        this.emit('notes-changed');
        this._scheduleSave();

        return note;
    }

    updateNoteText(id, text) {
        const note = this._getNoteById(id);

        if (!note)
            return null;

        const newText = this._normalizeText(text);

        if (newText === note.text)
            return note;

        note.text = newText;
        note.modifiedAt = new Date().toISOString();

        this.emit('notes-changed');
        this._scheduleSave();

        return note;
    }

    deleteNote(id) {
        const index = this._notes.findIndex(note => note.id === id);

        if (index === -1)
            return false;

        const deleted = this._notes.splice(index, 1)[0];

        this._lastDeleted = {
            note: deleted,
            index: index,
        };

        this.emit('notes-changed');
        this._scheduleSave();

        return true;
    }

    undoDelete() {
        if (!this._lastDeleted)
            return null;

        const {note, index} = this._lastDeleted;

        const insertAt = Math.min(
            Math.max(index, 0),
            this._notes.length
        );

        this._notes.splice(insertAt, 0, note);

        this._lastDeleted = null;

        this.emit('notes-changed');
        this._scheduleSave();

        return note;
    }

    getNoteById(id) {
        return this._getNoteById(id);
    }

    getSortedNotes() {
        const notes = [...this._notes];

        if (this._sortMode === SortMode.MODIFIED) {
            notes.sort((a, b) => {
                const modifiedDiff =
                    this._timestampMs(b.modifiedAt) -
                    this._timestampMs(a.modifiedAt);

                if (modifiedDiff !== 0)
                    return modifiedDiff;

                return (
                    this._timestampMs(b.createdAt) -
                    this._timestampMs(a.createdAt)
                );
            });
        } else if (this._sortMode === SortMode.CREATED) {
            notes.sort((a, b) => {
                const createdDiff =
                    this._timestampMs(b.createdAt) -
                    this._timestampMs(a.createdAt);

                if (createdDiff !== 0)
                    return createdDiff;

                return (
                    this._timestampMs(b.modifiedAt) -
                    this._timestampMs(a.modifiedAt)
                );
            });
        } else if (this._sortMode === SortMode.ALPHA) {
            notes.sort((a, b) => {
                const aLine = this._firstLine(a.text);
                const bLine = this._firstLine(b.text);

                if (!aLine && bLine)
                    return 1;

                if (aLine && !bLine)
                    return -1;

                const aLower = aLine.toLowerCase();
                const bLower = bLine.toLowerCase();

                if (aLower < bLower)
                    return -1;

                if (aLower > bLower)
                    return 1;

                return 0;
            });
        }

        return notes;
    }

    getLatestNote() {
        const sorted = this.getSortedNotes();

        if (sorted.length === 0)
            return null;

        return sorted[0];
    }

    clear() {
        this._notes = [];
        this._lastDeleted = null;

        this.emit('notes-changed');
        this._scheduleSave();
    }

    flushSave() {
        if (this._saveTimeoutId > 0) {
            GLib.source_remove(this._saveTimeoutId);
            this._saveTimeoutId = 0;
        }

        this._writeNow();
    }

    destroy() {
        this.flushSave();
    }

    _scheduleSave() {
        if (this._saveTimeoutId > 0)
            GLib.source_remove(this._saveTimeoutId);

        this._saveTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            600,
            () => {
                this._saveTimeoutId = 0;
                this._writeNow();

                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _writeNow() {
        try {
            GLib.mkdir_with_parents(this._directory, 0o700);

            const data = {
                version: 1,
                notes: this._notes,
            };

            const json = JSON.stringify(data, null, 2);
            const temporaryPath = `${this._path}.tmp`;

            GLib.file_set_contents(temporaryPath, json);

            const mainFile = Gio.File.new_for_path(this._path);
            const backupFile = Gio.File.new_for_path(this._backupPath);
            const temporaryFile = Gio.File.new_for_path(temporaryPath);

            if (mainFile.query_exists(null)) {
                mainFile.copy(
                    backupFile,
                    Gio.FileCopyFlags.OVERWRITE,
                    null,
                    null
                );
            }

            temporaryFile.move(
                mainFile,
                Gio.FileCopyFlags.OVERWRITE,
                null,
                null
            );
        } catch (error) {
            logError(error, 'Quick Notes: failed to save notes');
        }
    }

    _load() {
        this._notes = this._readFile(this._path);

        if (this._notes === null)
            this._notes = this._readFile(this._backupPath);

        if (this._notes === null)
            this._notes = [];
    }

    _readFile(path) {
        const file = Gio.File.new_for_path(path);

        if (!file.query_exists(null))
            return null;

        try {
            const [ok, contents] = file.load_contents(null);

            if (!ok)
                return null;

            let text;

            if (typeof contents === 'string') {
                text = contents;
            } else {
                text = new TextDecoder().decode(contents);
            }

            const parsed = JSON.parse(text);

            return this._parseData(parsed);
        } catch (error) {
            if (path === this._path) {
                logError(error, 'Quick Notes: notes.json is corrupt');
                this._preserveCorruptFile(file);
            }

            return null;
        }
    }

    _parseData(parsed) {
        if (Array.isArray(parsed)) {
            parsed = {
                version: 1,
                notes: parsed,
            };
        }

        if (!parsed || !Array.isArray(parsed.notes))
            throw new Error('Invalid Quick Notes data file');

        const notes = [];

        for (const rawNote of parsed.notes) {
            const note = this._sanitizeNote(rawNote);

            if (note)
                notes.push(note);
        }

        return notes;
    }

    _sanitizeNote(raw) {
        if (!raw || typeof raw !== 'object')
            return null;

        const now = new Date().toISOString();

        const id = typeof raw.id === 'string' && raw.id
            ? raw.id
            : this._generateId();

        const text = typeof raw.text === 'string'
            ? raw.text
            : '';

        const createdAt = typeof raw.createdAt === 'string'
            ? raw.createdAt
            : now;

        const modifiedAt = typeof raw.modifiedAt === 'string'
            ? raw.modifiedAt
            : createdAt;

        return {
            id,
            text,
            createdAt,
            modifiedAt,
        };
    }

    _preserveCorruptFile(file) {
        try {
            const timestamp = new Date()
                .toISOString()
                .replace(/[^0-9T]/g, '-')
                .toLowerCase();

            const corruptPath = `${this._path}.corrupt-${timestamp}`;

            file.move(
                Gio.File.new_for_path(corruptPath),
                Gio.FileCopyFlags.OVERWRITE,
                null,
                null
            );
        } catch (error) {
            logError(error, 'Quick Notes: failed to preserve corrupt notes file');
        }
    }

    _getNoteById(id) {
        const found = this._notes.find(note => note.id === id);

        if (!found)
            return null;

        return found;
    }

    _generateId() {
        const timePart = Date.now().toString(36);
        const randomPart = Math.random().toString(36).slice(2, 10);

        return `note-${timePart}-${randomPart}`;
    }

    _normalizeText(text) {
        if (text === null || text === undefined)
            return '';

        return String(text);
    }

    _timestampMs(isoString) {
        const parsed = Date.parse(isoString);

        if (Number.isNaN(parsed))
            return 0;

        return parsed;
    }

    _firstLine(text) {
        const normalized = this._normalizeText(text);

        if (!normalized)
            return '';

        const lines = normalized.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();

            if (trimmed)
                return trimmed;
        }

        return '';
    }
});
