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
const EAT_COOLDOWN_MS = 1800;

// Server tick rate: how many times per second the world updates
// and sends positions to players.
const TICK_RATE = 100;
const TICK_MS = 1000 / TICK_RATE;

// Speeds are per second, so changing TICK_RATE keeps gameplay the same.
const MOVE_SPEED_TILES_PER_SEC = 3;
const NPC_WANDER_CHANCE_PER_SEC = 0.4;

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
    stackable: false, slot: null, heal: 6
  },
  cooked_meat: {
    id: 'cooked_meat', name: 'Cooked Meat', icon: '🍖',
    buyPrice: 30, sellPrice: 12,
    stackable: false, slot: null, heal: 12
  },
  health_potion: {
    id: 'health_potion', name: 'Health Potion', icon: '🧪',
    buyPrice: 90, sellPrice: 40,
    stackable: false, slot: null, heal: 25
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
  ITEM_DB.cooked_meat,
  ITEM_DB.health_potion,
  ITEM_DB.iron_sword,
  ITEM_DB.bronze_helm,
  ITEM_DB.wooden_shield,
  ITEM_DB.fire_rune,
  ITEM_DB.rune_scimitar
];

const players = {};
const respawnProtectionUntil = new Map();
const lastAteAt = new Map();
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

// Saved items are copies, so refresh their stats from ITEM_DB.
// This gives old saved bread its new healing value.
function refreshItem(item) {
  if (!item || !ITEM_DB[item.id]) return item;
  return { ...ITEM_DB[item.id], count: item.count || 1 };
}

function refreshSavedItems(player) {
  if (Array.isArray(player.inventory)) {
    player.inventory = player.inventory.map(refreshItem);
  }

  if (player.equipment) {
    for (const slot of Object.keys(player.equipment)) {
      player.equipment[slot] = refreshItem(player.equipment[slot]);
    }
  }
}

function sendTo(ws, text) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'SERVER_MSG', text }));
  }
}

function eatItem(ws, p, index) {
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= p.inventory.length
  ) return;

  const item = p.inventory[index];
  const heal = item && ITEM_DB[item.id] && ITEM_DB[item.id].heal;

  if (!heal) return;

  if (p.hp >= p.maxHp) {
    sendTo(ws, 'You are already at full health.');
    return;
  }

  const now = Date.now();

  if (now - (lastAteAt.get(p.id) || 0) < EAT_COOLDOWN_MS) {
    sendTo(ws, 'You are still eating...');
    return;
  }

  lastAteAt.set(p.id, now);

  const healed = Math.min(heal, p.maxHp - p.hp);
  p.hp += healed;

  item.count = (item.count || 1) - 1;
  if (item.count <= 0) p.inventory[index] = null;

  sendTo(
    ws,
    `You ${item.id === 'health_potion' ? 'drink' : 'eat'} the ` +
    `${item.name} and heal ${healed} HP.`
  );

  broadcast({
    type: 'HITSPLAT',
    text: `+${healed}`,
    x: Math.round(p.x),
    y: Math.round(p.y),
    color: '#55ee77'
  });

  rememberPlayer(p);
  saveAccountsToDisk();
  broadcastWorld();
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

    refreshSavedItems(playerData);
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
      } else if (data.type === 'EAT_ITEM') {
        eatItem(ws, p, data.slotIndex);
      } else if (data.type === 'SELL_ITEM') {
        const index = data.slotIndex;

        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= p.inventory.length
        ) return;

        const item = p.inventory[index];

        if (item && item.id !== 'coins') {
          const gold = item.sellPrice * (item.count || 1);

          p.inventory[index] = null;
          addItemToInventory(p, 'coins', gold);

          rememberPlayer(p);
          saveAccountsToDisk();
        }
      } else if (data.type === 'BUY_ITEM') {
        const item = SHOP_STOCK.find(
          stock => stock.id === data.itemId
        );

        if (!item) return;

        const coins = p.inventory.find(
          slot => slot && slot.id === 'coins'
        );

        if (
          coins &&
          coins.count >= item.buyPrice &&
          addItemToInventory(p, item.id, 1)
        ) {
          coins.count -= item.buyPrice;

          if (coins.count <= 0) {
            const index = p.inventory.indexOf(coins);
            if (index !== -1) p.inventory[index] = null;
          }

          rememberPlayer(p);
          saveAccountsToDisk();
        }
      } else if (data.type === 'CHAT') {
        if (typeof data.text === 'string' && data.text.trim()) {
          broadcast({
            type: 'CHAT_MSG',
            sender: p.name,
            text: data.text.trim().substring(0, 250)
          });
        }
      }
    } catch (err) {
      // Ignore malformed messages.
    }
  });

  ws.on('close', () => {
    if (players[playerId]) {
      rememberPlayer(players[playerId]);
      saveAccountsToDisk();
    }

    respawnProtectionUntil.delete(playerId);
    lastAteAt.delete(playerId);
    delete players[playerId];

    broadcast({
      type: 'PLAYER_LEFT',
      id: playerId
    });
  });
});

