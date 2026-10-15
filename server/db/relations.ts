import { relations } from "drizzle-orm/relations";
import { user, creditLedger, organizations, documents, vectorIndexes, workspaceRuns, usageEvents, workspaces, performanceLog, workspaceRunEvents, workspaceSecrets, session, account, workspaceInvites, documentCorrections, pageStageStates, workspaceConnectors, webhooks, documentChunks, documentPages, webhookDeliveries, notificationPrefs, notificationDeliveries, apiKeys, documentSummaries, searchSessions, searchSessionResults, auditLog, searchEvalFixtures, searchIndexStaleness, documentPropositions, idempotencyCache, searchExperiments, chatSessions, chatTurns, aiOperations, aiOperationEvents, groundedSummaries, piiDetections, chatAnswerEvidenceSpans, parserEvalFixtures, parserEvalResults, uploadSessions, uploadSessionFiles, searchZeroResults, workspaceSearchSettings, querySuggestions, privacyAuditLog, connectorSyncLog, oauthAccounts, ssoAuthRequests, kgNodes, kgEdges, kgCommunities, orgMemberships, documentTags, apiKeyUsage, kgCommunityMembers, workspaceMembers, workspaceRunStageStates, documentRunStageStates, chunkEntities, creditGrants, storageMeterDays } from "./schema";

export const creditLedgerRelations = relations(creditLedger, ({one}) => ({
	user: one(user, {
		fields: [creditLedger.userId],
		references: [user.id]
	}),
}));

export const userRelations = relations(user, ({many}) => ({
	creditLedgers: many(creditLedger),
	organizations_createdByUserId: many(organizations, {
		relationName: "organizations_createdByUserId_user_id"
	}),
	organizations_personalOwnerUserId: many(organizations, {
		relationName: "organizations_personalOwnerUserId_user_id"
	}),
	usageEvents: many(usageEvents),
	documents: many(documents),
	performanceLogs: many(performanceLog),
	workspaceRunEvents: many(workspaceRunEvents),
	sessions: many(session),
	accounts: many(account),
	workspaceInvites_acceptedByUserId: many(workspaceInvites, {
		relationName: "workspaceInvites_acceptedByUserId_user_id"
	}),
	workspaceInvites_invitedByUserId: many(workspaceInvites, {
		relationName: "workspaceInvites_invitedByUserId_user_id"
	}),
	documentCorrections: many(documentCorrections),
	webhooks: many(webhooks),
	documentChunks: many(documentChunks),
	webhookDeliveries: many(webhookDeliveries),
	notificationPrefs: many(notificationPrefs),
	documentPages: many(documentPages),
	notificationDeliveries: many(notificationDeliveries),
	apiKeys: many(apiKeys),
	documentSummaries: many(documentSummaries),
	searchSessions: many(searchSessions),
	auditLogs: many(auditLog),
	searchEvalFixtures: many(searchEvalFixtures),
	searchIndexStalenesses: many(searchIndexStaleness),
	documentPropositions: many(documentPropositions),
	idempotencyCaches: many(idempotencyCache),
	searchExperiments: many(searchExperiments),
	chatSessions: many(chatSessions),
	aiOperations: many(aiOperations),
	workspaces: many(workspaces),
	groundedSummaries: many(groundedSummaries),
	chatAnswerEvidenceSpans: many(chatAnswerEvidenceSpans),
	parserEvalFixtures: many(parserEvalFixtures),
	parserEvalResults: many(parserEvalResults),
	uploadSessions: many(uploadSessions),
	workspaceRuns: many(workspaceRuns),
	searchZeroResults: many(searchZeroResults),
	workspaceSearchSettings: many(workspaceSearchSettings),
	querySuggestions: many(querySuggestions),
	oauthAccounts: many(oauthAccounts),
	kgNodes: many(kgNodes),
	kgEdges: many(kgEdges),
	kgCommunities: many(kgCommunities),
	orgMemberships: many(orgMemberships),
	documentTags: many(documentTags),
	workspaceMembers_invitedByUserId: many(workspaceMembers, {
		relationName: "workspaceMembers_invitedByUserId_user_id"
	}),
	workspaceMembers_userId: many(workspaceMembers, {
		relationName: "workspaceMembers_userId_user_id"
	}),
	chunkEntities: many(chunkEntities),
}));

