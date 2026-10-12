# SEO Audit

Sürüm: `package.json` dosyasındaki `version` alanı. Değişiklikler: `CLAUDE.md` → Karar günlüğü.

Teknik SEO denetim aracı. Kişisel proje. Bir siteyi tarar. Sonuçları web arayüzünde, JSON'da ve Excel'de gösterir.

Tanıtım sayfası: `docs/index.html`. Yayın: GitHub Pages (Settings → Pages → Deploy from a branch → main, /docs) veya Netlify (yayın klasörü `docs`, build komutu yok).

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

Tarayıcıda `http://localhost:3300` adresini açın. Giriş ekranında iki seçenek var: "Site denetimi" (tek site) ve "Taşıma projesi" (site yenileme).

Arayüz koyu temadır. Yazı tipi Google Fonts'tan (Archivo) gelir. İnternet yoksa sistem yazı tipi kullanılır.

- "Site denetimi" seçili iken adresi yazın. "Taramayı başlat" butonuna basın.
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

## Taşıma projesi (v0.7.0)

Site yenilemede "Taşıma projesi" seçin. Proje adını yazın. Araç beş adımda yol gösterir. Her ekranda tek bir "Sıradaki iş" kartı durur: tek cümle ve tek düğme.

| Adım | Ne yapılır |
|---|---|
| Proje | "Yeni yapı nasıl?" sorusunu cevaplayın. Siteleri yazın: eski site (canlı), eski alan adına geçecek site (staging olabilir), ek siteler (örnek: Türkçe sitesi ayrı alan adında). |
| Tarama | Her site için "Tara" düğmesi. Var olan bir taramayı da bağlayabilirsiniz. Staging şifresini tarama ayarlarına yazın. Araç şifreyi saklamaz. |
| Eşleştirme | Eski sitenin her bölümü (`/tr/`, `/fr/`…) bir satırdır. Araç yeni yeri önerir ve seçili getirir. Bulamadığı bölüm "Bulunamadı" der; satırı açın ve sayfaları görün. Serbest kural "Gelişmiş" altındadır. |
| 301 haritası (v0.8.0) | Adresi değişen her sayfa için araç yeni sayfa önerir: slug, title, H1 ve içerik benzerliği. Güven: Yüksek / Orta / Düşük. Öneriyi onaylayın, başka sayfa seçin, adres yazın veya 410 verin. "CSV indir" son listeyi verir (eski URL, yeni URL, 301/410). Kararlar projede saklanır. v0.8.1: araç sayfanın dilini (html lang) kullanır. Türkçe sayfaya Türkçe sayfa önerir. Eski ana sayfaya doğru sitenin ana sayfasını önerir. Excel her satırda kararın kaynağını ve aracın önerisini gösterir. |
| Yapılacaklar (v0.9.0) | İşler yapıldığı yere göre kartlara ayrılır: eski alan adı sunucusu (301, yönlendirme düzeltmesi, 410), her yeni site (sayfa oluşturun, link verin), İçerik (title, meta, H1, noindex) ve Karar bekleyen. Her kart ekibi gösterir ve listeyi açar. Yeni sitede çok az sayfa varsa araç "hazır değil gibi görünüyor" der ve o sitenin işlerini saymaz. Site gerçekten küçükse uyarıyı kapatın. Her terimin yanında "?" açıklaması var. Excel'in "Yapılacaklar" sayfası her işi yeri ve ekibi ile verir. v0.9.1: listede "Canlı adres" (canlıya çıkıştan sonraki adres, 301 hedefi) ve "Kontrol edilen adres" (staging) ayrı sütunlardır. Eski gruplar "Bütün sayfalar" altında. |

**Eski alan adına geçecek site:** Canlıdan sonra eski alan adını bu site kullanır. Bütün 301'ler bu sitede kurulur. Kurala girmeyen yol bu sitede aynı yolda aranır.

Başka yola veya başka siteye taşınan sayfa için araç iki şeyi kontrol eder:

1. Hedef sayfa var mı (hedef sitenin taramasında veya tek istek ile).
2. Eski yol, eski alan adına geçecek sitede hedefe 301 veriyor mu. 301 hedefi staging alan adı, ek sitenin "canlı alan adı" veya eski alan adı olabilir.

| Grup | Anlamı |
|---|---|
| Aynı kaldı | Aynı yolda açılıyor. Title, meta description ve H1 aynı. |
| İçerik değişti | Aynı yolda açılıyor ama title, meta veya H1 farklı. Boşaldıysa veya noindex eklendiyse "kayıp" olarak işaretlenir. |
| Hedef hazır, 301 kurulu | Taşınan sayfanın hedefi var. Eski adres hedefe 301 veriyor. Zincir veya 302 varsa satırda yapılacak iş yazılır. |
| Hedef hazır, 301 eksik | Hedef var. Eski adres yönlenmiyor veya başka sayfaya gidiyor. |
| Hedef yok | Taşınan sayfanın hedefi yeni sitede yok. |
| Yönleniyor | Aynı yol yeni sitede başka bir adrese yönleniyor. Hedef 4xx/5xx ise "hedef hatalı". |
| Açılıyor, link yok | Adres açılıyor ama yeni sitede bu sayfaya hiç link yok. |
| Kayboldu | Yeni sitede 404 veya başka bir hata. 301 gerekir. |
| Bölüm kaldırıldı | "Bölüm kaldırıldı" kararı verilen bölümün sayfası. 301 veya 410 yine gerekir. |
| Kontrol edilemedi | robots.txt engeli, şifreli staging (401) veya bağlantı hatası. |

Yeni tarama eski adresleri bulamaz, çünkü yeni sitede onlara link yoktur. Bu yüzden araç gereken her adresi tek tek ister. İlk eşleştirme birkaç saniye sürebilir. Araç sadece projede taranan sitelere istek gönderir.

