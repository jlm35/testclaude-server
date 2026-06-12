# TestClaude — Serveur de jeu

Serveur Node.js + Socket.io pour le GPS MMORPG TestClaude.

## Démarrage rapide (réseau local)

```bash
cd server
npm install
npm start
```

Le serveur écoute sur le port `3000`. Note ton adresse IP locale (`ipconfig` sur Windows, `ip a` sur Linux), puis modifie `config.js` dans les assets Android :

```js
SERVER_URL: 'http://192.168.1.TON_IP:3000'
```

## Variables d'environnement

| Variable | Défaut | Description |
|----------|--------|-------------|
| `PORT`   | `3000` | Port d'écoute |

## Endpoints

| Route | Description |
|-------|-------------|
| `GET /health` | Statut du serveur, nombre de joueurs et d'ennemis actifs |

## Déploiement Oracle Cloud (Always Free)

### 1. Créer la VM

- Connecte-toi sur [cloud.oracle.com](https://cloud.oracle.com)
- Compute > Instances > Create Instance
- Shape : VM.Standard.E2.1.Micro (gratuit)
- Image : Ubuntu 22.04
- Ajoute ta clé SSH publique

### 2. Ouvrir le port 3000

Dans le Security List de ton VCN, ajoute une règle Ingress :
- Source CIDR : `0.0.0.0/0`
- Protocol : TCP
- Port : `3000`

Sur la VM, ouvre aussi le firewall système :

```bash
sudo iptables -I INPUT -p tcp --dport 3000 -j ACCEPT
sudo netfilter-persistent save
```

### 3. Installer Node.js et déployer

```bash
# Installer Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Copier les fichiers serveur sur la VM (depuis ton PC)
scp -r server/ ubuntu@TON_IP_ORACLE:~/testclaude-server/

# Sur la VM
cd ~/testclaude-server
npm install

# Lancer avec PM2 (auto-restart)
sudo npm install -g pm2
pm2 start server.js --name testclaude
pm2 startup
pm2 save
```

### 4. Mettre à jour config.js

```js
SERVER_URL: 'http://TON_IP_ORACLE:3000'
```

Recompile et installe l'APK.

## Architecture

```
Client Android (WebView)
        |
        | Socket.io (WebSocket)
        |
   server.js
        |
    In-memory Maps
    players: Map<socketId, player>
    enemies: Map<enemyId, enemy>
```

Aucune base de données pour ce module. Les données sont perdues au redémarrage. PostgreSQL sera ajouté dans un module ultérieur pour la persistance.

## Événements Socket.io

### Client → Serveur

| Événement | Payload | Description |
|-----------|---------|-------------|
| `player:join` | `{username, lat, lng}` | Connexion au jeu |
| `player:move` | `{lat, lng}` | Mise à jour de position |
| `enemy:attack` | `{enemy_id, weapon_id}` | Attaque d'un ennemi |

### Serveur → Client(s)

| Événement | Payload | Destinataire |
|-----------|---------|--------------|
| `game:init` | `{enemies[], players[]}` | Joueur connecté |
| `player:joined` | `{id, username, lat, lng, level}` | Tous sauf le nouveau |
| `player:moved` | `{id, lat, lng}` | Tous sauf l'émetteur |
| `player:left` | `{id}` | Tous |
| `enemy:hit` | `{enemy_id, hp, player_id}` | Tous |
| `enemy:destroyed` | `{enemy_id, killer_id}` | Tous |
| `enemy:spawned` | `{enemy}` | Tous |
| `player:reward` | `{xp, resources}` | Joueur killer uniquement |
