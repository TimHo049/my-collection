// LEARN: require = 載入第三方套件，類似 PM 開案時找不同部門（前端/後端/DB）支援
const express = require('express');
// LEARN: Node.js v22+ 內建 node:sqlite，唔使安裝原生模組，免除 Python/C++ 編譯問題
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

// LEARN: 環境變數從 process.env 讀；不寫死才能在 dev/test/prod 用不同阜，也避免把密鑰進 Git
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json()); // LEARN: 中介軟體(middleware)，把前端送來的 JSON 自動解析成 req.body
app.use(express.static(path.join(__dirname, 'public'))); // LEARN: 靜態檔案服務，HTML/CSS/JS 直接從 public 送出

// LEARN: SQLite 是「檔案型資料庫」，整個 DB 就是一個 .db 檔，PM 可用 DB Browser 直接看 schema 與資料
const db = new DatabaseSync('collection.db');
db.exec(`CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  year TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// LEARN: 此處本來應該用 Redis 做 cache。Redis 是獨立的記憶體資料庫，重啟不消失、可多台 server 共享；
//        這裡用單機記憶體物件模擬，目的是讓你看懂 cache 邏輯，正式上線一定要換成 Redis。
const cache = {};

// LEARN: Rate Limit = 流量管制。每分鐘每個 IP 最多新增 5 筆，防止使用者或爬蟲灌爆系統；
//        PM 要關心「被擋時使用者體驗」與「商業上是否需要付費解鎖」。
const rateLimit = {};
function checkRateLimit(ip) {
  const now = Date.now();
  const window = 60 * 1000; // 1 分鐘窗
  if (!rateLimit[ip] || now - rateLimit[ip].start > window) {
    rateLimit[ip] = { start: now, count: 1 };
    return true;
  }
  rateLimit[ip].count++;
  return rateLimit[ip].count <= 5;
}

// LEARN: GET = 讀取資料，對應 PM 口中的「查詢 / 列表」；URL 通常是名詞（/api/items）
app.get('/api/items', (req, res) => {
  const items = db.prepare('SELECT * FROM items ORDER BY created_at DESC').all();
  res.json(items);
});

// LEARN: POST = 新增資料。這支 API 內部會再去呼叫 OpenLibrary 外部 API 自動補齊年份，
//        也就是「後端當中介，串接第三方服務」——PM 要關心第三方是否穩定、有無 SLA、停機怎麼辦。
app.post('/api/items', async (req, res) => {
  const ip = req.ip;
  if (!checkRateLimit(ip)) {
    // LEARN: 429 Too Many Requests = 標準的「被限流」狀態碼；前端看到 429 就該提示使用者稍後再試
    return res.status(429).json({ error: 'Rate limit: 每分鐘最多新增 5 筆' });
  }
  const { type, title } = req.body;
  if (!type || !title) return res.status(400).json({ error: 'type & title required' });

  let year = null;
  const cacheKey = `${type}:${title}`; // LEARN: cache key 要能唯一辨識這次查詢

  if (cache[cacheKey]) {
    year = cache[cacheKey]; // LEARN: cache hit — 直接用舊結果，省一次外部呼叫、也更快
  } else if (type === 'book') {
    // LEARN: 這就是「串外部 API」。OpenLibrary 是公開免費 API，不用金鑰；
    //        PM 測試這類端點常用 Postman（見下方），先確認第三方回傳格式再串接。
    const r = await fetch(`https://openlibrary.org/search.json?title=${encodeURIComponent(title)}&limit=1`);
    const data = await r.json();
    if (data.docs?.[0]?.first_publish_year) {
      year = String(data.docs[0].first_publish_year);
      cache[cacheKey] = year; // LEARN: cache miss 後把結果寫入，下次就 hit；失效策略可設 TTL（例如 1 小時後清掉）
    }
  }

  const info = db.prepare('INSERT INTO items (type, title, year) VALUES (?, ?, ?)').run(type, title, year);
  res.json({ id: info.lastInsertRowid, type, title, year });
});

// LEARN: DELETE = 刪除資料。RESTful 風格用 HTTP method 區分動作，而不是在 URL 寫 /deleteItem
app.delete('/api/items/:id', (req, res) => {
  db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