export const organizationsRelations = relations(organizations, ({one, many}) => ({
	user_createdByUserId: one(user, {
		fields: [organizations.createdByUserId],
		references: [user.id],
		relationName: "organizations_createdByUserId_user_id"
	}),
	user_personalOwnerUserId: one(user, {
		fields: [organizations.personalOwnerUserId],
		references: [user.id],
		relationName: "organizations_personalOwnerUserId_user_id"
	}),
	workspaceInvites: many(workspaceInvites),
	notificationPrefs: many(notificationPrefs),
	notificationDeliveries: many(notificationDeliveries),
	apiKeys: many(apiKeys),
	auditLogs: many(auditLog),
	aiOperations: many(aiOperations),
	uploadSessions: many(uploadSessions),
	ssoAuthRequests: many(ssoAuthRequests),
	creditGrants: many(creditGrants),
	storageMeterDays: many(storageMeterDays),
	orgMemberships: many(orgMemberships),
}));

export const vectorIndexesRelations = relations(vectorIndexes, ({one}) => ({
	document: one(documents, {
		fields: [vectorIndexes.documentId],
		references: [documents.id]
	}),
}));

export const documentsRelations = relations(documents, ({one, many}) => ({
	vectorIndexes: many(vectorIndexes),
	usageEvents: many(usageEvents),
	workspace: one(workspaces, {
		fields: [documents.workspaceId],
		references: [workspaces.id]
	}),
	workspaceRun: one(workspaceRuns, {
		fields: [documents.runId],
		references: [workspaceRuns.id]
	}),
	user: one(user, {
		fields: [documents.userId],
		references: [user.id]
	}),
	document: one(documents, {
		fields: [documents.dedupedFromDocumentId],
		references: [documents.id],
		relationName: "documents_dedupedFromDocumentId_documents_id"
	}),
	documents: many(documents, {
		relationName: "documents_dedupedFromDocumentId_documents_id"
	}),
	performanceLogs: many(performanceLog),
	workspaceRunEvents: many(workspaceRunEvents),
	documentCorrections: many(documentCorrections),
	pageStageStates: many(pageStageStates),
	documentChunks: many(documentChunks),
	documentPages: many(documentPages),
	documentSummaries: many(documentSummaries),
	auditLogs: many(auditLog),
	searchIndexStalenesses: many(searchIndexStaleness),
	documentPropositions: many(documentPropositions),
	groundedSummaries: many(groundedSummaries),
	piiDetections: many(piiDetections),
	parserEvalFixtures: many(parserEvalFixtures),
	parserEvalResults: many(parserEvalResults),
	privacyAuditLogs: many(privacyAuditLog),
	documentTags: many(documentTags),
	documentRunStageStates: many(documentRunStageStates),
}));

export const usageEventsRelations = relations(usageEvents, ({one}) => ({
	workspaceRun: one(workspaceRuns, {
		fields: [usageEvents.runId],
		references: [workspaceRuns.id]
	}),
	document: one(documents, {
		fields: [usageEvents.documentId],
		references: [documents.id]
	}),
	user: one(user, {
		fields: [usageEvents.userId],
		references: [user.id]
	}),
}));

export const workspaceRunsRelations = relations(workspaceRuns, ({one, many}) => ({
	usageEvents: many(usageEvents),
	documents: many(documents),
	performanceLogs: many(performanceLog),
	workspaceRunEvents: many(workspaceRunEvents),
	documentCorrections: many(documentCorrections),
	pageStageStates: many(pageStageStates),
	documentChunks: many(documentChunks),
	documentPages: many(documentPages),
	documentSummaries: many(documentSummaries),
	auditLogs: many(auditLog),
	searchEvalFixtures: many(searchEvalFixtures),
	searchIndexStalenesses: many(searchIndexStaleness),
	documentPropositions: many(documentPropositions),
	groundedSummaries: many(groundedSummaries),
	piiDetections: many(piiDetections),
	parserEvalFixtures: many(parserEvalFixtures),
	parserEvalResults: many(parserEvalResults),
	workspace: one(workspaces, {
		fields: [workspaceRuns.workspaceId],
		references: [workspaces.id]
	}),
	user: one(user, {
		fields: [workspaceRuns.userId],
		references: [user.id]
	}),
	privacyAuditLogs: many(privacyAuditLog),
	kgNodes: many(kgNodes),
	kgEdges: many(kgEdges),
	kgCommunities: many(kgCommunities),
	workspaceRunStageStates: many(workspaceRunStageStates),
	documentRunStageStates: many(documentRunStageStates),
	chunkEntities: many(chunkEntities),
}));

