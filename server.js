const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const SAVE_FILE = path.join(__dirname, 'players.json');

// World coordinates:
// North is UP, so northern locations have negative Y.
const WORLD = {
  minX: 0,
  maxX: 89,
  minY: -45,
  maxY: 89,
  wildernessBoundaryY: 0
};

const SPAWN = { x: 22, y: 22 };

const ENEMY_ATTACK_INTERVAL_MS = 1200;
const ENEMY_MELEE_RANGE = 1.5;
const RESPAWN_PROTECTION_MS = 3000;

let savedAccounts = {};

if (fs.existsSync(SAVE_FILE)) {
  try {
    savedAccounts = JSON.parse(
      fs.readFileSync(SAVE_FILE, 'utf8')
    );

    console.log('[RuneServer] Loaded saved accounts.');
  } catch (err) {
    console.error('[RuneServer] Error loading accounts:', err);
  }
}

function saveAccountsToDisk() {
  try {
    fs.writeFileSync(
      SAVE_FILE,
      JSON.stringify(savedAccounts, null, 2),
      'utf8'
    );
  } catch (err) {
    console.error('[RuneServer] Error saving accounts:', err);
  }
}

const server = http.createServer((req, res) => {
  fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Error: index.html not found on server.');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(content, 'utf-8');
  });
});

const wss = new WebSocketServer({ server });

