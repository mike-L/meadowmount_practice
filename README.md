# Meadowmount Practice App

A small local-only practice logger for PDF, PNG, and JPEG sheet-music sections. It runs on your computer and opens in Chrome, Safari, or Edge. It does not upload your music or require an account.

## Start the app

### macOS
1. Install Python 3 if it is not already installed.
2. In Finder, open this folder and double-click `run_mac.command`. If macOS blocks the first launch, right-click the file and choose **Open**.
3. The app should open in your default browser. Keep the Terminal window open while practicing; press Control-C there to stop the local server.

If the launcher is not executable, open Terminal, change to this folder, and run `python3 server.py`.

### Windows
1. Install Python 3 from [python.org](https://www.python.org/downloads/) if it is not already installed. Enable the Python launcher during installation.
2. Double-click `run_windows.bat`.
3. Keep the command window open while practicing; press Control-C to stop.

The server listens only on this computer (`127.0.0.1`). If the browser does not open automatically, use the local address printed in the launcher window.

## Configure music

1. Select **Pieces & folders** and click **Add a piece**.
2. Enter a display name and the full path to that piece's folder. For example:
   - macOS: `/Users/yourname/Music/Beethoven Sonata`
   - Windows: `C:\Users\yourname\Music\Beethoven Sonata`
3. Save. The app finds supported files in that folder and its subfolders. It ignores other file types (including LilyPond sources).

Supported score files: `.pdf`, `.png`, `.jpg`, and `.jpeg`. PDF viewing uses the browser's built-in PDF viewer. The Practice screen chooses a random file each time; repeats are possible. Use **Notes** and **Save practice note** to record a practice session, or use **Log passage and practice next** to log the current passage with a blank note and then choose another section. **Practice next** changes sections without recording practice. The bottom **Back**, **Forward**, and **Move to latest** controls navigate passages shown during the current page session without logging them.

## Data and iCloud

Piece configuration and practice history are stored in `app-data.json`. By default, it is in this app folder. To choose another location, open **Pieces & folders**, find **App data folder**, enter the full path to an existing folder (not the JSON filename), and choose **Change folder**. If the current data file exists and the destination is empty, the app copies it to the destination and leaves the original in place as a backup. If you already moved the JSON file, choose its containing folder and the app will adopt that file. The chosen location is remembered in `app-settings.json` beside the app. Restart the local server after updating app files so the browser is using the latest settings feature.

You can select an iCloud Drive folder as the data location to let iCloud sync the JSON file. Each computer must be pointed to the appropriate local folder, and simultaneous edits may cause sync conflicts; this app does not merge concurrent changes. Back up `app-data.json` before changing or syncing locations. **Do not hand-edit the JSON while the app is running.** The app itself and `app-settings.json` should remain in a writable folder.

History can also be exported/imported from the History screen. Imports merge entries; they do not alter your music files.

## Security notes

- The server binds only to `127.0.0.1`; do not change this to `0.0.0.0` or expose it through a router, tunnel, or port-forward.
- The app checks local request origins and uses a per-run token for API access and changes. Keep using the address printed by the launcher.
- Choose only music folders you trust. Supported score files are served locally by the browser; the app does not upload them.
- `app-data.json` contains your piece-folder paths and practice notes in readable JSON. Protect the app folder like any personal notes, and make backups before sharing or syncing it. The launcher does not encrypt the file.
- This protects against ordinary websites making requests to the local app, not against malware or another person/process already running as your macOS/Windows user.
- Keep Python and your browser updated. PDFs are rendered by the browser’s built-in PDF viewer.

## Files

- `server.py` — local Python standard-library server and persistence layer
- `index.html`, `styles.css`, `app.js` — browser interface
- `run_mac.command`, `run_windows.bat` — launchers
- `app-data.json` — created automatically after your first saved change, in the configured data folder
- `app-settings.json` — remembers the selected app data folder beside the app