export const workspacesRelations = relations(workspaces, ({one, many}) => ({
	documents: many(documents),
	workspaceSecrets: many(workspaceSecrets),
	workspaceInvites: many(workspaceInvites),
	workspaceConnectors: many(workspaceConnectors),
	notificationPrefs: many(notificationPrefs),
	notificationDeliveries: many(notificationDeliveries),
	auditLogs: many(auditLog),
	chatSessions: many(chatSessions),
	aiOperations: many(aiOperations),
	user: one(user, {
		fields: [workspaces.userId],
		references: [user.id]
	}),
	groundedSummaries: many(groundedSummaries),
	chatAnswerEvidenceSpans: many(chatAnswerEvidenceSpans),
	uploadSessions: many(uploadSessions),
	workspaceRuns: many(workspaceRuns),
	searchZeroResults: many(searchZeroResults),
	workspaceSearchSettings: many(workspaceSearchSettings),
	querySuggestions: many(querySuggestions),
	privacyAuditLogs: many(privacyAuditLog),
	kgNodes: many(kgNodes),
	kgEdges: many(kgEdges),
	kgCommunities: many(kgCommunities),
	kgCommunityMembers: many(kgCommunityMembers),
	workspaceMembers: many(workspaceMembers),
	chunkEntities: many(chunkEntities),
}));

export const performanceLogRelations = relations(performanceLog, ({one}) => ({
	workspaceRun: one(workspaceRuns, {
		fields: [performanceLog.runId],
		references: [workspaceRuns.id]
	}),
	document: one(documents, {
		fields: [performanceLog.documentId],
		references: [documents.id]
	}),
	user: one(user, {
		fields: [performanceLog.userId],
		references: [user.id]
	}),
}));

export const workspaceRunEventsRelations = relations(workspaceRunEvents, ({one}) => ({
	workspaceRun: one(workspaceRuns, {
		fields: [workspaceRunEvents.runId],
		references: [workspaceRuns.id]
	}),
	document: one(documents, {
		fields: [workspaceRunEvents.documentId],
		references: [documents.id]
	}),
	user: one(user, {
		fields: [workspaceRunEvents.userId],
		references: [user.id]
	}),
}));

export const workspaceSecretsRelations = relations(workspaceSecrets, ({one}) => ({
	workspace: one(workspaces, {
		fields: [workspaceSecrets.workspaceId],
		references: [workspaces.id]
	}),
}));

export const sessionRelations = relations(session, ({one}) => ({
	user: one(user, {
		fields: [session.userId],
		references: [user.id]
	}),
}));

export const accountRelations = relations(account, ({one}) => ({
	user: one(user, {
		fields: [account.userId],
		references: [user.id]
	}),
}));

export const workspaceInvitesRelations = relations(workspaceInvites, ({one}) => ({
	workspace: one(workspaces, {
		fields: [workspaceInvites.workspaceId],
		references: [workspaces.id]
	}),
	organization: one(organizations, {
		fields: [workspaceInvites.orgId],
		references: [organizations.id]
	}),
	user_acceptedByUserId: one(user, {
		fields: [workspaceInvites.acceptedByUserId],
		references: [user.id],
		relationName: "workspaceInvites_acceptedByUserId_user_id"
	}),
	user_invitedByUserId: one(user, {
		fields: [workspaceInvites.invitedByUserId],
		references: [user.id],
		relationName: "workspaceInvites_invitedByUserId_user_id"
	}),
}));

