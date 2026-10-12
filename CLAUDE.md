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
src/compare.js          Eski taramayı bir veya daha çok yeni tarama ile karşılaştırır. Yol kuralları, desen önerisi, satır açıklaması, bölüm tablosu (v0.7.1: her bölümün sayfa listesi). Bulunamayan eski yolları beklenen adreste yoklar. Taşınan sayfada hedefi ve geçecek sitedeki 301'i kontrol eder (v0.7.0)
src/projects.js         Taşıma projesi: tanım doğrulama, site anahtarı → alan adı çevirisi, dosya kaydı (crawls/projects/<id>.json, atomik yazma), 301 haritası kararlarının temizliği
src/redirectmap.js      301 haritası (v0.8.0): bulunamayan eski sayfaya yeni sayfa önerisi (slug, title, H1, içerik; IDF ağırlığı), güven, kullanıcı kararları, CSV. v0.8.1: dil filtresi (html lang), eski ana sayfaya ana sayfa önerisi
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
src/server.js           Web sunucusu + API (/api/crawls, /api/projects, /api/compare, /api/rules, /api/info, /healthz) + SSE canlı ilerleme. PUBLIC_MODE=1 yayın modudur
                        /api/projects/:id/map → GET (harita, ?format=csv son liste), POST { set: { "/eski/yol": karar | null } }
                        /api/projects/:id → crawl (POST), match, excel, export. GET/PUT/DELETE tanım
render.yaml             Render Blueprint (ücretsiz plan, Docker)
docs/                   Landing page (v0.8.3): docs/index.html + docs/img/. GitHub Pages (main, /docs) veya Netlify ile yayınlanır. Uygulamadan bağımsız, tarama yapmaz
public/                 Arayüz (vanilla JS, build yok, koyu tema). Giriş ekranı = landing page (Site denetimi / Taşıma projesi). Proje ekranı: adım çubuğu + Sıradaki iş kartı
config/rules.json       Bütün eşikler, kural ayarları ve ek kontrol limitleri (checks)
test/                   fixture sunucuları ve testler (fixture-https.js: self-signed HTTPS test sitesi, fixture-migration.js: eski site + geçecek site)
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
| Yayın | Render (ücretsiz), SSRF koruması, yayın limitleri. Şifre isteğe bağlı, Render şifresiz (v0.8.4) | Tamam (v0.5.0) |
| Sprint 3 | Migration: Parça 1 karşılaştırma ekranı tamam (v0.6.0), yol kuralları + çoklu hedef + desen önerisi + açıklama (v0.6.1), taşıma projesi + 301 kontrolü (v0.7.0), eşleştirme ekranı düzeltmesi (v0.7.1), Parça 2 301 haritası (v0.8.0), gerçek site düzeltmeleri: dil kontrolü, bölüm uyarısı, ana sayfa, Excel kaynağı (v0.8.1). Sırada: işin yapıldığı yere göre yapılacaklar listesi ve kavram açıklamaları. Sonra Parça 3: canlıya çıkış kontrolü | Devam ediyor |
| Landing | Portfolyo için statik tanıtım sayfası (kadastro paftası tasarımı), GitHub Pages veya Netlify | Tamam (v0.8.3), yayın bekliyor |
| Sprint 4 | AI özellikleri. Ön görüşme yapıldı (v0.8.1): fiyat, maliyet hesabı, anahtar ve ücret sahipliği konuşuldu. Sprint 3 bitmeden başlamaz. Başlamadan önce tekrar konuşulur | Bekliyor (Claude API anahtarı gerekir) |
| Sprint 5 | Entegrasyonlar | Bekliyor (PSI anahtarı, GSC OAuth, ClickUp token) |
| Sprint 6 | JS render | Bekliyor |

Testler: crawler 19, kural 99, yayın modu 12, karşılaştırma 49, 301 haritası 17, proje 17 kontrol (toplam yaklaşık 12 sn). 3.000 × 3.000 sayfa öneri hesabı yaklaşık 1,5 sn. 5.000 sayfa denetimi yaklaşık 1 sn.