Proje sunucuda `crawls/projects/` klasöründe durur. Projede sonuç yok, sadece tanım var: siteler, roller, tarama kimlikleri, kurallar. Ücretsiz Render planında disk kalıcı değildir: "Projeyi indir" ile JSON dosyasını alın, "Proje yükle" ile geri yükleyin.

v0.6.1'de tarayıcıda saklanan yol kuralları Eşleştirme adımında "Projeye aktar" ile projeye geçer.

## Yayın (Render, ücretsiz plan)

Render kodu GitHub deposundan alır. Her commit sonrası yeni sürümü kendisi yayınlar. Ayarlar depodaki `render.yaml` dosyasındadır.

1. render.com adresinde GitHub hesabınızla giriş yapın.
2. New → Blueprint seçin. `seo-audit` deposunu seçin.
3. Şifre isteğe bağlıdır. Şifresiz yayında herkes projeleri görür, indirir ve siler: Render'da müşteri sitesi taramayın. Şifre isterseniz Render → Environment bölümüne `APP_USER` ve en az 10 karakterli `APP_PASS` ekleyin.
4. Apply düğmesine basın. Birkaç dakika sonra adres hazır olur: `https://seo-audit-xxxx.onrender.com`.

Yayın modu (`PUBLIC_MODE=1`) şunları yapar:

- İç ağ adreslerini taramaz: `localhost`, `10.x`, `172.16-31.x`, `192.168.x`, `169.254.x` (bulut ayar servisi) ve IPv6 iç adresleri. Buna SSRF koruması denir. Yönlendirmenin her adımı da kontrol edilir.
- Giriş şifresi isteğe bağlıdır (v0.8.4). Şifre yoksa sunucu açılışta uyarı yazar. `/healthz` adresi her zaman şifresizdir ve sadece "ok" döner.
- Limitler: bir taramada en fazla 2.000 URL, aynı anda 1 tarama. Değerler `config/rules.json` → `yayin` bölümündedir.

Ücretsiz planın sınırları:

- 15 dakika istek gelmezse sunucu uyur. İlk istek birkaç saniye bekler.
- Sunucu uyuyunca veya yeniden başlayınca taramalar silinir. Tarama bitince Excel'i hemen indirin. Arayüz bunu bir uyarı ile gösterir.

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

`npm test` beş test çalıştırır:

1. Crawler testi (19 kontrol).
2. Kural testi (99 kontrol): `test/fixture-rules.js` her kuralı bilerek bozan sayfalardan oluşur. SSL ve HSTS kuralları `test/fixture-https.js` (self-signed sertifika, 2046'ya kadar geçerli) ile test edilir. Testler internete çıkmaz: dış linkler `.invalid` alan adı kullanır. Her kural doğru sayfada tetiklenmeli. `/temiz` sayfasında hiç sorun çıkmamalı (yanlış alarm kontrolü).

3. Yayın modu testi (12 kontrol): iç ağ adresleri, tarayıcının iç adrese hiç istek göndermemesi, şifre zorunluluğu, `/healthz` ve limitler.
4. Karşılaştırma testi (48 kontrol): yol eşleşmesi, kaybolan, yönlenen, içerik kaybı, yeni hostta istek, yol kuralları, çoklu hedef, bölüm kaldırıldı, desen önerisi, taşınan sayfanın 301 kontrolü, Excel.
5. Proje testi (13 kontrol): proje tanımı, kayıt, API, "Tara" düğmesi, gerçek test siteleri ile eşleştirme ve 301 kontrolü (`test/fixture-migration.js`), proje dosyası indir/yükle.

Yeni kural eklerseniz test sitesine onu tetikleyen bir sayfa da ekleyin.

## Sınırlar (bilinçli)

- JavaScript ile oluşan içerik görünmez. SPA siteler için render modu sonraki fazlarda gelir.
- `srcset` ve CSS arka plan görselleri kontrol edilmez. Sadece `<img src>` kontrol edilir.
- SSRF koruması adresi istekten önce DNS ile kontrol eder. DNS cevabı istek anında değişirse (DNS rebinding) koruma bunu yakalamaz. Şifre zorunluluğu bu riski azaltır.

## Yol haritası

1. **Faz 1 — Crawl + web arayüzü** ✅
2. **Sprint 1 — Kural motoru (77 kural), Sorunlar sekmesi, sağlık skoru, başlık ağacı** ✅
3. **Sprint 2 — Ek kontroller: dış link, görsel, site sürümleri, HSTS, SSL, sıkıştırma, llms.txt (11 kural)** ✅
4. **v0.5 — Yayın hazırlığı: Render, SSRF koruması, yayın modu** ✅
5. Sprint 3 — Migration: **Parça 1 karşılaştırma ✅ (v0.6.1: yol kuralları, çoklu hedef, desen önerisi)**, **v0.7.0 taşıma projesi ✅ (proje, tarama, eşleştirme, 301 kontrolü)**, **v0.7.1 eşleştirme düzeltmesi ✅**, **v0.8.0 Parça 2 301 haritası ✅**, **v0.8.1 dil kontrolü ve gerçek site düzeltmeleri ✅**, **v0.9.0 yapılacaklar listesi (işin yapıldığı yere göre) ✅**, Parça 3 canlıya çıkış kontrolü, Parça 4 canlıda 301 doğrulama.
5. Sprint 4 — AI: title/description, alt text, başlık önerisi, schema, yazım, 301 eşleştirme
6. Sprint 5 — Entegrasyon: PageSpeed (CWV), Search Console, ClickUp
7. Sprint 6 — JS render (Playwright)
