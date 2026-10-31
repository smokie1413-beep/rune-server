// Run once from the folder containing index.html and server.js:
// node update-north.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = __dirname;
const htmlFile = path.join(root, 'index.html');
const serverFile = path.join(root, 'server.js');
const originalHtml = fs.readFileSync(htmlFile, 'utf8');
const originalServer = fs.readFileSync(serverFile, 'utf8');
if (originalHtml.includes('NORTH_WORLD_UPDATE_V1')) {
  throw new Error('Northern update already installed. No files changed.');
}
let html = originalHtml;
let server = originalServer;
function replaceOnce(text, regex, replacement, label) {
  const matches = [...text.matchAll(new RegExp(regex.source, regex.flags.replace(/g/g, '') + 'g'))];
  if (matches.length !== 1) throw new Error(label + ': expected one match, found ' + matches.length + '. No files changed.');
  return text.replace(regex, replacement);
}
const generation = "for (let y = -45; y < MAP_SIZE; y++) {\n  const row = [];\n  for (let x = 0; x < MAP_SIZE; x++) {\n    let tile = y < 0 ? 5 : 0;\n    if (x === 22 || x === 23 || y === 22) tile = 1;\n    if ((y === -20 && x >= 22 && x <= 27) ||\n        (y === -28 && x >= 22 && x <= 37) ||\n        (y === -35 && x >= 13 && x <= 23)) tile = 1;\n    if (x >= 32 && x <= 40 && y >= 12 && y <= 18) {\n      const wall = x === 32 || x === 40 || y === 12 || y === 18;\n      tile = wall ? ((x === 36 && y === 18) ? 3 : 4) : 3;\n    }\n    row.push(tile);\n  }\n  state.map[y] = row;\n}\n";
const scenery = "\n// Northern wilderness terrain: decorative scenery is intentionally walk-through.\nfunction northHash(x,y,salt=0){\n  let n=Math.imul(x,374761393)^Math.imul(y,668265263)^Math.imul(salt,1442695041);\n  n=Math.imul(n^(n>>>13),1274126177);return (n^(n>>>16))>>>0;\n}\nfunction drawNorthTerrain(x,y,sx,sy,tile){\n  if(tile===3||tile===4)return;\n  const north=y<0,n=northHash(x,y);\n  ctx.save();ctx.translate(Math.round(sx),Math.round(sy));\n  const rect=(a,b,w,h,c)=>{ctx.fillStyle=c;ctx.fillRect(a,b,w,h);};\n  const ground=north?['#28342a','#30382b','#293029','#34382d']:['#14532d','#17582f','#18542d','#1a5830'];\n  rect(0,0,32,32,tile===1?(north?'#64513a':'#725936'):ground[n%4]);\n  for(let i=0;i<6;i++){\n    const d=northHash(x,y,i+1);\n    rect(2+d%27,2+(d>>>8)%27,2+i%2,2,tile===1?(i%2?'#8d7854':'#493c2d'):(north?(i%2?'#536047':'#1e2922'):(i%2?'#33733b':'#104626')));\n  }\n  if(tile===1){ctx.restore();return;}\n  const clearing=north&&(\n    Math.hypot(x-25,y+20)<4||Math.hypot(x-35,y+28)<4||Math.hypot(x-15,y+35)<4\n  );\n  if(north&&!clearing&&n%10===0){\n    rect(3,25,26,4,'#18231d');rect(14,17,5,12,'#59402d');\n    rect(3,19,26,6,'#142d26');rect(6,12,20,8,'#1e3c30');\n    rect(10,6,12,8,'#234332');rect(14,2,5,6,'#315343');\n    rect(6,19,8,3,'#3e6046');rect(9,12,6,3,'#476b4d');\n  }else if(north&&!clearing&&n%11===0){\n    rect(5,24,24,5,'#1d251f');rect(6,16,20,10,'#535c53');\n    rect(10,12,13,5,'#89907b');rect(7,17,5,6,'#7a846e');rect(18,21,8,5,'#394637');\n  }else if(north&&n%7===0){\n    rect(8,19,2,7,'#8a8054');rect(12,16,2,10,'#8a8054');rect(16,20,2,6,'#716b49');\n  }else if(!north&&n%23===0){\n    rect(12,18,2,8,'#448643');rect(10,15,6,4,n%2?'#d7b456':'#bd8fbd');\n  }\n  if(north&&x>=10&&x<=19&&y>=-40&&y<=-31&&(x===10||x===19||y===-40)&&n%4!==0){\n    rect(3,16,26,12,'#202620');rect(4,11,11,10,'#62685b');rect(17,14,10,10,'#62685b');\n    rect(4,11,11,2,'#969781');rect(17,14,10,2,'#969781');rect(5,20,8,4,'#45613a');\n  }\n  if(x===18&&y===-33){\n    rect(5,23,23,5,'#646457');rect(4,19,5,6,'#646457');rect(24,19,5,6,'#646457');\n    rect(9,20,15,5,'#503a29');rect(11,12,10,11,'#d85c2c');\n    rect(13,9,6,12,'#efa43c');rect(15,16,3,6,'#ffe3a0');\n  }\n  if((x===29||x===38)&&y===-24){\n    rect(5,23,24,4,'#202620');rect(8,4,16,21,'#62685b');\n    rect(8,4,16,3,'#a1a28a');rect(10,8,3,14,'#858b73');\n    rect(17,11,4,3,'#323e33');rect(8,22,16,4,'#45613a');\n  }\n  ctx.restore();\n}\n";
html = replaceOnce(html,
  /for \(let y = 0; y < MAP_SIZE; y\+\+\) \{[\s\S]*?state\.map\.push\(row\);\s*\}/,
  () => '// NORTH_WORLD_UPDATE_V1\n' + generation,
  'Map generation');
