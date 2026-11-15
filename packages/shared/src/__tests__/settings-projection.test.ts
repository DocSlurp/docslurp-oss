import { expect, it } from "vitest";
import { defaultPipelineFeatures, defaultProjectSearchSettings, projectSettingsProjection, getProjectTemplate } from "../index.js";
const base = { pipeline: defaultPipelineFeatures, templateKey: null, allowChinaProviders: true, monthlyBudgetCents: 100 };
it("intersects deployment, privacy and organization ceilings without exposing model bindings", () => {
  const rows = projectSettingsProjection({ project: base, settings: defaultProjectSearchSettings, searchStored: false, capabilities: { webEnabled: false, webChatEnabled: true, organizationAllowsChina: false } });
  expect(rows.find(r => r.field === 'pipeline.webTools')).toMatchObject({ requested: true, effective: false, status: 'unavailable' });
  expect(rows.find(r => r.field === 'allowChinaProviders')).toMatchObject({ effective: false, status: 'locked' });
  expect(rows.find(r => r.field === 'search.chat.answerStyle')).toMatchObject({ origin: 'search-default' });
  expect(rows.some(r => /modelUri|baseUrl|decisionModel/.test(r.field))).toBe(false);
});
it("shows template locks and inactive chat preferences without treating future builds as corpus coverage", () => {
  const rows = projectSettingsProjection({ project: { ...base, templateKey: 'legal-contracts', pipeline: getProjectTemplate('legal-contracts')!.pipeline }, settings: { ...defaultProjectSearchSettings, chat: { ...defaultProjectSearchSettings.chat, enabled: false } }, searchStored: true, capabilities: { webEnabled: true, webChatEnabled: true, organizationAllowsChina: true } });
  expect(rows.find(r => r.field === 'pipeline.quality')).toMatchObject({ status: 'locked', origin: 'template' });
  expect(rows.find(r => r.field === 'search.chat.answerStyle')).toMatchObject({ status: 'inactive' });
});
it("reports key and monthly organization ceilings as independent locked authority, never a preset override", () => {
  const rows = projectSettingsProjection({ project: base, settings: defaultProjectSearchSettings, searchStored: true, organizationMonthlyBudgetCents: 50, keyCeiling: { searchMode: 'keyword', maxOutputTokens: 500 }, capabilities: { webEnabled: true, webChatEnabled: true, organizationAllowsChina: true } });
  expect(rows.find(r => r.field === 'request.searchModeCeiling')).toMatchObject({ effective: 'keyword', origin: 'request-key', status: 'locked' });
  expect(rows.find(r => r.field === 'organization.monthlyBudgetCents')).toMatchObject({ effective: 50, status: 'locked' });
  expect(rows.some(r => /rerankProvider|rerankModel/.test(r.field))).toBe(false);
});
