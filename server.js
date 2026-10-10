const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { Server } = require('socket.io');

const JWT_SECRET = 'change-me-in-production';
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const AVATAR_DIR = path.join(UPLOAD_DIR, 'avatars');
const FILES_DIR = path.join(UPLOAD_DIR, 'files');
const BG_DIR = path.join(UPLOAD_DIR, 'backgrounds');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR);
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR);
if (!fs.existsSync(BG_DIR)) fs.mkdirSync(BG_DIR);

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const empty = { users: [], messages: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(empty, null, 2));
    return empty;
  }
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!data.users) data.users = [];
    if (!data.messages) data.messages = [];
    return data;
  } catch {
    const empty = { users: [], messages: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(empty, null, 2));
    return empty;
  }
}

const db = loadDB();
let saveTimer = null;
function saveDB() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  }, 200);
}

let nextMessageId = 1;
(function initNextId() {
  db.messages.forEach(m => {
    if (m.id && m.id >= nextMessageId) nextMessageId = m.id + 1;
  });
})();

function findUser(username) {
  return db.users.find(u => u.username === username);
}

function findMessage(id) {
  return db.messages.find(m => m.id === id);
}

// ---------- Multer ----------
const voiceStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = file.mimetype.includes('ogg') ? 'ogg'
              : file.mimetype.includes('mp4') ? 'm4a'
              : file.mimetype.includes('mpeg') ? 'mp3'
              : 'webm';
    cb(null, `voice-${Date.now()}-${Math.random().toString(36).slice(2,8)}.${ext}`);
  }
});
const uploadVoiceMw = multer({ storage: voiceStorage, limits: { fileSize: 10 * 1024 * 1024 } });

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, AVATAR_DIR),
  filename: (req, file, cb) => {
    const ext = file.mimetype.includes('png') ? 'png'
              : file.mimetype.includes('gif') ? 'gif'
              : file.mimetype.includes('webp') ? 'webp'
              : 'jpg';
    cb(null, `avatar-${req.user.username}-${Date.now()}.${ext}`);
  }
});
const uploadAvatarMw = multer({
  storage: avatarStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('только изображения'));
    cb(null, true);
  }
});

const fileStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, FILES_DIR),
  filename: (req, file, cb) => {
    let originalName = file.originalname;
    try {
      originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    } catch (e) {}
    const ext = path.extname(originalName).slice(0, 10);
    const randomName = `${Date.now()}-${Math.random().toString(36).slice(2,10)}${ext}`;
    cb(null, randomName);
  }
});
const uploadFileMw = multer({
  storage: fileStorage,
  limits: { fileSize: 100 * 1024 * 1024 }
});

const bgStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, BG_DIR),
  filename: (req, file, cb) => {
    const ext = file.mimetype.includes('png') ? 'png'
              : file.mimetype.includes('webp') ? 'webp'
              : 'jpg';
    cb(null, `bg-${req.user.username}-${Date.now()}.${ext}`);
  }
});
const uploadBgMw = multer({
  storage: bgStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('только изображения'));
    cb(null, true);
  }
});

// ---------- Express ----------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'нужны логин и пароль' });
  if (username.length < 3 || password.length < 4) return res.status(400).json({ error: 'слишком короткие данные' });
  if (findUser(username)) return res.status(409).json({ error: 'пользователь уже существует' });

  const user = {
    id: db.users.length + 1,
    username,
    password_hash: bcrypt.hashSync(password, 10),
    avatar: null,
    last_seen: null,
    created_at: Math.floor(Date.now() / 1000)
  };
  db.users.push(user);
  saveDB();
  const token = jwt.sign({ id: user.id, username }, JWT_SECRET);
  res.json({ token, username, avatar: null });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = findUser(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'неверные данные' });
  }
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
  res.json({ token, username: user.username, avatar: user.avatar || null });
});

app.get('/api/users', authMiddleware, (req, res) => {
  res.json(
    db.users
      .filter(u => u.username !== req.user.username)
      .map(u => ({
        username: u.username,
        avatar: u.avatar || null,
        last_seen: u.last_seen || null
      }))
  );
});

app.get('/api/me', authMiddleware, (req, res) => {
  const user = findUser(req.user.username);
  if (!user) return res.status(404).json({ error: 'нет пользователя' });
  res.json({ username: user.username, avatar: user.avatar || null });
});

app.post('/api/avatar', authMiddleware, uploadAvatarMw.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'нет файла' });
  const user = findUser(req.user.username);
  if (!user) return res.status(404).json({ error: 'нет пользователя' });

  if (user.avatar) {
    const oldPath = path.join(__dirname, user.avatar.replace('/uploads/', 'uploads/'));
    try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch (e) {}
  }

  const url = '/uploads/avatars/' + req.file.filename;
  user.avatar = url;
  saveDB();
  io.emit('avatar-update', { username: user.username, avatar: url });
  res.json({ ok: true, avatar: url });
});

