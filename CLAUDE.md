# SEO Audit — Proje bağlamı

Bu dosya projenin hafızasıdır. Her sohbete ve her geliştirme oturumuna bu dosyayı okuyarak başla. Her sprint sonunda "Durum" ve "Karar günlüğü" bölümlerini güncelle.

## Amaç

Kişisel proje. Teknik SEO denetim aracı. Bir şirkete veya ajansa bağlı değildir. Web sitesi yenileme projelerinde teknik SEO denetimi yapar.

Ana değer: yenileme (migration) güvenliği. Eski siteyi canlıdan önce tara, yeni siteyi staging'de tara, farkı bul, 301 haritasını üret, canlıya çıkışı kontrol et.

Kullanıcı: proje sahibi (Cihan). Sorunlar iş alanına göre gruplanır (Frontend, Backend/CMS, İçerik, SEO). Böylece her sorun doğru kişiye iletilir. Paylaşılabilir rapor sonraki aşama.

## Mimari

- Node.js 20+, ES modules, framework yok. Bağımlılıklar: cheerio, robots-parser, exceljs, fast-xml-parser.
- Tarama sunucu tarafında yapılır. Tarayıcı içinde çalışamaz (CORS). Bu yüzden yayınlanmış bir web sayfası değil, yerel bilgisayarda veya kendi sunucusunda çalışan bir Node uygulamasıdır.
- Veri: `crawls/` klasöründe her tarama için `<id>.json` (ham), `<id>.meta.json` (özet), `<id>.audit.json` (denetim). Veritabanı yok.
- Ham veri: `{ meta, pages, checks }`. `checks` ek kontrol sonucudur (`ran`, `site`, `resources`, `limited`). v0.4 öncesi taramalarda `checks` yoktur; ilgili kurallar o taramalarda tetiklenmez.

```
bin/crawl.js            CLI
src/crawler.js          Tarama motoru: kuyruk, redirect zinciri (manuel), robots, sitemap, iptal
src/checks.js           Ek kontroller (tarama sonrası): site sürümleri, SSL, HSTS, llms.txt, dış link, görsel
src/parser.js           HTML → SEO alanları (başlık ağacı, JSON-LD, görseller, linkler, parmak izi)
src/fingerprint.js      exactHash + 64-bit simhash (BigInt yok)
src/normalize.js        URL normalizasyonu, iç/dış ayrımı (www = aynı site)
src/sitemap.js          sitemap + sitemap index
src/rules/definitions.js  88 kural (tek kaynak)
src/rules/helpers.js    isIndexable, titlePx, staging host tespiti, isBroken, TLS hata metinleri
src/rules/index.js      Denetim motoru, sağlık skoru
src/export.js           Excel çıktısı
src/store.js            Dosya tabanlı kayıt
src/server.js           Web sunucusu + API (/api/crawls, /api/rules) + SSE canlı ilerleme
public/                 Arayüz (vanilla JS, build yok, koyu tema). Giriş ekranı = landing page
config/rules.json       Bütün eşikler, kural ayarları ve ek kontrol limitleri (checks)
test/                   fixture sunucuları ve testler (fixture-https.js: self-signed HTTPS test sitesi)
```

## Kurallar ve konvansiyonlar

1. Yeni kural `src/rules/definitions.js` içine yazılır. Her kuralda: id, category, severity (critical/warning/notice), team (SEO/İçerik/Frontend/Backend), title, description, fix, run.
2. Her yeni kural için `test/fixture-rules.js` içine onu tetikleyen bir sayfa ve `test/rules-test.js` içine beklenti eklenir. `/temiz` sayfasında hiçbir kural tetiklenmemeli.
3. Eşikler koda yazılmaz, `config/rules.json` içine yazılır.
4. Arayüz ve kural metinleri Türkçe, kısa cümleli, aktif fiilli (Simplified Technical English prensipleri).
5. Taranan sitelerden gelen her metin arayüzde `esc()` ile basılır (XSS).
6. Yeni bağımlılık eklemeden önce gerekçesi yazılır ve onay alınır.
7. API anahtarları sadece `.env` dosyasında durur. Sohbete veya repoya yazılmaz.
8. Her değişiklikten sonra `npm test` çalışır ve geçer.

## Durum

| Aşama | İçerik | Durum |
|---|---|---|
| Faz 1 | Crawler, CLI, Excel, web arayüzü, canlı durum şeridi | Tamam (v0.2) |
| Sprint 1 | Kural motoru (77 kural), Sorunlar sekmesi, sağlık skoru, başlık ağacı | Tamam (v0.3) |
| Altyapı | CLAUDE.md, .env.example, GitHub deposu `seo-audit` (Public), Claude depoyu klonlar | Tamam (v0.4.3) |
| Sprint 2 | Ek kontroller (11 kural): site sürümleri, SSL, HSTS, sıkıştırma, llms.txt, dış link, görsel; site kartı | Tamam (v0.4.0) |
| Arayüz | Koyu tema, landing giriş ekranı, bütün ekranlar yenilendi | Tamam (v0.4.1) |
| Sprint 3 | Migration | Sırada |
| Sprint 4 | AI özellikleri | Bekliyor (Claude API anahtarı gerekir) |
| Sprint 5 | Entegrasyonlar | Bekliyor (PSI anahtarı, GSC OAuth, ClickUp token) |
| Sprint 6 | JS render | Bekliyor |

