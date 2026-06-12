// ─── TestClaude Game Server ────────────────────────────────────────────────────

const express    = require('express')
const http       = require('http')
const { Server } = require('socket.io')
const cors       = require('cors')

// ── Config ─────────────────────────────────────────────────────────────────────

const PORT             = process.env.PORT || 3000
const ATTACK_RANGE     = 2000       // mètres
const ATTACK_COOLDOWN  = 3000       // ms
const MOVE_SPEED_MAX   = 100        // m/s (anti-cheat: max toléré)
const SPAWN_RADIUS     = 800        // mètres autour du joueur
const ENEMIES_PER_ZONE = 8
const RESPAWN_DELAY    = 2 * 60 * 1000  // 2 minutes

const ENEMY_TYPES = [
  { type: 'scout',    level: 1, hp: 30,  xp: 10, resources: 5,  fer: 5,  name: 'Éclaireur Alien' },
  { type: 'soldier',  level: 2, hp: 60,  xp: 20, resources: 10, fer: 12, name: 'Soldat Alien' },
  { type: 'gunship',  level: 3, hp: 100, xp: 30, resources: 15, fer: 22, name: 'Vaisseau Alien' },
  { type: 'fighter',  level: 4, hp: 150, xp: 40, resources: 20, fer: 35, name: 'Chasseur Alien' },
  { type: 'overlord', level: 5, hp: 200, xp: 50, resources: 25, fer: 50, name: 'Seigneur Alien' },
]

// ── State ──────────────────────────────────────────────────────────────────────

const players = new Map()    // socketId → player
const enemies = new Map()    // id → enemy

let enemyCounter = 0

// ── Helpers ────────────────────────────────────────────────────────────────────

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function randomPointNear(lat, lng, minR, maxR) {
  const angle = Math.random() * 2 * Math.PI
  const dist  = minR + Math.random() * (maxR - minR)
  const dlat  = (dist * Math.cos(angle)) / 111000
  const dlng  = (dist * Math.sin(angle)) / (111000 * Math.cos(lat * Math.PI / 180))
  return { lat: lat + dlat, lng: lng + dlng }
}

function randomEnemyType() {
  const weights = [40, 30, 15, 10, 5]
  const roll    = Math.random() * 100
  let sum = 0
  for (let i = 0; i < weights.length; i++) {
    sum += weights[i]
    if (roll < sum) return ENEMY_TYPES[i]
  }
  return ENEMY_TYPES[0]
}

function spawnEnemy(lat, lng) {
  const type = randomEnemyType()
  const pos  = randomPointNear(lat, lng, 80, SPAWN_RADIUS)
  const id   = 'enemy_' + (++enemyCounter)
  const enemy = {
    id,
    ...type,
    maxHp: type.hp,
    lat: pos.lat,
    lng: pos.lng,
  }
  enemies.set(id, enemy)
  return enemy
}

function ensureEnemiesForPlayer(player) {
  // Compte les ennemis déjà proches
  const nearbyCount = [...enemies.values()].filter(e =>
    haversine(player.lat, player.lng, e.lat, e.lng) <= SPAWN_RADIUS
  ).length

  const toSpawn = Math.max(0, ENEMIES_PER_ZONE - nearbyCount)
  const spawned = []
  for (let i = 0; i < toSpawn; i++) {
    spawned.push(spawnEnemy(player.lat, player.lng))
  }
  return spawned
}

function getEnemiesNear(lat, lng, radius) {
  return [...enemies.values()].filter(e => haversine(lat, lng, e.lat, e.lng) <= radius)
}

function getPlayersExcept(socketId) {
  return [...players.values()].filter(p => p.id !== socketId).map(p => ({
    id: p.id, username: p.username, lat: p.lat, lng: p.lng, level: p.level
  }))
}

// ── Express ────────────────────────────────────────────────────────────────────

const app    = express()
const server = http.createServer(app)
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
})

app.use(cors())
app.use(express.json())

app.get('/health', (req, res) => {
  res.json({ status: 'ok', players: players.size, enemies: enemies.size })
})

