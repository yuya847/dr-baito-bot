// 既存の予定の変更・削除。AI（agent.mjs）は案を出すだけで、本人が確認ボタン（変更する／削除する）を押したときだけ Google に書く。
// 守ること（10/30 本人の依頼で追加）：
//   - 変えてよいのは本人のカレンダー（primary）の予定と、共有カレンダーでは件名に本人の名前がある予定だけ
//     （医局の共有カレンダー「医局Dr不在日」には他の先生の不在・外勤が多く、消すと医局の全員のカレンダーから消える）
//   - 他人が主催の招待・ほかの参加者がいる予定は変えない（相手の予定も変わる・通知が飛ぶ）。Google カレンダーで本人が操作する
//   - 繰り返しの予定は、その日の1回だけを変える（singleEvents の id がその回を指す）
//   - 押すまでの間に予定が変わっていたら書かない（etag。違えば Google が 412 を返す）
//   - 書いたあと1日は「元に戻す」で戻せる（消した予定はゴミ箱から戻すので、メモや通知もそのまま）
import * as google from './lib/google.mjs';
import { confirmEdit, eventWhen } from './lib/line.mjs';
import { jstDate } from './schedule.mjs';

const DAY = 864e5;
const PENDING = 'assistant:pendingedits';
const LAST = 'assistant:lastedit';
const KIND = { outOfOffice: '不在', focusTime: 'サイレント', workingLocation: '勤務場所', fromGmail: 'Gmail から自動で入った予定', birthday: '誕生日' };

/** この予定を Bot が変えてよいか。だめなら理由（本人にそのまま伝えられる文）、よければ null */
export function blockReason(e, { name } = {}) {
  if (!e?.id) return 'どの予定か特定できません';
  if (e.invited) return '他の人から招待された予定なので、こちらでは変えません。変更は主催者に頼むか、Google カレンダーで出欠を「いいえ」にしてください';
  if (e.guests) return 'ほかの参加者がいる予定なので、相手の予定も変わってしまいます。Google カレンダーで直接変更してください';
  if (e.kind) return `${KIND[e.kind] || '特別な種類'}の予定なので、Google カレンダーで直接変更してください`;
  if (!e.primary && !(name && (e.title || '').includes(name))) {
    return `共有カレンダー「${e.calName || '共有'}」の予定で、件名に本人の名前（${name || '未設定'}）がないので変えません（他の先生の予定かもしれず、消すと全員のカレンダーから消えます）。Google カレンダーで直接変更してください`;
  }
  return null;
}

const HM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const hm = (ms) => new Date(ms).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
const pick = ({ title, location, start, end, allDay }) => ({ title, location, start, end, allDay });

/**
 * 頼まれた変更（AI の道具の入力）を、変更後の予定に。a = { title?, date?, start?, end?, all_day?, location? }
 * 日付だけなら時刻はそのまま・開始だけなら長さはそのまま。location は '' で消す。返り値 { after } か { error }
 */
export function planChange(e, a = {}) {
  const date = a.date || jstDate(e.start);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: '日付は YYYY-MM-DD' };
  if ((a.start && !HM.test(a.start)) || (a.end && !HM.test(a.end))) return { error: '時刻は HH:MM' };
  const after = pick(e);
  if (a.title != null && String(a.title).trim()) after.title = String(a.title).trim().slice(0, 80);
  if (a.location != null) after.location = String(a.location).trim().slice(0, 100) || undefined;
  const at = (t) => Date.parse(`${date}T${t.padStart(5, '0')}:00+09:00`);
  after.allDay = a.all_day === true ? true : (a.all_day === false || a.start || a.end) ? false : e.allDay;
  if (after.allDay) {
    // 何日にもわたる終日予定（学会など）は日数を保つ
    const days = e.allDay ? Math.max(1, Math.round((e.end - e.start) / DAY)) : 1;
    after.start = at('00:00');
    after.end = after.start + days * DAY;
  } else {
    if (e.allDay && !a.start) return { error: '終日の予定を時刻つきにするには開始時刻（start）が要る。本人に聞き返す' };
    const length = e.allDay ? 3600e3 : e.end - e.start;
    after.start = at(a.start || hm(e.start));
    after.end = a.end ? at(a.end) : after.start + length;
    if (after.end <= after.start) after.end += DAY; // 「22時〜翌7時」
  }
  const timeChanged = after.start !== e.start || after.end !== e.end || after.allDay !== e.allDay;
  if (!timeChanged && after.title === e.title && after.location === e.location) return { error: '今の予定と同じなので変更はない' };
  return { after };
}

/** Google に送る変更（変わったところだけ）。from → to */
function changeBody(from, to) {
  const body = {};
  if (to.title !== from.title) body.title = to.title || '';
  if (to.location !== from.location) body.location = to.location || '';
  if (to.start !== from.start || to.end !== from.end || to.allDay !== from.allDay) Object.assign(body, { start: to.start, end: to.end, allDay: to.allDay });
  return body;
}