export const documentCorrectionsRelations = relations(documentCorrections, ({one}) => ({
	document: one(documents, {
		fields: [documentCorrections.documentId],
		references: [documents.id]
	}),
	workspaceRun: one(workspaceRuns, {
		fields: [documentCorrections.runId],
		references: [workspaceRuns.id]
	}),
	user: one(user, {
		fields: [documentCorrections.userId],
		references: [user.id]
	}),
}));

export const pageStageStatesRelations = relations(pageStageStates, ({one}) => ({
	workspaceRun: one(workspaceRuns, {
		fields: [pageStageStates.runId],
		references: [workspaceRuns.id]
	}),
	document: one(documents, {
		fields: [pageStageStates.documentId],
		references: [documents.id]
	}),
}));

export const workspaceConnectorsRelations = relations(workspaceConnectors, ({one, many}) => ({
	workspace: one(workspaces, {
		fields: [workspaceConnectors.workspaceId],
		references: [workspaces.id]
	}),
	connectorSyncLogs: many(connectorSyncLog),
}));

export const webhooksRelations = relations(webhooks, ({one, many}) => ({
	user: one(user, {
		fields: [webhooks.userId],
		references: [user.id]
	}),
	webhookDeliveries: many(webhookDeliveries),
}));

export const documentChunksRelations = relations(documentChunks, ({one, many}) => ({
	document: one(documents, {
		fields: [documentChunks.documentId],
		references: [documents.id]
	}),
	workspaceRun: one(workspaceRuns, {
		fields: [documentChunks.runId],
		references: [workspaceRuns.id]
	}),
	documentPage: one(documentPages, {
		fields: [documentChunks.parentPageId],
		references: [documentPages.id]
	}),
	user: one(user, {
		fields: [documentChunks.userId],
		references: [user.id]
	}),
	chunkEntities: many(chunkEntities),
}));

export const documentPagesRelations = relations(documentPages, ({one, many}) => ({
	documentChunks: many(documentChunks),
	document: one(documents, {
		fields: [documentPages.documentId],
		references: [documents.id]
	}),
	workspaceRun: one(workspaceRuns, {
		fields: [documentPages.runId],
		references: [workspaceRuns.id]
	}),
	user: one(user, {
		fields: [documentPages.userId],
		references: [user.id]
	}),
}));

export const webhookDeliveriesRelations = relations(webhookDeliveries, ({one, many}) => ({
	webhook: one(webhooks, {
		fields: [webhookDeliveries.webhookId],
		references: [webhooks.id]
	}),
	webhookDelivery: one(webhookDeliveries, {
		fields: [webhookDeliveries.replayOfDeliveryId],
		references: [webhookDeliveries.id],
		relationName: "webhookDeliveries_replayOfDeliveryId_webhookDeliveries_id"
	}),
	webhookDeliveries: many(webhookDeliveries, {
		relationName: "webhookDeliveries_replayOfDeliveryId_webhookDeliveries_id"
	}),
	user: one(user, {
		fields: [webhookDeliveries.userId],
		references: [user.id]
	}),
}));

export const notificationPrefsRelations = relations(notificationPrefs, ({one}) => ({
	organization: one(organizations, {
		fields: [notificationPrefs.orgId],
		references: [organizations.id]
	}),
	workspace: one(workspaces, {
		fields: [notificationPrefs.workspaceId],
		references: [workspaces.id]
	}),
	user: one(user, {
		fields: [notificationPrefs.userId],
		references: [user.id]
	}),
}));

export const notificationDeliveriesRelations = relations(notificationDeliveries, ({one}) => ({
	organization: one(organizations, {
		fields: [notificationDeliveries.orgId],
		references: [organizations.id]
	}),
	workspace: one(workspaces, {
		fields: [notificationDeliveries.workspaceId],
		references: [workspaces.id]
	}),
	user: one(user, {
		fields: [notificationDeliveries.userId],
		references: [user.id]
	}),
}));

