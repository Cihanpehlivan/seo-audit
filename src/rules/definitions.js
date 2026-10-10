// All audit rules. Each rule returns a list of { url, detail }.
// severity: critical | warning | notice    team: SEO | İçerik | Frontend | Backend
import robotsParser from 'robots-parser';
import { isOk, isHtml, isNoindex, isCanonicalized, isIndexable, titlePx, isStagingHost, hostOf, sameSite, groupBy, short, isBroken, resLabel, tlsErrorText, isTlsError } from './helpers.js';
import { hamming } from '../fingerprint.js';

export const CATEGORIES = [
  ['crawl', 'Tarama ve indeks'], ['redirect', 'Redirect'], ['canonical', 'Canonical'],
  ['title', 'Title'], ['description', 'Meta description'], ['headings', 'Başlık hiyerarşisi'],
  ['content', 'İçerik'], ['links', 'Linkler'], ['images', 'Görseller'], ['hreflang', 'Hreflang'],
  ['schema', 'Yapısal veri'], ['performance', 'Performans'], ['https', 'HTTPS'],
  ['a11y', 'Mobil ve erişilebilirlik'], ['url', 'URL yapısı'],
];

const R = [];
const rule = (def) => R.push(def);
const list5 = (arr, fmt) => arr.slice(0, 5).map(fmt).join('\n') + (arr.length > 5 ? `\n+${arr.length - 5} daha` : '');
const siteRan = (c) => !!c.checks?.ran?.site && !!c.checks.site;
const each = (list, fn) => list.flatMap((p) => { const r = fn(p); return r ? [{ url: p.url, detail: r === true ? '' : r }] : []; });

// ---------- Tarama ve indeks ----------
rule({ id: 'http-4xx', category: 'crawl', severity: 'critical', team: 'Backend',
  title: '4xx hata veren sayfa', description: 'Sayfa 4xx durum kodu döndürüyor. Kullanıcı ve Google sayfaya ulaşamaz.',
  fix: 'Sayfayı geri getirin veya ilgili yeni sayfaya 301 yapın. Bu URL\'ye giden linkleri düzeltin.',
  run: (c) => each(c.pages, (p) => !p.redirectChain?.length && p.status >= 400 && p.status < 500 && `${p.status}${p.foundOn ? ' · bulunduğu sayfa: ' + p.foundOn : ''}`) });
rule({ id: 'http-5xx', category: 'crawl', severity: 'critical', team: 'Backend',
  title: '5xx sunucu hatası', description: 'Sunucu sayfayı üretemiyor.', fix: 'Sunucu loglarını kontrol edin. Hatayı düzeltin.',
  run: (c) => each(c.pages, (p) => !p.redirectChain?.length && p.status >= 500 && `${p.status}`) });
rule({ id: 'http-failed', category: 'crawl', severity: 'critical', team: 'Backend',
  title: 'Bağlantı hatası veya zaman aşımı', description: 'Sayfa hiç yanıt vermedi.', fix: 'Sunucu, DNS ve güvenlik duvarı ayarlarını kontrol edin.',
  run: (c) => each(c.pages, (p) => p.status === 0 && (p.error || 'yanıt yok')) });
rule({ id: 'robots-blocks-site', category: 'crawl', severity: 'critical', team: 'SEO', scope: 'site',
  title: 'robots.txt bütün siteyi Google\'a kapatıyor', description: 'Googlebot ana sayfayı tarayamaz. Staging ayarı canlıda kalmış olabilir.',
  fix: 'robots.txt dosyasındaki "Disallow: /" satırını kaldırın.',
  run: (c) => c.robots && c.robots.isAllowed(c.meta.startUrl, 'Googlebot') === false ? [{ url: c.meta.robots.url, detail: 'Googlebot için Disallow' }] : [] });
rule({ id: 'noindex-in-sitemap', category: 'crawl', severity: 'warning', team: 'SEO',
  title: 'noindex sayfa sitemap\'te', description: 'Sitemap "bu sayfayı indeksle" der, sayfa "indeksleme" der. Sinyaller çelişiyor.',
  fix: 'Sayfayı sitemap\'ten çıkarın veya noindex etiketini kaldırın.',
  run: (c) => each(c.pages, (p) => p.inSitemap && isOk(p) && isNoindex(p)) });
rule({ id: 'blocked-in-sitemap', category: 'crawl', severity: 'warning', team: 'SEO',
  title: 'robots.txt ile engelli URL sitemap\'te', description: 'Google bu URL\'yi tarayamaz ama sitemap URL\'yi önerir.',
  fix: 'URL\'yi sitemap\'ten çıkarın veya robots.txt engelini kaldırın.',
  run: (c) => each(c.pages, (p) => p.inSitemap && p.blockedByRobots) });
rule({ id: 'sitemap-non200', category: 'crawl', severity: 'warning', team: 'SEO',
  title: 'Sitemap\'te 200 olmayan URL', description: 'Sitemap sadece indekslenebilir 200 sayfaları içermeli.',
  fix: 'Redirect ve hata veren URL\'leri sitemap\'ten çıkarın. Redirect yerine hedef URL\'yi yazın.',
  run: (c) => each(c.pages, (p) => p.inSitemap && !p.blockedByRobots && p.status !== 200 && `${p.status}`) });
rule({ id: 'indexable-not-in-sitemap', category: 'crawl', severity: 'notice', team: 'SEO',
  title: 'İndekslenebilir sayfa sitemap\'te yok', description: 'Sayfa indekslenebilir ama sitemap\'te yer almıyor.',
  fix: 'Sayfayı sitemap\'e ekleyin. Sitemap otomatik üretiliyorsa CMS ayarını kontrol edin.',
  run: (c) => c.meta.sitemap.urlCount ? each(c.indexable, (p) => !p.inSitemap) : [] });
rule({ id: 'orphan-page', category: 'crawl', severity: 'warning', team: 'SEO',
  title: 'Yetim sayfa', description: 'Sayfaya site içinden hiç link yok. Sadece sitemap\'te bulundu.',
  fix: 'İlgili sayfalardan bu sayfaya iç link verin veya sayfa gereksizse kaldırın.',
  run: (c) => each(c.pages, (p) => p.orphan && isOk(p)) });
rule({ id: 'deep-page', category: 'crawl', severity: 'notice', team: 'SEO',
  title: 'Derin sayfa', description: 'Sayfa ana sayfadan çok tık uzakta. Google ve kullanıcı zor bulur.',
  fix: 'Menü, kategori veya ilgili içerik linkleri ile sayfayı yukarı taşıyın.',
  run: (c) => each(c.indexable, (p) => p.depth != null && p.depth > c.T.maxDepth && `${p.depth} tık`) });
rule({ id: 'soft-404', category: 'crawl', severity: 'warning', team: 'Backend',
  title: 'Soft 404', description: 'Sayfa "bulunamadı" içeriği gösteriyor ama 200 kodu döndürüyor.',
  fix: 'Bulunamayan sayfalar için sunucu 404 döndürmeli.',
  run: (c) => each(c.pages, (p) => isOk(p) && p.url !== c.meta.startUrl &&
    /\b404\b|bulunamad|not found|sayfa yok|mevcut değil|page doesn.t exist/i.test(`${p.title} ${(p.h1 || []).join(' ')}`) && short(p.title || p.h1?.[0])) });
