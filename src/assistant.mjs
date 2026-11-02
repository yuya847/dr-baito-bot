// LINE のやり取りの中身：空きに合う件数を伝える → 何を重視するかを言葉で聞く → AI が条件にして上位10件を出す。
// 「カレンダーに追加」は確認ボタン（追加する）を押したときだけ書き込む。既存の予定の変更・削除も確認ボタンを押したときだけ（edit.mjs）。
// 応募や問い合わせはしない。
// 今は利用者1人（Google を連携した本人）。LINE の userId とは連携コードで結びつける（scripts/line-link.mjs）。
import * as google from './lib/google.mjs';
import * as line from './lib/line.mjs';
import * as claude from './lib/claude.mjs';
import { ANYTIME, expandWindows, freeSlots, matchJobs } from './match.mjs';
import { rankJobs } from './rank.mjs';
import { travelFor } from './travel.mjs';
import { restCheck } from './rest.mjs';
import { weekdayOf } from './lib/normalize.mjs';
import { SITES } from './sites/index.mjs';
import { DEFAULT_QUIET, inQuiet, parseQuiet, quietText, getSettings, putSettings, getMemory, memoryForPrompt, mergeFacts } from './memory.mjs';
import { learnFromTurn } from './learn.mjs';
import { runAgent } from './agent.mjs';
import { cardsAlt, collect, headline } from './scout.mjs';
import { shiftFrom, setShift, dueReminders, reminderLines, reminderRoute, STATUS_LABEL } from './remind.mjs';
import { busyOf } from './schedule.mjs';
import { careNotices, eveningBrief } from './care.mjs';
import { applyEdit, candidateEdit, stashEdit, undoEdit } from './edit.mjs';

const MAX_NEW = 3;
// LINE の無料枠（月200通・プッシュだけ数える）の残りがこれ以下になったら、急がない知らせ（前夜のひとこと・新着・増額・感想）は控える
const PUSH_RESERVE = 20;

const DAYS = 14;
const PAGE = 10; // カルーセルは最大12枚。1回に10件
const QUICK = ['もっと見る', '条件を変える', '結果が違う'];
// 考えずに押せる選択肢（文字で送ってもよい）
const START = ['時給が高い順', '家から近い', 'ゆとり勤務', '17時以降だけ', '土日だけ'];
const EXAMPLES = '例：「時給が高い順」「船橋から1時間以内」「ゆとりのある勤務（健診・寝当直など）」「土曜の午前だけ、救急車対応はなし」';

/** 本人が決めた時間帯（既定は日本時間 1〜7時）はプッシュしない。本人からの話しかけへの返信は時間を問わない */
export function isQuiet(now = Date.now(), quiet = DEFAULT_QUIET) {
  return inQuiet(now, quiet);
}
const QUIET_CHOICES = ['1時〜7時（標準）', '22時〜7時', '0時〜8時', '23時〜6時', 'いつでもOK'];
const quietAsk = (q) => line.text(`通知を送らない時間帯は、今は「${quietText(q)}」です。変えますか？\nボタンを押すか「22時〜7時」のように送ってください。`, line.quickReplies(QUIET_CHOICES));

// 温まった Lambda では求人を2分だけ使い回す（DynamoDB の読み出しを減らす）
let jobCache = { at: 0, map: null };
export async function loadJobs(store, now = Date.now()) {
  if (jobCache.map && now - jobCache.at < 120_000) return jobCache.map;
  const map = new Map();
  for (const site of Object.keys(SITES)) for (const [uid, j] of await store.getJobs(site)) map.set(uid, j);
  jobCache = { at: now, map };
  return map;
}

/**
 * 今後2週間の予定（件名・場所つき）。events は「空き」表示も含む全部、busy は照合に使う「予定あり」
 * （件名にだけ時刻が書かれた予定は、その時間もふさぐ）。
 */
async function currentBusy(secrets, now) {
  const token = await google.getAccessToken(secrets);
  // 前日の予定の場所からの移動・前夜の当直も見るので、少し前から読む
  const events = await google.listEvents(token, { timeMin: new Date(now - 864e5).toISOString(), timeMax: new Date(now + (DAYS + 1) * 864e5).toISOString() });
  return { token, events, busy: busyOf(events) };
}

/** 今後2週間の、カレンダーの予定に干渉しない求人 */
export async function currentMatches({ store, secrets, now = Date.now() }) {
  const { token, busy, events } = await currentBusy(secrets, now);
  const slots = freeSlots(expandWindows(ANYTIME, { from: now, days: DAYS }), busy);
  const jobs = await loadJobs(store, now);
  const hits = matchJobs([...jobs.values()], slots, { now });
  // 当直の前後（前夜の当直・明けの予定）の注意。順位を下げ、カードにも出す
  for (const h of hits) h.rest = restCheck(h.interval, busy);
  return { hits, jobs, token, busy, events };
}

/** 求人の勤務時間（日をまたぐ当直は翌日まで） */
function jobInterval(d) {
  const start = Date.parse(`${d.date}T${d.startTime}:00+09:00`);
  let end = Date.parse(`${d.date}T${d.endTime}:00+09:00`);
  if (end <= start) end += 864e5;
  return { start, end };
}

