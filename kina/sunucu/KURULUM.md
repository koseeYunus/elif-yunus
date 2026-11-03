# Kına sunucusu — Cloudflare kurulumu

Kına sayfasının arka yüzü: bir **Worker** (`worker.js`), dosyalar için bir **R2** kovası, dilekler/kayıtlar/ayarlar için bir **D1** veritabanı. Hepsi ücretsiz kotada kalır. Kurulum aşağı yukarı 20–30 dakika sürer, her şey tarayıcıdan yapılır.

> Cloudflare paneli sık güncelleniyor. Menü adları burada yazandan biraz farklı olabilir; parantez içinde olası diğer adları da verdim.

---

## 1. Hesap

1. <https://dash.cloudflare.com/sign-up> adresinden ücretsiz hesap aç, e-postanı doğrula.
2. Önerilir: **My Profile → Authentication** altından iki adımlı doğrulamayı (2FA) aç.

## 2. R2'yi etkinleştir ve harcama uyarısı kur

1. Sol menüde **Storage & databases → R2 object storage → Overview** (ya da yalnızca **R2**).
2. **Purchase R2 / Add R2 subscription** adımını tamamla. Kart ya da PayPal istenebilir. Ücretsiz kota: aylık **10 GB depolama**, 1 milyon yazma (Class A), 10 milyon okuma (Class B); dışarı veri aktarımı ücretsiz. Worker 9,5 GB'ta yeni yüklemeyi durdurur, yani kotayı aşmazsın.
3. Harcama uyarısı (önerilir): **Manage account → Billing → Billable usage → Budget alerts** (ya da **Notifications → Add → Budget alert**). Eşiği **1 $** yap. Bu uyarı yalnızca e-posta gönderir, harcamayı durdurmaz.

## 3. R2 kovası