Testler: crawler testi 19 kontrol, kural testi 99 kontrol (yaklaşık 5 sn). 5.000 sayfa denetimi yaklaşık 1 sn.

Açık noktalar (Sprint 2'den):
- Ek kontroller gerçek bir sitede denenmedi. İlk denemede süreyi ve yanlış alarmları ölç. Eşikler: `checks` ve `brokenIgnoreStatuses`.
- `srcset` ve CSS arka plan görselleri kontrol edilmez.
- Kural kodu değişince eski denetimleri yenilemek için `AUDIT_VERSION` artır (`src/rules/index.js`). `configHash` sadece `rules.json` değişikliğini görür.

## Yol haritası (kalan sprintler)

**Sprint 3 — Migration:** iki taramayı karşılaştırma ekranı (eski = `eski` etiketli, yeni = `yeni` etiketli). Kaybolan URL'ler, title/meta/H1 kaybı, 301 haritası önerisi (önce slug/title benzerliği, Sprint 4'te AI), 301 haritasını CSV/Excel olarak dışa aktarma, canlıya çıkış kontrolü (noindex/Disallow kaldı mı, staging linki kaldı mı), canlıda 301 haritası doğrulama, iki tarama arası ilerleme.

**Sprint 4 — AI (Claude API):** title ve meta description yazma, görsel alt text yazma, başlık yapısı önerisi, schema önerisi, Türkçe yazım kontrolü, odak anahtar kelime uyumu, 301 eşleştirmede içerik benzerliği. Maliyet kontrolü: sayfa başına tek çağrı, toplu işlem, önizleme ve onay.

**Sprint 5 — Entegrasyon:** PageSpeed Insights API (Core Web Vitals), Google Search Console (trafik ile önceliklendirme, indeks durumu), sorun → ClickUp task (kuralın team alanına göre).

**Sprint 6 — JS render:** Playwright modu. Ham HTML ile render edilmiş HTML farkı, sadece JS ile gelen linkler.

## Karar günlüğü

