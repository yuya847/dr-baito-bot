// 先回りの知らせの試し：本物の求人・カレンダーで「今送るなら何を送るか」を画面に出す。LINE には送らず、DynamoDB にも書かない。
//   使い方: node scripts/try-scout.mjs [時刻]（例 2026-10-30T20:15 。省略すると今。前夜のひとことは20時以降に出る）
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { createDynamoStore } from '../src/lib/store.mjs';
import { notify } from '../src/assistant.mjs';

process.env.AWS_REGION ||= 'ap-northeast-1';
const outs = (await new CloudFormationClient({}).send(new DescribeStacksCommand({ StackName: 'dr-baito-bot' }))).Stacks[0].Outputs;
const get = (k) => outs.find((o) => o.OutputKey === k).OutputValue;
const secrets = JSON.parse((await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: get('SecretArn') }))).SecretString);
const cloud = await createDynamoStore(get('TableName'));
const local = new Map();
const store = { getJobs: (s) => cloud.getJobs(s), putJobs: async () => {}, getState: async (k) => (local.has(k) ? local.get(k) : cloud.getState(k)), putState: async (k, v) => { local.set(k, v); } };
const quick = (m) => (m.quickReply ? `\n   ［ボタン: ${m.quickReply.items.map((i) => i.action.label).join(' / ')}］` : '');
const show = (m) => (m.type === 'text' ? m.text + quick(m) : m.type === 'flex' ? `［カード ${m.contents.contents.length}枚：${m.contents.contents.map((b) => b.body.contents.slice(0, 3).map((c) => c.text).join(' ')).join(' / ')}］` : `［${m.type}］`);
const at = process.argv[2] ? Date.parse(`${process.argv[2]}+09:00`) : Date.now();
for (const label of ['1回目', '15分後（同じ知らせは出ないはず）']) {
  const sent = [];
  const r = await notify({ store, secrets, now: at + (label === '1回目' ? 0 : 15 * 60e3), _push: (m) => sent.push(...m) });
  console.log(`\n== ${label}: ${JSON.stringify(r)}`);
  for (const m of sent) console.log(`🤖 ${show(m)}`);
}