// 「どこが違いましたか？」のあとに押すボタン → 次の質問（答えは AI が条件にする）
const FOLLOW = {
  時間が違う: ['何時ごろがいいですか？', ['午前だけ', '午後だけ', '17時以降だけ', '当直（夜間）']],
  日付が違う: ['いつがいいですか？', ['明日', '明後日', '今週末', '来週']],
  場所が遠い: ['どこから通いますか？ 駅名か市区町村を送ってください（例：船橋駅）。'],
  時給が低い: ['時給いくら以上がいいですか？', ['1万円以上', '1.2万円以上', '1.5万円以上', '2万円以上']],
  仕事内容が違う: ['どんな仕事がいいですか？', ['外来', '健診', '当直', '内視鏡', '在宅']],
};
const askText = (n) => `カレンダーの予定と重ならない求人が、今後2週間で${n}件あります。\n何を重視しますか？ 下のボタンを押すか、言葉で送ってください。`;
const askMsg = (n) => line.text(askText(n), line.quickReplies(START));

/** prefs で並べ、AI に上位を選ばせて、表示順（id と理由）を返す */
async function order(secrets, prefs, hits, memory = '', model) {
  const ranked = rankJobs(hits, prefs);
  let picks = [];
  try { picks = await claude.pickJobs(secrets.ANTHROPIC_API_KEY, prefs, ranked, { memory, model }); } catch (e) { console.log('pickJobs 失敗（採点順で出す）', e.message); }
  const picked = new Set(picks.map((p) => p.id));
  const rest = ranked.filter((h) => !picked.has((h.job.data || h.job).uid)).map((h) => ({ id: (h.job.data || h.job).uid, reason: '' }));
  return { list: [...picks, ...rest].slice(0, 60), total: ranked.length };
}

/** 1件を一言で（「10/20(火) 18:00〜21:00 千葉市・内科外来（時給1.4万）」） */
function oneLine(job) {
  const d = job.data || job;
  const pay = d.hourlyRate ? `時給${(d.hourlyRate / 10000).toFixed(d.hourlyRate % 10000 ? 1 : 0)}万` : (d.payText || '').slice(0, 15);
  return `${line.fmtDate(d)} ${d.city || d.pref}・${(d.workOutline || d.title || '').split(/[,、]/)[0].slice(0, 15)}（${pay}）`;
}

/**
 * 候補のページ。最初のページは「◯件見つかりました。おすすめは〜です。」→ カード → おすすめをカレンダーに入れるか はい/いいえ。
 * 考える手間を減らすため、答えはボタンで返せるようにする。
 */
async function pageMessages(session, jobs, busy, intro) {
  const items = session.list.slice(session.offset, session.offset + PAGE)
    .map((x) => ({ job: jobs.get(x.id), reason: x.reason })).filter((x) => x.job);
  // 前後の予定に場所があれば、そこからの移動の目安を付ける（失敗してもカードは出す）
  await Promise.all(items.map(async (x) => {
    x.rest = restCheck(jobInterval(x.job.data || x.job), busy);
    try { x.travel = await travelFor(x.job, jobInterval(x.job.data || x.job), busy); } catch (e) { console.log('移動の目安 失敗', e.message); }
  }));
  if (!items.length) return [line.text('ほかの候補はもうありません。条件を変えますか？', line.quickReplies(['条件を変える', ...START.slice(0, 4)]))];
  const left = Math.max(0, session.list.length - session.offset - items.length);
  const more = left ? ['もっと見る', '条件を変える', '結果が違う'] : ['条件を変える', '結果が違う'];
  const top = items[0];
  if (session.offset === 0) {
    const rec = `おすすめは ${oneLine(top.job)} です。${top.reason ? `\n💡${top.reason}` : ''}`;
    return [
      line.text(`${intro}\n\n${rec}`),
      line.jobCarousel(items, intro),
      line.confirmAdd(top.job, { ask: 'おすすめをカレンダーに入れますか？', yes: 'はい', no: 'いいえ', quick: line.quickReplies(more) }),
    ];
  }
  return [
    line.text(`続きの${items.length}件です${left ? `（ほかに${left}件）` : ''}。`),
    line.jobCarousel(items, '続きの候補'),
    line.text('気になる求人は、カードの「カレンダーに追加」を押してください。', line.quickReplies(more)),
  ];
}

const showPrefs = (p) => (p
  ? `今の条件：${p.summary}${p.minHourly ? `\n・時給 ${p.minHourly.toLocaleString('ja-JP')}円以上` : ''}${p.origin ? `\n・出発地 ${p.origin}` : ''}${p.excludeKeywords?.length ? `\n・避ける：${p.excludeKeywords.join('、')}` : ''}\n\n変えたいときは、そのまま言葉で送ってください。`
  : `まだ条件がありません。\n${EXAMPLES}`);

