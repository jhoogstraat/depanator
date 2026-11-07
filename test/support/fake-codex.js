#!/usr/bin/env bun
// Stands in for the Codex CLI and so for ChatGPT, through the same arguments, stdin and output file. It logs every
// call to $CODEX_HOME/calls.jsonl. Its "judgement": a requirement "No <words>" rejects listings that mention <words>.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('login')) process.exit(0); // Logged in.
if (args.includes('debug')) {
  console.log(JSON.stringify({ models: [{ slug: 'gpt-e2e', display_name: 'GPT E2E', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], default_reasoning_level: 'low' },
    { slug: 'gpt-e1e', display_name: 'GPT E1E', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }], default_reasoning_level: 'low' }] })); // Older: not offered.
  process.exit(0);
}
const input = JSON.parse(readFileSync(0, 'utf8'));
appendFileSync(join(process.env.CODEX_HOME, 'calls.jsonl'), `${JSON.stringify({ args, input })}\n`);
const description = input.listing.description.toLowerCase();
const rejected = input.preferences.split('\n').some(line => /^no /i.test(line) && description.includes(line.slice(3).toLowerCase()));
const result = input.task === 'write'
  ? { decision: 'message', reasons: [], draft: `Guten Tag, ich bin ${input.verifiedPersona.vorname}.${input.userInstructions ? ` ${input.userInstructions}` : ''}`, confident: false }
  : { decision: rejected ? 'dismiss' : 'message', reasons: [rejected ? 'Breaks a requirement' : 'Fits'], draft: '', confident: !rejected && !description.includes('unclear') };
writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(result));
