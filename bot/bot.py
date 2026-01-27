from dotenv import load_dotenv
load_dotenv()

import os, sqlite3, logging, datetime as dt, requests, threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from typing import Optional

from telegram import Update, Chat
from telegram.ext import (
    Application, CommandHandler, MessageHandler, ContextTypes, filters
)

# ------------ RENDER İÇİN DUMMY WEB SERVER (EKLENDİ) ------------
# Render Web Service bir port dinlemek zorundadır.
# Bu basit sunucu Render'ı kandırıp uygulamanın "canlı" olduğunu söyler.

class HealthCheckHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-type', 'text/html')
        self.end_headers()
        self.wfile.write(b"Bot calisiyor! (Kargo Bot)")

def start_keep_alive():
    port = int(os.environ.get("PORT", 8080))
    server = HTTPServer(("0.0.0.0", port), HealthCheckHandler)
    print(f"Dummy server {port} portunda baslatildi.")
    server.serve_forever()

# ------------ ENV ------------
BOT_TOKEN      = os.environ.get("BOT_TOKEN")
API_BASE       = os.environ.get("API_BASE", "http://localhost:3000")
API_TOKEN      = os.environ.get("API_TOKEN", "change-me")
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "CengizzAtay").lstrip("@")

SHORTENER_ORDER = [
    s.strip().lower() for s in os.environ.get("SHORTENER_ORDER", "cleanuri,isgd,tinyurl").split(",")
    if s.strip()
]

if not BOT_TOKEN:
    raise SystemExit("BOT_TOKEN env eksik")

# ------------ LOG ------------
logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
log = logging.getLogger("kargo-bot")

# ------------ DB (ÇÖZÜM BURADA) ------------
# Hata veren '/var/data' gibi yetki gerektiren yollardan kaçınmak için
# her zaman botun kendi klasörünü kullanıyoruz.
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "bot_state.sqlite")

def db() -> sqlite3.Connection:
    # check_same_thread=False asenkron bot için şart
    con = sqlite3.connect(DB_PATH, check_same_thread=False)
    con.row_factory = sqlite3.Row
    return con

def init_db():
    try:
        with db() as con:
            con.executescript("""
            CREATE TABLE IF NOT EXISTS groups (
                chat_id    INTEGER PRIMARY KEY,
                title      TEXT,
                quota      INTEGER DEFAULT 0,
                disabled   INTEGER DEFAULT 0,
                updated_at TEXT
            );
            CREATE TABLE IF NOT EXISTS logs (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id    INTEGER,
                chat_title TEXT,
                item_id    TEXT,
                company    TEXT,
                created_at TEXT
            );
            """)
        log.info(f"Veritabanı başarıyla bağlandı: {DB_PATH}")
    except Exception as e:
        log.error(f"Kritik DB hatası: {e}")
        raise e

# Bot ayağa kalkmadan önce DB'yi hazırla
init_db()

# ------------ HELPERS ------------
def is_admin(user) -> bool:
    return (user and (user.username or "").lower() == ADMIN_USERNAME.lower())

def chat_kind(chat: Chat) -> str:
    return chat.type

def today_range_iso(tz: Optional[dt.tzinfo]=None):
    now = dt.datetime.now(tz)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end   = start + dt.timedelta(days=1)
    return start.isoformat(), end.isoformat()

def get_group(con: sqlite3.Connection, chat_id: int):
    cur = con.execute("SELECT * FROM groups WHERE chat_id=?", (chat_id,))
    return cur.fetchone()

def upsert_group(con: sqlite3.Connection, chat_id: int, title: str):
    con.execute("""
        INSERT INTO groups(chat_id, title, quota, disabled, updated_at)
        VALUES (?, ?, 0, 0, ?)
        ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at
    """, (chat_id, title, dt.datetime.utcnow().isoformat()))

def dec_quota(con: sqlite3.Connection, chat_id: int):
    con.execute("UPDATE groups SET quota = quota - 1, updated_at=? WHERE chat_id=?",
                (dt.datetime.utcnow().isoformat(), chat_id))

