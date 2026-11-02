// 手元での照合テスト：自分の Secrets Manager の Google 鍵でカレンダーを読み、DynamoDB の求人と照合して件数と候補を表示する。
// 予定の件名・場所も読むが、ここでは表示しない（件数だけ）。使い方: node scripts/match-local.mjs [日数]
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { getAccessToken, busyIntervals } from '../src/lib/google.mjs';
import { ANYTIME, expandWindows, freeSlots, matchJobs } from '../src/match.mjs';
import { createDynamoStore } from '../src/lib/store.mjs';
import { SITES } from '../src/sites/index.mjs';

const REGION = 'ap-northeast-1';
process.env.AWS_REGION ||= REGION;
const days = Number(process.argv[2] || 14);
// 勤務できる枠：時間帯は絞らず、既存の予定（前後60分の余白込み）と重ならなければ提案する
const RULES = ANYTIME;

const outs = (await new CloudFormationClient({ region: REGION }).send(new DescribeStacksCommand({ StackName: 'dr-baito-bot' }))).Stacks[0].Outputs;
const get = (k) => outs.find((o) => o.OutputKey === k).OutputValue;
const secrets = JSON.parse((await new SecretsManagerClient({ region: REGION }).send(new GetSecretValueCommand({ SecretId: get('SecretArn') }))).SecretString);

const now = Date.now();
const token = await getAccessToken(secrets);
const busy = await busyIntervals(token, { timeMin: new Date(now).toISOString(), timeMax: new Date(now + days * 864e5).toISOString() });
const slots = freeSlots(expandWindows(RULES, { from: now, days }), busy);

const store = await createDynamoStore(get('TableName'));
const jobs = [];
for (const site of Object.keys(SITES)) jobs.push(...(await store.getJobs(site)).values());
const hits = matchJobs(jobs, slots, { now });

const fmt = (ms) => new Date(ms).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
console.log(`予定あり ${busy.length}件 / 空き ${slots.length}枠（${slots.reduce((a, s) => a + (s.end - s.start), 0) / 36e5}時間） / 求人 ${jobs.length}件 → 合う求人 ${hits.length}件`);
const perDay = {};
for (const h of hits) { const k = fmt(h.interval.start).split(' ')[0]; perDay[k] = (perDay[k] || 0) + 1; }
console.log('日ごと: ' + Object.entries(perDay).map(([k, n]) => `${k} ${n}`).join(' / '));
for (const h of hits.slice(0, 15)) {
  const d = h.job.data;
  console.log(`- ${fmt(h.interval.start)}〜${d.endTime} ${d.siteLabel} ${d.pref}${d.city} ${d.payText || ''} ${d.title.slice(0, 30)}`);
}
