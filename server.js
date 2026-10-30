const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Create an HTTP server that serves index.html to web browsers
const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, 'index.html');
  
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('RuneQuest 2D: index.html not found on server!');
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(content, 'utf-8');
    }
  });
});

const wss = new WebSocketServer({ server });
console.log(`[RuneServer] Running on port ${PORT}`);

const players = {};
const npcs = [
  { id: 1, name: 'Goblin', x: 18, y: 28, hp: 8, maxHp: 8, alive: true, respawnTicks: 0 },
  { id: 2, name: 'Goblin', x: 26, y: 30, hp: 8, maxHp: 8, alive: true, respawnTicks: 0 }
];

function broadcast(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(message);
  });
}

wss.on('connection', (ws) => {
  const playerId = 'player_' + Math.random().toString(36).substring(2, 9);
  
  players[playerId] = {
    id: playerId,
    name: `Hero_${playerId.substring(7)}`,
    x: 22.0,
    y: 22.0,
    targetX: 22,
    targetY: 22,
    hp: 10,
    maxHp: 10,
    action: null
  };

  ws.send(JSON.stringify({ type: 'INIT', id: playerId, players, npcs }));
  broadcast({ type: 'PLAYER_JOINED', player: players[playerId] });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'MOVE' && players[playerId]) {
        players[playerId].targetX = data.x;
        players[playerId].targetY = data.y;
      } else if (data.type === 'CHAT') {
        broadcast({ type: 'CHAT_MSG', sender: players[playerId]?.name, text: data.text });
      }
    } catch (err) {}
  });

  ws.on('close', () => {
    delete players[playerId];
    broadcast({ type: 'PLAYER_LEFT', id: playerId });
  });
});

// 20-Tick Network Loop
setInterval(() => {
  const moveSpeed = 0.15;
  Object.values(players).forEach((p) => {
    if (Math.round(p.x) !== p.targetX || Math.round(p.y) !== p.targetY) {
      if (p.x < p.targetX) p.x = Math.min(p.targetX, p.x + moveSpeed);
      else if (p.x > p.targetX) p.x = Math.max(p.targetX, p.x - moveSpeed);
      if (p.y < p.targetY) p.y = Math.min(p.targetY, p.y + moveSpeed);
      else if (p.y > p.targetY) p.y = Math.max(p.targetY, p.y - moveSpeed);
    }
  });
  broadcast({ type: 'TICK_UPDATE', players, npcs });
}, 50);

server.listen(PORT);
