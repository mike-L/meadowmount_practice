# Meadowmount Practice App

A small practice logger for PDF, PNG, and JPEG sheet-music sections. It is a static web page with no server: it runs in Chrome or Safari on your iPad and Mac, and keeps your score screenshots and practice history in Dropbox.

## How it works

- Your library is a Dropbox **App folder**: `Dropbox/Apps/<your app name>/`. The app can see only that folder.
- Each **piece** is a folder inside it, holding that piece's score screenshots.
- Piece settings and practice history are saved in `app-data.json` at the top of the same folder.
- The page talks to Dropbox directly from your browser, so your music and notes never pass through any other server.

```
Dropbox/Apps/Meadowmount Practice/
├── app-data.json
├── Chopin/              1.png … 9.png
├── Segovia/             A_Major.png, …
└── Bach_Prelude_BWV1007/ 1.png … 41.png
```

## One-time setup

### 1. Create the Dropbox app
1. Go to <https://www.dropbox.com/developers/apps> and choose **Create app**.
2. Choose **Scoped access**, then **App folder**, and give it a name, for example "Meadowmount Practice". That name becomes the folder name under `Dropbox/Apps/`.
3. On the **Permissions** tab, tick `files.metadata.read`, `files.content.read` and `files.content.write`, then click **Submit**.
4. On the **Settings** tab, under **OAuth 2 → Redirect URIs**, add both of these:
   - `https://mike-l.github.io/meadowmount_practice/`
   - `http://localhost:8000/` (for testing on the Mac)
5. Copy the **App key** into `config.js`. The app key is meant to be public. Do **not** copy the App secret, which this app doesn't use.

### 2. Put your music in Dropbox
1. Install the Dropbox desktop app on your Mac.
2. Open the page and connect Dropbox once (see below). This creates `Dropbox/Apps/<app name>/`.
3. Copy your piece folders and `app-data.json` into that folder in Finder.

If `app-data.json` was made by the old Mac-only version, the app converts its full Mac folder paths to plain folder names the first time it saves.

### 3. Publish the page
The page is hosted free on GitHub Pages: repo **Settings → Pages → Deploy from a branch → `main` / root**. Every push to `main` updates the site.

## Use it

- Open <https://mike-l.github.io/meadowmount_practice/> and tap **Connect Dropbox**. You stay signed in on that browser until you choose **Disconnect**.
- On iPad, use **Share → Add to Home Screen** to get an app icon. The Home Screen copy has its own sign-in, so connect once there too.
- To add a piece, drop a folder of screenshots into the Dropbox app folder. Then go to **Pieces & folders → Add a piece → Browse…** and choose it.

On the Practice screen:
- **Practice next** picks another random section without logging anything.
- **Log passage and practice next** records the current passage with a blank note, then picks another section.
- **Notes → Save practice note** records the passage with a note.
- **Back**, **Forward** and **Move to latest** move through the passages you've seen during this visit.

Sections are numbered in natural order, so `2.png` comes before `10.png`.

History can be exported and imported from the History screen. Imports merge entries.

## Using more than one device

Every save reads the latest `app-data.json`, applies the change, and writes it back only if no other device saved in the meantime. If another device did save, it starts again from that version. This means the iPad and the Mac don't overwrite each other's entries. If you want to see entries made on another device, refresh the page.

## Test locally on the Mac

```
cd meadowmount_practice
python3 -m http.server 8000
```

Then open <http://localhost:8000/> in Chrome. This command only serves the files for testing and isn't part of the app.

## Privacy and security

- The app can only read and write its own Dropbox app folder, not the rest of your Dropbox.
- Sign-in uses Dropbox's PKCE method for browser apps, so no secret is stored in the code.
- The Dropbox sign-in token is kept in this browser's local storage. Anyone who can use this browser profile can open your practice library, so choose **Disconnect** on shared devices.
- The page's Content-Security-Policy allows connections only to Dropbox.
- Keep a backup of `app-data.json`. Dropbox also keeps earlier versions (right-click the file on dropbox.com and choose **Version history**).

## Files

- `index.html`, `styles.css`: the interface
- `app.js`: practice, history and piece screens
- `dropbox.js`: Dropbox sign-in, library listing and saving `app-data.json`
- `config.js`: your Dropbox app key

## Licence

Copyright 2026 mike-L. Released under the [PolyForm Noncommercial License 1.0.0](LICENSE.md).

You are welcome to use, copy and adapt this app for personal music study, teaching, and other non-commercial purposes, including at schools, charities and other non-profit organisations. Any commercial use, including selling it or building it into a paid product or service, needs written permission first. To ask, contact [mike-L on GitHub](https://github.com/mike-L).
