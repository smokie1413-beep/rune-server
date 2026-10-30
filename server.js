const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const SAVE_FILE = path.join(__dirname, 'players.json');

let savedAccounts = {};
if (fs.existsSync(SAVE_FILE)) {
  try {
    savedAccounts = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
    console.log('[RuneServer] Loaded saved player accounts from disk.');
  } catch (err) {
    console.error('[RuneServer] Error parsing players.json:', err);
  }
}

function saveAccountsToDisk() {
  try {
    fs.writeFileSync(SAVE_FILE, JSON.stringify(savedAccounts, null, 2), 'utf8');
  } catch (err) {
    console.error('[RuneServer] Error saving accounts:', err);
  }
}

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

const ITEM_DB = {
  coins: { id: 'coins', name: 'Coins', icon: '🪙', buyPrice: 0, sellPrice: 1, stackable: true, slot: null },
  bones: { id: 'bones', name: 'Bones', icon: '🦴', buyPrice: 10, sellPrice: 5, stackable: false, slot: null },
  goblin_hide: { id: 'goblin_hide', name: 'Goblin Hide', icon: '📜', buyPrice: 25, sellPrice: 12, stackable: false, slot: null },
  bread: { id: 'bread', name: 'Bread', icon: '🍞', buyPrice: 12, sellPrice: 6, stackable: false, slot: null },
  iron_sword: { id: 'iron_sword', name: 'Iron Sword', icon: '🗡️', buyPrice: 150, sellPrice: 75, stackable: false, slot: 'weapon' },
  bronze_helm: { id: 'bronze_helm', name: 'Bronze Helm', icon: '🪖', buyPrice: 80, sellPrice: 40, stackable: false, slot: 'head' },
  wooden_shield: { id: 'wooden_shield', name: 'Wooden Shield', icon: '🛡️', buyPrice: 110, sellPrice: 55, stackable: false, slot: 'shield' },
  fire_rune: { id: 'fire_rune', name: 'Fire Rune', icon: '🔥', buyPrice: 15, sellPrice: 7, stackable: true, slot: null },
  rune_scimitar: { id: 'rune_scimitar', name: 'Rune Scimitar', icon: '✨', buyPrice: 1500, sellPrice: 750, stackable: false, slot: 'weapon' }
};

const SHOP_STOCK = [
  ITEM_DB.bread,
  ITEM_DB.iron_sword,
  ITEM_DB.bronze_helm,
  ITEM_DB.wooden_shield,
  ITEM_DB.fire_rune,
  ITEM_DB.rune_scimitar
];

const players = {};
let groundItems = [];

// Expanded NPCs list including Level 10 Enemies in the North Wilderness Zone (y: 50 to 90)
const npcs = [
  { id: 1, name: 'Goblin', x: 18, y: 28, targetX: 18, targetY: 28, hp: 12, maxHp: 12, level: 2, alive: true, respawnTicks: 0, type: 'monster' },
  { id: 2, name: 'Goblin Guard', x: 26, y: 30, targetX: 26, targetY: 30, hp: 20, maxHp: 20, level: 5, alive: true, respawnTicks: 0, type: 'monster' },
  { id: 3, name: 'Shopkeeper Bob', x: 36, y: 15, targetX: 36, targetY: 15, hp: 100, maxHp: 100, level: 15, alive: true, respawnTicks: 0, type: 'shopkeeper' },
  
  // Level 10 Wilderness Enemies (North Connecting Map)
  { id: 4, name: 'Hobgoblin Brute', x: 25, y: 70, targetX: 25, targetY: 70, hp: 45, maxHp: 45, level: 10, alive: true, respawnTicks: 0, type: 'monster' },
  { id: 5, name: 'Moss Giant', x: 35, y: 75, targetX: 35, targetY: 75, hp: 60, maxHp: 60, level: 12, alive: true, respawnTicks: 0, type: 'monster' },
  { id: 6, name: 'Dark Warrior', x: 15, y: 80, targetX: 15, targetY: 80, hp: 50, maxHp: 50, level: 10, alive: true, respawnTicks: 0, type: 'monster' }
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
    if (existing) { existing.count += count; return true; }
  }
  const emptyIndex = player.inventory.findIndex(slot => slot === null);
  if (emptyIndex !== -1) {
    player.inventory[emptyIndex] = { ...itemInfo, count };
    return true;
  }
  return false;
}