// Move an entity toward its destination.
// Exact comparisons allow it to finish moving to the target.
function moveEntity(entity, speed) {
  if (
    entity.x === entity.targetX &&
    entity.y === entity.targetY
  ) return;

  const dx = entity.targetX - entity.x;
  const dy = entity.targetY - entity.y;

  const nextX =
    entity.x + Math.sign(dx) * Math.min(Math.abs(dx), speed);

  const nextY =
    entity.y + Math.sign(dy) * Math.min(Math.abs(dy), speed);

  if (!isWallTile(nextX, nextY)) {
    entity.x = nextX;
    entity.y = nextY;
  } else {
    entity.targetX = entity.x;
    entity.targetY = entity.y;
  }
}

// Movement and world updates.
setInterval(() => {
  const speed = MOVE_SPEED_TILES_PER_SEC / TICK_RATE;

  Object.values(players).forEach(player => {
    moveEntity(player, speed);
  });

  npcs.forEach(npc => {
    if (!npc.alive || npc.type === 'shopkeeper') return;

    if (
      npc.x !== npc.targetX ||
      npc.y !== npc.targetY
    ) {
      moveEntity(npc, speed);
      return;
    }

    if (Math.random() >= NPC_WANDER_CHANCE_PER_SEC / TICK_RATE) return;

    const wilderness = npc.region === 'wilderness';

    // Keep each enemy close to its spawn point.
    const minX = Math.max(5, npc.spawnX - 4);
    const maxX = Math.min(45, npc.spawnX + 4);

    const minY = Math.max(
      wilderness ? -40 : 5,
      npc.spawnY - 4
    );

    const maxY = Math.min(
      wilderness ? -5 : 40,
      npc.spawnY + 4
    );

    const x = Math.max(
      minX,
      Math.min(
        maxX,
        Math.round(npc.x) + Math.floor(Math.random() * 5) - 2
      )
    );

    const y = Math.max(
      minY,
      Math.min(
        maxY,
        Math.round(npc.y) + Math.floor(Math.random() * 5) - 2
      )
    );

    if (!isWallTile(x, y)) {
      npc.targetX = x;
      npc.targetY = y;
    }
  });

  broadcastWorld();
}, TICK_MS);