def set_quota(con: sqlite3.Connection, chat_id: int, title: str, quota: int):
    con.execute("""
        INSERT INTO groups(chat_id, title, quota, disabled, updated_at)
        VALUES (?, ?, ?, 0, ?)
        ON CONFLICT(chat_id) DO UPDATE SET quota=excluded.quota, disabled=0, title=excluded.title, updated_at=excluded.updated_at
    """, (chat_id, title, quota, dt.datetime.utcnow().isoformat()))

def set_disabled(con: sqlite3.Connection, chat_id: int, title: str, disabled: bool):
    con.execute("""
        INSERT INTO groups(chat_id, title, quota, disabled, updated_at)
        VALUES (?, ?, 0, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET disabled=excluded.disabled, title=excluded.title, updated_at=excluded.updated_at
    """, (chat_id, title, 1 if disabled else 0, dt.datetime.utcnow().isoformat()))

def log_create(con: sqlite3.Connection, chat_id: int, chat_title: str, item_id: str, company: str):
    con.execute("""
        INSERT INTO logs(chat_id, chat_title, item_id, company, created_at)
        VALUES (?,?,?,?,?)
    """, (chat_id, chat_title, item_id, company or "", dt.datetime.utcnow().isoformat()))

# ------------ COMMANDS ------------
async def start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if chat_kind(update.effective_chat) == "private":
        await update.message.reply_text("Lütfen @CengizzAtay ile iletişime geçin.")
        return
    await update.message.reply_text(
        "Selam! /kargo komutunu şu formatta tek mesajda gönder:\n\n"
        "/kargo\nAd Soyad\nAdres\nTarih\nFirma Adı"
    )

