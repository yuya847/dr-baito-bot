import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEdit, blockReason, candidateEdit, planChange, stashEdit, undoEdit } from '../src/edit.mjs';
import { runAgent } from '../src/agent.mjs';

const T = (s) => Date.parse(`${s}+09:00`);
const ev = (o) => ({ id: 'e1', cal: 'me@example.com', primary: true, etag: '"1"', busy: true, allDay: false, title: '歯医者', start: T('2026-11-07T10:00:00'), end: T('2026-11-07T11:00:00'), ...o });
const memStore = (init = {}) => { const st = new Map(Object.entries(init)); return { st, getState: async (k) => st.get(k) ?? null, putState: async (k, v) => { st.set(k, v); } }; };

// Google の代わり（呼ばれた中身を残す）
function fakeGoogle(event) {
  let cur = event ? { ...event } : null;
  let n = 1;
  const calls = [];
  return {
    calls,
    getEvent: async () => cur && { ...cur },
    patchEvent: async (_t, ref, body) => { calls.push(['patch', ref.etag, body]); n += 1; cur = { ...cur, etag: `"${n}"` }; return { etag: cur.etag }; },
    deleteEvent: async (_t, ref) => { calls.push(['delete', ref.etag]); },
    restoreEvent: async () => { calls.push(['restore']); },
    touch: () => { n += 1; cur = { ...cur, etag: `"${n}"` }; },
  };
}

test('変えてよい予定：本人のカレンダーだけ。招待・参加者あり・共有カレンダーの他の先生の予定は変えない', () => {
  assert.equal(blockReason(ev()), null);
  assert.match(blockReason(ev({ invited: true })), /招待された予定/);
  assert.match(blockReason(ev({ guests: 2 })), /ほかの参加者/);
  assert.match(blockReason(ev({ kind: 'fromGmail' })), /Gmail/);
  const shared = (title) => ev({ primary: undefined, calName: '医局Dr不在日', title, allDay: true });
  assert.match(blockReason(shared('佐藤不在'), { name: '山田' }), /共有カレンダー「医局Dr不在日」.*件名に本人の名前（山田）がない/);
  assert.match(blockReason(shared('山田勤務'), {}), /名前（未設定）/);
  assert.equal(blockReason(shared('山田勤務'), { name: '山田' }), null);
});

test('変更の中身：日付だけなら時刻そのまま・開始だけなら長さそのまま・日をまたぐ・終日との切り替え', () => {
  const e = ev();
  assert.deepEqual(planChange(e, { date: '2026-11-09' }).after, { title: '歯医者', location: undefined, start: T('2026-11-09T10:00:00'), end: T('2026-11-09T11:00:00'), allDay: false });
  assert.equal(planChange(e, { start: '11:40' }).after.end, T('2026-11-07T12:40:00'));
  assert.equal(planChange(e, { end: '10:30' }).after.start, T('2026-11-07T10:00:00'));
  assert.equal(planChange(e, { start: '22:00', end: '07:00' }).after.end, T('2026-11-08T07:00:00'));
  assert.deepEqual(planChange(e, { all_day: true }).after, { title: '歯医者', location: undefined, start: T('2026-11-07T00:00:00'), end: T('2026-11-08T00:00:00'), allDay: true });
  // 終日 → 時刻つきは開始時刻が要る。2日の終日予定（学会）は日付を動かしても2日のまま
  const conf = ev({ allDay: true, title: '学会', start: T('2026-11-07T00:00:00'), end: T('2026-11-09T00:00:00') });
  assert.match(planChange(conf, { all_day: false }).error, /開始時刻/);
  assert.equal(planChange(conf, { date: '2026-11-14' }).after.end, T('2026-11-16T00:00:00'));
  assert.equal(planChange(conf, { start: '09:00' }).after.end, T('2026-11-07T10:00:00'));
  // 件名・場所だけ。場所は空文字で消す。同じなら変更なし
  assert.equal(planChange(e, { title: '歯医者（定期）' }).after.title, '歯医者（定期）');
  assert.equal(planChange(ev({ location: '船橋駅' }), { location: '' }).after.location, undefined);
  assert.match(planChange(e, { start: '10:00' }).error, /同じ/);
  assert.match(planChange(e, { date: '11/9' }).error, /YYYY-MM-DD/);
});

