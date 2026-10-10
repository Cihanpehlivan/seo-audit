// HTTPS test site with a self-signed certificate (valid until 2046). Used for SSL and HSTS rules.
import https from 'node:https';

const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC8eWrBb1FtBxtP
ku6z7Y7paiH8ewFrgIFgOacGZMc2mx8nCs2TP9OVIfkm6p3/03DKbVD6gpP9tivS
361EUWZd8ZbDiTthDy28WzLD8H5V2WgqV4/x5Eg9fVITdkwQ1WZtTir3vcYLtRw2
sDf7sUXv+f3krbc4LX30iTnf/70TR3maolb580eUqz7Ua70dcjlGOof2bpczig8V
7lQOKDdkGXraV3UrpLSJRBKwxUqyA+YK/Xl9qgeT4FDSnf2WTtDJ9jlbdCaXWwZz
FFeMsTv/jyN8VIlWjbT0bRMtjmgQvZzr+5pvhnv/pv23YN+ceDPkr8vKW2MrRC4w
TxPbzwkdAgMBAAECggEAJVR1IRf/zDT2o1WqYsfgIPos/hmM5/J9bYYtv1XxoS6r
Rmvc2Nfw+95NP3iDz9pcwjNRsTRwxHUzC+LSqi/nMx85KcSCFtDPUbnMfcOh+jYD
7DMIpzP8XPV37rPlEAZ8cZTkbMpRMhtumaRgikEL5aKht4vyuLVF98vAQ04fcHRG
LRcBnizZZ5v7bJvFfFuv/qmTsXWmilvm8mYMwjYZ3f9PVA8xPnORNGUcfYvwxOfW
QwphU9l06bUPr4zrbzQfRandkS/kTTbuGzdQEGz2oJFoLdgffnYQykrReZlh/VO6
i8lA0wvQ6voaQ6nbKnIsHSw4I8BV0+rxBOeZ9zF0MQKBgQDdPoUm5rIuEZsXc9Mn
sGtV4w8wkWmC7rudGtiXlyfFV/DQrXhoXqBJoUmaP/D7dlgzSY/bgkglZPaKwhJ/
doBwaSmYGGHo6Uv06ZVfCY6tHhGbBrsRG5ASkDQwZU6xMddqac7qSxIUwCYlKfZP
nG5mPkdLbmrCNEZ6aQqPgPJKJQKBgQDaFQhgicYNntf3KlZWBHfHe96bOjJj5U3m
202a7rdk4ZXtbfP/n7Cx8fYYL1gay62Hct+Dfa3leTxSX7JV0fPv8qZdauuOggt+
FWAFhiRclFt8+e1rSAaXzbtwg+VHIddCrh5v0ssfBU241ZiTuLyreZz8LHrPAqvC
UQNHkPYFmQKBgQCm1B//Z3HwPyJdmt8cTHGDgAXSL7QKIQ6jtrygAkDhFCDomgXz
XXcsTkx73b9PPrvfYJbzhNf2Kp2loBXmu2q6WPIeWDRsNo8qDICv+zr023mXFoo0
qj4HYWmZHKsr/lNbUJHQJe9qakHZQD0VZvXwbwG/pXEnI9gJMe/eqfMJaQKBgQDG
ZIPubufB1FNcAyPvtLjSvRlR1aupvR0Ve0QqQiiMmbwu9uwWDExOVXQvpEJefhQr
OJGlqVvdemEp/uzZrdpg2zoFmhMY3a1e0ks8O0AxCLYCB8u44Rk+WGbAgPy/rUWK
36PIztcCLWz7TTU0jcb1p/jsX/qJAEEI0XJOVM27YQKBgH/kpmEltlPh7IiXbq4C
qyt8LS8TEMQ4l89uLuqaqKM74/k0SBvIzChZQYLEE8vEIVgC0XLlDPnHu6CNuU5y
Nhsd6JkEtlst2Wp67JwzKtfUbNCFrQtAOwArUgCDMDQgUPPWknEQGOQGag8blL6l
jfk4TruX5Nj7DtTh6nf6Gbf3
-----END PRIVATE KEY-----`;

const CERT = `-----BEGIN CERTIFICATE-----
MIIDFzCCAf+gAwIBAgIUXIf3bnGYMwHh4VjqM+5ezpiMq2UwDQYJKoZIhvcNAQEL
BQAwGzEZMBcGA1UEAwwQcm5nLXRlc3QuaW52YWxpZDAeFw0yNjEwMDkyMzMxMTVa
Fw00NjEwMDQyMzMxMTVaMBsxGTAXBgNVBAMMEHJuZy10ZXN0LmludmFsaWQwggEi
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC8eWrBb1FtBxtPku6z7Y7paiH8
ewFrgIFgOacGZMc2mx8nCs2TP9OVIfkm6p3/03DKbVD6gpP9tivS361EUWZd8ZbD
iTthDy28WzLD8H5V2WgqV4/x5Eg9fVITdkwQ1WZtTir3vcYLtRw2sDf7sUXv+f3k
rbc4LX30iTnf/70TR3maolb580eUqz7Ua70dcjlGOof2bpczig8V7lQOKDdkGXra
V3UrpLSJRBKwxUqyA+YK/Xl9qgeT4FDSnf2WTtDJ9jlbdCaXWwZzFFeMsTv/jyN8
VIlWjbT0bRMtjmgQvZzr+5pvhnv/pv23YN+ceDPkr8vKW2MrRC4wTxPbzwkdAgMB
AAGjUzBRMB0GA1UdDgQWBBTuVJ3XQ2HPuFj7gjflZTKmbt6urzAfBgNVHSMEGDAW
gBTuVJ3XQ2HPuFj7gjflZTKmbt6urzAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3
DQEBCwUAA4IBAQBUaoASx90KGUo2731/xSHCprFKL/lvevQFaqvHbsALNY42eW9w
N6f9J/S5QufYFtt4mPI1Tx46HoObs0tslUZoam0P+aSzKCMeZnWjiMZQe4hjBv+W
8/MoTpjAb1TSh7JA1GGyK8qO3xQuTJdmRfAXjh9gUuDSz4AkBPpiH0NatLo0Ktrd
j+jUlFIuZuyRUK/TSecq7Mi6AI6yw/wZsYuAQKXUb6UrUeHpfhCGLt0+ZH5lv5f0
DYzUVWryIgE6st6nvjjWIUhFVTtkj8c5AHjv87Pl2yMwpZrAU4wjWsAvmpmiYdsf
Na5dY5ddWHPWh+dQRiYHDgPDyacS3y4utu9a
-----END CERTIFICATE-----`;

const page = (title) => `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1></body></html>`;
const R = {
  '/': () => [200, page('HTTPS test'), {}],
  '/hsts-kisa': () => [200, page('Kısa HSTS'), { 'strict-transport-security': 'max-age=300' }],
  '/llms.txt': () => [200, '# Test sitesi\n\n- [Ana sayfa](/)\n', { 'content-type': 'text/markdown; charset=utf-8' }],
};

export function startHttpsFixture(port = 0) {
  const server = https.createServer({ key: KEY, cert: CERT }, (req, res) => {
    const r = R[new URL(req.url, 'https://x').pathname];
    if (!r) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end(page('404')); }
    const [status, body, headers] = r();
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
    res.end(body);
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}
