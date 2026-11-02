// 応募した・確定したバイトのリマインド（前日の夜と、当日の出発の約1時間前）と、当日の経路。
// 勤務は assistant:shifts に控える（求人が巡回で見えなくなっても困らないよう、公開の求人情報の写しを持つ）。
// 出発地：同じ日の前の予定に場所があればそこから。なければ経路は「今いる場所から」（Google マップの既定）にする。
// 予定の場所は AI に送らない・保存しない（その場で位置を調べるだけ）。
import { cleanPlace, geocode, km, transitMinutes, routeUrl } from './travel.mjs';

const H = 3600e3;
const BUFFER_MIN = 10; // 着いてから始まるまでのゆとり
const SAME_DAY = 12 * H;
/** 前日のリマインドと前夜のひとこと（care.mjs）を送り始める時刻（日本時間）。同じ1通にまとめるため揃える */
export const EVE_HOUR = 20;

const hm = (ms) => new Date(ms).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
const day = (ms) => new Date(ms).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short' });
const jstDate = (ms) => new Date(ms + 9 * H).toISOString().slice(0, 10);
const at = (date, t) => Date.parse(`${date}T${t}:00+09:00`);

export const STATUS_LABEL = { applied: '応募済み', confirmed: '確定', cancelled: '取消' };

/** 求人から勤務の控えを作る（公開の求人情報だけ） */
export function shiftFrom(job, status, now) {
  const d = job.data || job;
  const start = at(d.date, d.startTime);
  let end = at(d.date, d.endTime);
  if (end <= start) end += 24 * H;
  return {
    uid: d.uid, status, at: now, start, end, site: d.site, siteLabel: d.siteLabel, id: d.id, url: d.url, appUrl: d.appUrl, facility: d.facility || undefined,
    dest: d.address || `${d.pref}${d.city}`, area: `${d.pref}${d.city}`, work: (d.workOutline || d.title || '').slice(0, 40),
  };
}

/** 控えを更新する（同じ求人は置き換え。終わって2日たったものは消す） */
export function setShift(shifts = [], shift, now) {
  return [...shifts.filter((s) => s.uid !== shift.uid && s.end > now - 2 * 24 * H), shift].sort((a, b) => a.start - b.start).slice(-50);
}

/** 出発地と所要時間の目安。{ from: 経路の出発地（null＝今いる場所）, fromLabel, minutes: 分か null } */
export async function departFor(shift, busy, { origin } = {}) {
  const prev = busy.filter((b) => !b.allDay && b.location && b.end <= shift.start && shift.start - b.end <= SAME_DAY && jstDate(b.end) === jstDate(shift.start)).pop();
  const place = prev ? cleanPlace(prev.location) : origin ? cleanPlace(origin) : null;
  if (!place) return { from: null, fromLabel: null, minutes: null };
  let pos = await geocode(place);
  if (!pos && !place.addr && !/駅$/.test(place.q)) pos = await geocode({ ...place, q: `${place.q}駅` });
  const dest = await geocode({ q: shift.dest, addr: true });
  const minutes = pos && dest ? transitMinutes(km(pos, dest)) : null;
  return { from: place.raw, fromLabel: prev ? `前の予定（${hm(prev.end)}まで・${place.label}）` : place.label, minutes, prevEnd: prev?.end };
}

/**
 * 今送るリマインド。前日の20時以降（勤務の6時間前まで）に1回、出発の1時間前〜勤務開始に1回。
 * 返り値 [{ key, shift, kind: 'eve'|'go', depart }]
 */
export async function dueReminders({ now, shifts = [], busy = [], sentKeys, origin }) {
  const out = [];
  for (const s of shifts) {
    if (s.status === 'cancelled' || s.start <= now) continue;
    const eveFrom = at(jstDate(s.start - 24 * H), `${EVE_HOUR}:00`);
    const eveKey = `rem-eve#${s.uid}#${s.start}`;
    const goKey = `rem-go#${s.uid}#${s.start}`;
    const wantEve = now >= eveFrom && now < s.start - 6 * H && !sentKeys.has(eveKey);
    // 出発の時刻は目安が出せなければ「始まる2時間前」とみなす
    const depart = (wantEve || !sentKeys.has(goKey)) ? await departFor(s, busy, { origin }) : null;
    if (wantEve) { out.push({ key: eveKey, shift: s, kind: 'eve', depart }); continue; }
    const leaveAt = s.start - ((depart?.minutes ?? 110) + BUFFER_MIN) * 60e3;
    if (!sentKeys.has(goKey) && now >= leaveAt - H && now < s.start) out.push({ key: goKey, shift: s, kind: 'go', depart, leaveAt });
  }
  return out;
}

/** リマインドの本文（行の配列） */
export function reminderLines({ shift: s, kind, depart }) {
  const when = `${kind === 'eve' ? `明日 ${day(s.start)}` : '今日'} ${hm(s.start)}〜${hm(s.end)}`;
  const lines = [`${kind === 'eve' ? '🔔' : '⏰'} ${when}　${s.area}｜${s.work}`];
  if (depart?.minutes) {
    const leave = s.start - (depart.minutes + BUFFER_MIN) * 60e3;
    lines.push(`🚃 ${depart.fromLabel}から約${depart.minutes}分。出発の目安 ${hm(leave)}`);
    if (depart.prevEnd && leave < depart.prevEnd) lines.push('⚠ 前の予定が終わってからでは間に合わないかもしれません');
  } else {
    lines.push('🚃 所要時間は経路で確認してください（今いる場所から）');
    if (kind === 'eve' && !depart?.fromLabel) lines.push('「出発地は〇〇駅」と送ると、出発の目安も出します。');
  }
  if (s.status === 'applied') lines.push('まだ確定の連絡がなければ、求人サイトで確かめてください。');
  return lines;
}

export const reminderRoute = ({ shift, depart }) => (depart?.from ? routeUrl(depart.from, shift.dest) : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(shift.dest)}&travelmode=transit`);
