// Sayfayı eşitle — yönetim ekranında kaydedilen paylaşım özetini (Supabase › icerik.veri.ozet) sayfanın
// durağan dosyalarına işler. WhatsApp, Telegram, iMessage gibi uygulamalar bağlantı önizlemesini sayfanın betiğini
// çalıştırmadan, doğrudan index.html'deki etiketlerden okur; takvim uygulamaları da dugun.ics'i okur. Bu betik:
//   • index.html: sekme başlığı, açıklama, og etiketleri (başlık, açıklama, görsel), tema rengi, sekme simgesi ve
//     sayfayı ilk kez açan misafir için gömülü ilk veri (doğru renkler ve yazılar ilk anda görünsün)
//   • dugun.ics: etkinlik adı, tarih/saat, yer, açıklama, hatırlatmalar (değiştiyse SEQUENCE artar; takvime
//     abone olanlarda etkinlik kendiliğinden güncellenir)
//   • paylasim-guncel.jpg: sayfanın hazırladığı önizleme görseli (varsayılan görünümde depodaki paylasim.jpg kalır)
// Yalnızca publishable (herkese açık) anahtarla okur; veritabanına hiçbir şey yazmaz.
// GitHub Actions'ta Node ile çalışır (.github/workflows/sayfayi-esitle.yml). Dönüştürme işlevleri Node'a bağlı
// değildir; tarayıcıda da denenebilir.

export const SURUM = 1;
const KONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/g;
const metin = (v, max) => (typeof v === 'string' ? v.replace(/\r/g, '').replace(KONTROL, '').replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').trim().slice(0, max) : '');
const tekSatir = (v, max) => metin(v, max).replace(/\n+/g, ' ');
const zamanOku = v => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)) : null);
const htmlKacis = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// <script type="application/json"> içine güvenle gömülür: etiketi kapatamaz, HTML olarak yorumlanamaz
const jsonGom = v => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

