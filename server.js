const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(path.join(__dirname, 'public')));

const players = {};
const territoryGrid = {};
let enemies = [];
let enemyIdCounter = 0;
const baseSpawnRate = 5000; // Base spawn rate in milliseconds for level 1
let difficultyMultiplier = 1.0;
const gameStartTime = Date.now();
const WORLD_WIDTH = 9600;
const WORLD_HEIGHT = 7200;
const VIEW_WIDTH = 800;
const VIEW_HEIGHT = 600;
const SPAWN_MARGIN = 50;
const territoryCellSize = 50;
const MIN_SPAWN_INTERVAL = 1000; // Minimum spawn interval in milliseconds

const enemyTypes = {
  basic: { prob: 1.0, speed: 2.0, health: 1, radius: 15, color: '#FF5252' },
  fast: { prob: 0.0, speed: 3.5, health: 1, radius: 12, color: '#00FF00' },
  tank: { prob: 0.0, speed: 1.5, health: 5, radius: 25, color: '#0000FF' },
  miniBoss: { prob: 0.0, speed: 2.5, health: 50, radius: 30, color: '#FF6600' },
  boss: { prob: 0.0, speed: 1.8, health: 100, radius: 40, color: '#FF00FF' }
};

function getNextEnemyId() {
  return enemyIdCounter++;
}

function calculateDifficulty() {
  const minutesElapsed = (Date.now() - gameStartTime) / 60000;
  return 1 + minutesElapsed * 0.3;
}

function getSpawnInterval(level) {
  return Math.max(MIN_SPAWN_INTERVAL, baseSpawnRate - (level - 1) * 500);
}

function getEnemyProbabilities(level) {
  const probs = {
    basic: Math.max(0.5 - (level - 1) * 0.05, 0.1),
    fast: Math.min(0.2 + (level - 2) * 0.05, 0.3),
    tank: Math.min(0.15 + (level - 3) * 0.05, 0.2),
    miniBoss: Math.min(0.1 + (level - 5) * 0.02, 0.15),
    boss: Math.min(0.05 + (level - 7) * 0.01, 0.1)
  };
  const total = Object.values(probs).reduce((a, b) => a + b, 0);
  for (let key in probs) probs[key] /= total;
  return probs;
}

function spawnEnemyNearPlayer(player) {
  const level = player.level || 1;
  const probs = getEnemyProbabilities(level);
  const typeWeights = Object.entries(probs)
    .map(([type, prob]) => ({ type, prob }))
    .filter(t => t.prob > 0);
  let rand = Math.random();
  let cumulative = 0;
  let selectedType = 'basic';
  for (const { type, prob } of typeWeights) {
    cumulative += prob;
    if (rand < cumulative) {
      selectedType = type;
      break;
    }
  }
  const cfg = enemyTypes[selectedType];
  let x, y;
  const halfWidth = VIEW_WIDTH / 2;
  const halfHeight = VIEW_HEIGHT / 2;
  const viewLeft = player.x - halfWidth;
  const viewRight = player.x + halfWidth;
  const viewTop = player.y - halfHeight;
  const viewBottom = player.y + halfHeight;
  const edge = Math.floor(Math.random() * 4);
  if (edge === 0) { // Top
    x = Math.random() * (viewRight - viewLeft) + viewLeft;
    y = viewTop - SPAWN_MARGIN;
  } else if (edge === 1) { // Right
    x = viewRight + SPAWN_MARGIN;
    y = Math.random() * (viewBottom - viewTop) + viewTop;
  } else if (edge === 2) { // Bottom
    x = Math.random() * (viewRight - viewLeft) + viewLeft;
    y = viewBottom + SPAWN_MARGIN;
  } else { // Left
    x = viewLeft - SPAWN_MARGIN;
    y = Math.random() * (viewBottom - viewTop) + viewTop;
  }
  x = Math.max(0, Math.min(WORLD_WIDTH, x));
  y = Math.max(0, Math.min(WORLD_HEIGHT, y));
  const enemy = {
    id: getNextEnemyId(),
    x,
    y,
    type: selectedType,
    health: cfg.health * difficultyMultiplier,
    maxHealth: cfg.health * difficultyMultiplier,
    speed: cfg.speed * 1.3,
    radius: cfg.radius,
    color: cfg.color
  };
  enemies.push(enemy);
  io.emit('enemySpawn', enemy);
}