rule({ id: 'ai-bots-blocked', category: 'crawl', severity: 'notice', team: 'SEO', scope: 'site',
  title: 'AI botları robots.txt ile engelli', description: 'ChatGPT, Claude, Perplexity gibi AI arama botları siteyi okuyamaz. Bu bilinçli bir karar olabilir.',
  fix: 'AI aramalarında görünmek istiyorsanız bu botlara izin verin. Karar müşteriyle birlikte verilmeli.',
  run: (c) => {
    if (!c.robots) return [];
    const blocked = c.cfg.aiBots.filter((b) => c.robots.isAllowed(c.meta.startUrl, b) === false);
    return blocked.length ? [{ url: c.meta.robots.url, detail: blocked.join(', ') }] : [];
  } });
rule({ id: 'llms-txt-missing', category: 'crawl', severity: 'notice', team: 'SEO', scope: 'site',
  title: 'llms.txt dosyası yok', description: 'AI asistanlar için hazırlanan site özeti dosyası bulunamadı. Bu dosya zorunlu değildir.',
  fix: 'Kök dizine sitenin ana sayfalarını listeleyen bir /llms.txt dosyası ekleyin. Kararı müşteriyle verin.',
  run: (c) => siteRan(c) && c.checks.site.llms.status && !c.checks.site.llms.ok ? [{ url: c.checks.site.llms.url, detail: `${c.checks.site.llms.status}${/html/i.test(c.checks.site.llms.contentType) ? ' · HTML sayfa döndü' : ''}` }] : [] });

// ---------- Redirect ----------
rule({ id: 'redirect-chain', category: 'redirect', severity: 'warning', team: 'Backend',
  title: 'Redirect zinciri', description: 'URL hedefe birden fazla yönlendirme ile ulaşıyor. Hız ve link değeri kaybı olur.',
  fix: 'İlk URL\'yi doğrudan son hedefe 301 ile yönlendirin.',
  run: (c) => each(c.pages, (p) => p.redirectChain?.length > 1 && !p.error && `${p.redirectChain.length} hop → ${p.finalUrl}`) });
rule({ id: 'redirect-loop', category: 'redirect', severity: 'critical', team: 'Backend',
  title: 'Redirect döngüsü', description: 'Yönlendirmeler birbirine dönüyor. Sayfa hiç açılmaz.',
  fix: 'Yönlendirme kurallarını düzeltin. Her URL tek bir son hedefe gitmeli.',
  run: (c) => each(c.pages, (p) => (p.error === 'redirect-loop' || p.error === 'too-many-redirects') && p.redirectChain.map((h) => h.url).join(' → ')) });
rule({ id: 'redirect-broken', category: 'redirect', severity: 'critical', team: 'Backend',
  title: 'Redirect hata veren sayfaya gidiyor', description: 'Yönlendirme hedefi 4xx/5xx döndürüyor.',
  fix: 'Yönlendirmeyi çalışan bir sayfaya çevirin.',
  run: (c) => each(c.pages, (p) => p.redirectChain?.length && !p.error && (p.finalStatus >= 400 || p.finalStatus === 0) && `${p.finalUrl} (${p.finalStatus})`) });
rule({ id: 'redirect-temporary', category: 'redirect', severity: 'warning', team: 'Backend',
  title: 'Geçici yönlendirme (302/307)', description: 'Kalıcı taşınan sayfa için 302 kullanılırsa Google eski URL\'yi tutabilir.',
  fix: 'Taşıma kalıcı ise 301 veya 308 kullanın.',
  run: (c) => each(c.pages, (p) => p.redirectChain?.some((h) => h.status === 302 || h.status === 307) && p.redirectChain.map((h) => h.status).join(' → ')) });
rule({ id: 'internal-link-to-redirect', category: 'redirect', severity: 'notice', team: 'İçerik',
  title: 'İç link redirect URL\'ye gidiyor', description: 'Sayfadaki link önce yönlendirmeye, sonra hedefe gidiyor.',
  fix: 'Linki doğrudan son hedef URL ile değiştirin.',
  run: (c) => c.htmlPages.flatMap((p) => {
    const targets = [...new Set((p.links || []).filter((l) => l.internal).map((l) => l.url))].filter((u) => c.byUrl.get(u)?.redirectChain?.length);
    return targets.length ? [{ url: p.url, detail: targets.slice(0, 5).map((u) => `${u} → ${c.byUrl.get(u).finalUrl}`).join('\n') + (targets.length > 5 ? `\n+${targets.length - 5} daha` : '') }] : [];
  }) });
rule({ id: 'trailing-slash-duplicate', category: 'redirect', severity: 'warning', team: 'Backend',
  title: 'Sonda / olan ve olmayan URL ikisi de açılıyor', description: '/sayfa ve /sayfa/ ayrı sayfa gibi açılıyor. Kopya içerik oluşur.',
  fix: 'Bir biçimi seçin. Diğerini 301 ile ona yönlendirin.',
  run: (c) => {
    const ok = new Set(c.okPages.filter((p) => !isCanonicalized(p)).map((p) => p.url));
    return [...ok].filter((u) => !u.endsWith('/') && ok.has(u + '/')).map((u) => ({ url: u, detail: u + '/' }));
  } });
rule({ id: 'host-variant-duplicate', category: 'redirect', severity: 'critical', team: 'Backend', scope: 'site',
  title: 'Sitenin başka sürümü de açılıyor', description: 'http/https veya www/www olmayan sürüm yönlenmeden açılıyor. Google iki ayrı site görür ve içerik kopyalanır.',
  fix: 'Bütün sürümleri tek ana adrese 301 ile yönlendirin.',
  run: (c) => {
    if (!siteRan(c)) return [];
    const homeOrigin = new URL(c.checks.site.home).origin;
    return c.checks.site.variants.filter((v) => !v.error && v.finalStatus === 200 && (v.hops === 0 || new URL(v.finalUrl).origin !== homeOrigin))
      .map((v) => ({ url: v.url, detail: v.hops ? `${v.chain.join(' → ')} → ${v.finalUrl} (200)` : '200 döndürüyor, yönlenmiyor' }));
  } });
rule({ id: 'host-variant-redirect', category: 'redirect', severity: 'warning', team: 'Backend', scope: 'site',
  title: 'Site sürümü ana adrese doğru yönlenmiyor', description: 'Sürüm ana adrese geçici yönlendirme, zincir veya sertifika hatası ile gidiyor.',
  fix: 'Her sürümü tek adımda, 301 ile ana adrese yönlendirin. https sürümleri için sertifikayı kontrol edin.',
  run: (c) => {
    if (!siteRan(c)) return [];
    const { home, homeHops } = c.checks.site;
    return c.checks.site.variants.flatMap((v) => {
      if (v.error) return isTlsError(v.error) ? [{ url: v.url, detail: 'sertifika hatası: ' + tlsErrorText(v.error) }] : [];
      if (!v.hops || v.finalUrl !== home) return [];
      const why = [[302, 307].includes(v.chain[0]) && 'geçici yönlendirme', v.hops > homeHops + 1 && `${v.hops} adım`].filter(Boolean);
      return why.length ? [{ url: v.url, detail: `${why.join(', ')} · ${v.chain.join(' → ')} → ${v.finalUrl}` }] : [];
    });
  } });