- Crawler'ı Crawlee yerine kendimiz yazdık: her redirect hop'unu kaydetmek (Faz 3 için şart) ve bağımlılığı az tutmak için.
- Sitemap'teki URL'ler link taraması bittikten sonra taranır. Böylece yetim sayfa ve doğru derinlik bulunur.
- www ve www olmayan host aynı site sayılır.
- Eski Türkçe siteler için windows-1254 / iso-8859-9 çözümlenir.
- İçerik kopyası "ana içerik" üzerinden ölçülür (header/nav/footer/aside hariç).
- Benzer içerik eşiği simhash mesafesi 5 (3, 300 kelimelik sayfalarda gerçek benzerleri kaçırdı). 5.000 rastgele sayfada yanlış alarm 0.
- Sağlık skoru = kritik sayfa sorunu olmayan URL oranı. Site geneli kritik sorun varsa skor en fazla 40.
- v0.4.3: Proje kişisel projedir. RNG İstanbul ile ilgisi yoktur. Ad "SEO Audit", paket ve depo adı `seo-audit`. User-Agent `SEO-Audit/<sürüm>`. Renkler (grafit + kırmızı) sadece tasarım tercihidir, bir marka kimliği değildir.
- v0.4.3: Depo Public kalır, çünkü bir arkadaş ile paylaşılır. Claude kodu her sohbette depodan klonlar; Project ↔ GitHub senkronu gerekmez.
- v0.4.2: Proje GitHub'a taşındı (private depo). Önceki karar "GitHub kullanma" idi; dosya alışverişi çok adım aldığı için değişti. Kodun tek kaynağı GitHub deposudur. KAYNAK_KOD.md depoya girmez.
- Denetim, `rules.json` değişince eski taramalar açılırken otomatik tekrar çalışır (configHash).
- Sprint 2: Ek kontroller taramadan sonra ayrı adım olarak çalışır. Arayüz ve CLI'da varsayılan açık, kütüphanede (`crawl()`) varsayılan kapalı.
- Sprint 2: 401, 403, 429, 999 ve zaman aşımı "kırık" sayılmaz. Bunlar genelde bot korumasıdır (LinkedIn 999, Cloudflare 403).
- Sprint 2: Önce HEAD gönderilir. HEAD 4xx/5xx dönerse `GET Range: bytes=0-0` ile tekrar denenir. Boyut başlığı yoksa görsel için aynı GET kullanılır.
- Sprint 2: DNS hatası veren alan adı (ENOTFOUND) bir kez sorgulanır. Aynı hosttaki diğer URL'ler bu sonucu alır.
- Sprint 2: Staging şifresi (`auth`) sadece taranan siteye gönderilir, dış hostlara gönderilmez.
- Sprint 2: Site sürümleri kontrolü, sürümün son URL'sini ana adresin son URL'si ile karşılaştırır (`origin + '/'`). Sürüm 200 dönerse kopya site (kritik). Geçici yönlendirme, fazladan adım veya sertifika hatası uyarıdır.
- Sprint 2: Sadece sertifika hataları (CERT, SELF_SIGNED, VERIFY, ALTNAME) "sertifika hatası" sayılır. Protokol hataları (ERR_SSL_PACKET_LENGTH_TOO_LONG: https portunda düz http) ve ECONNREFUSED sayılmaz.
- Sprint 2: SSL sertifikası `tls.connect` ile `rejectUnauthorized: false` olarak okunur. Böylece süresi dolmuş veya self-signed sertifika da raporlanır.
- Sprint 2: Sıkıştırma ek istek gerektirmez. Taramada `content-encoding` başlığı kaydedilir. Test sitesi her HTML sayfayı gzip ile gönderir, sadece `/sikistirmasiz` sayfasını göndermez.
- Sprint 2: Testler internete çıkmaz. Dış linkler `.invalid` alan adı kullanır (RFC 2606). HTTPS testi 2046'ya kadar geçerli self-signed sertifika kullanır. `NODE_TLS_REJECT_UNAUTHORIZED=0` sadece test sürecinde ayarlanır.
- Arayüz (v0.4.1): Landing page uygulamanın giriş ekranıdır, aynı Node sunucusunda çalışır. Ayrı, herkese açık tanıtım sayfası yapılmadı: sunucuyu internete açmak SSRF ve şifre riski getirir.
- Arayüz (v0.4.1): Koyu tema. Zemin siyah değil grafit (#1C1F22). Gri yapıyı taşır. Kırmızı sadece ana buton ve hatalar içindir. Amber uyarı ve redirect, yeşil "sorun yok" içindir.
- Arayüz (v0.4.1): Tek yazı ailesi Archivo (Google Fonts). Başlıklar geniş kesim (font-stretch 125%), ağırlık 800. Font yüklenmezse system-ui kullanılır.
- Arayüz (v0.4.1): Giriş ekranında tek hareket var: URL alanının altındaki tarama şeridi bir kez dolar. prefers-reduced-motion açıksa hareket yok.
- Arayüz (v0.4.1): Giriş ekranındaki kategori ve kural sayıları /api/rules ile gelir. rules.json içinde kapatılan kurallar sayılmaz.
- Sprint 2: llms.txt kuralı "Bilgi" önemindedir. Dosya zorunlu değildir. Site hiç yanıt vermezse kural tetiklenmez.

## Proje dosyaları

Kodun tek kaynağı GitHub deposudur: https://github.com/Cihanpehlivan/seo-audit (Public). Depo bir arkadaş ile paylaşılır.

- `CLAUDE.md` — bu dosya: amaç, mimari, kurallar, durum, karar günlüğü. Depoda durur.
- `KAYNAK_KOD.md` — artık gerekmez. Depoya girmez. `npm run bundle` komutu yedek olarak durur.
- Depoya asla gizli bilgi koyma: `.env`, API anahtarı, staging şifresi, müşteri verisi, tarama sonucu (`crawls/`). Depo herkese açıktır.

## Çalışma döngüsü

Sohbette (claude.ai):

1. Kullanıcı yeni sohbet açar ve görevi yazar. Dosya yüklemez.
2. Claude depoyu klonlar: `git clone https://github.com/Cihanpehlivan/seo-audit.git`. Sonra `npm install` ve `npm test` çalıştırır. Testler geçmeden geliştirmeye başlama. Klonlama çalışmazsa kullanıcıdan depoyu zip olarak ister (GitHub → Code → Download ZIP).
3. Görevi bu dosyadan ve kullanıcıdan al. Kodu yaz, test sitesine yeni sayfalar ekle, `npm test` çalıştır.
4. Arayüz değiştiyse ekran görüntüsü ile kontrol et (masaüstü 1440 px ve mobil 390 px).
5. İş sonunda: bu dosyadaki Durum ve Karar günlüğü bölümlerini güncelle, `package.json` sürümünü artır.
6. Kullanıcıya bir zip ver. Zip sadece değişen ve yeni dosyaları, depodaki klasör yapısı ile içerir. Silinmesi gereken dosya varsa adlarını ayrıca yaz. Kısa bir commit mesajı öner.
7. Kullanıcı GitHub'da Add file → Upload files ile zip içeriğini sürükler ve commit yapar. Gizli dosyalar (nokta ile başlayan) değiştiyse Claude içeriklerini metin olarak da verir; kullanıcı bunları web'de düzenler.

Claude Code ile (masaüstü): Claude yerel depo klasöründe doğrudan çalışır, commit yapar. Zip ve 6-7. adımlar gerekmez. Push kullanıcı onayı ile yapılır.

8. Kullanıcı gerçek bir sitede dener ve geri bildirim verir. Eşikler `rules.json` ile kalibre edilir.
