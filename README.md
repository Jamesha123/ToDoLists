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

Then open [http://localhost:3000](http://localhost:3000) in your browser. Open it in a second tab or on
another device on your network and watch changes sync in real time.

To use a different port:

```bash
# macOS / Linux
PORT=8080 node server.js

# Windows (PowerShell)
$env:PORT=8080; node server.js
```



### The easy way — one click

Double-click `start.bat`. It opens two windows:

1. the to-do **server** on port **3001** (`node server.js`), and
2. the **tunnel** (`ngrok`) bound to the permanent URL.

Permanent URL: **[https://marital-quicksand-contend.ngrok-free.dev](https://marital-quicksand-contend.ngrok-free.dev)**  
Local URL: **[http://localhost:3001](http://localhost:3001)**