// ---------- Canonical ----------
rule({ id: 'canonical-missing', category: 'canonical', severity: 'warning', team: 'Frontend',
  title: 'Canonical etiketi yok', description: 'Sayfa hangi URL\'nin asıl sürüm olduğunu belirtmiyor.',
  fix: 'Her sayfaya kendini gösteren (self-referencing) canonical ekleyin.',
  run: (c) => each(c.okPages, (p) => !p.canonical && !isNoindex(p)) });
rule({ id: 'canonical-multiple', category: 'canonical', severity: 'critical', team: 'Frontend',
  title: 'Birden fazla canonical', description: 'Sayfada birden fazla canonical var. Google hepsini yok sayabilir.',
  fix: 'Tek bir canonical etiketi bırakın. Tema ve SEO eklentisinin ikisi de ekliyor olabilir.',
  run: (c) => each(c.okPages, (p) => p.canonicalCount > 1 && `${p.canonicalCount} adet`) });
rule({ id: 'canonicalized', category: 'canonical', severity: 'notice', team: 'SEO',
  title: 'Canonical başka URL\'yi gösteriyor', description: 'Sayfa asıl sürüm olarak başka bir URL\'yi gösteriyor. Bu sayfa indekslenmez.',
  fix: 'Bilinçli değilse canonical\'ı sayfanın kendi URL\'si yapın.',
  run: (c) => each(c.okPages, (p) => isCanonicalized(p) && `→ ${p.canonical}`) });
rule({ id: 'canonical-target-bad', category: 'canonical', severity: 'critical', team: 'SEO',
  title: 'Canonical hedefi indekslenemiyor', description: 'Canonical, hata veren, yönlenen, noindex veya engelli bir URL\'yi gösteriyor.',
  fix: 'Canonical\'ı 200 dönen ve indekslenebilir bir URL\'ye çevirin.',
  run: (c) => each(c.okPages, (p) => {
    if (!isCanonicalized(p)) return false;
    const t = c.byUrl.get(p.canonical);
    if (!t) return false;
    if (t.blockedByRobots) return `${p.canonical} (robots engeli)`;
    if (t.status !== 200 || t.redirectChain?.length) return `${p.canonical} (${t.status})`;
    if (isNoindex(t)) return `${p.canonical} (noindex)`;
    return false;
  }) });
rule({ id: 'noindex-canonical-conflict', category: 'canonical', severity: 'warning', team: 'SEO',
  title: 'noindex ve canonical çelişkisi', description: 'Sayfa hem noindex hem başka URL\'ye canonical. Google iki farklı sinyal alır.',
  fix: 'Sadece birini kullanın: kopya sayfa ise canonical, gizlenecek sayfa ise noindex.',
  run: (c) => each(c.okPages, (p) => isNoindex(p) && isCanonicalized(p) && `→ ${p.canonical}`) });

// ---------- Title ----------
rule({ id: 'title-missing', category: 'title', severity: 'critical', team: 'İçerik',
  title: 'Title eksik veya boş', description: 'Google arama sonucunda sayfa başlığını kendisi üretir.',
  fix: 'Her sayfaya benzersiz, anahtar kelime içeren bir title yazın.',
  run: (c) => each(c.okPages, (p) => !p.title) });
rule({ id: 'title-too-long', category: 'title', severity: 'warning', team: 'İçerik',
  title: 'Title çok uzun', description: 'Title arama sonucunda kesilir.',
  fix: 'Title\'ı yaklaşık 50–60 karaktere indirin. Önemli kelimeyi başa alın.',
  run: (c) => each(c.okPages, (p) => p.title && (titlePx(p.title) > c.T.titleMaxPx || p.title.length > c.T.titleMaxChars + 10) && `${p.title.length} karakter, ~${titlePx(p.title)} px`) });
rule({ id: 'title-too-short', category: 'title', severity: 'notice', team: 'İçerik',
  title: 'Title çok kısa', description: 'Kısa title, arama sonucunda alanı iyi kullanmaz.',
  fix: 'Title\'a sayfanın konusunu ve markayı ekleyin.',
  run: (c) => each(c.okPages, (p) => p.title && p.title.length < c.T.titleMinChars && `${p.title.length} karakter: ${p.title}`) });
rule({ id: 'title-duplicate', category: 'title', severity: 'warning', team: 'İçerik',
  title: 'Tekrar eden title', description: 'Birden fazla sayfa aynı title\'ı kullanıyor. Google hangisini göstereceğini seçemez.',
  fix: 'Her sayfaya benzersiz title yazın.',
  run: (c) => [...groupBy(c.indexable, (p) => p.title.toLowerCase())].filter(([, g]) => g.length > 1)
    .flatMap(([, g]) => g.map((p) => ({ url: p.url, detail: `"${short(p.title, 60)}" · ${g.length} sayfa` }))) });
rule({ id: 'title-multiple', category: 'title', severity: 'warning', team: 'Frontend',
  title: 'Birden fazla title etiketi', description: 'Sayfada birden fazla <title> var.',
  fix: 'Tek bir title bırakın. SVG içindeki <title> etiketleri bunu tetiklemez.',
  run: (c) => each(c.okPages, (p) => p.titleCount > 1 && `${p.titleCount} adet`) });
rule({ id: 'title-equals-h1', category: 'title', severity: 'notice', team: 'İçerik',
  title: 'Title ve H1 birebir aynı', description: 'Hata değildir. Ama title ve H1 farklı olursa daha fazla anahtar kelime kapsanır.',
  fix: 'Title\'ı arama sonucuna, H1\'i sayfa okuyucusuna göre yazın.',
  run: (c) => each(c.okPages, (p) => p.title && p.h1?.[0] && p.title.trim().toLowerCase() === p.h1[0].trim().toLowerCase()) });
rule({ id: 'title-brand-inconsistent', category: 'title', severity: 'notice', team: 'İçerik', scope: 'site',
  title: 'Title marka eki tutarsız', description: 'Sayfaların çoğu title sonunda aynı marka ekini kullanıyor, bazıları kullanmıyor.',
  fix: 'Bütün sayfalarda aynı ek biçimini kullanın. Örnek: "Sayfa adı | Marka".',
  run: (c) => {
    const withTitle = c.indexable.filter((p) => p.title);
    if (withTitle.length < 5) return [];
    const suffix = (t) => { const m = /\s[|\-–—•·]\s([^|\-–—•·]{2,40})$/.exec(t); return m ? m[1].trim().toLowerCase() : null; };
    const counts = new Map();
    for (const p of withTitle) { const s = suffix(p.title); if (s) counts.set(s, (counts.get(s) || 0) + 1); }
    const [top, n] = [...counts].sort((a, b) => b[1] - a[1])[0] || [];
    if (!top || n / withTitle.length < 0.6) return [];
    return withTitle.filter((p) => suffix(p.title) !== top && p.url !== c.meta.startUrl).map((p) => ({ url: p.url, detail: `beklenen ek: "${top}" · title: ${short(p.title, 60)}` }));
  } });

