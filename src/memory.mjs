// 覚えておくこと：報酬の観測（前回比）・通知を止める時間帯・会話から学んだ本人のこと。
// 観測と推測を分ける：報酬は「いつ見た額か」を必ず持ち、本人の体験は本人の言葉として持つ（一般化しない）。

// ---- 報酬の観測 ----

/** 求人1件の報酬のうち、比べる値。基本額（payAmount）とインセンティブ・交通費の表記は混ぜない */
export function payOf(d = {}) {
  return { amount: d.payAmount ?? null, total: d.totalPay ?? null, hourly: d.hourlyRate ?? null, note: String(d.note || '').slice(0, 80) };
}
const samePay = (a, b) => a && b && a.amount === b.amount && a.total === b.total && a.note === b.note;

/** 巡回で求人を書くときに報酬の観測を足す（変わったときだけ・最大20件） */
export function appendPay(prev, data, now) {
  const log = prev?.payLog ? [...prev.payLog] : prev?.data ? [{ at: prev.firstSeenAt || prev.changedAt || now, ...payOf(prev.data) }] : [];
  const cur = { at: now, ...payOf(data) };
  if (!samePay(log[log.length - 1], cur)) log.push(cur);
  return log.slice(-20);
}

/** 前回の観測からの基本額の変化。{ from, to, diff, pct, fromAt, toAt } か null */
export function payChange(job) {
  const log = (job?.payLog || []).filter((x) => x.amount);
  if (log.length < 2) return null;
  const a = log[log.length - 2], b = log[log.length - 1];
  if (a.amount === b.amount) return null;
  return { from: a.amount, to: b.amount, diff: b.amount - a.amount, pct: Math.round(((b.amount - a.amount) / a.amount) * 100), fromAt: a.at, toAt: b.at };
}

const jst = (iso) => { const d = new Date(Date.parse(iso) + 9 * 3600e3); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const yen = (n) => `${n.toLocaleString('ja-JP')}円`;

/** 「前回比 ＋8,000円／＋25%（10/19 07:10 32,000円 → 10/19 18:40 40,000円）」。通常額との比較はしない（根拠が足りないため） */
export function payChangeText(job) {
  const c = payChange(job);
  if (!c) return '';
  const sign = c.diff > 0 ? '＋' : '−';
  return `前回比 ${sign}${yen(Math.abs(c.diff))}／${sign}${Math.abs(c.pct)}%（${jst(c.fromAt)} ${yen(c.from)} → ${jst(c.toAt)} ${yen(c.to)}）`;
}

// ---- 通知を止める時間帯（本人が決める） ----

export const DEFAULT_QUIET = { from: 1, to: 7 };

/** quiet = { from, to }（時、日本時間。from>to なら日をまたぐ）。null は「いつでも送ってよい」 */
export function inQuiet(now, quiet = DEFAULT_QUIET) {
  if (!quiet) return false;
  const h = new Date(now + 9 * 3600e3).getUTCHours();
  return quiet.from <= quiet.to ? h >= quiet.from && h < quiet.to : h >= quiet.from || h < quiet.to;
}

export const quietText = (q) => (q ? `${q.from}時〜${q.to}時` : 'なし（いつでも送る）');

/** 「23時〜6時」「22-7」「0時から8時は送らないで」「いつでも」「標準」→ { quiet } か null（読めない） */
export function parseQuiet(t) {
  const s = String(t).normalize('NFKC');
  if (/いつでも|止めない|制限なし|なし$/.test(s)) return { quiet: null };
  if (/標準|元に戻/.test(s)) return { quiet: DEFAULT_QUIET };
  const m = s.match(/(\d{1,2})\s*時?\s*(?:[〜~\-ー－]|から)\s*(?:翌朝?)?\s*(\d{1,2})\s*時?/);
  if (!m) return null;
  const from = +m[1] % 24, to = +m[2] % 24;
  if (from === to) return null;
  return { quiet: { from, to } };
}

export async function getSettings(store) {
  const s = (await store.getState('assistant:settings')) || {};
  return { quiet: 'quiet' in s ? s.quiet : DEFAULT_QUIET, ...s };
}
export async function putSettings(store, patch) {
  const cur = (await store.getState('assistant:settings')) || {};
  await store.putState('assistant:settings', { ...cur, ...patch });
}

// ---- 会話から学んだこと ----

/**
 * 本人について覚えたこと（facts）と、返し方の反省（lessons）。
 * fact = { kind, subject, text, date?, at, src }。同じ kind+subject は新しいほうで置き換える（本人の訂正を優先）。
 */
export async function getMemory(store) {
  return {
    facts: (await store.getState('assistant:profile')) || [],
    lessons: (await store.getState('assistant:lessons')) || [],
  };
}

export function mergeFacts(facts, add, now, src = 'line') {
  const out = [...facts];
  for (const f of add) {
    if (!f?.text) continue;
    const item = { kind: f.kind, subject: String(f.subject || '').slice(0, 40), text: String(f.text).slice(0, 160), date: f.date || null, at: now, src };
    const i = out.findIndex((x) => x.kind === item.kind && item.subject && x.subject === item.subject);
    if (i >= 0) out.splice(i, 1);
    out.push(item);
  }
  return out.slice(-80);
}

export function mergeLessons(lessons, add, now, src = 'line') {
  const out = [...lessons];
  for (const l of add) {
    const text = String(l || '').trim().slice(0, 160);
    if (!text || out.some((x) => x.text === text)) continue;
    out.push({ text, at: now, src });
  }
  return out.slice(-30);
}

/** AI に渡す形（短く）。予定の中身は含まない（本人の言葉から覚えたことだけ） */
export function memoryForPrompt({ facts = [], lessons = [] } = {}) {
  const f = facts.slice(-40).map((x) => `- [${x.kind}] ${x.subject ? `${x.subject}：` : ''}${x.text}${x.date ? `（${x.date}）` : ''}`);
  const l = lessons.slice(-15).map((x) => `- ${x.text}`);
  return [f.length ? `本人について覚えていること（本人の発言から。観測であり一般化しない）:\n${f.join('\n')}` : '', l.length ? `これまでの反省（返し方）:\n${l.join('\n')}` : ''].filter(Boolean).join('\n\n');
}