// Özeti doğrular ve temizler. Eksik ya da geçersizse null döner; o zaman dosyalara hiç dokunulmaz.
export function ozetiDogrula(o) {
  if (!o || typeof o !== 'object' || o.surum !== SURUM) return null;
  const t = o.takvim && typeof o.takvim === 'object' ? o.takvim : {}, g = o.gorunum && typeof o.gorunum === 'object' ? o.gorunum : {};
  const z = {
    zaman: zamanOku(o.zaman),
    baslik: tekSatir(o.baslik, 200), aciklama: tekSatir(o.aciklama, 400),
    og_baslik: tekSatir(o.og_baslik, 200), og_aciklama: tekSatir(o.og_aciklama, 400), gorsel_alt: tekSatir(o.gorsel_alt, 200),
    gorsel: /^paylasim\/[0-9a-f-]{36}\.jpg$/.test(o.gorsel || '') ? o.gorsel : '',
    tema_rengi: /^#[0-9A-F]{6}$/i.test(g.t || '') ? g.t.toUpperCase() : '#1C2A23',
    ikon: typeof g.i === 'string' && g.i.length < 4000 && /^data:image\/svg\+xml,[\w%.!~*'()-]+$/.test(g.i) ? g.i : '',
    takvim: {
      baslik: tekSatir(t.baslik, 160), baslangic: zamanOku(t.baslangic), bitis: zamanOku(t.bitis), konum: tekSatir(t.konum, 300),
      aciklama: metin(t.aciklama, 1000), hatirlatma_gun: tekSatir(t.hatirlatma_gun, 200), hatirlatma_saat: tekSatir(t.hatirlatma_saat, 200),
    },
  };
  const k = z.takvim;
  if (!z.zaman || !z.baslik || !z.og_baslik || !k.baslik || !k.baslangic || !k.bitis || k.bitis <= k.baslangic) return null;
  return z;
}

// index.html'in <head>'ini günceller. Yalnızca ilk </head>'e kadarki bölüme dokunulur (sayfa kodundaki indirme
// şablonlarında da <title> vardır). Her etiket tam bir kez bulunmalıdır; bulunamazsa hata verir (sayfanın yapısı
// değişmiş demektir ve yanlış bir yere yazmaktansa durmak daha güvenlidir).
export function htmlGuncelle(html, z, veri, gorselAdresi) {
  const son = html.indexOf('</head>');
  if (son < 0) throw new Error('index.html: </head> bulunamadı');
  let out = html.slice(0, son);
  const degistir = (re, yeni) => {
    const n = (out.match(re) || []).length;
    if (n !== 1) throw new Error(`index.html: ${re} etiketi ${n} kez bulundu (1 bekleniyordu)`);
    out = out.replace(re, () => yeni);   // işlevle: metindeki "$" işaretleri özel anlam taşımasın
  };
  degistir(/<title>[^<]*<\/title>/g, `<title>${htmlKacis(z.baslik)}</title>`);
  degistir(/<meta name="description" content="[^"]*">/g, `<meta name="description" content="${htmlKacis(z.aciklama)}">`);
  degistir(/<meta name="theme-color" content="[^"]*">/g, `<meta name="theme-color" content="${z.tema_rengi}">`);
  degistir(/<meta property="og:title" content="[^"]*">/g, `<meta property="og:title" content="${htmlKacis(z.og_baslik)}">`);
  degistir(/<meta property="og:description" content="[^"]*">/g, `<meta property="og:description" content="${htmlKacis(z.og_aciklama)}">`);
  degistir(/<meta property="og:image" content="[^"]*">/g, `<meta property="og:image" content="${htmlKacis(gorselAdresi)}">`);
  degistir(/<meta property="og:image:alt" content="[^"]*">/g, `<meta property="og:image:alt" content="${htmlKacis(z.gorsel_alt)}">`);
  if (z.ikon) degistir(/<link rel="icon" href="[^"]*">/g, `<link rel="icon" href="${z.ikon}">`);
  degistir(/<script id="ilk-veri" type="application\/json">[^<]*<\/script>/g, `<script id="ilk-veri" type="application/json">${jsonGom({ icerik: veri })}</script>`);
  return out + html.slice(son);
}

/* ---------- Takvim dosyası (RFC 5545) ---------- */
const icsKacis = s => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, m => '\\' + m);
const icsZaman = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
// Satırlar en çok 75 bayttır; devam satırı bir boşlukla başlar. Çok baytlı (Türkçe) harfler ortadan bölünmez.
function katla(satir) {
  const enc = new TextEncoder(), parcalar = [];
  let cur = '', n = 0;
  for (const ch of satir) {
    const b = enc.encode(ch).length;
    if (n + b > (parcalar.length ? 74 : 75)) { parcalar.push(cur); cur = ''; n = 0; }
    cur += ch; n += b;
  }
  parcalar.push(cur);
  return parcalar.join('\r\n ');
}
const ac = ics => ics.replace(/\r\n[ \t]/g, '').split(/\r?\n/).filter(Boolean);   // katlanmış satırları birleştirir
// Etkinliğin içeriği (kimlik, zaman damgası ve sıra numarası hariç): yalnızca bu değiştiyse dosya yeniden yazılır
const icerikSatirlari = satirlar => satirlar.filter(s => /^(X-WR-CALNAME|DTSTART|DTEND|SUMMARY|LOCATION|URL|DESCRIPTION|TRIGGER|ACTION)[:;]/.test(s));

