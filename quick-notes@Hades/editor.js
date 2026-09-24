import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const EDITOR_WIDTH = 440;
const EDITOR_HEIGHT = 320;
const EDITOR_TOP_OFFSET = 90;

// The outer editor is 440px wide. Reserve room for the editor padding,
// borders and the non-overlay vertical scrollbar so the text never grows
// underneath it or beyond the right edge.
const EDITOR_TEXT_WIDTH = 404;
const EDITOR_TEXT_INNER_WIDTH = 382;

export class NoteEditor {
    constructor(store) {
        this._store = store;

        this._dialog = null;
        this._entry = null;
        this._scrollView = null;
        this._scrollContent = null;
        this._saveButton = null;
        this._closeButton = null;
        this._dragHandle = null;

        this._noteId = null;
        this._originalText = '';
        this._isNew = false;
        this._committed = false;

        this._focusTimeoutId = 0;
        this._entryResizeTimeoutId = 0;
        this._scrollToEndTimeoutId = 0;
        this._lastPosition = null;

        this._dragging = false;
        this._dragOffsetX = 0;
        this._dragOffsetY = 0;
        this._stageMotionId = 0;
        this._stageReleaseId = 0;
    }

    openNewNote() {
        this._open(null);
    }

    openNote(id) {
        this._open(id);
    }

    destroy() {
        this._commit();
        this._destroyDialog();
        this._store = null;
    }

