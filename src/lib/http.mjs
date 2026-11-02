// ブラウザを使わないサイト用の、Cookie を持ち回る最小の fetch ラッパ。
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createClient({ origin, cookies = {} }) {
  const jar = new Map(Object.entries(cookies));

  const keep = (res) => {
    for (const c of res.headers.getSetCookie?.() || []) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1));
    }
  };

  async function request(pathOrUrl, { method = 'GET', body, headers = {}, redirect = 'follow' } = {}) {
    const url = new URL(pathOrUrl, origin);
    const res = await fetch(url, {
      method,
      body,
      redirect,
      headers: {
        'user-agent': UA,
        'accept-language': 'ja',
        ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...headers,
      },
    });
    keep(res);
    return res;
  }

  async function html(pathOrUrl, opts) {
    const res = await request(pathOrUrl, opts);
    if (!res.ok) throw new Error(`${res.status} ${pathOrUrl}`);
    return res.text();
  }

  // ログイン Cookie を次回の起動へ持ち越すために書き出す
  const exportCookies = () => Object.fromEntries(jar);

  return { request, html, exportCookies };
}