/**
 * 確認ボタンを押されるまで案を置いておく（1日・5件まで）。返り値は確認のメッセージ（LINE）と案の id。
 * edit = { op: 'update' | 'delete', e: listEvents の1件, after?: 変更後, ask?: 確認の一文 }
 */
export async function stashEdit(store, now, { op, e, after, ask }) {
  const id = Math.random().toString(36).slice(2, 10);
  const ed = {
    id, at: now, op, cal: e.cal, eventId: e.id, etag: e.etag,
    ...(e.calName ? { calName: e.calName } : {}), ...(e.recurring ? { recurring: true } : {}),
    before: pick(e), ...(op === 'update' ? { after } : {}),
  };
  const pend = ((await store.getState(PENDING)) || []).filter((p) => now - p.at < DAY).slice(-4);
  await store.putState(PENDING, [...pend, ed]);
  return { id, message: confirmEdit(id, ed, { ask }) };
}

const line1 = (x) => `${eventWhen(x)} ${x.title || '（件名なし）'}`;
const CHANGED = '確認のあとに予定が変わっていたので、書き込みませんでした。今の予定を見てから、もう一度頼んでください。';

/** 「変更する」「削除する」が押された：直前にもう一度確かめてから書く。返り値 { text, undo? } */
export async function applyEdit({ store, token, id, now, g = google }) {
  const pend = (await store.getState(PENDING)) || [];
  const ed = pend.find((p) => p.id === id);
  await store.putState(PENDING, pend.filter((p) => p.id !== id));
  if (!ed || now - ed.at > DAY) return { text: 'この案はもう使えません（実行済みか、時間が経ちました）。もう一度送ってください。' };
  const ref = { cal: ed.cal, id: ed.eventId };
  const cur = await g.getEvent(token, ref);
  if (!cur) return { text: 'その予定はもう見つかりません（消されたか、別のカレンダーに移された可能性があります）。' };
  if (cur.etag !== ed.etag) return { text: CHANGED };
  // 元に戻すときのために、切り詰めていない件名・場所を控える
  const before = { ...ed.before, title: cur.summary, location: cur.location };
  try {
    if (ed.op === 'delete') await g.deleteEvent(token, { ...ref, etag: cur.etag });
    else ed.etagAfter = (await g.patchEvent(token, { ...ref, etag: cur.etag }, changeBody(ed.before, ed.after))).etag;
  } catch (err) {
    if (err.status === 412) return { text: CHANGED };
    throw err;
  }
  await store.putState(LAST, { ...ed, before, doneAt: now });
  const where = ed.calName ? `（共有カレンダー「${ed.calName}」）` : '';
  return ed.op === 'delete'
    ? { text: `削除しました${where}。\n${line1(ed.before)}`, undo: true }
    : { text: `変更しました${where}。\n${line1(ed.after)}${ed.after.location ? ` ＠${ed.after.location}` : ''}`, undo: true };
}

/** 「元に戻す」：直前の1件だけ（ボタンの案 id が直前のものと同じとき・1日以内） */
export async function undoEdit({ store, token, id, now, g = google }) {
  const ed = await store.getState(LAST);
  if (!ed || ed.id !== id || now - ed.doneAt > DAY) return { text: '戻せる変更がありません（もう戻したか、1日以上前か、あとに別の変更をしました）。' };
  const ref = { cal: ed.cal, id: ed.eventId };
  if (ed.op === 'delete') {
    await g.restoreEvent(token, ref);
  } else {
    const cur = await g.getEvent(token, ref);
    if (!cur) return { text: 'その予定はもう見つかりません。Google カレンダーで確かめてください。' };
    if (cur.etag !== ed.etagAfter) return { text: '変更のあとにも予定が変わっているので、戻しませんでした。Google カレンダーで直してください。' };
    await g.patchEvent(token, { ...ref, etag: cur.etag }, changeBody(ed.after, ed.before));
  }
  await store.putState(LAST, null);
  return { text: `元に戻しました。\n${line1(ed.before)}` };
}

/**
 * 「バイト候補」で入れた求人の予定（start が勤務の開始）：取消なら消す案、確定なら件名を「【勤務確定】…」にする案
 * （本人がふだん確定した勤務をこう書いているため）。当てはまらなければ null
 */
export function candidateEdit(events, start, status) {
  const e = events.find((x) => /^バイト候補[：:]/.test(x.title || '') && Math.abs(x.start - start) < 60e3);
  if (!e || blockReason(e)) return null;
  if (status === 'cancelled') return { op: 'delete', e, ask: 'カレンダーに入れた「バイト候補」も消しますか？' };
  if (status === 'confirmed') {
    const after = planChange(e, { title: e.title.replace(/^バイト候補[：:]\s*/, '【勤務確定】') }).after;
    return after ? { op: 'update', e, after, ask: 'カレンダーの件名も「勤務確定」に変えますか？' } : null;
  }
  return null;
}
