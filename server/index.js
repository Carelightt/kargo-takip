// server/index.js - GITHUB OTOMATİK SENKRONİZASYONLU VERSİYON 🚀
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const API_TOKEN = process.env.API_TOKEN || 'change-me';
const ADMIN_SECRET = 'f081366a24e2'; 

// --- ⚙️ GITHUB AYARLARI (BURAYI DOLDUR) ⚙️ ---
const GITHUB_USER = 'Carelightt';      // GitHub Kullanıcı Adın
const GITHUB_REPO = 'kargo-takip';     // Repo Adın (Linkteki gibi)
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const YEDEK_DOSYA_ADI = 'veritabani_yedek.json'; // GitHub'da oluşacak dosya adı

// --- TELEGRAM AYARLARI ---
const TELEGRAM_BOT_TOKEN = '8462814676:AAFDZ1cXE9bh4V2wyZ9r-wMoA4UY0j3czCQ';
const TELEGRAM_CHAT_ID = '6672759317'; 
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.use('/public', express.static(path.join(__dirname, '../public')));
app.use(express.static(path.join(__dirname, '../public')));

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
    source TEXT DEFAULT 'Bilinmiyor',
    next_auto_status_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

try {
    db.prepare("ALTER TABLE trackings ADD COLUMN source TEXT DEFAULT 'Bilinmiyor'").run();
} catch (e) {}

// ==========================================
// 🌐 GITHUB SENKRONİZASYON FONKSİYONLARI
// ==========================================

// 1. GitHub'dan Veriyi Çekip DB'ye Yükle (Site açılınca çalışır)
async function githubdanYukle() {
    console.log('🌍 GitHub\'dan yedek kontrol ediliyor...');
    try {
        const url = `https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${YEDEK_DOSYA_ADI}`;
        const response = await fetch(url, {
            headers: { 
                'Authorization': `token ${GITHUB_TOKEN}`,
                'User-Agent': 'NodeKargoApp'
            }
        });

        if (response.status === 404) {
            console.log('ℹ️ GitHub\'da henüz yedek dosyası yok. İlk kayıt bekleniyor.');
            return;
        }

        const json = await response.json();
        // GitHub içeriği base64 kodlar, onu çözüyoruz
        const content = Buffer.from(json.content, 'base64').toString('utf-8');
        const data = JSON.parse(content);

        if (Array.isArray(data)) {
            const insert = db.prepare(`INSERT OR REPLACE INTO trackings (id, full_name, address, eta, company, carrier, status, source, created_at) VALUES (@id, @full_name, @address, @eta, @company, @carrier, @status, @source, @created_at)`);
            const insertMany = db.transaction((kargolar) => {
                for (const kargo of kargolar) {
                    if (!kargo.source) kargo.source = 'GitHub Yedek';
                    insert.run(kargo);
                }
            });
            insertMany(data);
            console.log(`✅ GitHub'dan ${data.length} kayıt başarıyla yüklendi!`);
        }
    } catch (error) {
        console.error('❌ GitHub yükleme hatası:', error.message);
    }
}

// 2. Veritabanını GitHub'a Kaydet (Kargo eklenince çalışır)
async function githubaYedekle() {
    // Burayı "Fire and Forget" yapıyoruz, kullanıcıyı bekletmiyoruz.
    setTimeout(async () => {
        try {
            const tumKargolar = db.prepare('SELECT * FROM trackings').all();
            const jsonIcerik = JSON.stringify(tumKargolar, null, 2);
            const base64Icerik = Buffer.from(jsonIcerik).toString('base64');
            const url = `https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${YEDEK_DOSYA_ADI}`;

            // Önce dosyanın SHA bilgisini almalıyız (Update için şart)
            let sha = null;
            try {
                const getRes = await fetch(url, {
                    headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'NodeKargoApp' }
                });
                if (getRes.ok) {
                    const getData = await getRes.json();
                    sha = getData.sha;
                }
            } catch (err) {}

            // Dosyayı oluştur veya güncelle
            const body = {
                message: `Otomatik Yedek: ${new Date().toLocaleString('tr-TR')}`,
                content: base64Icerik,
                sha: sha // Dosya varsa sha gerekli, yoksa null
            };

            await fetch(url, {
                method: 'PUT',
                headers: { 
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Content-Type': 'application/json',
                    'User-Agent': 'NodeKargoApp'
                },
                body: JSON.stringify(body)
            });

            console.log('💾 Veriler GitHub\'a otomatik yedeklendi.');

        } catch (error) {
            console.error('❌ GitHub yedekleme hatası:', error.message);
        }
    }, 1000); // 1 saniye sonra çalışsın
}

