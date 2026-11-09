/*
 * Elif & Yunus — Düğün sayfası sunucusu (Cloudflare Worker, tek dosya, dış bağımlılık yok)
 *
 * Supabase'in yerine geçer: sayfanın Cloudflare veri katmanı (index.html › cfStore) yalnızca bu sunucuyla konuşur.
 * Bağlar (Worker › Bindings):     DEPO → R2 kovası, DB → D1 veritabanı
 * Gizli değişkenler (Secrets):    YONETICI_SIFRE (en az 12 karakter), IMZA_ANAHTARI (uzun rastgele metin)
 * Düz değişkenler (isteğe bağlı): KOKENLER (virgülle izinli kökenler), ALAN_GB (fotoğraf alanı, varsayılan 9.5)
 *
 * Veritabanı tabloları ilk istekte kendiliğinden kurulur (D1 konsolunda SQL çalıştırmak gerekmez).
 * Misafir: dilekleri ve albümü okur, dilek yazar, fotoğraf yükler (telefon başına sınır, site geneli fren).
 * Yönetici: şifreyle giriş yapar; jetonla siler, düzenler, ayarları ve metinleri değiştirir, kapak ve müzik yükler.
 * Misafirin istekleri özel başlık taşımaz; tarayıcı CORS ön isteği (OPTIONS) göndermez, günlük istek kotası korunur.
 */

// ---------------------------------------------------------------- sabitler

const KESIN_KAPANIS = Date.parse('2027-01-01T00:00:00+03:00'); // bundan sonra misafir yazması yok
const MB = 1024 * 1024;
const FOTO_EN_COK = 3 * MB;           // büyük sürüm (sayfa fotoğrafı ~0,4 MB'a küçültür)
const KUCUK_EN_COK = 1 * MB;          // küçük sürüm (albümdeki kare)
const SITE_EN_COK = 20 * MB;          // kapak fotoğrafı, paylaşım görseli, müzik
const JETON_OMRU = 30 * 24 * 3600;    // yönetici jetonu (saniye)
const DAKIKA = 60 * 1000;
const SAAT = 60 * DAKIKA;
const GUN = 24 * SAAT;
const DILEK_YOGUNLUK = 30;            // site geneli: 60 sn'de en çok dilek
const FOTO_YOGUNLUK = 200;            // site geneli: 60 sn'de en çok fotoğraf kaydı
const DOSYA_YOGUNLUK = 400;           // site geneli: 60 sn'de en çok dosya (her fotoğraf iki dosya)
const GIRIS_DENEME = 8;               // IP başına 15 dk'da en çok hatalı giriş
const BAG_SURESI = 3 * SAAT;          // fotoğraf, dilek yazıldıktan sonraki bu süre içinde o dileğe bağlanabilir
const SAYFA_EN_COK = 1000;            // bir okumada en çok kayıt
const SONRA_EN_COK = 200;             // "yalnızca yeniler" okumasında en çok kayıt
const SON_DEGISIKLIK = 20;
const ICERIK_EN_COK = 65536;          // sayfa metinleri (JSON) en çok bu kadar bayt
const UUID_DESEN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID = new RegExp(`^${UUID_DESEN}$`);
const FOTO_YOLU = new RegExp(`^(buyuk|kucuk)/(${UUID_DESEN})\\.jpg$`);
const SITE_YOLU = new RegExp(`^(?:(?:kapak|paylasim)/${UUID_DESEN}\\.jpg|muzik/${UUID_DESEN}\\.(?:mp3|m4a))$`);
const SITE_TURU = { jpg: 'image/jpeg', mp3: 'audio/mpeg', m4a: 'audio/mp4' };
const ISO_TARIH = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;
const TABLOLAR = ['notlar', 'fotograflar'];

// Ayar alanları (Supabase'teki "ayarlar" tablosuyla aynı): 'bayrak' (true/false), 'tarih' (ISO ya da null),
// [en az, en çok, boş olabilir mi]
const AYAR_KURALI = {
  foto_acik: 'bayrak', foto_baslangic: 'tarih', foto_bitis: 'tarih',
  dilek_acik: 'bayrak', dilek_baslangic: 'tarih', dilek_bitis: 'tarih',
  album_gorunur: 'bayrak', dilekler_gorunur: 'bayrak', muzik: 'bayrak',
  dilek_siniri: [1, 50, true], foto_siniri: [1, 1000, true],
};
const AYAR_ALANLARI = Object.keys(AYAR_KURALI);

// Görünmez/yön (bidi) karakterleri: başkasının adını ya da yazısını taklit etmeye yarar, silinir
const GORUNMEZ = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\xAD]/g;
// eslint-disable-next-line no-control-regex -- kontrol karakterleri bilerek silinir (satır sonu kalır)
const KONTROL = /[\x00-\x09\x0B-\x1F\x7F-\x9F]/g;

// ---------------------------------------------------------------- veritabanı şeması

// Her ifade ayrı hazırlanır (tetikleyici gövdelerindeki noktalı virgüller sorun çıkarmasın). Tekrar çalıştırmak
// güvenlidir: hiçbir tablo silinmez. Şema değişirse SEMA_SURUMU artırılır; yeni ifadeler sona eklenir.
const SEMA_SURUMU = 1;
const SIMDI_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const degisiklikTetikleyici = (tablo, olay, islem, kayit) =>
  `CREATE TRIGGER IF NOT EXISTS ${tablo}_${islem}_kaydi AFTER ${olay} ON ${tablo} BEGIN
     INSERT INTO degisiklikler (created_at, tablo, kayit_id, islem) VALUES (${SIMDI_SQL}, '${tablo}', ${kayit}, '${islem}');
   END`;