export const apiKeysRelations = relations(apiKeys, ({one, many}) => ({
	organization: one(organizations, {
		fields: [apiKeys.orgId],
		references: [organizations.id]
	}),
	user: one(user, {
		fields: [apiKeys.userId],
		references: [user.id]
	}),
	auditLogs: many(auditLog),
	aiOperations: many(aiOperations),
	apiKeyUsages: many(apiKeyUsage),
}));

export const documentSummariesRelations = relations(documentSummaries, ({one}) => ({
	document: one(documents, {
		fields: [documentSummaries.documentId],
		references: [documents.id]
	}),
	workspaceRun: one(workspaceRuns, {
		fields: [documentSummaries.runId],
		references: [workspaceRuns.id]
	}),
	user: one(user, {
		fields: [documentSummaries.userId],
		references: [user.id]
	}),
}));

export const searchSessionsRelations = relations(searchSessions, ({one, many}) => ({
	user: one(user, {
		fields: [searchSessions.userId],
		references: [user.id]
	}),
	searchSessionResults: many(searchSessionResults),
	chatAnswerEvidenceSpans: many(chatAnswerEvidenceSpans),
	searchZeroResults: many(searchZeroResults),
}));

export const searchSessionResultsRelations = relations(searchSessionResults, ({one}) => ({
	searchSession: one(searchSessions, {
		fields: [searchSessionResults.sessionId],
		references: [searchSessions.id]
	}),
}));

export const auditLogRelations = relations(auditLog, ({one}) => ({
	organization: one(organizations, {
		fields: [auditLog.orgId],
		references: [organizations.id]
	}),
	workspace: one(workspaces, {
		fields: [auditLog.workspaceId],
		references: [workspaces.id]
	}),
	workspaceRun: one(workspaceRuns, {
		fields: [auditLog.runId],
		references: [workspaceRuns.id]
	}),
	document: one(documents, {
		fields: [auditLog.documentId],
		references: [documents.id]
	}),
	apiKey: one(apiKeys, {
		fields: [auditLog.apiKeyId],
		references: [apiKeys.id]
	}),
	user: one(user, {
		fields: [auditLog.userId],
		references: [user.id]
	}),
}));

export const searchEvalFixturesRelations = relations(searchEvalFixtures, ({one}) => ({
	workspaceRun: one(workspaceRuns, {
		fields: [searchEvalFixtures.runId],
		references: [workspaceRuns.id]
	}),
	user: one(user, {
		fields: [searchEvalFixtures.userId],
		references: [user.id]
	}),
}));

export const searchIndexStalenessRelations = relations(searchIndexStaleness, ({one}) => ({
	workspaceRun: one(workspaceRuns, {
		fields: [searchIndexStaleness.runId],
		references: [workspaceRuns.id]
	}),
	document: one(documents, {
		fields: [searchIndexStaleness.documentId],
		references: [documents.id]
	}),
	user: one(user, {
		fields: [searchIndexStaleness.userId],
		references: [user.id]
	}),
}));

export const documentPropositionsRelations = relations(documentPropositions, ({one}) => ({
	document: one(documents, {
		fields: [documentPropositions.documentId],
		references: [documents.id]
	}),
	workspaceRun: one(workspaceRuns, {
		fields: [documentPropositions.runId],
		references: [workspaceRuns.id]
	}),
	user: one(user, {
		fields: [documentPropositions.userId],
		references: [user.id]
	}),
}));

export const idempotencyCacheRelations = relations(idempotencyCache, ({one}) => ({
	user: one(user, {
		fields: [idempotencyCache.userId],
		references: [user.id]
	}),
}));

export const searchExperimentsRelations = relations(searchExperiments, ({one}) => ({
	user: one(user, {
		fields: [searchExperiments.userId],
		references: [user.id]
	}),
}));

export const chatSessionsRelations = relations(chatSessions, ({one, many}) => ({
	workspace: one(workspaces, {
		fields: [chatSessions.workspaceId],
		references: [workspaces.id]
	}),
	user: one(user, {
		fields: [chatSessions.userId],
		references: [user.id]
	}),
	chatTurns: many(chatTurns),
	chatAnswerEvidenceSpans: many(chatAnswerEvidenceSpans),
}));