// 🚀 SUNUCU BAŞLARKEN VERİLERİ ÇEK
githubdanYukle();

// ==========================================
// ROUTE'LAR (YEDEKLEME EKLENDİ)
// ==========================================

app.get('/admin/backup', (req, res) => {
    if (req.query.secret !== ADMIN_SECRET) return res.status(403).send("Yetkisiz");
    try {
        const rows = db.prepare('SELECT * FROM trackings').all();
        res.setHeader('Content-Disposition', 'attachment; filename="kargo_yedek.json"');
        res.setHeader('Content-Type', 'application/json');
        res.json(rows);
    } catch (e) { res.status(500).send("Hata: " + e.message); }
});

app.post('/admin/restore', (req, res) => {
    const { secret, data } = req.body;
    if (secret !== ADMIN_SECRET) return res.status(403).json({ success: false, msg: "Yetkisiz" });
    if (!Array.isArray(data)) return res.status(400).json({ success: false, msg: "Geçersiz veri" });

    try {
        const insert = db.prepare(`INSERT OR REPLACE INTO trackings (id, full_name, address, eta, company, carrier, status, source, created_at) VALUES (@id, @full_name, @address, @eta, @company, @carrier, @status, @source, @created_at)`);
        const insertMany = db.transaction((kargolar) => {
            for (const kargo of kargolar) {
                if (!kargo.source) kargo.source = 'Yedek';
                insert.run(kargo);
            }
        });
        insertMany(data);
        githubaYedekle(); // RESTORE YAPINCA DA GITHUB'I GÜNCELLE
        res.json({ success: true, count: data.length });
    } catch (e) { res.status(500).json({ success: false, msg: e.message }); }
});

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"><title>Kargo Takip</title><style>*{margin:0;padding:0;box-sizing:border-box;font-family:sans-serif}body{background:url('/public/arkaplan.jpg')no-repeat center center fixed;background-size:cover;height:100vh;display:flex;align-items:center;justify-content:center}.card{background:rgba(255,255,255,0.95);padding:40px;border-radius:15px;width:90%;max-width:450px;text-align:center;border-top:5px solid #1e4a9e;box-shadow:0 10px 25px rgba(0,0,0,0.3)}h2{color:#1e4a9e;margin-bottom:20px}input{width:100%;padding:15px;border:2px solid #ddd;border-radius:8px;margin-bottom:20px;font-size:16px}button{width:100%;padding:15px;background:#ff7f00;color:white;border:none;border-radius:8px;font-size:18px;font-weight:bold;cursor:pointer}button:hover{background:#e66900}</style></head><body><div class="card"><h2>Lütfen Kargo Takip Numaranızı Giriniz :</h2><input type="text" id="takipNo" placeholder="Takip No Giriniz..."><button onclick="git()">SORGULA</button></div><script>function git(){var val=document.getElementById("takipNo").value.trim();if(val)window.location.href="/t/"+val}document.getElementById("takipNo").addEventListener("keypress",function(e){if(e.key==="Enter")git()});</script></body></html>`);
});

app.get('/admin', (req, res) => {
    try {
        if (req.query.secret !== ADMIN_SECRET) return res.status(403).send("Giriş Yasak");
        const trackings = db.prepare('SELECT * FROM trackings ORDER BY created_at DESC').all();
        res.render('admin', { items: trackings, secret: ADMIN_SECRET });
    } catch (error) { res.status(500).send(`<h1>Hata</h1><p>${error.message}</p>`); }
});

