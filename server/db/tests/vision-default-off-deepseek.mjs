// Migration 0141 moves projects stored with the old default vision model (DeepSeek V4.1 Flash 1017) to the new
// default, and leaves every other choice alone. Rollback-only, in an isolated schema.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
if (!process.env.DATABASE_URL || !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname)) {
  throw new Error('Run this rollback-only integration check against a local database.');
}
const DEEPSEEK = 'llm://openrouter/deepseek/deepseek-v4.1-flash-1017';
const LUNA = 'llm://openrouter/openai/gpt-6-luna';
const GLM = 'llm://openrouter/z-ai/glm-5.3-flash';
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const rollback = new Error('expected rollback');
try {
  await sql.begin(async tx => {
    const schema = `vision_default_${randomUUID().replaceAll('-', '')}`;
    await tx.unsafe(`create schema ${schema}; set local search_path to ${schema}`);
    await tx.unsafe('create table projects (id text primary key, pipeline jsonb not null default \'{}\')');
    const rows = {
      defaultProfile: { vision: { profile: 'good-fast-hosted', target: 'hosted', modelUri: DEEPSEEK, prompt: '<OCR>' }, chunking: { size: 800 } },
      noProfile: { vision: { modelUri: DEEPSEEK } },
      openWeights: { vision: { profile: 'open-weights-hosted', target: 'hosted', modelUri: DEEPSEEK } },
      otherModel: { vision: { profile: 'good-fast-hosted', target: 'hosted', modelUri: GLM } },
      local: { vision: { profile: 'good-fast-local', target: 'local', modelUri: 'llm://vllm/Qwen/Qwen2.5-VL-3B-Instruct' } },
      fallbackOnly: { vision: { profile: 'good-fast-hosted', modelUri: GLM, remoteFallbackModelUri: DEEPSEEK } },
      noVision: { chunking: { size: 400 } },
    };
    for (const [id, pipeline] of Object.entries(rows)) await tx`insert into projects ${tx({ id, pipeline: tx.json(pipeline) })}`;
    const migration = await readFile(new URL('../migrations/0141_vision_default_off_deepseek.sql', import.meta.url), 'utf8');
    for (const statement of migration.split('--> statement-breakpoint')) await tx.unsafe(statement);
    const byId = Object.fromEntries((await tx`select id, pipeline from projects`).map(row => [row.id, row.pipeline]));
    assert.equal(byId.defaultProfile.vision.modelUri, LUNA);
    assert.deepEqual(byId.defaultProfile.chunking, { size: 800 }, 'the rest of the pipeline is untouched');
    assert.equal(byId.defaultProfile.vision.prompt, '<OCR>');
    assert.equal(byId.noProfile.vision.modelUri, LUNA);
    assert.equal(byId.openWeights.vision.modelUri, GLM);
    assert.equal(byId.otherModel.vision.modelUri, GLM);
    assert.equal(byId.local.vision.modelUri, 'llm://vllm/Qwen/Qwen2.5-VL-3B-Instruct');
    assert.equal(byId.fallbackOnly.vision.remoteFallbackModelUri, DEEPSEEK, 'an explicit fallback model is not the default');
    assert.deepEqual(byId.noVision, { chunking: { size: 400 } });
    // A project that chooses DeepSeek after the migration keeps it: the migration runs once and nothing remaps at read.
    await tx`update projects set pipeline = ${tx.json({ vision: { profile: 'good-fast-hosted', target: 'hosted', modelUri: DEEPSEEK } })} where id = 'defaultProfile'`;
    const [kept] = await tx`select pipeline->'vision'->>'modelUri' as uri from projects where id = 'defaultProfile'`;
    assert.equal(kept.uri, DEEPSEEK);
    throw rollback;
  });
} catch (error) { if (error !== rollback) throw error; }
finally { await sql.end(); }
console.log('Vision default migration moved the old default, kept explicit choices (rolled back).');
