/**
 * Anonymous Chat Backend Server
 * Handles authentication, user search, realtime chat, presence, and offline messages.
 */

require('dotenv').config();

const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || JWT_SECRET;
const ADMIN_TOKEN_TTL = process.env.ADMIN_TOKEN_TTL || '12h';
const DB_PATH = path.join(__dirname, 'anonymous-chat.db');
const JSON_LIMIT = process.env.JSON_LIMIT || '30mb';
const MAX_TEXT_LENGTH = 2000;
const MAX_DISPLAY_NAME_LENGTH = 60;
const MAX_SEARCH_LENGTH = 80;
const MAX_MEDIA_DATA_LENGTH = 8 * 1024 * 1024; // base64/data URL chars
const MAX_REACTIONS_PER_MESSAGE = 64;
const MAX_FILE_NAME_LENGTH = 180;

app.disable('x-powered-by');

app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
});

app.use(express.json({ limit: JSON_LIMIT, strict: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Database open error:', err);
    process.exit(1);
  }

  initializeDatabase().catch((error) => {
    console.error('Database initialization error:', error);
    process.exit(1);
  });

  ensureAdminAccount().catch((error) => {
    console.error('Admin seed error:', error);
  });
});

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row || null);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows || []);
    });
  });
}

function sanitizeStringInput(value, maxLength) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, maxLength);
}

function sanitizeDisplayName(value) {
  return sanitizeStringInput(value, MAX_DISPLAY_NAME_LENGTH).trim();
}

function sanitizeMessageText(value) {
  return sanitizeStringInput(value, MAX_TEXT_LENGTH).trim();
}

function sanitizeSearchTerm(value) {
  return sanitizeStringInput(value, MAX_SEARCH_LENGTH).trim();
}

function sanitizeMediaData(value) {
  const raw = String(value || '');
  if (!raw) return '';
  if (raw.length > MAX_MEDIA_DATA_LENGTH) {
    return '';
  }
  return raw;
}

function sanitizeFileName(value) {
  return sanitizeStringInput(value, MAX_FILE_NAME_LENGTH).trim();
}

function sanitizeFileMime(value) {
  return sanitizeStringInput(value, 120).trim().toLowerCase();
}

function normalizeEmoji(value) {
  return String(value || '').trim().slice(0, 16);
}

function isValidEmoji(value) {
  const emoji = normalizeEmoji(value);
  if (!emoji) return false;
  return /\p{Extended_Pictographic}/u.test(emoji);
}

function createRateLimiter({ windowMs, maxRequests, keyPrefix }) {
  const buckets = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const ip = String(req.ip || req.headers['x-forwarded-for'] || 'unknown');
    const key = `${keyPrefix}:${ip}`;
    const bucket = buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      buckets.set(key, {
        count: 1,
        resetAt: now + windowMs
      });
      next();
      return;
    }

    if (bucket.count >= maxRequests) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Too many requests, please try again shortly.' });
      return;
    }

    bucket.count += 1;
    buckets.set(key, bucket);
    next();
  };
}

const authRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 60,
  keyPrefix: 'auth'
});

const messageRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 240,
  keyPrefix: 'messages'
});

const searchRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 180,
  keyPrefix: 'search'
});

const adminAuthRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 50,
  keyPrefix: 'adminAuth'
});

