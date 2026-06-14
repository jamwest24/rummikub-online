/* Rummikub Online — authoritative game server.
 * Serves the client and a WebSocket endpoint on one port.
 * The server owns the deck, deals private racks, and validates every turn,
 * so clients can't see each other's tiles or submit illegal plays.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;

/* ===================== rules engine ===================== */
const COLORS = ['r', 'b', 'o', 'k'];
let _uid = 0;
const uid = p => p + (_uid++);

function buildDeck() {
  const tiles = new Map();
  for (const c of COLORS) for (let n = 1; n <= 13; n++) for (let k = 0; k < 2; k++) {
    const id = uid('t'); tiles.set(id, { id, color: c, num: n, joker: false });
  }
  for (let k = 0; k < 2; k++) { const id = uid('j'); tiles.set(id, { id, joker: true }); }
  const order = [...tiles.keys()];
  for (let i = order.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [order[i], order[j]] = [order[j], order[i]]; }
  return { tiles, order };
}
function isValidGroup(ts) {
  if (ts.length < 3 || ts.length > 4) return false;
  const reals = ts.filter(t => !t.joker);
  if (reals.length) {
    const n = reals[0].num;
    if (!reals.every(t => t.num === n)) return false;
    if (new Set(reals.map(t => t.color)).size !== reals.length) return false;
  }
  return true;
}
function runStart(ts) {
  let s = null;
  for (let i = 0; i < ts.length; i++) { if (ts[i].joker) continue; const v = ts[i].num - i; if (s === null) s = v; else if (s !== v) return null; }
  return s;
}
function isValidRun(ts) {
  if (ts.length < 3 || ts.length > 13) return false;
  const reals = ts.filter(t => !t.joker);
  if (reals.length) { const c = reals[0].color; if (!reals.every(t => t.color === c)) return false; }
  const s = runStart(ts);
  return s !== null && s >= 1 && s + ts.length - 1 <= 13;
}
const isValidSet = ts => isValidGroup(ts) || isValidRun(ts);
function setValue(ts) {
  if (isValidGroup(ts)) { const n = (ts.find(t => !t.joker) || {}).num || 0; return n * ts.length; }
  if (isValidRun(ts)) { const s = runStart(ts); let v = 0; for (let i = 0; i < ts.length; i++) v += s + i; return v; }
  return 0;
}
const handScore = rack => rack.reduce((s, t) => s + (t.joker ? 30 : t.num), 0);
const sig = set => set.map(t => t.id).sort().join(',');

/* Validate a proposed end-of-turn board.
 * preBoardSets/rackTiles/proposedSets are arrays of tile OBJECTS. */
function validateProposal(preBoardSets, rackTiles, proposedSets, melded) {
  const rackIds = new Set(rackTiles.map(t => t.id));
  const preIds = new Set(preBoardSets.flat().map(t => t.id));
  const seen = new Set();
  for (const s of proposedSets) for (const t of s) {
    if (seen.has(t.id)) return { ok: false, error: 'A tile is used twice.' };
    seen.add(t.id);
    if (!preIds.has(t.id) && !rackIds.has(t.id)) return { ok: false, error: 'Unknown tile in your play.' };
  }
  for (const id of preIds) if (!seen.has(id)) return { ok: false, error: 'Tiles already on the table must stay on the table.' };
  const sets = proposedSets.filter(s => s.length > 0);
  for (const s of sets) if (s.length < 3 || !isValidSet(s)) return { ok: false, error: 'Every group must be a valid run or set of 3 or more.' };
  const played = [...seen].filter(id => rackIds.has(id));
  if (played.length === 0) return { ok: false, error: 'Play at least one tile, or draw a tile instead.' };
  if (!melded) {
    const preSigs = preBoardSets.map(sig).sort();
    const oldSigs = []; let sum = 0;
    for (const s of sets) {
      const allNew = s.every(t => rackIds.has(t.id));
      const allOld = s.every(t => preIds.has(t.id));
      if (allNew) sum += setValue(s);
      else if (allOld) oldSigs.push(sig(s));
      else return { ok: false, error: 'On your first play, keep your tiles in their own new groups.' };
    }
    if (oldSigs.sort().join('|') !== preSigs.join('|')) return { ok: false, error: "On your first play you can't rearrange the table yet." };
    if (sum < 30) return { ok: false, error: `Your first play must total at least 30 points (it's ${sum}).` };
  }
  return { ok: true, playedIds: played };
}

