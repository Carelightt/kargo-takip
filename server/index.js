// server/index.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

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
const db = new sqlite3.Database(dbPath);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS trackings (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    address TEXT NOT NULL,
    eta TEXT NOT NULL,
    company TEXT,
    carrier TEXT,
    status TEXT DEFAULT 'Hazırlandı',
    next_auto_status_at TEXT,        -- otomatik terfi zamanı (ISO)
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // Kolonlar yoksa eklemeye çalış; varsa sessizce geç
  db.run("ALTER TABLE trackings ADD COLUMN company TEXT", function(){});
  db.run("ALTER TABLE trackings ADD COLUMN carrier TEXT", function(){});
  db.run("ALTER TABLE trackings ADD COLUMN next_auto_status_at TEXT", function(){});
});

// ---------- yardımcılar ----------
function computeTomorrow08LocalISO() {
  // Sunucunun YEREL saatine göre ertesi gün 08:00
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
    const nextAuto = computeTomorrow08LocalISO(); // ertesi gün 08:00

    const q = `INSERT INTO trackings
      (id, full_name, address, eta, company, carrier, status, next_auto_status_at)
      VALUES (?,?,?,?,?,?, 'Hazırlandı', ?)`;

    db.run(q, [id, full_name, address, eta, company || null, carrier || null, nextAuto], function (err) {
      if (err) {
        console.error('DB insert error', err);
        return res.status(500).json({ error: 'db_error' });
      }
      res.json({ id, url: `${BASE_URL}/t/${id}` });
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ---------- public page ----------
app.get('/t/:id', (req, res) => {
  db.get('SELECT * FROM trackings WHERE id = ?', [req.params.id], (err, row) => {
    if (err) return res.status(500).send('DB error');
    if (!row) return res.status(404).send('Takip bulunamadı');

    const steps = ['Hazırlandı','Yola çıktı','Dağıtımda','Teslim edildi'];
    const idx = Math.max(0, steps.indexOf(row.status));
    // Hazırlandıysa çizgi ilk noktaya kadar (~%12), sonrasında orantılı
    const fillPercent = idx === 0 ? 12 : Math.round((idx / (steps.length - 1)) * 100);

    res.render('tracking', {
      item: row,
      baseUrl: BASE_URL,
      steps,
      activeIndex: idx,
      fillPercent
    });
  });
});

// ---------- admin json (opsiyonel) ----------
app.get('/admin/json', (req, res) => {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || token !== API_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

  db.all('SELECT * FROM trackings ORDER BY created_at DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'db_error' });
    res.json(rows);
  });
});

// ---------- otomatik durum terfi motoru ----------
function runAutoAdvanceTick() {
  const nowIso = new Date().toISOString();

  // 1) Hazırlandı → Yola çıktı (vakti gelenler)
  const sql = `
    UPDATE trackings
    SET status = 'Yola çıktı',
        next_auto_status_at = NULL
    WHERE status = 'Hazırlandı'
      AND next_auto_status_at IS NOT NULL
      AND next_auto_status_at <= ?`;
  db.run(sql, [nowIso], function (err) {
    if (err) return console.error('auto-advance error:', err.message);
    if (this.changes) console.log(`auto-advance: ${this.changes} kayıt 'Yola çıktı' yapıldı`);
  });
}

// Her 60 sn’de bir kontrol
setInterval(runAutoAdvanceTick, 60 * 1000);
// Sunucu açılır açılmaz bir kez çalıştır
runAutoAdvanceTick();

app.listen(PORT, () => console.log(`Server up on ${BASE_URL}`));