async function ensureColumn(tableName, columnName, definition) {
  const tableInfo = await all(`PRAGMA table_info(${tableName})`);
  const alreadyExists = tableInfo.some((col) => col && col.name === columnName);
  if (alreadyExists) {
    return;
  }

  await run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

async function initializeDatabase() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      displayName TEXT NOT NULL,
      avatar TEXT,
      createdAt INTEGER,
      updatedAt INTEGER,
      online INTEGER DEFAULT 0,
      lastSeen INTEGER
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      clientMessageId TEXT,
      fromUserId TEXT NOT NULL,
      toUserId TEXT NOT NULL,
      groupId TEXT DEFAULT '',
      groupName TEXT DEFAULT '',
      groupPicture TEXT DEFAULT '',
      text TEXT,
      type TEXT DEFAULT 'text',
      voiceData TEXT,
      mediaData TEXT,
      fileName TEXT DEFAULT '',
      fileMime TEXT DEFAULT '',
      fileSize INTEGER DEFAULT 0,
      durationSec INTEGER DEFAULT 0,
      replyTo TEXT,
      senderName TEXT,
      senderPicture TEXT,
      reaction TEXT DEFAULT '',
      reactions TEXT DEFAULT '[]',
      editedAt INTEGER,
      deletedForEveryone INTEGER DEFAULT 0,
      timestamp INTEGER,
      delivered INTEGER DEFAULT 0,
      deliveredAt INTEGER,
      readAt INTEGER,
      status TEXT DEFAULT 'sent',
      FOREIGN KEY(fromUserId) REFERENCES users(id),
      FOREIGN KEY(toUserId) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      fromUserId TEXT NOT NULL,
      toUserId TEXT NOT NULL,
      type TEXT,
      data TEXT,
      timestamp INTEGER,
      FOREIGN KEY(fromUserId) REFERENCES users(id),
      FOREIGN KEY(toUserId) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL UNIQUE,
      wsId TEXT,
      connectedAt INTEGER,
      FOREIGN KEY(userId) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS privacy_settings (
      userId TEXT PRIMARY KEY,
      showOnline INTEGER DEFAULT 1,
      lastSeenVisibility TEXT DEFAULT 'contacts',
      updatedAt INTEGER,
      FOREIGN KEY(userId) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS blocked_users (
      blockerUserId TEXT NOT NULL,
      blockedUserId TEXT NOT NULL,
      createdAt INTEGER,
      PRIMARY KEY (blockerUserId, blockedUserId),
      FOREIGN KEY(blockerUserId) REFERENCES users(id),
      FOREIGN KEY(blockedUserId) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS banned_users (
      id TEXT PRIMARY KEY,
      reason TEXT,
      createdAt INTEGER
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      passwordHash TEXT NOT NULL,
      createdAt INTEGER
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS reported_messages (
      id TEXT PRIMARY KEY,
      messageId TEXT NOT NULL,
      reporterId TEXT NOT NULL,
      fromUserId TEXT NOT NULL,
      toUserId TEXT NOT NULL,
      reason TEXT,
      messageText TEXT,
      createdAt INTEGER,
      FOREIGN KEY(messageId) REFERENCES messages(id),
      FOREIGN KEY(reporterId) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS hidden_presence_users (
      ownerUserId TEXT NOT NULL,
      hiddenFromUserId TEXT NOT NULL,
      createdAt INTEGER,
      PRIMARY KEY (ownerUserId, hiddenFromUserId),
      FOREIGN KEY(ownerUserId) REFERENCES users(id),
      FOREIGN KEY(hiddenFromUserId) REFERENCES users(id)
    )
  `);

  await ensureColumn('messages', 'clientMessageId', 'TEXT');
  await ensureColumn('messages', 'groupId', "TEXT DEFAULT ''");
  await ensureColumn('messages', 'groupName', "TEXT DEFAULT ''");
  await ensureColumn('messages', 'groupPicture', "TEXT DEFAULT ''");
  await ensureColumn('messages', 'mediaData', 'TEXT');
  await ensureColumn('messages', 'fileName', "TEXT DEFAULT ''");
  await ensureColumn('messages', 'fileMime', "TEXT DEFAULT ''");
  await ensureColumn('messages', 'fileSize', 'INTEGER DEFAULT 0');
  await ensureColumn('messages', 'durationSec', 'INTEGER DEFAULT 0');
  await ensureColumn('messages', 'replyTo', 'TEXT');
  await ensureColumn('messages', 'senderName', 'TEXT');
  await ensureColumn('messages', 'senderPicture', 'TEXT');
  await ensureColumn('messages', 'reaction', "TEXT DEFAULT ''");
  await ensureColumn('messages', 'reactions', "TEXT DEFAULT '[]'");
  await ensureColumn('messages', 'editedAt', 'INTEGER');
  await ensureColumn('messages', 'deletedForEveryone', 'INTEGER DEFAULT 0');
  await ensureColumn('messages', 'deliveredAt', 'INTEGER');
  await ensureColumn('messages', 'readAt', 'INTEGER');
  await ensureColumn('messages', 'status', "TEXT DEFAULT 'sent'");
  await ensureColumn('privacy_settings', 'showOnline', 'INTEGER DEFAULT 1');
  await ensureColumn('privacy_settings', 'lastSeenVisibility', "TEXT DEFAULT 'contacts'");
  await ensureColumn('privacy_settings', 'updatedAt', 'INTEGER');

  console.log('Connected to SQLite database:', DB_PATH);
  console.log('Database tables initialized');
}

async function ensureAdminAccount() {
  const existing = await get('SELECT username FROM admins WHERE lower(username) = lower(?)', [ADMIN_USERNAME]);
  if (existing) return;

  const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  await run(
    'INSERT INTO admins (username, passwordHash, createdAt) VALUES (?, ?, ?)',
    [ADMIN_USERNAME, hash, Date.now()]
  );
  console.log(`Seeded admin account "${ADMIN_USERNAME}"`);
}

const wsConnections = new Map(); // userId -> Set<WebSocket>
const onlineUsers = new Map();
const socketUsers = new Map(); // WebSocket -> userId
const offlineDeliveryInFlight = new Map(); // userId -> Promise<{messages: any[], pushed: boolean}>

const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,20}$/;

function normalizeUsernameBase(value) {
  return sanitizeSearchTerm(value)
    .replace(/^@/, '')
    .replace(/@zy(?:\.com)?$/i, '')
    .replace(/[^a-zA-Z0-9_]/g, '');
}

function formatUsernameHandle(base) {
  return `@${base}@Zy`;
}

function buildUsernameSuggestions(base) {
  const clean = normalizeUsernameBase(base) || 'user';
  return [
    formatUsernameHandle(`${clean}2`),
    formatUsernameHandle(`${clean}99`),
    formatUsernameHandle(`${clean}_chat`)
  ];
}

function normalizeSearchQuery(query) {
  return sanitizeSearchTerm(query)
    .replace(/^@/, '')
    .replace(/@zy(?:\.com)?$/i, '')
    .replace(/[^\p{L}\p{N}_\s@.-]/gu, '');
}

function normalizeLastSeenVisibility(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'everyone' || raw === 'contacts' || raw === 'nobody') {
    return raw;
  }
  return 'contacts';
}

async function ensurePrivacySettingsRow(userId) {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) return;

  await run(
    `INSERT INTO privacy_settings (userId, showOnline, lastSeenVisibility, updatedAt)
     VALUES (?, 1, 'contacts', ?)
     ON CONFLICT(userId) DO NOTHING`,
    [normalizedUserId, Date.now()]
  );
}

async function getPrivacySettings(userId) {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) {
    return {
      showOnline: true,
      lastSeenVisibility: 'contacts'
    };
  }

  await ensurePrivacySettingsRow(normalizedUserId);
  const row = await get(
    'SELECT showOnline, lastSeenVisibility FROM privacy_settings WHERE userId = ?',
    [normalizedUserId]
  );

  return {
    showOnline: !row || Number(row.showOnline) !== 0,
    lastSeenVisibility: normalizeLastSeenVisibility(row && row.lastSeenVisibility)
  };
}

async function isUserBlocked(blockerUserId, blockedUserId) {
  const blocker = String(blockerUserId || '').trim();
  const blocked = String(blockedUserId || '').trim();
  if (!blocker || !blocked) return false;

  const row = await get(
    'SELECT 1 AS value FROM blocked_users WHERE blockerUserId = ? AND blockedUserId = ?',
    [blocker, blocked]
  );
  return Boolean(row && row.value);
}

async function canUsersInteract(userAId, userBId) {
  const userA = String(userAId || '').trim();
  const userB = String(userBId || '').trim();
  if (!userA || !userB) return false;
  if (userA === userB) return true;

  const [aBlockedB, bBlockedA] = await Promise.all([
    isUserBlocked(userA, userB),
    isUserBlocked(userB, userA)
  ]);

  return !aBlockedB && !bBlockedA;
}

async function assertMessagingAllowed(fromUserId, toUserId) {
  const sender = String(fromUserId || '').trim();
  const recipient = String(toUserId || '').trim();
  if (!sender || !recipient) return;

  const [blockedByRecipient, blockedBySender] = await Promise.all([
    isUserBlocked(recipient, sender),
    isUserBlocked(sender, recipient)
  ]);

  if (blockedByRecipient) {
    const error = new Error('You cannot send messages to this user.');
    error.code = 403;
    throw error;
  }

  if (blockedBySender) {
    const error = new Error('Unblock this user before sending messages.');
    error.code = 403;
    throw error;
  }
}

async function canViewerSeePresence(targetUserId, viewerUserId) {
  const target = String(targetUserId || '').trim();
  const viewer = String(viewerUserId || '').trim();
  if (!target || !viewer) return false;
  if (target === viewer) return true;

  const interactionAllowed = await canUsersInteract(target, viewer);
  if (!interactionAllowed) return false;

  const settings = await getPrivacySettings(target);
  if (!settings.showOnline) return false;

  const hiddenRow = await get(
    'SELECT 1 AS value FROM hidden_presence_users WHERE ownerUserId = ? AND hiddenFromUserId = ?',
    [target, viewer]
  );
  return !(hiddenRow && hiddenRow.value);
}

async function projectUserForViewer(userRow, viewerUserId) {
  if (!userRow || !userRow.id) return userRow;

  const viewer = String(viewerUserId || '').trim();
  const target = String(userRow.id || '').trim();
  const settings = await getPrivacySettings(target);

  const [blockedByMe, blockedMe, presenceVisible] = await Promise.all([
    isUserBlocked(viewer, target),
    isUserBlocked(target, viewer),
    canViewerSeePresence(target, viewer)
  ]);

  let showLastSeen = false;
  if (!blockedByMe && !blockedMe) {
    if (settings.lastSeenVisibility === 'everyone') {
      showLastSeen = true;
    } else if (settings.lastSeenVisibility === 'contacts') {
      showLastSeen = true;
    }
  }

  return {
    ...userRow,
    online: presenceVisible ? Boolean(userRow.online) : false,
    lastSeen: showLastSeen ? userRow.lastSeen : null,
    blockedByMe,
    blockedMe
  };
}

function parseReply(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseReactions(value, fallbackReaction, fallbackUserId) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = [];
    }
  }

  const normalized = [];
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const userId = String(entry.userId || entry.user || '').trim();
      const emoji = normalizeEmoji(entry.emoji);
      if (!userId || !isValidEmoji(emoji)) continue;
      const existingIndex = normalized.findIndex((item) => item.userId === userId);
      const safeEntry = {
        userId,
        emoji,
        timestamp: normalizeTimestamp(entry.timestamp || Date.now())
      };
      if (existingIndex >= 0) {
        normalized.splice(existingIndex, 1, safeEntry);
      } else {
        normalized.push(safeEntry);
      }
    }
  }

  if (!normalized.length && isValidEmoji(fallbackReaction)) {
    normalized.push({
      userId: String(fallbackUserId || '').trim() || 'legacy',
      emoji: normalizeEmoji(fallbackReaction),
      timestamp: Date.now()
    });
  }

  return normalized.slice(0, MAX_REACTIONS_PER_MESSAGE);
}

function serializeReactions(value, fallbackReaction, fallbackUserId) {
  return JSON.stringify(parseReactions(value, fallbackReaction, fallbackUserId));
}

function normalizeTimestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return Date.now();
  }

  if (numeric < 1_000_000_000_000) {
    return Math.round(numeric * 1000);
  }

  return Math.round(numeric);
}

function messageStatusFromRow(row) {
  if (!row) return 'sent';
  if (row.readAt) return 'read';
  if (row.delivered) return 'delivered';
  if (row.status) return row.status;
  return 'sent';
}

function serializeMessage(row) {
  if (!row) return null;
  const kind = row.type || 'text';
  const mediaData = row.mediaData || row.voiceData || '';
  const reactions = parseReactions(row.reactions, row.reaction, row.fromUserId);
  const lastReaction = reactions.length ? reactions[reactions.length - 1].emoji : '';

  return {
    id: row.id,
    clientMessageId: row.clientMessageId || row.id,
    fromUserId: row.fromUserId,
    toUserId: row.toUserId,
    groupId: String(row.groupId || '').trim(),
    groupName: sanitizeDisplayName(row.groupName || ''),
    groupPicture: row.groupPicture || '',
    text: row.text || '',
    type: kind,
    kind,
    voiceData: kind === 'voice' ? mediaData : '',
    audioData: kind === 'voice' ? mediaData : '',
    imageData: kind === 'image' ? mediaData : '',
    mediaData,
    fileName: row.fileName || '',
    fileMime: row.fileMime || '',
    fileSize: Number(row.fileSize || 0),
    durationSec: Number(row.durationSec || 0),
    replyTo: parseReply(row.replyTo),
    senderName: sanitizeDisplayName(row.senderName || ''),
    senderPicture: row.senderPicture || '',
    reactions,
    reaction: lastReaction,
    editedAt: row.editedAt || null,
    deletedForEveryone: Boolean(row.deletedForEveryone),
    timestamp: Number(row.timestamp || Date.now()),
    delivered: Boolean(row.delivered),
    deliveredAt: row.deliveredAt || null,
    readAt: row.readAt || null,
    status: messageStatusFromRow(row)
  };
}

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return '';
  }
  return header.slice('Bearer '.length).trim();
}

function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.auth = {
      userId: String(decoded.userId || ''),
      username: String(decoded.username || '')
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

async function isUserBanned(userId) {
  const row = await get('SELECT id FROM banned_users WHERE id = ?', [String(userId || '').trim()]);
  return Boolean(row && row.id);
}

function createAdminToken(username) {
  return jwt.sign({ role: 'admin', username }, ADMIN_JWT_SECRET, { expiresIn: ADMIN_TOKEN_TTL });
}

function requireAdminAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const decoded = jwt.verify(token, ADMIN_JWT_SECRET);
    if (!decoded || decoded.role !== 'admin') {
      res.status(401).json({ error: 'Invalid admin token' });
      return;
    }

    req.admin = {
      username: String(decoded.username || 'admin')
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid admin token' });
  }
}

function getSocketsForUser(userId) {
  const key = String(userId || '');
  if (!key) return new Set();

  const sockets = wsConnections.get(key);
  if (!sockets || !(sockets instanceof Set)) {
    return new Set();
  }

  const openSockets = new Set();
  for (const socket of sockets) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      openSockets.add(socket);
    } else if (socket) {
      socketUsers.delete(socket);
    }
  }

  if (openSockets.size !== sockets.size) {
    if (openSockets.size) {
      wsConnections.set(key, openSockets);
    } else {
      wsConnections.delete(key);
    }
  }

  return openSockets;
}

function hasOpenSocketForUser(userId) {
  return getSocketsForUser(userId).size > 0;
}

function attachSocketForUser(userId, socket) {
  const key = String(userId || '');
  if (!key || !socket) return 0;

  const sockets = wsConnections.get(key) || new Set();
  sockets.add(socket);
  wsConnections.set(key, sockets);
  socketUsers.set(socket, key);
  return getSocketsForUser(key).size;
}

function detachSocketForUser(userId, socket) {
  const key = String(userId || '');
  if (!key) return 0;

  const sockets = wsConnections.get(key);
  if (!sockets) return 0;

  if (socket) {
    sockets.delete(socket);
    socketUsers.delete(socket);
  }

  if (!sockets.size) {
    wsConnections.delete(key);
    return 0;
  }

  wsConnections.set(key, sockets);
  return getSocketsForUser(key).size;
}

function totalOpenSocketCount() {
  let total = 0;
  for (const userId of wsConnections.keys()) {
    total += getSocketsForUser(userId).size;
  }
  return total;
}

async function countGroups() {
  const row = await get(
    `SELECT COUNT(DISTINCT TRIM(groupId)) AS count
     FROM messages
     WHERE TRIM(groupId) IS NOT NULL AND TRIM(groupId) != ''`
  );
  return Number(row && row.count) || 0;
}

async function countActiveChats({ sinceMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
  const since = Date.now() - sinceMs;
  const row = await get(
    `SELECT COUNT(DISTINCT chatKey) AS count FROM (
       SELECT
         CASE
           WHEN TRIM(groupId) IS NOT NULL AND TRIM(groupId) != '' THEN 'g:' || TRIM(groupId)
           ELSE 'p:' || CASE
             WHEN fromUserId < toUserId THEN fromUserId || ':' || toUserId
             ELSE toUserId || ':' || fromUserId
           END
         END AS chatKey
       FROM messages
       WHERE timestamp >= ?
     ) WHERE chatKey IS NOT NULL AND chatKey != ''`,
    [since]
  );
  return Number(row && row.count) || 0;
}

async function deleteUserCompletely(userId) {
  const normalizedId = String(userId || '').trim();
  if (!normalizedId) return { deleted: false };

  await run('DELETE FROM banned_users WHERE id = ?', [normalizedId]);
  await run('DELETE FROM reported_messages WHERE reporterId = ? OR fromUserId = ? OR toUserId = ?', [normalizedId, normalizedId, normalizedId]);

  const sockets = getSocketsForUser(normalizedId);
  for (const ws of sockets) {
    try {
      ws.close(4001, 'Account removed');
    } catch {
      // noop
    }
  }
  wsConnections.delete(normalizedId);
  socketUsers.forEach((value, socket) => {
    if (value === normalizedId) {
      socketUsers.delete(socket);
    }
  });
  onlineUsers.delete(normalizedId);

  await run('DELETE FROM messages WHERE fromUserId = ? OR toUserId = ?', [normalizedId, normalizedId]);
  await run('DELETE FROM signals WHERE fromUserId = ? OR toUserId = ?', [normalizedId, normalizedId]);
  await run('DELETE FROM connections WHERE userId = ?', [normalizedId]);
  await run('DELETE FROM blocked_users WHERE blockerUserId = ? OR blockedUserId = ?', [normalizedId, normalizedId]);
  await run('DELETE FROM hidden_presence_users WHERE ownerUserId = ? OR hiddenFromUserId = ?', [normalizedId, normalizedId]);
  await run('DELETE FROM privacy_settings WHERE userId = ?', [normalizedId]);
  const result = await run('DELETE FROM users WHERE id = ?', [normalizedId]);

  return { deleted: Number(result && result.changes) > 0 };
}

function sendWs(userId, payload) {
  const sockets = getSocketsForUser(userId);
  if (!sockets.size) return false;

  const packet = JSON.stringify(payload);
  let delivered = false;

  for (const ws of sockets) {
    try {
      ws.send(packet);
      delivered = true;
    } catch (error) {
      console.warn('WS send failed:', error && error.message ? error.message : error);
    }
  }

  return delivered;
}

async function broadcastPresence(userId, status, username) {
  const sourceUserId = String(userId || '').trim();
  if (!sourceUserId) return;

  const payloadBase = {
    type: 'presence',
    userId: sourceUserId,
    username: username || '',
    timestamp: Date.now()
  };

  for (const [viewerUserId] of wsConnections.entries()) {
    const sockets = getSocketsForUser(viewerUserId);
    if (!sockets.size) continue;

    const canSee = await canViewerSeePresence(sourceUserId, viewerUserId);
    const packet = JSON.stringify({
      ...payloadBase,
      status: canSee ? status : 'offline'
    });

    for (const client of sockets) {
      try {
        client.send(packet);
      } catch (error) {
        console.warn('Presence WS send failed:', error && error.message ? error.message : error);
      }
    }
  }
}

async function emitMessageStatusToUser(userId, payload) {
  sendWs(userId, {
    type: 'message_status',
    ...payload,
    timestamp: normalizeTimestamp(payload && payload.timestamp)
  });
}

async function setUserConnectionStatus(userId, username, isOnline) {
  const now = Date.now();

  await run(
    'UPDATE users SET online = ?, lastSeen = ? WHERE id = ?',
    [isOnline ? 1 : 0, now, userId]
  );

  if (isOnline) {
    onlineUsers.set(String(userId), {
      username: username || '',
      connectedAt: now
    });
    await broadcastPresence(userId, 'online', username || '');
  } else {
    onlineUsers.delete(String(userId));
    await broadcastPresence(userId, 'offline', username || '');
  }
}

async function getUserPresenceState(userId) {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) {
    return { status: 'offline', username: '' };
  }

  const row = await get(
    'SELECT username, online FROM users WHERE id = ?',
    [normalizedUserId]
  );

  const known = onlineUsers.get(normalizedUserId);
  const online = hasOpenSocketForUser(normalizedUserId) || Boolean(row && Number(row.online) === 1);

  return {
    status: online ? 'online' : 'offline',
    username: (known && known.username) || (row && row.username) || ''
  };
}

async function refreshPresenceBroadcast(userId) {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) return;
  const state = await getUserPresenceState(normalizedUserId);
  await broadcastPresence(normalizedUserId, state.status, state.username);
}

async function createAndDispatchMessage(fromUserId, payload = {}) {
  const toUserId = sanitizeStringInput(payload.toUserId, 128).trim();
  if (!toUserId) {
    throw new Error('Recipient is required');
  }

  const recipient = await get('SELECT id FROM users WHERE id = ?', [toUserId]);
  if (!recipient) {
    throw new Error('Recipient not found');
  }

  await assertMessagingAllowed(fromUserId, toUserId);

  const messageId = sanitizeStringInput(payload.id || payload.messageId || uuidv4(), 128);
  const clientMessageId = sanitizeStringInput(payload.clientMessageId || payload.id || messageId, 128);

  const alreadyExists = await get('SELECT * FROM messages WHERE id = ?', [messageId]);
  if (alreadyExists) {
    return serializeMessage(alreadyExists);
  }

  const requestedKind = String(payload.kind || payload.type || 'text').toLowerCase();
  const type = requestedKind === 'voice' || requestedKind === 'image' || requestedKind === 'file'
    ? requestedKind
    : 'text';
  const text = type === 'voice'
    ? sanitizeMessageText(payload.text || '🎤 Voice message')
    : (type === 'image'
      ? sanitizeMessageText(payload.text || '📷 Image')
      : (type === 'file'
        ? sanitizeMessageText(payload.text || `📎 ${sanitizeFileName(payload.fileName || '') || 'Attachment'}`)
        : sanitizeMessageText(payload.text || '')));
  const mediaData = sanitizeMediaData(
    payload.mediaData
    || payload.imageData
    || payload.voiceData
    || payload.audioData
    || ''
  );

  if ((type === 'voice' || type === 'image' || type === 'file') && !mediaData) {
    throw new Error('Media payload is required');
  }

  const voiceData = type === 'voice' ? mediaData : '';
  const fileName = type === 'file' ? sanitizeFileName(payload.fileName || payload.name || '') : '';
  const fileMime = type === 'file' ? sanitizeFileMime(payload.fileMime || payload.mime || '') : '';
  const fileSize = type === 'file' ? Math.max(0, Math.round(Number(payload.fileSize || payload.size || 0))) : 0;
  const durationSec = Math.max(0, Math.round(Number(payload.durationSec || 0)));
  const replyTo = payload.replyTo && typeof payload.replyTo === 'object'
    ? JSON.stringify(payload.replyTo)
    : null;
  const senderName = sanitizeDisplayName(payload.senderName || '');
  const senderPicture = typeof payload.senderPicture === 'string' ? payload.senderPicture.slice(0, 500000) : '';
  const groupId = sanitizeStringInput(payload.groupId, 128).trim();
  const groupName = sanitizeDisplayName(payload.groupName || '');
  const groupPicture = typeof payload.groupPicture === 'string' ? payload.groupPicture.slice(0, 500000) : '';
  const reactions = parseReactions(payload.reactions, payload.reaction, fromUserId);
  const reaction = reactions.length ? reactions[reactions.length - 1].emoji : '';
  const serializedReactions = JSON.stringify(reactions);
  const timestamp = normalizeTimestamp(payload.timestamp);
  const recipientOnline = hasOpenSocketForUser(toUserId);
  const deliveredAt = null;
  const initialStatus = 'sent';

  await run(
    `INSERT INTO messages (
      id, clientMessageId, fromUserId, toUserId, groupId, groupName, groupPicture, text, type, voiceData, mediaData, fileName, fileMime, fileSize, durationSec,
      replyTo, senderName, senderPicture, reaction, reactions, editedAt, deletedForEveryone,
      timestamp, delivered, deliveredAt, readAt, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, NULL, ?)`,
    [
      messageId,
      clientMessageId,
      fromUserId,
      toUserId,
      groupId,
      groupName,
      groupPicture,
      text,
      type,
      voiceData,
      mediaData,
      fileName,
      fileMime,
      fileSize,
      durationSec,
      replyTo,
      senderName,
      senderPicture,
      reaction,
      serializedReactions,
      timestamp,
      0,
      deliveredAt,
      initialStatus
    ]
  );

  const stored = await get('SELECT * FROM messages WHERE id = ?', [messageId]);
  let serialized = serializeMessage(stored);

  if (recipientOnline) {
    const deliveredNow = sendWs(toUserId, {
      type: 'chat_message',
      message: serialized
    });
    if (deliveredNow) {
      const now = Date.now();
      await run(
        `UPDATE messages
         SET delivered = 1, deliveredAt = COALESCE(deliveredAt, ?),
             status = CASE WHEN readAt IS NULL THEN 'delivered' ELSE status END
         WHERE id = ?`,
        [now, messageId]
      );
      const refreshed = await get('SELECT * FROM messages WHERE id = ?', [messageId]);
      if (refreshed) {
        serialized = serializeMessage(refreshed);
      }
    }
  }

  await emitMessageStatusToUser(fromUserId, {
    messageId,
    clientMessageId,
    toUserId,
    status: serialized.status || initialStatus,
    timestamp: serialized.deliveredAt || serialized.timestamp || deliveredAt || timestamp
  });

  return serialized;
}

async function syncOfflineMessagesForUser(recipientUserId, options = {}) {
  const userId = String(recipientUserId || '').trim();
  if (!userId) {
    return { messages: [], pushed: false };
  }

  if (offlineDeliveryInFlight.has(userId)) {
    return offlineDeliveryInFlight.get(userId);
  }

  const mode = options.mode === 'ws' ? 'ws' : 'http';

  const job = (async () => {
    const now = Date.now();

    await run(
      `UPDATE messages
       SET delivered = 1, deliveredAt = COALESCE(deliveredAt, ?), status = 'blocked'
       WHERE toUserId = ? AND delivered = 0
         AND EXISTS (
           SELECT 1 FROM blocked_users b
           WHERE b.blockerUserId = ? AND b.blockedUserId = messages.fromUserId
         )`,
      [now, userId, userId]
    );

    const rows = await all(
      `SELECT * FROM messages
       WHERE toUserId = ? AND delivered = 0
       ORDER BY timestamp ASC`,
      [userId]
    );

    if (!rows.length) {
      return { messages: [], pushed: false };
    }

    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => '?').join(', ');

    await run(
      `UPDATE messages
       SET delivered = 1, deliveredAt = ?, status = CASE WHEN readAt IS NULL THEN 'delivered' ELSE status END
       WHERE id IN (${placeholders})`,
      [now, ...ids]
    );

    for (const row of rows) {
      await emitMessageStatusToUser(row.fromUserId, {
        messageId: row.id,
        clientMessageId: row.clientMessageId || row.id,
        toUserId: row.toUserId,
        status: 'delivered',
        timestamp: now
      });
    }

    const updatedRows = await all(
      `SELECT * FROM messages WHERE id IN (${placeholders}) ORDER BY timestamp ASC`,
      ids
    );

    const messages = updatedRows.map(serializeMessage).filter(Boolean);

    let pushed = false;
    if (mode === 'ws' && messages.length && hasOpenSocketForUser(userId)) {
      for (const message of messages) {
        sendWs(userId, {
          type: 'chat_message',
          message
        });
      }
      pushed = true;
    }

    return { messages, pushed };
  })().finally(() => {
    offlineDeliveryInFlight.delete(userId);
  });

  offlineDeliveryInFlight.set(userId, job);
  return job;
}

async function markMessagesReadForUser(readerUserId, options = {}) {
  const normalizedReader = String(readerUserId || '').trim();
  if (!normalizedReader) {
    return { updated: 0, rows: [] };
  }

  const uniqueMessageIds = Array.isArray(options.messageIds)
    ? [...new Set(options.messageIds.map((id) => String(id || '').trim()).filter(Boolean))]
    : [];

  const peerUserId = options.fromUserId ? String(options.fromUserId).trim() : '';
  let targetRows = [];

  if (uniqueMessageIds.length > 0) {
    const placeholders = uniqueMessageIds.map(() => '?').join(', ');
    targetRows = await all(
      `SELECT id, fromUserId FROM messages
       WHERE toUserId = ? AND readAt IS NULL AND id IN (${placeholders})`,
      [normalizedReader, ...uniqueMessageIds]
    );
  } else if (peerUserId) {
    targetRows = await all(
      `SELECT id, fromUserId FROM messages
       WHERE toUserId = ? AND fromUserId = ? AND readAt IS NULL`,
      [normalizedReader, peerUserId]
    );
  }

  if (!targetRows.length) {
    if (uniqueMessageIds.length > 0 && peerUserId) {
      const now = Date.now();
      for (const messageId of uniqueMessageIds) {
        await emitMessageStatusToUser(peerUserId, {
          messageId,
          status: 'read',
          fromUserId: normalizedReader,
          timestamp: now
        });
      }
      return { updated: uniqueMessageIds.length, rows: [] };
    }

    return { updated: 0, rows: [] };
  }

  const now = Date.now();
  const ids = targetRows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(', ');

  await run(
    `UPDATE messages
     SET readAt = ?, delivered = 1, deliveredAt = COALESCE(deliveredAt, ?), status = 'read'
     WHERE id IN (${placeholders})`,
    [now, now, ...ids]
  );

  for (const row of targetRows) {
    await emitMessageStatusToUser(row.fromUserId, {
      messageId: row.id,
      status: 'read',
      fromUserId: normalizedReader,
      timestamp: now
    });
  }

  return { updated: targetRows.length, rows: targetRows };
}

async function patchMessageFromUser(authorUserId, payload = {}) {
  const messageId = String(payload.messageId || '').trim();
  if (!messageId) {
    throw new Error('messageId is required');
  }

  const existing = await get('SELECT * FROM messages WHERE id = ?', [messageId]);
  if (!existing) {
    const notFound = new Error('Message not found');
    notFound.code = 404;
    throw notFound;
  }

  if (String(existing.fromUserId) !== String(authorUserId)) {
    const forbidden = new Error('Not allowed');
    forbidden.code = 403;
    throw forbidden;
  }

  const updates = [];
  const params = [];
  const normalizedAuthorId = String(authorUserId || '').trim();

  if (typeof payload.text === 'string') {
    updates.push('text = ?');
    params.push(sanitizeMessageText(payload.text));
  }

  if (typeof payload.reaction === 'string') {
    const nextEmoji = normalizeEmoji(payload.reaction);
    const reactions = parseReactions(existing.reactions, existing.reaction, existing.fromUserId)
      .filter((entry) => entry.userId !== normalizedAuthorId);
    if (isValidEmoji(nextEmoji)) {
      reactions.push({
        userId: normalizedAuthorId,
        emoji: nextEmoji,
        timestamp: Date.now()
      });
    }

    updates.push('reaction = ?');
    params.push(isValidEmoji(nextEmoji) ? nextEmoji : '');
    updates.push('reactions = ?');
    params.push(JSON.stringify(reactions));
  }

  if (payload.kind === 'voice' || payload.type === 'voice') {
    updates.push("type = 'voice'");
  } else if (payload.kind === 'image' || payload.type === 'image') {
    updates.push("type = 'image'");
  } else if (payload.kind === 'file' || payload.type === 'file') {
    updates.push("type = 'file'");
  } else if (payload.kind === 'text' || payload.type === 'text') {
    updates.push("type = 'text'");
  }

  if (
    typeof payload.audioData === 'string'
    || typeof payload.voiceData === 'string'
    || typeof payload.imageData === 'string'
    || typeof payload.mediaData === 'string'
  ) {
    const mediaData = sanitizeMediaData(
      payload.mediaData
      || payload.imageData
      || payload.audioData
      || payload.voiceData
      || ''
    );
    updates.push('mediaData = ?');
    params.push(mediaData);
    updates.push('voiceData = ?');
    params.push(mediaData);
  }

  if (payload.durationSec !== undefined) {
    updates.push('durationSec = ?');
    params.push(Math.max(0, Math.round(Number(payload.durationSec || 0))));
  }

  if (payload.fileName !== undefined) {
    updates.push('fileName = ?');
    params.push(sanitizeFileName(payload.fileName));
  }

  if (payload.fileMime !== undefined) {
    updates.push('fileMime = ?');
    params.push(sanitizeFileMime(payload.fileMime));
  }

  if (payload.fileSize !== undefined) {
    updates.push('fileSize = ?');
    params.push(Math.max(0, Math.round(Number(payload.fileSize || 0))));
  }

  if (payload.deletedForEveryone === true) {
    updates.push('deletedForEveryone = 1');
    updates.push("text = '❌ This message was deleted for everyone'");
    updates.push("type = 'text'");
    updates.push("voiceData = ''");
    updates.push("mediaData = ''");
    updates.push("fileName = ''");
    updates.push("fileMime = ''");
    updates.push('fileSize = 0');
    updates.push('durationSec = 0');
    updates.push("reaction = ''");
    updates.push("reactions = '[]'");
  }

  const editedAt = normalizeTimestamp(payload.editedAt || Date.now());
  updates.push('editedAt = ?');
  params.push(editedAt);

  if (!updates.length) {
    throw new Error('Nothing to update');
  }

  params.push(messageId);
  await run(`UPDATE messages SET ${updates.join(', ')} WHERE id = ?`, params);

  const updated = await get('SELECT * FROM messages WHERE id = ?', [messageId]);
  const serialized = serializeMessage(updated);

  sendWs(updated.toUserId, {
    type: 'message_patch',
    messageId,
    patch: {
      text: serialized.text,
      reactions: serialized.reactions,
      reaction: serialized.reaction,
      editedAt: serialized.editedAt,
      deletedForEveryone: serialized.deletedForEveryone,
      kind: serialized.type,
      type: serialized.type,
      audioData: serialized.audioData,
      imageData: serialized.imageData,
      mediaData: serialized.mediaData,
      durationSec: serialized.durationSec
    }
  });

  return serialized;
}

async function setMessageReactionForUser(actorUserId, payload = {}) {
  const messageId = sanitizeStringInput(payload.messageId, 128).trim();
  if (!messageId) {
    const badRequest = new Error('messageId is required');
    badRequest.code = 400;
    throw badRequest;
  }

  const existing = await get('SELECT * FROM messages WHERE id = ?', [messageId]);
  if (!existing) {
    const notFound = new Error('Message not found');
    notFound.code = 404;
    throw notFound;
  }

  const normalizedActor = String(actorUserId || '').trim();
  const fromUserId = String(existing.fromUserId || '').trim();
  const toUserId = String(existing.toUserId || '').trim();
  if (normalizedActor !== fromUserId && normalizedActor !== toUserId) {
    const forbidden = new Error('Not allowed');
    forbidden.code = 403;
    throw forbidden;
  }

  const peerUserId = normalizedActor === fromUserId ? toUserId : fromUserId;
  if (peerUserId && !(await canUsersInteract(normalizedActor, peerUserId))) {
    const forbidden = new Error('Not allowed for this user');
    forbidden.code = 403;
    throw forbidden;
  }

  const emoji = normalizeEmoji(payload.emoji);
  if (emoji && !isValidEmoji(emoji)) {
    const invalid = new Error('Invalid emoji');
    invalid.code = 400;
    throw invalid;
  }

  const reactions = parseReactions(existing.reactions, existing.reaction, existing.fromUserId)
    .filter((entry) => entry.userId !== normalizedActor);

  if (emoji) {
    reactions.push({
      userId: normalizedActor,
      emoji,
      timestamp: Date.now()
    });
  }

  const lastReaction = reactions.length ? reactions[reactions.length - 1].emoji : '';
  const editedAt = normalizeTimestamp(payload.editedAt || Date.now());

  await run(
    'UPDATE messages SET reactions = ?, reaction = ?, editedAt = ? WHERE id = ?',
    [JSON.stringify(reactions), lastReaction, editedAt, messageId]
  );

  const updated = await get('SELECT * FROM messages WHERE id = ?', [messageId]);
  const serialized = serializeMessage(updated);
  
  // Get user name from the payload or lookup from users table
  const userName = payload.userName || '';
  
  const patch = {
    reactions: serialized.reactions,
    reaction: serialized.reaction,
    reactionUserId: normalizedActor,
    userName: userName,
    editedAt
  };

  sendWs(fromUserId, {
    type: 'message_patch',
    messageId,
    patch
  });

  if (toUserId && toUserId !== fromUserId) {
    sendWs(toUserId, {
      type: 'message_patch',
      messageId,
      patch
    });
  }

  return serialized;
}

app.use('/api/check-username', searchRateLimiter);
app.use('/api/auth/register', authRateLimiter);
app.use('/api/auth/login', authRateLimiter);
app.use('/api/users/search', searchRateLimiter);
app.use('/api/messages/send', messageRateLimiter);
app.use('/api/messages/offline', messageRateLimiter);
app.use('/api/messages/patch', messageRateLimiter);
app.use('/api/messages/react', messageRateLimiter);
app.use('/api/messages/search', searchRateLimiter);

// ============= ADMIN =============

app.post('/admin/login', adminAuthRateLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const safeUsername = String(username || '').trim();
    const safePassword = String(password || '').trim();

    if (!safeUsername || !safePassword) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const admin = await get(
      'SELECT * FROM admins WHERE lower(username) = lower(?)',
      [safeUsername]
    );

    if (!admin) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const ok = await bcrypt.compare(safePassword, admin.passwordHash);
    if (!ok) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const token = createAdminToken(safeUsername);
    res.json({
      token,
      expiresIn: ADMIN_TOKEN_TTL,
      username: safeUsername
    });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/admin/stats', requireAdminAuth, async (req, res) => {
  try {
    const totalUsersRow = await get('SELECT COUNT(*) AS count FROM users');
    const totalGroups = await countGroups();
    const activeChats = await countActiveChats();
    const totalMessagesRow = await get('SELECT COUNT(*) AS count FROM messages');

    res.json({
      totalUsers: Number(totalUsersRow && totalUsersRow.count) || 0,
      onlineUsers: onlineUsers.size,
      activeConnections: totalOpenSocketCount(),
      totalGroups,
      activeChats,
      totalMessages: Number(totalMessagesRow && totalMessagesRow.count) || 0,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('Admin stats error:', error);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

app.get('/admin/online', requireAdminAuth, (req, res) => {
  res.json({
    online: onlineUsers.size,
    activeConnections: totalOpenSocketCount(),
    timestamp: Date.now()
  });
});

app.get('/admin/live-users', requireAdminAuth, (req, res) => {
  const users = [];
  onlineUsers.forEach((value, key) => {
    users.push({
      userId: key,
      username: value.username || '',
      status: 'online',
      connectedAt: value.connectedAt || null
    });
  });

  res.json({
    count: users.length,
    users
  });
});

app.get('/admin/activity', requireAdminAuth, async (req, res) => {
  try {
    const rows = await all(
      `SELECT
         strftime('%H:%M', datetime(timestamp/1000, 'unixepoch')) AS minute,
         COUNT(*) AS count
       FROM messages
       WHERE timestamp > (strftime('%s','now','-1 hour') * 1000)
       GROUP BY minute
       ORDER BY minute ASC`
    );

    res.json(rows || []);
  } catch (error) {
    console.error('Admin activity error:', error);
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

app.get('/admin/groups', requireAdminAuth, async (req, res) => {
  try {
    const rows = await all(
      `SELECT
         TRIM(groupId) AS groupId,
         MAX(groupName) AS groupName,
         COUNT(*) AS messages,
         COUNT(DISTINCT fromUserId) AS members
       FROM messages
       WHERE TRIM(groupId) != ''
       GROUP BY TRIM(groupId)
       ORDER BY messages DESC
       LIMIT 500`
    );
    res.json({ groups: rows || [] });
  } catch (error) {
    console.error('Admin groups error:', error);
    res.status(500).json({ error: 'Failed to load groups' });
  }
});

app.delete('/admin/groups/:id', requireAdminAuth, async (req, res) => {
  try {
    const groupId = sanitizeStringInput(req.params.id, 128).trim();
    if (!groupId) {
      res.status(400).json({ error: 'Invalid group id' });
      return;
    }
    const messageIds = await all(
      'SELECT id FROM messages WHERE TRIM(groupId) = ?',
      [groupId]
    );
    if (messageIds && messageIds.length) {
      const ids = messageIds.map((m) => m.id);
      const placeholders = ids.map(() => '?').join(', ');
      await run(`DELETE FROM reported_messages WHERE messageId IN (${placeholders})`, ids);
    }
    await run('DELETE FROM messages WHERE TRIM(groupId) = ?', [groupId]);
    res.json({ success: true, deleted: true });
  } catch (error) {
    console.error('Admin delete group error:', error);
    res.status(500).json({ error: 'Failed to delete group' });
  }
});

app.get('/admin/groups/:id/members', requireAdminAuth, async (req, res) => {
  try {
    const groupId = sanitizeStringInput(req.params.id, 128).trim();
    if (!groupId) {
      res.status(400).json({ error: 'Invalid group id' });
      return;
    }
    const rows = await all(
      `SELECT DISTINCT u.id, u.username, u.displayName
       FROM messages m
       JOIN users u ON u.id = m.fromUserId
       WHERE TRIM(m.groupId) = ?
       ORDER BY lower(u.displayName) ASC
       LIMIT 300`,
      [groupId]
    );
    res.json({ members: rows || [] });
  } catch (error) {
    console.error('Admin group members error:', error);
    res.status(500).json({ error: 'Failed to load members' });
  }
});

app.delete('/admin/groups/:id/member/:userId', requireAdminAuth, async (req, res) => {
  try {
    const groupId = sanitizeStringInput(req.params.id, 128).trim();
    const userId = sanitizeStringInput(req.params.userId, 128).trim();
    if (!groupId || !userId) {
      res.status(400).json({ error: 'Invalid ids' });
      return;
    }
    const msgIds = await all(
      `SELECT id FROM messages
       WHERE TRIM(groupId) = ? AND fromUserId = ?`,
      [groupId, userId]
    );
    if (msgIds && msgIds.length) {
      const ids = msgIds.map((m) => m.id);
      const placeholders = ids.map(() => '?').join(', ');
      await run(`DELETE FROM reported_messages WHERE messageId IN (${placeholders})`, ids);
    }
    await run('DELETE FROM messages WHERE TRIM(groupId) = ? AND fromUserId = ?', [groupId, userId]);
    res.json({ success: true, removed: true });
  } catch (error) {
    console.error('Admin remove member error:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

app.get('/admin/offline-messages', requireAdminAuth, async (req, res) => {
  try {
    const rows = await all(
      `SELECT toUserId, COUNT(*) AS count
       FROM messages
       WHERE delivered = 0
       GROUP BY toUserId
       ORDER BY count DESC
       LIMIT 200`
    );
    res.json({ offline: rows || [] });
  } catch (error) {
    console.error('Admin offline messages error:', error);
    res.status(500).json({ error: 'Failed to load offline messages' });
  }
});

app.get('/admin/offline/:userId', requireAdminAuth, async (req, res) => {
  try {
    const userId = sanitizeStringInput(req.params.userId, 128).trim();
    if (!userId) {
      res.status(400).json({ error: 'Invalid user id' });
      return;
    }
    const rows = await all(
      `SELECT id, fromUserId, toUserId, text, timestamp
       FROM messages
       WHERE toUserId = ? AND delivered = 0
       ORDER BY timestamp DESC
       LIMIT 200`,
      [userId]
    );
    res.json({ messages: rows || [] });
  } catch (error) {
    console.error('Admin offline detail error:', error);
    res.status(500).json({ error: 'Failed to load offline messages' });
  }
});

app.get('/admin/user-chats/:userId', requireAdminAuth, async (req, res) => {
  try {
    const userId = sanitizeStringInput(req.params.userId, 128).trim();
    if (!userId) {
      res.status(400).json({ error: 'Invalid user id' });
      return;
    }
    const rows = await all(
      `SELECT
         contact.id   AS contactId,
         contact.username AS contactUsername,
         contact.displayName AS contactDisplayName,
         COUNT(m.id) AS messageCount
       FROM messages m
       JOIN users contact
         ON contact.id = CASE
           WHEN m.fromUserId = ? THEN m.toUserId
           ELSE m.fromUserId
         END
       WHERE m.fromUserId = ? OR m.toUserId = ?
       GROUP BY contact.id, contact.username, contact.displayName
       ORDER BY messageCount DESC
       LIMIT 200`,
      [userId, userId, userId]
    );
    res.json({ contacts: rows || [] });
  } catch (error) {
    console.error('Admin user chats error:', error);
    res.status(500).json({ error: 'Failed to load user chats' });
  }
});

app.get('/admin/chat/:u1/:u2', requireAdminAuth, async (req, res) => {
  try {
    const u1 = sanitizeStringInput(req.params.u1, 128).trim();
    const u2 = sanitizeStringInput(req.params.u2, 128).trim();
    if (!u1 || !u2) {
      res.status(400).json({ error: 'Invalid user ids' });
      return;
    }

    if (!hasOpenSocketForUser(u1) && !hasOpenSocketForUser(u2)) {
      res.status(409).json({ error: 'Both users are offline; conversation unavailable' });
      return;
    }

    const rows = await all(
      `SELECT
         m.id, m.fromUserId, m.toUserId, m.text, m.timestamp,
         fu.username AS fromUsername, fu.displayName AS fromDisplayName,
         tu.username AS toUsername, tu.displayName AS toDisplayName
       FROM messages m
       LEFT JOIN users fu ON fu.id = m.fromUserId
       LEFT JOIN users tu ON tu.id = m.toUserId
       WHERE (m.fromUserId = ? AND m.toUserId = ?)
          OR (m.fromUserId = ? AND m.toUserId = ?)
       ORDER BY m.timestamp DESC
       LIMIT 300`,
      [u1, u2, u2, u1]
    );
    res.json({ messages: rows || [] });
  } catch (error) {
    console.error('Admin chat load error:', error);
    res.status(500).json({ error: 'Failed to load chat' });
  }
});

app.get('/admin/group-chat/:groupId', requireAdminAuth, async (req, res) => {
  try {
    const groupId = sanitizeStringInput(req.params.groupId, 128).trim();
    if (!groupId) {
      res.status(400).json({ error: 'Invalid group id' });
      return;
    }

    // find any online member
    const candidateMembers = await all(
      `SELECT DISTINCT fromUserId AS uid
       FROM messages
       WHERE TRIM(groupId) = ?
       LIMIT 50`,
      [groupId]
    );
    const anyOnline = (candidateMembers || []).some((row) => row && hasOpenSocketForUser(row.uid));
    if (!anyOnline) {
      res.status(409).json({ error: 'Group members offline; conversation unavailable' });
      return;
    }

    const rows = await all(
      `SELECT
         m.id, m.fromUserId, m.toUserId, m.text, m.timestamp,
         fu.username AS fromUsername, fu.displayName AS fromDisplayName
       FROM messages m
       LEFT JOIN users fu ON fu.id = m.fromUserId
       WHERE TRIM(m.groupId) = ?
       ORDER BY m.timestamp DESC
       LIMIT 300`,
      [groupId]
    );

    res.json({ messages: rows || [] });
  } catch (error) {
    console.error('Admin group chat load error:', error);
    res.status(500).json({ error: 'Failed to load group chat' });
  }
});

app.get('/admin/reports', requireAdminAuth, async (req, res) => {
  try {
    const rows = await all(
      `SELECT r.id, r.messageId, r.reporterId, r.fromUserId, r.toUserId, r.reason, r.messageText, r.createdAt,
              u.username AS reporterUsername
       FROM reported_messages r
       LEFT JOIN users u ON u.id = r.reporterId
       ORDER BY r.createdAt DESC
       LIMIT 200`
    );
    res.json({ reports: rows || [] });
  } catch (error) {
    console.error('Admin reports error:', error);
    res.status(500).json({ error: 'Failed to load reports' });
  }
});

app.get('/admin/reports/:id', requireAdminAuth, async (req, res) => {
  try {
    const reportId = sanitizeStringInput(req.params.id, 128).trim();
    const row = await get(
      `SELECT r.*, u.username AS reporterUsername
       FROM reported_messages r
       LEFT JOIN users u ON u.id = r.reporterId
       WHERE r.id = ?`,
      [reportId]
    );
    if (!row) {
      res.status(404).json({ error: 'Report not found' });
      return;
    }
    res.json(row);
  } catch (error) {
    console.error('Admin report detail error:', error);
    res.status(500).json({ error: 'Failed to load report' });
  }
});

app.delete('/admin/reports/:id', requireAdminAuth, async (req, res) => {
  try {
    const reportId = sanitizeStringInput(req.params.id, 128).trim();
    await run('DELETE FROM reported_messages WHERE id = ?', [reportId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Admin delete report error:', error);
    res.status(500).json({ error: 'Failed to delete report' });
  }
});

app.delete('/admin/messages/:id', requireAdminAuth, async (req, res) => {
  try {
    const messageId = sanitizeStringInput(req.params.id, 128).trim();
    if (!messageId) {
      res.status(400).json({ error: 'Invalid message id' });
      return;
    }

    await run('DELETE FROM messages WHERE id = ?', [messageId]);
    await run('DELETE FROM reported_messages WHERE messageId = ?', [messageId]);
    res.json({ success: true, deleted: true });
  } catch (error) {
    console.error('Admin delete message error:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

app.get('/admin/users', requireAdminAuth, async (req, res) => {
  try {
    const search = sanitizeSearchTerm(req.query && req.query.search);
    let rows;

    if (search) {
      const wildcard = `%${search}%`;
      rows = await all(
        `SELECT id, username, displayName, avatar, online, lastSeen, createdAt
         FROM users
         WHERE lower(username) LIKE lower(?) OR lower(displayName) LIKE lower(?)
         ORDER BY online DESC, createdAt DESC
         LIMIT 200`,
        [wildcard, wildcard]
      );
    } else {
      rows = await all(
        `SELECT id, username, displayName, avatar, online, lastSeen, createdAt
         FROM users
         ORDER BY createdAt DESC
         LIMIT 200`
      );
    }

    res.json({
      users: (rows || []).map((row) => ({
        id: row.id,
        username: row.username,
        displayName: row.displayName,
        online: Boolean(row.online),
        status: Boolean(row.online) ? 'online' : 'offline',
        lastSeen: row.lastSeen || null,
        createdAt: row.createdAt || null
      }))
    });
  } catch (error) {
    console.error('Admin users error:', error);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

app.delete('/admin/users/:id', requireAdminAuth, async (req, res) => {
  try {
    const userId = sanitizeStringInput(req.params.id, 128).trim();
    if (!userId) {
      res.status(400).json({ error: 'Invalid user id' });
      return;
    }

    const existing = await get('SELECT id FROM users WHERE id = ?', [userId]);
    if (!existing) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const result = await deleteUserCompletely(userId);
    res.json({ success: true, deleted: result.deleted });
  } catch (error) {
    console.error('Admin delete user error:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

app.post('/admin/ban/:id', requireAdminAuth, async (req, res) => {
  try {
    const userId = sanitizeStringInput(req.params.id, 128).trim();
    if (!userId) {
      res.status(400).json({ error: 'Invalid user id' });
      return;
    }

    const reason = sanitizeStringInput((req.body && req.body.reason) || 'Admin ban', 240);
    await run(
      'INSERT OR REPLACE INTO banned_users (id, reason, createdAt) VALUES (?, ?, ?)',
      [userId, reason, Date.now()]
    );

    const sockets = getSocketsForUser(userId);
    for (const ws of sockets) {
      try {
        ws.close(4003, 'Banned');
      } catch {
        // noop
      }
    }
    wsConnections.delete(userId);
    onlineUsers.delete(userId);

    res.json({ success: true, banned: true });
  } catch (error) {
    console.error('Admin ban user error:', error);
    res.status(500).json({ error: 'Failed to ban user' });
  }
});

app.get(['/admin', '/m00maiN'], (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

// ============= AUTHENTICATION =============

app.post('/api/check-username', async (req, res) => {
  try {
    const base = normalizeUsernameBase(req.body && req.body.username);

    if (!base) {
      res.status(400).json({ available: false, error: 'Username is required' });
      return;
    }

    if (!USERNAME_REGEX.test(base)) {
      res.status(400).json({
        available: false,
        error: 'Username must be 3-20 characters and contain only letters, numbers, underscore'
      });
      return;
    }

    const username = formatUsernameHandle(base);
    const existing = await get(
      'SELECT id FROM users WHERE lower(username) = lower(?)',
      [username]
    );

    if (existing) {
      res.json({
        available: false,
        username,
        normalized: base,
        suggestions: buildUsernameSuggestions(base)
      });
      return;
    }

    res.json({
      available: true,
      username,
      normalized: base,
      suggestions: []
    });
  } catch (error) {
    console.error('Username check error:', error);
    res.status(500).json({ available: false, error: 'Unable to check username' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  const { username: usernameInput, password, displayName } = req.body || {};
  const usernameBase = normalizeUsernameBase(usernameInput);
  const username = formatUsernameHandle(usernameBase);
  const safeDisplayName = sanitizeDisplayName(displayName);
  const safePassword = sanitizeStringInput(password, 120);

  if (!USERNAME_REGEX.test(usernameBase)) {
    res.status(400).json({
      error: 'Username must be 3-20 characters and contain only letters, numbers, underscore'
    });
    return;
  }

  if (!safePassword || safePassword.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' });
    return;
  }

  if (!safeDisplayName || safeDisplayName.length < 1) {
    res.status(400).json({ error: 'Display name is required' });
    return;
  }

  try {
    const userExists = await get(
      'SELECT id FROM users WHERE lower(username) = lower(?)',
      [username]
    );

    if (userExists) {
      res.status(409).json({
        error: 'Username already taken',
        suggestions: buildUsernameSuggestions(usernameBase)
      });
      return;
    }

    const hashedPassword = await bcrypt.hash(safePassword, 10);
    const userId = uuidv4();
    const now = Date.now();

    await run(
      `INSERT INTO users (id, username, password, displayName, avatar, createdAt, updatedAt, online, lastSeen)
       VALUES (?, ?, ?, ?, NULL, ?, ?, 0, ?)`,
      [userId, username, hashedPassword, safeDisplayName, now, now, now]
    );
    await ensurePrivacySettingsRow(userId);

    const token = jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '30d' });
    const user = {
      id: userId,
      username,
      displayName: safeDisplayName,
      avatar: null,
      online: false,
      lastSeen: now
    };

    res.status(201).json({ token, user, message: 'Registration successful' });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username: usernameInput, password } = req.body || {};
  const usernameBase = normalizeUsernameBase(usernameInput);
  const username = formatUsernameHandle(usernameBase);
  const safePassword = sanitizeStringInput(password, 120);

  if (!usernameBase || !safePassword) {
    res.status(400).json({ error: 'Username and password required' });
    return;
  }

  try {
    const user = await get(
      'SELECT * FROM users WHERE lower(username) = lower(?)',
      [username]
    );

    if (!user) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    if (await isUserBanned(user.id)) {
      res.status(403).json({ error: 'Account banned' });
      return;
    }

    const passwordMatch = await bcrypt.compare(safePassword, user.password);
    if (!passwordMatch) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const now = Date.now();
    await ensurePrivacySettingsRow(user.id);
    await run('UPDATE users SET online = 1, lastSeen = ?, updatedAt = ? WHERE id = ?', [now, now, user.id]);

    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, {
      expiresIn: '30d'
    });

    const userResponse = {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatar: user.avatar,
      online: true,
      lastSeen: now
    };

    res.json({ token, user: userResponse, message: 'Login successful' });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/verify', requireAuth, async (req, res) => {
  try {
    const user = await get(
      'SELECT id, username, displayName, avatar, online, lastSeen FROM users WHERE id = ?',
      [req.auth.userId]
    );

    if (!user) {
      res.status(401).json({ valid: false, error: 'User not found' });
      return;
    }

    res.json({ valid: true, user });
  } catch (error) {
    console.error('Token verify error:', error);
    res.status(500).json({ valid: false, error: 'Verification failed' });
  }
});

// ============= USER SEARCH =============

app.get('/api/users/search', requireAuth, async (req, res) => {
  const query = normalizeSearchQuery(req.query && req.query.query);
  if (!query) {
    res.json({ users: [] });
    return;
  }

  try {
    const baseQuery = normalizeUsernameBase(query);
    const exactHandle = baseQuery ? formatUsernameHandle(baseQuery) : '';
    const wildcard = `%${query}%`;
    const rows = await all(
      `SELECT id, username, displayName, avatar, online, lastSeen
       FROM users
       WHERE id != ?
         AND (
           lower(username) LIKE lower(?)
           OR lower(displayName) LIKE lower(?)
           OR (? != '' AND lower(username) = lower(?))
         )
       ORDER BY
         CASE WHEN (? != '' AND lower(username) = lower(?)) THEN 0 ELSE 1 END,
         online DESC,
         displayName COLLATE NOCASE ASC
       LIMIT 25`,
      [
        req.auth.userId,
        wildcard,
        wildcard,
        exactHandle,
        exactHandle,
        exactHandle,
        exactHandle
      ]
    );

    const users = [];
    for (const row of rows || []) {
      users.push(await projectUserForViewer(row, req.auth.userId));
    }

    res.json({ users });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

app.get('/api/users/:userId', requireAuth, async (req, res) => {
  try {
    const userId = sanitizeStringInput(req.params.userId, 128).trim();
    if (!userId) {
      res.status(400).json({ error: 'Invalid user id' });
      return;
    }

    const row = await get(
      'SELECT id, username, displayName, avatar, online, lastSeen FROM users WHERE id = ?',
      [userId]
    );

    if (!row) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const projected = await projectUserForViewer(row, req.auth.userId);
    res.json(projected);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

app.post('/api/users/profile', requireAuth, async (req, res) => {
  try {
    const userId = String(req.auth.userId || '').trim();
    const existing = await get(
      'SELECT id, username, displayName, avatar, online, lastSeen FROM users WHERE id = ?',
      [userId]
    );
    if (!existing) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const payload = req.body || {};
    const nextDisplayName = payload.displayName !== undefined
      ? sanitizeDisplayName(payload.displayName)
      : sanitizeDisplayName(existing.displayName);
    if (!nextDisplayName) {
      res.status(400).json({ error: 'Display name is required' });
      return;
    }

    let nextAvatar = existing.avatar || '';
    if (payload.avatar !== undefined) {
      const rawAvatar = String(payload.avatar || '');
      const sanitizedAvatar = sanitizeMediaData(rawAvatar);
      if (rawAvatar && !sanitizedAvatar) {
        res.status(400).json({ error: 'Avatar payload is too large' });
        return;
      }
      nextAvatar = sanitizedAvatar;
    }

    const now = Date.now();
    await run(
      'UPDATE users SET displayName = ?, avatar = ?, updatedAt = ? WHERE id = ?',
      [nextDisplayName, nextAvatar, now, userId]
    );

    const row = await get(
      'SELECT id, username, displayName, avatar, online, lastSeen FROM users WHERE id = ?',
      [userId]
    );
    const projected = await projectUserForViewer(row, userId);
    res.json({ success: true, user: projected });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ============= PRIVACY =============

app.get('/api/privacy/settings', requireAuth, async (req, res) => {
  try {
    const userId = String(req.auth.userId || '').trim();
    await ensurePrivacySettingsRow(userId);
    const settings = await getPrivacySettings(userId);

    const blockedUsers = await all(
      `SELECT u.id, u.username, u.displayName, u.avatar
       FROM blocked_users b
       JOIN users u ON u.id = b.blockedUserId
       WHERE b.blockerUserId = ?
       ORDER BY lower(u.displayName) ASC`,
      [userId]
    );

    const hiddenFromUsers = await all(
      `SELECT u.id, u.username, u.displayName, u.avatar
       FROM hidden_presence_users h
       JOIN users u ON u.id = h.hiddenFromUserId
       WHERE h.ownerUserId = ?
       ORDER BY lower(u.displayName) ASC`,
      [userId]
    );

    res.json({
      showOnline: settings.showOnline,
      lastSeenVisibility: settings.lastSeenVisibility,
      blockedUsers: blockedUsers || [],
      hiddenFromUsers: hiddenFromUsers || []
    });
  } catch (error) {
    console.error('Get privacy settings error:', error);
    res.status(500).json({ error: 'Failed to load privacy settings' });
  }
});

app.post('/api/privacy/settings', requireAuth, async (req, res) => {
  try {
    const userId = String(req.auth.userId || '').trim();
    const payload = req.body || {};
    const current = await getPrivacySettings(userId);
    const nextShowOnline = typeof payload.showOnline === 'boolean'
      ? payload.showOnline
      : current.showOnline;
    const nextLastSeenVisibility = payload.lastSeenVisibility
      ? normalizeLastSeenVisibility(payload.lastSeenVisibility)
      : current.lastSeenVisibility;
    const now = Date.now();

    await run(
      `INSERT INTO privacy_settings (userId, showOnline, lastSeenVisibility, updatedAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(userId) DO UPDATE SET
         showOnline = excluded.showOnline,
         lastSeenVisibility = excluded.lastSeenVisibility,
         updatedAt = excluded.updatedAt`,
      [userId, nextShowOnline ? 1 : 0, nextLastSeenVisibility, now]
    );

    await refreshPresenceBroadcast(userId);

    res.json({
      success: true,
      showOnline: nextShowOnline,
      lastSeenVisibility: nextLastSeenVisibility
    });
  } catch (error) {
    console.error('Update privacy settings error:', error);
    res.status(500).json({ error: 'Failed to update privacy settings' });
  }
});

app.post('/api/privacy/block', requireAuth, async (req, res) => {
  try {
    const blockerUserId = String(req.auth.userId || '').trim();
    const blockedUserId = sanitizeStringInput(req.body && req.body.userId, 128).trim();
    if (!blockedUserId || blockedUserId === blockerUserId) {
      res.status(400).json({ error: 'Invalid user id' });
      return;
    }

    const target = await get(
      'SELECT id FROM users WHERE id = ?',
      [blockedUserId]
    );
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const now = Date.now();
    await run(
      `INSERT INTO blocked_users (blockerUserId, blockedUserId, createdAt)
       VALUES (?, ?, ?)
       ON CONFLICT(blockerUserId, blockedUserId) DO NOTHING`,
      [blockerUserId, blockedUserId, now]
    );

    await run(
      `UPDATE messages
       SET delivered = 1, deliveredAt = COALESCE(deliveredAt, ?), status = 'blocked'
       WHERE toUserId = ? AND fromUserId = ? AND delivered = 0`,
      [now, blockerUserId, blockedUserId]
    );

    await Promise.all([
      refreshPresenceBroadcast(blockerUserId),
      refreshPresenceBroadcast(blockedUserId)
    ]);

    res.json({ success: true, blockedUserId });
  } catch (error) {
    console.error('Block user error:', error);
    res.status(500).json({ error: 'Failed to block user' });
  }
});

app.post('/api/privacy/unblock', requireAuth, async (req, res) => {
  try {
    const blockerUserId = String(req.auth.userId || '').trim();
    const blockedUserId = sanitizeStringInput(req.body && req.body.userId, 128).trim();
    if (!blockedUserId || blockedUserId === blockerUserId) {
      res.status(400).json({ error: 'Invalid user id' });
      return;
    }

    await run(
      'DELETE FROM blocked_users WHERE blockerUserId = ? AND blockedUserId = ?',
      [blockerUserId, blockedUserId]
    );

    await Promise.all([
      refreshPresenceBroadcast(blockerUserId),
      refreshPresenceBroadcast(blockedUserId)
    ]);

    res.json({ success: true, unblockedUserId: blockedUserId });
  } catch (error) {
    console.error('Unblock user error:', error);
    res.status(500).json({ error: 'Failed to unblock user' });
  }
});

app.post('/api/privacy/hide-status', requireAuth, async (req, res) => {
  try {
    const ownerUserId = String(req.auth.userId || '').trim();
    const hiddenFromUserId = sanitizeStringInput(req.body && req.body.userId, 128).trim();
    const hidden = req.body && req.body.hidden !== false;
    if (!hiddenFromUserId || hiddenFromUserId === ownerUserId) {
      res.status(400).json({ error: 'Invalid user id' });
      return;
    }

    const target = await get(
      'SELECT id FROM users WHERE id = ?',
      [hiddenFromUserId]
    );
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (hidden) {
      await run(
        `INSERT INTO hidden_presence_users (ownerUserId, hiddenFromUserId, createdAt)
         VALUES (?, ?, ?)
         ON CONFLICT(ownerUserId, hiddenFromUserId) DO NOTHING`,
        [ownerUserId, hiddenFromUserId, Date.now()]
      );
    } else {
      await run(
        'DELETE FROM hidden_presence_users WHERE ownerUserId = ? AND hiddenFromUserId = ?',
        [ownerUserId, hiddenFromUserId]
      );
    }

    await refreshPresenceBroadcast(ownerUserId);

    res.json({
      success: true,
      userId: hiddenFromUserId,
      hidden: Boolean(hidden)
    });
  } catch (error) {
    console.error('Hide presence update error:', error);
    res.status(500).json({ error: 'Failed to update hidden status' });
  }
});

// ============= MESSAGES =============

app.get('/api/messages/search', requireAuth, async (req, res) => {
  try {
    const userIdQuery = sanitizeStringInput(req.query && req.query.userId, 128).trim();
    const usernameQuery = sanitizeSearchTerm(req.query && (req.query.username || req.query.handle));
    const textQuery = sanitizeSearchTerm(req.query && (req.query.query || req.query.q));
    const requestedLimit = Number(req.query && req.query.limit);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(200, Math.round(requestedLimit)))
      : 120;

    const params = [];
    const clauses = [];
    let resolvedUsername = '';

    if (userIdQuery) {
      const targetUser = await get(
        'SELECT id, username FROM users WHERE id = ?',
        [userIdQuery]
      );

      if (!targetUser) {
        res.json({ messages: [] });
        return;
      }

      resolvedUsername = targetUser.username || '';
      clauses.push('((fromUserId = ? AND toUserId = ?) OR (fromUserId = ? AND toUserId = ?))');
      params.push(req.auth.userId, targetUser.id, targetUser.id, req.auth.userId);
    } else if (usernameQuery) {
      const usernameBase = normalizeUsernameBase(usernameQuery);
      if (!usernameBase) {
        res.json({ messages: [] });
        return;
      }

      const usernameHandle = formatUsernameHandle(usernameBase);
      const targetUser = await get(
        'SELECT id, username FROM users WHERE lower(username) = lower(?)',
        [usernameHandle]
      );

      if (!targetUser) {
        res.json({ messages: [] });
        return;
      }

      resolvedUsername = targetUser.username;
      clauses.push('((fromUserId = ? AND toUserId = ?) OR (fromUserId = ? AND toUserId = ?))');
      params.push(req.auth.userId, targetUser.id, targetUser.id, req.auth.userId);
    } else {
      clauses.push('(fromUserId = ? OR toUserId = ?)');
      params.push(req.auth.userId, req.auth.userId);
    }

    if (textQuery) {
      clauses.push('lower(text) LIKE lower(?)');
      params.push(`%${textQuery}%`);
    }

    const whereClause = clauses.length ? clauses.join(' AND ') : '1 = 1';
    const rows = await all(
      `SELECT * FROM messages WHERE ${whereClause} ORDER BY timestamp DESC LIMIT ?`,
      [...params, limit]
    );

    res.json({
      messages: rows.map(serializeMessage),
      username: resolvedUsername || null
    });
  } catch (error) {
    console.error('Search messages error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

app.post('/api/messages/send', requireAuth, async (req, res) => {
  try {
    const message = await createAndDispatchMessage(req.auth.userId, req.body || {});

    res.status(201).json({
      success: true,
      messageId: message.id,
      ...message
    });
  } catch (error) {
    console.error('Send message error:', error);
    if (error && error.code === 403) {
      res.status(403).json({ error: error.message || 'Forbidden' });
      return;
    }
    res.status(400).json({ error: error.message || 'Failed to send message' });
  }
});

app.get('/api/messages/offline', requireAuth, async (req, res) => {
  try {
    const result = await syncOfflineMessagesForUser(req.auth.userId, { mode: 'http' });
    const messages = result && result.pushed
      ? []
      : (result && Array.isArray(result.messages) ? result.messages : []);
    res.json({ messages });
  } catch (error) {
    console.error('Get offline messages error:', error);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

// Backward-compatible route used by existing extension runtime code.
app.post('/api/messages/offline', requireAuth, async (req, res) => {
  try {
    const payload = req.body || {};
    const message = await createAndDispatchMessage(req.auth.userId, {
      ...payload,
      kind: payload.kind || payload.type || 'text',
      audioData: payload.voiceData || payload.audioData || payload.mediaData || payload.imageData || '',
      imageData: payload.imageData || payload.mediaData || '',
      mediaData: payload.mediaData || payload.imageData || payload.voiceData || payload.audioData || ''
    });

    res.status(201).json({
      success: true,
      messageId: message.id,
      ...message
    });
  } catch (error) {
    console.error('Store offline message error:', error);
    if (error && error.code === 403) {
      res.status(403).json({ error: error.message || 'Forbidden' });
      return;
    }
    res.status(400).json({ error: error.message || 'Failed to store message' });
  }
});

app.post('/api/messages/read', requireAuth, async (req, res) => {
  try {
    const payload = req.body || {};
    const result = await markMessagesReadForUser(req.auth.userId, {
      messageIds: payload.messageIds,
      fromUserId: payload.fromUserId || payload.peerUserId
    });

    res.json({ success: true, updated: result.updated });
  } catch (error) {
    console.error('Mark read error:', error);
    res.status(500).json({ error: 'Failed to mark messages as read' });
  }
});

app.post('/api/messages/patch', requireAuth, async (req, res) => {
  try {
    const message = await patchMessageFromUser(req.auth.userId, req.body || {});
    res.json({ success: true, message });
  } catch (error) {
    if (error && error.code === 404) {
      res.status(404).json({ error: error.message || 'Message not found' });
      return;
    }

    if (error && error.code === 403) {
      res.status(403).json({ error: error.message || 'Forbidden' });
      return;
    }

    console.error('Patch message error:', error);
    res.status(400).json({ error: error.message || 'Failed to patch message' });
  }
});

app.post('/api/messages/react', requireAuth, async (req, res) => {
  try {
    const message = await setMessageReactionForUser(req.auth.userId, req.body || {});
    res.json({ success: true, message });
  } catch (error) {
    if (error && error.code === 404) {
      const toUserId = sanitizeStringInput(req.body && req.body.toUserId, 128).trim();
      const messageId = sanitizeStringInput(req.body && req.body.messageId, 128).trim();
      const actorId = String(req.auth.userId || '').trim();
      if (toUserId && messageId) {
        const canInteract = await canUsersInteract(actorId, toUserId);
        if (!canInteract) {
          res.status(403).json({ error: 'Not allowed for this user' });
          return;
        }
        const editedAt = Date.now();
        const emoji = normalizeEmoji(req.body && req.body.emoji);
        const patch = {
          reaction: emoji,
          reactions: emoji ? [{ userId: actorId, emoji, timestamp: editedAt }] : [],
          reactionUserId: actorId,
          userName: sanitizeDisplayName(req.body && req.body.userName) || '',
          editedAt
        };
        sendWs(toUserId, {
          type: 'message_patch',
          messageId,
          patch
        });
        res.json({
          success: true,
          transient: true,
          message: {
            id: messageId,
            reaction: emoji,
            reactions: patch.reactions
          }
        });
        return;
      }
      res.status(404).json({ error: error.message || 'Message not found' });
      return;
    }
    if (error && error.code === 403) {
      res.status(403).json({ error: error.message || 'Forbidden' });
      return;
    }
    if (error && error.code === 400) {
      res.status(400).json({ error: error.message || 'Bad request' });
      return;
    }
    console.error('React message error:', error);
    res.status(400).json({ error: error.message || 'Failed to react to message' });
  }
});

app.post('/api/messages/report', requireAuth, async (req, res) => {
  try {
    const messageId = sanitizeStringInput(req.body && req.body.messageId, 128).trim();
    const reason = sanitizeStringInput(req.body && req.body.reason, 400);
    if (!messageId) {
      res.status(400).json({ error: 'messageId required' });
      return;
    }

    const message = await get('SELECT * FROM messages WHERE id = ?', [messageId]);
    if (!message) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    // store a snapshot to allow admin review without needing user online
    const reportId = uuidv4();
    await run(
      `INSERT INTO reported_messages
       (id, messageId, reporterId, fromUserId, toUserId, reason, messageText, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reportId,
        messageId,
        req.auth.userId,
        message.fromUserId,
        message.toUserId,
        reason || 'Not provided',
        sanitizeMessageText(message.text || ''),
        Date.now()
      ]
    );

    res.status(201).json({ success: true, reportId });
  } catch (error) {
    console.error('Report message error:', error);
    res.status(500).json({ error: 'Failed to report message' });
  }
});

// Alias for report endpoint used by clients: POST /api/report
app.post('/api/report', requireAuth, async (req, res) => {
  try {
    const messageId = sanitizeStringInput(req.body && req.body.messageId, 128).trim();
    const reason = sanitizeStringInput(req.body && req.body.reason, 400) || 'Not provided';
    if (!messageId) {
      res.status(400).json({ error: 'messageId required' });
      return;
    }

    // Reuse existing logic by reading message and inserting into reported_messages
    const message = await get('SELECT * FROM messages WHERE id = ?', [messageId]);
    if (!message) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    const reportId = uuidv4();
    await run(
      `INSERT INTO reported_messages
       (id, messageId, reporterId, fromUserId, toUserId, reason, messageText, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reportId,
        messageId,
        req.auth.userId,
        message.fromUserId,
        message.toUserId,
        reason,
        sanitizeMessageText(message.text || ''),
        Date.now()
      ]
    );

    res.status(201).json({ success: true, reportId });
  } catch (error) {
    console.error('Report alias error:', error);
    res.status(500).json({ error: 'Failed to report message' });
  }
});

// ============= WEBRTC SIGNALING =============

app.post('/api/signaling/send', requireAuth, async (req, res) => {
  try {
    const { toUserId, type, data } = req.body || {};
    if (!toUserId || !type) {
      res.status(400).json({ error: 'toUserId and type are required' });
      return;
    }

    const canInteract = await canUsersInteract(req.auth.userId, toUserId);
    if (!canInteract) {
      res.status(403).json({ error: 'Not allowed for this user' });
      return;
    }

    const signalId = uuidv4();
    const now = Date.now();

    await run(
      `INSERT INTO signals (id, fromUserId, toUserId, type, data, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        signalId,
        req.auth.userId,
        String(toUserId),
        String(type),
        JSON.stringify(data || null),
        now
      ]
    );

    sendWs(String(toUserId), {
      type: 'signal',
      fromUserId: req.auth.userId,
      signalType: String(type),
      data: data || null
    });

    res.status(201).json({ signalId });
  } catch (error) {
    console.error('Store signal error:', error);
    res.status(500).json({ error: 'Failed to store signal' });
  }
});

// ============= WEBSOCKET =============

wss.on('connection', (ws) => {
  const wsId = uuidv4();
  let currentUserId = '';
  let currentUsername = '';

  console.log('[WS] New connection:', wsId);

  ws.on('message', async (rawData) => {
    let message;
    try {
      message = JSON.parse(rawData);
    } catch {
      return;
    }

    if (!message || typeof message !== 'object') {
      return;
    }

    try {
      if (message.type === 'auth' && message.token) {
        const decoded = jwt.verify(String(message.token), JWT_SECRET);
        currentUserId = String(decoded.userId || '');
        currentUsername = String(decoded.username || '');

        if (!currentUserId) {
          ws.send(JSON.stringify({ type: 'auth_failed', error: 'Invalid token payload' }));
          ws.close();
          return;
        }

        if (await isUserBanned(currentUserId)) {
          ws.send(JSON.stringify({ type: 'auth_failed', error: 'Account banned' }));
          ws.close();
          return;
        }

        await ensurePrivacySettingsRow(currentUserId);

        const hadConnections = hasOpenSocketForUser(currentUserId);
        attachSocketForUser(currentUserId, ws);
        if (!hadConnections) {
          await setUserConnectionStatus(currentUserId, currentUsername, true);
        }

        ws.send(JSON.stringify({
          type: 'authenticated',
          userId: currentUserId,
          username: currentUsername,
          timestamp: Date.now()
        }));

        syncOfflineMessagesForUser(currentUserId, { mode: 'ws' }).catch((error) => {
          console.error('[WS] Offline delivery push failed:', error);
        });

        return;
      }

      if (!currentUserId) {
        ws.send(JSON.stringify({ type: 'auth_required', error: 'Authenticate first' }));
        return;
      }

      if (message.type === 'chat_message') {
        const payload = message.message && typeof message.message === 'object'
          ? { ...message.message, toUserId: message.toUserId || message.message.toUserId }
          : { ...message, toUserId: message.toUserId };

        const created = await createAndDispatchMessage(currentUserId, payload);

        ws.send(JSON.stringify({
          type: 'message_accepted',
          clientMessageId: payload.id || payload.clientMessageId || created.clientMessageId || created.id,
          message: created,
          timestamp: Date.now()
        }));

        return;
      }

      if (message.type === 'typing') {
        const toUserId = String(message.toUserId || '').trim();
        if (!toUserId) return;
        if (!(await canUsersInteract(currentUserId, toUserId))) {
          return;
        }

        sendWs(toUserId, {
          type: 'typing',
          fromUserId: currentUserId,
          name: String(message.name || ''),
          activity: String(message.activity || 'typing'),
          groupId: sanitizeStringInput(message.groupId, 128).trim(),
          groupName: sanitizeDisplayName(message.groupName || ''),
          timestamp: Date.now()
        });
        return;
      }

      if (message.type === 'message_read') {
        await markMessagesReadForUser(currentUserId, {
          messageIds: message.messageIds,
          fromUserId: message.fromUserId || message.peerUserId
        });

        ws.send(JSON.stringify({
          type: 'message_read_ack',
          timestamp: Date.now()
        }));
        return;
      }

      if (message.type === 'message_reaction') {
        const reactionPayload = {
          messageId: message.messageId,
          emoji: message.emoji,
          userId: message.userId,
          userName: message.userName
        };
        try {
          const reacted = await setMessageReactionForUser(currentUserId, reactionPayload);
          ws.send(JSON.stringify({
            type: 'message_reaction_ack',
            messageId: reacted.id,
            reaction: reacted.reaction,
            timestamp: Date.now()
          }));
          return;
        } catch (error) {
          const toUserId = String(message.toUserId || '').trim();
          const messageId = sanitizeStringInput(message.messageId, 128).trim();
          if (error && error.code === 404 && toUserId && messageId) {
            if (!(await canUsersInteract(currentUserId, toUserId))) {
              ws.send(JSON.stringify({
                type: 'error',
                error: 'Not allowed for this user'
              }));
              return;
            }
            const editedAt = Date.now();
            const emoji = normalizeEmoji(message.emoji);
            const actorId = String(currentUserId || '').trim();
            const patch = {
              reaction: emoji,
              reactions: emoji ? [{ userId: actorId, emoji, timestamp: editedAt }] : [],
              reactionUserId: actorId,
              userName: String(message.userName || currentUsername || ''),
              editedAt
            };

            sendWs(toUserId, {
              type: 'message_patch',
              messageId,
              patch
            });

            ws.send(JSON.stringify({
              type: 'message_reaction_ack',
              messageId,
              reaction: emoji,
              transient: true,
              timestamp: Date.now()
            }));
            return;
          }
          throw error;
        }
      }

      if (message.type === 'message_patch') {
        const patchPayload = {
          messageId: message.messageId,
          ...(message.patch && typeof message.patch === 'object' ? message.patch : {})
        };

        try {
          const patched = await patchMessageFromUser(currentUserId, patchPayload);
          ws.send(JSON.stringify({
            type: 'message_patch_ack',
            messageId: patched.id,
            timestamp: Date.now()
          }));
          return;
        } catch (error) {
          const toUserId = String(message.toUserId || '').trim();
          if (error && error.code === 404 && toUserId) {
            sendWs(toUserId, {
              type: 'message_patch',
              messageId: patchPayload.messageId,
              patch: message.patch && typeof message.patch === 'object' ? message.patch : {}
            });

            ws.send(JSON.stringify({
              type: 'message_patch_ack',
              messageId: patchPayload.messageId,
              transient: true,
              timestamp: Date.now()
            }));
            return;
          }

          throw error;
        }
      }

      if (message.type === 'signal') {
        const toUserId = String(message.toUserId || '').trim();
        if (!toUserId) return;
        if (!(await canUsersInteract(currentUserId, toUserId))) {
          return;
        }

        sendWs(toUserId, {
          type: 'signal',
          fromUserId: currentUserId,
          signalType: message.signalType || message.type,
          data: message.data || null
        });
        return;
      }

      if (message.type === 'presence') {
        const nextStatus = message.status === 'offline' ? 'offline' : 'online';
        if (nextStatus === 'offline') {
          // Avoid marking user offline while at least one authenticated socket is still open.
          if (getSocketsForUser(currentUserId).size > 0) {
            return;
          }
        }
        await setUserConnectionStatus(currentUserId, currentUsername, nextStatus === 'online');
        return;
      }

      if (message.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      }
    } catch (error) {
      console.error('[WS] Message handling error:', error);
      ws.send(JSON.stringify({ type: 'error', error: error.message || 'WS message failed' }));
    }
  });

  ws.on('close', async () => {
    socketUsers.delete(ws);
    if (!currentUserId) {
      return;
    }

    const remainingConnections = detachSocketForUser(currentUserId, ws);
    try {
      if (remainingConnections === 0) {
        await setUserConnectionStatus(currentUserId, currentUsername, false);
      }
    } catch (error) {
      console.error('[WS] Close status update failed:', error);
    }

    console.log('[WS] User disconnected:', currentUserId);
  });

  ws.on('error', (error) => {
    console.error('[WS] Error:', error);
  });
});

// ============= HEALTH/STATS =============

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.get('/stats', (req, res) => {
  res.json({
    onlineUsers: onlineUsers.size,
    activeConnections: totalOpenSocketCount(),
    timestamp: Date.now()
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║  Anonymous Chat Backend Server             ║
╚════════════════════════════════════════════╝

✅ Server running on http://localhost:${PORT}
✅ WebSocket running on ws://localhost:${PORT}/ws
✅ Database: ${DB_PATH}

Endpoints:
  POST   /api/check-username
  POST   /api/auth/register
  POST   /api/auth/login
  POST   /api/auth/verify
  GET    /api/users/search
  GET    /api/users/:userId
  POST   /api/messages/send
  GET    /api/messages/search
  GET    /api/messages/offline
  POST   /api/messages/offline
  POST   /api/messages/read
  POST   /api/messages/patch
  POST   /api/messages/react
  POST   /api/signaling/send
  GET    /health
  GET    /stats

WebSocket:
  ws://localhost:${PORT}/ws

  Messages:
    {type:'auth', token:'...'}
    {type:'chat_message', toUserId, message:{...}}
    {type:'typing', toUserId, name}
    {type:'message_read', messageIds:[...], fromUserId}
    {type:'message_reaction', messageId, emoji}
    {type:'message_patch', messageId, patch:{...}}
    {type:'ping'}
  `);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  server.close(() => {
    db.close();
    process.exit(0);
  });
});

module.exports = server;