html = replaceOnce(html,
  /for \(let y = 0; y < MAP_SIZE; y\+\+\) \{/,
  'for (let y = -45; y < MAP_SIZE; y++) {',
  'Map drawing bounds');
const drawStart = html.indexOf('function draw() {');
if (drawStart < 0) throw new Error('Draw function not found. No files changed.');
const beforeDraw = html.slice(0, drawStart);
let drawTail = html.slice(drawStart);
const tileFill = 'ctx.fillRect(sx, sy, TILE_PX, TILE_PX);';
if (!drawTail.includes(tileFill)) throw new Error('Terrain drawing not found. No files changed.');
drawTail = drawTail.replace(tileFill, tileFill + '\n      drawNorthTerrain(x, y, sx, sy, tile);');
html = beforeDraw + scenery + '\n' + drawTail;
html = replaceOnce(html, /const signY = 46 \* TILE_PX - camY;/,
  'const signY = -camY;', 'Wilderness warning sign');
html = html.replace('Head North to enter the Level 10+ Wilderness!',
  'Follow the road NORTH ↑. Wilderness begins beyond the warning sign.');
// Add a persistent orientation/region indicator without changing combat HUD code.
const regionScript = `
<script>
(() => {
  const badge = document.createElement('div');
  badge.style.cssText = 'position:absolute;top:64px;left:8px;padding:6px 10px;background:#141b16e8;border:1px solid #8c6a3c;border-radius:5px;color:#e5d6a4;font:12px sans-serif;pointer-events:none;z-index:10';
  document.getElementById('game-container').appendChild(badge);
  setInterval(() => {
    const me = state.players[state.playerId];
    badge.textContent = me ? 'N ↑ | ' + (me.y < 0 ? 'Northern Wilderness • Level 10+' : 'Town & Grasslands') : 'N ↑';
  }, 250);
})();
</script>
`;
html = replaceOnce(html, /<\/body>/, () => regionScript + '\n</body>', 'Region indicator');
for (const [name, y] of [['Hobgoblin Brute',-20],['Moss Giant',-28],['Dark Warrior',-35]]) {
  const pattern = new RegExp("name: '" + name + "',[\\s\\S]*?targetY: \\d+");
  server = replaceOnce(server, pattern, block => block
    .replace(/\by: \d+/, 'y: ' + y)
    .replace(/targetY: \d+/, 'targetY: ' + y), name + ' coordinates');
}
server = replaceOnce(server,
  /const ry = Math\.max\([\s\S]*?\n      \);/,
  `const wilderness = npc.id >= 4;
      const ry = Math.max(
        wilderness ? -40 : 5,
        Math.min(wilderness ? -5 : 40, npc.y + (Math.floor(Math.random() * 5) - 2))
      );`, 'Enemy roaming bounds');
server = replaceOnce(server, /function isWallTile\(x, y\) \{/,
  `function isWallTile(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x >= 90 || y < -45 || y >= 90) return true;`,
  'World boundary');
// Move players saved in the former southern wilderness back to town on login.
server = replaceOnce(server, /playerData = savedAccounts\[cleanIp\];/,
  `playerData = savedAccounts[cleanIp];
    if (!Number.isFinite(playerData.x) || !Number.isFinite(playerData.y) ||
        playerData.x < 0 || playerData.x >= 90 || playerData.y < -45 || playerData.y > 45) {
      playerData.x = 22;
      playerData.y = 22;
    }`, 'Saved position compatibility');
// Parse both updated JavaScript files before writing either one.
new vm.Script(server, {filename:'server.js'});
let scriptCount = 0;
for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
  new vm.Script(match[1], {filename:'index-inline-' + (++scriptCount) + '.js'});
}
if (scriptCount < 1) throw new Error('No inline scripts found. No files changed.');
const stamp = Date.now();
fs.writeFileSync(htmlFile + '.before-north-' + stamp + '.bak', originalHtml, {flag:'wx'});
fs.writeFileSync(serverFile + '.before-north-' + stamp + '.bak', originalServer, {flag:'wx'});
fs.writeFileSync(htmlFile, html, 'utf8');
fs.writeFileSync(serverFile, server, 'utf8');
console.log('Updated index.html and server.js. Original files were backed up.');
console.log('Restart your server and refresh the browser. Follow the road UP from town.');
