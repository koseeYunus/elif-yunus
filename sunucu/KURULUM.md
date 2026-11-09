# Düğün sunucusu — Cloudflare kurulumu ve geçiş

Düğün sayfasının yeni arka yüzü: bir **Worker** (`sunucu/worker.js`), fotoğraflar için bir **R2** kovası, dilekler/ayarlar/metinler için bir **D1** veritabanı. Kına sunucusuyla **aynı Cloudflare hesabında**, ondan tamamen ayrı çalışır. Kurulum yaklaşık 15–20 dakika sürer.

Kınadan farkı: R2 zaten açık, veritabanı tabloları da Worker'ın ilk isteğinde kendiliğinden kurulur (**D1 Console'da SQL çalıştırmak gerekmez**).

---

## 1. R2 kovası

1. **Storage & databases → R2 object storage → Create bucket**.
2. **Bucket name:** `elif-yunus-dugun`
3. **Location:** *Provide a location hint* → **Eastern Europe (EEUR)**.
4. **Default storage class:** **Standard**.
5. **Create bucket**. Kovanın **Settings** sekmesinde **R2.dev subdomain** **Disabled**, **Custom Domains** boş kalmalı.

## 2. D1 veritabanı

1. **Storage & databases → D1 SQL database → Create database**.
2. **Name:** `elif-yunus-dugun`, location hint varsa **Eastern Europe** → **Create**.
3. Başka bir şey yapma; tablolar kendiliğinden kurulur.

## 3. Worker

1. **Compute (Workers) → Workers & Pages → Create application → Start with Hello World! → Get started**.
2. **Worker name:** `elif-yunus-dugun` → **Deploy**.
   Adı birebir böyle olmalı. Adres `https://elif-yunus-dugun.kose-yunus-55.workers.dev` olur ve sayfa bu adrese bağlanacak şekilde hazırlandı.
3. **Edit code**. Soldaki `worker.js` içeriğini tamamen sil, depodaki `sunucu/worker.js` dosyasının **tamamını** yapıştır → **Deploy**.

## 4. Bağlar (Bindings)

Worker → **Bindings** → **Add binding**:

1. **R2 bucket** → *Variable name*: `DEPO`, *R2 bucket*: `elif-yunus-dugun`.
2. **D1 database** → *Variable name*: `DB`, *D1 database*: `elif-yunus-dugun`.

Adlar birebir böyle olmalı (büyük harf). Kınanın kovasını ya da veritabanını seçmediğinden emin ol.

## 5. Gizli değişkenler (Secrets)

Worker → **Settings → Variables and Secrets → Add**. **Type: Secret** seçili olsun (değer gizlensin):

| Variable name | Value |
|---|---|
| `YONETICI_SIFRE` | Düğün yönetiminin yeni şifresi. **En az 12 karakter.** Kınadakinden farklı olsun. |
| `IMZA_ANAHTARI` | Yeni, uzun rastgele metin (kınadakini kullanma). |

`IMZA_ANAHTARI` üretmek için Windows PowerShell'de:

```powershell
$b = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
```

En sonda **Deploy**. Şifreyi ve anahtarı kimseyle (bana da) paylaşma, ekran görüntüsüne girmesin.

İsteğe bağlı düz değişken (Type **Text**): `ALAN_GB` → fotoğraf alanı üst sınırı, varsayılan `9.5`. Not: R2'nin ücretsiz 10 GB'ı hesap başınadır, yani kına ve düğün bu alanı paylaşır. Aşan kısmın ücreti GB başına ayda yaklaşık 0,015 $'dır (10 GB fazlası ≈ 0,15 $/ay).

## 6. Deneme

Tarayıcıda `https://elif-yunus-dugun.kose-yunus-55.workers.dev/durum` aç. Şunu görmelisin:

```json
{"calisiyor":true,"veritabani":true,"depo":true,"yonetim":"hazır", …}
```

`"yonetim":"eksik…"` görürsen 5. adımı, `"Sunucu kurulumu tamamlanmamış."` görürsen 4. adımı denetle.

## 7. Verileri aktar ve telefonla dene

