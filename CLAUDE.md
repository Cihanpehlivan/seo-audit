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
src/compare.js          Eski taramayı bir veya daha çok yeni tarama ile karşılaştırır. Yol kuralları, desen önerisi, satır açıklaması. Bulunamayan eski yolları beklenen adreste yoklar (Sprint 3)
src/netguard.js         Yayın modunda iç ağ adreslerini engeller (SSRF koruması)
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
src/server.js           Web sunucusu + API (/api/crawls, /api/compare, /api/rules, /api/info, /healthz) + SSE canlı ilerleme. PUBLIC_MODE=1 yayın modudur
render.yaml             Render Blueprint (ücretsiz plan, Docker)
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
| Yayın | Render (ücretsiz), SSRF koruması, zorunlu şifre, yayın limitleri | Tamam (v0.5.0) |
| Sprint 3 | Migration: Parça 1 karşılaştırma ekranı tamam (v0.6.0), yol kuralları + çoklu hedef + desen önerisi + açıklama (v0.6.1). Sırada Parça 2: 301 haritası önerisi | Devam ediyor |
| Sprint 4 | AI özellikleri | Bekliyor (Claude API anahtarı gerekir) |
| Sprint 5 | Entegrasyonlar | Bekliyor (PSI anahtarı, GSC OAuth, ClickUp token) |
| Sprint 6 | JS render | Bekliyor |

Testler: crawler 19, kural 99, yayın modu 12, karşılaştırma 38 kontrol (toplam yaklaşık 8 sn). 5.000 sayfa denetimi yaklaşık 1 sn.