export const chatTurnsRelations = relations(chatTurns, ({one}) => ({
	chatSession: one(chatSessions, {
		fields: [chatTurns.sessionId],
		references: [chatSessions.id]
	}),
}));

export const aiOperationsRelations = relations(aiOperations, ({one, many}) => ({
	organization: one(organizations, {
		fields: [aiOperations.orgId],
		references: [organizations.id]
	}),
	workspace: one(workspaces, {
		fields: [aiOperations.workspaceId],
		references: [workspaces.id]
	}),
	apiKey: one(apiKeys, {
		fields: [aiOperations.apiKeyId],
		references: [apiKeys.id]
	}),
	user: one(user, {
		fields: [aiOperations.userId],
		references: [user.id]
	}),
	aiOperationEvents: many(aiOperationEvents),
}));

export const aiOperationEventsRelations = relations(aiOperationEvents, ({one}) => ({
	aiOperation: one(aiOperations, {
		fields: [aiOperationEvents.operationId],
		references: [aiOperations.id]
	}),
}));

export const groundedSummariesRelations = relations(groundedSummaries, ({one}) => ({
	document: one(documents, {
		fields: [groundedSummaries.documentId],
		references: [documents.id]
	}),
	workspaceRun: one(workspaceRuns, {
		fields: [groundedSummaries.runId],
		references: [workspaceRuns.id]
	}),
	workspace: one(workspaces, {
		fields: [groundedSummaries.workspaceId],
		references: [workspaces.id]
	}),
	user: one(user, {
		fields: [groundedSummaries.userId],
		references: [user.id]
	}),
}));

export const piiDetectionsRelations = relations(piiDetections, ({one}) => ({
	document: one(documents, {
		fields: [piiDetections.documentId],
		references: [documents.id]
	}),
	workspaceRun: one(workspaceRuns, {
		fields: [piiDetections.runId],
		references: [workspaceRuns.id]
	}),
}));

export const chatAnswerEvidenceSpansRelations = relations(chatAnswerEvidenceSpans, ({one}) => ({
	chatSession: one(chatSessions, {
		fields: [chatAnswerEvidenceSpans.sessionId],
		references: [chatSessions.id]
	}),
	searchSession: one(searchSessions, {
		fields: [chatAnswerEvidenceSpans.searchSessionId],
		references: [searchSessions.id]
	}),
	workspace: one(workspaces, {
		fields: [chatAnswerEvidenceSpans.workspaceId],
		references: [workspaces.id]
	}),
	user: one(user, {
		fields: [chatAnswerEvidenceSpans.userId],
		references: [user.id]
	}),
}));

export const parserEvalFixturesRelations = relations(parserEvalFixtures, ({one}) => ({
	workspaceRun: one(workspaceRuns, {
		fields: [parserEvalFixtures.runId],
		references: [workspaceRuns.id]
	}),
	document: one(documents, {
		fields: [parserEvalFixtures.documentId],
		references: [documents.id]
	}),
	user: one(user, {
		fields: [parserEvalFixtures.userId],
		references: [user.id]
	}),
}));

export const parserEvalResultsRelations = relations(parserEvalResults, ({one}) => ({
	workspaceRun: one(workspaceRuns, {
		fields: [parserEvalResults.runId],
		references: [workspaceRuns.id]
	}),
	document: one(documents, {
		fields: [parserEvalResults.documentId],
		references: [documents.id]
	}),
	user: one(user, {
		fields: [parserEvalResults.userId],
		references: [user.id]
	}),
}));

export const uploadSessionsRelations = relations(uploadSessions, ({one, many}) => ({
	user: one(user, {
		fields: [uploadSessions.userId],
		references: [user.id]
	}),
	organization: one(organizations, {
		fields: [uploadSessions.orgId],
		references: [organizations.id]
	}),
	workspace: one(workspaces, {
		fields: [uploadSessions.workspaceId],
		references: [workspaces.id]
	}),
	uploadSessionFiles: many(uploadSessionFiles),
}));

