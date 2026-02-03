// server/index.js - YEDEKLEME SİSTEMİ EKLENMİŞ HALİ
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const API_TOKEN = process.env.API_TOKEN || 'change-me';
const ADMIN_SECRET = 'f081366a24e2'; 

// JSON limitini artırdık ki büyük yedekleri yüklerken patlamasın
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Klasör Ayarları
app.set('view engine', 'ejs');
// views ve public klasörlerinin server'ın bir üstünde veya yanında olmasını garantiye alıyoruz
const viewsPath = path.join(__dirname, 'views'); // Eğer server içindeyse
app.set('views', viewsPath);

app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'public')));

// DB Başlatma
const dbPath = path.join(__dirname, 'db.sqlite');
const db = new Database(dbPath);

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

// --- YEDEKLEME SİSTEMİ (YENİ) ---

// 1. YEDEK İNDİRME
app.get('/admin/backup', (req, res) => {
    if (req.query.secret !== ADMIN_SECRET) return res.status(403).send("Yetkisiz");
    
    try {
        const rows = db.prepare('SELECT * FROM trackings').all();
        // Dosya olarak indirt
        res.setHeader('Content-Disposition', 'attachment; filename="kargo_yedek.json"');
        res.setHeader('Content-Type', 'application/json');
        res.json(rows);
    } catch (e) {
        res.status(500).send("Yedek alınamadı: " + e.message);
    }
});

// 2. YEDEK YÜKLEME
app.post('/admin/restore', (req, res) => {
    const { secret, data } = req.body;
    if (secret !== ADMIN_SECRET) return res.status(403).json({ success: false, msg: "Yetkisiz" });

    if (!Array.isArray(data)) return res.status(400).json({ success: false, msg: "Geçersiz veri formatı" });

    try {
        const insert = db.prepare(`INSERT OR REPLACE INTO trackings (id, full_name, address, eta, company, carrier, status, created_at) VALUES (@id, @full_name, @address, @eta, @company, @carrier, @status, @created_at)`);
        
        const insertMany = db.transaction((kargolar) => {
            for (const kargo of kargolar) insert.run(kargo);
        });

        insertMany(data);
        res.json({ success: true, count: data.length });
    } catch (e) {
        res.status(500).json({ success: false, msg: e.message });
    }
});

// --- DİĞER ROUTE'LAR (AYNEN DEVAM) ---

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"><title>Kargo Takip</title><style>*{margin:0;padding:0;box-sizing:border-box;font-family:sans-serif}body{background:url('/public/arkaplan.jpg')no-repeat center center fixed;background-size:cover;height:100vh;display:flex;align-items:center;justify-content:center}.card{background:rgba(255,255,255,0.95);padding:40px;border-radius:15px;width:90%;max-width:450px;text-align:center;border-top:5px solid #1e4a9e;box-shadow:0 10px 25px rgba(0,0,0,0.3)}h2{color:#1e4a9e;margin-bottom:20px}input{width:100%;padding:15px;border:2px solid #ddd;border-radius:8px;margin-bottom:20px;font-size:16px}button{width:100%;padding:15px;background:#ff7f00;color:white;border:none;border-radius:8px;font-size:18px;font-weight:bold;cursor:pointer}button:hover{background:#e66900}</style></head><body><div class="card"><h2>Lütfen Kargo Takip Numaranızı Giriniz :</h2><input type="text" id="takipNo" placeholder="Takip No Giriniz..."><button onclick="git()">SORGULA</button></div><script>function git(){var val=document.getElementById("takipNo").value.trim();if(val)window.location.href="/t/"+val}document.getElementById("takipNo").addEventListener("keypress",function(e){if(e.key==="Enter")git()});</script></body></html>`);
});

app.get('/admin', (req, res) => {
    if (req.query.secret !== ADMIN_SECRET) return res.status(403).send("Giriş Yasak");
    const trackings = db.prepare('SELECT * FROM trackings ORDER BY created_at DESC').all();
    res.render('admin', { items: trackings, secret: ADMIN_SECRET });
});

app.post('/admin/create', (req, res) => {
    const { id, full_name, address, eta, secret } = req.body;
    if (secret !== ADMIN_SECRET) return res.status(403).send("Yetkisiz");
    try {
        const trackingId = id && id.trim() !== '' ? id.trim() : crypto.randomBytes(6).toString('hex');
        const insertEta = eta || new Date().toISOString().split('T')[0];
        db.prepare(`INSERT INTO trackings (id, full_name, address, eta, status) VALUES (?, ?, ?, ?, 'Hazırlandı')`).run(trackingId, full_name, address, insertEta);
        res.redirect('/admin?secret=' + secret);
    } catch (e) { res.send(e.message); }
});

app.post('/admin/update', (req, res) => {
    const { id, status, eta, secret } = req.body;
    if (secret !== ADMIN_SECRET) return res.status(403).send("Yetkisiz");
    db.prepare('UPDATE trackings SET status = ?, eta = ? WHERE id = ?').run(status, eta, id);
    res.redirect('/admin?secret=' + secret);
});

app.post('/api/tracking', (req, res) => {
    const auth = req.headers['authorization'] || '';
    if (auth.replace('Bearer ', '') !== API_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
    const { full_name, address, eta } = req.body || {};
    const id = crypto.randomBytes(6).toString('hex');
    const insertEta = eta || new Date().toISOString().split('T')[0];
    db.prepare(`INSERT INTO trackings (id, full_name, address, eta, status) VALUES (?, ?, ?, ?, 'Hazırlandı')`).run(id, full_name, address, insertEta);
    res.json({ id, url: `${BASE_URL}/t/${id}` });
});

app.get('/t/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM trackings WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).send('Takip bulunamadı');
    const steps = ['Hazırlandı','Yola çıktı','Dağıtımda','Teslim edildi'];
    const idx = Math.max(0, steps.indexOf(row.status));
    const fillPercent = idx === 0 ? 12 : Math.round((idx / (steps.length - 1)) * 100);
    res.render('tracking', { item: row, baseUrl: BASE_URL, steps, activeIndex: idx, fillPercent });
});

app.listen(PORT, () => console.log(`Server aktif: ${BASE_URL}`));