export function icsOlustur(z, onceki, simdi, siteAdresi) {
  const k = z.takvim, eski = ac(onceki || '');
  const uid = /^UID:(.+)$/.exec(eski.find(s => s.startsWith('UID:')) || '')?.[1] || 'elif-yunus-dugun@elif-yunus';
  const sira = Number(/^SEQUENCE:(\d+)$/.exec(eski.find(s => s.startsWith('SEQUENCE:')) || '')?.[1] || 0);
  const yap = (seq, stamp) => [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Elif ve Yunus//Dugun//TR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsKacis(k.baslik)}`, 'X-WR-TIMEZONE:Europe/Istanbul', 'REFRESH-INTERVAL;VALUE=DURATION:P1D', 'X-PUBLISHED-TTL:P1D',
    'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp}`, `SEQUENCE:${seq}`,
    `DTSTART:${icsZaman(k.baslangic)}`, `DTEND:${icsZaman(k.bitis)}`,
    `SUMMARY:${icsKacis(k.baslik)}`, `LOCATION:${icsKacis(k.konum)}`, `URL:${siteAdresi}`, `DESCRIPTION:${icsKacis(k.aciklama)}`,
    'BEGIN:VALARM', 'TRIGGER:-P1D', 'ACTION:DISPLAY', `DESCRIPTION:${icsKacis(k.hatirlatma_gun || k.baslik)}`, 'END:VALARM',
    'BEGIN:VALARM', 'TRIGGER:-PT3H', 'ACTION:DISPLAY', `DESCRIPTION:${icsKacis(k.hatirlatma_saat || k.baslik)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ];
  const yeni = yap(sira, '');
  if (JSON.stringify(icerikSatirlari(yeni)) === JSON.stringify(icerikSatirlari(eski))) return onceki;   // değişiklik yok
  // Takvim uygulamaları aynı kimlikli etkinliği daha büyük sıra numarasıyla görünce günceller
  return yap(sira + 1, icsZaman(simdi)).map(katla).join('\r\n') + '\r\n';
}

/* ---------- GitHub Actions'ta çalışan bölüm ---------- */
async function main() {
  const { readFile, writeFile, rm } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const html = await readFile('index.html', 'utf8');
  const url = /supabaseUrl: '(https:\/\/[a-z0-9-]+\.supabase\.co)'/.exec(html)?.[1];
  const key = /supabaseKey: '(sb_publishable_[\w-]+)'/.exec(html)?.[1];   // yalnızca herkese açık anahtar kabul edilir
  if (!url || !key) { console.log('index.html’de Supabase bilgisi yok (önizleme modu); eşitlenecek bir şey yok.'); return; }
  const site = /<meta property="og:url" content="(https:\/\/[^"]+)">/.exec(html)?.[1];
  if (!site) throw new Error('index.html’de og:url bulunamadı.');

  const res = await fetch(`${url}/rest/v1/icerik?select=veri&id=eq.1`, { headers: { apikey: key, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Supabase yanıtı: HTTP ${res.status}`);
  const veri = (await res.json())?.[0]?.veri;
  if (!veri || typeof veri !== 'object' || Array.isArray(veri)) { console.log('İçerik kaydı yok; dosyalar olduğu gibi kalır.'); return; }
  if (JSON.stringify(veri).length > 65536) throw new Error('İçerik kaydı beklenenden büyük; eşitleme yapılmadı.');
  const z = ozetiDogrula(veri.ozet);
  if (!z) { console.log('Yönetimden henüz geçerli bir paylaşım özeti kaydedilmemiş; dosyalar olduğu gibi kalır.'); return; }

  // Önizleme görseli: yönetimin hazırladığı görsel indirilir; adres sonundaki ?v= WhatsApp'ın yenisini almasını sağlar
  let gorselAdresi = new URL('paylasim.jpg', site).href;
  if (z.gorsel) {
    const r = await fetch(`${url}/storage/v1/object/public/site/${z.gorsel}`);
    if (!r.ok) throw new Error(`Önizleme görseli indirilemedi: HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 2000 || buf.length > 3e6 || buf[0] !== 0xFF || buf[1] !== 0xD8 || buf[2] !== 0xFF) throw new Error('Önizleme görseli geçerli bir JPEG değil.');
    await writeFile('paylasim-guncel.jpg', buf);
    gorselAdresi = `${new URL('paylasim-guncel.jpg', site).href}?v=${createHash('sha256').update(buf).digest('hex').slice(0, 12)}`;
  } else {
    await rm('paylasim-guncel.jpg', { force: true });
  }
  await writeFile('index.html', htmlGuncelle(html, z, veri, gorselAdresi));
  const ics = await readFile('dugun.ics', 'utf8').catch(() => '');
  await writeFile('dugun.ics', icsOlustur(z, ics, new Date(), site));
  console.log(`Özet okundu (${z.zaman.toISOString()}): ${z.baslik}`);
}
if (typeof process !== 'undefined' && /esitle\.mjs$/.test(process.argv?.[1] || '')) {
  main().catch(e => { console.error('Eşitleme yapılamadı:', e.message); process.exit(1); });
}