/** Webhook の1イベントを処理する。ctx = { store, secrets, now } */
export async function handleEvent(ev, ctx) {
  const { store, secrets } = ctx;
  const tok = secrets.LINE_CHANNEL_ACCESS_TOKEN;
  const userId = ev.source?.userId;
  if (!userId || ev.source.type !== 'user') return;
  // 送ったメッセージの id を覚えておき、本人が引用返信したときに「どの求人の話か」をたどる
  const say = async (msgs) => { const r = ctx._say ? (ctx._say(msgs), {}) : await line.reply(tok, ev.replyToken, msgs); ctx.sent = r?.sentMessages || []; return r; };
  ctx = { ...ctx, userId, quotedId: ev.message?.quotedMessageId || null };
  const owner = await store.getState('line:owner');

  if (owner?.userId !== userId) {
    // 連携前：連携コード（6桁）だけ受け付ける
    const t = ev.type === 'message' && ev.message.type === 'text' ? ev.message.text.trim() : '';
    const code = await store.getState('line:linkcode');
    if (/^\d{6}$/.test(t) && code && code.exp > (ctx.now || Date.now()) && t === code.code) {
      await store.putState('line:owner', { userId, linkedAt: new Date(ctx.now || Date.now()).toISOString() });
      await store.putState('line:linkcode', null);
      line.loading(tok, userId);
      const { hits } = await currentMatches(ctx);
      await store.putState('assistant:asked', ctx.now || Date.now());
      return say([line.text('連携しました。'), askMsg(hits.length)]);
    }
    if (ev.type === 'follow' || t) return say([line.text('友だち追加ありがとうございます。いまは招待制です。届いた6桁の連携コードを送ってください。')]);
    return;
  }

  if (ev.type === 'follow') {
    const { hits } = await currentMatches(ctx);
    return say([askMsg(hits.length)]);
  }

  if (ev.type === 'postback') return handlePostback(ev, ctx, say);
  if (ev.type !== 'message' || ev.message.type !== 'text') return say([line.text('文字で送ってください。')]);

  const t = ev.message.text.trim();
  // 直近のやり取りを残す（文脈として AI に渡す・不具合の調査用。30件まで）
  const log = (await store.getState('assistant:log')) || [];
  const turn = { at: new Date(ctx.now || Date.now()).toISOString(), user: t.slice(0, 200), bot: '' };
  try {
    return await handleText(t, ctx, say, log, turn);
  } finally {
    await store.putState('assistant:log', [...log, turn].slice(-30)).catch(() => {});
    if (turn.shownIds?.length && ctx.sent?.length) {
      const map = (await store.getState('assistant:msgmap')) || {};
      for (const m of ctx.sent) map[m.id] = turn.shownIds;
      await store.putState('assistant:msgmap', Object.fromEntries(Object.entries(map).slice(-60))).catch(() => {});
    }
    // 返事を送ったあとで、この往復から本人のこと・返し方の反省を学ぶ（ボタン操作は除く）
    if (!turn.cmd) {
      await learnFromTurn({ apiKey: secrets.ANTHROPIC_API_KEY, store, turn, history: log, now: turn.at })
        .then((r) => { if (r.facts || r.lessons) console.log('学習', JSON.stringify(r)); })
        .catch((e) => console.log('学習に失敗', e.message));
    }
  }
}

const fmtDay = (d) => { const [, m, day] = d.split('-').map(Number); return `${m}/${day}(${weekdayOf(d)})`; };