/* ===================== static server ===================== */
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
const server = http.createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';
  const file = path.join(PUBLIC, path.normalize(url).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ===================== rooms ===================== */
const rooms = new Map();
const code4 = () => { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let s = ''; for (let i = 0; i < 4; i++) s += a[Math.random() * a.length | 0]; return s; };

function newRoom() {
  let code; do { code = code4(); } while (rooms.has(code));
  const room = {
    code, hostId: null,
    players: new Map(),       // id -> {id,name,ws,connected,rack:[ids],melded}
    order: [],                // turn order of player ids
    tiles: new Map(),         // id -> tile object (canonical deck)
    board: [],                // array of arrays of ids
    pool: [],                 // array of ids
    phase: 'lobby',           // lobby | play | over
    turnIdx: 0, turnSeq: 0,
    passes: 0, winner: null,
    touched: Date.now()
  };
  rooms.set(code, room);
  return room;
}
const touch = r => r.touched = Date.now();
const tilesOf = (room, ids) => ids.map(id => room.tiles.get(id));
const currentId = room => room.order[room.turnIdx];

function deal(room) {
  const { tiles, order } = buildDeck();
  room.tiles = tiles; room.pool = order;
  for (const pid of room.order) {
    const p = room.players.get(pid);
    p.rack = room.pool.splice(0, 14); p.melded = false;
  }
  room.board = []; room.turnIdx = 0; room.turnSeq++; room.passes = 0; room.winner = null;
  room.phase = 'play';
}

/* ===================== state projection ===================== */
function playerView(room, id) {
  const me = room.players.get(id);
  const view = {
    code: room.code, phase: room.phase, hostId: room.hostId, turnSeq: room.turnSeq,
    poolCount: room.pool.length,
    board: room.board.map(set => tilesOf(room, set)),
    players: room.order.map(pid => { const p = room.players.get(pid); return { id: p.id, name: p.name, tiles: p.rack.length, connected: p.connected, melded: p.melded, isTurn: pid === currentId(room) }; }),
    turnId: room.phase === 'play' ? currentId(room) : null,
    turnName: room.phase === 'play' ? room.players.get(currentId(room))?.name : null,
    you: me ? { id: me.id, name: me.name, rack: tilesOf(room, me.rack), melded: me.melded, yourTurn: room.phase === 'play' && currentId(room) === me.id } : null
  };
  if (room.phase === 'over' && room.winner) {
    view.winnerName = room.players.get(room.winner)?.name;
    view.standings = room.order.map(pid => { const p = room.players.get(pid); return { name: p.name, left: handScore(tilesOf(room, p.rack)) }; }).sort((a, b) => a.left - b.left);
  }
  return view;
}
const send = (ws, msg) => { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); } catch (_) {} };
function broadcast(room) { for (const p of room.players.values()) send(p.ws, { type: 'state', state: playerView(room, p.id) }); }

/* ===================== turn flow ===================== */
function advance(room) {
  if (room.phase !== 'play') return;
  room.turnIdx = (room.turnIdx + 1) % room.order.length;
  room.turnSeq++;
  if (room.passes >= room.order.length && room.pool.length === 0) endByScore(room);
}
function endByScore(room) {
  let best = null;
  for (const pid of room.order) { const s = handScore(tilesOf(room, room.players.get(pid).rack)); if (!best || s < best.s) best = { pid, s }; }
  room.winner = best.pid; room.phase = 'over';
}

/* ===================== websocket ===================== */
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);
  ws.on('message', buf => { let m; try { m = JSON.parse(buf.toString()); } catch { return; } handle(ws, m); });
  ws.on('close', () => {
    const room = ws.roomCode && rooms.get(ws.roomCode); if (!room) return;
    const p = room.players.get(ws.playerId);
    if (p && p.ws === ws) { p.connected = false; broadcast(room); }
  });
});