function updateEnemies() {
  enemies.forEach(enemy => {
    let nearestPlayer = null;
    let minDist = Infinity;
    let dxToNearest = 0;
    let dyToNearest = 0;
    for (let id in players) {
      const p = players[id];
      const dx = p.x - enemy.x;
      const dy = p.y - enemy.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < minDist) {
        minDist = dist;
        nearestPlayer = p;
        dxToNearest = dx;
        dyToNearest = dy;
      }
    }
    if (nearestPlayer && minDist > 0) {
      const speed = enemy.type === 'boss' ? Math.min(enemy.speed, minDist / 10) : enemy.speed;
      enemy.x += (dxToNearest / minDist) * speed;
      enemy.y += (dyToNearest / minDist) * speed;
      enemy.x = Math.max(0, Math.min(WORLD_WIDTH, enemy.x));
      enemy.y = Math.max(0, Math.min(WORLD_HEIGHT, enemy.y));
    }
  });
}

setInterval(() => {
  const now = Date.now();
  difficultyMultiplier = calculateDifficulty();
  const connectedPlayerIds = Object.keys(players);
  connectedPlayerIds.forEach(playerId => {
    const player = players[playerId];
    const level = player.level || 1;
    const spawnInterval = getSpawnInterval(level);
    if (now - player.lastSpawnTime > spawnInterval && enemies.length < 30) {
      spawnEnemyNearPlayer(player);
      player.lastSpawnTime = now;
    }
  });
  updateEnemies();
  io.emit('enemyState', enemies);
}, 50);

setInterval(() => {
  const playersData = {};
  for (let id in players) {
    playersData[id] = { ...players[id], territory: Array.from(players[id].territory) };
  }
  io.emit('currentPlayers', playersData);
}, 5000);

function getAllOccupiedCells() {
  return new Set(Object.keys(territoryGrid));
}

function floodFillServer(startX, startY, trailSet, visited, player, gridWidth, gridHeight) {
  const stack = [[startX, startY]];
  const region = [];
  let isEnclosed = true;
  while (stack.length > 0) {
    const [x, y] = stack.pop();
    const pos = `${x},${y}`;
    if (x < 0 || x >= gridWidth || y < 0 || y >= gridHeight) {
      isEnclosed = false;
      continue;
    }
    if (player.territory.has(pos) || trailSet.has(pos)) continue;
    if (visited.has(pos)) continue;

    region.push(pos);
    visited.add(pos);

    stack.push([x + 1, y]);
    stack.push([x - 1, y]);
    stack.push([x, y + 1]);
    stack.push([x, y - 1]);
  }
  return [region, isEnclosed];
}

