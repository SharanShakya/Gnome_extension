# Custom Application Priority Switcher

GNOME Shell 50 extension with a top-bar popup for running applications.

## Behavior

- The top-bar icon is always visible. Clicking it opens/closes the popup; clicking outside closes it.
- Each row has a priority circle, the app icon/name from the desktop entry, and a close (`×`) button.
- Clicking the icon/name area focuses the application and closes the popup.
- Clicking `×` calls the app's quit request. The row remains until the app actually exits, including while a save-confirmation dialog is open.
- Priority apps appear above normal apps in the popup.
- Priority also means **always on top** at the window-manager level: every window belonging to that app is kept above normal windows without stealing focus.
- Clicking another application can change focus, while a priority application remains above it.
- Turning priority off removes the always-on-top behavior that this extension applied to the app's windows.
- New applications are appended to the bottom of the normal section.
- Closing an application keeps its saved order slot, so a later relaunch returns it to its remembered position.
- Turning priority on moves the app to the bottom of the priority section.
- Turning priority off moves it to the top of the normal section.
- Dragging reorders only within the app's current section. The row follows the pointer by live list reordering and does not float freely.
- A movement of less than 6 px is a click; 6 px or more starts a drag.

State is saved at:

`~/.config/custom-app-priority-switcher/state.json`

The extension listens for app state changes and for an application's `windows-changed` signal so remembered priority is applied to newly opened windows too.

## Known gaps

- No automatic scrolling while dragging in a very long list. The list currently scrolls at about 480 px.
- No keyboard reordering.

## Development install

For a symlinked development checkout:

```bash
ln -s ~/Desktop/extensions/custom-app-priority-switcher@Hades \\
  ~/.local/share/gnome-shell/extensions/custom-app-priority-switcher@Hades
```

Then restart/reload GNOME Shell as appropriate and enable:

```bash
gnome-extensions enable custom-app-priority-switcher@Hades
```