Misafirler bu sırada eski sistemi (Supabase) kullanmaya devam eder; hiçbir şey değişmez.

1. **Aktarım:** <https://koseeyunus.github.io/elif-yunus/sunucu/tasi.html> sayfasını aç. 5. adımdaki şifreyi yaz → **Aktar**. Dilekler, ayarlar, sayfa metinleri, kapak/müzik ve WhatsApp görseli kopyalanır. Supabase'te hiçbir şey silinmez.
2. **Telefonla deneme:** <https://koseeyunus.github.io/elif-yunus/?sunucu=cloudflare> adresini aç. Sayfa yeni sunucuyla çalışır; yalnızca bu adresle açan kişi yeni sunucuyu görür.
   - Bir deneme dileği yaz.
   - Fotoğraf denemek için: aynı adresin sonuna `#yonetim` ekle (`…/?sunucu=cloudflare#yonetim`) → yalnızca şifreyle gir → **Ayarlar → Fotoğraf paylaşımı**'nda açılış zamanını sil → **Kaydet**. Sonra iPhone ve Android'den birer fotoğraf yükle.
   - Deneme dileğini ve fotoğrafları yönetimden sil. Ayarlar bir sonraki aktarımda Supabase'teki hâline döner.

## 8. Geçiş günü (en geç 12 Kasım akşamı)

1. **Son aktarım:** `tasi.html` → **Aktar** (ayarlar işaretli).
2. **Sayfayı yeni sunucuya çevir:** bunu ben yapacağım (`index.html` → `sunucu: 'cloudflare'`). Commit'i GitHub Desktop'tan **Push origin** ile yayınla.
3. **Eski sistemde paylaşımı kapat:** <https://koseeyunus.github.io/elif-yunus/?sunucu=supabase#yonetim> → eski e-posta ve şifrenle gir → **Ayarlar** → fotoğraf paylaşımını ve dilek yazmayı **kapat** → **Kaydet**. Böylece sayfayı eski hâliyle açık tutan telefonlar artık eski sisteme yazamaz.
4. **30 dakika sonra:** `tasi.html` → **"Ayarlar ve sayfa metinleri de aktarılsın" işaretini kaldır** → **Aktar**. Bu arada eski sisteme yazılmış geç dilekler de gelir.
5. **WhatsApp önizlemesi:** yeni yönetimde (`#yonetim`) **İçerik → Metinleri Kaydet**.

**Geri dönüş (sorun çıkarsa):** 2. adımdaki commit geri alınır (`sunucu: 'supabase'`). 2–3 dakikada eski sisteme dönülür; Supabase'te hiçbir şey silinmediği için veriler yerindedir. Eski sistemin paylaşımı da 3. adımdaki gibi yeniden açılır.

## 9. Bilmekte yarar var

- **Günlük istek sınırı:** Workers ücretsiz planı hesap başına günde 100.000 istek verir (kına ve düğün ortak; Türkiye saatiyle 03.00'te sıfırlanır). Sayfa istekleri birleştirir ve dakikada bir yoklar; düğün gecesi için tahmin 30–50 bin istek. Tam güvence için Kasım ayına **Workers Paid** (ayda 5 $, günlük sınır yok) alınabilir: **Workers & Pages → Plans**.
- **Harcama uyarısı:** Kurulmadıysa **Manage account → Billing → Billable usage → Budget alerts** altından 1 $ eşiğiyle bir uyarı ekle.
- **Yönetim:** Giriş yalnızca şifreyle, 30 gün geçerli. Tüm oturumları kapatmak için `IMZA_ANAHTARI`'nı değiştir. Bir IP'den 15 dakikada 8 hatalı denemede giriş 15 dakika kilitlenir.
- **Sınırlar:** Fotoğraf başına 3 MB (sayfa fotoğrafları ~0,4 MB'a küçültür), telefon başına fotoğraf ve dilek sınırları yönetimdeki Ayarlar'dan.
- **Arşiv:** Düğünden sonra **#yonetim → Arşiv** sekmesinden her şeyi indir (eskisiyle aynı).
