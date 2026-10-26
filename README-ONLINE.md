# Digital Swami – family games (single player, pass & play, hotspot, online)

One Node server does two jobs: it serves `index.html` and it relays WebSocket room events between players.

## Play modes
- **Single Player · vs Ammamma** – you against the Ammamma bot (easy / medium / hard). No server needed.
- **Pass & Play** – one phone, take turns, optional bots. No server needed.
- **Hotspot / Wi-Fi** – run `node server.js` on one device (default port **8787**) and enter its private IP, e.g. `192.168.43.1:8787`.
- **Online Play** – deploy the server (below). The page connects to the server that served it, so there is no URL to type.

## Deploy on Render
1. Push these files to the repository root.
2. In Render choose **New + > Blueprint** and select the repository (it reads `render.yaml`), or create a Node Web Service with build `npm install` and start `npm start`.
3. Open `https://YOUR-SERVICE.onrender.com/health` – it should return `{"ok":true,...}`.
4. Open `https://YOUR-SERVICE.onrender.com/` on every phone, choose **Online Play**, create a room and share the 4-letter code.

The free Render tier sleeps when idle and takes up to a minute to wake. The page pings `/health` when the Online panel opens and waits up to 60 seconds to connect.

## Room rules
- Creating a room always gets a fresh code; joining a code that does not exist shows "Room not found".
- Up to 8 players per room. Rooms live in memory and vanish when the server restarts.
- Connections are pinged every 25 s; dead ones are cleaned up. Message flooding is rate-limited.

## Limits
This is a lightweight relay, not a database-backed platform. Add authentication, persistence and server-side validation before a large public launch. Never put secrets in `index.html`.

## Ads
No ad code is included. If you add Google AdSense later, add your own publisher ID and keep ads away from game controls.