const SEMA = [
  `CREATE TABLE IF NOT EXISTS notlar (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     created_at TEXT NOT NULL,
     isim TEXT NOT NULL,
     mesaj TEXT NOT NULL,
     bag_anahtari TEXT UNIQUE,
     cihaz_anahtari TEXT
   )`,
  'CREATE INDEX IF NOT EXISTS notlar_created_at ON notlar (created_at)',
  'CREATE INDEX IF NOT EXISTS notlar_cihaz ON notlar (cihaz_anahtari)',
  `CREATE TABLE IF NOT EXISTS fotograflar (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     created_at TEXT NOT NULL,
     isim TEXT,
     buyuk TEXT NOT NULL UNIQUE,
     kucuk TEXT NOT NULL UNIQUE,
     genislik INTEGER,
     yukseklik INTEGER,
     not_id INTEGER REFERENCES notlar (id) ON DELETE SET NULL,
     cihaz_anahtari TEXT
   )`,
  'CREATE INDEX IF NOT EXISTS fotograflar_created_at ON fotograflar (created_at)',
  'CREATE INDEX IF NOT EXISTS fotograflar_not_id ON fotograflar (not_id)',
  'CREATE INDEX IF NOT EXISTS fotograflar_cihaz ON fotograflar (cihaz_anahtari)',
  // R2'deki fotoğraf dosyaları (Supabase'teki storage.objects karşılığı): alan hesabı ve depo temizliği için
  `CREATE TABLE IF NOT EXISTS dosyalar (
     ad TEXT PRIMARY KEY,
     boyut INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     cihaz_anahtari TEXT
   )`,
  'CREATE INDEX IF NOT EXISTS dosyalar_created_at ON dosyalar (created_at)',
  // Yöneticinin sildiği/düzenlediği kayıtlar: açık sayfalar bunu izleyip kendini günceller
  `CREATE TABLE IF NOT EXISTS degisiklikler (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     created_at TEXT NOT NULL,
     tablo TEXT NOT NULL,
     kayit_id INTEGER NOT NULL,
     islem TEXT NOT NULL CHECK (islem IN ('sil', 'duzenle'))
   )`,
  `CREATE TABLE IF NOT EXISTS ayarlar (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     foto_acik INTEGER NOT NULL DEFAULT 1,
     foto_baslangic TEXT DEFAULT '2026-11-14T21:00:00.000Z',
     foto_bitis TEXT,
     dilek_acik INTEGER NOT NULL DEFAULT 1,
     dilek_baslangic TEXT,
     dilek_bitis TEXT,
     album_gorunur INTEGER NOT NULL DEFAULT 1,
     dilekler_gorunur INTEGER NOT NULL DEFAULT 1,
     muzik INTEGER NOT NULL DEFAULT 1,
     dilek_siniri INTEGER DEFAULT 3,
     foto_siniri INTEGER DEFAULT 100
   )`,
  'INSERT OR IGNORE INTO ayarlar (id) VALUES (1)',
  `CREATE TABLE IF NOT EXISTS icerik (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     veri TEXT NOT NULL DEFAULT '{}'
   )`,
  'INSERT OR IGNORE INTO icerik (id) VALUES (1)',
  // Sayaçlar: sayfa her açılışta tabloları baştan saymasın (D1'in günlük okuma kotası)
  `CREATE TABLE IF NOT EXISTS sayac (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     notlar INTEGER NOT NULL DEFAULT 0,
     fotograflar INTEGER NOT NULL DEFAULT 0,
     bayt INTEGER NOT NULL DEFAULT 0,
     dosya INTEGER NOT NULL DEFAULT 0
   )`,
  `INSERT OR IGNORE INTO sayac (id, notlar, fotograflar, bayt, dosya) SELECT 1,
     (SELECT COUNT(*) FROM notlar), (SELECT COUNT(*) FROM fotograflar),
     (SELECT COALESCE(SUM(boyut), 0) FROM dosyalar), (SELECT COUNT(*) FROM dosyalar WHERE ad LIKE 'buyuk/%')`,
  'CREATE TABLE IF NOT EXISTS girisler (ip TEXT NOT NULL, zaman TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS girisler_ip_zaman ON girisler (ip, zaman)',
  degisiklikTetikleyici('notlar', 'UPDATE', 'duzenle', 'NEW.id'),
  degisiklikTetikleyici('notlar', 'DELETE', 'sil', 'OLD.id'),
  degisiklikTetikleyici('fotograflar', 'UPDATE', 'duzenle', 'NEW.id'),
  degisiklikTetikleyici('fotograflar', 'DELETE', 'sil', 'OLD.id'),
  degisiklikTetikleyici('ayarlar', 'UPDATE', 'duzenle', 'NEW.id'),
  degisiklikTetikleyici('icerik', 'UPDATE', 'duzenle', 'NEW.id'),
  `CREATE TRIGGER IF NOT EXISTS notlar_sayac_ekle AFTER INSERT ON notlar BEGIN
     UPDATE sayac SET notlar = notlar + 1 WHERE id = 1; END`,
  `CREATE TRIGGER IF NOT EXISTS notlar_sayac_sil AFTER DELETE ON notlar BEGIN
     UPDATE sayac SET notlar = MAX(0, notlar - 1) WHERE id = 1; END`,
  `CREATE TRIGGER IF NOT EXISTS fotograflar_sayac_ekle AFTER INSERT ON fotograflar BEGIN
     UPDATE sayac SET fotograflar = fotograflar + 1 WHERE id = 1; END`,
  `CREATE TRIGGER IF NOT EXISTS fotograflar_sayac_sil AFTER DELETE ON fotograflar BEGIN
     UPDATE sayac SET fotograflar = MAX(0, fotograflar - 1) WHERE id = 1; END`,
  `CREATE TRIGGER IF NOT EXISTS dosyalar_sayac_ekle AFTER INSERT ON dosyalar BEGIN
     UPDATE sayac SET bayt = bayt + NEW.boyut, dosya = dosya + (NEW.ad LIKE 'buyuk/%') WHERE id = 1; END`,
  `CREATE TRIGGER IF NOT EXISTS dosyalar_sayac_sil AFTER DELETE ON dosyalar BEGIN
     UPDATE sayac SET bayt = MAX(0, bayt - OLD.boyut), dosya = MAX(0, dosya - (OLD.ad LIKE 'buyuk/%')) WHERE id = 1; END`,
  'CREATE TABLE IF NOT EXISTS sema_surumu (id INTEGER PRIMARY KEY CHECK (id = 1), surum INTEGER NOT NULL)',
  `INSERT OR REPLACE INTO sema_surumu (id, surum) VALUES (1, ${SEMA_SURUMU})`,
];

let semaHazir = false;
async function semaKur(env) {
  if (semaHazir) return;
  try {
    const r = await env.DB.prepare('SELECT surum FROM sema_surumu WHERE id = 1').first();
    if (r && r.surum >= SEMA_SURUMU) { semaHazir = true; return; }
  } catch { /* tablo henüz yok: aşağıda kurulur */ }
  await env.DB.batch(SEMA.map((s) => env.DB.prepare(s)));
  semaHazir = true;
}

// ---------------------------------------------------------------- hatalar

const MESAJLAR = {
  gecersiz: 'İstek geçersiz.',
  yetkisiz: 'Oturum geçersiz ya da süresi dolmuş, lütfen yeniden giriş yapın.',
  yok: 'Bulunamadı.',
  kapali: 'Paylaşım şu anda kapalı.',
  yogunluk: 'Şu anda çok yoğunuz, lütfen biraz sonra tekrar deneyin.',
  foto_yogunluk: 'Şu anda çok fazla fotoğraf gönderiliyor.',
  cok_buyuk: 'Dosya çok büyük.',
  alan_doldu: 'Fotoğraf alanı doldu, daha fazla fotoğraf yüklenemiyor.',
  tur: 'Bu dosya türü desteklenmiyor.',
  foto_dosyasi_yok: 'Fotoğraf dosyası sunucuda bulunamadı.',
  cok_deneme: 'Çok fazla hatalı deneme yapıldı. Lütfen 15 dakika sonra tekrar deneyin.',
  sunucu: 'Bir sorun oluştu, lütfen biraz sonra tekrar deneyin.',
};

class Hata extends Error {
  constructor(durum, kod, mesaj, sayi) {
    super(kod);
    this.durum = durum;
    this.kod = kod;
    this.mesaj = mesaj || MESAJLAR[kod];
    this.sayi = sayi;
  }
}
const gecersiz = (mesaj) => new Hata(400, 'gecersiz', mesaj);
const yok = () => new Hata(404, 'yok');
const kurulumEksik = () => new Hata(500, 'sunucu', 'Sunucu kurulumu tamamlanmamış.');
const kapali = (mesaj) => new Hata(403, 'kapali', mesaj);
const cokBuyuk = (bayt) => new Hata(413, 'cok_buyuk', `Dosya çok büyük (en çok ${Math.round(bayt / MB)} MB).`);

// ---------------------------------------------------------------- giriş noktası

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    const izinli = kokenIzinliMi(origin, env);
    let yanit;
    try {
      if (request.method === 'OPTIONS') {
        // Ön istek (preflight): izinsiz kökene CORS başlığı verilmez, tarayıcı engeller
        yanit = new Response(null, { status: 204 });
        if (izinli) {
          yanit.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS');
          yanit.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
          yanit.headers.set('Access-Control-Max-Age', '86400');
        }
      } else {
        yanit = await yonlendir(request, env, ctx);
      }
    } catch (e) {
      if (e instanceof Hata) {
        yanit = hataYaniti(e);
      } else {
        console.error('Beklenmeyen hata:', (e && e.stack) || e);
        yanit = hataYaniti(new Hata(500, 'sunucu'));
      }
    }
    return corsEkle(yanit, izinli ? origin : null);
  },
};

