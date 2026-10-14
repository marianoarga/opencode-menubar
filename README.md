# opencode-menubar

A lightweight native macOS menu bar app that shows OpenCode activity across all
sessions. One icon, three states, no Dock icon, and no session switching.

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
crisp Retina rendering. Click it to check activity and connection status or quit.
The current menu text is in Spanish.

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

With other OpenCode sessions idle, run:

```sh
bun scripts/verify-installed.js
```

This starts a temporary local OpenCode server, runs `sleep 3` in a real session,
and checks that the running app transitions from working to idle. Controlled
question events verify the attention state. No model requests are made. The
script deletes its test session and stops the temporary server when finished.

## How it works

Each plugin instance writes a separate JSON snapshot to
`~/Library/Application Support/OpenCode Menu Bar/states`. Snapshots contain
internal session identifiers and activity states, not prompts, responses, project
paths, or session titles. Files use private permissions and atomic renames.
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