app.get('/api/messages/:with', authMiddleware, (req, res) => {
  const me = req.user.username;
  const other = req.params.with;
  const rows = db.messages
    .filter(m =>
      (m.from_user === me && m.to_user === other) ||
      (m.from_user === other && m.to_user === me)
    )
    .filter(m => {
      if (Array.isArray(m.deleted_for) && m.deleted_for.includes(me)) return false;
      return true;
    })
    .slice(-500);

  let changed = false;
  rows.forEach(m => {
    if (m.to_user === me && !m.read_at) {
      m.read_at = Math.floor(Date.now() / 1000);
      changed = true;
    }
  });
  if (changed) {
    saveDB();
    const bySender = {};
    rows.forEach(m => {
      if (m.to_user === me && m.read_at) {
        bySender[m.from_user] = Math.max(bySender[m.from_user] || 0, m.read_at);
      }
    });
    Object.entries(bySender).forEach(([sender, readAt]) => {
      notifyUser(sender, 'read', { by: me, read_at: readAt });
    });
  }

  res.json(rows.map(m => ({
    id: m.id,
    from_user: m.from_user,
    to_user: m.to_user,
    type: m.type,
    text: m.deleted ? '' : (m.text || ''),
    audio_url: m.audio_url,
    duration: m.duration,
    file_url: m.file_url,
    file_name: m.file_name,
    file_size: m.file_size,
    file_mime: m.file_mime,
    is_image: m.is_image,
    created_at: m.created_at,
    read_at: m.read_at,
    deleted: !!m.deleted,
    reactions: m.reactions || {},
    reply_to: m.reply_to || null
  })));
});

app.post('/api/read/:with', authMiddleware, (req, res) => {
  const me = req.user.username;
  const other = req.params.with;
  const now = Math.floor(Date.now() / 1000);
  let changed = false;
  db.messages.forEach(m => {
    if (m.from_user === other && m.to_user === me && !m.read_at) {
      m.read_at = now;
      changed = true;
    }
  });
  if (changed) {
    saveDB();
    notifyUser(other, 'read', { by: me, read_at: now });
  }
  res.json({ ok: true });
});

app.post('/api/voice', authMiddleware, uploadVoiceMw.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'нет файла' });
  const to = req.body.to;
  if (!to) return res.status(400).json({ error: 'не указан получатель' });

  const audioUrl = '/uploads/' + req.file.filename;
  const now = Math.floor(Date.now() / 1000);
  const duration = parseInt(req.body.duration || '0', 10);
  const replyTo = req.body.reply_to ? parseInt(req.body.reply_to, 10) : null;

  const msg = {
    id: nextMessageId++,
    from_user: req.user.username, to_user: to, type: 'voice',
    audio_url: audioUrl, duration, text: '',
    created_at: now, read_at: null,
    deleted: false, deleted_for: [], reactions: {}, reply_to: replyTo
  };
  db.messages.push(msg);
  saveDB();

  const payload = serializeMessage(msg);
  notifyUser(to, 'message', payload);
  notifyUser(req.user.username, 'message', payload);
  res.json({ ok: true, url: audioUrl });
});

app.post('/api/file', authMiddleware, uploadFileMw.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'нет файла' });
  const to = req.body.to;
  if (!to) return res.status(400).json({ error: 'не указан получатель' });

  const fileUrl = '/uploads/files/' + req.file.filename;
  const now = Math.floor(Date.now() / 1000);
  const fileSize = req.file.size;

  let fileName = req.file.originalname;
  try {
    fileName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  } catch (e) {}

  const fileMime = req.file.mimetype;
  const isImage = fileMime.startsWith('image/');
  const replyTo = req.body.reply_to ? parseInt(req.body.reply_to, 10) : null;

  const msg = {
    id: nextMessageId++,
    from_user: req.user.username, to_user: to, type: 'file',
    file_url: fileUrl, file_name: fileName, file_size: fileSize,
    file_mime: fileMime, is_image: isImage, text: '',
    created_at: now, read_at: null,
    deleted: false, deleted_for: [], reactions: {}, reply_to: replyTo
  };
  db.messages.push(msg);
  saveDB();

  const payload = serializeMessage(msg);
  notifyUser(to, 'message', payload);
  notifyUser(req.user.username, 'message', payload);
  res.json({ ok: true, url: fileUrl });
});

app.post('/api/background', authMiddleware, uploadBgMw.single('bg'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'нет файла' });
  const url = '/uploads/backgrounds/' + req.file.filename;
  res.json({ ok: true, url });
});

app.get('/api/download/:filename', (req, res) => {
  const filename = req.params.filename;
  const safe = path.basename(filename);
  const filePath = path.join(FILES_DIR, safe);
  if (!fs.existsSync(filePath)) return res.status(404).send('не найдено');
  let originalName = req.query.name || safe;
  res.download(filePath, originalName);
});

