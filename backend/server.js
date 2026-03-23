
const express = require("express");
const http = require("http");
const cors = require("cors");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const app = express();
app.use(cors());

const rooms = new Map();

function now() { return Date.now(); }

function createEmptyFloorMap() {
  const floors = {};
  for (let floor = 1; floor <= 10; floor++) {
    floors[String(floor)] = {
      success: {}, // color -> platform
      fail: {}     // color -> [platform, ...]
    };
  }
  return floors;
}

function createRoom(code, password = "") {
  return {
    code,
    password,
    createdAt: now(),
    updatedAt: now(),
    players: {},   // clientId -> { color, name }
    floors: createEmptyFloorMap()
  };
}

function publicRoomState(room) {
  return {
    code: room.code,
    players: room.players,
    floors: room.floors,
    updatedAt: room.updatedAt
  };
}

function getRoom(code) {
  return rooms.get(code);
}

function ensureRoom(code, password = "") {
  if (!rooms.has(code)) rooms.set(code, createRoom(code, password));
  return rooms.get(code);
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    name: "rjpq-web-backend",
    uptime: Math.floor(process.uptime()),
    rooms: rooms.size
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcastRoom(roomCode, payload) {
  const message = JSON.stringify(payload);
  for (const ws of wss.clients) {
    if (ws.readyState === 1 && ws.roomCode === roomCode) {
      ws.send(message);
    }
  }
}

function send(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

function normalizeName(value) {
  const s = String(value || "").trim();
  return s.slice(0, 20);
}

function normalizeColor(value) {
  const allowed = new Set(["red","blue","green","yellow"]);
  return allowed.has(value) ? value : "";
}

wss.on("connection", (ws) => {
  ws.clientId = Math.random().toString(36).slice(2, 10);
  ws.roomCode = null;

  send(ws, { type: "hello", clientId: ws.clientId });

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); }
    catch { return send(ws, { type: "error", message: "無效訊息格式" }); }

    const type = data.type;

    if (type === "join_room") {
      const code = String(data.code || "").trim();
      const password = String(data.password || "");
      if (!code) return send(ws, { type: "error", message: "請輸入房號" });

      let room = getRoom(code);
      if (!room) room = ensureRoom(code, password);

      if (room.password !== password) {
        return send(ws, { type: "error", message: "房間密碼錯誤" });
      }

      ws.roomCode = code;
      if (!room.players[ws.clientId]) {
        room.players[ws.clientId] = { color: "", name: "" };
      }
      room.updatedAt = now();
      send(ws, { type: "room_state", room: publicRoomState(room), yourClientId: ws.clientId });
      broadcastRoom(code, { type: "room_state", room: publicRoomState(room) });
      return;
    }

    if (!ws.roomCode) return send(ws, { type: "error", message: "尚未加入房間" });
    const room = getRoom(ws.roomCode);
    if (!room) return send(ws, { type: "error", message: "房間不存在" });

    if (type === "set_profile") {
      const color = normalizeColor(data.color);
      const name = normalizeName(data.name);

      if (color) {
        for (const [clientId, profile] of Object.entries(room.players)) {
          if (clientId !== ws.clientId && profile.color === color) {
            return send(ws, { type: "error", message: "顏色已被選走" });
          }
        }
      }

      room.players[ws.clientId] = {
        ...room.players[ws.clientId],
        color,
        name
      };
      room.updatedAt = now();
      return broadcastRoom(room.code, { type: "room_state", room: publicRoomState(room) });
    }

    if (type === "toggle_success") {
      const floor = String(data.floor);
      const platform = Number(data.platform);
      const profile = room.players[ws.clientId] || {};
      if (!room.floors[floor] || ![1,2,3,4].includes(platform) || !profile.color) {
        return send(ws, { type: "error", message: "共享標記失敗" });
      }
      const current = room.floors[floor].success[profile.color];
      if (current === platform) delete room.floors[floor].success[profile.color];
      else room.floors[floor].success[profile.color] = platform;
      room.updatedAt = now();
      return broadcastRoom(room.code, { type: "room_state", room: publicRoomState(room) });
    }

    if (type === "toggle_fail") {
      const floor = String(data.floor);
      const platform = Number(data.platform);
      const profile = room.players[ws.clientId] || {};
      if (!room.floors[floor] || ![1,2,3,4].includes(platform) || !profile.color) {
        return send(ws, { type: "error", message: "XX 標記失敗" });
      }
      const list = room.floors[floor].fail[profile.color] || [];
      const idx = list.indexOf(platform);
      if (idx >= 0) list.splice(idx, 1);
      else list.push(platform);
      room.floors[floor].fail[profile.color] = [...new Set(list)].sort((a,b)=>a-b);
      room.updatedAt = now();
      return broadcastRoom(room.code, { type: "room_state", room: publicRoomState(room) });
    }

    if (type === "clear_shared") {
      room.floors = createEmptyFloorMap();
      room.updatedAt = now();
      return broadcastRoom(room.code, { type: "room_state", room: publicRoomState(room) });
    }
  });

  ws.on("close", () => {
    const code = ws.roomCode;
    if (!code) return;
    const room = getRoom(code);
    if (!room) return;
    delete room.players[ws.clientId];
    room.updatedAt = now();
    broadcastRoom(code, { type: "room_state", room: publicRoomState(room) });
  });
});

server.listen(PORT, () => {
  console.log(`RJPQ backend listening on ${PORT}`);
});
