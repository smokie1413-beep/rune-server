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
      res.end('Error: index.html not found on server.');
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(content, 'utf-8');
    }
  });
});

const wss = new WebSocketServer({ server });
console.log(`[RuneServer] Starting on port ${PORT}`);

// Item Database
const ITEM_DB = {
  coins: { id: 'coins', name: 'Coins', icon: '🪙', buyPrice: 0, sellPrice: 1, stackable: true },
  bones: { id: 'bones', name: 'Bones', icon: '🦴', buyPrice: 10, sellPrice: 5, stackable: false },
  goblin_hide: { id: 'goblin_hide', name: 'Goblin Hide', icon: '📜', buyPrice: 25, sellPrice: 12, stackable: false },
  bread: { id: 'bread', name: 'Bread', icon: '🍞', buyPrice: 12, sellPrice: 6, stackable: false },
  iron_sword: { id: 'iron_sword', name: 'Iron Sword', icon: '🗡️', buyPrice: 150, sellPrice: 75, stackable: false },
  bronze_helm: { id: 'bronze_helm', name: 'Bronze Helm', icon: '🪖', buyPrice: 80, sellPrice: 40, stackable: false },
  wooden_shield: { id: 'wooden_shield', name: 'Wooden Shield', icon: '🛡️', buyPrice: 110, sellPrice: 55, stackable: false },
  fire_rune: { id: 'fire_rune', name: 'Fire Rune', icon: '🔥', buyPrice: 15, sellPrice: 7, stackable: true }
};

const SHOP_STOCK = [
  ITEM_DB.bread,
  ITEM_DB.iron_sword,
  ITEM_DB.bronze_helm,
  ITEM_DB.wooden_shield,
  ITEM_DB.fire_rune
];

const players = {};
let groundItems = [];

// Shopkeeper Bob is now positioned INSIDE the shop building at (36, 15)
const npcs = [
  { id: 1, name: 'Goblin', x: 18, y: 28, targetX: 18, targetY: 28, hp: 12, maxHp: 12, level: 2, alive: true, respawnTicks: 0, type: 'monster' },
  { id: 2, name: 'Goblin Guard', x: 26, y: 30, targetX: 26, targetY: 30, hp: 20, maxHp: 20, level: 5, alive: true, respawnTicks: 0, type: 'monster' },
  { id: 3, name: 'Shopkeeper Bob', x: 36, y: 15, targetX: 36, targetY: 15, hp: 100, maxHp: 100, level: 15, alive: true, respawnTicks: 0, type: 'shopkeeper' }
];

function broadcast(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(message);
  });
}

function addItemToInventory(player, itemId, count = 1) {
  const itemInfo = ITEM_DB[itemId];
  if (!itemInfo) return false;

  if (itemInfo.stackable) {
    const existing = player.inventory.find(i => i && i.id === itemId);
    if (existing) {
      existing.count += count;
      return true;
    }
  }

  const emptyIndex = player.inventory.findIndex(slot => slot === null);
  if (emptyIndex !== -1) {
    player.inventory[emptyIndex] = { ...itemInfo, count };
    return true;
  }
  return false;
}

// Building collision check: Walls from x:32 to x:40, y:12 to y:18 (Doorway at x:36, y:18)
function isWallTile(x, y) {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx >= 32 && tx <= 40 && ty >= 12 && ty <= 18) {
    // Outer perimeter walls
    if (tx === 32 || tx === 40 || ty === 12 || ty === 18) {
      // Allow entrance through the doorway at x:36, y:18
      if (tx === 36 && ty === 18) return false;
      return true;
    }
  }
  return false;
}