const ITEM_DB = {
  coins: {
    id: 'coins', name: 'Coins', icon: '🪙',
    buyPrice: 0, sellPrice: 1,
    stackable: true, slot: null
  },
  bones: {
    id: 'bones', name: 'Bones', icon: '🦴',
    buyPrice: 10, sellPrice: 5,
    stackable: false, slot: null
  },
  goblin_hide: {
    id: 'goblin_hide', name: 'Goblin Hide', icon: '📜',
    buyPrice: 25, sellPrice: 12,
    stackable: false, slot: null
  },
  bread: {
    id: 'bread', name: 'Bread', icon: '🍞',
    buyPrice: 12, sellPrice: 6,
    stackable: false, slot: null
  },
  iron_sword: {
    id: 'iron_sword', name: 'Iron Sword', icon: '🗡️',
    buyPrice: 150, sellPrice: 75,
    stackable: false, slot: 'weapon'
  },
  bronze_helm: {
    id: 'bronze_helm', name: 'Bronze Helm', icon: '🪖',
    buyPrice: 80, sellPrice: 40,
    stackable: false, slot: 'head'
  },
  wooden_shield: {
    id: 'wooden_shield', name: 'Wooden Shield', icon: '🛡️',
    buyPrice: 110, sellPrice: 55,
    stackable: false, slot: 'shield'
  },
  fire_rune: {
    id: 'fire_rune', name: 'Fire Rune', icon: '🔥',
    buyPrice: 15, sellPrice: 7,
    stackable: true, slot: null
  },
  rune_scimitar: {
    id: 'rune_scimitar', name: 'Rune Scimitar', icon: '✨',
    buyPrice: 1500, sellPrice: 750,
    stackable: false, slot: 'weapon'
  }
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
const respawnProtectionUntil = new Map();
let groundItems = [];

function makeNpc(id, name, x, y, hp, level, type, region) {
  return {
    id,
    name,
    x,
    y,
    targetX: x,
    targetY: y,
    spawnX: x,
    spawnY: y,
    hp,
    maxHp: hp,
    level,
    alive: true,
    respawnTicks: 0,
    type,
    region
  };
}

const npcs = [
  makeNpc(
    1, 'Goblin',
    18, 28, 12, 2,
    'monster', 'town'
  ),
  makeNpc(
    2, 'Goblin Guard',
    26, 30, 20, 5,
    'monster', 'town'
  ),
  makeNpc(
    3, 'Shopkeeper Bob',
    36, 15, 100, 15,
    'shopkeeper', 'town'
  ),

  // These enemies now spawn NORTH of town.
  makeNpc(
    4, 'Hobgoblin Brute',
    25, -20, 45, 10,
    'monster', 'wilderness'
  ),
  makeNpc(
    5, 'Moss Giant',
    35, -28, 60, 12,
    'monster', 'wilderness'
  ),
  makeNpc(
    6, 'Dark Warrior',
    15, -35, 50, 10,
    'monster', 'wilderness'
  )
];

function broadcast(data) {
  const message = JSON.stringify(data);

  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

function broadcastWorld() {
  broadcast({
    type: 'TICK_UPDATE',
    players,
    npcs,
    groundItems
  });
}

function rememberPlayer(player) {
  if (player.ip) {
    savedAccounts[player.ip] = player;
  }
}

function addItemToInventory(player, itemId, count = 1) {
  const info = ITEM_DB[itemId];

  if (!info) return false;

  if (info.stackable) {
    const existing = player.inventory.find(
      item => item && item.id === itemId
    );

    if (existing) {
      existing.count += count;
      return true;
    }
  }

  const empty = player.inventory.findIndex(
    item => item === null
  );

  if (empty === -1) return false;

  player.inventory[empty] = { ...info, count };
  return true;
}

function isWallTile(x, y) {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < WORLD.minX ||
    x > WORLD.maxX ||
    y < WORLD.minY ||
    y > WORLD.maxY
  ) {
    return true;
  }

  const tx = Math.floor(x);
  const ty = Math.floor(y);

  if (tx >= 32 && tx <= 40 && ty >= 12 && ty <= 18) {
    const wall =
      tx === 32 ||
      tx === 40 ||
      ty === 12 ||
      ty === 18;

    if (wall) {
      return !(tx === 36 && ty === 18);
    }
  }

  return false;
}

function respawnPlayer(player) {
  player.hp = player.maxHp;
  player.x = SPAWN.x;
  player.y = SPAWN.y;
  player.targetX = SPAWN.x;
  player.targetY = SPAWN.y;
  player.action = null;
  player.isAttacking = false;

  respawnProtectionUntil.set(
    player.id,
    Date.now() + RESPAWN_PROTECTION_MS
  );

  rememberPlayer(player);

  broadcast({
    type: 'HITSPLAT',
    text: 'RESPAWNED',
    x: SPAWN.x,
    y: SPAWN.y,
    color: '#ffdd77'
  });
}

wss.on('connection', (ws, req) => {
  const forwarded = req.headers['x-forwarded-for'];
  const clientIp =
    (typeof forwarded === 'string' && forwarded) ||
    req.socket.remoteAddress ||
    'unknown_ip';

  const cleanIp = clientIp.split(',')[0].trim();

  const playerId =
    'player_' + Math.random().toString(36).substring(2, 9);

  let playerData;
  let positionReset = false;

  if (savedAccounts[cleanIp]) {
    playerData = savedAccounts[cleanIp];
    playerData.id = playerId;
    playerData.ip = cleanIp;
    playerData.action = null;
    playerData.isAttacking = false;

    // Move saves from the old southern wilderness back to town.
    // Also recover positions outside the new world boundary.
    if (
      playerData.y > 45 ||
      isWallTile(playerData.x, playerData.y)
    ) {
      playerData.x = SPAWN.x;
      playerData.y = SPAWN.y;
      positionReset = true;
    }

    if (playerData.hp <= 0) {
      playerData.hp = playerData.maxHp;
      playerData.x = SPAWN.x;
      playerData.y = SPAWN.y;
      positionReset = true;
    }

    playerData.targetX = Math.round(playerData.x);
    playerData.targetY = Math.round(playerData.y);
  } else {
    const inventory = Array(28).fill(null);

    inventory[0] = { ...ITEM_DB.coins, count: 100 };
    inventory[1] = { ...ITEM_DB.bread, count: 2 };

    playerData = {
      id: playerId,
      ip: cleanIp,
      name: `Hero_${playerId.substring(7)}`,
      x: SPAWN.x,
      y: SPAWN.y,
      targetX: SPAWN.x,
      targetY: SPAWN.y,
      hp: 20,
      maxHp: 20,
      combatLvl: 3,
      xp: 0,
      statPoints: 0,
      stats: {
        attack: 1,
        strength: 1,
        defense: 1,
        ranged: 1,
        magic: 1,
        hitpoints: 10
      },
      equipment: {
        head: null,
        weapon: null,
        shield: null
      },
      inventory,
      action: null,
      isAttacking: false
    };
  }

  players[playerId] = playerData;
  rememberPlayer(playerData);
  saveAccountsToDisk();

  ws.send(JSON.stringify({
    type: 'INIT',
    id: playerId,
    players,
    npcs,
    groundItems,
    shopStock: SHOP_STOCK,
    world: WORLD
  }));

  if (positionReset) {
    ws.send(JSON.stringify({
      type: 'SERVER_MSG',
      text: 'Your position was reset to town. The wilderness is now north of town.'
    }));
  }

  broadcast({
    type: 'PLAYER_JOINED',
    player: playerData
  });

  ws.on('message', message => {
    try {
      const data = JSON.parse(message);
      const p = players[playerId];

      if (!p || !data || typeof data !== 'object') return;

      if (data.type === 'MOVE') {
        if (
          Number.isInteger(data.x) &&
          Number.isInteger(data.y) &&
          !isWallTile(data.x, data.y)
        ) {
          p.targetX = data.x;
          p.targetY = data.y;
        }

        p.action = null;
        p.isAttacking = false;
      } else if (data.type === 'ATTACK') {
        const npc = npcs.find(
          enemy => enemy.id === data.targetId
        );

        if (npc && npc.alive && npc.type === 'monster') {
          p.action = {
            type: 'ATTACK',
            targetId: npc.id
          };
        }
      } else if (data.type === 'SET_NAME') {
        if (
          typeof data.name === 'string' &&
          data.name.trim()
        ) {
          p.name = data.name.trim().substring(0, 12);
          rememberPlayer(p);
          saveAccountsToDisk();
          broadcastWorld();
        }
      } else if (data.type === 'UPGRADE_STAT') {
        if (
          p.statPoints > 0 &&
          Object.prototype.hasOwnProperty.call(
            p.stats,
            data.stat
          )
        ) {
          p.statPoints--;
          p.stats[data.stat]++;

          if (data.stat === 'hitpoints') {
            p.maxHp += 2;
            p.hp = p.maxHp;
          }

          rememberPlayer(p);
          saveAccountsToDisk();
          broadcastWorld();
        }
      } else if (data.type === 'EQUIP_ITEM') {
        const index = data.slotIndex;

        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= p.inventory.length
        ) return;

        const item = p.inventory[index];

        if (
          item &&
          item.slot &&
          Object.prototype.hasOwnProperty.call(
            p.equipment,
            item.slot
          )
        ) {
          const old = p.equipment[item.slot];

          p.equipment[item.slot] = item;
          p.inventory[index] = old;

          rememberPlayer(p);
          saveAccountsToDisk();
          broadcastWorld();
        }
      } else if (data.type === 'UNEQUIP_ITEM') {
        if (
          !Object.prototype.hasOwnProperty.call(
            p.equipment,
            data.slotName
          )
        ) return;

        const item = p.equipment[data.slotName];

        if (item) {
          if (addItemToInventory(p, item.id, item.count || 1)) {
            p.equipment[data.slotName] = null;
            rememberPlayer(p);
            saveAccountsToDisk();
            broadcastWorld();
          } else {
            ws.send(JSON.stringify({
              type: 'SERVER_MSG',
              text: 'Inventory is full!'
            }));
          }
        }
      } else if (data.type === 'PICKUP') {
        const index = groundItems.findIndex(
          item => item.id === data.itemId
        );

        if (index !== -1) {
          const item = groundItems[index];

          if (
            Math.hypot(p.x - item.x, p.y - item.y) <= 1.5
          ) {
            if (addItemToInventory(p, item.itemId, item.count)) {
              groundItems.splice(index, 1);

              rememberPlayer(p);
              saveAccountsToDisk();

              broadcast({
                type: 'GROUND_UPDATE',
                groundItems
              });
            } else {
              ws.send(JSON.stringify({
                type: 'SERVER_MSG',
                text: 'Inventory is full!'
              }));
            }
          }
        }
      } else if (data.type === 'SELL_ITEM') {
        const index = data.slotIndex;

        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= p.inventory.length
        ) return;

        const item = p.inventory
