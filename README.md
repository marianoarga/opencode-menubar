# opencode-menubar

A lightweight native macOS menu bar app that shows OpenCode activity across all
sessions. One icon, three states, and a live session list with elapsed timers.

Built with Swift and AppKit, with a small global OpenCode plugin. No Electron,
web view, third-party runtime dependencies, or background HTTP server.

## Activity at a glance

| Icon | State | Meaning |
| --- | --- | --- |
| Neutral OpenCode logo | Idle | All sessions are idle. Adapts to the macOS light/dark appearance. |
| Pulsing blue OpenCode logo | Working | At least one session is working or retrying. |
| Orange OpenCode logo | Needs attention | A session is waiting for an answer or permission. Takes priority over working. |

Activity is combined across local OpenCode instances and projects. If one session
finishes while another is working, the icon stays active. Idle indicates that work
has stopped, not that the last task succeeded.

The icon uses the official OpenCode logo geometry from
[`favicon.svg`](https://opencode.ai/favicon.svg), drawn natively as a vector for
crisp Retina rendering. Click it to see connected sessions, activity, elapsed
timers, and connection status, or quit.
The current menu text is in Spanish.

## Expanded session menu

Each observed session uses its descriptive sidebar title, followed by its state,
elapsed time, and project name:

```text
Fix login
    Trabajando · hace 2 min 15 s · my-app
Review checkout
    Requiere atención · hace 30 s · website
Update dependencies
    En reposo · hace 1 min 5 s · api
```

Active sessions are listed first, with attention taking priority. Timers update
while the menu is open. Working time is measured from the start of the current
run, including any waits or retries; answering a question does not reset it.
Attention and idle durations are measured from the last state transition. A new
run starts a fresh timer.

The menu lists sessions observed since each plugin instance connected, including
resumed sessions after they are selected or used. Idle sessions stay listed until
deleted or their instance disconnects. It does not load the full session history.

Titles come from OpenCode session metadata. For local sessions, the app also
looks up connected session titles in OpenCode's SQLite database using a read-only
connection, refreshing cached names every 2 seconds. This follows sidebar renames
and resolves titles for instances still running an older plugin. The app never
shows a session ID as its name; unavailable names use a temporary loading label.

## Requirements

- macOS 13 or later.
- OpenCode with support for global plugins and session activity events.
- Xcode Command Line Tools, including the Swift compiler.
- Python 3 for the installer.
- Bun to run the tests and installation verification.

## Build and install

```sh
bash scripts/build.sh
bun test
bash scripts/install.sh
```

The installer builds and ad-hoc signs the app, installs it, and starts it:

| Component | Location |
| --- | --- |
| App | `~/Applications/OpenCode Menu Bar.app` |
| Global plugin | `~/.config/opencode/plugins/opencode-menubar.js` |
| Login LaunchAgent | `~/Library/LaunchAgents/local.opencode.menubar.plist` |

**Quit and restart any running OpenCode instances to load the plugin.** Sessions
are observed from the moment the integration loads.

The app starts automatically when you log in to macOS. Quitting from its menu
closes it until you reopen it or log in again.

## Verify an installation

Run:

```sh
bun scripts/verify-installed.js
```

This starts a temporary local OpenCode server, runs `sleep 3` in a real session,
and checks that its row in the running app transitions from working to idle. Controlled
question events verify the attention state. No model requests are made. The
script deletes its test session and stops the temporary server when finished.

## How it works

Each plugin instance writes a separate JSON snapshot to
`~/Library/Application Support/OpenCode Menu Bar/states`. Snapshots contain
internal session identifiers, titles, project folder names, activity states, and
timestamps. It does not store prompts, responses, or full project paths.
Files use private permissions and atomic renames.
The app and plugin communicate through local files without opening a network port.

The plugin sends a heartbeat every 5 seconds. The app checks activity every
250 milliseconds and ignores snapshots older than 30 seconds or owned by exited
processes. The plugin's `dispose` hook removes its snapshot during clean shutdown.

You can also inspect the aggregate state from the command line:

```sh
"$HOME/Applications/OpenCode Menu Bar.app/Contents/MacOS/OpenCodeMenuBar" --status
```

## Uninstall

```sh
launchctl bootout "gui/$(id -u)/local.opencode.menubar"
rm "$HOME/Library/LaunchAgents/local.opencode.menubar.plist"
rm "$HOME/.config/opencode/plugins/opencode-menubar.js"
rm -rf "$HOME/Applications/OpenCode Menu Bar.app"
rm -rf "$HOME/Library/Application Support/OpenCode Menu Bar"
```

Restart OpenCode to remove the plugin from instances that were already running.
