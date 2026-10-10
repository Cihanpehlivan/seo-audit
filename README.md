# SEO Audit — v0.4.3

Teknik SEO denetim aracı. Kişisel proje. Bir siteyi tarar. Sonuçları web arayüzünde, JSON'da ve Excel'de gösterir.

## Kurulum

Node.js 20 veya üstü gerekli.

```bash
npm install
npm test          # crawler testi ve kural testi
```

## Web arayüzü

```bash
npm start
```

Tarayıcıda `http://localhost:3300` adresini açın. Giriş ekranı açılır: adres alanı, site etiketi, gelişmiş ayarlar, yenileme akışı ve denetlenen alanlar.

Arayüz koyu temadır. Yazı tipi Google Fonts'tan (Archivo) gelir. İnternet yoksa sistem yazı tipi kullanılır.

- Adresi yazın. Etiketi seçin (tek site / eski / yeni). "Taramayı başlat" butonuna basın.
- Tarama sırasında her URL bir hücre olarak görünür. Gri: 200. Turuncu: redirect. Kırmızı: 4xx/5xx. Boş kırmızı çerçeve: bağlantı hatası. Boş gri çerçeve: robots engeli.
- Tarama bitince "Sorunlar" sekmesi açılır. Sağlık skoru, önem (kritik / uyarı / bilgi) ve ekip (Frontend / Backend / İçerik / SEO) filtreleri vardır. Soruna tıklayın: açıklama, çözüm ve etkilenen URL'ler görünür.
- Sorunlar sekmesindeki site kartı ek kontrollerin sonucunu gösterir: site sürümleri, SSL, HSTS, llms.txt, sıkıştırma, dış linkler, görseller. Renkli kutuya tıklayın, ilgili sorun açılır.
- "Sayfalar" sekmesinde tablo açılır. Filtre butonları ile sorunlu URL'leri seçin. Satıra tıklayın, detaylar açılır.
- Hücreye tıklayın, tablo o URL'ye gider.
- "Excel indir" ile raporu alın.

### Sunucuda çalıştırma

Varsayılan olarak sadece bu bilgisayardan erişilir. Ekibin erişmesi için:

```bash
HOST=0.0.0.0 PORT=3300 APP_USER=admin APP_PASS=guclu-bir-sifre npm start
```

veya Docker ile:

```bash
docker build -t seo-audit .
docker run -d -p 3300:3300 -v $(pwd)/crawls:/app/crawls -e APP_USER=admin -e APP_PASS=guclu-bir-sifre seo-audit
```

Ortam değişkenleri:

| Değişken | Açıklama | Varsayılan |
|---|---|---|
| `PORT` | Port | 3300 |
| `HOST` | Dinlenen adres | 127.0.0.1 |
| `APP_USER`, `APP_PASS` | Arayüz şifresi. Ağa açarsanız mutlaka tanımlayın. | — |
| `MAX_JOBS` | Aynı anda çalışan tarama sayısı | 2 |
| `CRAWL_DIR` | Kayıt klasörü | ./crawls |

Not: Bu tool sunucu tarafında tarama yapar. Tarayıcı içinde tek başına çalışamaz, çünkü tarayıcılar başka sitelerin içeriğini okumayı engeller (CORS).

## Komut satırı (CLI)

```bash
node bin/crawl.js https://www.ornek.com
```

Yenileme projesinde iki tarama yapın. Etiket kullanın:

```bash
# 1. Eski site (canlı)
node bin/crawl.js https://www.ornek.com --label eski

# 2. Yeni site (staging, şifreli ve robots kapalı)
node bin/crawl.js https://staging.ornek.com --label yeni --auth kullanici:sifre --ignore-robots
```

Çıktılar `crawls/` klasörüne gider:

- `<host>_<etiket>_<tarih>.json` — ham veri. Faz 3 (fark analizi) bu dosyayı kullanır. Silmeyin.
- `<host>_<etiket>_<tarih>.xlsx` — Excel rapor.

## Seçenekler

| Seçenek | Açıklama | Varsayılan |
|---|---|---|
| `--max` | En fazla URL | 5000 |
| `--depth` | En fazla link derinliği | 50 |
| `-c` | Paralel istek | 5 |
| `--delay` | İstekler arası bekleme (ms) | 0 |
| `--timeout` | İstek zaman aşımı (ms) | 15000 |
| `--auth` | Basic auth `user:pass` | — |
| `--ignore-robots` | robots.txt kurallarını yok say | kapalı |
| `--no-sitemap` | Sitemap okuma | açık |
| `--no-checks` | Ek kontrolleri çalıştırma | açık |
| `--no-external` | Dış linkleri kontrol etme | açık |
| `--no-images` | Görselleri kontrol etme | açık |
| `--label` | Dosya adı etiketi | — |

Müşteri sunucusu yavaş ise `-c 2 --delay 500` kullanın.

## Toplanan veri

Her URL için: status, redirect zinciri (her hop), son hedef, title, meta description, H1 listesi, H2 sayısı, canonical, meta robots, X-Robots-Tag, html lang, hreflang, kelime sayısı, görsel ve alt eksikleri, iç/dış linkler, inlink sayısı, derinlik, yanıt süresi, boyut, sitemap durumu, yetim sayfa durumu.

## Davranış