    _open(id) {
        if (this._dialog || !this._store)
            return;

        let note = null;

        if (id) {
            note = this._store.getNoteById(id);
            if (!note)
                return;
        }

        this._noteId = note ? note.id : null;
        this._isNew = !note;
        this._originalText = note ? note.text : '';
        this._committed = false;

        // Fixed-size, non-modal editor.
        this._dialog = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'quick-notes-editor',
            reactive: true,
            can_focus: true,
        });
        this._dialog.set_size(EDITOR_WIDTH, EDITOR_HEIGHT);

        const header = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'quick-notes-editor-header',
        });

        this._dragHandle = new St.Widget({
            style_class: 'quick-notes-editor-drag-handle',
            reactive: true,
            can_focus: false,
            x_expand: true,
        });

        const title = new St.Label({
            text: note ? 'Edit Note' : 'New Quick Note',
            style_class: 'quick-notes-editor-title',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._dragHandle.add_child(title);

        this._closeButton = new St.Button({
            label: '×',
            style_class: 'quick-notes-editor-close',
            can_focus: true,
            reactive: true,
        });

        this._closeButton.connect('clicked', () => {
            this._finishEditing();
        });

        header.add_child(this._dragHandle);
        header.add_child(this._closeButton);
        this._dialog.add_child(header);

        this._configureDragHandle();

        this._entry = new St.Entry({
            text: this._originalText,
            hint_text: 'Type something...',
            can_focus: true,
            reactive: true,
            x_expand: false,
            y_expand: false,
            style_class: 'quick-notes-editor-text',
        });

        this._configureEntry();

        // StBoxLayout implements StScrollable in GNOME Shell.
        // Make it the direct child of ScrollView so its height can grow with
        // the text and the ScrollView can provide the vertical adjustment.
        this._scrollContent = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'quick-notes-editor-scroll-content',
            x_expand: true,
            y_expand: false,
        });

        this._scrollContent.add_child(this._entry);

        this._scrollView = new St.ScrollView({
            x_expand: true,
            y_expand: true,
        });

        // Never scroll horizontally; show the vertical scrollbar only when
        // the content is taller than the visible editor area.
        this._scrollView.set_policy(
            St.PolicyType.NEVER,
            St.PolicyType.AUTOMATIC
        );

        if (typeof this._scrollView.set_mouse_scrolling === 'function')
            this._scrollView.set_mouse_scrolling(true);

        if (typeof this._scrollView.set_touch_scrolling === 'function')
            this._scrollView.set_touch_scrolling(true);

        if (typeof this._scrollView.set_overlay_scrollbars === 'function')
            this._scrollView.set_overlay_scrollbars(false);

        this._scrollView.set_child(this._scrollContent);
        this._dialog.add_child(this._scrollView);

        this._scrollView.connect('notify::width', () => {
            this._queueEntryResize();
        });

        this._scrollView.connect('notify::height', () => {
            this._queueEntryResize();
        });

        const actions = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'quick-notes-editor-actions',
            x_align: Clutter.ActorAlign.END,
        });

        this._saveButton = new St.Button({
            label: 'Save',
            style_class: 'quick-notes-editor-button',
            can_focus: true,
            reactive: true,
        });

        this._saveButton.connect('clicked', () => {
            this._finishEditing();
        });

        actions.add_child(this._saveButton);
        this._dialog.add_child(actions);

        Main.layoutManager.addTopChrome(this._dialog, {
            affectsStruts: false,
            trackFullscreen: false,
        });

        this._dialog.show();

        if (this._lastPosition) {
            const [x, y] = this._clampPosition(
                this._lastPosition.x,
                this._lastPosition.y
            );
            this._dialog.set_position(x, y);
        } else {
            this._positionDialog();
        }

        this._focusTimeoutId = GLib.idle_add_once(
            GLib.PRIORITY_DEFAULT_IDLE,
            () => {
                this._focusTimeoutId = 0;

                if (!this._dialog || !this._entry)
                    return;

                if (!this._lastPosition)
                    this._positionDialog();

                this._queueEntryResize();

                this._focusEntry();

                const text = this._entry.get_clutter_text();
                text.set_cursor_position(text.get_text().length);
            }
        );
    }

    _positionDialog() {
        if (!this._dialog)
            return;

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const [width, height] = this._dialog.get_size();

        let x = monitor.x + Math.round((monitor.width - width) / 2);
        let y = monitor.y + EDITOR_TOP_OFFSET;

        [x, y] = this._clampPosition(x, y);
        this._dialog.set_position(x, y);
    }

    _clampPosition(x, y) {
        if (!this._dialog)
            return [x, y];

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return [x, y];

        const [width, height] = this._dialog.get_size();
        const margin = 48;

        const minX = monitor.x - width + margin;
        const maxX = monitor.x + monitor.width - margin;
        const minY = monitor.y;
        const maxY = monitor.y + monitor.height - margin;

        return [
            Math.round(Math.min(Math.max(x, minX), maxX)),
            Math.round(Math.min(Math.max(y, minY), maxY)),
        ];
    }

    _configureDragHandle() {
        if (!this._dragHandle)
            return;

        this._dragHandle.connect('button-press-event', (_actor, event) => {
            if (!this._dialog || event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;

            const [dialogX, dialogY] = this._dialog.get_position();
            const [pointerX, pointerY] = event.get_coords();

            this._dragging = true;
            this._dragOffsetX = pointerX - dialogX;
            this._dragOffsetY = pointerY - dialogY;

            this._stageMotionId = global.stage.connect(
                'motion-event',
                (_stage, motionEvent) => this._onStageMotion(motionEvent)
            );

            this._stageReleaseId = global.stage.connect(
                'button-release-event',
                (_stage, releaseEvent) => {
                    if (releaseEvent.get_button() === Clutter.BUTTON_PRIMARY)
                        this._endDrag();

                    return Clutter.EVENT_STOP;
                }
            );

            return Clutter.EVENT_STOP;
        });
    }

    _onStageMotion(event) {
        if (!this._dragging || !this._dialog)
            return Clutter.EVENT_PROPAGATE;

        const [pointerX, pointerY] = event.get_coords();

        let x = Math.round(pointerX - this._dragOffsetX);
        let y = Math.round(pointerY - this._dragOffsetY);

        [x, y] = this._clampPosition(x, y);
        this._dialog.set_position(x, y);

        return Clutter.EVENT_STOP;
    }

    _endDrag() {
        if (this._stageMotionId > 0) {
            global.stage.disconnect(this._stageMotionId);
            this._stageMotionId = 0;
        }

        if (this._stageReleaseId > 0) {
            global.stage.disconnect(this._stageReleaseId);
            this._stageReleaseId = 0;
        }

        if (this._dragging && this._dialog) {
            const [x, y] = this._dialog.get_position();
            this._lastPosition = {x, y};
        }

        this._dragging = false;
    }

    _focusEntry() {
        if (!this._entry)
            return;

        // The editor is non-modal, so opening Firefox (or another app)
        // legitimately moves keyboard focus away from the editor. When the
        // user clicks the editor again, explicitly return key focus to the
        // Entry. ClutterActor.grab_key_focus() sets the stage's key focus to
        // the actor.
        this._entry.grab_key_focus();

        const text = this._entry.get_clutter_text();

        if (text) {
            text.set_editable(true);
            text.set_selectable(true);
            text.set_cursor_visible(true);
        }
    }

    _configureEntry() {
        if (!this._entry)
            return;

        const text = this._entry.get_clutter_text();

        text.set_single_line_mode(false);
        text.set_line_wrap(true);

        // Give Pango an explicit finite width. ClutterText wrapping only
        // happens when its layout has a width constraint.
        if (typeof text.set_line_wrap_mode === 'function')
            text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);

        if (typeof text.set_ellipsize === 'function')
            text.set_ellipsize(Pango.EllipsizeMode.NONE);

        this._setPangoTextWidth(text);

        text.set_editable(true);
        text.set_selectable(true);
        text.set_activatable(false);
        text.set_cursor_visible(true);

        text.connect('text-changed', () => {
            this._onTextChanged();
            this._queueEntryResize();

            // When typing at the end of a note, keep the newest line visible.
            // This avoids the common "cursor disappears below the fold"
            // problem without needing a rectangle/Graphene helper.
            this._queueScrollToEndIfAtEnd();
        });

        text.connect('notify::cursor-position', () => {
            const cursor = text.get_cursor_position();
            const length = text.get_text().length;

            if (cursor === length)
                this._queueScrollToEndIfAtEnd();
        });

        this._entry.connect('notify::width', () => {
            this._queueEntryResize();
        });

        // ClutterText can consume scroll events itself. Handle them here so
        // the vertical adjustment is changed explicitly. Horizontal motion
        // is intentionally ignored.
        this._entry.connect('scroll-event', (_actor, event) => {
            return this._onEntryScroll(event);
        });

        this._entry.connect('button-press-event', () => {
            this._focusEntry();

            GLib.idle_add_once(
                GLib.PRIORITY_DEFAULT_IDLE,
                () => {
                    if (this._dialog && this._entry)
                        this._focusEntry();
                }
            );

            return Clutter.EVENT_PROPAGATE;
        });

        this._entry.connect('button-release-event', () => {
            this._focusEntry();
            return Clutter.EVENT_PROPAGATE;
        });

        this._entry.connect('key-press-event', (_actor, event) => {
            return this._onKeyPress(event);
        });
    }

    _setPangoTextWidth(text = null) {
        const clutterText = text || (this._entry
            ? this._entry.get_clutter_text()
            : null);

        if (!clutterText || typeof clutterText.get_layout !== 'function')
            return;

        const layout = clutterText.get_layout();

        if (!layout || typeof layout.set_width !== 'function')
            return;

        layout.set_width(
            Math.floor(EDITOR_TEXT_INNER_WIDTH * Pango.SCALE)
        );

        if (typeof layout.set_wrap === 'function')
            layout.set_wrap(Pango.WrapMode.WORD_CHAR);
    }

    _queueEntryResize() {
        if (this._entryResizeTimeoutId > 0)
            return;

        this._entryResizeTimeoutId = GLib.idle_add_once(
            GLib.PRIORITY_DEFAULT_IDLE,
            () => {
                this._entryResizeTimeoutId = 0;
                this._updateEntryLayout();
            }
        );
    }

    _updateEntryLayout() {
        if (!this._entry || !this._scrollContent || !this._scrollView)
            return;

        const availableHeight = Math.floor(this._scrollView.get_height());

        if (availableHeight <= 0)
            return;

        // Do NOT use the Entry's natural width and do NOT let the scrollable
        // content negotiate a width from the text. The editor deliberately
        // has a fixed text width, and there is never horizontal scrolling.
        const width = EDITOR_TEXT_WIDTH;

        if (Math.abs(this._entry.get_width() - width) > 0.5)
            this._entry.set_width(width);

        if (Math.abs(this._scrollContent.get_width() - width) > 0.5)
            this._scrollContent.set_width(width);

        const clutterText = this._entry.get_clutter_text();

        // Explicitly constrain Pango before measuring. This is the part that
        // stops very long words/URLs/code-like strings from escaping in X.
        this._setPangoTextWidth(clutterText);

        let textHeight = 0;
        const layout = clutterText && clutterText.get_layout
            ? clutterText.get_layout()
            : null;

        if (layout && typeof layout.get_pixel_size === 'function') {
            const [, measuredHeight] = layout.get_pixel_size();
            textHeight = Math.ceil(measuredHeight);
        }

        // Entry CSS has 10px top/bottom padding and a 1px border.
        const contentHeight = Math.max(
            availableHeight,
            textHeight + 24
        );

        if (Math.abs(this._entry.get_height() - contentHeight) > 0.5)
            this._entry.set_height(contentHeight);

        if (Math.abs(this._scrollContent.get_height() - contentHeight) > 0.5)
            this._scrollContent.set_height(contentHeight);

        // Absolutely no horizontal scrolling.
        const hAdjustment = this._scrollView.get_hadjustment();

        if (hAdjustment)
            hAdjustment.set_value(0);
    }

    _onEntryScroll(event) {
        if (!this._scrollView)
            return Clutter.EVENT_PROPAGATE;

        const adjustment = this._scrollView.get_vadjustment();

        if (!adjustment)
            return Clutter.EVENT_PROPAGATE;

        let deltaY = 0;
        const direction = event.get_scroll_direction();

        if (direction === Clutter.ScrollDirection.SMOOTH) {
            const values = event.get_scroll_delta();
            deltaY = values.length >= 2 ? values[1] : 0;
        } else if (direction === Clutter.ScrollDirection.UP) {
            deltaY = -1;
        } else if (direction === Clutter.ScrollDirection.DOWN) {
            deltaY = 1;
        } else {
            // LEFT/RIGHT are deliberately ignored.
            return Clutter.EVENT_STOP;
        }

        if (!Number.isFinite(deltaY) || deltaY === 0)
            return Clutter.EVENT_STOP;

        const step = direction === Clutter.ScrollDirection.SMOOTH
            ? 55
            : 45;

        const lower = adjustment.get_lower();
        const upper = adjustment.get_upper();
        const pageSize = adjustment.get_page_size();
        const maximum = Math.max(lower, upper - pageSize);

        let value = adjustment.get_value() + deltaY * step;

        value = Math.min(
            Math.max(value, lower),
            maximum
        );

        adjustment.set_value(value);

        return Clutter.EVENT_STOP;
    }

    _queueScrollToEndIfAtEnd() {
        if (this._scrollToEndTimeoutId > 0)
            return;

        this._scrollToEndTimeoutId = GLib.idle_add_once(
            GLib.PRIORITY_DEFAULT_IDLE,
            () => {
                this._scrollToEndTimeoutId = 0;

                if (!this._entry || !this._scrollView)
                    return;

                const text = this._entry.get_clutter_text();

                if (!text)
                    return;

                if (text.get_cursor_position() !== text.get_text().length)
                    return;

                const adjustment = this._scrollView.get_vadjustment();

                if (!adjustment)
                    return;

                const lower = adjustment.get_lower();
                const maximum = Math.max(
                    lower,
                    adjustment.get_upper() - adjustment.get_page_size()
                );

                adjustment.set_value(maximum);
            }
        );
    }

    _onTextChanged() {
        if (!this._store || !this._entry || this._isNew || !this._noteId)
            return;

        const text = this._entry.get_text();

        if (text !== this._originalText) {
            this._store.updateNoteText(this._noteId, text);
            this._originalText = text;
        }
    }

    _onKeyPress(event) {
        const symbol = event.get_key_symbol();
        const state = event.get_state();
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;

        if (symbol === Clutter.KEY_Escape) {
            this._finishEditing();
            return Clutter.EVENT_STOP;
        }

        if (ctrl && symbol === Clutter.KEY_a) {
            const text = this._entry.get_clutter_text();
            text.set_selection(0, text.get_text().length);
            return Clutter.EVENT_STOP;
        }

        if (
            ctrl &&
            (symbol === Clutter.KEY_Return ||
             symbol === Clutter.KEY_KP_Enter)
        ) {
            this._finishEditing();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _finishEditing() {
        this._commit();
        this._destroyDialog();
    }

    _commit() {
        if (this._committed || !this._entry || !this._store)
            return;

        this._committed = true;

        const text = this._entry.get_text();

        if (this._isNew) {
            if (text.trim())
                this._store.createNote(text);
        } else if (this._noteId && text !== this._originalText) {
            this._store.updateNoteText(this._noteId, text);
        }
    }

    _destroyDialog() {
        if (this._focusTimeoutId > 0) {
            GLib.source_remove(this._focusTimeoutId);
            this._focusTimeoutId = 0;
        }

        if (this._entryResizeTimeoutId > 0) {
            GLib.source_remove(this._entryResizeTimeoutId);
            this._entryResizeTimeoutId = 0;
        }

        if (this._scrollToEndTimeoutId > 0) {
            GLib.source_remove(this._scrollToEndTimeoutId);
            this._scrollToEndTimeoutId = 0;
        }

        this._endDrag();

        if (!this._dialog)
            return;

        const dialog = this._dialog;

        this._dialog = null;
        this._entry = null;
        this._scrollView = null;
        this._scrollContent = null;
        this._saveButton = null;
        this._closeButton = null;
        this._dragHandle = null;
        this._noteId = null;
        this._originalText = '';
        this._isNew = false;

        try {
            Main.layoutManager.removeChrome(dialog);
        } catch (error) {
            // Shell may already be shutting down.
        }

        dialog.destroy();
    }
}