test('確認ボタンを押したら：直前にもう一度確かめて、変わったところだけ書く。1日は元に戻せる', async () => {
  const store = memStore();
  const now = T('2026-11-01T12:00:00');
  const e = ev({ title: '11:40 みなと研修会' });
  const g = fakeGoogle({ etag: '"1"', summary: '11:40 みなと研修会', location: undefined });
  const { id, message } = await stashEdit(store, now, { op: 'update', e, after: planChange(e, { start: '11:40' }).after });
  assert.match(message.template.text, /この予定を変更しますか？\n11\/7\(土\) 10:00〜11:00 11:40 みなと研修会\n→ 11\/7\(土\) 11:40〜12:40/);
  assert.deepEqual(message.template.actions.map((a) => a.data), [`edok|${id}`, `edno|${id}`]);
  const r = await applyEdit({ store, token: 't', id, now, g });
  assert.match(r.text, /^変更しました。\n11\/7\(土\) 11:40〜12:40 11:40 みなと研修会/);
  assert.deepEqual(g.calls[0], ['patch', '"1"', { start: T('2026-11-07T11:40:00'), end: T('2026-11-07T12:40:00'), allDay: false }]);
  // 同じボタンをもう一度押しても書かない
  assert.match((await applyEdit({ store, token: 't', id, now, g })).text, /もう使えません/);
  const u = await undoEdit({ store, token: 't', id, now: now + 3600e3, g });
  assert.match(u.text, /^元に戻しました。\n11\/7\(土\) 10:00〜11:00/);
  assert.deepEqual(g.calls[1], ['patch', '"2"', { start: T('2026-11-07T10:00:00'), end: T('2026-11-07T11:00:00'), allDay: false }]);
  assert.match((await undoEdit({ store, token: 't', id, now, g })).text, /戻せる変更がありません/);
});

test('押すまでの間に予定が変わっていたら書かない・消えていたらそう言う', async () => {
  const store = memStore();
  const now = T('2026-11-01T12:00:00');
  const g = fakeGoogle({ etag: '"1"', summary: '歯医者' });
  const { id } = await stashEdit(store, now, { op: 'delete', e: ev() });
  g.touch();
  assert.match((await applyEdit({ store, token: 't', id, now, g })).text, /予定が変わっていた/);
  assert.equal(g.calls.length, 0);
  const { id: id2 } = await stashEdit(store, now, { op: 'delete', e: ev() });
  assert.match((await applyEdit({ store, token: 't', id: id2, now, g: fakeGoogle(null) })).text, /もう見つかりません/);
});

test('削除 → 元に戻すはゴミ箱から戻す。あとで別の変更をしたら前の「元に戻す」は効かない', async () => {
  const store = memStore();
  const now = T('2026-11-01T12:00:00');
  const g = fakeGoogle({ etag: '"1"', summary: '歯医者' });
  const a = await stashEdit(store, now, { op: 'delete', e: ev() });
  const b = await stashEdit(store, now, { op: 'update', e: ev({ id: 'e2' }), after: planChange(ev({ id: 'e2' }), { title: '検診' }).after });
  assert.match((await applyEdit({ store, token: 't', id: a.id, now, g })).text, /^削除しました。\n11\/7\(土\) 10:00〜11:00 歯医者/);
  assert.deepEqual(g.calls[0], ['delete', '"1"']);
  const g2 = fakeGoogle({ etag: '"1"', summary: '歯医者' });
  await applyEdit({ store, token: 't', id: b.id, now, g: g2 });
  assert.match((await undoEdit({ store, token: 't', id: a.id, now, g })).text, /戻せる変更がありません/);
  const store2 = memStore();
  const c = await stashEdit(store2, now, { op: 'delete', e: ev() });
  await applyEdit({ store: store2, token: 't', id: c.id, now, g });
  assert.match((await undoEdit({ store: store2, token: 't', id: c.id, now, g })).text, /元に戻しました/);
  assert.deepEqual(g.calls.at(-1), ['restore']);
});

