// 手元での試し：LINE に送る代わりに画面に出す。AI の読み取り（条件）と選んだ上位を確かめる。
//   使い方: ANTHROPIC_API_KEY=… node scripts/try-assistant.mjs "時給重視で、船橋から1時間以内"
import { weekdayOf } from '../src/lib/normalize.mjs';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { createDynamoStore } from '../src/lib/store.mjs';
import { currentMatches } from '../src/assistant.mjs';
import { parsePrefs, pickJobs } from '../src/lib/claude.mjs';
import { rankJobs } from '../src/rank.mjs';

const REGION = 'ap-northeast-1';
process.env.AWS_REGION ||= REGION;
const outs = (await new CloudFormationClient({ region: REGION }).send(new DescribeStacksCommand({ StackName: 'dr-baito-bot' }))).Stacks[0].Outputs;
const get = (k) => outs.find((o) => o.OutputKey === k).OutputValue;
const secrets = JSON.parse((await new SecretsManagerClient({ region: REGION }).send(new GetSecretValueCommand({ SecretId: get('SecretArn') }))).SecretString);
const key = process.env.ANTHROPIC_API_KEY || secrets.ANTHROPIC_API_KEY;
const store = await createDynamoStore(get('TableName'));

const t0 = Date.now();
const { hits, jobs } = await currentMatches({ store, secrets });
console.log(`空きに合う求人 ${hits.length}件（${Date.now() - t0}ms）`);
const { intent, prefs } = await parsePrefs(key, process.argv[2] || 'ゆとりのある勤務がいい');
console.log('読み取った条件', intent, JSON.stringify(prefs));
const ranked = rankJobs(hits, prefs);
const picks = await pickJobs(key, prefs, ranked);
console.log(`条件に合う ${ranked.length}件 → AI が選んだ上位（${Date.now() - t0}ms）`);
for (const p of picks.slice(0, 6)) {
  const d = jobs.get(p.id).data;
  console.log(`- ${d.date}(${weekdayOf(d.date)}) ${d.startTime}〜${d.endTime} ${d.siteLabel} ${d.pref}${d.city} ${d.payText}（時給${d.hourlyRate}） ${(d.workOutline || '').slice(0, 30)} 💡${p.reason}`);
}