// ---------- Meta description ----------
rule({ id: 'desc-missing', category: 'description', severity: 'warning', team: 'İçerik',
  title: 'Meta description eksik', description: 'Google arama sonucundaki açıklamayı sayfadan rastgele seçer.',
  fix: 'Her sayfaya 120–160 karakter, tıklamaya teşvik eden bir açıklama yazın.',
  run: (c) => each(c.indexable, (p) => !p.metaDescription) });
rule({ id: 'desc-too-long', category: 'description', severity: 'notice', team: 'İçerik',
  title: 'Meta description çok uzun', description: 'Açıklama arama sonucunda kesilir.',
  fix: 'Açıklamayı 160 karakterin altına indirin.',
  run: (c) => each(c.indexable, (p) => p.metaDescription.length > c.T.descMaxChars && `${p.metaDescription.length} karakter`) });
rule({ id: 'desc-too-short', category: 'description', severity: 'notice', team: 'İçerik',
  title: 'Meta description çok kısa', description: 'Kısa açıklama kullanıcıyı ikna etmez.',
  fix: 'Açıklamayı 120 karakter civarına genişletin.',
  run: (c) => each(c.indexable, (p) => p.metaDescription && p.metaDescription.length < c.T.descMinChars && `${p.metaDescription.length} karakter`) });
rule({ id: 'desc-duplicate', category: 'description', severity: 'warning', team: 'İçerik',
  title: 'Tekrar eden meta description', description: 'Birden fazla sayfa aynı açıklamayı kullanıyor.',
  fix: 'Her sayfaya benzersiz açıklama yazın.',
  run: (c) => [...groupBy(c.indexable, (p) => p.metaDescription.toLowerCase())].filter(([, g]) => g.length > 1)
    .flatMap(([, g]) => g.map((p) => ({ url: p.url, detail: `"${short(p.metaDescription, 60)}" · ${g.length} sayfa` }))) });
rule({ id: 'desc-multiple', category: 'description', severity: 'warning', team: 'Frontend',
  title: 'Birden fazla meta description', description: 'Sayfada birden fazla description etiketi var.',
  fix: 'Tek bir etiket bırakın.',
  run: (c) => each(c.okPages, (p) => p.metaDescriptionCount > 1 && `${p.metaDescriptionCount} adet`) });

// ---------- Başlık hiyerarşisi ----------
rule({ id: 'h1-missing', category: 'headings', severity: 'warning', team: 'Frontend',
  title: 'H1 eksik', description: 'Sayfanın ana başlığı yok.',
  fix: 'Her sayfaya konuyu anlatan tek bir H1 ekleyin. Logo H1 olmamalı.',
  run: (c) => each(c.okPages, (p) => Array.isArray(p.h1) && p.h1.length === 0) });
rule({ id: 'h1-multiple', category: 'headings', severity: 'notice', team: 'Frontend',
  title: 'Birden fazla H1', description: 'Sayfada birden fazla H1 var. Ana konu belirsizleşir.',
  fix: 'Bir H1 bırakın. Diğerlerini H2 yapın.',
  run: (c) => each(c.okPages, (p) => p.h1?.length > 1 && `${p.h1.length} adet: ${p.h1.slice(0, 3).map((h) => short(h, 30)).join(' / ')}`) });
rule({ id: 'h1-duplicate', category: 'headings', severity: 'notice', team: 'İçerik',
  title: 'Tekrar eden H1', description: 'Birden fazla sayfa aynı H1\'i kullanıyor.',
  fix: 'Her sayfanın H1\'i kendi konusunu anlatmalı.',
  run: (c) => [...groupBy(c.indexable, (p) => (p.h1?.[0] || '').toLowerCase())].filter(([, g]) => g.length > 1)
    .flatMap(([, g]) => g.map((p) => ({ url: p.url, detail: `"${short(p.h1[0], 60)}" · ${g.length} sayfa` }))) });
rule({ id: 'heading-skip', category: 'headings', severity: 'notice', team: 'Frontend',
  title: 'Başlık seviyesi atlanıyor', description: 'Örnek: H2\'den sonra doğrudan H4 geliyor. Sayfa yapısı bozuk görünür.',
  fix: 'Başlıkları sırayla kullanın. Görünüm için CSS kullanın, başlık seviyesi için değil.',
  run: (c) => each(c.okPages, (p) => {
    if (!p.headings?.length) return false;
    const skips = [];
    for (let i = 1; i < p.headings.length; i++) {
      const a = p.headings[i - 1].l, b = p.headings[i].l;
      if (b > a + 1) skips.push(`H${a} → H${b} ("${short(p.headings[i].t, 30)}")`);
    }
    if (p.headings[0].l > 1 && !p.headings.some((h) => h.l === 1)) skips.unshift(`ilk başlık H${p.headings[0].l}`);
    return skips.length ? skips.slice(0, 4).join('\n') : false;
  }) });
rule({ id: 'heading-empty', category: 'headings', severity: 'warning', team: 'Frontend',
  title: 'Boş başlık etiketi', description: 'İçinde metin olmayan H1–H6 var.',
  fix: 'Boş başlıkları silin veya metin ekleyin.',
  run: (c) => each(c.okPages, (p) => p.emptyHeadings > 0 && `${p.emptyHeadings} adet`) });

// ---------- İçerik ----------
rule({ id: 'thin-content', category: 'content', severity: 'warning', team: 'İçerik',
  title: 'Az içerik', description: 'Ana içerik alanında çok az kelime var.',
  fix: 'Sayfaya kullanıcıya faydalı, özgün içerik ekleyin veya sayfayı başka sayfa ile birleştirin.',
  run: (c) => each(c.indexable, (p) => p.contentWordCount != null && p.url !== c.meta.startUrl && p.contentWordCount < c.T.thinContentWords && `${p.contentWordCount} kelime`) });
rule({ id: 'content-duplicate', category: 'content', severity: 'critical', team: 'İçerik',
  title: 'Birebir aynı içerik', description: 'Bu sayfaların ana içeriği tamamen aynı.',
  fix: 'Kopyaları kaldırın, 301 yapın veya canonical ile asıl sayfayı gösterin.',
  run: (c) => [...groupBy(c.indexable.filter((p) => p.contentWordCount >= 20), (p) => p.contentHash)].filter(([, g]) => g.length > 1)
    .flatMap(([, g]) => g.map((p) => ({ url: p.url, detail: 'aynı: ' + g.filter((x) => x !== p).slice(0, 3).map((x) => x.url).join(', ') }))) });