// Player attacks and monster respawning.
setInterval(() => {
  let accountsChanged = false;

  Object.values(players).forEach(p => {
    p.isAttacking = false;

    if (!p.action || p.action.type !== 'ATTACK') return;

    const npc = npcs.find(
      enemy => enemy.id === p.action.targetId
    );

    if (!npc || !npc.alive || npc.type !== 'monster') {
      p.action = null;
      return;
    }

    if (
      Math.hypot(p.x - npc.x, p.y - npc.y) >
      ENEMY_MELEE_RANGE
    ) {
      p.targetX = Math.round(npc.x);
      p.targetY = Math.round(npc.y);
      return;
    }

    const hit =
      Math.floor(Math.random() * 5) +
      Math.floor(p.stats.strength / 3);

    npc.hp = Math.max(0, npc.hp - hit);
    p.isAttacking = true;
    p.xp += Math.max(10, hit * 4);

    if (p.xp >= p.combatLvl * 50) {
      p.combatLvl++;
      p.statPoints += 3;

      broadcast({
        type: 'HITSPLAT',
        text: 'LEVEL UP!',
        x: Math.round(p.x),
        y: Math.round(p.y),
        color: '#ffff00'
      });
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
      npc.respawnTicks = 15;
      p.action = null;
      p.isAttacking = false;

      const drops = ['bones'];

      if (Math.random() < 0.7) drops.push('coins');

      // Food drops let players keep fighting longer.
      if (Math.random() < (npc.level >= 10 ? 0.35 : 0.2)) {
        drops.push('cooked_meat');
      }

      if (npc.level >= 10 && Math.random() < 0.15) {
        drops.push('rune_scimitar');
      } else if (Math.random() < 0.3) {
        drops.push('goblin_hide');
      }

      drops.forEach(itemId => {
        groundItems.push({
          id: 'item_' + Math.random().toString(36).substring(2, 9),
          itemId,
          name: ITEM_DB[itemId].name,
          icon: ITEM_DB[itemId].icon,
          count: itemId === 'coins' ? 50 : 1,
          x: Math.round(npc.x),
          y: Math.round(npc.y)
        });
      });

      broadcast({
        type: 'GROUND_UPDATE',
        groundItems
      });
    }

    rememberPlayer(p);
    accountsChanged = true;
  });

  npcs.forEach(npc => {
    if (!npc.alive && --npc.respawnTicks <= 0) {
      npc.alive = true;
      npc.hp = npc.maxHp;
      npc.x = npc.spawnX;
      npc.y = npc.spawnY;
      npc.targetX = npc.spawnX;
      npc.targetY = npc.spawnY;
    }
  });

  if (accountsChanged) saveAccountsToDisk();
}, 600);

// Enemy retaliation.
setInterval(() => {
  const now = Date.now();
  let accountsChanged = false;

  npcs.forEach(npc => {
    if (!npc.alive || npc.type !== 'monster') return;

    const target = Object.values(players)
      .filter(p => {
        return (
          p.hp > 0 &&
          p.action &&
          p.action.type === 'ATTACK' &&
          p.action.targetId === npc.id &&
          now >= (respawnProtectionUntil.get(p.id) || 0) &&
          Math.hypot(p.x - npc.x, p.y - npc.y) <=
            ENEMY_MELEE_RANGE
        );
      })
      .sort((a, b) => {
        return (
          Math.hypot(a.x - npc.x, a.y - npc.y) -
          Math.hypot(b.x - npc.x, b.y - npc.y)
        );
      })[0];

    if (!target) return;

    const maxHit = Math.max(
      2,
      Math.ceil(npc.level / 2) + 1
    );

    const defense = Math.max(
      1,
      Number(target.stats?.defense) || 1
    );

    let armorBonus = 0;

    if (target.equipment?.head?.id === 'bronze_helm') {
      armorBonus += 2;
    }

    if (target.equipment?.shield?.id === 'wooden_shield') {
      armorBonus += 3;
    }

    const hitChance = Math.max(
      0.35,
      Math.min(
        0.9,
        0.8 +
          npc.level * 0.01 -
          defense * 0.015 -
          armorBonus * 0.025
      )
    );

    let damage = 0;

    if (Math.random() < hitChance) {
      damage = 1 + Math.floor(Math.random() * maxHit);
    }

    damage = Math.min(target.hp, damage);
    target.hp = Math.max(0, target.hp - damage);

    broadcast({
      type: 'HITSPLAT',
      text: damage > 0 ? `-${damage}` : 'BLOCK',
      x: Math.round(target.x),
      y: Math.round(target.y),
      color: damage > 0 ? '#ff5555' : '#99bbdd'
    });

    if (target.hp <= 0) {
      // No loss of inventory, equipment, coins, or XP.
      respawnPlayer(target);
    }

    if (damage > 0) {
      rememberPlayer(target);
      accountsChanged = true;
    }
  });

  if (accountsChanged) saveAccountsToDisk();

  broadcastWorld();
}, ENEMY_ATTACK_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`[RuneServer] Listening on port ${PORT}`);
  console.log('[RuneServer] Northern wilderness: Y -45 through -1.');
  console.log(`[RuneServer] Tick rate: ${TICK_RATE} ticks/sec.`);
});
