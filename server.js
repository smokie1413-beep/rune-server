const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  const filePath = path.join(__dirname, 'index.html');
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Error: index.html not found in server folder.');
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(content, 'utf-8');
    }
  });
});

const wss = new WebSocketServer({ server });
console.log(`[RuneServer] Starting on port ${PORT}`);

const players = {};
const npcs = [
  { id: 1, name: 'Goblin', x: 18, y: 28, targetX: 18, targetY: 28, hp: 12, maxHp: 12, level: 2, alive: true, respawnTicks: 0, atkTimer: 0 },
  { id: 2, name: 'Goblin Guard', x: 26, y: 30, targetX: 26, targetY: 30, hp: 20, maxHp: 20, level: 5, alive: true, respawnTicks: 0, atkTimer: 0 }
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
    hp: 20,
    maxHp: 20,
    combatLvl: 3,
    xp: 0,
    action: null,
    facing: 'down',
    isAttacking: false
  };

  ws.send(JSON.stringify({ type: 'INIT', id: playerId, players, npcs }));
  broadcast({ type: 'PLAYER_JOINED', player: players[playerId] });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'MOVE' && players[playerId]) {
        players[playerId].targetX = data.x;
        players[playerId].targetY = data.y;
        players[playerId].action = null; // Cancel combat on move
      } else if (data.type === 'ATTACK' && players[playerId]) {
        players[playerId].action = { type: 'ATTACK', targetId: data.targetId };
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

// 20-Tick Network Loop (50ms) - Movement Interpolation
setInterval(() => {
  const moveSpeed = 0.15;
  Object.values(players).forEach((p) => {
    if (Math.round(p.x) !== p.targetX || Math.round(p.y) !== p.targetY) {
      if (p.x < p.targetX) { p.x = Math.min(p.targetX, p.x + moveSpeed); p.facing = 'right'; }
      else if (p.x > p.targetX) { p.x = Math.max(p.targetX, p.x - moveSpeed); p.facing = 'left'; }
      if (p.y < p.targetY) { p.y = Math.min(p.targetY, p.y + moveSpeed); p.facing = 'down'; }
      else if (p.y > p.targetY) { p.y = Math.max(p.targetY, p.y - moveSpeed); p.facing = 'up'; }
    }
  });

  // NPC Movement & Respawn logic
  npcs.forEach(npc => {
    if (!npc.alive) return;
    if (Math.round(npc.x) !== npc.targetX || Math.round(npc.y) !== npc.targetY) {
      if (npc.x < npc.targetX) npc.x = Math.min(npc.targetX, npc.x + moveSpeed);
      else if (npc.x > npc.targetX) npc.x = Math.max(npc.targetX, npc.x - moveSpeed);
      if (npc.y < npc.targetY) npc.y = Math.min(npc.targetY, npc.y + moveSpeed);
      else if (npc.y > npc.targetY) npc.y = Math.max(npc.targetY, npc.y - moveSpeed);
    } else if (Math.random() < 0.02) { // Random wander
      npc.targetX = Math.max(10, Math.min(40, npc.x + (Math.floor(Math.random() * 5) - 2)));
      npc.targetY = Math.max(10, Math.min(40, npc.y + (Math.floor(Math.random() * 5) - 2)));
    }
  });

  broadcast({ type: 'TICK_UPDATE', players, npcs });
}, 50);

// RuneScape Action Loop (600ms) - Combat & Skills
setInterval(() => {
  Object.values(players).forEach((p) => {
    if (p.action && p.action.type === 'ATTACK') {
      const npc = npcs.find((n) => n.id === p.action.targetId);
      if (npc && npc.alive) {
        const dist = Math.hypot(p.x - npc.x, p.y - npc.y);
        if (dist <= 1.5) { // In attack range
          const hit = Math.floor(Math.random() * 5); // 0 to 4 damage
          npc.hp = Math.max(0, npc.hp - hit);
          p.isAttacking = true;

          // XP Gain (4 XP per 1 damage)
          const xpGained = Math.max(10, hit * 4);
          p.xp += xpGained;
          
          if (p.xp >= p.combatLvl * 50) {
            p.combatLvl++;
            p.maxHp += 2;
            p.hp = p.maxHp;
            broadcast({ type: 'HITSPLAT', text: 'LEVEL UP!', x: Math.round(p.x), y: Math.round(p.y), color: '#ffff00' });
          }

          broadcast({ 
            type: 'HITSPLAT', 
            text: hit === 0 ? '0' : `-${hit}`, 
            x: Math.round(npc.x), 
            y: Math.round(npc.y), 
            color: hit === 0 ? '#888888' : '#ff3333' 
          });

          if (npc.hp <= 0) {
            npc.alive = false;
            npc.respawnTicks = 10;
            p.action = null;
          }
        } else {
          // Walk toward target
          p.targetX = Math.round(npc.x);
          p.targetY = Math.round(npc.y);
        }
      } else {
        p.action = null;
      }
    } else {
      p.isAttacking = false;
    }
  });

  // NPC Respawn System
  npcs.forEach((npc) => {
    if (!npc.alive) {
      npc.respawnTicks--;
      if (npc.respawnTicks <= 0) {
        npc.alive = true;
        npc.hp = npc.maxHp;
      }
    }
  });
}, 600);

server.listen(PORT, () => {
  console.log(`[RuneServer] Running on port ${PORT}`);
});