rule({ id: 'content-near-duplicate', category: 'content', severity: 'warning', team: 'İçerik',
  title: 'Çok benzer içerik', description: 'Sayfaların içeriği çok benziyor. Google birini seçip diğerini göstermeyebilir.',
  fix: 'İçerikleri farklılaştırın veya sayfaları birleştirin.',
  run: (c) => {
    const list = c.indexable.filter((p) => p.simhash);
    const hashes = new Set(); const pairs = new Map();
    // Band index: with d+1 bands, two hashes within distance d share at least one band exactly.
    const nb = c.T.nearDuplicateDistance + 1, size = Math.ceil(64 / nb);
    const bits = (h) => parseInt(h.slice(0, 8), 16).toString(2).padStart(32, '0') + parseInt(h.slice(8), 16).toString(2).padStart(32, '0');
    const bands = new Map();
    list.forEach((p, i) => { const b64 = bits(p.simhash); for (let b = 0; b < nb; b++) { const k = b + ':' + b64.slice(b * size, (b + 1) * size); (bands.get(k) || bands.set(k, []).get(k)).push(i); } });
    for (const idx of bands.values()) {
      if (idx.length < 2 || idx.length > 500) continue;
      for (let x = 0; x < idx.length; x++) for (let y = x + 1; y < idx.length; y++) {
        const a = list[idx[x]], b = list[idx[y]];
        const key = a.url < b.url ? a.url + '|' + b.url : b.url + '|' + a.url;
        if (hashes.has(key) || a.contentHash === b.contentHash) continue;
        hashes.add(key);
        const d = hamming(a.simhash, b.simhash);
        if (d <= c.T.nearDuplicateDistance) {
          for (const [p, q] of [[a, b], [b, a]]) (pairs.get(p.url) || pairs.set(p.url, []).get(p.url)).push(q.url);
        }
      }
    }
    return [...pairs].map(([url, others]) => ({ url, detail: 'benzer: ' + others.slice(0, 3).join(', ') + (others.length > 3 ? ` +${others.length - 3}` : '') }));
  } });
rule({ id: 'placeholder-text', category: 'content', severity: 'critical', team: 'İçerik',
  title: 'Dummy / lorem ipsum metin kaldı', description: 'Sayfada geliştirme sırasında kullanılan örnek metin var.',
  fix: 'Örnek metni gerçek içerik ile değiştirin.',
  run: (c) => each(c.okPages, (p) => p.placeholder && `"${p.placeholder}"`) });

// ---------- Linkler ----------
rule({ id: 'broken-internal-link', category: 'links', severity: 'critical', team: 'İçerik',
  title: 'Kırık iç link', description: 'Sayfada hata veren bir iç sayfaya link var.',
  fix: 'Linki doğru sayfa ile değiştirin veya kaldırın.',
  run: (c) => c.htmlPages.flatMap((p) => {
    const bad = [...new Set((p.links || []).filter((l) => l.internal).map((l) => l.url))].filter((u) => {
      const t = c.byUrl.get(u); return t && !t.redirectChain?.length && !t.blockedByRobots && (t.status >= 400 || t.status === 0);
    });
    return bad.length ? [{ url: p.url, detail: bad.slice(0, 5).map((u) => `${u} (${c.byUrl.get(u).status || 'hata'})`).join('\n') + (bad.length > 5 ? `\n+${bad.length - 5} daha` : '') }] : [];
  }) });
rule({ id: 'broken-external-link', category: 'links', severity: 'warning', team: 'İçerik',
  title: 'Kırık dış link', description: 'Sayfa, hata veren veya hiç açılmayan bir dış siteye link veriyor.',
  fix: 'Linki güncel adres ile değiştirin veya kaldırın.',
  run: (c) => !c.checks?.ran?.external ? [] : c.htmlPages.flatMap((p) => {
    const bad = [...new Set((p.links || []).filter((l) => !l.internal).map((l) => l.url))].filter((u) => isBroken(c.res.get(u), c.cfg));
    return bad.length ? [{ url: p.url, detail: list5(bad, (u) => `${u} (${resLabel(c.res.get(u))})`) }] : [];
  }) });
rule({ id: 'internal-nofollow', category: 'links', severity: 'notice', team: 'Frontend',
  title: 'İç linkte nofollow', description: 'Site kendi sayfalarına nofollow veriyor. Google bu sayfalara değer aktarmaz.',
  fix: 'İç linklerden rel="nofollow" kaldırın.',
  run: (c) => c.htmlPages.flatMap((p) => { const n = (p.links || []).filter((l) => l.internal && l.nofollow); return n.length ? [{ url: p.url, detail: `${n.length} link · ${short(n[0].url, 70)}` }] : []; }) });
rule({ id: 'anchor-generic', category: 'links', severity: 'notice', team: 'İçerik',
  title: 'Genel veya boş link metni', description: '"Tıklayın", "devamı" gibi link metinleri hedef sayfayı anlatmaz.',
  fix: 'Link metnini hedef sayfanın konusu ile yazın.',
  run: (c) => {
    const g = new Set(c.cfg.genericAnchors.map((x) => x.toLocaleLowerCase('tr')));
    return c.okPages.flatMap((p) => {
      const bad = (p.links || []).filter((l) => l.internal && (!l.anchor || g.has(l.anchor.toLocaleLowerCase('tr').replace(/[.…»›→>]+$/, '').trim())));
      return bad.length ? [{ url: p.url, detail: `${bad.length} link · ${[...new Set(bad.map((l) => l.anchor || '(boş)'))].slice(0, 4).join(', ')}` }] : [];
    });
  } });
rule({ id: 'too-many-links', category: 'links', severity: 'notice', team: 'Frontend',
  title: 'Sayfada çok fazla link', description: 'Çok fazla link, her linkin değerini azaltır.',
  fix: 'Mega menü ve footer linklerini sadeleştirin.',
  run: (c) => each(c.okPages, (p) => { const n = new Set((p.links || []).map((l) => l.url)).size; return n > c.T.maxLinksPerPage && `${n} benzersiz link`; }) });
rule({ id: 'staging-link', category: 'links', severity: 'critical', team: 'Frontend',
  title: 'Staging / test ortamına link', description: 'Sayfa test veya geliştirme ortamına link, canonical veya görsel ile bağlanıyor. Yenileme sonrası sık görülür.',
  fix: 'Bütün staging adreslerini canlı domain ile değiştirin. CMS içinde toplu arama yapın.',
  run: (c) => c.okPages.flatMap((p) => {
    const urls = [...(p.links || []).map((l) => l.url), p.canonical, p.ogImage, ...(p.hreflang || []).map((h) => h.url), ...(p.images || []).map((i) => i.src)].filter(Boolean);
    const bad = [...new Set(urls.filter((u) => { const h = hostOf(u); return h && !sameSite(h, c.meta.host) && isStagingHost(h, c.cfg); }))];
    return bad.length ? [{ url: p.url, detail: bad.slice(0, 4).join('\n') + (bad.length > 4 ? `\n+${bad.length - 4} daha` : '') }] : [];
  }) });