async function yonlendir(request, env, ctx) {
  const url = new URL(request.url);
  const yol = url.pathname.replace(/\/+$/, '') || '/';
  const y = request.method;

  if (yol === '/' && y === 'GET') {
    return json({ calisiyor: true, bilgi: 'Elif & Yunus düğün sunucusu. Durum için /durum adresine bakın.' });
  }
  if (!env.DB || !env.DEPO) throw kurulumEksik();
  await semaKur(env);

  if (yol === '/durum' && y === 'GET') return durum(env);
  if (yol === '/veri' && y === 'GET') return veriOku(request, env, url);
  if (yol === '/dilek' && y === 'POST') return dilekEkle(request, env);
  if (yol === '/dosya' && y === 'POST') return dosyaYukle(request, env, url);
  if (yol === '/foto' && y === 'POST') return fotoEkle(request, env);
  if (y === 'GET' || y === 'HEAD') {
    if (yol.startsWith('/d/')) return dosyaVer(request, env, 'foto/', yol.slice(3), FOTO_YOLU);
    if (yol.startsWith('/s/')) return dosyaVer(request, env, 'site/', yol.slice(3), SITE_YOLU);
  }
  if (yol.startsWith('/yonetim/')) return yonetim(request, env, ctx, url, yol.slice('/yonetim/'.length));
  throw yok();
}

async function yonetim(request, env, ctx, url, yol) {
  const y = request.method;
  if (yol === 'giris' && y === 'POST') return yoneticiGirisi(request, env, ctx);
  if (!yonetimHazir(env)) throw kurulumEksik();
  if (!(await yoneticiMi(request, env))) throw new Hata(401, 'yetkisiz');

  if (yol === 'ben' && y === 'GET') return json({ yonetici: true });
  if (yol === 'sil' && y === 'POST') return yonetimSil(request, env);
  const m = /^(notlar|fotograflar)\/(\d{1,15})$/.exec(yol);
  if (m && y === 'PATCH') return yonetimDuzenle(request, env, m[1], Number(m[2]));
  if (yol === 'ayarlar' && y === 'PUT') return yonetimAyarlar(request, env);
  if (yol === 'icerik' && y === 'PUT') return yonetimIcerik(request, env);
  if (yol === 'site' && y === 'POST') return siteYukle(request, env, url);
  if (yol === 'site-sil' && y === 'POST') return siteSil(request, env);
  if (yol === 'depo' && y === 'GET') return depoDurumu(env);
  if (yol === 'temizle' && y === 'POST') return depoTemizle(request, env);
  if (yol === 'tasi' && y === 'POST') return tasi(request, env);
  throw yok();
}

// ---------------------------------------------------------------- yanıt yardımcıları