Gerçek site denemesi (v0.7.0, Şamil Şahin taşıması, 11 Ekim 2026). Eşleştirme ekranı: `/` 7 sayfa (3 bulundu), `/tr/` 46 sayfa, `/fr/` 19 sayfa, `/prosedur/` 13 sayfa. Bulgular:
- Araç sadece yol ile arar. Slug değişince sayfayı bulamaz ve "Bölüm kaldırıldı" önerir. "Bulunamadı" ile "kaldırıldı" aynı şey değildir. Bu öneri yanlış güven verir. `/prosedur/` bu durumda.
- `/tr/` için "Bölüm kaldırıldı" kayıtlı kural olarak seçili. Türkçe sayfalar kaldırılmadı, ayrı alan adına taşındı. Büyük olasılıkla Türkçe sitede de slug değişti, bu yüzden "Türkçe · /tr/ kalkar" seçeneği az sayfa buldu. Kullanıcıya soruldu (v0.7.1), cevap bekleniyor: Türkçe sitede adresler eski `/tr/` adresleri ile aynı mı (önek hariç), yoksa slug da değişti mi? v0.7.1 ile `/tr/` satırı açılır ve cevap sayfa listesinde görünür. Kayıtlı "Bölüm kaldırıldı" kararını kullanıcı Türkçe site olarak değiştirmeli.
- Listedeki sayı (2 / 7) sadece taramaya bakar. Sonuçtaki sayı (3 / 7) istekten sonra gelir. Fark açıklanmıyor.
- "Diğer sayfalar" etiketi belirsiz. Bölüm satırı açılmıyor: hangi sayfanın bulunduğu görünmüyor.

v0.7.1 planı (gerçek site denemesinden sonra güncellendi). 1-4 tamam (v0.7.1). Sıra:
1. Hiçbir seçenek sayfa bulmazsa "Bölüm kaldırıldı" önerme. Satır "Bulunamadı: adresler değişmiş olabilir" der. Seçim olarak hedef siteler ve "Bölüm kaldırıldı" kalır. Sıradaki iş kartı nedeni açıklar.
2. Bölüm satırı açılır: eski sayfa → bulunan yeni adres veya "bulunamadı".
3. Sayılar tek ve açık etiket alır ("taramada bulundu" ile "kontrol sonrası bulundu" ayrımı ya da tek sayı).
4. "Diğer sayfalar" yerine açık ad (örnek: "Kök ve küçük bölümler").
5. Sonra asıl v0.7.1 işi: işin yapıldığı yere göre yapılacaklar listesi ve kavram açıklamaları.
Öncelik kararı (11 Ekim 2026, kullanıcı onayladı): Çok alan adlı taşıma nadirdir. Yaygın iş tek eski site → tek yeni sitedir. İki durumda da asıl zorluk slug değişimidir. Gerçek projede SEO ajansı 301 listesi göndermedi: listeyi araç üretmeli. 301 kontrolü ancak 301'ler kurulduktan sonra işe yarar. Yeni sıra:
1. v0.7.1: Eşleştirme ekranı düzeltmesi (yukarıdaki plan 1-4). Tamam.
2. v0.8.0: Parça 2, 301 haritası önerisi. Tamam (v0.8.0).
3. Sonra: işin yapıldığı yere göre yapılacaklar listesi ve kavram açıklamaları.
Gerçek site denemesi (v0.8.0, 11 Ekim 2026, çok dilli taşıma: İngilizce kökte, Türkçe /tr/ altında, Fransızca /fr/ altında; yeni İngilizce site eski alan adında, Türkçe site ayrı alan adında). Bulgular:
- /tr/ bölüm kararı yanlışlıkla geçecek site (İngilizce) olarak kaydedildi (taramada 0 sayfa). Bölüm kararı aramayı o siteye sınırladığı için Türkçe sayfalar İngilizce sayfa önerisi aldı. Araç bu kararı uyarmadı.
- Fransızca bölüm kaldırıldı. Arama serbest kaldı ve Fransızca sayfalar Türkçe siteye eşleşti.
- Ana sayfa hiç aday değildi. Eski bölüm ana sayfaları (/tr/home, /fr/page-daccueil) yanlış sayfaya gitti.
- Excel onaylanan satırda güven, puan ve nedeni silmişti. Önerinin doğruluğu ölçülemedi.
- Bölüm kuralı doğru olan eski İngilizce /prosedur/ sayfaları çoğunlukla doğru eşleşti. Dolgu sayfaları genel /procedures sayfasına gitti (daha özel sayfa vardı); kaynağı belli değil.
v0.8.1 bu dört sorunu düzeltti. Tekrar test bekliyor.