rule({ id: 'http-internal-link', category: 'links', severity: 'warning', team: 'İçerik',
  title: 'HTTPS sayfada http:// iç link', description: 'Link önce http adresine, sonra https\'e yönleniyor.',
  fix: 'İç linkleri https:// ile yazın veya göreli link kullanın.',
  run: (c) => c.okPages.filter((p) => p.url.startsWith('https:')).flatMap((p) => {
    const n = (p.links || []).filter((l) => l.internal && l.url.startsWith('http:'));
    return n.length ? [{ url: p.url, detail: `${n.length} link · ${short(n[0].url, 70)}` }] : [];
  }) });

// ---------- Görseller ----------
rule({ id: 'img-alt-missing', category: 'images', severity: 'warning', team: 'İçerik',
  title: 'Görselde alt metni yok', description: 'alt özelliği yok. Ekran okuyucu ve Google görseli anlamaz.',
  fix: 'Görseli anlatan alt metni yazın. Dekoratif görsellerde alt="" kullanın.',
  run: (c) => each(c.okPages, (p) => p.imgNoAlt > 0 && `${p.imgNoAlt} görsel`) });
rule({ id: 'img-alt-empty', category: 'images', severity: 'notice', team: 'İçerik',
  title: 'Görselde alt metni boş', description: 'alt="" sadece dekoratif görseller için doğrudur.',
  fix: 'İçerik taşıyan görsellere açıklayıcı alt metni yazın.',
  run: (c) => each(c.okPages, (p) => p.imgEmptyAlt > 0 && `${p.imgEmptyAlt} görsel`) });
rule({ id: 'img-legacy-format', category: 'images', severity: 'notice', team: 'Frontend',
  title: 'Görsel modern formatta değil', description: 'JPG/PNG/GIF görseller WebP veya AVIF\'e göre daha büyüktür.',
  fix: 'Görselleri WebP/AVIF olarak sunun veya <picture> ile alternatif verin.',
  run: (c) => each(c.okPages, (p) => { const n = (p.images || []).filter((i) => !i.modern && /\.(jpe?g|png|gif|bmp)(\?|$)/i.test(i.src)).length; return n > 0 && `${n} görsel`; }) });
rule({ id: 'img-no-dimensions', category: 'images', severity: 'notice', team: 'Frontend',
  title: 'Görselde width/height yok', description: 'Boyut belirtilmeyen görsel yüklenirken sayfa kayar (CLS).',
  fix: 'Görsellere width ve height özelliği ekleyin.',
  run: (c) => each(c.okPages, (p) => { const n = (p.images || []).filter((i) => !i.dims && i.src !== 'data:').length; return n > 0 && `${n} görsel`; }) });
rule({ id: 'img-broken', category: 'images', severity: 'warning', team: 'Frontend',
  title: 'Kırık görsel', description: 'Görsel yüklenmiyor. Sunucu hata döndürüyor veya dosya yok.',
  fix: 'Görsel adresini düzeltin veya görseli tekrar yükleyin. Yenileme sonrası eski görsel yollarını kontrol edin.',
  run: (c) => !c.checks?.ran?.images ? [] : c.okPages.flatMap((p) => {
    const bad = [...new Set((p.images || []).map((i) => i.src))].filter((u) => isBroken(c.res.get(u), c.cfg));
    return bad.length ? [{ url: p.url, detail: list5(bad, (u) => `${u} (${resLabel(c.res.get(u))})`) }] : [];
  }) });
rule({ id: 'img-too-large', category: 'images', severity: 'warning', team: 'İçerik',
  title: 'Büyük görsel dosyası', description: 'Görsel dosyası eşikten büyük. Sayfa yavaş açılır, mobilde veri harcar.',
  fix: 'Görseli sıkıştırın, WebP veya AVIF yapın ve gösterildiği boyuta küçültün.',
  run: (c) => !c.checks?.ran?.images ? [] : c.okPages.flatMap((p) => {
    const big = [...new Set((p.images || []).map((i) => i.src))].map((u) => c.res.get(u))
      .filter((r) => r && r.status && r.status < 400 && r.size > c.T.largeImageKb * 1024).sort((a, b) => b.size - a.size);
    return big.length ? [{ url: p.url, detail: list5(big, (r) => `${r.url} (${Math.round(r.size / 1024)} KB)`) }] : [];
  }) });

// ---------- Hreflang ----------
const HREFLANG_RE = /^(x-default|[a-z]{2,3}(-([a-z]{4}|[a-z]{2}|\d{3}))?)$/;
rule({ id: 'hreflang-invalid-code', category: 'hreflang', severity: 'critical', team: 'Frontend',
  title: 'Geçersiz hreflang kodu', description: 'Dil veya ülke kodu yanlış. Google bu etiketi yok sayar.',
  fix: 'ISO 639-1 dil kodu ve ISO 3166 ülke kodu kullanın. Örnek: tr, en, en-gb (en-uk değil).',
  run: (c) => each(c.okPages, (p) => { const bad = (p.hreflang || []).filter((h) => !HREFLANG_RE.test(h.lang) || /-uk$/.test(h.lang)); return bad.length && bad.map((h) => h.lang).join(', '); }) });
rule({ id: 'hreflang-no-self', category: 'hreflang', severity: 'warning', team: 'Frontend',
  title: 'Hreflang kendi sayfasını içermiyor', description: 'Hreflang grubu, sayfanın kendisini de içermeli.',
  fix: 'Her dil sürümüne kendi URL\'sini gösteren hreflang ekleyin.',
  run: (c) => each(c.okPages, (p) => p.hreflang?.length && !p.hreflang.some((h) => h.url === p.url)) });
rule({ id: 'hreflang-no-return', category: 'hreflang', severity: 'critical', team: 'Frontend',
  title: 'Hreflang dönüş linki yok', description: 'A sayfası B\'yi gösteriyor ama B, A\'yı göstermiyor. Google iki yönlü onay ister.',
  fix: 'Bütün dil sürümlerinde aynı hreflang grubunu kullanın.',
  run: (c) => c.okPages.flatMap((p) => {
    const miss = (p.hreflang || []).filter((h) => h.url && h.url !== p.url && h.lang !== 'x-default').filter((h) => {
      const t = c.byUrl.get(h.url); return t && isOk(t) && !(t.hreflang || []).some((x) => x.url === p.url);
    });
    return miss.length ? [{ url: p.url, detail: miss.map((h) => `${h.lang}: ${h.url}`).join('\n') }] : [];
  }) });
rule({ id: 'hreflang-no-xdefault', category: 'hreflang', severity: 'notice', team: 'Frontend',
  title: 'x-default eksik', description: 'Dil eşleşmeyen kullanıcılar için varsayılan sürüm belirtilmemiş.',
  fix: 'Hreflang grubuna hreflang="x-default" ekleyin.',
  run: (c) => each(c.okPages, (p) => p.hreflang?.length && !p.hreflang.some((h) => h.lang === 'x-default')) });