async def dm_guard(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if chat_kind(update.effective_chat) == "private":
        await update.message.reply_text("Lütfen @CengizzAtay ile iletişime geçin.")

async def kargo(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    chat = update.effective_chat
    if chat_kind(chat) == "private":
        await update.message.reply_text("Lütfen @CengizzAtay ile iletişime geçin.")
        return

    text = (update.message.text or "").splitlines()
    lines = [l.strip() for l in text[1:] if l.strip()]
    if len(lines) < 4:
        await update.message.reply_text("Format:\n/kargo\nAd Soyad\nAdres\nTarih\nFirma Adı")
        return

    full_name, address, eta_str, company = lines[0], lines[1], lines[2], lines[3]
    api_eta = eta_str
    try:
        parsed_date = dt.datetime.strptime(eta_str.replace("/", "."), "%d.%m.%Y")
        api_eta = parsed_date.strftime("%Y-%m-%d")
    except ValueError:
        pass

    with db() as con:
        upsert_group(con, chat.id, chat.title or str(chat.id))
        g = get_group(con, chat.id)
        if g["disabled"]:
            await update.message.reply_text("Bu grupta işlemler kapalıdır. Lütfen @CengizzAtay yazınız.")
            return
        if g["quota"] <= 0:
            await update.message.reply_text("Hakkınız yoktur. Lütfen @CengizzAtay yaz.")
            return

    try:
        payload = {
            "full_name": full_name,
            "address": address,
            "eta": api_eta,
            "company": company,
            "carrier": "yurtici"
        }
        r = requests.post(
            f"{API_BASE}/api/tracking",
            json=payload,
            headers={"Authorization": f"Bearer {API_TOKEN}", "Content-Type":"application/json"},
            timeout=15
        )
        if r.status_code != 200:
            await update.message.reply_text("Sunucuya ulaşılamadı veya hata oluştu.")
            return
        data = r.json()
    except Exception:
        await update.message.reply_text("Sunucuya ulaşılamadı veya hata oluştu.")
        return

    with db() as con:
        dec_quota(con, chat.id)
        log_create(con, chat.id, chat.title or str(chat.id), data.get("id",""), company)
        left = con.execute("SELECT quota FROM groups WHERE chat_id=?", (chat.id,)).fetchone()["quota"]

    url = data.get("url", f"{API_BASE}/t/{data.get('id','')}")
    shown_url = url
    track_id = data.get("id","")

    msg = (
        "Kargo Takip Sitesi hazır:\n\n"
        f"{shown_url}\n\n"
        f"Kalan Hak : {left}\n\n"
        "Müşteriye Gönderilecek Örnek Mesaj :\n\n"
        f"Merhaba {full_name}. Ürünleriniz kargoya verilmiştir. Aşağıdaki linkten direkt kargonuzu sorgulayabilirsiniz.\n"
        f"Kargo Takip Numarası : {track_id}\n"
        "Kargo Takip Sitesi : \n"
        f"{shown_url}\n"
        f"Tahmini Teslim Süresi : {eta_str}"
    )
    await update.message.reply_text(msg)

async def kalanhak(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    chat = update.effective_chat
    if chat_kind(chat) == "private":
        await update.message.reply_text("Bu komut grup içinde kullanılabilir.")
        return
    with db() as con:
        upsert_group(con, chat.id, chat.title or str(chat.id))
        g = get_group(con, chat.id)
    status = "Kapalı" if g["disabled"] else "Açık"
    await update.message.reply_text(f"Grup: {g['title']}\nDurum: {status}\nKalan Hak: {g['quota']}")

async def hakver(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    if not is_admin(user): return
    chat = update.effective_chat
    args = (update.message.text or "").strip().split()
    if len(args) != 2 or not args[1].isdigit():
        await update.message.reply_text("Kullanım: /hakver 5")
        return
    quota = int(args[1])
    with db() as con:
        set_quota(con, chat.id, chat.title or str(chat.id), quota)
    await update.message.reply_text(f"Bu gruba {quota} hak verildi.")

async def bitir(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    if not is_admin(user): return
    chat = update.effective_chat
    with db() as con:
        set_disabled(con, chat.id, chat.title or str(chat.id), True)
    await update.message.reply_text("Bu grup için işlemler kapatıldı.")

async def rapor(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    if not is_admin(user): return
    start_iso, end_iso = today_range_iso()
    with db() as con:
        rows = con.execute("""
            SELECT chat_id, chat_title, company, COUNT(*) as cnt
            FROM logs
            WHERE created_at >= ? AND created_at < ?
            GROUP BY chat_id, chat_title, company
            ORDER BY chat_title COLLATE NOCASE
        """, (start_iso, end_iso)).fetchall()

        totals = con.execute("""
            SELECT chat_id, chat_title, COUNT(*) as cnt
            FROM logs
            WHERE created_at >= ? AND created_at < ?
            GROUP BY chat_id, chat_title
            ORDER BY chat_title COLLATE NOCASE
        """, (start_iso, end_iso)).fetchall()

    if not rows:
        await update.message.reply_text("Bugün henüz kayıt yok.")
        return

    parts = []
    tmap = {r["chat_id"]: r["cnt"] for r in totals}
    current_chat = None
    for r in rows:
        if r["chat_id"] != current_chat:
            current_chat = r["chat_id"]
            parts.append(f"\n *{r['chat_title']}* — Toplam: *{tmap.get(current_chat,0)}*")
        comp = r["company"] or "—"
        parts.append(f"    • {comp}: *{r['cnt']}*")

    await update.message.reply_markdown_v2(
        "*Günlük Rapor*\n" + "\n".join(parts)
            .replace("-", "\\-").replace(".", "\\.")
    )

async def unknown_dm(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if chat_kind(update.effective_chat) == "private":
        await update.message.reply_text("Lütfen @CengizzAtay ile iletişime geçin.")

# ------------ MAIN ------------
def main():
    # 1. ÖNCE Dummy Web Server'ı ayrı bir thread'de başlatıyoruz.
    # Bu sayede Render, uygulamanın PORT dinlediğini görüp "Live" işaretliyor.
    t = threading.Thread(target=start_keep_alive, daemon=True)
    t.start()

    # 2. Sonra Bot'u başlatıyoruz.
    app = Application.builder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("kargo", kargo))
    app.add_handler(CommandHandler("kalanhak", kalanhak))
    app.add_handler(CommandHandler("hakver", hakver))
    app.add_handler(CommandHandler("bitir", bitir))
    app.add_handler(CommandHandler("rapor", rapor))

    app.add_handler(MessageHandler(filters.ChatType.PRIVATE & ~filters.COMMAND, dm_guard))
    app.add_handler(MessageHandler(filters.ChatType.PRIVATE & filters.COMMAND, dm_guard))
    app.add_handler(MessageHandler(filters.ChatType.PRIVATE, unknown_dm))

    log.info("Bot starting…")
    app.run_polling()

if __name__ == "__main__":
    main()