function handle(ws, m) {
  switch (m.type) {
    case 'create': {
      const room = newRoom();
      const id = crypto.randomUUID();
      const name = (m.name || '').trim().slice(0, 14) || 'Player';
      room.players.set(id, { id, name, ws, connected: true, rack: [], melded: false });
      room.order.push(id); room.hostId = id;
      ws.roomCode = room.code; ws.playerId = id;
      send(ws, { type: 'joined', playerId: id, code: room.code });
      broadcast(room); break;
    }
    case 'join': {
      const room = rooms.get((m.code || '').toUpperCase());
      if (!room) return send(ws, { type: 'error', message: 'No game with that code.' });
      const name = (m.name || '').trim().slice(0, 14) || 'Player';
      let p = m.playerId && room.players.get(m.playerId);
      if (!p) {
        // reclaim a disconnected seat with the same name — lets you rejoin from any device
        for (const cand of room.players.values()) {
          if (!cand.connected && cand.name.toLowerCase() === name.toLowerCase()) { p = cand; break; }
        }
      }
      if (p) { p.ws = ws; p.connected = true; p.name = name; }   // reconnect / reclaim
      else {
        if (room.phase !== 'lobby') return send(ws, { type: 'error', message: 'This game is in progress — to get back in, join with the exact name you were using.' });
        if (room.order.length >= 4) return send(ws, { type: 'error', message: 'That game is full (4 players).' });
        const id = crypto.randomUUID();
        p = { id, name, ws, connected: true, rack: [], melded: false };
        room.players.set(id, p); room.order.push(id);
      }
      ws.roomCode = room.code; ws.playerId = p.id;
      send(ws, { type: 'joined', playerId: p.id, code: room.code });
      touch(room); broadcast(room); break;
    }
    case 'start': {
      const room = rooms.get(ws.roomCode); if (!room || room.hostId !== ws.playerId) return;
      if (room.phase === 'lobby' && room.order.length >= 2) { deal(room); touch(room); broadcast(room); }
      else send(ws, { type: 'error', message: 'Need at least 2 players to start.' });
      break;
    }
    case 'commit': {
      const room = rooms.get(ws.roomCode); if (!room || room.phase !== 'play') return;
      const p = room.players.get(ws.playerId); if (!p || currentId(room) !== p.id) return;
      // reconstruct proposed sets from ids
      const proposed = (m.board || []).map(set => set.map(id => room.tiles.get(id)).filter(Boolean));
      const preBoard = room.board.map(set => tilesOf(room, set));
      const rackTiles = tilesOf(room, p.rack);
      const v = validateProposal(preBoard, rackTiles, proposed, p.melded);
      if (!v.ok) return send(ws, { type: 'reject', message: v.error });
      // apply
      const playedSet = new Set(v.playedIds);
      p.rack = p.rack.filter(id => !playedSet.has(id));
      room.board = proposed.filter(s => s.length).map(s => s.map(t => t.id));
      if (!p.melded) p.melded = true;
      room.passes = 0;
      if (p.rack.length === 0) { room.winner = p.id; room.phase = 'over'; touch(room); broadcast(room); break; }
      advance(room); touch(room); broadcast(room); break;
    }
    case 'draw': {
      const room = rooms.get(ws.roomCode); if (!room || room.phase !== 'play') return;
      const p = room.players.get(ws.playerId); if (!p || currentId(room) !== p.id) return;
      if (room.pool.length) { p.rack.push(room.pool.shift()); room.passes = 0; }
      else { room.passes++; }
      advance(room); touch(room); broadcast(room); break;
    }
    case 'rematch': {
      const room = rooms.get(ws.roomCode); if (!room || room.hostId !== ws.playerId) return;
      if (room.phase === 'over' && room.order.length >= 2) { deal(room); touch(room); broadcast(room); }
      break;
    }
  }
}

/* keepalive + sweep */
setInterval(() => { wss.clients.forEach(ws => { if (ws.isAlive === false) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch {} }); }, 30000);
setInterval(() => { const now = Date.now(); for (const [c, r] of rooms) { const live = [...r.players.values()].some(p => p.connected); if (!live && now - r.touched > ROOM_TTL_MS) rooms.delete(c); } }, 10 * 60 * 1000);

server.listen(PORT, () => console.log(`Rummikub Online on http://localhost:${PORT}`));

module.exports = { rooms, validateProposal, isValidSet, setValue, buildDeck };