Açık noktalar (v0.8.4):
- Render şifresiz. Herkes tarama başlatabilir: aynı anda 1 tarama sınırı sizi bekletebilir. Kötüye kullanım görülürse Render → Environment bölümüne APP_USER ve APP_PASS eklemek yeterli (kod değişikliği gerekmez).
- Silme düğmeleri şifresiz çalışır. Gerekirse sonraki sürüm: yayın modunda silmeyi kapatmak veya şifresiz demo modu.

Açık noktalar (v0.8.1):
- v0.8.1 gerçek sitede denenmedi. Aynı projede /tr/ satırında uyarı görünmeli. "Bu seçimi kullan" ile Türkçe siteyi seçin. Ek site için canlı alan adını yazın. Sonra haritayı açın ve Excel'deki "Kaynak" ve "Araç önerisi" sütunları ile önerileri ölçün.
- Dil filtresi `html lang` değerine güvenir. Yeni site bu değeri yanlış yazarsa (Türkçe sitede `lang="en"`) filtre yanlış siteye sınırlar. Testte bunu kontrol edin. Gerekirse sonraki adım: sayfa metninden dil tahmini veya site ayarı ile dil seçimi.
- Eski sitede `hreflang` varsa dil eşleri doğrudan bulunabilir (AI gerekmez). Kullanıcıya soruldu, cevap bekleniyor.
- Gerekçede bölüm kelimesi bazen görünür ("Slug ortak: prosedur, botoks"): bölüm kelimesi sadece ilk yol parçası sayılır (/tr/prosedur/ içinde `tr`). Küçük kozmetik hata.
- Render'da aynı anda 1 tarama çalışır (`rules.json` → `yayin`). İkinci tarama hata verir. Sıra (kuyruk) özelliği gerekirse sonra küçük bir sürüm olarak yapılır. Şimdilik değişiklik yok.

Açık noktalar (v0.8.0):
- 301 haritası gerçek sitede denenmedi. Şamil Şahin projesinde haritayı açın. Önerilerin doğruluğunu ve güven etiketlerini kontrol edin. Eşikler `rules.json` → `redirectMap` (high 80, mid 55, low 35).
- Farklı dilde eş anlam bulunmaz (göz kapağı ↔ blepharoplasty). Sadece aynı kelime, ortak önek ve yakın yazım (prosedur ↔ procedures) bulunur. İçerik benzerliği (simhash) sadece 50 kelimeden uzun sayfada vardır. Anlam benzerliği Sprint 4'te (AI) gelir.
- CSV biçimi: eski_url, yeni_url, durum (301/410), kaynak. Sunucu kuralı biçimleri (.htaccess, nginx, Shopify CSV) sonraki sürümde.
- Bir yeni sayfa birden çok eski sayfanın hedefi olabilir. Araç bunu uyarmaz.

Açık noktalar (v0.7.1):
- v0.7.1 gerçek sitede denenmedi. Şamil Şahin projesinde eşleştirmeyi tekrar açın. `/prosedur/` ve `/fr/` "Bulunamadı" demeli, "Bölüm kaldırıldı" önermemeli. Satırları açın ve sayfa listesini kontrol edin.
- Yapılacaklar adımı şimdilik grup görünümünü ("Bütün sayfalar") gösterir. İşin yapıldığı yere göre liste v0.8.0'dan sonra gelir.
- İstekler staging şifresini göndermez. Şifreli geçecek sitede 301 kontrolü "Kontrol edilemedi" olur.
- Otomatik öneri kaydedilmez. Tarama değişirse öneri de değişebilir. Kullanıcı seçerse kural olur.

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

## Doğrulama planı (bekliyor)

Bütün özellikler bittikten sonra her kalemin doğruluğunu tek tek kontrol ederiz. Her kalem için: senaryo, beklenen sonuç, gerçek sonuç, bug kaydı. Yöntemi kullanıcı ile birlikte planlarız. Şimdilik sadece bu not var. Plan yapılmadan doğrulamaya başlama.

## Karar günlüğü

