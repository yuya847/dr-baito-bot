// カレンダーの空き時間と求人の照合。
// 「勤務できる枠」（曜日×時間帯）の中で、予定（前後の移動・休息の余白込み）と重ならない部分を空きとする。
// 10/17 本人の方針：枠は既定で終日（ANYTIME）＝既存の予定に干渉しなければ提案する。
const DAY = 24 * 60 * 60 * 1000;
const JST = 9 * 60 * 60 * 1000;

/** 既定の枠：時間帯を絞らない（予定と重ならなければいつでも空き）。本人が枠を決めたらそれを使う。 */
export const ANYTIME = [{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '00:00' }];

const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const ymdJst = (ms) => new Date(ms + JST).toISOString().slice(0, 10);

/**
 * 勤務できる枠を具体的な日時の区間に展開する。
 * rules: [{ days: [0..6]（0=日）, from: 'HH:MM', to: 'HH:MM'（from 以下なら翌日まで）}]
 */
export function expandWindows(rules, { from, days }) {
  const out = [];
  const base = Date.parse(`${ymdJst(from)}T00:00:00+09:00`);
  for (let i = 0; i < days; i += 1) {
    const d0 = base + i * DAY;
    const dow = new Date(d0 + JST).getUTCDay();
    for (const r of rules) {
      if (!r.days.includes(dow)) continue;
      const s = d0 + toMin(r.from) * 60000;
      let e = d0 + toMin(r.to) * 60000;
      if (e <= s) e += DAY;
      out.push({ start: s, end: e });
    }
  }
  return mergeIntervals(out);
}

export function mergeIntervals(list) {
  const xs = [...list].sort((a, b) => a.start - b.start);
  const out = [];
  for (const x of xs) {
    const last = out[out.length - 1];
    if (last && x.start <= last.end) last.end = Math.max(last.end, x.end);
    else out.push({ start: x.start, end: x.end });
  }
  return out;
}

/** 枠から予定（前後に bufferMin 分の余白）を引いた残り＝空き時間。 */
export function freeSlots(windows, busy, { bufferMin = 60 } = {}) {
  const pad = bufferMin * 60000;
  const blocks = mergeIntervals(busy.map((b) => ({ start: b.start - pad, end: b.end + pad })));
  const out = [];
  for (const w of windows) {
    let cur = w.start;
    for (const b of blocks) {
      if (b.end <= cur || b.start >= w.end) continue;
      if (b.start > cur) out.push({ start: cur, end: b.start });
      cur = Math.max(cur, b.end);
      if (cur >= w.end) break;
    }
    if (cur < w.end) out.push({ start: cur, end: w.end });
  }
  return out;
}

/** 求人の勤務区間（日本時間）。時刻が不明なら null（＝照合できないので通知しない）。 */
export function jobInterval(job) {
  if (!job.date || !job.startTime || !job.endTime) return null;
  const start = Date.parse(`${job.date}T${job.startTime}:00+09:00`);
  let end = Date.parse(`${job.date}T${job.endTime}:00+09:00`);
  if (end <= start) end += DAY; // 当直など翌日にまたがる
  return { start, end };
}

/** 空き時間にすっぽり収まる求人を返す（過去・掲載終了の可能性があるものは除く）。 */
export function matchJobs(jobs, slots, { now = Date.now(), minHourly = 0 } = {}) {
  const hits = [];
  for (const j of jobs) {
    const d = j.data || j;
    if (j.missingSince) continue;
    const iv = jobInterval(d);
    if (!iv || iv.start <= now) continue;
    if (minHourly && d.hourlyRate && d.hourlyRate < minHourly) continue;
    const slot = slots.find((s) => s.start <= iv.start && iv.end <= s.end);
    if (slot) hits.push({ job: j, interval: iv, slot });
  }
  return hits.sort((a, b) => a.interval.start - b.interval.start);
}
