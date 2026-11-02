// LINE のやり取りの記録（直近30件）を見て、条件と結果が食い違っていないかを点検する。改善の手がかりにする。
//   使い方: node scripts/review-log.mjs
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { createDynamoStore } from '../src/lib/store.mjs';

process.env.AWS_REGION ||= 'ap-northeast-1';
const outs = (await new CloudFormationClient({ region: 'ap-northeast-1' }).send(new DescribeStacksCommand({ StackName: 'dr-baito-bot' }))).Stacks[0].Outputs;
const store = await createDynamoStore(outs.find((o) => o.OutputKey === 'TableName').OutputValue);
const log = (await store.getState('assistant:log')) || [];

// 見せた候補が、読み取った条件（日付・時刻）を守っているか
function check(t) {
  const bad = [];
  for (const s of t.shown || []) {
    const [date, time] = s.split(' ');
    const [st, en] = (time || '').split('-');
    if (t.dates?.length && !t.dates.includes(date)) bad.push(`日付外 ${s}`);
    if (t.prefs?.earliestStart && st < t.prefs.earliestStart) bad.push(`開始が早い ${s}`);
    if (t.prefs?.latestEnd && (en <= st || en > t.prefs.latestEnd)) bad.push(`終了が遅い ${s}`);
  }
  return bad;
}

for (const t of log) {
  const at = new Date(t.at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const bad = check(t);
  console.log(`${t.feedback === 'bad' ? '👎' : bad.length ? '⚠' : '・'} ${at}  「${t.user}」`);
  console.log(`    → ${t.bot}${t.dates?.length ? `  [日付 ${t.dates.join(',')}]` : ''}${t.prefs ? `  [条件 ${t.prefs.summary}${t.prefs.earliestStart ? ` ${t.prefs.earliestStart}〜` : ''}${t.prefs.latestEnd ? ` 〜${t.prefs.latestEnd}` : ''}]` : ''}`);
  for (const b of bad) console.log(`    ⚠ ${b}`);
}
console.log(`\n${log.length}件　👎=本人が「結果が違う」　⚠=条件と結果の食い違い`);
