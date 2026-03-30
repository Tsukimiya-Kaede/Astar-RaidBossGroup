const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const rooms = new Map(); // roomCode -> room

function randomId() {
  return crypto.randomBytes(8).toString('hex');
}

function getOrCreateRoom(code, password = '') {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      password,
      colors: { red: null, blue: null, green: null, yellow: null },
      members: new Map(), // clientId -> { clientId, ws, color }
      board: Array.from({ length: 10 }, () => ({ picks: {}, wrongs: {} })),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  return rooms.get(code);
}

function normalizeFloorState(floorState) {
  if (!floorState || typeof floorState !== 'object') {
    return { picks: {}, wrongs: {} };
  }
  if ('picks' in floorState || 'wrongs' in floorState) {
    return {
      picks: { ...(floorState.picks || {}) },
      wrongs: { ...(floorState.wrongs || {}) },
    };
  }
  return { picks: { ...floorState }, wrongs: {} };
}

function forEachFloor(room, callback) {
  room.board = room.board.map(normalizeFloorState);
  room.board.forEach((floorState, index) => callback(floorState, index));
}

function serializeRoom(room) {
  room.board = room.board.map(normalizeFloorState);
  return {
    code: room.code,
    memberCount: room.members.size,
    colors: room.colors,
    members: [...room.members.values()].map(m => ({ clientId: m.clientId, color: m.color || null })),
    board: room.board,
    updatedAt: room.updatedAt,
  };
}

function broadcastRoomState(room) {
  const payloadBase = { type: 'room_state', room: serializeRoom(room) };
  for (const member of room.members.values()) {
    safeSend(member.ws, { ...payloadBase, yourColor: member.color || null });
  }
}

