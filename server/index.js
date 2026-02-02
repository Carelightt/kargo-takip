// server/index.js - GÜNCELLENMİŞ VERSİYON (MANUEL EKLEME ÖZELLİKLİ)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const API_TOKEN = process.env.API_TOKEN || 'change-me';
// Admin şifren burada (bunu değiştirebilirsin)
const ADMIN_SECRET = '123456'; 

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Form verilerini okumak için

app.use('/public', express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// DB Başlatma
const dbPath = path.join(__dirname, 'db.sqlite');
const db = new Database(dbPath);

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

// --- ROUTE: ANASAYFA ---
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="tr">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Kargo Takip</title>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; font-family: sans-serif; }
            body { background: url('/public/arkaplan.jpg') no-repeat center center fixed; background-size: cover; height: 100vh; display: flex; align-items: center; justify-content: center; }
            .card { background: rgba(255,255,255,0.95); padding: 40px; border-radius: 15px; width: 90%; max-width: 450px; text-align: center; border-top: 5px solid #1e4a9e; box-shadow: 0 10px 25px rgba(0,0,0,0.3); }
            h2 { color: #1e4a9e; margin-bottom: 20px; }
            input { width: 100%; padding: 15px; border: 2px solid #ddd; border-radius: 8px; margin-bottom: 20px; font-size: 16px; }
            button { width: 100%; padding: 15px; background: #ff7f00; color: white; border: none; border-radius: 8px; font-size: 18px; font-weight: bold; cursor: pointer; }
            button:hover { background: #e66900; }
        </style>
    </head>
    <body>
        <div class="card">
            <h2>Lütfen Kargo Takip Numaranızı Giriniz :</h2>
            <input type="text" id="takipNo" placeholder="Takip No Giriniz...">
            <button onclick="git()">SORGULA</button>
        </div>
        <script>
            function git() {
                var val = document.getElementById("takipNo").value.trim();
                if(val) window.location.href = "/t/" + val;
            }
            // Enter tuşu desteği
            document.getElementById("takipNo").addEventListener("keypress", function(event) {
                if (event.key === "Enter") git();
            });
        </script>
    </body>
    </html>
    `);
});

// --- ROUTE: ADMIN PANELİ GÖRÜNTÜLEME ---
app.get('/admin', (req, res) => {
    if (req.query.secret !== ADMIN_SECRET) return res.status(403).send("Giriş Yasak: URL sonuna ?secret=ŞİFRE eklemeyi unuttunuz.");

    const trackings = db.prepare('SELECT * FROM trackings ORDER BY created_at DESC').all();
    res.render('admin', { items: trackings, secret: ADMIN_SECRET, error: null });
});

// --- ROUTE: ADMIN YENİ KARGO EKLEME (MANUEL) ---
app.post('/admin/create', (req, res) => {
    const { id, full_name, address, eta, secret } = req.body;
    
    // Güvenlik Kontrolü
    if (secret !== ADMIN_SECRET) return res.status(403).send("Yetkisiz işlem");

    try {
        // ID boşsa otomatik oluştur, doluysa onu kullan
        const trackingId = id && id.trim() !== '' ? id.trim() : crypto.randomBytes(6).toString('hex');
        const insertEta = eta || new Date().toISOString().split('T')[0];

        const stmt = db.prepare(`INSERT INTO trackings (id, full_name, address, eta, status) VALUES (?, ?, ?, ?, 'Hazırlandı')`);
        stmt.run(trackingId, full_name, address, insertEta);
        
        // Başarılıysa admin paneline geri dön
        res.redirect('/admin?secret=' + secret);
    } catch (e) {
        // Hata varsa (örn: aynı ID kullanıldıysa)
        res.send(`<h1>Hata Oluştu</h1><p>${e.message}</p><a href="/admin?secret=${secret}">Geri Dön</a>`);
    }
});

// --- ROUTE: ADMIN GÜNCELLEME ---
app.post('/admin/update', (req, res) => {
    const { id, status, eta, secret } = req.body;
    
    if (secret !== ADMIN_SECRET) return res.status(403).send("Yetkisiz işlem");

    try {
        const stmt = db.prepare('UPDATE trackings SET status = ?, eta = ? WHERE id = ?');
        stmt.run(status, eta, id);
        res.redirect('/admin?secret=' + secret);
    } catch (e) {
        res.send('Hata oluştu: ' + e.message);
    }
});

// --- ROUTE: ADMIN SİLME (OPSİYONEL) ---
app.post('/admin/delete', (req, res) => {
    const { id, secret } = req.body;
    if (secret !== ADMIN_SECRET) return res.status(403).send("Yetkisiz işlem");
    try {
        db.prepare('DELETE FROM trackings WHERE id = ?').run(id);
        res.redirect('/admin?secret=' + secret);
    } catch(e) { res.send(e.message); }
});

// --- ROUTE: API (BOT İÇİN) ---
app.post('/api/tracking', (req, res) => {
  try {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token || token !== API_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

    const { full_name, address, eta } = req.body || {};
    const id = crypto.randomBytes(6).toString('hex');
    const insertEta = eta || new Date().toISOString().split('T')[0];

    const stmt = db.prepare(`INSERT INTO trackings (id, full_name, address, eta, status) VALUES (?, ?, ?, ?, 'Hazırlandı')`);
    stmt.run(id, full_name, address, insertEta);
    
    res.json({ id, url: `${BASE_URL}/t/${id}` });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

// --- ROUTE: KARGO GÖRÜNTÜLEME ---
app.get('/t/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM trackings WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).send(`
        <h2 style="text-align:center; margin-top:50px;">Takip Bulunamadı</h2>
        <p style="text-align:center;">Aradığınız <b>${req.params.id}</b> numaralı kargo sistemde kayıtlı değil.</p>
    `);

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

app.listen(PORT, () =>