async function handleText(t, ctx, say, log, turn) {
  const { store, secrets } = ctx;
  const tok = secrets.LINE_CHANNEL_ACCESS_TOKEN;
  const prefs = await store.getState('assistant:prefs');
  const reply = (msgs, note) => { turn.bot = note || msgs.map((m) => m.text || m.altText || '').join(' / ').slice(0, 300); return say(msgs); };
  const cmd = (msgs, note) => { turn.cmd = true; return reply(msgs, note); };
  if (/^(もっと|次|続き)/.test(t)) { turn.cmd = true; turn.bot = '（もっと見る）'; return more(ctx, say); }
  // 通知を送らない時間帯（本人が決める）
  if (QUIET_CHOICES.includes(t) || /^通知(の|を止める|を送らない)?時間/.test(t) || (/通知|送らない|静かに|鳴らさない/.test(t) && parseQuiet(t))) {
    const q = parseQuiet(t);
    const settings = await getSettings(store);
    if (!q) return cmd([quietAsk(settings.quiet)]);
    await putSettings(store, { quiet: q.quiet, quietAsked: true });
    return cmd([line.text(q.quiet ? `わかりました。${quietText(q.quiet)}は通知を送りません。` : 'わかりました。時間帯を問わず通知します。', line.quickReplies(QUICK))]);
  }
  if (/^覚えていること$|^何を覚えて/.test(t)) {
    const { facts, lessons } = await getMemory(store);
    const body = facts.length ? facts.slice(-15).map((f) => `・${f.subject ? `${f.subject}：` : ''}${f.text}`).join('\n') : 'まだありません。';
    return cmd([line.text(`覚えていること（会話から）：\n${body}${lessons.length ? `\n\n返し方で気をつけること：\n${lessons.slice(-5).map((l) => `・${l.text}`).join('\n')}` : ''}\n\n消したいときは「覚えていることを消す」と送ってください。`)]);
  }
  if (/^覚えていることを(消す|忘れて)|^全部忘れて/.test(t)) {
    await store.putState('assistant:profile', []);
    await store.putState('assistant:lessons', []);
    return cmd([line.text('覚えていたことを消しました。')]);
  }
  const home = t.normalize('NFKC').match(/^(?:出発地|自宅|最寄り?駅?)(?:は|を)\s*(.{2,40}?)(?:です|にして|に変更|で)?[。.]?$/);
  if (home) {
    await putSettings(store, { home: home[1] });
    return cmd([line.text(`出発地を「${home[1]}」にしました。バイトの前日と出発前のリマインドで、ここからの所要時間の目安を出します（同じ日に前の予定があればそこから）。`)]);
  }
  const name = t.normalize('NFKC').match(/^(?:私の|僕の)?(?:名前|苗字|名字|姓)は\s*(.{1,10}?)(?:です)?[。.]?$/);
  if (name) {
    await putSettings(store, { name: name[1] });
    return cmd([line.text(`「${name[1]}」さんとして覚えました。カレンダーの終日予定のうち、名前が入ったものを本人の予定として扱います。`)]);
  }
  if (/^(今の条件|条件を確認)/.test(t)) return cmd([line.text(`${showPrefs(prefs)}\n\n通知を送らない時間帯：${quietText((await getSettings(store)).quiet)}（「通知の時間」で変更）`)]);
  if (/^条件を変える$/.test(t)) return cmd([line.text('何を重視しますか？ 下のボタンを押すか、言葉で送ってください。', line.quickReplies(START))]);
  const follow = FOLLOW[t];
  if (follow) return cmd([line.text(follow[0], follow[1] ? line.quickReplies(follow[1]) : undefined)]);
  if (/^(結果が違う|違う|おかしい)$/.test(t)) {
    // 直前の結果に「違う」と印を付けて、どこが違うかをボタンで聞く（記録は改善に使う）
    if (log.length) log[log.length - 1].feedback = 'bad';
    turn.feedback = 'bad';
    turn.cmd = true;
    return reply([line.text('すみません。どこが違いましたか？ 正しい条件を送ってもらえれば、探し直します。', line.quickReplies(['時間が違う', '日付が違う', '場所が遠い', '時給が低い', '仕事内容が違う']))]);
  }

  line.loading(tok, ctx.userId, 50);
  // Bot からの通知（push）は、本人がそれに返事をすることがあるので長めに渡す
  const history = log.slice(-6).map((x) => ({ user: x.user, bot: x.bot.slice(0, x.push ? 400 : 120) }));

  // 秘書としての会話（道具を使って調べてから短く返す）。失敗・時間切れなら下の従来の処理で答える
  if (process.env.AGENT !== 'off') {
    try {
      const quoted = ctx.quotedId ? ((await store.getState('assistant:msgmap')) || {})[ctx.quotedId] || [] : [];
      const r = await runAgent({ text: t, quoted, history, ctx, api: agentApi(ctx), now: ctx.now || Date.now() });
      if (r) {
        turn.intent = 'agent';
        turn.tools = r.tools;
        turn.shownIds = r.shown;
        if (r.private) turn.cmd = true; // 本人の私的な予定は「覚えること」にしない
        if (r.shown.length) {
          const jobs = await loadJobs(store, ctx.now);
          turn.shown = r.shown.map((id) => { const d = jobs.get(id)?.data || {}; return `${d.date} ${d.startTime}-${d.endTime} ${d.city} ${d.hourlyRate || ''}`; });
        }
        return reply(r.messages, r.note.slice(0, 300));
      }
      console.log('agent: 答えが出なかった（従来の処理で答える）');
    } catch (e) { console.log('agent 失敗（従来の処理で答える）', e.message); }
  }
  const memory = memoryForPrompt(await getMemory(store));
  const parsed = await claude.parsePrefs(secrets.ANTHROPIC_API_KEY, t, prefs, { now: ctx.now || Date.now(), history, memory });
  turn.intent = parsed.intent;
  turn.dates = parsed.dates;
  if (parsed.intent === 'more') { turn.bot = '（もっと見る）'; return more(ctx, say); }
  if (parsed.intent === 'show') return reply([line.text(showPrefs(prefs))]);
  if (parsed.intent === 'reset') {
    await store.putState('assistant:prefs', null);
    return reply([line.text(`条件を消しました。何を重視しますか？\n${EXAMPLES}`)]);
  }
  // 日付だけ聞かれた（「明後日は？」）ときは、今の条件のまま日付で絞る
  const usePrefs = parsed.intent === 'prefs' ? parsed.prefs : (parsed.dates.length && prefs ? prefs : null);
  if (!usePrefs) return reply([line.text(`空き時間に合うスポット求人を探すお手伝いをしています。何を重視して選ぶか、または「明後日」「土曜」など日付を送ってください。\n${EXAMPLES}`)]);

  if (parsed.intent === 'prefs') await store.putState('assistant:prefs', usePrefs);
  const { hits: all, jobs, busy } = await currentMatches(ctx);
  const dates = parsed.dates;
  const onDates = (d) => !dates.length || dates.includes(d.date);
  const hits = all.filter((h) => onDates(h.job.data || h.job));
  const { list, total } = await order(secrets, usePrefs, hits, memory);
  const session = { list, offset: 0, at: ctx.now || Date.now(), dates };
  await store.putState('assistant:session', { ...session, offset: PAGE });
  // いま見せた候補は、次の定時通知では「新しく合う求人」に数えない
  if (!dates.length) await store.putState('assistant:sent', all.map((h) => (h.job.data || h.job).uid).slice(-3000));

  const when = dates.length ? `${dates.map(fmtDay).join('・')}の` : '';
  if (!total) {
    let why = '条件をゆるめてみてください。';
    if (dates.length) {
      const posted = [...jobs.values()].filter((j) => !j.missingSince && onDates(j.data || j)).length;
      why = !posted ? 'その日の求人は、巡回している3サイトに掲載がありません。'
        : !hits.length ? `その日の求人は${posted}件ありますが、どれもカレンダーの予定（前後60分の余白を含む）と重なります。`
          : `その日に空き時間と合う求人は${hits.length}件ありますが、「${usePrefs.summary}」の条件では外れました。`;
    }
    return reply([line.text(`${when}「${usePrefs.summary}」の求人は見つかりませんでした。\n${why}`, line.quickReplies(['条件を変える', ...START.slice(0, 4)]))]);
  }
  const head = `${when}「${usePrefs.summary}」の求人が${total}件見つかりました。`;
  turn.bot = head;
  turn.prefs = usePrefs;
  // 見せた候補（改善のための点検用）
  turn.shownIds = list.slice(0, PAGE).map((x) => x.id);
  turn.shown = list.slice(0, PAGE).map((x) => { const d = jobs.get(x.id)?.data || {}; return `${d.date} ${d.startTime}-${d.endTime} ${d.city} ${d.hourlyRate || ''}`; });
  return say(await pageMessages(session, jobs, busy, head));
}