- v0.8.4: Render şifresiz çalışır (kullanıcının son kararı, v0.5.0 ve v0.4.1 kararlarının şifre kısmının yerine geçer). Claude riskleri yazdı ve şifreli kalmayı ve şifresiz demo modunu önerdi; kullanıcı tam kaldırmayı seçti. Kod: yayın modunda APP_PASS yoksa sunucu açılır ve uyarı yazar. APP_PASS tanımlı ise eski kural geçerli (APP_USER ve en az 10 karakter). SSRF koruması ve yayın limitleri (2.000 URL, aynı anda 1 tarama) değişmedi. `render.yaml` artık APP_USER ve APP_PASS istemez.
- v0.8.4: Şifresiz yayının kuralları: Render'da müşteri sitesi taranmaz, müşteri projesi tutulmaz. Herkes projeleri görür, Excel indirir ve siler. Müşteri işleri yerelde (`npm start`, 127.0.0.1) yapılır.

- v0.8.3: Depo açık kalır (v0.4.3 kararı geçerli). Kullanıcı önce gizli depoyu seçti, sonra vazgeçti. Claude depoyu klonlamaya devam eder. Landing'de "Kodu inceleyin" düğmesi ve GitHub linki var.
- v0.8.3: Landing page (kullanıcı onayladı). Proje iş listesinden ayrı bir görev, Sprint 3 sırasını değiştirmez. Yer: `docs/index.html`, yayın: GitHub Pages (Settings → Pages → main, /docs) veya Netlify (yayın klasörü `docs`). Uygulamanın içinde değil, çünkü: yayın modunda uygulama şifre ister, Render ücretsiz plan uyur (ilk açılış yavaş), portfolyo linki şifre denemesi çeker. v0.4.1 kararı (sunucuyu herkese açma) korunur.
- v0.8.3: Tasarım yönü "kadastro paftası" (frontend-design skill ile, üç yönden kullanıcı seçti). Eski site = mavi ölçü çizgisi, yeni site = kırmızı kesik sınır, sorun = kırmızı nokta, ekip = kare. Renk: pafta zemini #E6EDE3, grafit #2B2E2A, ölçü mavisi #2F5D8C, sınır kırmızısı #B3261E, ızgara #D3DECF. Yazı: Overpass (Google Fonts). Uygulama teması (grafit + kırmızı) kopyalanmadı: landing kendi kimliğini taşır. Tek hareket: eski parseller çizilir, yeni sınırlar gelir, iki sorun işareti düşer; prefers-reduced-motion açıksa yok. Parsellere sayfa yolları yazılır (/urun → /kahveler).
- v0.8.3: Düzen tam genişliktir (kullanıcı istedi). Izgara bütün ekranı kaplar, bölümler tam genişlik bantlardır, bantlar arasında pafta çizgisi var. Hero ekran yüksekliğindedir, çizim sağ kenara uzanır. Metin satırı dar kalır (40-45 karakter). İlk sürümdeki ortada çerçeveli kâğıt düzeni bırakıldı: geniş ekranda küçük ve belge gibi duruyordu.
- v0.8.3: Ekran görüntüleri örnek sitelerden alındı (kavrulmus.example: eski site, staging, İngilizce site; RFC 2606 alan adları). Müşteri verisi yok. Örnek site depoya girmez.
- v0.8.3: "Uygulamaya girin" düğmesi `docs/index.html` sonundaki `APP_URL` sabitini kullanır. Boş ise düğme gizlidir. Adres yazılırsa landing'i açan herkes görür: karar kullanıcıda. Uygulama şifreli kalır (v0.4.1).

