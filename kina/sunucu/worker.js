/*
 * Elif & Yunus — Kına gecesi sunucusu (Cloudflare Worker, tek dosya, dış bağımlılık yok)
 *
 * Bağlar (Worker > Bindings):     DEPO → R2 kovası, DB → D1 veritabanı
 * Gizli değişkenler (Secrets):    YONETICI_SIFRE (en az 12 karakter), IMZA_ANAHTARI (uzun rastgele metin)
 * Düz değişkenler (isteğe bağlı): KOKENLER (virgülle izinli kökenler), ALAN_GB (varsayılan 9.5)
 *
 * Mahremiyet: misafir yalnızca kendi cihaz kimliğiyle (X-Cihaz) yüklediği dosyaları görebilir;
 * tüm dosyaları yalnızca yönetici jetonu (ya da ondan türeyen okuma jetonu) açar.
 * Dosyalar belleğe alınmaz: istek gövdesi doğrudan R2'ye akıtılır (ücretsiz planda 10 ms CPU sınırı).
 */

// ---------------------------------------------------------------- sabitler

const KESIN_KAPANIS = Date.parse('2027-01-01T00:00:00+03:00'); // bundan sonra misafir yazması yok
const MB = 1024 * 1024;
const PARCA = 8 * MB;                 // 8 MiB'tan büyük dosyalar parça parça yüklenir
const KUCUK_EN_COK = 400 * 1024;      // küçük resim üst sınırı
const JETON_OMRU = 30 * 24 * 3600;    // yönetici jetonu (saniye)
const OKUMA_OMRU = 12 * 3600;         // okuma jetonu (saniye)
const DAKIKA = 60 * 1000;
const SAAT = 60 * DAKIKA;
const GUN = 24 * SAAT;
const DILEK_YOGUNLUK = 30;            // site geneli: 60 sn'de en çok dilek
const DOSYA_YOGUNLUK = 300;           // site geneli: 60 sn'de en çok yeni dosya kaydı
const GIRIS_DENEME = 8;               // IP başına 15 dk'da en çok hatalı giriş
const TOPLU_SIL_EN_COK = 2000;        // /yonetim/sil tek istekte en çok dosya
const TEMIZLE_EN_COK = 400;           // /yonetim/temizle tek istekte en çok kayıt
const IPTAL_EN_COK = 25;              // tek istekte en çok çok-parçalı oturum iptali (alt istek sınırı)
const D1_PARCA = 90;                  // D1 bir ifadede en çok 100 parametre alır
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_TARIH = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

// İzinli dosya türleri ve R2 anahtarındaki uzantıları
const MIMELER = {
  foto: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif',
          'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' },
  video: { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
           'video/3gpp': '3gp', 'video/x-m4v': 'm4v' },
};
const IZINLI_MIME = new Set([...Object.keys(MIMELER.foto), ...Object.keys(MIMELER.video)]);
// Tarayıcı türü boş (ya da application/octet-stream) gönderirse dosya adının uzantısına bakılır
const UZANTIDAN = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic',
  heif: 'image/heif', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', mp4: 'video/mp4',
  mov: 'video/quicktime', qt: 'video/quicktime', webm: 'video/webm', '3gp': 'video/3gpp', m4v: 'video/x-m4v' };
// Bazı telefonların gönderdiği standart dışı adlar
const ESDEGER = { 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'image/x-png': 'image/png' };

// Ayar alanları ve doğrulama kuralları: 'bayrak' (0/1), 'tarih' (ISO ya da null), [en az, en çok, null olabilir mi]
const AYAR_KURALI = {
  dosya_acik: 'bayrak', dosya_baslangic: 'tarih', dosya_bitis: 'tarih',
  dilek_acik: 'bayrak', dilek_baslangic: 'tarih', dilek_bitis: 'tarih',
  dilekler_gorunur: 'bayrak',
  dilek_siniri: [1, 50, true], dosya_siniri: [1, 2000, true],
  foto_mb: [1, 100, false], video_mb: [10, 500, false],
};
const AYAR_ALANLARI = Object.keys(AYAR_KURALI);

// Görünmez/yön (bidi) karakterleri ve satır sonu dışındaki kontrol karakterleri
const GORUNMEZ = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\xAD]/g;
// eslint-disable-next-line no-control-regex -- kontrol karakterleri bilerek silinir
const KONTROL = /[\x00-\x09\x0B-\x1F\x7F-\x9F]/g;

// ---------------------------------------------------------------- hatalar

