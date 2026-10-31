const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const scryptAsync = promisify(crypto.scrypt);

const PORT = process.env.PORT || 3000;
const SAVE_FILE = path.join(__dirname, 'accounts.json');

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
    throw err;
  }
}

function saveAccountsToDisk() {
  try {
    fs.writeFileSync(SAVE_FILE + '.tmp', JSON.stringify(savedAccounts, null, 2),
      { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(SAVE_FILE + '.tmp', SAVE_FILE);
    return true;
  } catch (err) {
    console.error('[RuneServer] Error saving accounts:', err);
    return false;
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

const wss = new WebSocketServer({ server, maxPayload: 8192 });
let activeAuthJobs = 0;

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
  logs: {
    id: 'logs', name: 'Logs', icon: '🪵',
    buyPrice: 8, sellPrice: 3,
    stackable: true, slot: null
  },
  oak_logs: {
    id: 'oak_logs', name: 'Oak Logs', icon: '🪵',
    buyPrice: 20, sellPrice: 8,
    stackable: true, slot: null
  },
  willow_logs: {
    id: 'willow_logs', name: 'Willow Logs', icon: '🪵',
    buyPrice: 40, sellPrice: 15,
    stackable: true, slot: null
  },
  bronze_axe: {
    id: 'bronze_axe', name: 'Bronze Axe', icon: '🪓',
    buyPrice: 50, sellPrice: 20,
    stackable: false, slot: 'weapon', axeTier: 1
  },
  iron_axe: {
    id: 'iron_axe', name: 'Iron Axe', icon: '🪓',
    buyPrice: 180, sellPrice: 70,
    stackable: false, slot: 'weapon', axeTier: 2
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
  ITEM_DB.bronze_axe,
  ITEM_DB.iron_axe,
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

const TREE_TYPES = {
  normal: {
    name: 'Tree',
    level: 1,
    xp: 25,
    log: 'logs',
    maxHp: 3,
    respawnTicks: 40
  },
  oak: {
    name: 'Oak',
    level: 15,
    xp: 38,
    log: 'oak_logs',
    maxHp: 5,
    respawnTicks: 55
  },
  willow: {
    name: 'Willow',
    level: 30,
    xp: 68,
    log: 'willow_logs',
    maxHp: 7,
    respawnTicks: 70
  }
};

function makeTree(id, x, y, type) {
  const def = TREE_TYPES[type];
  return {
    id,
    x,
    y,
    type,
    name: def.name,
    level: def.level,
    alive: true,
    hp: def.maxHp,
    maxHp: def.maxHp,
    respawnTicks: 0
  };
}

const trees = [
  // === Normal trees (lvl 1) – common around town & grasslands ===
  makeTree(1, 8, 12, 'normal'),
  makeTree(2, 10, 18, 'normal'),
  makeTree(3, 14, 22, 'normal'),
  makeTree(4, 16, 28, 'normal'),
  makeTree(5, 20, 14, 'normal'),
  makeTree(6, 24, 10, 'normal'),
  makeTree(7, 28, 16, 'normal'),
  makeTree(8, 30, 24, 'normal'),
  makeTree(9, 34, 20, 'normal'),
  makeTree(10, 38, 12, 'normal'),
  makeTree(11, 42, 18, 'normal'),
  makeTree(12, 46, 26, 'normal'),
  makeTree(13, 6, 30, 'normal'),
  makeTree(14, 12, 34, 'normal'),
  makeTree(15, 18, 32, 'normal'),
  makeTree(16, 26, 36, 'normal'),
  makeTree(17, 32, 30, 'normal'),
  makeTree(18, 40, 34, 'normal'),
  makeTree(19, 48, 22, 'normal'),
  makeTree(20, 52, 28, 'normal'),
  makeTree(21, 4, 20, 'normal'),
  makeTree(22, 50, 10, 'normal'),
  makeTree(23, 22, 8, 'normal'),
  makeTree(24, 36, 8, 'normal'),

  // === Oak trees (lvl 15) – scattered mid-distance ===
  makeTree(25, 5, 38, 'oak'),
  makeTree(26, 12, 42, 'oak'),
  makeTree(27, 18, 40, 'oak'),
  makeTree(28, 28, 44, 'oak'),
  makeTree(29, 38, 40, 'oak'),
  makeTree(30, 46, 36, 'oak'),
  makeTree(31, 54, 30, 'oak'),
  makeTree(32, 58, 20, 'oak'),
  makeTree(33, 2, 28, 'oak'),
  makeTree(34, 55, 12, 'oak'),
  makeTree(35, 8, 8, 'oak'),
  makeTree(36, 44, 6, 'oak'),
  makeTree(37, 60, 32, 'oak'),
  makeTree(38, 15, 48, 'oak'),
  makeTree(39, 32, 50, 'oak'),
  makeTree(40, 50, 45, 'oak'),

  // === Willow trees (lvl 30) – edges & further out ===
  makeTree(41, 3, 45, 'willow'),
  makeTree(42, 10, 50, 'willow'),
  makeTree(43, 22, 52, 'willow'),
  makeTree(44, 35, 55, 'willow'),
  makeTree(45, 48, 50, 'willow'),
  makeTree(46, 58, 42, 'willow'),
  makeTree(47, 62, 28, 'willow'),
  makeTree(48, 65, 15, 'willow'),
  makeTree(49, 1, 35, 'willow'),
  makeTree(50, 70, 35, 'willow'),
  makeTree(51, 5, 55, 'willow'),
  makeTree(52, 40, 60, 'willow'),
  makeTree(53, 55, 55, 'willow'),
  makeTree(54, 68, 45, 'willow'),
  makeTree(55, 25, 58, 'willow')
];

function broadcast(data) {
  const message = JSON.stringify(data, publicFields);

  wss.clients.forEach(client => {
    if (client.readyState === 1 && client.authenticated) {
      client.send(message);
    }
  });
}

function broadcastWorld() {
  broadcast({
    type: 'TICK_UPDATE',
    players,
    npcs,
    groundItems,
    trees
  });
}

function publicFields(key, value) {
  return ['ip', 'accountKey', 'passwordHash', 'salt'].includes(key) ? undefined : value;
}

function rememberPlayer(player) {
  if (player.accountKey && savedAccounts[player.accountKey]) {
    savedAccounts[player.accountKey].player = player;
  }
}

function getPlayerSocket(playerId) {
  for (const client of wss.clients) {
    if (
      client.readyState === 1 &&
      client.authenticated &&
      client.playerId === playerId
    ) {
      return client;
    }
  }
  return null;
}

function sendQuestUpdate(ws, player) {
  if (!ws || ws.readyState !== 1 || !player?.quest) return;
  ws.send(JSON.stringify({
    type: 'QUEST_UPDATE',
    quest: player.quest
  }));
}

function advanceStarterChop(player, ws) {
  const q = player.quest;
  if (!q || q.done || q.stage !== 'chop') return;

  q.progress = Math.min(q.goal, (q.progress || 0) + 1);
  if (q.progress >= q.goal) {
    q.stage = 'deliver';
    q.progress = q.goal;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'SERVER_MSG',
        text: 'Quest updated: Return to Shopkeeper Bob for your reward.'
      }));
    }
  }
  sendQuestUpdate(ws, player);
}

function tryCompleteStarterQuest(player, ws) {
  const q = player.quest;
  if (!q || q.done) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'SERVER_MSG',
        text: q?.done
          ? "Bob: Thanks again. Come back when you need supplies."
          : "Bob: Welcome to my shop."
      }));
    }
    return false;
  }

  if (q.stage === 'chop') {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'SERVER_MSG',
        text: `Bob: Chop ${q.goal} trees for me first. Progress: ${q.progress}/${q.goal}.`
      }));
    }
    return false;
  }

  if (q.stage === 'deliver') {
    q.done = true;
    q.stage = 'done';
    addItemToInventory(player, 'coins', 50);
    addItemToInventory(player, 'bread', 2);
    rememberPlayer(player);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'SERVER_MSG',
        text: "Bob: Fine work. Here's 50 coins and some bread."
      }));
      sendQuestUpdate(ws, player);
    }
    return true;
  }

  return false;
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