- v0.8.2: README başlığındaki sürüm (v0.6.1'de kalmıştı) kaldırıldı. Sürümün tek kaynağı `package.json`. İş sonu kuralına README eklendi (Çalışma döngüsü, 5. adım).
- v0.8.1: Belge değişiklikleri. "İki kişi çalışma kuralları" ve "Doğrulama planı (bekliyor)" bölümleri eklendi. Render'daki tek tarama sınırı Durum'a not olarak yazıldı.
- v0.8.1: Dil filtresi. Her sayfanın dili `html lang` ana etiketidir (tr-TR → tr). Öneri aramasında sıra: (1) eski sayfanın dili bir yeni sitede varsa sadece o dildeki sayfalar; (2) dil biliniyor ama hiçbir yeni sitede yoksa sadece geçecek site (Fransızca → İngilizce site, Türkçe siteye asla); aday yoksa öneri yok; (3) dil bilinmiyor ve bölüm kaldırıldıysa geçecek site (adayı varsa); (4) bölüm kararı (prefer) bu kümede adayı varsa. Dil, bölüm kararından önce gelir: yanlış bölüm kararı yanlış dilde öneri üretmez. AI gerekmez, ücretsizdir.
- v0.8.1: Bölüm uyarısı (`sections[].alert`). Türler: `lang` (bölüm sayfalarının dili ile seçilen sitenin dili farklı ve bölüm dilinde site var), `zero` (kayıtlı karar taramada 0 sayfa buluyor, başka seçim buluyor), `lang-drop` (bölüm kaldırıldı, ama bölüm dilinde site sayfaları buluyor). Uyarı daha iyi seçimi söyler, "Bu seçimi kullan" düğmesi kararı kaydeder. Kendiliğinden uygulanmaz. Sıradaki iş kartı uyarıyı 301 haritasından önce gösterir (harita adımında göstermez). Bölüm ve site dili: dili bilinen sayfaların en az `compare.langMinShare` (0.6) oranı.
- v0.8.1: Ana sayfa adayı. Son yol parçası `redirectMap.homeSlugs` içinde olan eski sayfa (home, anasayfa, page-daccueil…) veya dil bölümünün kökü (/tr, /en-gb) ana sayfa sayılır. Bu sayfaya doğru sitenin ana sayfası (aynı dil, yoksa geçecek site) `homeScore` (85, Yüksek) ile ilk aday olur. Ana sayfa başka hiçbir sayfa için aday olmaz (soft 404 kuralı korunur).
- v0.8.1: Excel "301 haritası" sayfası her satırda Kaynak (Bölüm kuralı, Araç önerisi, İlk öneri onaylandı, Listeden başka öneri, Elle yazıldı, 410, 410 (araç öneri vermişti)) ve aracın en iyi önerisini (adres, güven, puan, neden) gösterir. Öneri her eşleştirmede tekrar hesaplanır: sütun o anki öneriyi gösterir, onay anındaki öneriyi değil.
- v0.8.1: Yeni bağımlılık yok.
- v0.8.1: Sıra değişmedi (kullanıcı onayladı). Önce v0.8.0 301 haritası gerçek sitede denenir. Sonra yapılacaklar listesi, sonra Parça 3. Sprint 4 (AI) sonra konuşulur. Neden: AI'ın faydasını ölçmek için haritanın gerçek sitede neyi kaçırdığını bilmek gerekir.
- v0.8.1: Sprint 4 ön görüşmesi (11 Ekim 2026, karar değil, not). Fiyat (1M token, girdi/çıktı): Haiku 5.5 $0.10/$0.50, Sonnet 5.5 $2/$10, Opus 5.5 $4/$20. Batch API %50 indirim. Tahmin: 2.000 sayfa title/meta Haiku ile yaklaşık $0.43, Sonnet ile $8.60. Öneri: ilk AI özelliği 301 eşleştirmede anlam benzerliği. Aylık üst sınır Console workspace sınırı ile olur (Render diski kalıcı değil, uygulama sayacı sıfırlanır). Render'daki anahtar Cihan'ındır, Render'dan yapılan AI işleri Cihan'a yazılır. SDK gerekmez (Node 20 fetch). Fiyatları Sprint 4 başında tekrar kontrol et.
- v0.8.1: Arkadaş ayrı branch'te çalışır ve Pull Request açar. Kullanıcı kontrol eder ve merge eder. `main` dalına doğrudan yazılmaz.

- v0.8.0: Adım sırası değişti (kullanıcı onayladı): Proje → Tarama → Eşleştirme → 301 haritası → Yapılacaklar → (sonra) Canlıya çıkış → Canlı doğrulama. Neden: Yapılacaklar haritaya bağlıdır ("301 kurun" mu, "sayfayı oluşturun" mu).
- v0.8.0: Haritaya giren sayfalar: bölüm kuralı ile taşınan ve hedefi var olan sayfalar ("Kural", kendiliğinden), yeni adresi olmayan sayfalar (Kayboldu, Hedef yok, Bölüm kaldırıldı, hedefi kırık yönlendirme). Aynı yolda açılan veya doğru yönlenen sayfa haritaya girmez.
- v0.8.0: Öneri puanı 0-100. İki parça: alan puanı (slug 0.4, title 0.3, H1 0.15, içerik 0.15; eksik alan hesaba girmez) ve bütün kelimelerin tek torba benzerliği (`bagWeight` 0.5). Kelime ağırlığı nadirliğe göredir (IDF): yeni sayfalarda ve eski sayfalarda çok geçen kelime (istanbul, prosedur) az sayar. Benzerlik: yarı Dice, yarı daha iyi kapsanan tarafın kapsama oranı (kısa yeni slug `/facelift` uzun eski slug `facelift-turkey` ile güçlü eşleşir).
- v0.8.0: Kelime eşleşmesi: aynı kelime 1, ortak önek (en az 5 harf, kısa kelimenin %75'i) 0.8, yakın yazım (ilk harf aynı, düzenleme benzerliği en az %70) 0.7. Türkçe harfler ve aksanlar sadeleşir (ğ→g, ı→i, à→a). Sayılar ve `stopWords` puana girmez.
- v0.8.0: Aynı bölüm bonusu: bir eski bölümün iyi eşleşmelerinin çoğu tek yeni bölüme gidiyorsa (en az 2 eşleşme, %60) o bölümdeki adaylar +10 puan alır (/prosedur/ → /procedures/).
- v0.8.0: Bölüm kararı (kural bir siteye gidiyorsa) aramayı o siteye sınırlar. Türkçe sayfa için İngilizce sayfa önerilmez.
- v0.8.0: Ana sayfa, noindex sayfa ve yönlendirme aday olmaz. Araç ana sayfaya toplu 301 önermez (soft 404). Öneri yoksa kullanıcı adres seçer veya 410 verir.
- v0.8.0: Hız: aday arama kelime dizini ile yapılır. Aday sayfaların %30'undan fazlasında geçen kelime aramada kullanılmaz. Her eski sayfa için en fazla `maxScored` (40) aday tam puan alır.
- v0.8.0: Projede sadece kullanıcı kararları saklanır (`project.map`: eski yol → `{ site, path }`, `{ url }` veya `{ gone }`, `src`: oneri/elle). Öneriler her eşleştirmede tekrar hesaplanır. Kararı değiştirmek için `POST /map` kullanılır. Proje `PUT` haritayı değiştirmez (tarayıcıdaki eski kopya yeni kararı silmez). Silinen sitenin kararları düşer. "Projeyi indir" ve "Proje yükle" kararları taşır.
- v0.8.0: Yeni URL canlı alan adı ile yazılır: geçecek site için eski alan adı, ek site için projede yazılan "canlı alan adı". Canlı alan adı yoksa tarama adresi yazılır ve ekran uyarır.
- v0.8.0: Onaylanan hedef son taramada yoksa satır uyarı verir. Artık gerekli olmayan karar (eski sayfa yok veya sayfa bulundu) listeye girmez; ekran sayısını yazar.
- v0.8.0: CSV sadece son listeyi verir: Kural ve Onay satırları 301, 410 satırları boş yeni URL ile. UTF-8 BOM eklenir (Excel Türkçe harfleri doğru açar). `=`, `+`, `-`, `@` ile başlayan değerin önüne `'` eklenir (CSV formül koruması). Excel'deki "301 haritası" sayfası bütün satırları durumları ile verir.
- v0.8.0: "Bulunamadı" bölümü artık sıradaki işi engellemez. 301 haritası her sayfa için öneri verir. Bölüm başka siteye gidiyorsa kullanıcı siteyi seçer, bu seçim aramayı o siteye sınırlar.
- v0.8.0: Yeni bağımlılık yok. Benzerlik hesabı (IDF, Dice, düzenleme mesafesi) kendi kodumuzdur.

- v0.7.1: "Bulunamadı" ile "kaldırıldı" ayrıdır. Öneri motoru "Bölüm kaldırıldı" önermez. Hiçbir taşıma bölümü bulamazsa öneri `notFound: true` alır, bölüm "Karar verin" der, satır "Bulunamadı · Adresler değişmiş olabilir" yazar. "Bölüm kaldırıldı" seçeneği listede kalır, kullanıcı seçer.
- v0.7.1: Bazı sayfaları bulan en iyi taşıma ipucu olur ("Öneri: Türkçe · /tr/ kalkar"). İpucu kendiliğinden uygulanmaz. Bölümün kendi ana sayfası (`/fr` → `/`) kanıt sayılmaz, çünkü her sitede kök sayfa vardır. İpucu için en az bir başka sayfa bulunmalı.
- v0.7.1: Bölüm satırı açılır ("Sayfaları göster"). Her eski sayfa durumu ve adresi ile listelenir. Bulunan sayfa yeni adresini, bulunamayan sayfa aranan adresi ve nedenini gösterir. Bulunamayanlar önce gelir. Liste sınırı `compare.sectionPageLimit` (200), bütün liste Excel'de. API: `sections[].pageList`, `sections[].more`.
- v0.7.1: Etiket rengi: yeşil = sayfa yerinde (aynı, içerik değişti, yönleniyor, 301 kurulu). Amber = iş gerekli (301 eksik, hedef yok, bulunamadı, linksiz, kontrol edilemedi, bölüm kaldırıldı).
- v0.7.1: İki sayı, iki etiket. Seçim listesinde "taramada 3 / 7" (sadece tarama, istek yok). Sonuç sütununda "3 / 7 bulundu" (araç her adresi tek tek istedikten sonra). "Sonuç ?" açıklaması farkı anlatır. Tek sayıya indirilmedi: seçenek sayıları istek atmadan hesaplanır.
- v0.7.1: "Diğer sayfalar" yerine "Kök ve küçük bölümler" (yanında "?" açıklaması).
- v0.7.1: Mobil taşma düzeltmesi: adım çubuğundaki gizli `.sr` etiketleri (position: absolute) sayfayı 909 px genişletiyordu (v0.7.0 hatası). `.steps` artık `position: relative`.

- v0.7.0: Model düzeltmesi. Başka yola veya başka siteye taşınan sayfa artık "Aynı kaldı" sayılmaz. İki kontrol: hedef sayfa var mı, eski yol "eski alan adına geçecek site" üzerinde hedefe 301 veriyor mu. Sonuç: "Hedef hazır, 301 kurulu" (`moved`), "Hedef hazır, 301 eksik" (`no301`), "Hedef yok" (`notarget`). Korunan oran `moved` sayfaları da sayar. Kural istatistiğinde `no301` "bulundu" sayılır (hedef var).
- v0.7.0: 301 kontrolü Location başlığına göre yapılır. Geçecek sitede sadece aynı hosttaki adımlar izlenir. Başka hosta giden ilk adımda durulur, çünkü hedef site canlıda olmayabilir. Kabul edilen 301 hedefi: hedef sitenin tarama alan adı, projede yazılan "canlı alan adı" veya (hedef geçecek site ise) eski alan adı. Yol eşleşir ama alan adı bilinmiyorsa "301 eksik" olur ve "canlı alan adını projeye yazın" der. İstekler sadece taranan sitelere gider (SSRF yüzeyi büyümez).
- v0.7.0: Geçecek site taramasında eski yol yönlendirme olarak varsa (link ile bulunduysa) istek atılmaz, tarama sonucu kullanılır.
- v0.7.0: Proje `crawls/projects/<id>.json` dosyasında durur (crawls/ zaten .gitignore ve .dockerignore içinde). Yazma atomiktir: önce geçici dosya, sonra rename. Aynı projeye yazmalar sıraya girer.
- v0.7.0: Projede kural hedefi site anahtarıdır (`heir`, `s1`…), alan adı değildir. Motor için sitenin tarama alan adına çevrilir. Staging adresi değişse de kural geçerli kalır.
- v0.7.0: Tarama düğmesi taramayı başlatır, proje `pendingCrawlId` tutar. Tarama bitince `crawlId` yazılır. Hata olursa `lastError` yazılır ve eski tarama korunur. Site durumu: taranmadı, taranıyor, tamam, silinmiş, adres değişti. Proje ekranı taranırken 2 saniyede bir sunucuya sorar (SSE yerine basit).
- v0.7.0: Eşleştirme iki geçişte çalışır. Önce istek atmadan öneriler bulunur. Taşıma önerisi (bölüm başka yerde bulunur) kararsız bölüme uygulanır ve "Öneri" etiketi alır, kaydedilmez. "Bölüm kaldırıldı" önerisi uygulanmaz: bölüm "Karar verin" der ve amber "Öneri: …" etiketi alır. Kullanıcı seçince bölüm kuralı kaydedilir.
- v0.7.0: Bölüm tablosu ilk yol parçasına göre gruplar (en az `suggestMinPages` sayfa). Küçük gruplar "Diğer sayfalar" (`/*`) satırına girer. Her seçenek taramalarda bulduğu sayfa sayısını gösterir (istek atmaz).
- v0.7.0: "Karşılaştır" ekranı kaldırıldı. Yerine taşıma projesi geldi. Serbest kural editörü Eşleştirme adımında "Gelişmiş" altında. `#/compare` linki giriş ekranını "Taşıma projesi" seçili açar. `/api/compare` API olarak kaldı.
- v0.7.0: Giriş ekranından eski/yeni etiket seçimi kaldırıldı. Proje taramaları etiketi kendisi alır (eski site `eski`, diğerleri `yeni`). Kenar çubuğu: önce projeler, sonra projeye bağlı olmayan taramalar.
- v0.7.0: v0.6.1 tarayıcı kuralları (localStorage) proje kuralsız iken "Projeye aktar" ile aktarılır. Hedef alan adı projede yoksa kural atlanır ve kullanıcıya yazılır.
- v0.7.0: "Projeyi indir" sadece tanımı verir (sonuç ve sunucu alanları yok). "Proje yükle" yeni proje kimliği verir. Tarama kimlikleri dosyada kalır; taramalar sunucuda yoksa proje "Silinmiş: Tekrar tara" der.
- v0.7.0: Kural metninde "ana hedef" kalktı. Motor, geçecek sitenin alan adını yazar (`/en/* → staging.ornek.com/*`).

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
5. İş sonunda: bu dosyadaki Durum ve Karar günlüğü bölümlerini güncelle, `package.json` sürümünü artır. Kullanıcıya görünen özellik değiştiyse `README.md` içindeki ilgili bölümü de güncelle. README başlığına sürüm yazma.
6. Kullanıcıya bir zip ver. Zip sadece değişen ve yeni dosyaları, depodaki klasör yapısı ile içerir. Silinmesi gereken dosya varsa adlarını ayrıca yaz. Kısa bir commit mesajı öner.
7. Kullanıcı GitHub'da Add file → Upload files ile zip içeriğini sürükler ve commit yapar. Gizli dosyalar (nokta ile başlayan) değiştiyse Claude içeriklerini metin olarak da verir; kullanıcı bunları web'de düzenler.

Claude Code ile (masaüstü): Claude yerel depo klasöründe doğrudan çalışır, commit yapar. Zip ve 6-7. adımlar gerekmez. Push kullanıcı onayı ile yapılır.

8. Kullanıcı gerçek bir sitede dener ve geri bildirim verir. Eşikler `rules.json` ile kalibre edilir.

## İki kişi çalışma kuralları

Depoda iki kişi çalışır: kullanıcı (Cihan) ve bir arkadaş. Arkadaş Claude kullanmaz.

Arkadaş:
1. Her iş için `main` dalından yeni bir branch açar. `main` dalına doğrudan yazmaz.
2. İş sonunda bu dosyadaki Durum ve Karar günlüğü bölümlerini günceller.
3. `npm test` çalıştırır. Testler geçmeden Pull Request açmaz.
4. Pull Request açar. Açıklamaya ne değiştiğini ve nasıl denediğini yazar.
5. Bu dosyadaki bütün kurallara uyar (eşikler `rules.json` içinde, yeni kural için test sayfası ve beklenti, yeni bağımlılık için gerekçe, Türkçe kısa metin).

Kullanıcı (Cihan):
1. Pull Request kontrolünü Claude ile yapar.
2. Claude branch'i klonlar: `git clone -b <branch> https://github.com/Cihanpehlivan/seo-audit.git`.
3. Claude `npm install` ve `npm test` çalıştırır.
4. Claude değişikliği bu dosyadaki kurallara göre inceler: testler, `/temiz` sayfası, eşikler, bağımlılık, XSS (`esc()`), gizli bilgi, Durum ve Karar günlüğü güncel mi. Arayüz değiştiyse ekran görüntüsü alır (1440 px ve 390 px).
5. Claude bulguları listeler. Kullanıcı merge eder veya değişiklik ister.

Ortak kurallar:
- Aynı anda iki kişi aynı dosyada büyük değişiklik yapmaz. İş başlamadan kim neyi yapıyor, kısaca konuşulur.
- `package.json` sürümünü merge sırasında kullanıcı belirler. İki branch aynı sürüm numarasını almaz.
- Depoya gizli bilgi girmez. Her kişi kendi `.env` dosyasını kullanır.