// ── Socket.io ──────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('[CONNECT]', socket.id)

  // ── player:join ──────────────────────────────────────────────────────────────

  socket.on('player:join', (data) => {
    const { username, lat, lng } = data
    if (!username || typeof lat !== 'number' || typeof lng !== 'number') return

    const player = {
      id:         socket.id,
      username:   username.substring(0, 20).replace(/[<>]/g, ''),
      lat, lng,
      level:      1,
      xp:         0,
      resources:  0,
      lastAttack: 0,
      lastLat:    lat,
      lastLng:    lng,
      lastMoveTs: Date.now()
    }
    players.set(socket.id, player)

    // Spawner des ennemis pour ce joueur
    const spawned = ensureEnemiesForPlayer(player)
    spawned.forEach(e => {
      socket.broadcast.emit('enemy:spawned', { enemy: e })
    })

    // Envoyer l'état initial au joueur
    const nearbyEnemies  = getEnemiesNear(lat, lng, SPAWN_RADIUS + 2000)
    const otherPlayers   = getPlayersExcept(socket.id)
    socket.emit('game:init', { enemies: nearbyEnemies, players: otherPlayers })

    // Notifier les autres
    socket.broadcast.emit('player:joined', {
      id: player.id, username: player.username, lat, lng, level: player.level
    })

    console.log(`[JOIN] ${username} (${lat.toFixed(5)}, ${lng.toFixed(5)})`)
  })

  // ── player:move ──────────────────────────────────────────────────────────────

  socket.on('player:move', (data) => {
    const player = players.get(socket.id)
    if (!player) return

    const { lat, lng } = data
    if (typeof lat !== 'number' || typeof lng !== 'number') return

    // Anti-cheat : vitesse max
    const now     = Date.now()
    const elapsed = (now - player.lastMoveTs) / 1000
    const dist    = haversine(player.lastLat, player.lastLng, lat, lng)
    if (elapsed > 0 && dist / elapsed > MOVE_SPEED_MAX) {
      return  // Trop rapide, on ignore
    }

    player.lat        = lat
    player.lng        = lng
    player.lastLat    = lat
    player.lastLng    = lng
    player.lastMoveTs = now

    socket.broadcast.emit('player:moved', { id: socket.id, lat, lng })

    // Spawner si nécessaire
    const spawned = ensureEnemiesForPlayer(player)
    spawned.forEach(e => {
      io.emit('enemy:spawned', { enemy: e })
    })
  })

  // ── enemy:attack ─────────────────────────────────────────────────────────────

  socket.on('enemy:attack', (data) => {
    const player = players.get(socket.id)
    if (!player) return

    const { enemy_id } = data
    const enemy = enemies.get(enemy_id)
    if (!enemy) return

    // Anti-cheat : cooldown
    const now = Date.now()
    if (now - player.lastAttack < ATTACK_COOLDOWN - 200) return  // 200ms de tolérance
    player.lastAttack = now

    // Anti-cheat : portée
    const dist = haversine(player.lat, player.lng, enemy.lat, enemy.lng)
    if (dist > ATTACK_RANGE + 200) return  // 200m de tolérance

    // Calculer les dégâts (30 à 50 selon niveau joueur)
    const damage = 30 + (player.level - 1) * 5

    enemy.hp -= damage
    if (enemy.hp < 0) enemy.hp = 0

    if (enemy.hp <= 0) {
      // Ennemi détruit
      enemies.delete(enemy_id)
      io.emit('enemy:destroyed', { enemy_id, killer_id: socket.id })

      // Récompense uniquement au tueur
      player.xp        += enemy.xp
      player.resources += enemy.resources

      const newLevel = computeLevel(player.xp)
      if (newLevel > player.level) player.level = newLevel

      socket.emit('player:reward', { xp: enemy.xp, resources: enemy.resources, fer: enemy.fer })

      // Respawn après délai
      const spawnLat = enemy.lat
      const spawnLng = enemy.lng
      setTimeout(() => {
        const respawned = spawnEnemy(spawnLat, spawnLng)
        io.emit('enemy:spawned', { enemy: respawned })
      }, RESPAWN_DELAY)

    } else {
      // Ennemi touché
      io.emit('enemy:hit', { enemy_id, hp: enemy.hp, player_id: socket.id })

      // Riposte de l'ennemi (60-80% selon niveau)
      const retaliationChance = 0.6 + (enemy.level - 1) * 0.05
      if (Math.random() < retaliationChance) {
        const baseDamage = enemy.level * 8  // 8, 16, 24, 32, 40
        socket.emit('city:hit', { damage: baseDamage, enemy_name: enemy.name })
      }
    }
  })

  // ── disconnect ───────────────────────────────────────────────────────────────

  socket.on('disconnect', (reason) => {
    const player = players.get(socket.id)
    if (player) {
      console.log(`[LEAVE] ${player.username} (${reason})`)
      players.delete(socket.id)
      socket.broadcast.emit('player:left', { id: socket.id })
    }
  })
})

// ── Utils ──────────────────────────────────────────────────────────────────────

function computeLevel(xp) {
  const thresholds = [0, 100, 300, 700, 1500, Infinity]
  for (let i = thresholds.length - 2; i >= 0; i--) {
    if (xp >= thresholds[i]) return i + 1
  }
  return 1
}

// ── Start ──────────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  console.log(`TestClaude server listening on :${PORT}`)
  console.log(`Health: http://localhost:${PORT}/health`)
})