// Same Perlin height field as the client (seed 0x51a7e311). Deep water is solid.
const HEIGHT_PERM = (() => {
  const src = new Uint8Array(256);
  for (let i = 0; i < 256; i++) src[i] = i;
  let s = 0x51a7e311;
  for (let i = 255; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    const tmp = src[i];
    src[i] = src[j];
    src[j] = tmp;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = src[i & 255];
  return perm;
})();

function fadePerlin(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerpPerlin(a, b, t) {
  return a + t * (b - a);
}

function gradPerlin(hash, x, y) {
  switch (hash & 3) {
    case 0: return x + y;
    case 1: return -x + y;
    case 2: return x - y;
    default: return -x - y;
  }
}

function perlin2(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = fadePerlin(xf);
  const v = fadePerlin(yf);
  const X = xi & 255;
  const Y = yi & 255;
  const aa = HEIGHT_PERM[HEIGHT_PERM[X] + Y];
  const ab = HEIGHT_PERM[HEIGHT_PERM[X] + Y + 1];
  const ba = HEIGHT_PERM[HEIGHT_PERM[X + 1] + Y];
  const bb = HEIGHT_PERM[HEIGHT_PERM[X + 1] + Y + 1];
  return lerpPerlin(
    lerpPerlin(gradPerlin(aa, xf, yf), gradPerlin(ba, xf - 1, yf), u),
    lerpPerlin(gradPerlin(ab, xf, yf - 1), gradPerlin(bb, xf - 1, yf - 1), u),
    v
  );
}

function fbmHeight(x, y) {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let octave = 0; octave < 5; octave++) {
    sum += amp * perlin2(x * freq, y * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

function terrainHeight(tx, ty) {
  const n = fbmHeight((tx + 40) * 0.08, (ty + 40) * 0.08);
  return Math.max(0, Math.min(1, n * 0.72 + 0.5));
}

const WATER_LEVEL = 0.38;

function isShopBridge(tx, ty) {
  // Wooden path from the main road (y=22) up to the shop door (36,18).
  return tx >= 35 && tx <= 37 && ty >= 19 && ty <= 21;
}

function isAuthoredGround(tx, ty) {
  if (tx === 22 || tx === 23 || ty === 22) return true;

  if (
    (ty === -20 && tx >= 22 && tx <= 27) ||
    (ty === -28 && tx >= 22 && tx <= 37) ||
    (ty === -35 && tx >= 13 && tx <= 23)
  ) {
    return true;
  }

  if (isShopBridge(tx, ty)) return true;
  if (tx === 36 && ty === 18) return true;
  if (tx > 32 && tx < 40 && ty > 12 && ty < 18) return true;
  return false;
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

  if (!isAuthoredGround(tx, ty) && terrainHeight(tx, ty) < WATER_LEVEL) {
    return true;
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
  let busy = false;
  let attempts = 0;
  let nextAttemptAt = 0;
  const timeout = setTimeout(() => ws.close(1008, 'Login timed out'), 120000);
  ws.on('close', () => clearTimeout(timeout));
  ws.on('error', err => console.error('[RuneServer] WebSocket error:', err.message));

  function fail(text) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'AUTH_ERROR', text }));
  }

  async function authenticate(message) {
    if (busy || ws.authenticated || ws.readyState !== 1) return;
    let data;
    try { data = JSON.parse(message); } catch { return; }
    if (!data || !['LOGIN', 'REGISTER'].includes(data.type)) return fail('Please log in first.');
    if (Date.now() < nextAttemptAt) return fail('Please wait a moment before trying again.');
    if (++attempts > 20) return ws.close(1008, 'Too many login attempts');
    nextAttemptAt = Date.now() + 1500;
    const username = typeof data.username === 'string' ? data.username.trim() : '';
    const password = data.password;
    if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) return fail('Username must contain 3–16 letters, numbers, or underscores.');
    if (typeof password !== 'string' || password.length < 10 || password.length > 128) return fail('Password must contain 10–128 characters.');
    if (activeAuthJobs >= 8) return fail('Login service is busy. Try again shortly.');
    const accountKey = 'user:' + username.toLowerCase();
    busy = true;
    activeAuthJobs++;
    try {
      let account = savedAccounts[accountKey];
      const salt = account?.salt || crypto.randomBytes(16).toString('hex');
      const derivedKey = await scryptAsync(password, salt, 64);
      if (ws.readyState !== 1) return;
      if (data.type === 'REGISTER') {
        if (savedAccounts[accountKey]) return fail('That username is already registered.');
        account = { username, salt, passwordHash: derivedKey.toString('hex'), player: null };
        savedAccounts[accountKey] = account;
        if (!saveAccountsToDisk()) {
          delete savedAccounts[accountKey];
          return fail('Unable to save your account. Please try later.');
        }
      } else {
        const storedHash = account ? Buffer.from(account.passwordHash, 'hex') : null;
        if (!storedHash || storedHash.length !== derivedKey.length || !crypto.timingSafeEqual(derivedKey, storedHash)) {
          return fail('Incorrect username or password.');
        }
      }
      if (Object.values(players).some(p => p.accountKey === accountKey)) return fail('This account is already logged in.');
      ws.authenticated = true;
      clearTimeout(timeout);
      ws.removeListener('message', authenticate);
      enterWorld(accountKey, account);
    } catch (err) {
      console.error('[RuneServer] Login error:', err);
      fail('Unable to log in. Please try again.');
    } finally {
      busy = false;
      activeAuthJobs--;
    }
  }
  ws.on('message', authenticate);

  function enterWorld(accountKey, account) {
  const playerId =
    'player_' + Math.random().toString(36).substring(2, 9);

  let playerData;
  let positionReset = false;

  if (account.player) {
    playerData = account.player;
    playerData.id = playerId;
    playerData.accountKey = accountKey;
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

    if (!playerData.stats) playerData.stats = {};
    if (playerData.stats.woodcutting == null) playerData.stats.woodcutting = 1;
    if (playerData.woodcuttingXp == null) playerData.woodcuttingXp = 0;
    if (!playerData.quest) {
      playerData.quest = {
        id: 'starter',
        title: "Bob's first job",
        stage: 'chop',
        progress: 0,
        goal: 5,
        done: false
      };
    }
  } else {
    const inventory = Array(28).fill(null);

    inventory[0] = { ...ITEM_DB.coins, count: 100 };
    inventory[1] = { ...ITEM_DB.bread, count: 2 };
    inventory[2] = { ...ITEM_DB.bronze_axe, count: 1 };

    playerData = {
      id: playerId,
      accountKey,
      name: account.username,
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
        hitpoints: 10,
        woodcutting: 1
      },
      woodcuttingXp: 0,
      quest: {
        id: 'starter',
        title: "Bob's first job",
        stage: 'chop',
        progress: 0,
        goal: 5,
        done: false
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
  ws.playerId = playerId;
  rememberPlayer(playerData);
  saveAccountsToDisk();

  ws.send(JSON.stringify({
    type: 'INIT',
    id: playerId,
    players,
    npcs,
    groundItems,
    trees,
    shopStock: SHOP_STOCK,
    world: WORLD
  }, publicFields));

  sendQuestUpdate(ws, playerData);

  if (!playerData.quest.done) {
    ws.send(JSON.stringify({
      type: 'SERVER_MSG',
      text: playerData.quest.stage === 'chop'
        ? "Quest: Chop 5 trees, then talk to Shopkeeper Bob."
        : "Quest: Talk to Shopkeeper Bob to finish your job."
    }));
  }

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
      } else if (data.type === 'CHOP') {
        const tree = trees.find(t => t.id === data.targetId);

        if (tree && tree.alive) {
          p.action = {
            type: 'CHOP',
            targetId: tree.id
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
      } else if (data.type === 'TALK_NPC') {
        const npc = npcs.find(n => n.id === data.targetId);
        if (
          npc &&
          npc.alive &&
          npc.type === 'shopkeeper' &&
          Math.hypot(p.x - npc.x, p.y - npc.y) < 4
        ) {
          tryCompleteStarterQuest(p, ws);
          rememberPlayer(p);
          saveAccountsToDisk();
          broadcastWorld();
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
  }
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

    if (!p.action) return;

    if (p.action.type === 'ATTACK') {
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
    } else if (p.action.type === 'CHOP') {
      const tree = trees.find(t => t.id === p.action.targetId);

      if (!tree || !tree.alive) {
        p.action = null;
        return;
      }

      if (Math.hypot(p.x - tree.x, p.y - tree.y) > 1.5) {
        p.targetX = Math.round(tree.x);
        p.targetY = Math.round(tree.y);
        return;
      }

      const def = TREE_TYPES[tree.type] || TREE_TYPES.normal;
      const wcLevel = p.stats.woodcutting || 1;

      // Level requirement
      if (wcLevel < def.level) {
        p.action = null;
        broadcast({
          type: 'HITSPLAT',
          text: `Need WC ${def.level}`,
          x: Math.round(p.x),
          y: Math.round(p.y),
          color: '#ff8855'
        });
        return;
      }

      // Must have an axe (equipped or in inventory)
      let axeTier = 0;
      if (p.equipment?.weapon?.axeTier) {
        axeTier = p.equipment.weapon.axeTier;
      } else {
        const invAxe = p.inventory.find(it => it && it.axeTier);
        if (invAxe) axeTier = invAxe.axeTier;
      }

      if (axeTier < 1) {
        p.action = null;
        broadcast({
          type: 'HITSPLAT',
          text: 'Need an axe!',
          x: Math.round(p.x),
          y: Math.round(p.y),
          color: '#ff8855'
        });
        return;
      }

      // Success chance rises with level difference + axe tier
      const levelBonus = Math.min(0.45, (wcLevel - def.level) * 0.02);
      const axeBonus = (axeTier - 1) * 0.12;
      const successChance = Math.min(0.92, 0.55 + levelBonus + axeBonus);

      p.isAttacking = true;

      if (Math.random() > successChance) {
        // Missed swing
        broadcast({
          type: 'HITSPLAT',
          text: 'Swing',
          x: Math.round(tree.x),
          y: Math.round(tree.y),
          color: '#aaaaaa'
        });
        return;
      }

      // Successful hit
      tree.hp = (tree.hp || def.maxHp) - 1;

      broadcast({
        type: 'HITSPLAT',
        text: 'Chop!',
        x: Math.round(tree.x),
        y: Math.round(tree.y),
        color: '#88cc55'
      });

      if (tree.hp > 0) {
        // Still standing – keep chopping
        return;
      }

      // Tree is down
      const xpGain = def.xp;
      p.woodcuttingXp = (p.woodcuttingXp || 0) + xpGain;

      let leveled = false;
      while (p.woodcuttingXp >= (p.stats.woodcutting || 1) * 50) {
        p.woodcuttingXp -= (p.stats.woodcutting || 1) * 50;
        p.stats.woodcutting = (p.stats.woodcutting || 1) + 1;
        leveled = true;
      }

      if (leveled) {
        broadcast({
          type: 'HITSPLAT',
          text: 'WC LEVEL UP!',
          x: Math.round(p.x),
          y: Math.round(p.y),
          color: '#55ff55'
        });
      }

      const logId = def.log;
      if (addItemToInventory(p, logId, 1)) {
        broadcast({
          type: 'HITSPLAT',
          text: `+1 ${ITEM_DB[logId].name}`,
          x: Math.round(tree.x),
          y: Math.round(tree.y),
          color: '#88cc55'
        });
      } else {
        broadcast({
          type: 'HITSPLAT',
          text: 'INV FULL',
          x: Math.round(p.x),
          y: Math.round(p.y),
          color: '#ffaa55'
        });
      }

      tree.alive = false;
      tree.respawnTicks = def.respawnTicks;
      p.action = null;
      p.isAttacking = false;

      advanceStarterChop(p, getPlayerSocket(p.id));
      rememberPlayer(p);
      accountsChanged = true;
    }
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

  trees.forEach(tree => {
    if (!tree.alive && --tree.respawnTicks <= 0) {
      const def = TREE_TYPES[tree.type] || TREE_TYPES.normal;
      tree.alive = true;
      tree.hp = def.maxHp;
      tree.maxHp = def.maxHp;
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
