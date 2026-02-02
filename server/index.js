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

// MEVCUT: Public klasörü (CSS/JS vs için)
app.use('/public', express.static(path.join(__dirname, 'public')));

// YENİ EKLENDİ: arkaplan.jpg gibi dosyaların kök dizinden (/arkaplan.jpg) çalışması için:
app.use(express.static(path.join(__dirname, 'public')));

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

// ---------- YENİ EKLENEN ANASAYFA (SORGULAMA EKRANI) ----------
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="tr">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Kargo Takip</title>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
            
            body {
                /* Public klasöründeki arkaplan.jpg dosyasını çeker */
                background: url('/arkaplan.jpg') no-repeat center center fixed; 
                background-size: cover;
                height: 100vh;
                display: flex;
                align-items: center;
                justify-content: center;
            }

            .card {
                background: rgba(255, 255, 255, 0.95);
                padding: 40px;
                border-radius: 15px;
                box-shadow: 0 10px 25px rgba(0,0,0,0.3);
                width: 90%;
                max-width: 450px;
                text-align: center;
                border-top: 5px solid #1e4a9e; /* Mavi Çizgi */
                animation: slideIn 1s ease-out;
            }

            h2 {
                color: #1e4a9e;
                margin-bottom: 25px;
                font-size: 22px;
                font-weight: 600;
            }

            .input-group {
                margin-bottom: 20px;
            }

            input {
                width: 100%;
                padding: 15px;
                border: 2px solid #ddd;
                border-radius: 8px;
                font-size: 16px;
                outline: none;
                transition: 0.3s;
            }

            input:focus {
                border-color: #ff7f00; /* Turuncu */
                box-shadow: 0 0 8px rgba(255, 127, 0, 0.2);
            }

            button {
                width: 100%;
                padding: 15px;
                background: #ff7f00; /* Turuncu */
                color: white;
                border: none;
                border-radius: 8px;
                font-size: 18px;
                font-weight: bold;
                cursor: pointer;
                transition: 0.3s;
            }

            button:hover {
                background: #e66900;
                transform: translateY(-2px);
            }

            @keyframes slideIn {
                from { transform: translateY(-50px); opacity: 0; }
                to { transform: translateY(0); opacity: 1; }
            }
        </style>
    </head>
    <body>

        <div class="card">
            <h2>Lütfen Kargo Takip Numaranızı Giriniz :</h2>
            <div class="input-group">
                <input type="text" id="takipNo" placeholder="Takip numarasını buraya yazınız...">
            </div>
            <button onclick="sorgula()">SORGULA</button>
        </div>

        <script>
            function sorgula() {
                var no = document.getElementById("takipNo").value;
                if(no.trim() !== "") {
                    // Girilen numarayı /t/ID adresine yönlendirir
                    window.location.href = "/t/" + no.trim();
                } else {
                    alert("Lütfen geçerli bir numara giriniz.");
                }
            }

            // Enter tuşu desteği
            document.getElementById("takipNo").addEventListener("keypress", function(event) {
                if (event.key === "Enter") {
                    sorgula();
                }
            });
        </script>

    </body>
    </html>
    `);
});

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