app.post('/admin/create', (req, res) => {
    const { id, full_name, address, eta, secret } = req.body;
    if (secret !== ADMIN_SECRET) return res.status(403).send("Yetkisiz");
    try {
        const trackingId = id && id.trim() !== '' ? id.trim() : crypto.randomBytes(6).toString('hex');
        const insertEta = eta || new Date().toISOString().split('T')[0];
        
        db.prepare(`INSERT INTO trackings (id, full_name, address, eta, status, source) VALUES (?, ?, ?, ?, 'Hazırlandı', 'Admin Paneli')`)
          .run(trackingId, full_name, address, insertEta);
        
        githubaYedekle(); // YENİ KAYIT EKLENİNCE GITHUB'A GÖNDER
        res.redirect('/admin?secret=' + secret);
    } catch (e) { res.send(e.message); }
});

app.post('/admin/update', (req, res) => {
    const { id, status, eta, secret } = req.body;
    if (secret !== ADMIN_SECRET) return res.status(403).send("Yetkisiz");
    db.prepare('UPDATE trackings SET status = ?, eta = ? WHERE id = ?').run(status, eta, id);
    
    githubaYedekle(); // GÜNCELLEME OLUNCA GITHUB'A GÖNDER
    res.redirect('/admin?secret=' + secret);
});

app.post('/api/tracking', (req, res) => {
    const auth = req.headers['authorization'] || '';
    if (auth.replace('Bearer ', '') !== API_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
    
    const { full_name, address, eta, group_name } = req.body || {};
    const id = crypto.randomBytes(6).toString('hex');
    const insertEta = eta || new Date().toISOString().split('T')[0];
    const source = group_name || 'Genel API'; 

    db.prepare(`INSERT INTO trackings (id, full_name, address, eta, status, source) VALUES (?, ?, ?, ?, 'Hazırlandı', ?)`)
      .run(id, full_name, address, insertEta, source);
    
    githubaYedekle(); // BOT EKLEYİNCE GITHUB'A GÖNDER
    res.json({ id, url: `${BASE_URL}/t/${id}` });
});

app.get('/t/:id', (req, res) => {
    try {
        const row = db.prepare('SELECT * FROM trackings WHERE id = ?').get(req.params.id);
        if (!row) return res.status(404).send('Takip bulunamadı');
        const steps = ['Hazırlandı','Yola çıktı','Dağıtımda','Teslim edildi'];
        const idx = Math.max(0, steps.indexOf(row.status));
        const fillPercent = idx === 0 ? 12 : Math.round((idx / (steps.length - 1)) * 100);
        res.render('tracking', { item: row, baseUrl: BASE_URL, steps, activeIndex: idx, fillPercent });
    } catch (e) { res.status(500).send(e.message); }
});

// TELEGRAM RAPOR VE YEDEK (Aynı kaldı)
cron.schedule('55 23 * * *', async () => {
    console.log('⏰ Otomatik rapor zamanı...');
    try {
        const bugunRaporu = db.prepare(`SELECT source, COUNT(*) as adet FROM trackings WHERE date(created_at) = date('now') GROUP BY source`).all();
        let raporMesaji = "📊 **GÜNLÜK KARGO RAPORU** 📊\n\n";
        
        if (bugunRaporu.length > 0) {
            let toplam = 0;
            bugunRaporu.forEach(satir => {
                raporMesaji += `🔹 ${satir.source}: ${satir.adet} adet\n`;
                toplam += satir.adet;
            });
            raporMesaji += `\n--------\n📈 **Toplam: ${toplam} adet**`;
        } else {
            raporMesaji += "Bugün hiç kargo girişi yapılmadı.";
        }
        await bot.sendMessage(TELEGRAM_CHAT_ID, raporMesaji, { parse_mode: 'Markdown' });
        
        // Telegrama da dosya atalım nolur nolmaz
        const tumKargolar = db.prepare('SELECT * FROM trackings').all();
        if (tumKargolar.length > 0) {
            const jsonIcerik = JSON.stringify(tumKargolar, null, 2);
            await bot.sendDocument(TELEGRAM_CHAT_ID, Buffer.from(jsonIcerik), {}, {
                filename: `yedek_${new Date().toISOString().split('T')[0]}.json`,
                contentType: 'application/json'
            });
        }
    } catch (error) { console.error(error); }
});

app.listen(PORT, () => console.log(`Server aktif: ${BASE_URL}`));
