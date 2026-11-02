// 「これまだある？」に、掲載状況を今確かめて答える。
// 自社の求人なら JOBS_STATUS_URL（例 https://api.example.com/jobs/{id}/status）に問い合わせる。
// 返事は 404＝終了、または JSON の "status" が "open"／"ended"（"closed" も終了）。未設定なら巡回の記録で答える。
// 同じ問い合わせ先へは gapMs おきまで（元の実装では、求人サイトの robots の Crawl-Delay を守るのに使っていた）。同じ求人の結果は10分使い回す。
import { UA } from './lib/http.mjs';

const CACHE_MS = 10 * 60e3;
const WAIT_MAX_MS = 15e3;
const RULES = {
  feed: {
    gapMs: 1e3,
    url: (d) => (process.env.JOBS_STATUS_URL || '').replace('{id}', encodeURIComponent(d.id)),
    judge: (status, body) => (status === 404 || /"status"\s*:\s*"(ended|closed)"/.test(body) ? 'ended'
      : status === 200 && /"status"\s*:\s*"open"/.test(body) ? 'open' : 'unknown'),
  },
};

const stamp = (ms) => new Date(ms).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function liveText(r) {
  if (r.state === 'ended') return `募集終了を確認しました（${stamp(r.at)}）`;
  if (r.state === 'open') return `掲載中でした（${stamp(r.at)}確認）`;
  return r.why || '掲載状況は確かめられませんでした';
}

/** 1件の求人の掲載状況を確かめる。返り値 { state: 'open'|'ended'|'unknown', at, why? } */
export async function liveCheck(job, { store, now = Date.now(), fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const d = job.data || job;
  const rule = RULES[d.site || job.site];
  const target = rule?.url(d);
  if (!target) return { state: 'unknown', at: now, why: `${d.siteLabel || 'この求人'}は、その場では掲載状況を確かめられません` };
  const cacheKey = `live#${d.uid}`;
  const cached = await store.getState(cacheKey);
  if (cached && now - cached.at < CACHE_MS) return cached;

  let host;
  try { host = new URL(target).host; } catch { return { state: 'unknown', at: now, why: '掲載状況の問い合わせ先（JOBS_STATUS_URL）の形が正しくありません' }; }
  const gateKey = `livegate#${host}`;
  const last = (await store.getState(gateKey)) || 0;
  const wait = last + rule.gapMs - Date.now();
  if (wait > WAIT_MAX_MS) return { state: 'unknown', at: now, why: '少し前に確かめたばかりなので、少しおいてもう一度聞いてください' };
  if (wait > 0) await sleep(wait);
  await store.putState(gateKey, Date.now());

  let r;
  try {
    const res = await fetchImpl(target, { headers: { 'user-agent': UA, accept: 'application/json' }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    const body = (await res.text()).slice(0, 300_000);
    r = { state: rule.judge(res.status, body, d), at: Date.now() };
    if (r.state === 'unknown') r.why = `掲載状況の返事を読み取れませんでした（${res.status}）`;
  } catch (e) {
    // 取得に失敗しただけ。終了した、とは決めつけない
    return { state: 'unknown', at: now, why: `掲載状況を確かめられませんでした（${String(e.message).slice(0, 40)}）` };
  }
  await store.putState(cacheKey, r);
  return r;
}