// Collision Map: Town shop building walls + wilderness boundaries
function isWallTile(x, y) {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  // Shop Building
  if (tx >= 32 && tx <= 40 && ty >= 12 && ty <= 18) {
    if (tx === 32 || tx === 40 || ty === 12 || ty === 18) {
      if (tx === 36 && ty === 18) return false; // Doorway
      return true;
    }
  }
  return false;
}

wss.on('connection', (ws, req) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown_ip';
  const cleanIp = clientIp.split(',')[0].trim();
  const playerId = 'player_' + Math.random().toString(36).substring(2, 9);

  let playerData;
  if (savedAccounts[cleanIp]) {
    playerData = savedAccounts[cleanIp];
    playerData.id = playerId;
    playerData.targetX = Math.round(playerData.x);
    playerData.targetY = Math.round(playerData.y);
  } else {
    const initialInv = Array(28).fill(null);
    initialInv[0] = { ...ITEM_DB.coins, count: 100 };
    initialInv[1] = { ...ITEM_DB.bread, count: 2 };

    playerData = {
      id: playerId,
      ip: cleanIp,
      name: `Hero_${playerId.substring(7)}`,
      x: 22.0,
      y: 22.0,
      targetX: 22,
      targetY: 22,
      hp: 20,
      maxHp: 20,
      combatLvl: 3,
      xp: 0,
      statPoints: 0,
      stats: { attack: 1, strength: 1, defense: 1, ranged: 1, magic: 1, hitpoints: 10 },
      equipment: { head: null, weapon: null, shield: null },
      inventory: initialInv,
      action: null,
      isAttacking: false
    };
    savedAccounts[cleanIp] = playerData;
    saveAccountsToDisk();
  }

  players[playerId] = playerData;

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
        }
        p.action = null;
      } else if (data.type === 'ATTACK') {
        p.action = { type: 'ATTACK', targetId: data.targetId };
      } else if (data.type === 'SET_NAME') {
        if (typeof data.name === 'string' && data.name.trim().length > 0) {
          p.name = data.name.trim().substring(0, 12);
          savedAccounts[cleanIp] = p;
          saveAccountsToDisk();
          broadcast({ type: 'TICK_UPDATE', players, npcs, groundItems });
        }
      } else if (data.type === 'UPGRADE_STAT') {
        const statName = data.stat;
        if (p.statPoints > 0 && p.stats[statName] !== undefined) {
          p.statPoints--;
          p.stats[statName]++;
          if (statName === 'hitpoints') {
            p.maxHp += 2;
            p.hp = p.maxHp;
          }
          savedAccounts[cleanIp] = p;
          saveAccountsToDisk();
          broadcast({ type: 'TICK_UPDATE', players, npcs, groundItems });
        }
      } else if (data.type === 'EQUIP_ITEM') {
        const slotIdx = data.slotIndex;
        const item = p.inventory[slotIdx];
        if (item && item.slot) {
          const equipSlot = item.slot;
          const currentEquipped = p.equipment[equipSlot];
          p.equipment[equipSlot] = item;
          p.inventory[slotIdx] = currentEquipped;
          savedAccounts[cleanIp] = p;
          saveAccountsToDisk();
          broadcast({ type: 'TICK_UPDATE', players, npcs, groundItems });
        }
      } else if (data.type === 'UNEQUIP_ITEM') {
        const slotName = data.slotName;
        const item = p.equipment[slotName];
        if (item) {
          if (addItemToInventory(p, item.id, item.count || 1)) {
            p.equipment[slotName] = null;
            savedAccounts[cleanIp] = p;
            saveAccountsToDisk();
            broadcast({ type: 'TICK_UPDATE', players, npcs, groundItems });
          } else {
            ws.send(JSON.stringify({ type: 'SERVER_MSG', text: 'Inventory is full!' }));
          }
        }
      } else if (data.type === 'PICKUP') {
        const itemIdx = groundItems.findIndex(g => g.id === data.itemId);
        if (itemIdx !== -1) {
          const item = groundItems[itemIdx];
          if (Math.hypot(p.x - item.x, p.y - item.y) <= 1.5) {
            if (addItemToInventory(p, item.itemId, item.count)) {
              groundItems.splice(itemIdx, 1);
              savedAccounts[cleanIp] = p;
              saveAccountsToDisk();
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
          savedAccounts[cleanIp] = p;
          saveAccountsToDisk();
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
              savedAccounts[cleanIp] = p;
              saveAccountsToDisk();
            }
          }
        }
      } else if (data.type === 'CHAT') {
        broadcast({ type: 'CHAT_MSG', sender: p.name, text: data.text });
      }
    } catch (err) {}
  });

  ws.on('close', () => {
    if (players[playerId]) {
      savedAccounts[cleanIp] = players[playerId];
      saveAccountsToDisk();
    }
    delete players[playerId];
    broadcast({ type: 'PLAYER_LEFT', id: playerId });
  });
});