- `www` ve `www` olmayan host aynı site sayılır.
- `utm_*`, `gclid`, `fbclid` parametreleri silinir. `#` parçaları silinir.
- Görsel, PDF, CSS, JS gibi dosyalar taranmaz.
- Dış linkler kaydedilir ama taranmaz.
- Redirect döngüsü ve 10 hop üstü zincir hata olarak işaretlenir.
- Sitemap'teki ama linklerle bulunamayan sayfalar "yetim" olarak işaretlenir.
- windows-1254 / iso-8859-9 kodlu eski Türkçe siteler doğru okunur.

## Ek kontroller (Sprint 2)

Tarama bittikten sonra çalışır. Arayüzde "Gelişmiş ayarlar" altından, CLI'da `--no-checks` ile kapatılır.

- **Site ayarları:** http/https ve www/www olmayan sürümler ana adrese 301 ile gidiyor mu? SSL sertifikası geçerli mi, kaç gün kaldı? HSTS başlığı var mı? `/llms.txt` var mı?
- **Dış linkler:** her dış link bir kez HEAD ile kontrol edilir. HEAD reddedilirse 1 baytlık GET ile tekrar denenir.
- **Görseller:** kırık görsel ve büyük dosya (varsayılan 200 KB üstü).
- **Sıkıştırma:** ek istek gerekmez. Taramada her sayfanın `content-encoding` başlığı okunur.

Kurallar:

- 401, 403, 429, 999 kodları ve zaman aşımı "kırık" sayılmaz. Bunlar genelde bot korumasıdır.
- DNS'i olmayan bir alan adı bir kez sorgulanır.
- Staging şifresi (`--auth`) sadece taranan siteye gönderilir. Dış sitelere gönderilmez.
- Limitler `config/rules.json` → `checks` bölümündedir: paralel istek 8, zaman aşımı 8 sn, en fazla 1.000 dış link ve 2.000 görsel.

Excel'de iki yeni sayfa vardır: "Site sürümleri" ve "Dış kaynaklar".

## Denetim kuralları

88 kural, 15 kategori: tarama ve indeks, redirect, canonical, title, meta description, başlık hiyerarşisi, içerik (kopya, benzer, dummy metin), linkler (kırık, staging linki), görseller, hreflang, yapısal veri, performans, HTTPS, mobil/erişilebilirlik, URL yapısı.

Kural tanımları: `src/rules/definitions.js`. Her kuralın açıklaması, çözümü, önemi ve sorumlu ekibi vardır.

### Eşikleri ayarlama

Bütün eşikler `config/rules.json` dosyasındadır. Kod değiştirmeyin. Örnekler:

- Az içerik sınırı: `"thinContentWords": 250`
- Title uzunluğu: `"titleMaxPx": 580`
- Benzer içerik hassasiyeti: `"nearDuplicateDistance": 5` (küçük sayı = daha katı)
- Büyük görsel sınırı: `"largeImageKb": 200`
- SSL uyarı süresi: `"sslExpiryDays": 30`
- Kırık sayılmayan kodlar: `"brokenIgnoreStatuses": [401, 403, 429, 999]`
- Bir kuralı kapatma: `"rules": { "title-equals-h1": { "enabled": false } }`
- Önem değiştirme: `"rules": { "canonical-missing": { "severity": "notice" } }`

Dosyayı değiştirince sunucuyu yeniden başlatmanız gerekmez. Eski taramalar açılırken yeni ayarlarla tekrar denetlenir.

### Sağlık skoru

Skor = kritik sorunu olmayan URL oranı (robots ile engelli URL'ler hariç). Site geneli kritik sorun varsa (örnek: robots.txt siteyi kapatıyor) skor en fazla 40 olur.

## Testler

`npm test` iki test çalıştırır:

1. Crawler testi (19 kontrol).
2. Kural testi (99 kontrol): `test/fixture-rules.js` her kuralı bilerek bozan sayfalardan oluşur. SSL ve HSTS kuralları `test/fixture-https.js` (self-signed sertifika, 2046'ya kadar geçerli) ile test edilir. Testler internete çıkmaz: dış linkler `.invalid` alan adı kullanır. Her kural doğru sayfada tetiklenmeli. `/temiz` sayfasında hiç sorun çıkmamalı (yanlış alarm kontrolü).

Yeni kural eklerseniz test sitesine onu tetikleyen bir sayfa da ekleyin.

## Sınırlar (bilinçli)

- JavaScript ile oluşan içerik görünmez. SPA siteler için render modu sonraki fazlarda gelir.
- `srcset` ve CSS arka plan görselleri kontrol edilmez. Sadece `<img src>` kontrol edilir.

## Yol haritası

1. **Faz 1 — Crawl + web arayüzü** ✅
2. **Sprint 1 — Kural motoru (77 kural), Sorunlar sekmesi, sağlık skoru, başlık ağacı** ✅
3. **Sprint 2 — Ek kontroller: dış link, görsel, site sürümleri, HSTS, SSL, sıkıştırma, llms.txt (11 kural)** ✅
4. Sprint 3 — Migration: eski/yeni karşılaştırma, 301 haritası, launch kontrolü
5. Sprint 4 — AI: title/description, alt text, başlık önerisi, schema, yazım, 301 eşleştirme
6. Sprint 5 — Entegrasyon: PageSpeed (CWV), Search Console, ClickUp
7. Sprint 6 — JS render (Playwright)
