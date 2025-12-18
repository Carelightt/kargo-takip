// server/index.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3'); // sqlite3 yerine better-sqlite3

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const API_TOKEN = process.env.API_TOKEN || 'change-me';

app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ---------- DB init + migrasyonlar ----------
const dbPath = path.join(__dirname, 'db.sqlite');
// better-sqlite3 senkron çalışır, bu yüzden daha hızlı ve kurulumu kolaydır
const db = new Database(dbPath, { verbose: console.log });

// Tabloyu oluştur
db.exec(`CREATE TABLE IF NOT EXISTS trackings (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    address TEXT NOT NULL,
    eta TEXT NOT NULL,
    company TEXT,
    carrier TEXT,
    status TEXT DEFAULT 'Hazırlandı',
    next_auto_status_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

// Kolon kontrolü ve ekleme (better-sqlite3 ile hata yönetimi)
const addColumn = (colName, colType) => {
  try {
    db.exec(`ALTER TABLE trackings ADD COLUMN ${colName} ${colType}`);
  } catch (e) {
    // Kolon zaten varsa hata verir, sessizce geçiyoruz
  }
};

addColumn('company', 'TEXT');
addColumn('carrier', 'TEXT');
addColumn('next_auto_status_at', 'TEXT');

// ---------- yardımcılar ----------
function computeTomorrow08LocalISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d.toISOString();
}

// ---------- health ----------
app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------- create tracking (korumalı) ----------
app.post('/api/tracking', (req, res) => {
  try {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token || token !== API_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

    const { full_name, address, eta, company, carrier } = req.body || {};
    if (!full_name || !address || !eta) {
      return res.status(400).json({ error: 'full_name, address, eta boş olamaz' });
    }

    const id = crypto.randomBytes(6).toString('hex');
    const nextAuto = computeTomorrow08LocalISO();

    const stmt = db.prepare(`INSERT INTO trackings
      (id, full_name, address, eta, company, carrier, status, next_auto_status_at)
      VALUES (?, ?, ?, ?, ?, ?, 'Hazırlandı', ?)`);

    stmt.run(id, full_name, address, eta, company || null, carrier || null, nextAuto);
    
    res.json({ id, url: `${BASE_URL}/t/${id}` });
  } catch (e) {
    console.error('Create error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ---------- public page ----------
app.get('/t/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM trackings WHERE id = ?').get(req.params.id);
    
    if (!row) return res.status(404).send('Takip bulunamadı');

    const steps = ['Hazırlandı','Yola çıktı','Dağıtımda','Teslim edildi'];
    const idx = Math.max(0, steps.indexOf(row.status));
    const fillPercent = idx === 0 ? 12 : Math.round((idx / (steps.length - 1)) * 100);

    res.render('tracking', {
      item: row,
      baseUrl: BASE_URL,
      steps,
      activeIndex: idx,
      fillPercent
    });
  } catch (e) {
    res.status(500).send('DB error');
  }
});

// ---------- admin json (opsiyonel) ----------
app.get('/admin/json', (req, res) => {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || token !== API_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const rows = db.prepare('SELECT * FROM trackings ORDER BY created_at DESC').all();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'db_error' });
  }
});

// ---------- otomatik durum terfi motoru ----------
function runAutoAdvanceTick() {
  const nowIso = new Date().toISOString();

  try {
    const stmt = db.prepare(`
      UPDATE trackings
      SET status = 'Yola çıktı',
          next_auto_status_at = NULL
      WHERE status = 'Hazırlandı'
        AND next_auto_status_at IS NOT NULL
        AND next_auto_status_at <= ?`);
    
    const info = stmt.run(nowIso);
    if (info.changes) {
      console.log(`auto-advance: ${info.changes} kayıt 'Yola çıktı' yapıldı`);
    }
  } catch (err) {
    console.error('auto-advance error:', err.message);
  }
}

// Periyodik kontrol
setInterval(runAutoAdvanceTick, 60 * 1000);
runAutoAdvanceTick();

app.listen(PORT, () => console.log(`Server up on ${BASE_URL}`));
