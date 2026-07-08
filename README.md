# Lists — Collaborative To-Do

A shared to-do list that anyone can open and edit. Everyone sees the same list,
and every change (add, check off, edit, delete) appears **live** for everyone
who has the page open — no refresh needed.

## How it works

The app is intentionally small and has **no external dependencies** — it runs on
Node.js built-in modules only.

- `server.js` — an HTTP server that serves the page, stores the list in
  `data.json`, and exposes a small REST API for changes.
- Real-time updates use [Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events).
  Each browser opens a long-lived `/api/events` stream; whenever the list
  changes, the server pushes the new state to every connected client at once.
- `public/` — the browser UI (plain HTML, CSS, and JavaScript).

```
browser  ──POST/PATCH/DELETE──▶  server  ──writes──▶  data.json
   ▲                               │
   └──────  SSE broadcast  ◀────────┘  (pushed to every open tab)
```

## Run it

Requires Node.js 18 or newer.

```bash
node server.js
```

Then open http://localhost:3000 in your browser. Open it in a second tab or on
another device on your network and watch changes sync in real time.

To use a different port:

```bash
# macOS / Linux
PORT=8080 node server.js

# Windows (PowerShell)
$env:PORT=8080; node server.js
```

## Usage

- Type a task and press Enter (or click **Add**).
- Click the circle to mark a task done.
- Double-click a task's text to edit it inline (Enter saves, Esc cancels).
- Click **×** to delete a task.
- Click **Clear completed** to remove all finished tasks.

The connection indicator at the top turns green when you're live-synced.

## Access from anywhere (public link)

The server itself only listens on your machine. To reach it from outside your
home network, an [ngrok](https://ngrok.com) tunnel gives it a permanent public
HTTPS address that forwards to `localhost:3000`.

Permanent URL: **https://marital-quicksand-contend.ngrok-free.dev**

### The easy way — one click

Double-click **`start.bat`**. It opens two windows:

1. the to-do **server** on port **3001** (`node server.js`), and
2. the **tunnel** (`ngrok`) bound to the permanent URL.

Local URL: **http://localhost:3001**

`start.bat` uses 3001 so Lists won't conflict with other apps that use port 3000.
Change the `PORT=` line in `start.bat` if you want a different port (and use the
same number in the ngrok command on the next line).

Keep both windows open while you want the site online; close them to take it
offline. (Nothing starts automatically on boot — you launch it when you want
it up.)

### The manual way

In two separate terminals:

```bash
set PORT=3001 && node server.js
ngrok http --url=https://marital-quicksand-contend.ngrok-free.dev 3001
```

### Notes about the free ngrok plan

- On the free plan, first-time visitors see a one-time ngrok warning page —
  they just click **"Visit Site"** and the app loads normally afterward.
- The authtoken is stored once in `%LOCALAPPDATA%\ngrok\ngrok.yml` (already
  configured on this machine), so you don't need to enter it again.

## Host online (Render — no PC required)

Deploy the same Node app to [Render](https://render.com) so it stays reachable
without your computer or ngrok. The free plan sleeps after ~15 minutes of no
visits; the first open after that may take 30–60 seconds (the status bar shows
**"Starting server…"** until it connects).

### 1. Push to GitHub

`data.json` is gitignored (your lists stay local). The cloud deploy starts with
empty lists unless you copy data up later (see step 4).

```bash
git init
git add .
git commit -m "Lists app"
git remote add origin https://github.com/YOUR_USER/lists.git
git push -u origin main
```

### 2. Create the web service

1. Sign in at [dashboard.render.com](https://dashboard.render.com)
2. **New +** → **Web Service**
3. Connect your GitHub repo
4. Render should detect `render.yaml`; otherwise set:
   - **Runtime:** Node
   - **Build command:** *(leave empty)*
   - **Start command:** `npm start`
   - **Plan:** Free
5. Click **Create Web Service**

You get a URL like `https://lists-xxxx.onrender.com`.

### 3. Use it

Open that URL on any device. While you're both using it, the server stays awake.
No `start.bat`, no ngrok, no port conflicts.

### 4. Automatic data backup (no manual commits)

**Local (every run):** Each save copies the previous `data.json` into `backups/`
(up to 30 timestamped files). If `data.json` is missing, corrupt, or empty on
startup, the server restores from the newest backup that still has list data.
Writes are atomic (temp file + rename) so a crash mid-save won't wipe the file.

**Cloud (Render):** `data.json` is **gitignored** — you never commit it by hand. On Render, set one
environment variable so the server backs up to GitHub after you edit lists:

1. GitHub → **Settings** → **Developer settings** → **Personal access tokens**
2. **Generate new token (classic)** or fine-grained with **Contents: Read and write** on `ToDoLists`
3. Render → your service → **Environment** → add:
   - `GITHUB_TOKEN` = your token
   - `GITHUB_REPO` = `Jamesha123/ToDoLists` *(optional, this is the default)*

**How it works:**
- Every change saves to disk, then **auto-uploads to GitHub** (~90 seconds after the last edit)
- On **startup / redeploy**, the server pulls from GitHub if that copy is newer
- Before Render restarts for a deploy, it tries to **flush** a final backup

Your lists survive redeploys without you touching git. Keep the repo **private** if you don't want list data public on GitHub.

**First-time seed:** If GitHub already has `data.json` from an earlier manual commit, you're set. Otherwise make one edit on the live site after adding `GITHUB_TOKEN`, wait ~2 minutes, and check GitHub for `data.json`.

### Render vs home PC

| | `start.bat` + ngrok | Render free |
|--|---------------------|-------------|
| PC must stay on | Yes | No |
| Cold start delay | No | Yes, after idle |
| Good for 2 people | Yes | Yes |