export const uploadSessionFilesRelations = relations(uploadSessionFiles, ({one}) => ({
	uploadSession: one(uploadSessions, {
		fields: [uploadSessionFiles.sessionId],
		references: [uploadSessions.id]
	}),
}));

export const searchZeroResultsRelations = relations(searchZeroResults, ({one}) => ({
	searchSession: one(searchSessions, {
		fields: [searchZeroResults.sessionId],
		references: [searchSessions.id]
	}),
	user: one(user, {
		fields: [searchZeroResults.userId],
		references: [user.id]
	}),
	workspace: one(workspaces, {
		fields: [searchZeroResults.workspaceId],
		references: [workspaces.id]
	}),
}));

export const workspaceSearchSettingsRelations = relations(workspaceSearchSettings, ({one}) => ({
	workspace: one(workspaces, {
		fields: [workspaceSearchSettings.workspaceId],
		references: [workspaces.id]
	}),
	user: one(user, {
		fields: [workspaceSearchSettings.userId],
		references: [user.id]
	}),
}));

export const querySuggestionsRelations = relations(querySuggestions, ({one}) => ({
	user: one(user, {
		fields: [querySuggestions.userId],
		references: [user.id]
	}),
	workspace: one(workspaces, {
		fields: [querySuggestions.workspaceId],
		references: [workspaces.id]
	}),
}));

export const privacyAuditLogRelations = relations(privacyAuditLog, ({one}) => ({
	document: one(documents, {
		fields: [privacyAuditLog.documentId],
		references: [documents.id]
	}),
	workspaceRun: one(workspaceRuns, {
		fields: [privacyAuditLog.runId],
		references: [workspaceRuns.id]
	}),
	workspace: one(workspaces, {
		fields: [privacyAuditLog.workspaceId],
		references: [workspaces.id]
	}),
}));

export const connectorSyncLogRelations = relations(connectorSyncLog, ({one}) => ({
	workspaceConnector: one(workspaceConnectors, {
		fields: [connectorSyncLog.connectorId],
		references: [workspaceConnectors.id]
	}),
}));

export const oauthAccountsRelations = relations(oauthAccounts, ({one}) => ({
	user: one(user, {
		fields: [oauthAccounts.userId],
		references: [user.id]
	}),
}));

export const ssoAuthRequestsRelations = relations(ssoAuthRequests, ({one}) => ({
	organization: one(organizations, {
		fields: [ssoAuthRequests.orgId],
		references: [organizations.id]
	}),
}));

export const creditGrantsRelations = relations(creditGrants, ({one}) => ({
	organization: one(organizations, {
		fields: [creditGrants.orgId],
		references: [organizations.id]
	}),
}));

export const storageMeterDaysRelations = relations(storageMeterDays, ({one}) => ({
	organization: one(organizations, {
		fields: [storageMeterDays.orgId],
		references: [organizations.id]
	}),
}));

export const kgNodesRelations = relations(kgNodes, ({one, many}) => ({
	workspace: one(workspaces, {
		fields: [kgNodes.workspaceId],
		references: [workspaces.id]
	}),
	workspaceRun: one(workspaceRuns, {
		fields: [kgNodes.runId],
		references: [workspaceRuns.id]
	}),
	user: one(user, {
		fields: [kgNodes.userId],
		references: [user.id]
	}),
	kgEdges_sourceNodeId: many(kgEdges, {
		relationName: "kgEdges_sourceNodeId_kgNodes_id"
	}),
	kgEdges_targetNodeId: many(kgEdges, {
		relationName: "kgEdges_targetNodeId_kgNodes_id"
	}),
	kgCommunityMembers: many(kgCommunityMembers),
	chunkEntities: many(chunkEntities),
}));

export const kgEdgesRelations = relations(kgEdges, ({one}) => ({
	workspace: one(workspaces, {
		fields: [kgEdges.workspaceId],
		references: [workspaces.id]
	}),
	workspaceRun: one(workspaceRuns, {
		fields: [kgEdges.runId],
		references: [workspaceRuns.id]
	}),
	user: one(user, {
		fields: [kgEdges.userId],
		references: [user.id]
	}),
	kgNode_sourceNodeId: one(kgNodes, {
		fields: [kgEdges.sourceNodeId],
		references: [kgNodes.id],
		relationName: "kgEdges_sourceNodeId_kgNodes_id"
	}),
	kgNode_targetNodeId: one(kgNodes, {
		fields: [kgEdges.targetNodeId],
		references: [kgNodes.id],
		relationName: "kgEdges_targetNodeId_kgNodes_id"
	}),
}));

