// 空きに合う求人を、本人が言葉で伝えた「重視すること」で並べ替える（AI を使わない決定的な部分）。
// prefs は src/lib/claude.mjs の parsePrefs が作る：
//   { summary, priorities: ['pay'|'location'|'relaxed'|'short'|'long'|'time'|'keywords'], minHourly, maxHours, minHours,
//     areas: [{ pref, city }], excludeAreas: [{ pref, city }], includeKeywords: [], excludeKeywords: [], timeOfDay }
// 1番目に挙げたことがはっきり勝つように差をつける
const WEIGHTS = [4, 2, 1, 0.5, 0.5, 0.5, 0.5];

// 「ゆとり勤務」の目安。求人文は相手サイトの文面なので、加点・減点に使うだけで指示としては扱わない
const RELAXED_PLUS = /健診|検診|ドック|ワクチン|予防接種|寝当直|オンコール|待機|産業医|ゆとり|少なめ|落ち着|ほぼ(なし|無し)|コンサルト|日直/;
const RELAXED_MINUS = /救急車|救急搬送|三次救急|多忙|忙しい|件数多|ウォークイン|walk.?in|ER/i;

import { isNight } from './rest.mjs';

const clamp = (x) => Math.max(0, Math.min(1, x));

export function relaxedScore(text = '') {
  let s = 0;
  if (RELAXED_PLUS.test(text)) s += 0.6;
  if (RELAXED_MINUS.test(text)) s -= 0.6;
  const m = text.match(/患者数[^0-9]{0,6}(\d{1,3})/);
  if (m) s += Number(m[1]) <= 20 ? 0.4 : Number(m[1]) >= 50 ? -0.4 : 0;
  return Math.max(-1, Math.min(1, s));
}

function inAreas(d, areas = []) {
  for (const a of areas) {
    if (a.pref && a.pref !== d.pref) continue;
    if (!a.city || (d.city && (d.city === a.city || d.city.startsWith(a.city) || a.city.startsWith(d.city)))) return a.city ? 1 : 0.5;
  }
  return 0;
}

function timeMatch(d, tod) {
  if (!tod || !d.startTime) return 0;
  const h = Number(d.startTime.slice(0, 2));
  const overnight = d.endTime && d.endTime <= d.startTime;
  if (tod === 'night') return overnight ? 1 : 0;
  if (tod === 'morning') return h < 12 && !overnight ? 1 : 0;
  if (tod === 'day') return h >= 8 && h < 14 && !overnight ? 1 : 0;
  if (tod === 'evening') return h >= 16 && !overnight ? 1 : 0;
  return 0;
}

const quantile = (xs, q) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

/** hits（matchJobs の結果）を prefs で絞り込み・採点し、似た求人を間引いて高い順に返す。 */
export function rankJobs(hits, prefs = {}) {
  const ex = (prefs.excludeKeywords || []).filter(Boolean);
  const inc = (prefs.includeKeywords || []).filter(Boolean);
  const pool = hits.filter((h) => {
    const { job } = h;
    const d = job.data || job;
    const text = d.searchText || '';
    if (prefs.minHourly && (!d.hourlyRate || d.hourlyRate < prefs.minHourly)) return false;
    if (prefs.maxHours && d.hours && d.hours > prefs.maxHours) return false;
    if (prefs.minHours && d.hours && d.hours < prefs.minHours) return false;
    if (prefs.excludeAreas?.length && inAreas(d, prefs.excludeAreas)) return false;
    // 時刻の指定は必ず守る（「17時以降」に日中の求人は出さない）
    if (prefs.earliestStart && (!d.startTime || d.startTime < prefs.earliestStart)) return false;
    if (prefs.latestEnd && (!d.endTime || d.endTime <= d.startTime || d.endTime > prefs.latestEnd)) return false;
    if (ex.some((k) => text.includes(k))) return false;
    // 「当直だけ」「日勤だけ」も必ず守る
    if (prefs.shift && h.interval) { const n = isNight(h.interval); if ((prefs.shift === 'night') !== n) return false; }
    return true;
  });
  const rates = pool.map(({ job }) => (job.data || job).hourlyRate).filter(Boolean);
  const lo = quantile(rates, 0.25);
  const hi = quantile(rates, 0.9);
  const pri = (prefs.priorities?.length ? prefs.priorities : ['pay']).slice(0, WEIGHTS.length);

  const scored = pool.map((h) => {
    const d = h.job.data || h.job;
    const f = {
      pay: d.hourlyRate ? clamp((d.hourlyRate - lo) / Math.max(1, hi - lo)) : 0,
      location: prefs.areas?.length ? inAreas(d, prefs.areas) : 0,
      relaxed: (relaxedScore(d.searchText) + 1) / 2,
      short: d.hours ? (d.hours <= 4 ? 1 : d.hours <= 8 ? 0.5 : 0) : 0,
      long: d.hours ? (d.hours >= 12 ? 1 : d.hours >= 8 ? 0.6 : 0.2) : 0,
      time: timeMatch(d, prefs.timeOfDay),
      keywords: inc.length && inc.some((k) => (d.searchText || '').includes(k)) ? 1 : 0,
    };
    // 同点のときは時給の高い順（その次に日付の早い順）
    // 当直の前後に予定がある（前夜が当直・明けに予定）ものは下げる（外しはしない）
    const score = pri.reduce((s, p, i) => s + WEIGHTS[i] * (f[p] || 0), 0) + 0.01 * f.pay - 1.5 * (h.rest?.penalty || 0);
    return { ...h, score, features: f };
  });
  scored.sort((a, b) => b.score - a.score || a.interval.start - b.interval.start);

  // 同じ求人の重複（サイト違い）と、同じ日・同じ時間・同じ業務の似た求人は1件に
  const seen = new Set();
  const out = [];
  for (const h of scored) {
    const d = h.job.data || h.job;
    const keys = [d.dupKey, `${d.date}|${d.startTime}|${d.endTime}|${d.workOutline || d.title}`];
    if (keys.some((k) => k && seen.has(k))) continue;
    keys.forEach((k) => k && seen.add(k));
    out.push(h);
  }
  return out;
}