function serializeMessage(m) {
  return {
    id: m.id,
    from: m.from_user,
    to: m.to_user,
    type: m.type,
    text: m.deleted ? '' : (m.text || ''),
    audio_url: m.audio_url,
    duration: m.duration,
    file_url: m.file_url,
    file_name: m.file_name,
    file_size: m.file_size,
    file_mime: m.file_mime,
    is_image: m.is_image,
    created_at: m.created_at,
    read_at: m.read_at,
    deleted: !!m.deleted,
    reactions: m.reactions || {},
    reply_to: m.reply_to || null
  };
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'нет токена' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'неверный токен' });
  }
}

app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'файл слишком большой' });
  }
  if (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'ошибка сервера' });
  }
  next();
});

// ---------- Socket.IO ----------
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

const online = new Map();

function notifyUser(username, event, data) {
  const sockets = online.get(username);
  if (!sockets) return;
  for (const sid of sockets) io.to(sid).emit(event, data);
}

io.use((socket, next) => {
  try {
    socket.user = jwt.verify(socket.handshake.auth?.token, JWT_SECRET);
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

io.on('connection', (socket) => {
  const me = socket.user.username;
  if (!online.has(me)) online.set(me, new Set());
  online.get(me).add(socket.id);
  io.emit('online', Array.from(online.keys()));

  const meUser = findUser(me);
  if (meUser) {
    meUser.last_seen = Math.floor(Date.now() / 1000);
    saveDB();
  }

  socket.on('send', ({ to, text, reply_to }, ack) => {
    if (!to || !text || !text.trim()) return ack?.({ error: 'пусто' });
    const clean = text.trim().slice(0, 2000);
    const now = Math.floor(Date.now() / 1000);
    const replyTo = reply_to ? parseInt(reply_to, 10) : null;

    const msg = {
      id: nextMessageId++,
      from_user: me, to_user: to, type: 'text',
      text: clean, created_at: now, read_at: null,
      deleted: false, deleted_for: [], reactions: {}, reply_to: replyTo
    };
    db.messages.push(msg);
    saveDB();

    const payload = serializeMessage(msg);
    notifyUser(to, 'message', payload);
    notifyUser(me, 'message', payload);

    ack?.({ ok: true, id: msg.id });
  });

  socket.on('read', ({ with: withUser }) => {
    if (!withUser) return;
    const now = Math.floor(Date.now() / 1000);
    let changed = false;
    db.messages.forEach(m => {
      if (m.from_user === withUser && m.to_user === me && !m.read_at) {
        m.read_at = now;
        changed = true;
      }
    });
    if (changed) {
      saveDB();
      notifyUser(withUser, 'read', { by: me, read_at: now });
    }
  });

  socket.on('typing', ({ to, typing }) => {
    if (!to) return;
    notifyUser(to, 'typing', { from: me, typing: !!typing });
  });

  socket.on('delete-message', ({ id, mode }) => {
    const msg = findMessage(parseInt(id, 10));
    if (!msg) return;
    if (msg.from_user !== me) return;

    if (mode === 'all') {
      msg.deleted = true;
      msg.text = '';
      msg.audio_url = null;
      msg.file_url = null;
      msg.reactions = {};
      saveDB();
      const other = msg.to_user;
      const payload = { id: msg.id, mode: 'all' };
      notifyUser(other, 'message-deleted', payload);
      notifyUser(me, 'message-deleted', payload);
    } else {
      if (!Array.isArray(msg.deleted_for)) msg.deleted_for = [];
      if (!msg.deleted_for.includes(me)) msg.deleted_for.push(me);
      saveDB();
      notifyUser(me, 'message-deleted', { id: msg.id, mode: 'me' });
    }
  });

  socket.on('react', ({ id, emoji }) => {
    const msg = findMessage(parseInt(id, 10));
    if (!msg || msg.deleted) return;
    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];

    const arr = msg.reactions[emoji];
    const idx = arr.indexOf(me);
    if (idx >= 0) {
      arr.splice(idx, 1);
      if (arr.length === 0) delete msg.reactions[emoji];
    } else {
      arr.push(me);
    }
    saveDB();

    const payload = { id: msg.id, reactions: msg.reactions };
    const other = msg.from_user === me ? msg.to_user : msg.from_user;
    notifyUser(other, 'message-reaction', payload);
    notifyUser(me, 'message-reaction', payload);
  });

  socket.on('disconnect', () => {
    const set = online.get(me);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) {
        online.delete(me);
        io.emit('typing', { from: me, typing: false });
        const user = findUser(me);
        if (user) {
          user.last_seen = Math.floor(Date.now() / 1000);
          saveDB();
        }
      }
    }
    io.emit('online', Array.from(online.keys()));
  });
});

server.listen(PORT, () => {
  console.log(`BestФрендики запущен: http://localhost:${PORT}`);
});