export const kgCommunitiesRelations = relations(kgCommunities, ({one, many}) => ({
	workspace: one(workspaces, {
		fields: [kgCommunities.workspaceId],
		references: [workspaces.id]
	}),
	workspaceRun: one(workspaceRuns, {
		fields: [kgCommunities.runId],
		references: [workspaceRuns.id]
	}),
	user: one(user, {
		fields: [kgCommunities.userId],
		references: [user.id]
	}),
	kgCommunityMembers: many(kgCommunityMembers),
}));

export const orgMembershipsRelations = relations(orgMemberships, ({one}) => ({
	organization: one(organizations, {
		fields: [orgMemberships.orgId],
		references: [organizations.id]
	}),
	user: one(user, {
		fields: [orgMemberships.userId],
		references: [user.id]
	}),
}));

export const documentTagsRelations = relations(documentTags, ({one}) => ({
	document: one(documents, {
		fields: [documentTags.documentId],
		references: [documents.id]
	}),
	user: one(user, {
		fields: [documentTags.userId],
		references: [user.id]
	}),
}));

export const apiKeyUsageRelations = relations(apiKeyUsage, ({one}) => ({
	apiKey: one(apiKeys, {
		fields: [apiKeyUsage.keyId],
		references: [apiKeys.id]
	}),
}));

export const kgCommunityMembersRelations = relations(kgCommunityMembers, ({one}) => ({
	kgCommunity: one(kgCommunities, {
		fields: [kgCommunityMembers.communityId],
		references: [kgCommunities.id]
	}),
	kgNode: one(kgNodes, {
		fields: [kgCommunityMembers.nodeId],
		references: [kgNodes.id]
	}),
	workspace: one(workspaces, {
		fields: [kgCommunityMembers.workspaceId],
		references: [workspaces.id]
	}),
}));

export const workspaceMembersRelations = relations(workspaceMembers, ({one}) => ({
	workspace: one(workspaces, {
		fields: [workspaceMembers.workspaceId],
		references: [workspaces.id]
	}),
	user_invitedByUserId: one(user, {
		fields: [workspaceMembers.invitedByUserId],
		references: [user.id],
		relationName: "workspaceMembers_invitedByUserId_user_id"
	}),
	user_userId: one(user, {
		fields: [workspaceMembers.userId],
		references: [user.id],
		relationName: "workspaceMembers_userId_user_id"
	}),
}));

export const workspaceRunStageStatesRelations = relations(workspaceRunStageStates, ({one}) => ({
	workspaceRun: one(workspaceRuns, {
		fields: [workspaceRunStageStates.runId],
		references: [workspaceRuns.id]
	}),
}));

export const documentRunStageStatesRelations = relations(documentRunStageStates, ({one}) => ({
	workspaceRun: one(workspaceRuns, {
		fields: [documentRunStageStates.runId],
		references: [workspaceRuns.id]
	}),
	document: one(documents, {
		fields: [documentRunStageStates.documentId],
		references: [documents.id]
	}),
}));

export const chunkEntitiesRelations = relations(chunkEntities, ({one}) => ({
	documentChunk: one(documentChunks, {
		fields: [chunkEntities.chunkId],
		references: [documentChunks.id]
	}),
	workspace: one(workspaces, {
		fields: [chunkEntities.workspaceId],
		references: [workspaces.id]
	}),
	workspaceRun: one(workspaceRuns, {
		fields: [chunkEntities.runId],
		references: [workspaceRuns.id]
	}),
	user: one(user, {
		fields: [chunkEntities.userId],
		references: [user.id]
	}),
	kgNode: one(kgNodes, {
		fields: [chunkEntities.nodeId],
		references: [kgNodes.id]
	}),
}));