test('「バイト候補」で入れた求人：取消なら消す案、確定なら件名を「【勤務確定】…」にする案', () => {
  const start = T('2026-11-07T09:00:00');
  const evs = [ev({ title: '外来', start }), ev({ id: 'c1', title: 'バイト候補：自社求人 大和市 健診', start, end: start + 3 * 3600e3 })];
  const del = candidateEdit(evs, start, 'cancelled');
  assert.equal(del.op, 'delete');
  assert.equal(del.e.id, 'c1');
  const ren = candidateEdit(evs, start, 'confirmed');
  assert.equal(ren.after.title, '【勤務確定】自社求人 大和市 健診');
  assert.equal(candidateEdit(evs, start, 'applied'), null);
  assert.equal(candidateEdit(evs, start + 3600e3, 'cancelled'), null);
});

// ---- 会話から ----

const scripted = (steps) => { let i = 0; const seen = []; const call = async (_k, req) => { seen.push(structuredClone(req)); return steps[i++]; }; call.seen = seen; return call; };
const toolUse = (name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t${name}`, name, input }] });
const say = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

function setup(events) {
  const store = memStore();
  const api = {
    settings: async () => ({ quiet: { from: 1, to: 7 }, name: '山田' }), loadJobs: async () => new Map(), currentMatches: async () => ({ hits: [], busy: [] }),
    order: async () => ({ list: [], total: 0 }), cards: async () => null,
    busyOn: async () => events.filter((e) => e.busy), eventsOn: async () => events, findEvents: async (q) => events.filter((e) => e.title.includes(q)),
  };
  return { store, ctx: { store, secrets: { ANTHROPIC_API_KEY: 'k' } }, api };
}

test('「歯医者を15時からにして」：予定に E1… の参照名を付けて渡し、変更の案（確認ボタン）を出すだけ', async () => {
  const now = T('2026-11-06T20:00:00');
  const events = [ev(), ev({ id: 'e9', title: '外来', start: T('2026-11-07T15:30:00'), end: T('2026-11-07T17:00:00') })];
  const { store, ctx, api } = setup(events);
  const call = scripted([toolUse('propose_change', { ref: 'E1', start: '15:00' }), say('11/7(土) 歯医者を 15:00〜16:00 に変えますか？ 15:30からの外来と重なります。')]);
  const r = await runAgent({ text: '明日の歯医者を15時からにして', ctx, api, call, now });
  assert.match(call.seen[0].system, /<calendar>\nE1 11\/7\(土\) 10:00-11:00 歯医者\nE2 11\/7\(土\) 15:30-17:00 外来/);
  const res = JSON.parse(call.seen[1].messages.at(-1).content[0].content);
  assert.equal(res.ok, true);
  assert.deepEqual(res.overlaps, ['15:30-17:00 外来']);
  const confirm = r.messages.find((m) => m.type === 'template');
  assert.match(confirm.template.text, /→ 11\/7\(土\) 15:00〜16:00/);
  assert.equal(store.st.get('assistant:pendingedits')[0].eventId, 'e1');
  assert.equal(r.private, true);
});

test('共有カレンダーの他の先生の予定は消す案を出さず、理由を返す。find_events で日付の分からない予定も探せる', async () => {
  const now = T('2026-11-01T12:00:00');
  const events = [ev({ id: 's1', primary: undefined, calName: '医局Dr不在日', title: '佐藤不在', allDay: true, busy: false, start: T('2026-11-13T00:00:00'), end: T('2026-11-14T00:00:00') })];
  const { store, ctx, api } = setup(events);
  const call = scripted([toolUse('find_events', { query: '佐藤' }), toolUse('propose_delete', { ref: 'E1' }), say('共有カレンダーの予定なので、こちらでは消せません。')]);
  const r = await runAgent({ text: '佐藤不在を消して', ctx, api, call, now });
  assert.match(JSON.parse(call.seen[1].messages.at(-1).content[0].content).events[0], /^E1 11\/13\(金\) 終日 佐藤不在/);
  assert.match(JSON.parse(call.seen[2].messages.at(-1).content[0].content).note, /共有カレンダー/);
  assert.equal(r.messages.find((m) => m.type === 'template'), undefined);
  assert.equal(store.st.get('assistant:pendingedits'), undefined);
});
