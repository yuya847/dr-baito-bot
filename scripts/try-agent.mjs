// 手元での会話の試し：本物の求人・カレンダーを読むが、書き込みは手元のメモリだけ（DynamoDB には書かない）。LINE にも送らない。
//   使い方: node scripts/try-agent.mjs "明後日の17時以降は？" "J1まだある？" …（順に送る）
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { createDynamoStore } from '../src/lib/store.mjs';
import { handleEvent } from '../src/assistant.mjs';

process.env.AWS_REGION ||= 'ap-northeast-1';
const outs = (await new CloudFormationClient({}).send(new DescribeStacksCommand({ StackName: 'dr-baito-bot' }))).Stacks[0].Outputs;
const get = (k) => outs.find((o) => o.OutputKey === k).OutputValue;
const secrets = JSON.parse((await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: get('SecretArn') }))).SecretString);
const cloud = await createDynamoStore(get('TableName'));
const local = new Map();
const store = {
  getJobs: (site) => cloud.getJobs(site),
  putJobs: async () => {},
  getState: async (k) => (local.has(k) ? local.get(k) : cloud.getState(k)),
  putState: async (k, v) => { local.set(k, v); },
};
const owner = await cloud.getState('line:owner');
const show = (m) => (m.type === 'text' ? m.text : m.type === 'flex' ? `［カード ${m.contents.contents.length}枚：${m.contents.contents.map((b) => b.body.contents[0].text).slice(0, 3).join(' / ')}…］` : m.type === 'template' ? `［確認：${m.template.text.split('\n')[0]}］` : `［${m.type}］`);
let n = 0;
for (const text of process.argv.slice(2)) {
  const t0 = Date.now();
  const ev = { type: 'message', replyToken: 'x', source: { type: 'user', userId: owner.userId }, message: { type: 'text', id: `m${n}`, text } };
  const ctx = { store, secrets: { ...secrets, LINE_CHANNEL_ACCESS_TOKEN: 'dummy' } };
  // LINE へは送らず画面に出す
  const line = await import('../src/lib/line.mjs');
  const sayed = [];
  await handleEvent(ev, { ...ctx, _say: (msgs) => sayed.push(...msgs) });
  console.log(`\n👤 ${text}`);
  for (const m of sayed) console.log(`🤖 ${show(m)}`);
  const log = local.get('assistant:log') || [];
  console.log(`   （${Date.now() - t0}ms・道具: ${(log[log.length - 1]?.tools || []).join(',') || 'なし'}）`);
  n += 1;
}
console.log('\n覚えたこと（手元だけ）:', JSON.stringify((local.get('assistant:profile') || []).filter((f) => f.src !== 'dot').slice(-5)));