function safeSend(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function leaveRoom(client, roomCode) {
  if (!roomCode) return;
  const room = rooms.get(roomCode);
  if (!room) return;

  const member = room.members.get(client.clientId);
  if (member) {
    if (member.color) {
      forEachFloor(room, (floorState) => {
        if (floorState.picks[member.color]) {
          delete floorState.picks[member.color];
        }
        Object.keys(floorState.wrongs).forEach((door) => {
          const colors = Array.isArray(floorState.wrongs[door]) ? floorState.wrongs[door] : [];
          const nextColors = colors.filter((color) => color !== member.color);
          if (nextColors.length > 0) floorState.wrongs[door] = nextColors;
          else delete floorState.wrongs[door];
        });
      });
    }
    if (member.color && room.colors[member.color] === client.clientId) {
      room.colors[member.color] = null;
    }
    room.members.delete(client.clientId);
    room.updatedAt = Date.now();
  }

  if (room.members.size === 0) {
    rooms.delete(roomCode);
  } else {
    broadcastRoomState(room);
  }
  client.roomCode = null;
}

function handleSelectColor(client, room, color) {
  if (!room.colors.hasOwnProperty(color)) {
    return safeSend(client.ws, { type: 'error', message: '無效顏色' });
  }
  const me = room.members.get(client.clientId);
  if (!me) return;
  const previousColor = me.color;

  // release old color
  if (me.color && room.colors[me.color] === client.clientId) {
    room.colors[me.color] = null;
  }

  const holder = room.colors[color];
  if (holder && holder !== client.clientId) {
    // revert previous color if taken
    if (me.color) room.colors[me.color] = client.clientId;
    return safeSend(client.ws, { type: 'error', message: '這個顏色已被選走' });
  }

  if (previousColor && previousColor !== color) {
    forEachFloor(room, (floorState) => {
      if (floorState.picks[previousColor]) {
        floorState.picks[color] = floorState.picks[previousColor];
        delete floorState.picks[previousColor];
      }
      Object.keys(floorState.wrongs).forEach((door) => {
        const colors = Array.isArray(floorState.wrongs[door]) ? floorState.wrongs[door] : [];
        if (!colors.includes(previousColor)) return;
        const nextColors = colors.map((item) => (item === previousColor ? color : item));
        floorState.wrongs[door] = [...new Set(nextColors)].slice(0, 3);
      });
    });
  }

  room.colors[color] = client.clientId;
  me.color = color;
  room.updatedAt = Date.now();
  broadcastRoomState(room);
}

function handleToggleShared(client, room, floor, door) {
  const me = room.members.get(client.clientId);
  if (!me || !me.color) {
    return safeSend(client.ws, { type: 'error', message: '請先選擇顏色' });
  }
  floor = Number(floor);
  door = Number(door);
  if (floor < 1 || floor > 10 || door < 1 || door > 4) {
    return safeSend(client.ws, { type: 'error', message: '無效座標' });
  }
  const floorState = normalizeFloorState(room.board[floor - 1]);
  room.board[floor - 1] = floorState;
  const picks = floorState.picks;
  const wrongs = floorState.wrongs;

  // Each door can only be occupied by one color.
  for (const [color, pickedDoor] of Object.entries(picks)) {
    if (pickedDoor === door && color !== me.color) {
      return safeSend(client.ws, { type: 'error', message: '此門已被其他顏色占用' });
    }
  }

  if (picks[me.color] === door) {
    delete picks[me.color];
  } else {
    picks[me.color] = door;
    delete wrongs[String(door)];
  }
  room.updatedAt = Date.now();
  broadcastRoomState(room);
}

function handleToggleWrong(client, room, floor, door) {
  const me = room.members.get(client.clientId);
  if (!me || !me.color) {
    return safeSend(client.ws, { type: 'error', message: '請先選擇顏色' });
  }
  floor = Number(floor);
  door = Number(door);
  if (floor < 1 || floor > 10 || door < 1 || door > 4) {
    return safeSend(client.ws, { type: 'error', message: '無效座標' });
  }

  const floorState = normalizeFloorState(room.board[floor - 1]);
  room.board[floor - 1] = floorState;
  const picks = floorState.picks;
  const wrongs = floorState.wrongs;

  if (Object.values(picks).includes(door)) {
    return safeSend(client.ws, { type: 'error', message: '已有共享正解，無法加上 X 標記' });
  }

  const key = String(door);
  const colors = Array.isArray(wrongs[key]) ? wrongs[key] : [];
  if (colors.includes(me.color)) {
    wrongs[key] = colors.filter((color) => color !== me.color);
    if (wrongs[key].length === 0) delete wrongs[key];
  } else {
    if (colors.length >= 3) {
      return safeSend(client.ws, { type: 'error', message: '同一格最多只能有三個共享 X 標記' });
    }
    wrongs[key] = [...colors, me.color];
  }

  room.updatedAt = Date.now();
  broadcastRoomState(room);
}

function handleClearShared(client, room) {
  for (let i = 0; i < 10; i++) room.board[i] = { picks: {}, wrongs: {} };
  room.updatedAt = Date.now();
  broadcastRoomState(room);
}

function cleanupIdleRooms() {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (room.members.size === 0 && now - room.updatedAt > 30 * 60 * 1000) {
      rooms.delete(code);
    }
  }
}
setInterval(cleanupIdleRooms, 5 * 60 * 1000);

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      ok: true,
      name: 'rjpq-multiplayer-backend',
      uptime: Math.round(process.uptime()),
      rooms: rooms.size
    }));
  }

  if (req.url && req.url.startsWith('/ws')) {
    res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Use WebSocket.');
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const client = { clientId: randomId(), ws, roomCode: null };
  safeSend(ws, { type: 'welcome', clientId: client.clientId });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch {
      return safeSend(ws, { type: 'error', message: '無法解析訊息' });
    }

    try {
      switch (msg.type) {
        case 'create_room': {
          const roomCode = String(msg.roomCode || '').trim().toLowerCase();
          const password = String(msg.password || '');
          if (!roomCode) return safeSend(ws, { type: 'error', message: '房號不可空白' });
          if (rooms.has(roomCode)) return safeSend(ws, { type: 'error', message: '房間已存在' });
          const room = getOrCreateRoom(roomCode, password);
          leaveRoom(client, client.roomCode);
          room.members.set(client.clientId, { clientId: client.clientId, ws, color: null });
          client.roomCode = roomCode;
          safeSend(ws, { type: 'joined_room', roomCode });
          broadcastRoomState(room);
          break;
        }
        case 'join_room': {
          const roomCode = String(msg.roomCode || '').trim().toLowerCase();
          const password = String(msg.password || '');
          const room = rooms.get(roomCode);
          if (!room) return safeSend(ws, { type: 'error', message: '找不到房間' });
          if ((room.password || '') !== password) {
            return safeSend(ws, { type: 'error', message: '房間密碼錯誤' });
          }
          leaveRoom(client, client.roomCode);
          room.members.set(client.clientId, { clientId: client.clientId, ws, color: null });
          client.roomCode = roomCode;
          safeSend(ws, { type: 'joined_room', roomCode });
          broadcastRoomState(room);
          break;
        }
        case 'select_color': {
          const room = rooms.get(client.roomCode);
          if (!room) return safeSend(ws, { type: 'error', message: '尚未加入房間' });
          handleSelectColor(client, room, String(msg.color || ''));
          break;
        }
        case 'toggle_shared': {
          const room = rooms.get(client.roomCode);
          if (!room) return safeSend(ws, { type: 'error', message: '尚未加入房間' });
          handleToggleShared(client, room, msg.floor, msg.door);
          break;
        }
        case 'toggle_wrong': {
          const room = rooms.get(client.roomCode);
          if (!room) return safeSend(ws, { type: 'error', message: '尚未加入房間' });
          handleToggleWrong(client, room, msg.floor, msg.door);
          break;
        }
        case 'clear_shared': {
          const room = rooms.get(client.roomCode);
          if (!room) return safeSend(ws, { type: 'error', message: '尚未加入房間' });
          handleClearShared(client, room);
          break;
        }
        case 'leave_room': {
          leaveRoom(client, client.roomCode);
          safeSend(ws, { type: 'left_room' });
          break;
        }
        default:
          safeSend(ws, { type: 'error', message: '未知操作' });
      }
    } catch (err) {
      console.error(err);
      safeSend(ws, { type: 'error', message: '伺服器錯誤' });
    }
  });

  ws.on('close', () => {
    leaveRoom(client, client.roomCode);
  });
});

server.listen(PORT, () => {
  console.log(`RJPQ multiplayer backend is running on port ${PORT}`);
});