wss.on('connection', (ws) => {
  const playerId = 'player_' + Math.random().toString(36).substring(2, 9);
  
  const initialInv = Array(28).fill(null);
  initialInv[0] = { ...ITEM_DB.coins, count: 100 };
  initialInv[1] = { ...ITEM_DB.bread, count: 2 };

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
    inventory: initialInv,
    action: null,
    facing: 'down',
    isAttacking: false
  };

  ws.send(JSON.stringify({ type: 'INIT', id: playerId, players, npcs, groundItems, shopStock: SHOP_STOCK }));
  broadcast({ type: 'PLAYER_JOINED', player: players[playerId] });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      const p = players[playerId];
      if (!p) return;

      if (data.type === 'MOVE') {
        if (!isWallTile(data.x, data.y)) {
          p.targetX = data.x;
          p.targetY = data.y;
        } else {
          ws.send(JSON.stringify({ type: 'SERVER_MSG', text: 'A solid stone wall blocks your path!' }));
        }
        p.action = null;
      } else if (data.type === 'ATTACK') {
        p.action = { type: 'ATTACK', targetId: data.targetId };
      } else if (data.type === 'PICKUP') {
        const itemIdx = groundItems.findIndex(g => g.id === data.itemId);
        if (itemIdx !== -1) {
          const item = groundItems[itemIdx];
          const dist = Math.hypot(p.x - item.x, p.y - item.y);
          if (dist <= 1.5) {
            if (addItemToInventory(p, item.itemId, item.count)) {
              groundItems.splice(itemIdx, 1);
              broadcast({ type: 'GROUND_UPDATE', groundItems });
            } else {
              ws.send(JSON.stringify({ type: 'SERVER_MSG', text: 'Inventory is full!' }));
            }
          }
        }
      } else if (data.type === 'SELL_ITEM') {
        const slotItem = p.inventory[data.slotIndex];
        if (slotItem && slotItem.id !== 'coins') {
          const goldAmount = slotItem.sellPrice * (slotItem.count || 1);
          p.inventory[data.slotIndex] = null;
          addItemToInventory(p, 'coins', goldAmount);
          broadcast({ type: 'HITSPLAT', text: `+${goldAmount}g`, x: Math.round(p.x), y: Math.round(p.y), color: '#ffff00' });
        }
      } else if (data.type === 'BUY_ITEM') {
        const buyItem = ITEM_DB[data.itemId];
        if (buyItem) {
          const coinSlot = p.inventory.find(i => i && i.id === 'coins');
          if (coinSlot && coinSlot.count >= buyItem.buyPrice) {
            if (addItemToInventory(p, data.itemId, 1)) {
              coinSlot.count -= buyItem.buyPrice;
              if (coinSlot.count <= 0) {
                const coinIndex = p.inventory.findIndex(i => i && i.id === 'coins');
                if (coinIndex !== -1) p.inventory[coinIndex] = null;
              }
              broadcast({ type: 'HITSPLAT', text: `-${buyItem.buyPrice}g`, x: Math.round(p.x), y: Math.round(p.y), color: '#ffaaaa' });
            } else {
              ws.send(JSON.stringify({ type: 'SERVER_MSG', text: 'Inventory is full!' }));
            }
          } else {
            ws.send(JSON.stringify({ type: 'SERVER_MSG', text: 'Not enough coins!' }));
          }
        }
      } else if (data.type === 'CHAT') {
        broadcast({ type: 'CHAT_MSG', sender: p.name, text: data.text });
      }
    } catch (err) {}
  });

  ws.on('close', () => {
    delete players[playerId];
    broadcast({ type: 'PLAYER_LEFT', id: playerId });
  });
});

// 20-Tick Movement Loop
setInterval(() => {
  const moveSpeed = 0.15;
  Object.values(players).forEach((p) => {
    if (Math.round(p.x) !== p.targetX || Math.round(p.y) !== p.targetY) {
      let nextX = p.x;
      let nextY = p.y;
      if (p.x < p.targetX) nextX = Math.min(p.targetX, p.x + moveSpeed);
      else if (p.x > p.targetX) nextX = Math.max(p.targetX, p.x - moveSpeed);
      if (p.y < p.targetY) nextY = Math.min(p.targetY, p.y + moveSpeed);
      else if (p.y > p.targetY) nextY = Math.max(p.targetY, p.y - moveSpeed);

      if (!isWallTile(nextX, nextY)) {
        p.x = nextX;
        p.y = nextY;
      } else {
        p.targetX = Math.round(p.x);
        p.targetY = Math.round(p.y);
      }
    }
  });

  npcs.forEach(npc => {
    if (!npc.alive || npc.type === 'shopkeeper') return;
    if (Math.round(npc.x) !== npc.targetX || Math.round(npc.y) !== npc.targetY) {
      if (npc.x < npc.targetX) npc.x = Math.min(npc.targetX, npc.x + moveSpeed);
      else if (npc.x > npc.targetX) npc.x = Math.max(npc.targetX, npc.x - moveSpeed);
      if (npc.y < npc.targetY) npc.y = Math.min(npc.targetY, npc.y + moveSpeed);
      else if (npc.y > npc.targetY) npc.y = Math.max(npc.targetY, npc.y - moveSpeed);
    } else if (Math.random() < 0.02) {
      const rx = Math.max(10, Math.min(30, npc.x + (Math.floor(Math.random() * 5) - 2)));
      const ry = Math.max(10, Math.min(40, npc.y + (Math.floor(Math.random() * 5) - 2)));
      if (!isWallTile(rx, ry)) {
        npc.targetX = rx;
        npc.targetY = ry;
      }
    }
  });

  broadcast({ type: 'TICK_UPDATE', players, npcs, groundItems });
}, 50);

// Combat Loop
setInterval(() => {
  Object.values(players).forEach((p) => {
    if (p.action && p.action.type === 'ATTACK') {
      const npc = npcs.find((n) => n.id === p.action.targetId);
      if (npc && npc.alive && npc.type === 'monster') {
        const dist = Math.hypot(p.x - npc.x, p.y - npc.y);
        if (dist <= 1.5) {
          const hit = Math.floor(Math.random() * 5);
          npc.hp = Math.max(0, npc.hp - hit);
          p.isAttacking = true;

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
            npc.respawnTicks = 12;
            p.action = null;

            const drops = ['bones'];
            if (Math.random() < 0.7) drops.push('coins');
            if (Math.random() < 0.3) drops.push('goblin_hide');
            if (Math.random() < 0.1) drops.push('fire_rune');

            drops.forEach(dropId => {
              const count = dropId === 'coins' ? Math.floor(Math.random() * 20) + 5 : 1;
              groundItems.push({
                id: 'item_' + Math.random().toString(36).substring(2, 9),
                itemId: dropId,
                name: ITEM_DB[dropId].name,
                icon: ITEM_DB[dropId].icon,
                count: count,
                x: Math.round(npc.x),
                y: Math.round(npc.y)
              });
            });

            broadcast({ type: 'GROUND_UPDATE', groundItems });
          }
        } else {
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

  npcs.forEach((npc) => {
    if (!npc.alive) {
      npc.respawnTicks--;
      if (
