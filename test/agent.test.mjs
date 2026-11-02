import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent.mjs';

const job = (id, o = {}) => ({ uid: id, data: { uid: id, site: 'feed', siteLabel: '自社求人', date: '2026-10-21', startTime: '08:30', endTime: '11:30', pref: '神奈川県', city: '大和市', workOutline: '健診', payText: '一回 60,000円', payAmount: 60000, url: 'https://jobs.example.com/jobs/5039558' }, ...o });

function setup(jobsList, state = {}) {
  const st = new Map(Object.entries(state));
  const store = { getState: async (k) => st.get(k) ?? null, putState: async (k, v) => { st.set(k, v); } };
  const jobs = new Map(jobsList.map((j) => [j.uid, j]));
  const api = { settings: async () => ({ quiet: { from: 1, to: 7 } }), loadJobs: async () => jobs, currentMatches: async () => ({ hits: [], busy: [] }), order: async () => ({ list: [], total: 0 }), busyOn: async () => [], eventsOn: async () => [], cards: async () => null, liveCheck: async () => ({ state: 'ended', at: Date.parse('2026-10-20T01:06:00+09:00') }) };
  return { st, ctx: { store, secrets: { ANTHROPIC_API_KEY: 'k' } }, api };
}

// Claude の代わりに決めた順で答える
const scripted = (steps) => { let i = 0; const seen = []; const call = async (_k, req) => { seen.push(structuredClone(req)); return steps[i++]; }; call.seen = seen; return call; };
const toolUse = (name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t${name}`, name, input }] });
const say = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

test('「これまだある？」：引用された求人を参照名にして check_job で確かめ、見えなくなっていればそう返す', async () => {
  const { ctx, api } = setup([job('feed:5039558', { missingSince: '2026-10-19T16:06:00Z' })]);
  const call = scripted([toolUse('check_job', { ref: 'Q1' }), say('10/21の大和市・午前健診は、巡回で見えなくなっていて募集終了の可能性が高いです。')]);
  const r = await runAgent({ text: 'これまだある？', quoted: ['feed:5039558'], ctx, api, call, now: Date.parse('2026-10-20T01:10:00+09:00') });
  assert.match(call.seen[0].messages.at(-1).content, /引用して返信しています: Q1/);
  const result = JSON.parse(call.seen[1].messages.at(-1).content[0].content);
  assert.match(result.official, /募集終了を確認しました（10\/20 01:06）/);
  assert.match(result.crawl, /見えなくなった/);
  assert.match(r.messages[0].text, /募集終了/);
});

test('本人の取消は remember で本人がしたこととして覚える', async () => {
  const { st, ctx, api } = setup([]);
  const call = scripted([toolUse('remember', { kind: 'engagement', subject: 'さくらクリニック 10/28', text: '本人が取消済み。中央病院の日勤は予定どおり', date: '2026-10-28' }), say('了解です。10/28のさくらは取消済み、中央病院の日勤は予定どおりとして扱います。')]);
  const r = await runAgent({ text: 'さくらのほうを取り消しました', ctx, api, call });
  assert.equal(st.get('assistant:profile')[0].text, '本人が取消済み。中央病院の日勤は予定どおり');
  assert.doesNotMatch(r.messages[0].text, /取り消しました/);
});

test('カレンダーは案（はい／いいえ）を出すだけ。「1番」は直前の一覧の1件目', async () => {
  const { ctx, api } = setup([job('feed:1')], { 'assistant:recent': [{ ref: 'J1', id: 'feed:1' }] });
  const call = scripted([toolUse('propose_calendar', { ref: '1番' }), say('1番の案を出しました。「はい」で入ります。')]);
  const r = await runAgent({ text: '1番をカレンダーに', ctx, api, call });
  const confirm = r.messages.find((m) => m.type === 'template');
  assert.equal(confirm.template.actions[0].data, 'addok|feed:1');
});

test('報酬は前回比だけ。通常額比は未確認と返す', async () => {
  const j = job('feed:5040703', { payLog: [{ at: '2026-10-18T22:10:00Z', amount: 32000 }, { at: '2026-10-19T09:40:00Z', amount: 40000 }] });
  const { ctx, api } = setup([j], { 'assistant:recent': [{ ref: 'J1', id: 'feed:5040703' }] });
  const call = scripted([toolUse('pay_history', { ref: 'J1' }), say('前回比 ＋8,000円／＋25%です。')]);
  await runAgent({ text: '1番上がった？', ctx, api, call });
  const res = JSON.parse(call.seen[1].messages.at(-1).content[0].content);
  assert.match(res.change, /＋8,000円／＋25%/);
  assert.match(res.normal, /未確認/);
});

test('時間切れ・答えなしは null（従来の処理に任せる）', async () => {
  const { ctx, api } = setup([]);
  assert.equal(await runAgent({ text: 'こんにちは', ctx, api, call: scripted([{ stop_reason: 'end_turn', content: [] }]) }), null);
});

import { liveCheck, liveText } from '../src/livecheck.mjs';

test('掲載状況の確認：JOBS_STATUS_URL に聞く。404 と "ended" は終了、未設定は確かめない、同じ問い合わせ先は間をあける', async () => {
  const st = new Map();
  const store = { getState: async (k) => st.get(k) ?? null, putState: async (k, v) => { st.set(k, v); } };
  const page = (status, body) => async (u) => { page.url = u; return { status, text: async () => body }; };
  const one = (id) => ({ uid: `feed:${id}`, site: 'feed', data: { uid: `feed:${id}`, site: 'feed', id, siteLabel: '自社求人' } });
  const none = await liveCheck(one('S0'), { store });
  assert.equal(none.state, 'unknown');
  assert.match(none.why, /掲載状況を確かめられません/);
  process.env.JOBS_STATUS_URL = 'https://api.example.com/jobs/{id}/status';
  const ended = await liveCheck(one('S1'), { store, fetchImpl: page(404, 'not found') });
  assert.equal(page.url, 'https://api.example.com/jobs/S1/status');
  assert.equal(ended.state, 'ended');
  assert.match(liveText(ended), /募集終了を確認/);
  const tooSoon = await liveCheck(one('S2'), { store, fetchImpl: page(200, '{"status":"open"}'), sleep: async () => {} });
  assert.equal(tooSoon.state, 'open'); // 1秒の間は待って確かめる
  st.set('livegate#api.example.com', Date.now() + 60e3);
  const wait = await liveCheck(one('S3'), { store, fetchImpl: page(200, '{"status":"open"}') });
  assert.equal(wait.state, 'unknown'); // 長く待つなら確かめない
  st.set('livegate#api.example.com', 0);
  const closed = await liveCheck(one('S4'), { store, fetchImpl: page(200, '{"status":"closed"}') });
  assert.equal(closed.state, 'ended');
  const fail = await liveCheck(one('S5'), { store, fetchImpl: async () => { throw new Error('timeout'); }, sleep: async () => {} });
  assert.equal(fail.state, 'unknown');
  assert.doesNotMatch(fail.why, /終了/); // 取得失敗を終了と決めつけない
  delete process.env.JOBS_STATUS_URL;
});

test('バイト以外の予定：propose_event で「入れる／やめる」を出すだけ。重なる予定を返す', async () => {
  const { st, ctx, api } = setup([]);
  api.busyOn = async () => [{ start: Date.parse('2026-10-30T14:30:00+09:00'), end: Date.parse('2026-10-30T16:00:00+09:00'), allDay: false }];
  const call = scripted([toolUse('propose_event', { title: '歯医者', date: '2026-10-30', start: '14:00', end: null }), say('10/30(金) 14:00〜15:00 歯医者で入れますか？14:30からの予定と重なります。')]);
  const r = await runAgent({ text: '30日の14時に歯医者入れといて', ctx, api, call, now: Date.parse('2026-10-24T10:00:00+09:00') });
  const result = JSON.parse(call.seen[1].messages.at(-1).content[0].content);
  assert.equal(result.when, '10/30(金) 14:00〜15:00');
  assert.deepEqual(result.overlaps, ['14:30-16:00 予定あり']);
  const confirm = r.messages.at(-1);
  const [p] = st.get('assistant:pendingevents');
  assert.equal(confirm.template.actions[0].data, `evok|${p.id}`);
  assert.match(confirm.template.text, /歯医者/);
  assert.equal(r.private, true);
});

test('eventFrom：時刻なしは終日、終わりが開始より前なら翌日', async () => {
  const { eventFrom } = await import('../src/agent.mjs');
  const a = eventFrom({ title: '学会', date: '2026-11-03' });
  assert.equal(a.allDay, true);
  assert.equal(a.end - a.start, 864e5);
  const b = eventFrom({ title: '夜勤', date: '2026-11-03', start: '22:00', end: '07:00' });
  assert.equal(b.end - b.start, 9 * 3600e3);
  assert.equal(eventFrom({ title: 'x', date: '来週' }), null);
});

test('アプリのリンクがある求人を紹介したら、返事に ID とアプリで開くリンクを付ける（JOB_HOSTS のドメインだけ）', async () => {
  process.env.JOB_HOSTS = 'jobs.example.com,app.example.com';
  const j = job('feed:4755260', { data: { ...job('x').data, uid: 'feed:4755260', id: '4755260', appUrl: 'https://app.example.com/jobs/4755260' } });
  const bad = job('feed:9', { data: { ...job('x').data, uid: 'feed:9', id: '9', appUrl: 'https://evil.example.net/9' } });
  const { ctx, api } = setup([j, bad], { 'assistant:recent': [{ ref: 'J1', id: 'feed:4755260' }, { ref: 'J2', id: 'feed:9' }] });
  const call = scripted([say('おすすめは1番の10/21大和です。')]);
  const r = await runAgent({ text: 'どれがいい？', ctx, api, call });
  delete process.env.JOB_HOSTS;
  assert.match(r.messages[0].text, /1番 ID 4755260\nhttps:\/\/app\.example\.com\/jobs\/4755260/);
  assert.doesNotMatch(r.messages[0].text, /evil/);
});

test('「1番応募した」は set_status で控える（リマインド用）', async () => {
  const j = job('feed:7', { data: { ...job('x').data, uid: 'feed:7', id: '7', date: '2026-10-30' } });
  const { st, ctx, api } = setup([j], { 'assistant:recent': [{ ref: 'J1', id: 'feed:7' }] });
  const call = scripted([toolUse('set_status', { ref: '1番', status: 'applied' }), say('1番を応募済みとして控えました。前日の夜と出発前にお知らせします。')]);
  await runAgent({ text: '1番応募した', ctx, api, call, now: Date.parse('2026-10-26T10:00:00+09:00') });
  const [s] = st.get('assistant:shifts');
  assert.equal(s.status, 'applied');
  assert.equal(s.start, Date.parse('2026-10-30T08:30:00+09:00'));
});
