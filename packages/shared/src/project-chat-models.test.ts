import { expect, it } from 'vitest';
import { DEFAULT_PROJECT_CHAT_MODEL, resolveProjectChatModel, PROJECT_CHAT_MODELS } from './project-chat-models.js';
it('defaults new and invalid model selections to GLM 5.3 Flash while preserving explicit supported choices', () => {
  expect(DEFAULT_PROJECT_CHAT_MODEL).toBe('z-ai/glm-5.3-flash');
  expect(resolveProjectChatModel(null)).toBe(DEFAULT_PROJECT_CHAT_MODEL);
  expect(resolveProjectChatModel('missing')).toBe(DEFAULT_PROJECT_CHAT_MODEL);
  expect(resolveProjectChatModel('deepseek/deepseek-v4.1-flash')).toBe('deepseek/deepseek-v4.1-flash');
  expect(PROJECT_CHAT_MODELS[0].id).toBe(DEFAULT_PROJECT_CHAT_MODEL);
});

it('offers supported model choices and resolves retired choices to the default', () => {
  for (const { id } of PROJECT_CHAT_MODELS) expect(resolveProjectChatModel(id)).toBe(id);
  expect(resolveProjectChatModel('deepseek/deepseek-v4-flash')).toBe(DEFAULT_PROJECT_CHAT_MODEL);
});
