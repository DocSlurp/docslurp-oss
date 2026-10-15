import { expect, it } from 'vitest';
import { DEFAULT_WORKSPACE_CHAT_MODEL, resolveWorkspaceChatModel, WORKSPACE_CHAT_MODELS } from './workspace-chat-models.js';
it('defaults new and invalid model selections to GLM 5.3 Flash while preserving explicit supported choices', () => {
  expect(DEFAULT_WORKSPACE_CHAT_MODEL).toBe('z-ai/glm-5.3-flash');
  expect(resolveWorkspaceChatModel(null)).toBe(DEFAULT_WORKSPACE_CHAT_MODEL);
  expect(resolveWorkspaceChatModel('missing')).toBe(DEFAULT_WORKSPACE_CHAT_MODEL);
  expect(resolveWorkspaceChatModel('deepseek/deepseek-v4.1-flash')).toBe('deepseek/deepseek-v4.1-flash');
  expect(WORKSPACE_CHAT_MODELS[0].id).toBe(DEFAULT_WORKSPACE_CHAT_MODEL);
});

it('offers supported model choices and resolves retired choices to the default', () => {
  for (const { id } of WORKSPACE_CHAT_MODELS) expect(resolveWorkspaceChatModel(id)).toBe(id);
  expect(resolveWorkspaceChatModel('deepseek/deepseek-v4-flash')).toBe(DEFAULT_WORKSPACE_CHAT_MODEL);
});