// Remove enemies within 500 units of the player upon spawning
function removeNearbyEnemies(player) {
  const spawnProtectionRadius = 500;
  enemies = enemies.filter(enemy => {
    const dx = enemy.x - player.x;
    const dy = enemy.y - player.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    return distance > spawnProtectionRadius;
  });
  io.emit('enemyState', enemies);
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);
  const gridWidth = Math.floor(WORLD_WIDTH / territoryCellSize);
  const gridHeight = Math.floor(WORLD_HEIGHT / territoryCellSize);
  const allOccupied = getAllOccupiedCells();
  let spawnCell;
  do {
    const cx = Math.floor(Math.random() * gridWidth);
    const cy = Math.floor(Math.random() * gridHeight);
    spawnCell = `${cx},${cy}`;
  } while (allOccupied.has(spawnCell));
  const startX = (parseInt(spawnCell.split(',')[0]) + 0.5) * territoryCellSize;
  const startY = (parseInt(spawnCell.split(',')[1]) + 0.5) * territoryCellSize;
  players[socket.id] = {
    id: socket.id,
    x: startX,
    y: startY,
    health: 100,
    coins: 0,
    color: null,
    cableActive: false,
    cableTarget: null,
    caughtBy: null,
    territory: new Set([spawnCell]),
    trail: [],
    lastSpawnTime: Date.now(),
    level: 1,
    invulnerable: false,
    invulnerabilityEndTime: 0
  };
  territoryGrid[spawnCell] = socket.id;
  console.log(`Player ${socket.id} spawned at cell ${spawnCell} with level 1`);
  removeNearbyEnemies(players[socket.id]); // Clear nearby enemies on spawn

  const currentPlayersData = {};
  for (let id in players) {
    if (id !== socket.id) {
      currentPlayersData[id] = { ...players[id], territory: Array.from(players[id].territory) };
    }
  }
  socket.emit('currentPlayers', currentPlayersData);
  socket.emit('enemyState', enemies);

  socket.on('selectColor', (color) => {
    const isColorTaken = Object.values(players).some(p => p.color === color && p.id !== socket.id);
    if (isColorTaken) {
      socket.emit('colorTaken');
    } else {
      players[socket.id].color = color;
      socket.emit('colorAccepted', { x: players[socket.id].x, y: players[socket.id].y });
      const newPlayerData = { ...players[socket.id], territory: Array.from(players[socket.id].territory) };
      socket.broadcast.emit('newPlayer', { id: socket.id, data: newPlayerData });
      console.log(`Player ${socket.id} selected color ${color}`);
    }
  });

  socket.on('playerUpdate', (data) => {
    if (!players[socket.id]) return;
    const player = players[socket.id];
    player.x = typeof data.x === 'number' ? data.x : player.x;
    player.y = typeof data.y === 'number' ? data.y : player.y;
    player.health = typeof data.health === 'number' ? data.health : player.health;
    player.color = data.color || player.color;
    player.cableActive = data.cableActive || false;
    player.cableTarget = data.cableTarget || null;
    player.caughtBy = data.caughtBy || null;
    player.trail = Array.isArray(data.trail) ? data.trail : player.trail;
    const cellX = Math.floor(player.x / territoryCellSize);
    const cellY = Math.floor(player.y / territoryCellSize);
    for (let otherId in players) {
      if (otherId !== socket.id) {
        const otherPlayer = players[otherId];
        if (otherPlayer.trail.some(([tx, ty]) => tx === cellX && ty === cellY)) {
          const cellsToRemove = Math.max(1, Math.ceil(otherPlayer.territory.size * 0.01));
          otherPlayer.trail = [];
          for (let i = 0; i < cellsToRemove && otherPlayer.territory.size > 0; i++) {
            const randomCell = Array.from(otherPlayer.territory)[Math.floor(Math.random() * otherPlayer.territory.size)];
            otherPlayer.territory.delete(randomCell);
            delete territoryGrid[randomCell];
          }
          io.to(otherId).emit('territoryPenalty', { territory: Array.from(otherPlayer.territory), trail: otherPlayer.trail });
          console.log(`Player ${socket.id} stepped on player ${otherId}'s trail. Removed ${cellsToRemove} cells`);
        }
      }
    }
    const updateData = { ...player, territory: Array.from(player.territory) };
    socket.broadcast.emit('playerUpdate', { id: socket.id, data: updateData });
  });

  socket.on('playerShoot', (data) => {
    socket.broadcast.emit('playerShoot', { id: socket.id, data });
  });

  socket.on('enemyHit', ({ enemyId, damage }) => {
    const enemy = enemies.find(e => e.id === enemyId);
    if (enemy) {
      enemy.health -= damage;
      if (enemy.health <= 0) {
        const enemyData = { id: enemy.id, type: enemy.type, x: enemy.x, y: enemy.y };
        enemies = enemies.filter(e => e.id !== enemyId);
        io.emit('enemyDestroyed', enemyId);
        socket.emit('enemyKilled', {
          enemyId: enemyData.id,
          enemyType: enemyData.type,
          x: enemyData.x,
          y: enemyData.y,
          playerId: socket.id
        });
        console.log(`Enemy ${enemyId} (${enemyData.type}) killed by player ${socket.id}`);
      } else {
        io.emit('enemyState', enemies);
      }
    }
  });

  socket.on('playerHit', ({ playerId, damage }) => {
    const targetPlayer = players[playerId];
    if (targetPlayer && (!targetPlayer.invulnerable || Date.now() > targetPlayer.invulnerabilityEndTime)) {
      const cellX = Math.floor(targetPlayer.x / territoryCellSize);
      const cellY = Math.floor(targetPlayer.y / territoryCellSize);
      const cellKey = `${cellX},${cellY}`;
      if (!targetPlayer.territory.has(cellKey)) { // Only take damage outside territory
        targetPlayer.health -= damage;
        if (targetPlayer.health <= 0) {
          // Handle player death if needed (e.g., respawn logic could be added here)
        }
        io.emit('playerUpdate', { id: playerId, data: { health: targetPlayer.health } });
        console.log(`Player ${playerId} hit for ${damage} damage, health now ${targetPlayer.health}`);
      }
    }
  });

  socket.on('expandTerritory', ({ enemyType, K }) => {
    if (!players[socket.id]) return;
    const player = players[socket.id];
    let cellsToAdd;
    if (enemyType === 'levelUp' && K !== undefined) cellsToAdd = K;
    else {
      switch (enemyType) {
        case 'basic': cellsToAdd = 1; break;
        case 'fast': cellsToAdd = 2; break;
        case 'tank': cellsToAdd = 3; break;
        case 'miniBoss': cellsToAdd = 5; break;
        case 'boss': cellsToAdd = 10; break;
        default: cellsToAdd = 1;
      }
    }
    const directions = [[0, 1], [0, -1], [1, 0], [-1, 0]];
    const gridWidth = Math.floor(WORLD_WIDTH / territoryCellSize);
    const gridHeight = Math.floor(WORLD_HEIGHT / territoryCellSize);
    let candidates = [];
    player.territory.forEach(cell => {
      const [x, y] = cell.split(',').map(Number);
      directions.forEach(([dx, dy]) => {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < gridWidth && ny >= 0 && ny < gridHeight) {
          const ncell = `${nx},${ny}`;
          if (!territoryGrid[ncell]) candidates.push(ncell);
        }
      });
    });
    if (candidates.length === 0) {
      console.log(`No available cells to expand territory for player ${socket.id}`);
      return;
    }
    candidates = [...new Set(candidates)].sort(() => Math.random() - 0.5);
    let toAdd = [];
    for (let i = 0; i < cellsToAdd && i < candidates.length; i++) {
      const cell = candidates[i];
      player.territory.add(cell);
      territoryGrid[cell] = socket.id;
      toAdd.push(cell);
    }
    console.log(`Player ${socket.id} expanded territory by ${toAdd.length} cells`);
    const updateData = { ...player, territory: Array.from(player.territory), newCells: toAdd };
    io.emit('playerUpdate', { id: socket.id, data: updateData });
  });

  socket.on('captureTerritory', ({ trail }) => {
    if (!players[socket.id]) return;
    const player = players[socket.id];
    const trailSet = new Set(trail.map(([x, y]) => `${x},${y}`));
    const newTrailCells = [];
    trail.forEach(([x, y]) => {
      const pos = `${x},${y}`;
      const currentOwner = territoryGrid[pos];
      if (currentOwner && currentOwner !== socket.id) {
        players[currentOwner].territory.delete(pos);
      }
      if (!player.territory.has(pos)) {
        player.territory.add(pos);
        newTrailCells.push(pos);
      }
      territoryGrid[pos] = socket.id;
    });
    const minX = Math.min(...trail.map(p => p[0]));
    const maxX = Math.max(...trail.map(p => p[0]));
    const minY = Math.min(...trail.map(p => p[1]));
    const maxY = Math.max(...trail.map(p => p[1]));
    const gridWidth = Math.floor(WORLD_WIDTH / territoryCellSize);
    const gridHeight = Math.floor(WORLD_HEIGHT / territoryCellSize);
    const visited = new Set();
    const newCapturedCells = [];
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const pos = `${x},${y}`;
        if (!player.territory.has(pos) && !visited.has(pos)) {
          const [region, isEnclosed] = floodFillServer(x, y, trailSet, visited, player, gridWidth, gridHeight);
          if (isEnclosed) {
            region.forEach(p => {
              const currentOwner = territoryGrid[p];
              if (currentOwner && currentOwner !== socket.id) {
                players[currentOwner].territory.delete(p);
              }
              player.territory.add(p);
              territoryGrid[p] = socket.id;
              newCapturedCells.push(p);
            });
          }
        }
      }
    }
    const newCells = [...newTrailCells, ...newCapturedCells];
    const updateData = { ...player, territory: Array.from(player.territory), newCells };
    io.emit('playerUpdate', { id: socket.id, data: updateData });
    for (let otherId in players) {
      if (otherId !== socket.id) {
        const otherUpdateData = { ...players[otherId], territory: Array.from(players[otherId].territory) };
        io.emit('playerUpdate', { id: otherId, data: otherUpdateData });
      }
    }
  });

  socket.on('playerCableCatch', (data) => {
    io.emit('playerCableCatch', data);
  });

  // Invulnerability when shop is opened
  socket.on('openShop', () => {
    if (players[socket.id]) {
      players[socket.id].invulnerable = true;
    }
  });

  // Invulnerability lasts 3 seconds after closing shop
  socket.on('closeShop', () => {
    if (players[socket.id]) {
      players[socket.id].invulnerabilityEndTime = Date.now() + 3000;
    }
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    if (players[socket.id]) {
      if (players[socket.id].cableTarget) {
        const caughtId = players[socket.id].cableTarget;
        if (players[caughtId]) {
          players[caughtId].caughtBy = null;
          io.to(caughtId).emit('playerUpdate', { id: caughtId, data: { caughtBy: null } });
        }
      }
      if (players[socket.id].caughtBy) {
        const catcherId = players[socket.id].caughtBy;
        if (players[catcherId]) {
          players[catcherId].cableActive = false;
          players[catcherId].cableTarget = null;
          io.to(catcherId).emit('playerUpdate', { id: catcherId, data: { cableActive: false, cableTarget: null } });
        }
      }
      players[socket.id].territory.forEach(cell => {
        delete territoryGrid[cell];
      });
      delete players[socket.id];
      io.emit('playerDisconnect', socket.id);
    }
  });
});

// Periodically check and end invulnerability after the 3-second period
setInterval(() => {
  const now = Date.now();
  for (let id in players) {
    const player = players[id];
    if (player.invulnerable && now > player.invulnerabilityEndTime) {
      player.invulnerable = false;
    }
  }
}, 1000);

server.listen(3000, () => {
  console.log('Server listening on port 3000');
});