/** agent.mjs に渡す道具の中身（カレンダー・求人・並べ替え・カード） */
function agentApi(ctx) {
  const { store, secrets } = ctx;
  const now = ctx.now || Date.now();
  return {
    settings: () => getSettings(store),
    loadJobs: () => loadJobs(store, now),
    currentMatches: () => currentMatches(ctx),
    // 会話の中では待ち時間を短くするため、候補選びは速いモデルで
    order: (prefs, hits, memory) => order(secrets, prefs, hits, memory, process.env.CLAUDE_FAST_MODEL || 'claude-haiku-5-5'),
    async busyOn(date) {
      const token = await google.getAccessToken(secrets);
      const from = Date.parse(`${date}T00:00:00+09:00`);
      return google.busyIntervals(token, { timeMin: new Date(from).toISOString(), timeMax: new Date(from + 864e5).toISOString() });
    },
    /** date から days 日分の予定（「空き」表示も含む・件名・場所・メモつき） */
    async eventsOn(date, days = 1) {
      const token = await google.getAccessToken(secrets);
      const from = Date.parse(`${date}T00:00:00+09:00`);
      return google.listEvents(token, { timeMin: new Date(from).toISOString(), timeMax: new Date(from + days * 864e5).toISOString() });
    },
    /** 言葉で予定を探す（1週間前〜3か月先） */
    async findEvents(query) {
      const token = await google.getAccessToken(secrets);
      return google.listEvents(token, { timeMin: new Date(now - 7 * 864e5).toISOString(), timeMax: new Date(now + 92 * 864e5).toISOString(), q: query });
    },
    async cards(recent, jobs, busy, summary) {
      const items = recent.map((r, i) => ({ job: jobs.get(r.id), reason: r.reason, no: i + 1 })).filter((x) => x.job);
      await Promise.all(items.map(async (x) => { x.rest = restCheck(jobInterval(x.job.data || x.job), busy); try { x.travel = await travelFor(x.job, jobInterval(x.job.data || x.job), busy); } catch { /* 目安なしで出す */ } }));
      return line.jobCarousel(items, `「${summary}」の候補`);
    },
  };
}

async function more(ctx, say) {
  const session = await ctx.store.getState('assistant:session');
  if (!session) return say([line.text(`まず、何を重視するか教えてください。\n${EXAMPLES}`)]);
  const jobs = await loadJobs(ctx.store, ctx.now);
  const { busy } = await currentBusy(ctx.secrets, ctx.now || Date.now());
  await ctx.store.putState('assistant:session', { ...session, offset: session.offset + PAGE });
  return say(await pageMessages(session, jobs, busy));
}

