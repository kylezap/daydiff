#!/usr/bin/env node
/**
 * Quick test of OpenAI API key. Run: node scripts/test-openai.mjs
 */
import 'dotenv/config';
import OpenAI from 'openai';

const key = process.env.OPENAI_API_KEY;
if (!key) {
  console.error('OPENAI_API_KEY not set in .env');
  process.exit(1);
}

console.log('Testing OpenAI API...');
console.log('Key prefix:', key.slice(0, 12) + '...');

const openai = new OpenAI({ apiKey: key });
try {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Reply with just: OK' }],
    max_tokens: 10,
  });
  const content = res.choices?.[0]?.message?.content?.trim();
  console.log('Response:', content || '(empty)');
  console.log('Usage:', JSON.stringify(res.usage ?? {}));
  console.log('\n✓ API key works');
} catch (err) {
  console.error('\n✗ API error:', err.message);
  if (err.status) console.error('  Status:', err.status);
  if (err.code) console.error('  Code:', err.code);
  process.exit(1);
}