Açık nokta (v0.6.1, v0.7.0'da düzelir): Kural ile başka yola veya başka siteye taşınan sayfa, hedef sayfa varsa "Aynı kaldı" olur. Bu yanlış güven verir. Asıl soru: eski adres hedefe 301 ile gidiyor mu? 301'ler eski alan adında çalışır. Canlıdan sonra eski alan adını "eski alan adına geçecek site" kullanır. Bu yüzden yönlendirme o sitenin staging'inde yoklanmalıdır.

Açık noktalar (Sprint 2'den):
- Ek kontroller gerçek bir sitede denenmedi. İlk denemede süreyi ve yanlış alarmları ölç. Eşikler: `checks` ve `brokenIgnoreStatuses`.
- `srcset` ve CSS arka plan görselleri kontrol edilmez.
- Kural kodu değişince eski denetimleri yenilemek için `AUDIT_VERSION` artır (`src/rules/index.js`). `configHash` sadece `rules.json` değişikliğini görür.

## Yol haritası (kalan sprintler)

**v0.7.0 — Taşıma projesi (arayüz, Sprint 3 Parça 2'den önce):** Araç kullanıcıyı adım adım yönlendirir. Adım çubuğu: Proje → Tarama → Eşleştirme → Yapılacaklar → (sonra) 301 haritası → Canlıya çıkış → Canlı doğrulama. Her ekranda tek bir "Sıradaki iş" kartı. Boş veya engelli her sonuç nedeni ve sıradaki işi söyler.
- Proje: ad + "Yeni yapı nasıl?" sorusu (aynı alan adı ve aynı yollar / aynı alan adı, değişen yollar / diller ayrı alan adlarına). Site rolleri: eski site, eski alan adına geçecek site, ek siteler. Etiket (eski/yeni) seçimi gerekmez.
- Tarama: her site için "Tara" düğmesi ve durum (bekliyor, taranıyor, tamam, silinmiş).
- Eşleştirme: eski bölüm tablosu (`/tr/ · 8 sayfa → [TR site] · 7 bulundu`), öneri satırda hazır. Serbest kural editörü "Gelişmiş" altında. v0.6.1 tarayıcı kuralları projeye aktarılır.
- Model düzeltmesi: taşınan sayfa için iki kontrol: hedef sayfa var mı, eski yol "eski alan adına geçecek site" üzerinde hedefe 301 veriyor mu. Sonuç: "Hedef hazır, 301 kurulu" / "Hedef hazır, 301 eksik" / "Hedef yok".
- Yapılacaklar: işin yapıldığı yere göre liste (eski alan adı sunucusu: yönlendirmeler; hedef site: eksik sayfalar; içerik: title/meta/H1). Mevcut gruplar ikinci görünüm.
- Terimler: "ana hedef" yerine "eski alan adına geçecek site". "Yoklama" kullanıcıya gösterilmez. Her kavramın yanında kısa "?" açıklaması.
- İş büyükse iki sürüme bölünür: v0.7.0 (model, proje, tarama, eşleştirme), v0.7.1 (yapılacaklar, açıklamalar).

**v0.7.0 onaylı ekran tasarımı** (sohbette tıklanabilir taslak ile onaylandı, örnek: Şamil Şahin taşıması):
- Proje başlığı: proje adı, altında özet ("3 site · 2 kural · son tarama bugün").
- Adım çubuğu: Proje, Tarama, Eşleştirme, Yapılacaklar tıklanır. 301 haritası, Canlıya çıkış, Canlı doğrulama kesik çizgili ve pasif ("Sonraki sürüm"). Mobilde çubuk yatay kayar.
- "Sıradaki iş" kartı: adım çubuğunun altında, mavi sol çizgi. Tek cümle durum + tek düğme. Örnekler: "Türkçe site taranmadı. Eşleştirme için gerekli." [Türkçe siteyi tara]; "/fr/ bölümü için karar gerekli." [Kararı seç]; "15 iş var. En çok iş eski alan adı sunucusunda." [Excel indir].
- Proje ekranı: "Yeni yapı nasıl?" üç seçim kartı (aynı alan adı ve aynı yollar / aynı alan adı, yollar değişiyor / diller ayrı alan adlarına). Siteler listesi: Eski site, Eski alan adına geçecek site (? açıklaması: "Canlıdan sonra eski alan adını bu site kullanır. Bütün 301'ler bu sitede kurulur."), Ek site (ad verilir, örnek "Türkçe"). Düğmeler: + Site ekle, Projeyi indir, Proje yükle.
- Tarama ekranı: her site bir satır: alan adı + rol, durum etiketi (Tamam · N sayfa / Taranıyor / Taranmadı / Silinmiş), düğme (Tara / Tekrar tara). Not: "Staging şifreli ise şifreyi tarama sırasında girin. Araç şifreyi saklamaz."
- Eşleştirme ekranı: sütunlar Eski bölüm · ok · Nereye gidiyor? · Sonuç. Satır: "/tr/ · 8 sayfa → [Türkçe site · /tr/ kalkar ▾] → 7 / 8 bulundu". Seçenekler: her site + yol biçimi (aynı yol / önek kalkar / önek değişir), Bölüm kaldırıldı, Karar verin. Öneri seçili gelir; bulunamayan bölüm "Karar verin" ve amber "Öneri: …" etiketi alır. Altta: "Gelişmiş: serbest kural yaz" (v0.6.1 kural editörü).
- Yapılacaklar ekranı: işin yapıldığı yere göre satırlar: "<eski alan adı> sunucusu" (yönlendirme sayısı), her ek site (eksik sayfa), İçerik (title/meta/H1), Karar bekleyen. Her satırda sayı etiketi ve "Listeyi aç". Eski grup görünümü (Aynı kaldı, Yönleniyor, Kayboldu…) "Bütün sayfalar" altında kalır.
- Durum etiketleri: yeşil = tamam/sorun yok, amber = iş veya karar gerekli, gri = taranmadı/bekliyor. Kırmızı sadece hata ve ana düğme için (v0.4.1 renk kuralı).
- Giriş ekranı: iki seçenek, "Site denetimi" (tek site, mevcut Sorunlar ekranı) ve "Taşıma projesi". Kenar çubuğu: önce projeler, sonra projeye bağlı olmayan taramalar.
- Mobil (390 px): bölüm tablosunun her satırı karta dönüşür; site satırlarında düğme alta iner.


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
- v0.6.0 (Sprint 3, Parça 1): Sprint 3 dört parçaya bölündü: 1 karşılaştırma ekranı, 2 301 haritası önerisi, 3 canlıya çıkış kontrolü, 4 canlıda 301 doğrulama. Her parça ayrı sürüm.
- v0.6.0: Eski ve yeni tarama URL yoluna göre eşleşir (host farklı olabilir: canlı ve staging). Sondaki / yok sayılır, yüzde kodlu yol çözülür. Büyük/küçük harf farkı ayrı yol sayılır (Parça 2 benzerlik ile yakalar).
- v0.6.0: Sadece eski sitede 200 veren HTML sayfalar karşılaştırılır. Eski sitedeki yönlendirmeler eski sayfa sayılmaz.
- v0.6.0: Yeni tarama sadece yeni sitenin linklerini izler; eski URL'ler genelde sadece 301 olarak yaşar. Bu yüzden yeni taramada bulunmayan her eski yol yeni hostta tek tek istenir (yoklama). Sonuç: yönleniyor, hatalı hedefe yönleniyor, açılıyor ama linksiz, kayboldu veya kontrol edilemedi.
- v0.6.0: Yoklama staging şifresini göndermez (tarama şifresi kayıtta saklanmaz). Şifreli staging'de 401 "kontrol edilemedi" olur. Yayın modunda yoklama da SSRF korumasından geçer.
- v0.6.0: İçerik kaybı: title, meta description veya H1 boşaldıysa, ya da indexlenebilir sayfaya noindex eklendiyse. Farklı metin "değişti" sayılır, kayıp sayılmaz.
- v0.6.0: Karşılaştırma sonucu sunucu belleğinde tarama çifti başına saklanır (en fazla 20). Yoklama tekrar çalışmaz.
- v0.6.0: Kaybolan listesi önem sırasındadır: önce indexlenebilir, sonra eski sitede çok iç link alan sayfa.
- v0.7.0 planı: Proje kaydı sunucuda `crawls/` yanında JSON dosyası olur (veritabanı yok kuralı korunur). Projede taramaların sonucu değil, sadece tanım durur: siteler, roller, tarama kimlikleri, kurallar. Render diski kalıcı olmadığı için "Projeyi indir" ve "Proje yükle" (JSON) gelir. Taramalar silinirse proje ekranı "Tarama yok: Tara" der; tanım kalır, tekrar tarama tek tıktır. Sadece tarayıcıda saklamak seçilmedi: başka tarayıcıda ve arkadaş ile paylaşımda proje görünmez. Kalıcı çözüm sonra: Render kalıcı disk (ücretli) veya dış depolama.
- v0.6.1: Yol kuralı = eski yol deseni → hedef site + yeni yol (`/tr/* → tr.ornek.com /*`). `*` sadece sonda olur. `/tr/` yazılırsa `/tr/*` okunur. En uzun eski yol önce uygulanır. Kurala girmeyen yol ana hedefte aynı yolda aranır.
- v0.6.1: Çoklu hedef: bir eski tarama en fazla 4 yeni tarama ile karşılaştırılır (`rules.json` → `compare.maxTargets`). İlk yeni tarama ana hedeftir. Yoklama her eski adresi kuralın hedef sitesinde ister. Yeni sayfalar her hedef için ayrı bulunur.
- v0.6.1: Kural hedefi tarama kimliği değil, alan adıdır (www yok sayılır). Staging tekrar tarandığında kural geçerli kalır. Kuralın alan adı seçili taramalarda yoksa sayfalar "Kontrol edilemedi" olur; yoklama başka hosta gitmez (SSRF yüzeyi büyümez).
- v0.6.1: "Bölüm kaldırıldı" kuralı (`drop`): sayfa ana hedefte aynı yolda aranır. Yönleniyorsa "Yönleniyor", bulunmazsa "Kayboldu" yerine "Bölüm kaldırıldı" grubuna girer. Korunan oranı artırmaz. 301 veya 410 yine gerekir.
- v0.6.1: Kurallar sunucuda saklanmaz. Arayüz kuralları tarayıcıda (localStorage) eski sitenin alan adına göre saklar ve API'ye `rules` sorgu parametresi ile gönderir. Sebep: Render diski kalıcı değil, Excel linki de aynı parametreleri taşır. Karşılaştırma önbelleği kuralları da anahtara katar.
- v0.6.1: Desen önerisi: eski sayfalar ilk yol parçasına göre gruplanır (en az `suggestMinPages` sayfa). Her grup için her hedefte üç taşıma denenir: aynı yol, öneki kaldır, hedefin bir öneki ile değiştir. Öneri, taramadaki sayfalara bakar (yoklama yapmaz). Grubun en az `suggestMinRatio` oranını bulmalı ve mevcut durumdan en az `suggestMinPages` fazla sayfa bulmalı. Hiçbir taşıma bulamazsa "bölüm kaldırıldı" önerilir. Kuralı olan grup tekrar önerilmez.
- v0.6.1: Açıklama: her satırda kontrol edilen URL, uygulanan kural ve yapılacak iş (`todo`) yazılır. Yönlendirmede hatalı hedef, zincir (1'den fazla adım) ve 301/308 dışı status düzeltme ister. Her kuralın yanında sayfa ve bulunan sayısı gösterilir.
- v0.6.1: Testler müşteri alan adı kullanmaz (`eski.com`, `tr.ornek.com`). Depo herkese açıktır.
- v0.5.0: Araç Render ücretsiz planında yayınlanır (render.yaml, Docker). GitHub Pages kullanılmaz: sadece statik sayfa yayınlar, tarama sunucu ister.
- v0.5.0: Yayın modu PUBLIC_MODE=1 ile açılır. Yerel kullanım değişmez: test sitesi 127.0.0.1 üzerinde çalışmaya devam eder.
- v0.5.0: Yayın modunda APP_USER ve en az 10 karakterli APP_PASS zorunludur. Yoksa sunucu başlamaz.
- v0.5.0: SSRF koruması (src/netguard.js) her isteği ve yönlendirmenin her adımını kontrol eder: özel IPv4/IPv6 aralıkları, localhost, .internal, .local, http dışı protokoller. Ek kontrollerde yönlendirmeler artık elle izlenir. Engellenen kaynak "kırık" sayılmaz.
- v0.5.0: Bilinen sınır: DNS rebinding tam kapalı değil (adres istekten önce kontrol edilir). Kapatmak için undici dispatcher ile bağlantı anında kontrol gerekir; yeni bağımlılık ister.
- v0.5.0: Yayın limitleri rules.json → yayin: 2.000 URL, aynı anda 1 tarama. Ücretsiz plan 512 MB bellek verir.
- v0.5.0: Ücretsiz planda disk kalıcı değildir. EPHEMERAL_STORAGE=1 arayüzde uyarı gösterir. Docker imajı root olmayan kullanıcı ile çalışır.
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