function json(veri, durum = 200) {
  return new Response(JSON.stringify(veri), {
    status: durum,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function hataYaniti(h) {
  const govde = { hata: h.kod, mesaj: h.mesaj };
  if (h.sayi !== undefined && h.sayi !== null) govde.sayi = h.sayi;
  return json(govde, h.durum);
}

function kokenIzinliMi(origin, env) {
  if (!origin) return false;
  // Geliştirme için yerel kökenler her zaman kabul edilir
  if (/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/.test(origin)) return true;
  const liste = String(env.KOKENLER || 'https://koseeyunus.github.io')
    .split(',').map((s) => s.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean);
  return liste.includes(origin.toLowerCase());
}

// Herkese açık dosyalar (fotoğraf, kapak, müzik) kendi "*" izniyle gelir; ona dokunulmaz (önbellek dostu)
function corsEkle(yanit, origin) {
  if (yanit.headers.get('Access-Control-Allow-Origin') === '*') return yanit;
  const h = new Headers(yanit.headers);
  h.append('Vary', 'Origin');
  if (origin) h.set('Access-Control-Allow-Origin', origin);
  return new Response(yanit.body, { status: yanit.status, statusText: yanit.statusText, headers: h });
}

// ---------------------------------------------------------------- istek yardımcıları

const iso = (ms) => new Date(ms).toISOString();

function uuidOku(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return UUID.test(s) ? s : null;
}

function pozitifTam(v) {
  const n = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function sinirla(v, enAz, enCok, varsayilan) {
  const n = pozitifTam(v);
  return n === null ? varsayilan : Math.min(Math.max(n, enAz), enCok);
}

function zamanOku(v) {
  if (typeof v !== 'string' || !ISO_TARIH.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? iso(ms) : null;
}

// "1,2,3" → [1, 2, 3] (en çok "enCok" tane; geçersizler atlanır)
function idListesi(v, enCok) {
  const liste = String(v || '').split(',').map(pozitifTam).filter((n) => n !== null);
  return [...new Set(liste)].slice(0, enCok);
}

function icerikUzunlugu(request) {
  const v = request.headers.get('Content-Length');
  return v && /^\d{1,15}$/.test(v) ? Number(v) : null;
}

// İstek gövdesini en çok "enCok" bayta kadar okur (Content-Length'siz akışlarda da sınırlı)
async function govdeOku(request, enCok, buyukHata) {
  const uzunluk = icerikUzunlugu(request);
  if (uzunluk !== null && uzunluk > enCok) throw buyukHata();
  const parcalar = [];
  let toplam = 0;
  if (request.body) {
    const okuyucu = request.body.getReader();
    try {
      for (;;) {
        const { done, value } = await okuyucu.read();
        if (done) break;
        toplam += value.byteLength;
        if (toplam > enCok) {
          okuyucu.cancel().catch(() => {});
          throw buyukHata();
        }
        parcalar.push(value);
      }
    } catch (e) {
      if (e instanceof Hata) throw e;
      throw gecersiz('İstek gövdesi okunamadı.');
    }
  }
  const bayt = new Uint8Array(toplam);
  let konum = 0;
  for (const p of parcalar) {
    bayt.set(p, konum);
    konum += p.byteLength;
  }
  return bayt;
}

// JSON gövdesi (sayfa "text/plain" türüyle gönderir: CORS ön isteği gerekmesin)
async function jsonOku(request, enCok) {
  const bayt = await govdeOku(request, enCok, () => gecersiz('İstek çok büyük.'));
  try {
    const v = JSON.parse(new TextDecoder().decode(bayt));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch { /* aşağıda hata */ }
  throw gecersiz('İstek gövdesi geçersiz.');
}

function kesinKapanisDenetle() {
  if (Date.now() >= KESIN_KAPANIS) throw kapali('Paylaşım sona erdi.');
}

// ---------------------------------------------------------------- metin temizliği

function temizle(s) {
  if (typeof s !== 'string') return null;
  return s.normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(KONTROL, '')
    .replace(GORUNMEZ, '')
    .trim();
}

const harfSayisi = (s) => [...s].length;
const kes = (s, n) => [...s].slice(0, n).join('').trim();

// Tek satırlık metin (isim)
function tekSatir(s) {
  const t = temizle(s);
  return t === null ? null : t.replace(/\s+/g, ' ');
}

function isimDogrula(v) {
  const t = tekSatir(v);
  if (!t || harfSayisi(t) > 60) throw gecersiz('İsim 1–60 karakter olmalı.');
  return t;
}

function istegeBagliIsim(v) {
  if (v === undefined || v === null) return null;
  const t = tekSatir(String(v));
  return t ? kes(t, 60) || null : null;
}

function mesajDogrula(v) {
  let t = temizle(v);
  if (t === null) throw gecersiz('Dilek 1–1000 karakter olmalı.');
  t = t.split('\n').map((satir) => satir.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const n = harfSayisi(t);
  if (n < 1 || n > 1000) throw gecersiz('Dilek 1–1000 karakter olmalı.');
  return t;
}

function olcu(v) {
  return Number.isInteger(v) && v >= 1 && v <= 10000 ? v : null;
}

// ---------------------------------------------------------------- imza ve jetonlar (HMAC-SHA256)

const kodlayici = new TextEncoder();
let anahtarOnbellegi = null;

function yonetimHazir(env) {
  return typeof env.IMZA_ANAHTARI === 'string' && env.IMZA_ANAHTARI.length >= 16 &&
         typeof env.YONETICI_SIFRE === 'string' && env.YONETICI_SIFRE.length >= 12;
}

async function hmac(env, veri) {
  if (!anahtarOnbellegi || anahtarOnbellegi.metin !== env.IMZA_ANAHTARI) {
    const anahtar = await crypto.subtle.importKey('raw', kodlayici.encode(env.IMZA_ANAHTARI),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    anahtarOnbellegi = { metin: env.IMZA_ANAHTARI, anahtar };
  }
  return new Uint8Array(await crypto.subtle.sign('HMAC', anahtarOnbellegi.anahtar, kodlayici.encode(veri)));
}

// Sabit zamanlı karşılaştırma
function esit(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let fark = 0;
  for (let i = 0; i < a.length; i++) fark |= a[i] ^ b[i];
  return fark === 0;
}

function b64url(bayt) {
  let s = '';
  for (const x of bayt) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlCoz(s) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(s)) return null;
  try {
    let t = s.replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    return Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

// Jeton biçimi: y.<bitiş unix sn>.<imza>. Şifre değişirse eski jetonlar da geçersiz olur (imzaya şifre de girer).
async function jetonUret(env) {
  const bitis = Math.floor(Date.now() / 1000) + JETON_OMRU;
  const imza = b64url(await hmac(env, `y.${bitis}.${env.YONETICI_SIFRE}`));
  return { jeton: `y.${bitis}.${imza}`, bitis: iso(bitis * 1000) };
}

async function jetonGecerliMi(env, jeton) {
  if (!yonetimHazir(env) || typeof jeton !== 'string' || jeton.length > 200) return false;
  const p = jeton.split('.');
  if (p.length !== 3 || p[0] !== 'y' || !/^\d{1,12}$/.test(p[1])) return false;
  if (Number(p[1]) * 1000 <= Date.now()) return false;
  const verilen = b64urlCoz(p[2]);
  if (!verilen) return false;
  return esit(verilen, await hmac(env, `y.${p[1]}.${env.YONETICI_SIFRE}`));
}

async function yoneticiMi(request, env) {
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') || '');
  return m ? jetonGecerliMi(env, m[1]) : false;
}

// ---------------------------------------------------------------- ayarlar

function ayarBicimle(r) {
  if (!r) throw kurulumEksik();
  const a = {};
  for (const alan of AYAR_ALANLARI) {
    const v = r[alan];
    a[alan] = AYAR_KURALI[alan] === 'bayrak' ? !!v : (v === undefined ? null : v);
  }
  return a;
}

async function ayarOku(env) {
  return ayarBicimle(await env.DB.prepare('SELECT * FROM ayarlar WHERE id = 1').first());
}

// Paylaşım ('foto' | 'dilek') şu an açık mı? (Supabase'teki paylasim_acik() ile aynı kural)
function acikMi(ayar, tur, simdi) {
  const bas = ayar[`${tur}_baslangic`];
  const bit = ayar[`${tur}_bitis`];
  return ayar[`${tur}_acik`] && simdi < KESIN_KAPANIS &&
    (!bas || Date.parse(bas) <= simdi) && (!bit || Date.parse(bit) > simdi);
}

function alanBayt(env) {
  const gb = parseFloat(env.ALAN_GB);
  // GB = 10^9 bayt kabul edilir (R2'nin 10 GB ücretsiz alanının altında kalmak için temkinli)
  return Math.floor((Number.isFinite(gb) && gb > 0 ? gb : 9.5) * 1e9);
}

// ---------------------------------------------------------------- okuma: GET /veri

// Dilekler bağlı fotoğraflarıyla, fotoğraflar bağlı oldukları dileğin yazısıyla birlikte gelir (Supabase'teki
// "notlar(… fotograflar(…))" ve "fotograflar(… notlar(mesaj))" sorgularının karşılığı).
const NOT_ALANLARI = `x.id, x.created_at, x.isim, x.mesaj,
  (SELECT json_group_array(json_object('id', f.id, 'created_at', f.created_at, 'isim', f.isim, 'buyuk', f.buyuk,
     'kucuk', f.kucuk, 'genislik', f.genislik, 'yukseklik', f.yukseklik, 'not_id', f.not_id))
   FROM (SELECT * FROM fotograflar WHERE not_id = x.id ORDER BY id) f) AS _fotolar`;
const FOTO_ALANLARI = 'x.id, x.created_at, x.isim, x.buyuk, x.kucuk, x.genislik, x.yukseklik, x.not_id, n.mesaj AS _mesaj';
const KAYNAK = {
  notlar: { alanlar: NOT_ALANLARI, kaynak: 'notlar x' },
  fotograflar: { alanlar: FOTO_ALANLARI, kaynak: 'fotograflar x LEFT JOIN notlar n ON n.id = x.not_id' },
};

function satirBicimle(tablo, r, gorunur) {
  if (tablo === 'notlar') {
    let fotograflar = [];
    if (gorunur.fotograflar) {
      try { fotograflar = JSON.parse(r._fotolar || '[]'); } catch { fotograflar = []; }
    }
    return { id: r.id, created_at: r.created_at, isim: r.isim, mesaj: r.mesaj, fotograflar };
  }
  return {
    id: r.id, created_at: r.created_at, isim: r.isim, buyuk: r.buyuk, kucuk: r.kucuk,
    genislik: r.genislik, yukseklik: r.yukseklik, not_id: r.not_id,
    notlar: gorunur.notlar && r.not_id !== null && r._mesaj !== null ? { mesaj: r._mesaj } : null,
  };
}

// tur: sayfa (yeniden eskiye), sonra (verilen andan sonra eklenenler), idler, artan (yönetici: tümünü sayfa sayfa)
function tabloSorgusu(env, tablo, tur, q, yonetici) {
  const { alanlar, kaynak } = KAYNAK[tablo];
  const p = (ad) => q.get(`${tablo}_${ad}`);
  if (tur === 'sayfa') {
    return env.DB.prepare(`SELECT ${alanlar} FROM ${kaynak} WHERE (?1 IS NULL OR x.id < ?1) ORDER BY x.id DESC LIMIT ?2`)
      .bind(pozitifTam(p('once')), sinirla(p('adet'), 1, SAYFA_EN_COK, 24));
  }
  if (tur === 'sonra') {
    return env.DB.prepare(`SELECT ${alanlar} FROM ${kaynak} WHERE (?1 IS NULL OR x.created_at >= ?1) ORDER BY x.id ASC LIMIT ?2`)
      .bind(zamanOku(p('zaman')), SONRA_EN_COK);
  }
  if (tur === 'idler') {
    return env.DB.prepare(`SELECT ${alanlar} FROM ${kaynak} WHERE x.id IN (SELECT value FROM json_each(?1)) ORDER BY x.id`)
      .bind(JSON.stringify(idListesi(p('idler'), SONRA_EN_COK)));
  }
  if (tur === 'artan') {
    if (!yonetici) throw new Hata(401, 'yetkisiz');
    return env.DB.prepare(`SELECT ${alanlar} FROM ${kaynak} WHERE x.id > ?1 ORDER BY x.id ASC LIMIT ?2`)
      .bind(pozitifTam(p('sonra_id')) || 0, sinirla(p('adet'), 1, SAYFA_EN_COK, SAYFA_EN_COK));
  }
  throw gecersiz(`"${tablo}" okuması geçersiz.`);
}

// Sayfanın aynı anda istediği her şey tek istekte: ?notlar=sayfa&fotograflar=sonra&ayarlar=1&icerik=1 …
// Yönetici jetonu (Authorization) gönderilirse gizlenen bölümler de gelir.
async function veriOku(request, env, url) {
  const q = url.searchParams;
  let yonetici = false;
  if (request.headers.has('Authorization')) {
    yonetici = await yoneticiMi(request, env);
    if (!yonetici) throw new Hata(401, 'yetkisiz');
  }
  // İlk ifade her zaman ayarlar: hangi bölümlerin misafire gösterileceği buna bağlı
  const isler = [{ anahtar: '_ayar', ifade: env.DB.prepare('SELECT * FROM ayarlar WHERE id = 1') }];
  for (const tablo of TABLOLAR) {
    const tur = q.get(tablo);
    if (tur) isler.push({ anahtar: tablo, tablo, ifade: tabloSorgusu(env, tablo, tur, q, yonetici) });
  }
  if (q.get('notlar_say') || q.get('fotograflar_say')) {
    isler.push({ anahtar: '_say', ifade: env.DB.prepare('SELECT notlar, fotograflar FROM sayac WHERE id = 1') });
  }
  const dt = q.get('degisiklik');
  if (dt === 'son') {
    isler.push({ anahtar: 'degisiklik', ifade: env.DB.prepare(
      'SELECT id, tablo, kayit_id, islem FROM degisiklikler ORDER BY id DESC LIMIT ?1').bind(SON_DEGISIKLIK) });
  } else if (dt === 'sonra') {
    isler.push({ anahtar: 'degisiklik', ifade: env.DB.prepare(
      'SELECT id, tablo, kayit_id, islem FROM degisiklikler WHERE id > ?1 ORDER BY id ASC LIMIT ?2')
      .bind(Number(q.get('degisiklik_id')) >= 0 ? Math.floor(Number(q.get('degisiklik_id'))) : 0, SONRA_EN_COK) });
  } else if (dt) {
    throw gecersiz('"degisiklik" okuması geçersiz.');
  }
  if (q.get('icerik')) isler.push({ anahtar: 'icerik', ifade: env.DB.prepare('SELECT veri FROM icerik WHERE id = 1') });

  const sonuclar = await env.DB.batch(isler.map((i) => i.ifade));
  const ayar = ayarBicimle(sonuclar[0].results[0]);
  const gorunur = { notlar: yonetici || ayar.dilekler_gorunur, fotograflar: yonetici || ayar.album_gorunur };
  const yanit = { simdi: iso(Date.now()) };
  if (q.get('ayarlar')) yanit.ayarlar = ayar;
  isler.forEach((is, k) => {
    const satirlar = sonuclar[k].results;
    if (is.tablo) {
      // Gizlenen bölüm (Anı Albümü / Dilek Defteri) misafire sunucudan da verilmez
      yanit[is.anahtar] = gorunur[is.tablo] ? satirlar.map((r) => satirBicimle(is.tablo, r, gorunur)) : [];
    } else if (is.anahtar === '_say') {
      const s = satirlar[0] || { notlar: 0, fotograflar: 0 };
      for (const tablo of TABLOLAR) if (q.get(`${tablo}_say`)) yanit[`${tablo}_say`] = gorunur[tablo] ? s[tablo] : 0;
    } else if (is.anahtar === 'degisiklik') {
      yanit.degisiklik = satirlar;
    } else if (is.anahtar === 'icerik') {
      let veri = {};
      try { veri = JSON.parse(satirlar[0]?.veri || '{}'); } catch { veri = {}; }
      yanit.icerik = veri;
    }
  });
  return json(yanit);
}

async function durum(env) {
  const s = await env.DB.prepare('SELECT notlar, fotograflar FROM sayac WHERE id = 1').first();
  return json({
    calisiyor: true,
    veritabani: !!s,
    depo: !!env.DEPO,
    yonetim: yonetimHazir(env) ? 'hazır' : 'eksik: YONETICI_SIFRE ve IMZA_ANAHTARI girilmeli',
    simdi: iso(Date.now()),
  });
}

// ---------------------------------------------------------------- misafir: dilek

async function dilekEkle(request, env) {
  const g = await jsonOku(request, 16 * 1024);
  const simdi = Date.now();
  const ayar = await ayarOku(env);
  if (!acikMi(ayar, 'dilek', simdi)) throw kapali('Dilek yazma şu anda kapalı.');
  const isim = isimDogrula(g.isim);
  const mesaj = mesajDogrula(g.mesaj);
  // Bağ anahtarı: dileği yazan telefonun ürettiği gizli sayı; fotoğraf dileğe yalnızca bununla bağlanır
  const bag = uuidOku(g.bag);
  const cihaz = uuidOku(g.cihaz);
  const sinir = ayar.dilek_siniri;

  // Sınır ve yoğunluk denetimi ekleme ile aynı ifadede: aynı anda gelen isteklerde de aşılmaz
  const r = await env.DB.prepare(
    `INSERT INTO notlar (created_at, isim, mesaj, bag_anahtari, cihaz_anahtari)
     SELECT ?1, ?2, ?3, ?4, ?5
     WHERE NOT EXISTS (SELECT 1 FROM notlar WHERE bag_anahtari = ?4)
       AND (?6 IS NULL OR ?5 IS NULL OR (SELECT COUNT(*) FROM notlar WHERE cihaz_anahtari = ?5) < ?6)
       AND (SELECT COUNT(*) FROM notlar WHERE created_at > ?7) < ?8
     RETURNING id`,
  ).bind(iso(simdi), isim, mesaj, bag, cihaz, sinir, iso(simdi - DAKIKA), DILEK_YOGUNLUK).first();

  if (!r) {
    // Önceki deneme aslında kaydetmiş (yeniden deneme): başarı sayılır
    if (bag && (await env.DB.prepare('SELECT 1 AS v FROM notlar WHERE bag_anahtari = ?1').bind(bag).first())) {
      return json({ kaydedildi: true });
    }
    if (sinir !== null && cihaz) {
      const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM notlar WHERE cihaz_anahtari = ?1').bind(cihaz).first();
      if (c.n >= sinir) throw new Hata(429, 'dilek_siniri', `Bu telefondan en çok ${sinir} dilek gönderilebilir.`, sinir);
    }
    throw new Hata(429, 'yogunluk', 'Şu anda çok fazla dilek gönderiliyor.');
  }
  return json({ kaydedildi: true }, 201);
}

// ---------------------------------------------------------------- misafir: fotoğraf

// JPEG dosyaları FF D8 FF ile başlar (sayfa her fotoğrafı JPEG'e çevirip gönderir)
const jpegMi = (b) => b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;

const fotoSiniri = (sinir) => new Hata(429, 'foto_siniri', `Bu telefondan en çok ${sinir} fotoğraf gönderilebilir.`, sinir);

// POST /dosya?ad=buyuk/<uuid>.jpg&cihaz=<uuid> — gövde: JPEG (sayfa "text/plain" türüyle gönderir: ön istek olmasın)
async function dosyaYukle(request, env, url) {
  kesinKapanisDenetle();
  const ad = url.searchParams.get('ad') || '';
  const m = FOTO_YOLU.exec(ad);
  if (!m) throw gecersiz('Dosya adı geçersiz.');
  const cihaz = uuidOku(url.searchParams.get('cihaz'));
  const enCok = m[1] === 'buyuk' ? FOTO_EN_COK : KUCUK_EN_COK;
  const uzunluk = icerikUzunlugu(request);
  if (uzunluk !== null && uzunluk > enCok) throw cokBuyuk(enCok);

  const simdi = Date.now();
  const [a, mevcut, son, s, benim] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM ayarlar WHERE id = 1'),
    env.DB.prepare('SELECT 1 AS v FROM dosyalar WHERE ad = ?1').bind(ad),
    env.DB.prepare('SELECT COUNT(*) AS n FROM dosyalar WHERE created_at > ?1').bind(iso(simdi - DAKIKA)),
    env.DB.prepare('SELECT bayt FROM sayac WHERE id = 1'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM fotograflar WHERE cihaz_anahtari = ?1').bind(cihaz),
  ]);
  // Önceki deneme yüklemiş: başarı sayılır, üzerine yazılmaz
  if (mevcut.results.length) return json({ zaten: true });
  const ayar = ayarBicimle(a.results[0]);
  if (!acikMi(ayar, 'foto', simdi)) throw kapali('Fotoğraf paylaşımı şu anda kapalı.');
  if (son.results[0].n >= DOSYA_YOGUNLUK) throw new Hata(429, 'foto_yogunluk');
  // Telefonun fotoğraf hakkı dolduysa dosya hiç alınmaz (kesin denetim kayıtta)
  if (cihaz && ayar.foto_siniri !== null && benim.results[0].n >= ayar.foto_siniri) throw fotoSiniri(ayar.foto_siniri);

  const govde = await govdeOku(request, enCok, () => cokBuyuk(enCok));
  if (!jpegMi(govde)) throw new Hata(415, 'tur', 'Yalnızca JPEG fotoğraf yüklenebilir.');
  if ((s.results[0]?.bayt || 0) + govde.byteLength > alanBayt(env)) throw new Hata(507, 'alan_doldu');

  await env.DEPO.put(`foto/${ad}`, govde, {
    httpMetadata: { contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable' },
  });
  await env.DB.prepare('INSERT OR IGNORE INTO dosyalar (ad, boyut, created_at, cihaz_anahtari) VALUES (?1, ?2, ?3, ?4)')
    .bind(ad, govde.byteLength, iso(simdi), cihaz).run();
  return json({ yuklendi: true }, 201);
}

// POST /foto {id, isim, genislik, yukseklik, bag, cihaz} — iki dosya da yüklendikten sonra albüme kaydeder
async function fotoEkle(request, env) {
  const g = await jsonOku(request, 16 * 1024);
  const id = uuidOku(g.id);
  if (!id) throw gecersiz('Fotoğraf kimliği geçersiz.');
  const buyuk = `buyuk/${id}.jpg`;
  const kucuk = `kucuk/${id}.jpg`;
  const cihaz = uuidOku(g.cihaz);
  const bag = uuidOku(g.bag);
  const isim = istegeBagliIsim(g.isim);
  const simdi = Date.now();
  const ayar = await ayarOku(env);
  if (!acikMi(ayar, 'foto', simdi)) throw kapali('Fotoğraf paylaşımı şu anda kapalı.');
  const sinir = ayar.foto_siniri;

  // Dileğe bağ: yalnızca bağ anahtarı tutan ve son 3 saatte yazılmış dilek (anahtar hiçbir zaman okutulmaz)
  const r = await env.DB.prepare(
    `INSERT INTO fotograflar (created_at, isim, buyuk, kucuk, genislik, yukseklik, not_id, cihaz_anahtari)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6,
       (SELECT id FROM notlar WHERE ?7 IS NOT NULL AND bag_anahtari = ?7 AND created_at > ?8),
       ?9
     WHERE NOT EXISTS (SELECT 1 FROM fotograflar WHERE buyuk = ?3)
       AND (SELECT COUNT(*) FROM dosyalar WHERE ad IN (?3, ?4)) = 2
       AND (?10 IS NULL OR ?9 IS NULL OR (SELECT COUNT(*) FROM fotograflar WHERE cihaz_anahtari = ?9) < ?10)
       AND (SELECT COUNT(*) FROM fotograflar WHERE created_at > ?11) < ?12
     RETURNING id`,
  ).bind(iso(simdi), isim, buyuk, kucuk, olcu(g.genislik), olcu(g.yukseklik), bag, iso(simdi - BAG_SURESI),
    cihaz, sinir, iso(simdi - DAKIKA), FOTO_YOGUNLUK).first();

  if (!r) {
    const [ayni, dosya, benim] = await env.DB.batch([
      env.DB.prepare('SELECT id FROM fotograflar WHERE buyuk = ?1').bind(buyuk),
      env.DB.prepare('SELECT COUNT(*) AS n FROM dosyalar WHERE ad IN (?1, ?2)').bind(buyuk, kucuk),
      env.DB.prepare('SELECT COUNT(*) AS n FROM fotograflar WHERE cihaz_anahtari = ?1').bind(cihaz),
    ]);
    if (ayni.results.length) return json({ id: ayni.results[0].id });   // önceki deneme kaydetmiş
    if (dosya.results[0].n < 2) throw new Hata(400, 'foto_dosyasi_yok');
    if (cihaz && sinir !== null && benim.results[0].n >= sinir) throw fotoSiniri(sinir);
    throw new Hata(429, 'foto_yogunluk');
  }
  return json({ id: r.id }, 201);
}

// ---------------------------------------------------------------- dosya okuma: /d/… (fotoğraflar) ve /s/… (site)

// "Range: bytes=…" başlığı: tek aralık desteklenir; geçersizse yok sayılır, karşılanamazsa 'karsilanamaz'
function aralikCoz(baslik, boyut) {
  const m = /^bytes=(\d{0,15})-(\d{0,15})$/.exec((baslik || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const n = Math.min(Number(m[2]), boyut);
    return n === 0 ? 'karsilanamaz' : { offset: boyut - n, length: n };
  }
  const bas = Number(m[1]);
  const son = m[2] === '' ? boyut - 1 : Math.min(Number(m[2]), boyut - 1);
  if (bas >= boyut) return 'karsilanamaz';
  if (son < bas) return null;
  return { offset: bas, length: son - bas + 1 };
}

// Dosya adları benzersiz (rastgele kimlik) ve değişmez: tarayıcı bir yıl önbellekte tutar, tekrar istemez
async function dosyaVer(request, env, onek, ad, desen) {
  if (!desen.test(ad)) throw yok();
  const anahtar = onek + ad;
  const turu = ad.endsWith('.jpg') ? 'image/jpeg' : SITE_TURU[ad.split('.').pop()];
  const h = new Headers({
    'Content-Type': turu,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Access-Control-Allow-Origin': '*',
  });
  const aralikBasligi = request.headers.get('Range');
  if (request.method === 'HEAD' || aralikBasligi) {
    const bas = await env.DEPO.head(anahtar);
    if (!bas) throw yok();
    h.set('ETag', bas.httpEtag);
    if (request.method === 'HEAD') {
      h.set('Content-Length', String(bas.size));
      return new Response(null, { status: 200, headers: h });
    }
    const aralik = aralikCoz(aralikBasligi, bas.size);
    if (aralik === 'karsilanamaz') {
      h.set('Content-Range', `bytes */${bas.size}`);
      return new Response(null, { status: 416, headers: h });
    }
    if (aralik) {
      const parca = await env.DEPO.get(anahtar, { range: aralik });
      if (!parca) throw yok();
      h.set('Content-Range', `bytes ${aralik.offset}-${aralik.offset + aralik.length - 1}/${bas.size}`);
      return new Response(parca.body, { status: 206, headers: h });
    }
  }
  const nesne = await env.DEPO.get(anahtar, { onlyIf: request.headers });
  if (!nesne) throw yok();
  h.set('ETag', nesne.httpEtag);
  if (!('body' in nesne) || !nesne.body) return new Response(null, { status: 304, headers: h });
  return new Response(nesne.body, { status: 200, headers: h });
}

// ---------------------------------------------------------------- yönetici

async function yoneticiGirisi(request, env, ctx) {
  if (!yonetimHazir(env)) throw kurulumEksik();
  const ip = request.headers.get('CF-Connecting-IP') || 'bilinmiyor';
  const simdi = Date.now();
  const d = await env.DB.prepare('SELECT COUNT(*) AS n FROM girisler WHERE ip = ?1 AND zaman > ?2')
    .bind(ip, iso(simdi - 15 * DAKIKA)).first();
  if (d.n >= GIRIS_DENEME) throw new Hata(429, 'cok_deneme');

  const g = await jsonOku(request, 4 * 1024);
  const sifre = typeof g.sifre === 'string' ? g.sifre.slice(0, 500) : '';
  // Sabit zamanlı: iki tarafın HMAC'ı karşılaştırılır
  const dogru = esit(await hmac(env, `sifre:${sifre}`), await hmac(env, `sifre:${env.YONETICI_SIFRE}`));
  if (!dogru) {
    await env.DB.prepare('INSERT INTO girisler (ip, zaman) VALUES (?1, ?2)').bind(ip, iso(simdi)).run();
    ctx.waitUntil(env.DB.prepare('DELETE FROM girisler WHERE zaman < ?1').bind(iso(simdi - GUN)).run().catch(() => {}));
    throw new Hata(401, 'yetkisiz', 'Şifre hatalı.');
  }
  return json(await jetonUret(env));
}

// Bir tablodaki kayıtları sayfanın beklediği biçimde (bağlı kayıtlarla) okur
async function kayitlariOku(env, tablo, idler) {
  if (!idler.length) return [];
  const { alanlar, kaynak } = KAYNAK[tablo];
  const { results } = await env.DB.prepare(
    `SELECT ${alanlar} FROM ${kaynak} WHERE x.id IN (SELECT value FROM json_each(?1)) ORDER BY x.id`,
  ).bind(JSON.stringify(idler)).all();
  return results.map((r) => satirBicimle(tablo, r, { notlar: true, fotograflar: true }));
}

// POST /yonetim/sil {tablo, idler} → silinen kimlikler. Fotoğraflarda önce dosyalar silinir (yarıda kalırsa
// tekrar denemek güvenli). Dilek silinince bağlı fotoğraflar albümde kalır, yalnızca bağları kopar.
async function yonetimSil(request, env) {
  const g = await jsonOku(request, 256 * 1024);
  if (!TABLOLAR.includes(g.tablo) || !Array.isArray(g.idler) || g.idler.length > 5000) throw gecersiz('Silme isteği geçersiz.');
  const idler = [...new Set(g.idler.map(pozitifTam).filter((n) => n !== null))];
  if (!idler.length) return json({ silinen: [] });
  const liste = JSON.stringify(idler);

  if (g.tablo === 'fotograflar') {
    const { results } = await env.DB.prepare(
      'SELECT buyuk, kucuk FROM fotograflar WHERE id IN (SELECT value FROM json_each(?1))').bind(liste).all();
    const adlar = results.flatMap((r) => [r.buyuk, r.kucuk]);
    for (let i = 0; i < adlar.length; i += 1000) await env.DEPO.delete(adlar.slice(i, i + 1000).map((a) => `foto/${a}`));
    const [, sil] = await env.DB.batch([
      env.DB.prepare('DELETE FROM dosyalar WHERE ad IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(adlar)),
      env.DB.prepare('DELETE FROM fotograflar WHERE id IN (SELECT value FROM json_each(?1)) RETURNING id').bind(liste),
    ]);
    return json({ silinen: sil.results.map((r) => r.id) });
  }
  const [, sil] = await env.DB.batch([
    // Bağı açıkça koparır (düzenleme kaydı da düşer: açık sayfalar fotoğrafı yeniler)
    env.DB.prepare('UPDATE fotograflar SET not_id = NULL WHERE not_id IN (SELECT value FROM json_each(?1))').bind(liste),
    env.DB.prepare('DELETE FROM notlar WHERE id IN (SELECT value FROM json_each(?1)) RETURNING id').bind(liste),
  ]);
  return json({ silinen: sil.results.map((r) => r.id) });
}

// PATCH /yonetim/notlar/<id> {isim?, mesaj?} ya da /yonetim/fotograflar/<id> {isim}
async function yonetimDuzenle(request, env, tablo, id) {
  const g = await jsonOku(request, 16 * 1024);
  let r;
  if (tablo === 'notlar') {
    const isim = g.isim === undefined ? null : isimDogrula(g.isim);
    const mesaj = g.mesaj === undefined ? null : mesajDogrula(g.mesaj);
    if (isim === null && mesaj === null) throw gecersiz('Değiştirilecek alan yok.');
    r = await env.DB.prepare('UPDATE notlar SET isim = COALESCE(?1, isim), mesaj = COALESCE(?2, mesaj) WHERE id = ?3')
      .bind(isim, mesaj, id).run();
  } else {
    if (!('isim' in g)) throw gecersiz('Değiştirilecek alan yok.');
    r = await env.DB.prepare('UPDATE fotograflar SET isim = ?1 WHERE id = ?2').bind(istegeBagliIsim(g.isim), id).run();
  }
  if (r.meta.changes === 0) throw yok();
  const [satir] = await kayitlariOku(env, tablo, [id]);
  return json({ kayit: satir });
}

function ayarDegeriDogrula(alan, v) {
  const kural = AYAR_KURALI[alan];
  const hata = () => gecersiz(`"${alan}" ayarı geçersiz.`);
  if (kural === 'bayrak') {
    if (v === true || v === 1) return 1;
    if (v === false || v === 0) return 0;
    throw hata();
  }
  if (kural === 'tarih') {
    if (v === null || v === '') return null;
    const t = zamanOku(v);
    if (!t) throw hata();
    return t;
  }
  const [enAz, enCok, bosOlabilir] = kural;
  if ((v === null || v === '') && bosOlabilir) return null;
  if (!Number.isInteger(v) || v < enAz || v > enCok) {
    throw gecersiz(`"${alan}" ayarı ${enAz}–${enCok} arasında bir tam sayı olmalı.`);
  }
  return v;
}

// Ayarları doğrulayıp yazar (yönetim ve taşıma ortak kullanır)
async function ayarlariYaz(env, g) {
  const mevcut = await ayarOku(env);
  const degisen = {};
  for (const alan of AYAR_ALANLARI) {
    if (Object.prototype.hasOwnProperty.call(g, alan)) degisen[alan] = ayarDegeriDogrula(alan, g[alan]);
  }
  const yeni = { ...mevcut, ...degisen };
  for (const tur of ['foto', 'dilek']) {
    const bas = yeni[`${tur}_baslangic`];
    const bit = yeni[`${tur}_bitis`];
    if (bas && bit && Date.parse(bas) >= Date.parse(bit)) throw gecersiz('Kapanış zamanı açılıştan sonra olmalı.');
  }
  const alanlar = Object.keys(degisen);
  if (alanlar.length) {
    // Sütun adları yalnızca sabit listeden gelir; değerler bağ parametresiyle
    const atamalar = alanlar.map((a, i) => `${a} = ?${i + 1}`).join(', ');
    await env.DB.prepare(`UPDATE ayarlar SET ${atamalar} WHERE id = 1`).bind(...alanlar.map((a) => degisen[a])).run();
  }
  return ayarOku(env);
}

async function yonetimAyarlar(request, env) {
  return json({ ayarlar: await ayarlariYaz(env, await jsonOku(request, 16 * 1024)) });
}

function icerikDogrula(veri) {
  if (!veri || typeof veri !== 'object' || Array.isArray(veri)) throw gecersiz('Metinler bir nesne olmalı.');
  const metin = JSON.stringify(veri);
  if (kodlayici.encode(metin).length >= ICERIK_EN_COK) throw gecersiz('Metinler çok uzun.');
  return metin;
}

async function yonetimIcerik(request, env) {
  const g = await jsonOku(request, ICERIK_EN_COK + 1024);
  const metin = icerikDogrula(g.veri);
  await env.DB.prepare('UPDATE icerik SET veri = ?1 WHERE id = 1').bind(metin).run();
  return json({ veri: JSON.parse(metin) });
}

// POST /yonetim/site?ad=kapak/<uuid>.jpg — gövde: dosya (Content-Length gerekli; belleğe alınmadan R2'ye akar)
async function siteYukle(request, env, url) {
  const ad = url.searchParams.get('ad') || '';
  if (!SITE_YOLU.test(ad)) throw gecersiz('Dosya adı geçersiz.');
  const uzunluk = icerikUzunlugu(request);
  if (!uzunluk || !request.body) throw gecersiz('Dosya boyutu eksik.');
  if (uzunluk > SITE_EN_COK) throw cokBuyuk(SITE_EN_COK);
  const anahtar = `site/${ad}`;
  if (await env.DEPO.head(anahtar)) return json({ zaten: true });   // adlar benzersiz: üzerine yazılmaz
  await env.DEPO.put(anahtar, request.body, {
    httpMetadata: { contentType: SITE_TURU[ad.split('.').pop()], cacheControl: 'public, max-age=31536000, immutable' },
  });
  return json({ yuklendi: true }, 201);
}

async function siteSil(request, env) {
  const g = await jsonOku(request, 64 * 1024);
  if (!Array.isArray(g.adlar) || g.adlar.length > 100) throw gecersiz('Silme isteği geçersiz.');
  const adlar = g.adlar.filter((a) => typeof a === 'string' && SITE_YOLU.test(a));
  if (adlar.length) await env.DEPO.delete(adlar.map((a) => `site/${a}`));
  return json({ silinen: adlar.length });
}

// Albümde hiçbir kaydın kullanmadığı fotoğraf dosyaları (yarım kalan yüklemeler). Yeni yüklemelere dokunmamak
// için son 1 saatteki dosyalar sayılmaz.
const YETIM_SQL = `FROM dosyalar d WHERE d.created_at < ?1
  AND NOT EXISTS (SELECT 1 FROM fotograflar f WHERE f.buyuk = d.ad)
  AND NOT EXISTS (SELECT 1 FROM fotograflar f WHERE f.kucuk = d.ad)`;

// GET /yonetim/depo → kullanılan alan, fotoğraf sayısı, alan sınırı, yetim dosyalar. Sayaçlar burada gerçek
// toplamlarla yeniden eşitlenir (kendi kendini onarır).
async function depoDurumu(env) {
  const [, s, y] = await env.DB.batch([
    env.DB.prepare(`UPDATE sayac SET notlar = (SELECT COUNT(*) FROM notlar), fotograflar = (SELECT COUNT(*) FROM fotograflar),
      bayt = (SELECT COALESCE(SUM(boyut), 0) FROM dosyalar), dosya = (SELECT COUNT(*) FROM dosyalar WHERE ad LIKE 'buyuk/%')
      WHERE id = 1`),
    env.DB.prepare('SELECT bayt, dosya FROM sayac WHERE id = 1'),
    env.DB.prepare(`SELECT d.ad, d.boyut ${YETIM_SQL} ORDER BY d.created_at LIMIT 5000`).bind(iso(Date.now() - SAAT)),
  ]);
  const t = s.results[0] || { bayt: 0, dosya: 0 };
  return json({ bayt: t.bayt, dosya: t.dosya, alan_bayt: alanBayt(env), yetimler: y.results });
}

// POST /yonetim/temizle {adlar} — yalnızca hâlâ yetim olan dosyalar silinir
async function depoTemizle(request, env) {
  const g = await jsonOku(request, 512 * 1024);
  if (!Array.isArray(g.adlar) || g.adlar.length > 5000) throw gecersiz('Temizlik isteği geçersiz.');
  const adlar = [...new Set(g.adlar.filter((a) => typeof a === 'string' && FOTO_YOLU.test(a)))];
  if (!adlar.length) return json({ silinen: 0 });
  const { results } = await env.DB.prepare(`SELECT d.ad ${YETIM_SQL} AND d.ad IN (SELECT value FROM json_each(?2))`)
    .bind(iso(Date.now() - SAAT), JSON.stringify(adlar)).all();
  const silinecek = results.map((r) => r.ad);
  for (let i = 0; i < silinecek.length; i += 1000) await env.DEPO.delete(silinecek.slice(i, i + 1000).map((a) => `foto/${a}`));
  if (silinecek.length) {
    await env.DB.prepare('DELETE FROM dosyalar WHERE ad IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(silinecek)).run();
  }
  return json({ silinen: silinecek.length });
}

// POST /yonetim/tasi {notlar: [{id, created_at, isim, mesaj}], ayarlar?, icerik?} — Supabase'ten aktarım.
// Tekrar çalıştırmak güvenlidir: aynı numaralı dilek ikinci kez eklenmez. Dilekler Supabase'teki numaralarıyla
// eklenir; yeni dilekler en büyük numaranın 100 fazlasından başlar (geç gelen eski dileklere yer kalsın).
async function tasi(request, env) {
  const g = await jsonOku(request, 4 * MB);
  const notlar = Array.isArray(g.notlar) ? g.notlar : [];
  if (notlar.length > 20000) throw gecersiz('Çok fazla dilek.');
  const ifadeler = [];
  let gecersizSayisi = 0;
  let enBuyuk = 0;
  for (const n of notlar) {
    const id = pozitifTam(n && n.id);
    const zaman = n && typeof n.created_at === 'string' && Number.isFinite(Date.parse(n.created_at)) ? iso(Date.parse(n.created_at)) : null;
    let isim = null;
    let mesaj = null;
    try { isim = isimDogrula(n.isim); mesaj = mesajDogrula(n.mesaj); } catch { /* aşağıda sayılır */ }
    if (!id || !zaman || !isim || !mesaj) { gecersizSayisi++; continue; }
    enBuyuk = Math.max(enBuyuk, id);
    ifadeler.push(env.DB.prepare(
      'INSERT OR IGNORE INTO notlar (id, created_at, isim, mesaj, cihaz_anahtari) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id',
    ).bind(id, zaman, isim, mesaj, uuidOku(n.cihaz_anahtari)));
  }
  // Eklenenler dönen kayıtlardan sayılır (D1'in değişiklik sayısına tetikleyicilerin yazdıkları da girer)
  let eklenen = 0;
  for (let i = 0; i < ifadeler.length; i += 200) {
    const sonuclar = await env.DB.batch(ifadeler.slice(i, i + 200));
    for (const s of sonuclar) eklenen += s.results.length;
  }
  // Yeni dileklerin numarası Supabase'tekilerle çakışmasın
  if (enBuyuk) {
    const hedef = enBuyuk + 100;
    const s = await env.DB.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'notlar'").first().catch(() => null);
    if (!s || s.seq < hedef) {
      try {
        await env.DB.prepare("UPDATE sqlite_sequence SET seq = ?1 WHERE name = 'notlar' AND seq < ?1").bind(hedef).run();
      } catch {
        // sqlite_sequence yazılamıyorsa: o numarayla geçici bir kayıt eklenip silinir (numara bir daha kullanılmaz)
        await env.DB.batch([
          env.DB.prepare("INSERT OR IGNORE INTO notlar (id, created_at, isim, mesaj) VALUES (?1, ?2, '-', '-')").bind(hedef, iso(0)),
          env.DB.prepare("DELETE FROM notlar WHERE id = ?1 AND isim = '-' AND created_at = ?2").bind(hedef, iso(0)),
        ]);
      }
    }
  }
  const yanit = { eklenen, zaten: ifadeler.length - eklenen, gecersiz: gecersizSayisi };
  if (g.ayarlar && typeof g.ayarlar === 'object') yanit.ayarlar = await ayarlariYaz(env, g.ayarlar);
  if (g.icerik !== undefined && g.icerik !== null) {
    await env.DB.prepare('UPDATE icerik SET veri = ?1 WHERE id = 1').bind(icerikDogrula(g.icerik)).run();
    yanit.icerik = true;
  }
  return json(yanit);
}