1. R2 sayfasında **Create bucket**.
2. **Bucket name:** `elif-yunus-kina`
3. **Location:** *Provide a location hint* → **Eastern Europe (EEUR)** (Türkiye'ye en yakını), yoksa **Western Europe (WEUR)**. Jurisdiction varsayılan kalsın.
4. **Default storage class:** **Standard**. *Infrequent Access* seçme, ücretsiz kotaya girmez.
5. **Create bucket**.
6. Kovanın **Settings** sekmesinde şunları denetle:
   - **Public access → R2.dev subdomain** (Public Development URL): **Disabled** kalmalı.
   - **Custom Domains**: boş kalmalı. Dosyalar yalnızca Worker üzerinden, yetkiyle açılır.
   - **Object lifecycle rules**: "Abort incomplete multipart uploads" (7 gün) kuralı varsayılan olarak gelir. Yoksa ekle: *Add rule → Abort incomplete multipart uploads → 7 days*.

## 4. D1 veritabanı ve şema

1. **Storage & databases → D1 SQL database → Create database** (ya da *Create*).
2. **Name:** `elif-yunus-kina`. Location hint varsa **Eastern Europe** seç. **Create**.
3. Veritabanını aç, **Console** sekmesine geç.
4. `kina/sunucu/sema.sql` dosyasının **tamamını** kopyala, Console'a yapıştır, **Execute**.
   - Dosyada yorum satırı yoktur. Tüm ifadeler `IF NOT EXISTS` / `OR IGNORE` ile yazıldığı için tekrar çalıştırmak güvenlidir.
   - Console toplu çalıştırmada hata verirse ifadeleri `;` ile biten parçalar hâlinde sırayla çalıştır.
5. **Tables** sekmesinde şu tablolar görünmeli: `ayarlar`, `dilekler`, `dosyalar`, `sayac`, `silinenler`, `girisler`.

## 5. Worker

1. **Compute (Workers) → Workers & Pages → Create application** (ya da *Create*).
2. **Start with Hello World!** → **Get started**.
3. **Worker name:** `elif-yunus-kina` → **Deploy**.
4. **Edit code** (sağ üstte `</>` simgesi). Soldaki `worker.js` dosyasının içeriğini tamamen sil, depodaki `kina/sunucu/worker.js` dosyasının **tamamını** yapıştır → **Deploy** (ya da *Save and deploy*).
5. Worker'ın adresi şuna benzer: `https://elif-yunus-kina.<hesap-adın>.workers.dev`. Worker sayfasının üst kısmında ya da **Settings → Domains & Routes** altında görünür.

## 6. Bağlar (Bindings)

Worker sayfasında **Bindings** sekmesi (bazı görünümlerde **Settings → Bindings**):

1. **Add binding → R2 bucket** → *Variable name*: `DEPO`, *R2 bucket*: `elif-yunus-kina` → **Add binding**.
2. **Add binding → D1 database** → *Variable name*: `DB`, *D1 database*: `elif-yunus-kina` → **Add binding**.

Adlar birebir böyle olmalı (büyük harf).

## 7. Gizli değişkenler (Secrets)

Worker → **Settings → Variables and Secrets → Add**:

| Type | Variable name | Value |
|---|---|---|
| **Secret** | `YONETICI_SIFRE` | Yönetim sayfasının şifresi. **En az 12 karakter** olmalı; daha kısasını Worker kabul etmez. |
| **Secret** | `IMZA_ANAHTARI` | Uzun rastgele metin (aşağıdaki komutla üret). |

`IMZA_ANAHTARI` üretmek için Windows PowerShell'de:

```powershell
$b = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
```

Çıkan metni kopyala, değer olarak yapıştır, en sonda **Deploy**.

İsteğe bağlı düz değişkenler (Type **Text**):
- `KOKENLER`: Sayfanın açılabileceği adresler, virgülle ayrılır. Varsayılanı `https://koseeyunus.github.io` olduğu için normalde gerekmez.
- `ALAN_GB`: Depolama üst sınırı (varsayılan `9.5`).

Notlar:
- Yönetici girişi 30 gün geçerlidir. Tüm oturumları hemen kapatmak için `IMZA_ANAHTARI`'nı değiştir.
- Bir IP'den 15 dakikada 8 hatalı şifre denenirse giriş 15 dakika kilitlenir.

## 8. Deneme

Tarayıcıda `https://elif-yunus-kina.<hesap-adın>.workers.dev/durum` adresini aç. Şuna benzer bir JSON görmelisin:

```json
{"simdi":"2026-11-…Z","ayar":{"dosya_acik":1,…},"acik":{"dosya":false,"dilek":true},"alan_dolu":false}
```

(`dosya: false` normal: fotoğraf yüklemesi 13 Kasım 00.00'da açılır.)

`"Sunucu kurulumu tamamlanmamış."` görürsen şunlardan biri eksiktir: bağlar (6. adım), şema (4. adım), secret'lar ya da şifrenin 12 karakter kuralı (7. adım). Ayrıntıyı Worker → **Logs** (*Observability*) sekmesinde görebilirsin.

**Son adım:** Worker adresini (`https://…workers.dev`) bana ilet; sayfaya ben bağlayacağım.

## 9. Bilmekte yarar var (ücretsiz plan)

- Workers: günde 100.000 istek, istek başına 10 ms CPU. Dosyalar belleğe alınmadan doğrudan R2'ye aktığı için bu sınır yüklemeleri etkilemez.
- D1: günlük okuma/yazma kotası var. Sayfa dilekleri sık sık yenilemesin (dakikada bir yeter).
- Fotoğraf sınırı 40 MB, video sınırı 100 MB, telefon başına 300 dosya ve 3 dilek. Hepsi yönetim sayfasından değiştirilebilir.

## 10. Toplu indirme

En kolayı: kına sayfasında **#yonetim → Arşiv → Hepsini İndir**. Bilgisayarda Chrome ya da Edge ile seçtiğin klasöre fotoğraflar, videolar, dilekler ve “Anı Defteri” sayfası iner (tekrar indirince yalnızca yeniler iner).

İsteğe bağlı yedek yol, rclone ile doğrudan R2'den:

1. **R2 → Overview → Manage R2 API Tokens** (ya da *API Tokens*) → **Create API token** (*Account API token*).
   - **Permissions:** *Object Read only*
   - **Specify bucket(s):** yalnızca `elif-yunus-kina`
   - **TTL:** birkaç gün yeterli
2. Oluşunca **Access Key ID**, **Secret Access Key** ve **S3 endpoint** (`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`) gösterilir. Secret yalnızca bir kez gösterilir, bir yere not et.
3. <https://rclone.org/downloads/> adresinden Windows zip'ini indir, aç (kurulum gerekmez). O klasörde PowerShell aç:

   ```powershell
   .\rclone.exe config create kina s3 provider=Cloudflare access_key_id=ANAHTAR_ID secret_access_key=GIZLI_ANAHTAR endpoint=https://ACCOUNT_ID.r2.cloudflarestorage.com region=auto acl=private no_check_bucket=true
   .\rclone.exe size kina:elif-yunus-kina/asil
   .\rclone.exe copy kina:elif-yunus-kina/asil "D:\Kina\asil" --progress --transfers 8
   .\rclone.exe check kina:elif-yunus-kina/asil "D:\Kina\asil" --one-way
   ```

   - `asil/` asıl dosyaları, `kucuk/` küçük önizlemeleri içerir. Yalnızca `asil/` yeterli.
   - Dosya adları kimlik numarasıdır (`asil/<kimlik>.jpg`). Özgün adı ve yükleyenin adı D1'deki `dosyalar` tablosunda durur (`id`, `ad`, `isim`, `zaman`). Fotoğrafların çekim tarihi (EXIF) dosyanın içinde korunur; galeri uygulamaları doğru sıralar.

## 11. Kına bittikten sonra temizlik

Yüklemeler 15 Kasım 18.00'de kendiliğinden kapanır. 1 Ocak 2027'den sonra da hiçbir misafir yazması kabul edilmez. Her şeyi indirip yedekleri denetledikten sonra:

1. **Dilekleri ve dosya listesini yedekle:** D1 → Console → `SELECT id, zaman, isim, mesaj FROM dilekler ORDER BY id;` ve `SELECT id, zaman, tur, ad, isim, dilek_id FROM dosyalar ORDER BY no;` (sonuçları kopyala).
2. **R2 kovası:** Kovayı silmeden önce boşaltmak gerekir. Panelde kova → **Settings → Delete bucket**; panel boşaltmayı önermezse önce bir *Object lifecycle rule* ile "Delete objects after 1 day" kuralı ekle, ertesi gün kovayı sil. Alternatif: `.\rclone.exe purge kina:elif-yunus-kina` (yazma yetkili bir token gerekir).
3. **D1:** veritabanı → **Settings → Delete**.
4. **Worker:** Worker → **Settings → Delete**.
5. **R2 API token'ı** sil (10. adımda oluşturduğun).
6. İstersen **Billing → Subscriptions** altından R2 aboneliğini iptal et. Ücretsiz kotanın altında kaldığın sürece ücret çıkmaz.