rule({ id: 'hreflang-target-bad', category: 'hreflang', severity: 'critical', team: 'SEO',
  title: 'Hreflang hedefi indekslenemiyor', description: 'Hreflang, hata veren, yönlenen veya noindex bir URL\'yi gösteriyor.',
  fix: 'Hreflang URL\'lerini 200 dönen, indekslenebilir son URL\'ler ile değiştirin.',
  run: (c) => c.okPages.flatMap((p) => {
    const bad = (p.hreflang || []).filter((h) => { const t = c.byUrl.get(h.url); return t && (t.status !== 200 || t.redirectChain?.length || isNoindex(t)); });
    return bad.length ? [{ url: p.url, detail: bad.map((h) => `${h.lang}: ${h.url} (${c.byUrl.get(h.url).status})`).join('\n') }] : [];
  }) });
rule({ id: 'hreflang-lang-mismatch', category: 'hreflang', severity: 'notice', team: 'Frontend',
  title: 'html lang ile hreflang uyumsuz', description: 'Sayfanın html lang değeri, hreflang\'deki kendi dil kodundan farklı.',
  fix: 'html lang değerini sayfanın gerçek diline göre düzeltin.',
  run: (c) => each(c.okPages, (p) => {
    const self = (p.hreflang || []).find((h) => h.url === p.url && h.lang !== 'x-default');
    if (!self || !p.htmlLang) return false;
    return self.lang.split('-')[0] !== p.htmlLang.split('-')[0] && `html lang="${p.htmlLang}", hreflang="${self.lang}"`;
  }) });

// ---------- Yapısal veri ----------
rule({ id: 'schema-parse-error', category: 'schema', severity: 'critical', team: 'Frontend',
  title: 'JSON-LD sözdizimi hatası', description: 'Yapısal veri okunamıyor. Google bu bloğu yok sayar.',
  fix: 'JSON-LD bloğunu Google Rich Results Test ile doğrulayın. Virgül ve tırnakları kontrol edin.',
  run: (c) => each(c.okPages, (p) => { const e = (p.jsonld || []).filter((j) => j.error); return e.length && e[0].error; }) });
rule({ id: 'schema-missing-fields', category: 'schema', severity: 'warning', team: 'Frontend',
  title: 'Yapısal veride zorunlu alan eksik', description: 'Schema tipi için gerekli alanlar yok. Zengin sonuç çıkmaz.',
  fix: 'Eksik alanları ekleyin.',
  run: (c) => each(c.okPages, (p) => {
    const out = [];
    for (const e of (p.jsonld || []).filter((j) => !j.error)) for (const t of e.types) {
      const req = c.cfg.schemaRequired[t]; if (!req) continue;
      const miss = req.filter((k) => !e.keys.includes(k));
      if (t === 'Product' && !['offers', 'review', 'aggregateRating'].some((k) => e.keys.includes(k))) miss.push('offers | review | aggregateRating');
      if (miss.length) out.push(`${t}: ${miss.join(', ')}`);
    }
    return out.length && out.join('\n');
  }) });
rule({ id: 'schema-none', category: 'schema', severity: 'notice', team: 'SEO', scope: 'site',
  title: 'Sitede hiç yapısal veri yok', description: 'Hiçbir sayfada JSON-LD bulunamadı.',
  fix: 'En az Organization, WebSite ve BreadcrumbList ekleyin. Ürün/haber sayfaları için ilgili tipleri ekleyin.',
  run: (c) => c.okPages.length && !c.okPages.some((p) => p.jsonld?.length) && c.okPages[0].jsonld ? [{ url: c.meta.startUrl, detail: '' }] : [] });
rule({ id: 'og-missing', category: 'schema', severity: 'notice', team: 'Frontend',
  title: 'Open Graph etiketi eksik', description: 'Sosyal medyada paylaşımda başlık veya görsel düzgün çıkmaz.',
  fix: 'og:title, og:description ve og:image ekleyin.',
  run: (c) => each(c.indexable, (p) => { if (p.ogDescription === undefined) return false; const m = [!p.ogTitle && 'og:title', !p.ogDescription && 'og:description', !p.ogImage && 'og:image'].filter(Boolean); return m.length && m.join(', '); }) });
rule({ id: 'twitter-card-missing', category: 'schema', severity: 'notice', team: 'Frontend',
  title: 'Twitter Card etiketi yok', description: 'X (Twitter) paylaşımında büyük görsel çıkmaz.',
  fix: '<meta name="twitter:card" content="summary_large_image"> ekleyin.',
  run: (c) => each(c.indexable, (p) => p.twitterCard === '') });

// ---------- Performans ----------
rule({ id: 'slow-response', category: 'performance', severity: 'warning', team: 'Backend',
  title: 'Yavaş sunucu yanıtı', description: 'Sunucunun HTML\'i göndermesi uzun sürüyor.',
  fix: 'Sayfa önbelleği (cache), CDN ve veritabanı sorgularını kontrol edin.',
  run: (c) => each(c.okPages, (p) => p.responseMs > c.T.slowResponseMs && `${p.responseMs} ms`) });
rule({ id: 'large-html', category: 'performance', severity: 'warning', team: 'Frontend',
  title: 'Büyük HTML', description: 'HTML dosyası çok büyük. Satır içi kod veya veri sayfayı şişiriyor olabilir.',
  fix: 'Satır içi script/style ve gömülü veriyi azaltın.',
  run: (c) => each(c.okPages, (p) => p.sizeBytes / 1024 > c.T.largeHtmlKb && `${Math.round(p.sizeBytes / 1024)} KB`) });
rule({ id: 'render-blocking', category: 'performance', severity: 'notice', team: 'Frontend',
  title: 'Render engelleyen kaynaklar', description: '<head> içinde async/defer olmayan script ve CSS dosyaları sayfanın çizilmesini geciktirir.',
  fix: 'Script\'lere defer ekleyin. Kritik olmayan CSS\'i sonradan yükleyin.',
  run: (c) => each(c.okPages, (p) => (p.blockingJs || 0) + (p.blockingCss || 0) > c.T.blockingResources && `${p.blockingJs} JS, ${p.blockingCss} CSS`) });
rule({ id: 'compression-missing', category: 'performance', severity: 'warning', team: 'Backend',
  title: 'HTML sıkıştırılmıyor', description: 'Sunucu HTML\'i gzip veya brotli ile sıkıştırmıyor. Sayfa daha yavaş iner.',
  fix: 'Sunucuda veya CDN\'de gzip ya da brotli sıkıştırmayı açın.',
  run: (c) => each(c.okPages, (p) => p.contentEncoding !== undefined && !/gzip|br|deflate|zstd/i.test(p.contentEncoding) && p.sizeBytes >= c.T.compressionMinKb * 1024 && `${Math.round(p.sizeBytes / 1024)} KB, sıkıştırma yok`) });

// ---------- HTTPS ----------
rule({ id: 'mixed-content', category: 'https', severity: 'critical', team: 'Frontend',
  title: 'Mixed content', description: 'HTTPS sayfa http:// üzerinden kaynak yüklüyor. Tarayıcı engelleyebilir.',
  fix: 'Bütün kaynak adreslerini https:// yapın.',
  run: (c) => each(c.okPages, (p) => p.mixed?.length && `${p.mixed.length} kaynak · ${short(p.mixed[0], 70)}`) });