async function handlePostback(ev, ctx, say) {
  const { store, secrets } = ctx;
  const [kind, uid] = String(ev.postback.data || '').split('|');
  if (kind === 'evok' || kind === 'evno') return eventPostback(kind, uid, ctx, say);
  if (kind === 'edok' || kind === 'edno' || kind === 'edundo') return editPostback(kind, uid, ctx, say);
  if (kind === 'eng') return statusPostback(String(ev.postback.data).split('|'), ctx, say);
  if (kind === 'fb') return feedbackPostback(String(ev.postback.data).split('|'), ctx, say);
  if (kind === 'addno') return say([line.text('わかりました。ほかの候補はカードを横にスワイプすると見られます。', line.quickReplies(QUICK))]);
  const jobs = await loadJobs(store, ctx.now);
  const job = jobs.get(uid);
  if (!job || job.missingSince) return say([line.text('この求人は掲載が終わった可能性があります。求人サイトで確かめてください。')]);
  const d = job.data || job;
  if (kind === 'add') return say([line.confirmAdd(job)]);
  if (kind !== 'addok') return;

  const added = (await store.getState('assistant:added')) || [];
  if (added.includes(uid)) return say([line.text('この求人はもうカレンダーに追加してあります。')]);
  const { start, end } = jobInterval(d);
  const token = await google.getAccessToken(secrets);
  // 押すまでの間に予定が入っていないか、書く直前にもう一度確かめる
  const busy = await google.busyIntervals(token, { timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString() });
  if (busy.some((b) => b.start < end && start < b.end)) return say([line.text('その時間には、もう予定が入っています。追加はしませんでした。')]);
  await google.insertEvent(token, {
    summary: `バイト候補：${d.siteLabel} ${d.city || d.pref} ${(d.workOutline || '').slice(0, 30)}`,
    description: [line.safeUrl(d.url), d.payText, '※応募はまだです。求人サイトから本人が応募してください（医師バイトBotは応募しません）。'].filter(Boolean).join('\n'),
    location: d.address, start, end,
  });
  await store.putState('assistant:added', [...added, uid].slice(-500));
  return say([line.text(`カレンダーに「バイト候補」として追加しました。\n応募はまだです。求人サイトから応募してください。\n応募・確定したら下のボタンを押すと、前日と出発前にリマインドと経路を送ります。`, line.statusQuick(uid))]);
}

// 「応募した／確定した」ボタン：勤務を控えて、前日と出発前にリマインドする
async function statusPostback([, uid, status], ctx, say) {
  const { store } = ctx;
  if (!STATUS_LABEL[status]) return;
  const now = ctx.now || Date.now();
  const job = (await loadJobs(store, ctx.now)).get(uid);
  const shifts = (await store.getState('assistant:shifts')) || [];
  const known = shifts.find((x) => x.uid === uid);
  if (!job && !known) return say([line.text('この求人の記録が見つかりませんでした。')]);
  const shift = job ? shiftFrom(job, status, now) : { ...known, status, at: now };
  await store.putState('assistant:shifts', setShift(shifts, shift, now));
  const msgs = [line.text(`${STATUS_LABEL[status]}として控えました。前日の夜と、当日の出発の1時間前ごろにリマインドと経路を送ります。`)];
  // 確定したら、カレンダーの「バイト候補」の件名を「【勤務確定】…」にするか聞く（本人がふだんこう書いているため）
  if (status === 'confirmed') {
    try {
      const token = await google.getAccessToken(ctx.secrets);
      const evs = await google.listEvents(token, { timeMin: new Date(shift.start - 60e3).toISOString(), timeMax: new Date(shift.start + 60e3).toISOString() });
      const cand = candidateEdit(evs, shift.start, status);
      if (cand) msgs.push((await stashEdit(store, now, cand)).message);
    } catch (e) { console.log('バイト候補の予定を探せません', e.message); }
  }
  return say(msgs);
}

// 既存の予定の変更・削除の確認ボタン（変更する／削除する／やめる）と、そのあとの「元に戻す」
async function editPostback(kind, id, ctx, say) {
  const { store, secrets } = ctx;
  const now = ctx.now || Date.now();
  if (kind === 'edno') {
    const pend = (await store.getState('assistant:pendingedits')) || [];
    await store.putState('assistant:pendingedits', pend.filter((p) => p.id !== id));
    return say([line.text('わかりました。予定はそのままです。')]);
  }
  const token = await google.getAccessToken(secrets);
  const r = kind === 'edok' ? await applyEdit({ store, token, id, now, g: ctx._google }) : await undoEdit({ store, token, id, now, g: ctx._google });
  // 続けて「やっぱり15時に」と言われても分かるように、会話の記録に残す
  const log = (await store.getState('assistant:log')) || [];
  await store.putState('assistant:log', [...log, { at: new Date(now).toISOString(), user: kind === 'edok' ? '（確認ボタンを押した）' : '元に戻す', bot: r.text.slice(0, 300), cmd: true }].slice(-30));
  return say([line.text(r.undo ? `${r.text}

間違えたときは「元に戻す」を押してください（1日以内）。` : r.text, r.undo ? line.undoQuick(id) : undefined)]);
}

// 勤務の感想（「お疲れさまでした。どうでしたか？」のボタン）：その勤務の体験として覚える
async function feedbackPostback([, id, code], ctx, say) {
  const { store } = ctx;
  const now = ctx.now || Date.now();
  const a = ((await store.getState('assistant:asks')) || []).find((x) => x.id === id);
  const label = line.FEEDBACK.find(([, c]) => c === code)?.[0];
  if (!a || !label) return say([line.text('この質問はもう使えません。感想があれば、そのまま送ってください。')]);
  const kind = code === 'again' ? 'preference' : code === 'never' ? 'avoid' : 'experience';
  const when = a.date.slice(5).replace('-', '/');
  const { facts } = await getMemory(store);
  const at = new Date(now).toISOString();
  await store.putState('assistant:profile', mergeFacts(facts, [{ kind, subject: a.subject, text: `${label}（${when}の勤務・本人の感想）`, date: a.date }], at, 'line'));
  // 続けて送られる感想の言葉が、どの勤務の話か分かるように会話の記録に残す
  const log = (await store.getState('assistant:log')) || [];
  await store.putState('assistant:log', [...log, { at, user: label, bot: `（勤務の感想を聞いた）${when} ${a.subject}：「${label}」と覚えた`, cmd: true }].slice(-30));
  return say([line.text('ありがとうございます。覚えておきます。ほかに気づいたこと（患者の数・電子カルテ・休憩など）があれば、そのまま送ってください。')]);
}