const MESAJLAR = {
  gecersiz: 'İstek geçersiz.',
  yetkisiz: 'Oturum geçersiz ya da süresi dolmuş, lütfen yeniden giriş yapın.',
  yasak: 'Bu işlem için izniniz yok.',
  yok: 'Bulunamadı.',
  kapali: 'Paylaşım şu anda kapalı.',
  dilek_siniri: 'Bu telefondan gönderilebilecek dilek sınırına ulaşıldı.',
  dosya_siniri: 'Bu telefondan yüklenebilecek dosya sınırına ulaşıldı.',
  yogunluk: 'Şu anda çok yoğunuz, lütfen biraz sonra tekrar deneyin.',
  cok_buyuk: 'Bu dosya çok büyük.',
  alan_doldu: 'Depolama alanı doldu, daha fazla dosya yüklenemiyor.',
  tur: 'Bu dosya türü desteklenmiyor. Lütfen fotoğraf ya da video seçin.',
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

// ---------------------------------------------------------------- giriş noktası

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    const izinli = kokenIzinliMi(origin, env);
    let yanit;
    try {
      if (request.method === 'OPTIONS') {
        // Ön uçuş (preflight): izinsiz kökene CORS başlığı verilmez, tarayıcı engeller
        yanit = new Response(null, { status: 204 });
        if (izinli) {
          yanit.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
          yanit.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Cihaz');
          yanit.headers.set('Access-Control-Max-Age', '86400');
        }
      } else {
        yanit = await yonlendir(request, env, ctx);
      }
    } catch (e) {
      if (e instanceof Hata) {
        yanit = hataYaniti(e);
      } else if (/no such table/i.test(String(e && e.message))) {
        console.error('Şema uygulanmamış:', e && e.message);
        yanit = hataYaniti(kurulumEksik());
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
  const p = (url.pathname.replace(/\/+$/, '') || '/').split('/').slice(1); // '/a/b' → ['a','b']
  const y = request.method;

  if (p.length === 1 && p[0] === '' && y === 'GET') {
    return json({ calisiyor: true, bilgi: 'Elif & Yunus kına sunucusu. Durum için /durum adresine bakın.' });
  }
  if (!env.DB || !env.DEPO) throw kurulumEksik();

  switch (p[0]) {
    case 'durum':
      if (y === 'GET' && p.length === 1) return durum(request, env);
      break;
    case 'dilekler':
      if (y === 'GET' && p.length === 1) return dilekleriListele(request, env, url);
      break;
    case 'dilek':
      if (y === 'POST' && p.length === 1) return dilekEkle(request, env);
      break;
    case 'benim':
      if (y === 'GET' && p.length === 1) return benim(request, env);
      break;
    case 'yukleme':
      if (p.length === 1 && y === 'POST') return yuklemeBaslat(request, env);
      if (p.length === 2 && y === 'PUT') return tekParcaYukle(request, env, p[1]);
      if (p.length === 2 && y === 'DELETE') return kendiDosyaniSil(request, env, p[1]);
      if (p.length === 4 && p[2] === 'parca' && y === 'PUT') return parcaYukle(request, env, p[1], p[3]);
      if (p.length === 3 && p[2] === 'bitir' && y === 'POST') return parcalariBitir(request, env, p[1]);
      if (p.length === 3 && p[2] === 'kucuk' && y === 'PUT') return kucukYukle(request, env, p[1]);
      break;
    case 'k':
    case 'a':
      if ((y === 'GET' || y === 'HEAD') && p.length === 2) return dosyaVer(request, env, url, p[1], p[0] === 'a');
      break;
    case 'yonetim':
      return yonetim(request, env, ctx, url, p.slice(1));
  }
  throw yok();
}

async function yonetim(request, env, ctx, url, p) {
  const y = request.method;
  if (p.length === 1 && p[0] === 'giris' && y === 'POST') return yoneticiGirisi(request, env, ctx);
  if (!yonetimHazir(env)) throw kurulumEksik();
  if (!(await yoneticiMi(request, env))) throw new Hata(401, 'yetkisiz');

  const yol = `${y} ${p.join('/')}`;
  if (yol === 'GET ozet') return yonetimOzet(env);
  if (yol === 'GET dosyalar') return yonetimDosyalar(env, url);
  if (yol === 'GET dilekler') return yonetimDilekler(env);
  if (y === 'PATCH' && p.length === 2 && p[0] === 'dilek') return yonetimDilekDuzenle(request, env, p[1]);
  if (yol === 'POST sil') return yonetimSil(request, env);
  if (yol === 'PUT ayarlar') return yonetimAyarlar(request, env);
  if (yol === 'POST temizle') return yonetimTemizle(env);
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

function corsEkle(yanit, origin) {
  const h = new Headers(yanit.headers);
  h.append('Vary', 'Origin');
  if (origin) {
    h.set('Access-Control-Allow-Origin', origin);
    h.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, ETag');
  }
  return new Response(yanit.body, { status: yanit.status, statusText: yanit.statusText, headers: h });
}

// ---------------------------------------------------------------- istek yardımcıları

const iso = (ms) => new Date(ms).toISOString();

function cihazOku(request) {
  const v = (request.headers.get('X-Cihaz') || '').trim().toLowerCase();
  return UUID.test(v) ? v : null;
}

function cihazZorunlu(request) {
  const c = cihazOku(request);
  if (!c) throw gecersiz('Cihaz kimliği eksik ya da geçersiz.');
  return c;
}

function idOku(v) {
  const s = String(v || '').toLowerCase();
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

function icerikUzunlugu(request) {
  const v = request.headers.get('Content-Length');
  return v && /^\d{1,15}$/.test(v) ? Number(v) : null;
}

// JSON gövdesini en çok "enCok" bayta kadar okur (Content-Length'siz akışlarda da sınırlı)
async function jsonOku(request, enCok) {
  const uzunluk = icerikUzunlugu(request);
  if (uzunluk !== null && uzunluk > enCok) throw gecersiz('İstek çok büyük.');
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
          throw gecersiz('İstek çok büyük.');
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
  const metin = new TextDecoder().decode(bayt);
  try {
    const v = JSON.parse(metin);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch { /* aşağıda hata */ }
  throw gecersiz('İstek gövdesi geçersiz.');
}

function kesinKapanisDenetle() {
  if (Date.now() >= KESIN_KAPANIS) throw new Hata(403, 'kapali', 'Paylaşım sona erdi.');
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

// Tek satırlık metin (isim, dosya adı)
function tekSatir(s) {
  const t = temizle(s);
  return t === null ? null : t.replace(/\s*\n+\s*/g, ' ');
}

function isimDogrula(v) {
  const t = tekSatir(v);
  if (!t || harfSayisi(t) > 50) throw gecersiz('İsim 1–50 karakter olmalı.');
  return t;
}

function mesajDogrula(v) {
  let t = temizle(v);
  if (t === null) throw gecersiz('Mesaj 2–600 karakter olmalı.');
  // Satır sonu boşlukları atılır, en çok 3 ardışık boş satır kalır
  t = t.split('\n').map((satir) => satir.trimEnd()).join('\n').replace(/\n{5,}/g, '\n\n\n\n').trim();
  const n = harfSayisi(t);
  if (n < 2 || n > 600) throw gecersiz('Mesaj 2–600 karakter olmalı.');
  return t;
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

// Jeton biçimi: <önek>.<bitiş unix sn>.<imza>; önek 'y' yönetici, 'o' okuma
async function jetonUret(env, onek, omur) {
  const bitis = Math.floor(Date.now() / 1000) + omur;
  const imza = b64url(await hmac(env, `${onek}.${bitis}`));
  return { jeton: `${onek}.${bitis}.${imza}`, bitis: iso(bitis * 1000) };
}

async function jetonGecerliMi(env, jeton, onek) {
  if (!yonetimHazir(env) || typeof jeton !== 'string' || jeton.length > 200) return false;
  const p = jeton.split('.');
  if (p.length !== 3 || p[0] !== onek || !/^\d{1,12}$/.test(p[1])) return false;
  if (Number(p[1]) * 1000 <= Date.now()) return false;
  const verilen = b64urlCoz(p[2]);
  if (!verilen) return false;
  return esit(verilen, await hmac(env, `${onek}.${p[1]}`));
}

async function yoneticiMi(request, env) {
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') || '');
  return m ? jetonGecerliMi(env, m[1], 'y') : false;
}

// ---------------------------------------------------------------- ayarlar

async function ayarOku(env) {
  const r = await env.DB.prepare('SELECT * FROM ayarlar WHERE id = 1').first();
  if (!r) throw kurulumEksik();
  return ayarBicimle(r);
}

function ayarBicimle(r) {
  const a = {};
  for (const alan of AYAR_ALANLARI) {
    const v = r[alan];
    a[alan] = AYAR_KURALI[alan] === 'bayrak' ? (v ? 1 : 0) : (v === undefined ? null : v);
  }
  return a;
}

// "Açık" kuralı: <tur>_acik = 1, kesin kapanıştan önce, başlangıç ≤ şimdi < bitiş
function acikMi(ayar, tur, simdi) {
  const bas = ayar[`${tur}_baslangic`];
  const bit = ayar[`${tur}_bitis`];
  return ayar[`${tur}_acik`] === 1 && simdi < KESIN_KAPANIS &&
    (!bas || Date.parse(bas) <= simdi) && (!bit || Date.parse(bit) > simdi);
}

function acikDurumu(ayar, simdi) {
  return { dosya: acikMi(ayar, 'dosya', simdi), dilek: acikMi(ayar, 'dilek', simdi) };
}

function alanBayt(env) {
  const gb = parseFloat(env.ALAN_GB);
  // GB = 10^9 bayt kabul edilir (R2'nin 10 GB ücretsiz kotasının altında kalmak için temkinli)
  return Math.floor((Number.isFinite(gb) && gb > 0 ? gb : 9.5) * 1e9);
}

// ---------------------------------------------------------------- misafir: durum ve dilekler

async function durum(request, env) {
  const simdi = Date.now();
  const cihaz = cihazOku(request);
  const r = await env.DB.prepare(
    `SELECT a.*,
       COALESCE((SELECT bayt FROM sayac WHERE id = 1), 0) AS _bayt,
       (SELECT COUNT(*) FROM dilekler WHERE cihaz = ?1) AS _dilek,
       (SELECT COUNT(*) FROM dosyalar WHERE cihaz = ?1) AS _dosya
     FROM ayarlar a WHERE a.id = 1`).bind(cihaz).first();
  if (!r) throw kurulumEksik();
  const ayar = ayarBicimle(r);
  const yanit = {
    simdi: iso(simdi),
    ayar,
    acik: acikDurumu(ayar, simdi),
    alan_dolu: r._bayt >= alanBayt(env),
  };
  if (cihaz) yanit.benim = { dilek: r._dilek, dosya: r._dosya };
  return json(yanit);
}

// Dileğe bağlı, tamamlanmış foto/video sayıları
const DILEK_SAYILARI = `
  (SELECT COUNT(*) FROM dosyalar f WHERE f.dilek_id = d.id AND f.durum = 'tamam' AND f.tur = 'foto') AS foto,
  (SELECT COUNT(*) FROM dosyalar f WHERE f.dilek_id = d.id AND f.durum = 'tamam' AND f.tur = 'video') AS video`;

async function dilekleriListele(request, env, url) {
  const ayar = await ayarOku(env);
  if (!ayar.dilekler_gorunur && !(await yoneticiMi(request, env))) {
    return json({ dilekler: [], daha: false, silinen: [], gizli: true });
  }
  const adet = sinirla(url.searchParams.get('adet'), 1, 100, 20);
  const once = pozitifTam(url.searchParams.get('once'));
  const liste = once
    ? env.DB.prepare(`SELECT d.id, d.zaman, d.isim, d.mesaj, ${DILEK_SAYILARI} FROM dilekler d
        WHERE d.id < ?1 ORDER BY d.id DESC LIMIT ?2`).bind(once, adet + 1)
    : env.DB.prepare(`SELECT d.id, d.zaman, d.isim, d.mesaj, ${DILEK_SAYILARI} FROM dilekler d
        ORDER BY d.id DESC LIMIT ?1`).bind(adet + 1);
  const silinen = env.DB.prepare(
    'SELECT DISTINCT dilek_id AS id FROM silinenler WHERE zaman > ?1 ORDER BY dilek_id DESC LIMIT 1000',
  ).bind(iso(Date.now() - 7 * GUN));
  const [l, s] = await env.DB.batch([liste, silinen]);
  const dilekler = l.results;
  const daha = dilekler.length > adet;
  if (daha) dilekler.length = adet;
  return json({ dilekler, daha, silinen: s.results.map((x) => x.id), gizli: false });
}

async function dilekEkle(request, env) {
  const cihaz = cihazZorunlu(request);
  const govde = await jsonOku(request, 16 * 1024);
  const simdi = Date.now();
  const ayar = await ayarOku(env);
  if (!acikMi(ayar, 'dilek', simdi)) throw new Hata(403, 'kapali', 'Dilek bırakma şu anda kapalı.');
  const isim = isimDogrula(govde.isim);
  const mesaj = mesajDogrula(govde.mesaj);
  const sinir = ayar.dilek_siniri;
  const birDkOnce = iso(simdi - DAKIKA);

  // Sınır ve yoğunluk denetimi ekleme ile aynı ifadede: aynı anda gelen isteklerde de aşılmaz
  const r = await env.DB.prepare(
    `INSERT INTO dilekler (zaman, isim, mesaj, cihaz)
     SELECT ?1, ?2, ?3, ?4
     WHERE (?5 IS NULL OR (SELECT COUNT(*) FROM dilekler WHERE cihaz = ?4) < ?5)
       AND (SELECT COUNT(*) FROM dilekler WHERE zaman > ?6) < ?7
     RETURNING id, zaman`,
  ).bind(iso(simdi), isim, mesaj, cihaz, sinir, birDkOnce, DILEK_YOGUNLUK).first();

  if (!r) {
    if (sinir !== null) {
      const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM dilekler WHERE cihaz = ?1').bind(cihaz).first();
      if (c.n >= sinir) {
        throw new Hata(429, 'dilek_siniri', `Bir telefondan en çok ${sinir} dilek gönderilebilir.`, sinir);
      }
    }
    throw new Hata(429, 'yogunluk');
  }
  return json({ id: r.id, zaman: r.zaman }, 201);
}

// ---------------------------------------------------------------- misafir: yükleme

async function kayitOku(env, id) {
  return env.DB.prepare('SELECT * FROM dosyalar WHERE id = ?1').bind(id).first();
}

const parcaSayisi = (boyut) => Math.ceil(boyut / PARCA);

// Mevcut kaydın durumunu istemciye bildirir (POST /yukleme yeniden denendiğinde)
async function kayitDurumu(env, k) {
  const parcali = k.boyut > PARCA;
  if (parcali && k.durum === 'yukleniyor' && !k.yukleme) await parcaliOturumHazirla(env, k);
  const yanit = { id: k.id, durum: k.durum, parcali };
  if (parcali) {
    yanit.parca = PARCA;
    yanit.parca_sayisi = parcaSayisi(k.boyut);
  }
  yanit.kucuk = !!k.kucuk;
  return yanit;
}

// R2 çok parçalı yükleme oturumunu açar ve kayda yazar (yalnızca bir kez)
async function parcaliOturumHazirla(env, k) {
  const mp = await env.DEPO.createMultipartUpload(k.anahtar, {
    httpMetadata: { contentType: k.mime, contentDisposition: 'inline' },
  });
  const r = await env.DB.prepare('UPDATE dosyalar SET yukleme = ?1 WHERE id = ?2 AND yukleme IS NULL')
    .bind(mp.uploadId, k.id).run();
  if (r.meta.changes === 1) {
    k.yukleme = mp.uploadId;
    return;
  }
  // Başka bir istek önce davrandı (ya da kayıt silindi): bu oturumu bırak, kayıttakini kullan
  try { await mp.abort(); } catch { /* önemsiz */ }
  const guncel = await kayitOku(env, k.id);
  if (!guncel) throw yok();
  k.yukleme = guncel.yukleme;
}

function mimeBelirle(tur, mime, ad) {
  let m = typeof mime === 'string' ? mime.toLowerCase().split(';')[0].trim() : '';
  m = ESDEGER[m] || m;
  if ((!m || m === 'application/octet-stream') && ad) {
    const uzanti = (/\.([a-z0-9]{1,5})$/i.exec(ad) || [])[1];
    m = (uzanti && UZANTIDAN[uzanti.toLowerCase()]) || '';
  }
  const uzanti = MIMELER[tur][m];
  if (!uzanti) throw new Hata(415, 'tur');
  return { mime: m, uzanti };
}

function olcu(v) {
  return Number.isInteger(v) && v > 0 && v <= 100000 ? v : null;
}

function sureOku(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 86400 ? Math.round(v * 100) / 100 : null;
}

function istegeBagliMetin(v, enCok) {
  if (v === undefined || v === null) return null;
  const t = tekSatir(String(v));
  return t ? kes(t, enCok) || null : null;
}

async function yuklemeBaslat(request, env) {
  const cihaz = cihazZorunlu(request);
  const g = await jsonOku(request, 16 * 1024);

  // 1) Alanlar
  const id = typeof g.id === 'string' ? idOku(g.id) : null;
  if (!id) throw gecersiz('Dosya kimliği geçersiz.');
  if (g.tur !== 'foto' && g.tur !== 'video') throw gecersiz('Dosya türü foto ya da video olmalı.');
  const tur = g.tur;
  const boyut = g.boyut;
  if (!Number.isSafeInteger(boyut) || boyut < 1) throw gecersiz('Dosya boyutu geçersiz.');
  const ad = istegeBagliMetin(g.ad, 120);
  const isim = istegeBagliMetin(g.isim, 50);
  const dilekId = pozitifTam(g.dilek_id);

  // 2) Aynı kimlik daha önce kaydedildiyse (yeniden deneme) mevcut durumu döndür. Bu, paylaşım denetiminden önce
  //    yapılır: kapanıştan önce başlamış bir yükleme, misafir sayfayı kapanıştan sonra yeniden açsa da tamamlanabilir.
  const mevcut = await kayitOku(env, id);
  if (mevcut) {
    if (mevcut.cihaz !== cihaz) throw new Hata(403, 'yasak');
    return json(await kayitDurumu(env, mevcut));
  }

  // 3) Tür, 4) boyut, 5) paylaşım açık mı
  const { mime, uzanti } = mimeBelirle(tur, g.mime, ad);
  const simdi = Date.now();
  const ayar = await ayarOku(env);
  const sinirMb = tur === 'foto' ? ayar.foto_mb : ayar.video_mb;
  if (boyut > sinirMb * MB) {
    throw new Hata(413, 'cok_buyuk', `Bu dosya çok büyük. En çok ${sinirMb} MB yüklenebilir.`, sinirMb);
  }
  if (!acikMi(ayar, 'dosya', simdi)) throw new Hata(403, 'kapali', 'Fotoğraf ve video paylaşımı şu anda kapalı.');

  // 6) Sınırlar ekleme ile aynı ifadede denetlenir; toplam alan "sayac" tablosunda tutulur
  const zaman = iso(simdi);
  const anahtar = `asil/${id}.${uzanti}`;
  const sinir = ayar.dosya_siniri;
  const alan = alanBayt(env);
  const birDkOnce = iso(simdi - DAKIKA);
  const [ekle] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dosyalar (id, zaman, tur, mime, boyut, ad, isim, dilek_id, cihaz, genislik, yukseklik, sure, anahtar)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7,
         (SELECT id FROM dilekler WHERE id = ?8 AND cihaz = ?9 AND zaman > ?10),
         ?9, ?11, ?12, ?13, ?14
       WHERE NOT EXISTS (SELECT 1 FROM dosyalar WHERE id = ?1)
         AND (?15 IS NULL OR (SELECT COUNT(*) FROM dosyalar WHERE cihaz = ?9) < ?15)
         AND COALESCE((SELECT bayt FROM sayac WHERE id = 1), 0) + ?5 <= ?16
         AND (SELECT COUNT(*) FROM dosyalar WHERE zaman > ?17) < ?18
       RETURNING no`,
    ).bind(id, zaman, tur, mime, boyut, ad, isim, dilekId, cihaz, iso(simdi - 12 * SAAT),
      olcu(g.genislik), olcu(g.yukseklik), sureOku(g.sure), anahtar, sinir, alan, birDkOnce, DOSYA_YOGUNLUK),
    env.DB.prepare(
      `UPDATE sayac SET bayt = bayt + ?1
       WHERE id = 1 AND EXISTS (SELECT 1 FROM dosyalar WHERE id = ?2 AND cihaz = ?3 AND zaman = ?4)`,
    ).bind(boyut, id, cihaz, zaman),
  ]);

  if (ekle.results.length === 0) {
    // Neden eklenmediğini bul (sözleşmedeki sırayla)
    const ayni = await kayitOku(env, id);
    if (ayni) {
      if (ayni.cihaz !== cihaz) throw new Hata(403, 'yasak');
      return json(await kayitDurumu(env, ayni));
    }
    const c = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM dosyalar WHERE cihaz = ?1) AS benim,
              COALESCE((SELECT bayt FROM sayac WHERE id = 1), 0) AS bayt`,
    ).bind(cihaz).first();
    if (sinir !== null && c.benim >= sinir) {
      throw new Hata(429, 'dosya_siniri', `Bir telefondan en çok ${sinir} dosya yüklenebilir.`, sinir);
    }
    if (c.bayt + boyut > alan) throw new Hata(507, 'alan_doldu');
    throw new Hata(429, 'yogunluk');
  }

  const kayit = { id, boyut, mime, anahtar, yukleme: null, durum: 'yukleniyor', kucuk: 0 };
  const yanit = await kayitDurumu(env, kayit);
  return json(yanit, 201);
}

// Kayıt bu cihazın mı? Değilse varlığı belli etmeden 404.
async function kendiKaydi(request, env, idHam) {
  const cihaz = cihazZorunlu(request);
  const id = idOku(idHam);
  if (!id) throw yok();
  const k = await kayitOku(env, id);
  if (!k || k.cihaz !== cihaz) throw yok();
  return k;
}

async function tekParcaYukle(request, env, idHam) {
  const k = await kendiKaydi(request, env, idHam);
  kesinKapanisDenetle();
  if (k.durum === 'tamam') return json({ tamam: true });
  if (k.boyut > PARCA) throw gecersiz('Bu dosya parça parça yüklenmeli.');
  if (icerikUzunlugu(request) !== k.boyut || !request.body) throw gecersiz('Dosya boyutu uyuşmuyor.');

  // Gövde belleğe alınmadan R2'ye akıtılır
  await env.DEPO.put(k.anahtar, request.body, {
    httpMetadata: { contentType: k.mime, contentDisposition: 'inline' },
  });
  const r = await env.DB.prepare(
    "UPDATE dosyalar SET durum = 'tamam', tamamlandi = ?1 WHERE id = ?2 AND durum = 'yukleniyor'",
  ).bind(iso(Date.now()), k.id).run();
  if (r.meta.changes === 0 && !(await kayitOku(env, k.id))) {
    // Yükleme sürerken kayıt silinmiş: artık nesneyi bırakma
    await env.DEPO.delete(k.anahtar);
    throw yok();
  }
  return json({ tamam: true });
}

async function parcaYukle(request, env, idHam, nHam) {
  const k = await kendiKaydi(request, env, idHam);
  kesinKapanisDenetle();
  const n = pozitifTam(nHam);
  if (k.durum === 'tamam') return json({ n, tamam: true });
  if (k.boyut <= PARCA) throw gecersiz('Bu dosya tek parça yüklenmeli.');
  const toplam = parcaSayisi(k.boyut);
  if (!n || n > toplam) throw gecersiz('Parça numarası geçersiz.');
  const beklenen = n < toplam ? PARCA : k.boyut - (toplam - 1) * PARCA;
  if (icerikUzunlugu(request) !== beklenen || !request.body) throw gecersiz('Parça boyutu uyuşmuyor.');
  if (!k.yukleme) await parcaliOturumHazirla(env, k);

  const parca = await env.DEPO.resumeMultipartUpload(k.anahtar, k.yukleme).uploadPart(n, request.body);
  return json({ n, etag: parca.etag });
}

async function parcalariBitir(request, env, idHam) {
  const k = await kendiKaydi(request, env, idHam);
  kesinKapanisDenetle();
  if (k.durum === 'tamam') return json({ tamam: true });
  if (k.boyut <= PARCA || !k.yukleme) throw gecersiz('Parçalı yükleme bulunamadı.');

  const g = await jsonOku(request, 64 * 1024);
  const toplam = parcaSayisi(k.boyut);
  const liste = Array.isArray(g.parcalar) ? g.parcalar : null;
  if (!liste || liste.length !== toplam) throw gecersiz('Parça listesi eksik.');
  const parcalar = [];
  const gorulen = new Set();
  for (const x of liste) {
    const n = x && pozitifTam(x.n);
    const etag = x && typeof x.etag === 'string' ? x.etag : '';
    if (!n || n > toplam || gorulen.has(n) || !etag || etag.length > 200) throw gecersiz('Parça listesi geçersiz.');
    gorulen.add(n);
    parcalar.push({ partNumber: n, etag });
  }
  parcalar.sort((a, b) => a.partNumber - b.partNumber);

  let nesne;
  try {
    nesne = await env.DEPO.resumeMultipartUpload(k.anahtar, k.yukleme).complete(parcalar);
  } catch (e) {
    // Aynı anda gelen ikinci "bitir" isteği olabilir
    const guncel = await kayitOku(env, k.id);
    if (guncel && guncel.durum === 'tamam') return json({ tamam: true });
    console.error('Parçalar birleştirilemedi:', e && e.message);
    throw gecersiz('Parçalar birleştirilemedi, dosyayı yeniden yükleyin.');
  }
  if (nesne.size !== k.boyut) {
    // Olmaması gerekir (her parçanın boyutu denetleniyor); yine de tutarsız dosya bırakma
    await kayitlariSil(env, [{ ...k, durum: 'tamam' }]);
    throw gecersiz('Dosya boyutu uyuşmuyor, yeniden yükleyin.');
  }
  const r = await env.DB.prepare(
    "UPDATE dosyalar SET durum = 'tamam', tamamlandi = ?1, yukleme = NULL WHERE id = ?2 AND durum = 'yukleniyor'",
  ).bind(iso(Date.now()), k.id).run();
  if (r.meta.changes === 0 && !(await kayitOku(env, k.id))) {
    await env.DEPO.delete(k.anahtar);
    throw yok();
  }
  return json({ tamam: true });
}

async function kucukYukle(request, env, idHam) {
  const k = await kendiKaydi(request, env, idHam);
  kesinKapanisDenetle();
  const tur = (request.headers.get('Content-Type') || '').toLowerCase().split(';')[0].trim();
  if (tur !== 'image/jpeg') throw new Hata(415, 'tur', 'Küçük resim JPEG olmalı.');
  const uzunluk = icerikUzunlugu(request);
  if (!uzunluk || !request.body) throw gecersiz('Küçük resim boyutu eksik.');
  if (uzunluk > KUCUK_EN_COK) throw gecersiz('Küçük resim en çok 400 KB olabilir.');

  const anahtar = `kucuk/${k.id}.jpg`;
  await env.DEPO.put(anahtar, request.body, {
    httpMetadata: { contentType: 'image/jpeg', contentDisposition: 'inline' },
  });
  const r = await env.DB.prepare('UPDATE dosyalar SET kucuk = 1 WHERE id = ?1').bind(k.id).run();
  if (r.meta.changes === 0) {
    await env.DEPO.delete(anahtar);
    throw yok();
  }
  return json({ kucuk: true });
}

async function kendiDosyaniSil(request, env, idHam) {
  const cihaz = cihazZorunlu(request);
  const id = idOku(idHam);
  if (!id) throw gecersiz('Dosya kimliği geçersiz.');
  const k = await kayitOku(env, id);
  // Yoksa ya da başkasınınsa da "silindi" denir (idempotent, varlığı belli etmez)
  if (k && k.cihaz === cihaz) await kayitlariSil(env, [k]);
  return json({ silindi: true });
}

// Kayıtları R2'den ve D1'den siler; yarım çok parçalı yüklemeleri iptal eder. Silinen bayt döner.
// Ücretsiz planda istek başına alt istek sınırı (50) için en çok IPTAL_EN_COK oturum iptal edilir;
// kalanların parçalarını R2'nin "yarım yüklemeleri 7 günde iptal et" kuralı temizler.
async function kayitlariSil(env, kayitlar) {
  if (kayitlar.length === 0) return 0;
  let iptal = 0;
  for (const k of kayitlar) {
    if (k.durum === 'yukleniyor' && k.yukleme && iptal < IPTAL_EN_COK) {
      iptal++;
      try { await env.DEPO.resumeMultipartUpload(k.anahtar, k.yukleme).abort(); } catch { /* zaten yok */ }
    }
  }
  // Önce R2 (D1 kaydı kalırsa yeniden silinebilir; tersi görünmez çöp bırakırdı)
  const anahtarlar = kayitlar.flatMap((k) => [k.anahtar, `kucuk/${k.id}.jpg`]);
  for (let i = 0; i < anahtarlar.length; i += 1000) await env.DEPO.delete(anahtarlar.slice(i, i + 1000));

  const ifadeler = [];
  for (let i = 0; i < kayitlar.length; i += D1_PARCA) {
    const idler = kayitlar.slice(i, i + D1_PARCA).map((k) => k.id);
    const yer = idler.map((_, j) => `?${j + 1}`).join(',');
    ifadeler.push(env.DB.prepare(
      `UPDATE sayac SET bayt = MAX(0, bayt - (SELECT COALESCE(SUM(boyut), 0) FROM dosyalar WHERE id IN (${yer})))
       WHERE id = 1`).bind(...idler));
    ifadeler.push(env.DB.prepare(`DELETE FROM dosyalar WHERE id IN (${yer})`).bind(...idler));
  }
  await env.DB.batch(ifadeler);
  return kayitlar.reduce((t, k) => t + (k.boyut || 0), 0);
}

async function benim(request, env) {
  const cihaz = cihazZorunlu(request);
  const [d, l] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, zaman, tur, mime, boyut, durum, kucuk, genislik, yukseklik, sure, dilek_id
       FROM dosyalar WHERE cihaz = ?1 ORDER BY no DESC LIMIT 2000`).bind(cihaz),
    env.DB.prepare('SELECT id, zaman, isim, mesaj FROM dilekler WHERE cihaz = ?1 ORDER BY id DESC').bind(cihaz),
  ]);
  for (const x of d.results) x.kucuk = !!x.kucuk;
  return json({ dosyalar: d.results, dilekler: l.results });
}

// ---------------------------------------------------------------- dosya okuma: /k (küçük) ve /a (asıl)

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

// İndirme için güvenli dosya adı (Content-Disposition)
function indirmeBasligi(k) {
  const uzanti = k.anahtar.split('.').pop();
  // eslint-disable-next-line no-control-regex -- kontrol karakterleri bilerek silinir
  let ad = (k.ad || '').replace(/[\x00-\x1F\x7F"\\/:*?<>|]/g, '').replace(/^[.\s]+/, '').trim();
  ad = kes(ad, 100);
  if (!ad) ad = `kina-${k.id.slice(0, 8)}`;
  const adUzantisi = (/\.([a-z0-9]{1,5})$/i.exec(ad) || [])[1];
  if (!adUzantisi || UZANTIDAN[adUzantisi.toLowerCase()] !== k.mime) ad += `.${uzanti}`;
  const ascii = ad.replace(/[^\x20-\x7E]/g, '_').replace(/[%;]/g, '_');
  const utf8 = encodeURIComponent(ad).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

async function dosyaVer(request, env, url, idHam, asil) {
  const id = idOku(idHam);
  if (!id) throw yok();
  const k = await kayitOku(env, id);
  if (!k) throw yok();

  // Yetki: kaydın cihazı ya da geçerli okuma jetonu. Değilse 404 (varlığı belli etme).
  const c = (url.searchParams.get('c') || '').toLowerCase();
  let yetkili = UUID.test(c) && esit(kodlayici.encode(c), kodlayici.encode(k.cihaz));
  if (!yetkili) {
    const t = url.searchParams.get('t');
    yetkili = !!t && (await jetonGecerliMi(env, t, 'o'));
  }
  if (!yetkili) throw yok();
  if (asil ? k.durum !== 'tamam' || !IZINLI_MIME.has(k.mime) : !k.kucuk) throw yok();

  const anahtar = asil ? k.anahtar : `kucuk/${k.id}.jpg`;
  const h = new Headers();
  let durumKodu = 200;
  let nesne;
  let aralik = null;

  if (request.method === 'HEAD') {
    nesne = await env.DEPO.head(anahtar);
    if (!nesne) throw yok();
  } else {
    if (asil) {
      aralik = aralikCoz(request.headers.get('Range'), k.boyut);
      if (aralik === 'karsilanamaz') {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${k.boyut}` } });
      }
    }
    const secenek = { onlyIf: request.headers };
    if (aralik) secenek.range = aralik;
    nesne = await env.DEPO.get(anahtar, secenek);
    if (!nesne) throw yok();
  }

  nesne.writeHttpMetadata(h);
  h.set('Content-Type', asil ? k.mime : 'image/jpeg');
  h.set('Content-Disposition', asil && url.searchParams.get('indir') === '1' ? indirmeBasligi(k) : 'inline');
  h.set('ETag', nesne.httpEtag);
  h.set('Cache-Control', 'private, max-age=3600');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Content-Security-Policy', "default-src 'none'; sandbox");
  h.set('Cross-Origin-Resource-Policy', 'cross-origin');
  if (asil) h.set('Accept-Ranges', 'bytes');

  if (request.method === 'HEAD') {
    h.set('Content-Length', String(nesne.size));
    return new Response(null, { status: 200, headers: h });
  }
  if (!('body' in nesne) || !nesne.body) {
    // Koşullu istek karşılandı: If-None-Match / If-Modified-Since → 304, diğerleri → 412
    const kosul = request.headers.has('If-None-Match') || request.headers.has('If-Modified-Since');
    return new Response(null, { status: kosul ? 304 : 412, headers: h });
  }
  if (aralik) {
    durumKodu = 206;
    h.set('Content-Range', `bytes ${aralik.offset}-${aralik.offset + aralik.length - 1}/${nesne.size}`);
  }
  return new Response(nesne.body, { status: durumKodu, headers: h });
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
    // Eski denemeleri arka planda temizle
    ctx.waitUntil(env.DB.prepare('DELETE FROM girisler WHERE zaman < ?1').bind(iso(simdi - GUN)).run()
      .catch(() => {}));
    throw new Hata(401, 'yetkisiz', 'Şifre yanlış.');
  }
  const y = await jetonUret(env, 'y', JETON_OMRU);
  const o = await jetonUret(env, 'o', OKUMA_OMRU);
  return json({ jeton: y.jeton, bitis: y.bitis, okuma: o.jeton, okuma_bitis: o.bitis });
}