setInterval(() => {
  const moveSpeed = 0.15;
  Object.values(players).forEach((p) => {
    if (Math.round(p.x) !== p.targetX || Math.round(p.y) !== p.targetY) {
      let nextX = p.x, nextY = p.y;
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
      const rx = Math.max(5, Math.min(45, npc.x + (Math.floor(Math.random() * 5) - 2)));
      const ry = Math.max(5, Math.min(85, npc.y + (Math.floor(Math.random() * 5) - 2)));
      if (!isWallTile(rx, ry)) {
        npc.targetX = rx;
        npc.targetY = ry;
      }
    }
  });

  broadcast({ type: 'TICK_UPDATE', players, npcs, groundItems });
}, 50);

setInterval(() => {
  Object.values(players).forEach((p) => {
    if (p.action && p.action.type === 'ATTACK') {
      const npc = npcs.find((n) => n.id === p.action.targetId);
      if (npc && npc.alive && npc.type === 'monster') {
        if (Math.hypot(p.x - npc.x, p.y - npc.y) <= 1.5) {
          const hit = Math.floor(Math.random() * 5) + Math.floor(p.stats.strength / 3);
          npc.hp = Math.max(0, npc.hp - hit);
          p.isAttacking = true;
          p.xp += Math.max(10, hit * 4);

          if (p.xp >= p.combatLvl * 50) {
            p.combatLvl++;
            p.statPoints += 3;
            broadcast({ type: 'HITSPLAT', text: 'LEVEL UP!', x: Math.round(p.x), y: Math.round(p.y), color: '#ffff00' });
          }

          broadcast({ type: 'HITSPLAT', text: hit === 0 ? '0' : `-${hit}`, x: Math.round(npc.x), y: Math.round(npc.y), color: hit === 0 ? '#888888' : '#ff3333' });

          if (npc.hp <= 0) {
            npc.alive = false;
            npc.respawnTicks = 15;
            p.action = null;

            const drops = ['bones'];
            if (Math.random() < 0.7) drops.push('coins');
            if (npc.level >= 10 && Math.random() < 0.15) drops.push('rune_scimitar');
            else if (Math.random() < 0.3) drops.push('goblin_hide');

            drops.forEach(dropId => {
              groundItems.push({
                id: 'item_' + Math.random().toString(36).substring(2, 9),
                itemId: dropId,
                name: ITEM_DB[dropId].name,
                icon: ITEM_DB[dropId].icon,
                count: dropId === 'coins' ? 50 : 1,
                x: Math.round(npc.x),
                y: Math.round(npc.y)
              });
            });
            broadcast({ type: 'GROUND_UPDATE', groundItems });
          }

          if (p.ip && savedAccounts[p.ip]) {
            savedAccounts[p.ip] = p;
            saveAccountsToDisk();
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
    if (!npc.alive && --npc.respawnTicks <= 0) {
      npc.alive = true;
      npc.hp = npc.maxHp;
    }
  });
}, 600);

server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