/** 感想のボタンを押されたときに、どの勤務の話かたどれるよう控える（直近10件） */
async function rememberAsk(store, ask, now) {
  const id = Math.random().toString(36).slice(2, 10);
  const asks = ((await store.getState('assistant:asks')) || []).slice(-9);
  await store.putState('assistant:asks', [...asks, { id, subject: ask.subject, date: ask.date, at: now }]);
  return id;
}

/** 今月の LINE の送信数が上限に近いか（確かめられなければ近くないとみなす） */
async function lowOnPushes(ctx, tok) {
  if (ctx._push) return Boolean(ctx._low);
  try {
    const q = await line.quota(tok);
    return q.limit != null && q.limit - q.used <= PUSH_RESERVE;
  } catch (e) { console.log('LINE の送信数を確かめられません', e.message); return false; }
}

// 本人が「入れといて」と言った予定（バイト以外も）。案は押されるまでだけ置き、書いたら・やめたら消す
async function eventPostback(kind, id, ctx, say) {
  const { store, secrets } = ctx;
  const pend = (await store.getState('assistant:pendingevents')) || [];
  const ev = pend.find((p) => p.id === id);
  await store.putState('assistant:pendingevents', pend.filter((p) => p.id !== id));
  if (kind === 'evno') return say([line.text('わかりました。入れていません。')]);
  if (!ev) return say([line.text('この案はもう使えません（入れ済みか、時間が経ちました）。もう一度「〇日〇時に〇〇を入れて」と送ってください。')]);
  const token = await google.getAccessToken(secrets);
  await google.insertEvent(token, { summary: ev.title, location: ev.location, start: ev.start, end: ev.end, allDay: ev.allDay });
  return say([line.text(`カレンダーに入れました。\n${line.eventWhen(ev)} ${ev.title}`)]);
}

/**
 * 先回りの知らせ（15分おき・EventBridge）。重なり・気にしていた求人の募集終了・増額・新着と、お節介（care.mjs：前夜のひとこと・
 * 件名と時刻の食い違い・移動・応募の確認・勤務の感想）を、変化があるときだけ1通にまとめて送る。
 * 通知を送らない時間帯（本人が決める）は何もしない（知らせは次の回に回る）。条件がまだなければ、ときどき聞く。
 */