async function yonetimOzet(env) {
  const simdi = Date.now();
  const [o, d, , a] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COALESCE(SUM(durum = 'tamam'), 0) AS dosya,
              COALESCE(SUM(durum = 'tamam' AND tur = 'foto'), 0) AS foto,
              COALESCE(SUM(durum = 'tamam' AND tur = 'video'), 0) AS video,
              COALESCE(SUM(CASE WHEN durum = 'tamam' THEN boyut END), 0) AS bayt,
              COALESCE(SUM(durum = 'yukleniyor'), 0) AS yarim,
              COALESCE(SUM(CASE WHEN durum = 'yukleniyor' THEN boyut END), 0) AS yarim_bayt
       FROM dosyalar`),
    env.DB.prepare('SELECT COUNT(*) AS n FROM dilekler'),
    // Toplam alan sayacını gerçek toplamla eşitle (kendi kendini onarır)
    env.DB.prepare('UPDATE sayac SET bayt = (SELECT COALESCE(SUM(boyut), 0) FROM dosyalar) WHERE id = 1'),
    env.DB.prepare('SELECT * FROM ayarlar WHERE id = 1'),
  ]);
  if (!a.results[0]) throw kurulumEksik();
  const ayar = ayarBicimle(a.results[0]);
  return json({
    ...o.results[0],
    dilek: d.results[0].n,
    alan_bayt: alanBayt(env),
    ayar,
    acik: acikDurumu(ayar, simdi),
  });
}

async function yonetimDosyalar(env, url) {
  const adet = sinirla(url.searchParams.get('adet'), 1, 1000, 500);
  const once = pozitifTam(url.searchParams.get('once'));
  const alanlar = `no, id, zaman, tamamlandi, tur, mime, boyut, ad, isim, dilek_id, genislik, yukseklik, sure, kucuk, durum`;
  const ifade = once
    ? env.DB.prepare(`SELECT ${alanlar} FROM dosyalar WHERE no < ?1 ORDER BY no DESC LIMIT ?2`).bind(once, adet + 1)
    : env.DB.prepare(`SELECT ${alanlar} FROM dosyalar ORDER BY no DESC LIMIT ?1`).bind(adet + 1);
  const { results } = await ifade.all();
  const daha = results.length > adet;
  if (daha) results.length = adet;
  for (const x of results) x.kucuk = !!x.kucuk;
  const o = await jetonUret(env, 'o', OKUMA_OMRU);
  return json({ dosyalar: results, daha, okuma: o.jeton, okuma_bitis: o.bitis });
}

async function yonetimDilekler(env) {
  const { results } = await env.DB.prepare(
    `SELECT d.id, d.zaman, d.isim, d.mesaj, ${DILEK_SAYILARI} FROM dilekler d ORDER BY d.id DESC`).all();
  return json({ dilekler: results });
}

async function yonetimDilekDuzenle(request, env, idHam) {
  const id = pozitifTam(idHam);
  if (!id) throw yok();
  const g = await jsonOku(request, 16 * 1024);
  const isim = g.isim === undefined ? null : isimDogrula(g.isim);
  const mesaj = g.mesaj === undefined ? null : mesajDogrula(g.mesaj);
  if (isim === null && mesaj === null) throw gecersiz('Değiştirilecek alan yok.');
  const r = await env.DB.prepare(
    'UPDATE dilekler SET isim = COALESCE(?1, isim), mesaj = COALESCE(?2, mesaj) WHERE id = ?3',
  ).bind(isim, mesaj, id).run();
  if (r.meta.changes === 0) throw yok();
  const dilek = await env.DB.prepare(
    `SELECT d.id, d.zaman, d.isim, d.mesaj, ${DILEK_SAYILARI} FROM dilekler d WHERE d.id = ?1`).bind(id).first();
  return json({ dilek });
}

async function yonetimSil(request, env) {
  const g = await jsonOku(request, 256 * 1024);
  const dosyaIdleri = g.dosyalar === undefined ? [] : g.dosyalar;
  const dilekIdleri = g.dilekler === undefined ? [] : g.dilekler;
  if (!Array.isArray(dosyaIdleri) || !Array.isArray(dilekIdleri)) throw gecersiz('Liste bekleniyordu.');
  if (dosyaIdleri.length > TOPLU_SIL_EN_COK || dilekIdleri.length > TOPLU_SIL_EN_COK) {
    throw gecersiz(`Tek seferde en çok ${TOPLU_SIL_EN_COK} öğe silinebilir.`);
  }
  const dosyalar = [...new Set(dosyaIdleri.map(idOku))];
  const dilekler = [...new Set(dilekIdleri.map(pozitifTam))];
  if (dosyalar.includes(null) || dilekler.includes(null)) throw gecersiz('Listede geçersiz kimlik var.');

  // Dosyalar: önce kayıtları bul (R2 anahtarları ve yarım yüklemeler için)
  let dosyaSayisi = 0;
  if (dosyalar.length) {
    const okumalar = [];
    for (let i = 0; i < dosyalar.length; i += D1_PARCA) {
      const idler = dosyalar.slice(i, i + D1_PARCA);
      okumalar.push(env.DB.prepare(
        `SELECT id, anahtar, durum, yukleme, boyut FROM dosyalar WHERE id IN (${idler.map((_, j) => `?${j + 1}`).join(',')})`,
      ).bind(...idler));
    }
    const kayitlar = (await env.DB.batch(okumalar)).flatMap((r) => r.results);
    await kayitlariSil(env, kayitlar);
    dosyaSayisi = kayitlar.length;
  }

  // Dilekler: silinenler tablosuna yaz, bağlı dosyaların dilek_id'sini boşalt, sil
  let dilekSayisi = 0;
  if (dilekler.length) {
    const zaman = iso(Date.now());
    const ifadeler = [env.DB.prepare('DELETE FROM silinenler WHERE zaman < ?1').bind(iso(Date.now() - 30 * GUN))];
    const silmeSirasi = [];
    for (let i = 0; i < dilekler.length; i += D1_PARCA) {
      const idler = dilekler.slice(i, i + D1_PARCA);
      const yer = idler.map((_, j) => `?${j + 2}`).join(',');
      ifadeler.push(env.DB.prepare(
        `INSERT INTO silinenler (dilek_id, zaman) SELECT id, ?1 FROM dilekler WHERE id IN (${yer})`,
      ).bind(zaman, ...idler));
      ifadeler.push(env.DB.prepare(`UPDATE dosyalar SET dilek_id = NULL WHERE dilek_id IN (${yer})`)
        .bind(zaman, ...idler));
      silmeSirasi.push(ifadeler.length);
      ifadeler.push(env.DB.prepare(`DELETE FROM dilekler WHERE id IN (${yer})`).bind(zaman, ...idler));
    }
    const sonuclar = await env.DB.batch(ifadeler);
    for (const s of silmeSirasi) dilekSayisi += sonuclar[s].meta.changes;
  }
  return json({ dosya: dosyaSayisi, dilek: dilekSayisi });
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
    if (typeof v !== 'string' || !ISO_TARIH.test(v)) throw hata();
    const ms = Date.parse(v);
    if (!Number.isFinite(ms)) throw hata();
    return iso(ms);
  }
  const [enAz, enCok, bosOlabilir] = kural;
  if (v === null && bosOlabilir) return null;
  if (!Number.isInteger(v) || v < enAz || v > enCok) {
    throw gecersiz(`"${alan}" ayarı ${enAz}–${enCok} arasında bir tam sayı olmalı.`);
  }
  return v;
}

async function yonetimAyarlar(request, env) {
  const g = await jsonOku(request, 16 * 1024);
  const mevcut = await ayarOku(env);
  const degisen = {};
  for (const alan of AYAR_ALANLARI) {
    if (Object.prototype.hasOwnProperty.call(g, alan)) degisen[alan] = ayarDegeriDogrula(alan, g[alan]);
  }
  const yeni = { ...mevcut, ...degisen };
  for (const tur of ['dosya', 'dilek']) {
    const bas = yeni[`${tur}_baslangic`];
    const bit = yeni[`${tur}_bitis`];
    if (bas && bit && Date.parse(bas) >= Date.parse(bit)) {
      throw gecersiz(`"${tur}_baslangic", "${tur}_bitis" tarihinden önce olmalı.`);
    }
  }
  const alanlar = Object.keys(degisen);
  if (alanlar.length) {
    // Sütun adları yalnızca sabit listeden gelir; değerler bağ parametresiyle
    const atamalar = alanlar.map((a, i) => `${a} = ?${i + 1}`).join(', ');
    await env.DB.prepare(`UPDATE ayarlar SET ${atamalar}, guncellendi = ?${alanlar.length + 1} WHERE id = 1`)
      .bind(...alanlar.map((a) => degisen[a]), iso(Date.now())).run();
  }
  const ayar = await ayarOku(env);
  return json({ ayar, acik: acikDurumu(ayar, Date.now()) });
}

async function yonetimTemizle(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, anahtar, durum, yukleme, boyut FROM dosyalar
     WHERE durum = 'yukleniyor' AND zaman < ?1 ORDER BY no LIMIT ?2`,
  ).bind(iso(Date.now() - 6 * SAAT), TEMIZLE_EN_COK).all();
  // Çok parçalı oturumların hepsi iptal edilebilsin diye bir seferde en çok IPTAL_EN_COK tanesi alınır
  let parcali = 0;
  const secilen = results.filter((k) => !k.yukleme || ++parcali <= IPTAL_EN_COK);
  const bayt = await kayitlariSil(env, secilen);
  return json({ silinen: secilen.length, bayt, daha: results.length === TEMIZLE_EN_COK || parcali > IPTAL_EN_COK });
}