rule({ id: 'site-not-https', category: 'https', severity: 'critical', team: 'Backend', scope: 'site',
  title: 'Site HTTPS kullanmıyor', description: 'Başlangıç adresi http:// üzerinden açılıyor.',
  fix: 'SSL sertifikası kurun ve http trafiğini https\'e 301 ile yönlendirin.',
  run: (c) => c.meta.startUrl.startsWith('http:') && !c.isLocal ? [{ url: c.meta.startUrl, detail: '' }] : [] });
rule({ id: 'ssl-invalid', category: 'https', severity: 'critical', team: 'Backend', scope: 'site',
  title: 'SSL sertifikası geçersiz', description: 'Tarayıcı güvenlik uyarısı gösterir. Kullanıcı siteye girmez, Google sayfaları düşürebilir.',
  fix: 'Geçerli bir sertifika kurun. Ara sertifika zincirini ve sertifikadaki alan adlarını kontrol edin.',
  run: (c) => { const t = siteRan(c) && c.checks.site.tls; return t && !t.connectFailed && t.error ? [{ url: c.checks.site.home, detail: tlsErrorText(t.error) + (t.validTo ? ` · bitiş: ${t.validTo.slice(0, 10)}` : '') }] : []; } });
rule({ id: 'ssl-expiring', category: 'https', severity: 'warning', team: 'Backend', scope: 'site',
  title: 'SSL sertifikası yakında bitiyor', description: 'Sertifikanın bitiş tarihi yakın. Yenilenmezse site güvenlik uyarısı verir.',
  fix: 'Sertifikayı yenileyin. Otomatik yenileme ayarını (örnek: Let\'s Encrypt) kontrol edin.',
  run: (c) => { const t = siteRan(c) && c.checks.site.tls; return t && t.daysLeft != null && t.daysLeft >= 0 && t.daysLeft < c.T.sslExpiryDays ? [{ url: c.checks.site.home, detail: `${t.daysLeft} gün kaldı · bitiş: ${t.validTo.slice(0, 10)}${t.issuer ? ' · ' + t.issuer : ''}` }] : []; } });
rule({ id: 'hsts-missing', category: 'https', severity: 'warning', team: 'Backend', scope: 'site',
  title: 'HSTS başlığı yok', description: 'Sunucu tarayıcıya "bu siteyi her zaman HTTPS ile aç" demiyor. İlk ziyarette http açığı kalır.',
  fix: 'Sunucuya şu başlığı ekleyin: Strict-Transport-Security: max-age=31536000; includeSubDomains',
  run: (c) => siteRan(c) && c.checks.site.hsts === '' ? [{ url: c.checks.site.home, detail: '' }] : [] });
rule({ id: 'hsts-short', category: 'https', severity: 'notice', team: 'Backend', scope: 'site',
  title: 'HSTS süresi kısa', description: 'HSTS başlığındaki max-age değeri önerilen süreden kısa.',
  fix: 'max-age değerini en az 31536000 (1 yıl) yapın.',
  run: (c) => {
    const h = siteRan(c) && c.checks.site.hsts; if (!h) return [];
    const age = +(/max-age\s*=\s*"?(\d+)/i.exec(h)?.[1] ?? 0);
    return age < c.T.hstsMinMaxAgeSec ? [{ url: c.checks.site.home, detail: h }] : [];
  } });

// ---------- Mobil ve erişilebilirlik ----------
rule({ id: 'viewport-missing', category: 'a11y', severity: 'critical', team: 'Frontend',
  title: 'viewport meta etiketi yok', description: 'Sayfa mobilde masaüstü genişliğinde açılır.',
  fix: '<meta name="viewport" content="width=device-width, initial-scale=1"> ekleyin.',
  run: (c) => each(c.okPages, (p) => p.viewport === '') });
rule({ id: 'lang-missing', category: 'a11y', severity: 'warning', team: 'Frontend',
  title: 'html lang eksik', description: 'Sayfanın dili belirtilmemiş. Ekran okuyucu yanlış dilde okur.',
  fix: '<html lang="tr"> gibi dil kodu ekleyin.',
  run: (c) => each(c.okPages, (p) => !p.htmlLang) });
rule({ id: 'unnamed-controls', category: 'a11y', severity: 'notice', team: 'Frontend',
  title: 'Adı olmayan link veya buton', description: 'İkon linkleri ve butonlar metin içermiyor. Ekran okuyucu ne yaptığını söyleyemez.',
  fix: 'aria-label ekleyin. Örnek: <a aria-label="Instagram">.',
  run: (c) => each(c.okPages, (p) => (p.unnamedLinks || 0) + (p.unnamedButtons || 0) > 0 && `${p.unnamedLinks} link, ${p.unnamedButtons} buton`) });
rule({ id: 'favicon-missing', category: 'a11y', severity: 'notice', team: 'Frontend', scope: 'site',
  title: 'Favicon etiketi yok', description: 'Ana sayfada favicon link etiketi bulunamadı. Arama sonucunda ikon çıkmayabilir.',
  fix: '<link rel="icon" href="/favicon.ico"> ekleyin (en az 48×48 px).',
  run: (c) => { const h = c.byUrl.get(c.meta.startUrl); return h && isOk(h) && h.favicon === false ? [{ url: h.url, detail: '' }] : []; } });

// ---------- URL yapısı ----------
rule({ id: 'url-format', category: 'url', severity: 'notice', team: 'Backend',
  title: 'URL biçimi sorunlu', description: 'URL\'de büyük harf, boşluk veya alt çizgi var.',
  fix: 'Küçük harf ve tire (-) kullanın. Eski URL\'ler için 301 ekleyin.',
  run: (c) => each(c.indexable, (p) => { const path = decodeURIComponent(new URL(p.url).pathname); const m = [/[A-ZÇĞİÖŞÜ]/.test(path) && 'büyük harf', /\s|%20/.test(p.url) && 'boşluk', /_/.test(path) && 'alt çizgi'].filter(Boolean); return m.length && m.join(', '); }) });
rule({ id: 'url-non-ascii', category: 'url', severity: 'notice', team: 'Backend',
  title: 'URL\'de Türkçe / özel karakter', description: 'Paylaşımda URL %C3%BC gibi kodlara dönüşür.',
  fix: 'ç→c, ğ→g, ı→i, ö→o, ş→s, ü→u dönüşümü ile slug üretin.',
  run: (c) => each(c.indexable, (p) => /%[89A-F][0-9A-F]|[^\x00-\x7F]/i.test(new URL(p.url).pathname) && decodeURIComponent(new URL(p.url).pathname)) });
rule({ id: 'url-long', category: 'url', severity: 'notice', team: 'Backend',
  title: 'URL çok uzun veya çok parametreli', description: 'Uzun ve parametreli URL\'ler kötü görünür ve kopya sayfa üretebilir.',
  fix: 'Kısa, anlamlı slug kullanın. Filtre parametrelerini canonical ile yönetin.',
  run: (c) => each(c.indexable, (p) => { const u = new URL(p.url); const n = [...u.searchParams.keys()].length; return (p.url.length > c.T.maxUrlLength || n > c.T.maxUrlParams) && `${p.url.length} karakter, ${n} parametre`; }) });

export const RULES = R;
export { robotsParser };