export async function notify(ctx) {
  const now = ctx.now || Date.now();
  const { store, secrets } = ctx;
  const settings = await getSettings(store);
  if (isQuiet(now, settings.quiet)) return { skipped: 'quiet' };
  const owner = await store.getState('line:owner');
  if (!owner) return { skipped: 'no-owner' };
  const tok = secrets.LINE_CHANNEL_ACCESS_TOKEN;
  const prefs = await store.getState('assistant:prefs');
  const { hits, jobs, busy, events } = await currentMatches(ctx);
  const [sentKeysArr, sentArr, lastNewAt, added, watch, shiftsState, asked] = await Promise.all(['assistant:sentkeys', 'assistant:sent', 'assistant:lastnew', 'assistant:added', 'assistant:watch', 'assistant:shifts', 'assistant:asked'].map((k) => store.getState(k)));
  const shifts = shiftsState || [];
  const sentKeys = new Set(sentKeysArr || []);
  const pushOut = (m) => (ctx._push ? ctx._push(m) : line.push(tok, owner.userId, m));
  const memory = memoryForPrompt(await getMemory(store));
  const low = await lowOnPushes(ctx, tok);

  // 応募・確定した勤務のリマインド（前日の夜・出発前）。ほかの知らせと同じ1通にまとめる
  const rems = await dueReminders({ now, shifts, busy, sentKeys, origin: settings.home || prefs?.origin });
  const remMsgs = rems.length ? [line.reminderCarousel(rems.map((r) => ({ lines: reminderLines(r), route: reminderRoute(r), shift: r.shift })))] : [];
  const remKeys = rems.map((r) => r.key);

  // お節介：件名と時刻の食い違い・移動・応募の確認・勤務の感想と、20時以降は前夜のひとこと
  const care = await careNotices({ now, events, busy, shifts, added: added || [], jobs, sentKeys });
  let brief = null;
  if (!low) {
    try { brief = await eveningBrief({ now, events, busy, shifts, settings, memory, apiKey: secrets.ANTHROPIC_API_KEY, sentKeys, call: ctx._call }); } catch (e) { console.log('前夜のひとこと 失敗', e.message); }
  }
  const doneKeys = []; // 送らないが「知らせ済み」にするもの
  if (brief) {
    doneKeys.push(brief.key);
    // 明日の食い違い・移動は前夜のひとことの材料にしたので、別の知らせにはしない
    if (brief.text) {
      doneKeys.push(...care.items.filter((x) => x.date === brief.date).map((x) => x.key));
      care.items = care.items.filter((x) => x.date !== brief.date);
    }
  }

  const sentNew = new Set(sentArr || []);
  // 条件で並べた空きに合う求人（新着は AI に上位を選ばせる。増額は条件の順のまま）
  const ranked = prefs ? rankJobs(hits, prefs) : hits;
  const found = collect({ now, busy, hits: ranked, jobs, watched: [...new Set([...(added || []), ...(watch || [])])].filter((u) => !shifts.some((x) => x.uid === u && x.status === 'confirmed')), sentKeys, sentNew, lastNewAt: lastNewAt || 0, hasPrefs: Boolean(prefs) });
  found.items = [...found.items, ...care.items].slice(0, 4);
  if (low) found.jobs = [];
  if (found.fresh && !low) {
    // 新着の枠は AI に選び直させる（理由つき）
    const freshHits = ranked.filter((h) => !sentNew.has((h.job.data || h.job).uid));
    const { list } = await order(secrets, prefs, freshHits, memory, process.env.CLAUDE_FAST_MODEL || 'claude-haiku-5-5');
    const keep = found.jobs.filter((x) => x.kind !== 'new');
    found.jobs = [...keep, ...list.filter((x) => !keep.some((k) => k.uid === x.id)).slice(0, MAX_NEW - keep.length).map((x) => ({ kind: 'new', key: `new#${x.id}`, uid: x.id, reason: x.reason }))];
  }
  // ボタンで聞くのは1通に1つ（クイックリプライは最後のメッセージにしか出ないため）。送信数が残り少ないときは応募の確認だけ
  const ask = care.asks.find((x) => !low || x.kind === 'nudge') || null;
  const askPrefs = !prefs && !low && (!asked || now - asked >= 3 * 864e5);

  const msgs = [];
  if (brief?.text) msgs.push(line.text(`🌙 明日の予定\n${brief.text}`));
  msgs.push(...remMsgs);
  if (found.items.length || found.jobs.length) msgs.push(line.text(headline(found, jobs)));
  if (found.jobs.length) {
    const recent = found.jobs.map((x, i) => ({ ref: `J${i + 1}`, id: x.uid, reason: x.kind === 'pay' ? `増額 ＋${x.pct}%` : x.reason || '' }));
    const items = recent.map((r, i) => ({ job: jobs.get(r.id), reason: r.reason, no: i + 1 })).filter((x) => x.job);
    await Promise.all(items.map(async (x) => { x.rest = restCheck(jobInterval(x.job.data || x.job), busy); try { x.travel = await travelFor(x.job, jobInterval(x.job.data || x.job), busy); } catch { /* 目安なし */ } }));
    msgs.push(line.jobCarousel(items, cardsAlt(found, jobs), line.quickReplies(QUICK)));
    // 「1番まだある？」が通じるように、いま見せた求人を覚える
    await store.putState('assistant:recent', recent);
    await store.putState('assistant:session', { list: recent.map((r) => ({ id: r.id, reason: r.reason })), offset: PAGE, at: now });
  }
  if (!msgs.length && !ask && !askPrefs) {
    if (doneKeys.length) await store.putState('assistant:sentkeys', [...sentKeys, ...doneKeys].slice(-3000));
    return { skipped: 'nothing', low };
  }
  if (ask) msgs.push(line.text(ask.text, ask.kind === 'nudge' ? line.statusQuick(ask.uid) : line.feedbackQuick(await rememberAsk(store, ask, now))));
  else if (askPrefs) msgs.push(askMsg(hits.length));
  else if (!settings.quietAsked) {
    msgs.push(quietAsk(settings.quiet));
    await putSettings(store, { quietAsked: true });
  }
  await pushOut(msgs);
  // 本人がこの通知に返事をしたとき（「11:40が正しい」「直して」）に話が通じるよう、会話の記録に残す
  const pushed = [...new Set(msgs.map((m) => m.text || m.altText || '').filter(Boolean))].join(' / ');
  const log = (await store.getState('assistant:log')) || [];
  await store.putState('assistant:log', [...log, { at: new Date(now).toISOString(), user: '（Botからの通知）', bot: pushed.slice(0, 400), cmd: true, push: true }].slice(-30));
  const keys = [...found.items, ...found.jobs].map((x) => x.key).concat(found.jobs.length ? found.payKeys : [], remKeys, doneKeys, ask ? [ask.key] : []);
  await store.putState('assistant:sentkeys', [...sentKeys, ...keys].slice(-3000));
  if (askPrefs) await store.putState('assistant:asked', now);
  const newIds = found.jobs.filter((x) => x.kind === 'new').map((x) => x.uid);
  if (found.jobs.length) await store.putState('assistant:lastnew', now);
  if (newIds.length) {
    // 新着として見せたもの以外の今の候補も「既に知っている」扱いにして、同じものを次々に送らない
    await store.putState('assistant:sent', [...sentNew, ...ranked.map((h) => (h.job.data || h.job).uid)].slice(-3000));
  }
  return { brief: Boolean(brief?.text), items: found.items.map((x) => x.kind || x.key.split('#')[0]), jobs: found.jobs.map((x) => x.kind), reminders: rems.map((r) => r.kind), ask: ask?.kind, low };
}
