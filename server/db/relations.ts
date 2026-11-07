import { relations } from "drizzle-orm/relations";
import { user, creditLedger, organizations, documents, vectorIndexes, projectRuns, usageEvents, projects, performanceLog, projectRunEvents, projectSecrets, session, account, projectInvites, documentCorrections, pageStageStates, projectConnectors, webhooks, documentChunks, documentPages, webhookDeliveries, notificationPrefs, notificationDeliveries, apiKeys, documentSummaries, searchSessions, searchSessionResults, auditLog, searchEvalFixtures, searchIndexStaleness, documentPropositions, idempotencyCache, searchExperiments, chatSessions, chatTurns, piiDetections, chatAnswerEvidenceSpans, parserEvalFixtures, parserEvalResults, uploadSessions, uploadSessionFiles, searchZeroResults, projectSearchSettings, querySuggestions, privacyAuditLog, connectorSyncLog, oauthAccounts, ssoAuthRequests, kgNodes, kgEdges, kgCommunities, orgMemberships, documentTags, apiKeyUsage, kgCommunityMembers, projectMembers, projectRunStageStates, documentRunStageStates, chunkEntities, creditGrants, storageMeterDays } from "./schema";

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
	projectRunEvents: many(projectRunEvents),
	sessions: many(session),
	accounts: many(account),
	projectInvites_acceptedByUserId: many(projectInvites, {
		relationName: "projectInvites_acceptedByUserId_user_id"
	}),
	projectInvites_invitedByUserId: many(projectInvites, {
		relationName: "projectInvites_invitedByUserId_user_id"
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
	projects: many(projects),
	chatAnswerEvidenceSpans: many(chatAnswerEvidenceSpans),
	parserEvalFixtures: many(parserEvalFixtures),
	parserEvalResults: many(parserEvalResults),
	uploadSessions: many(uploadSessions),
	projectRuns: many(projectRuns),
	searchZeroResults: many(searchZeroResults),
	projectSearchSettings: many(projectSearchSettings),
	querySuggestions: many(querySuggestions),
	oauthAccounts: many(oauthAccounts),
	kgNodes: many(kgNodes),
	kgEdges: many(kgEdges),
	kgCommunities: many(kgCommunities),
	orgMemberships: many(orgMemberships),
	documentTags: many(documentTags),
	projectMembers_invitedByUserId: many(projectMembers, {
		relationName: "projectMembers_invitedByUserId_user_id"
	}),
	projectMembers_userId: many(projectMembers, {
		relationName: "projectMembers_userId_user_id"
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
	projectInvites: many(projectInvites),
	notificationPrefs: many(notificationPrefs),
	notificationDeliveries: many(notificationDeliveries),
	apiKeys: many(apiKeys),
	auditLogs: many(auditLog),
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
	project: one(projects, {
		fields: [documents.projectId],
		references: [projects.id]
	}),
	projectRun: one(projectRuns, {
		fields: [documents.runId],
		references: [projectRuns.id]
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
	projectRunEvents: many(projectRunEvents),
	documentCorrections: many(documentCorrections),
	pageStageStates: many(pageStageStates),
	documentChunks: many(documentChunks),
	documentPages: many(documentPages),
	documentSummaries: many(documentSummaries),
	auditLogs: many(auditLog),
	searchIndexStalenesses: many(searchIndexStaleness),
	documentPropositions: many(documentPropositions),
	piiDetections: many(piiDetections),
	parserEvalFixtures: many(parserEvalFixtures),
	parserEvalResults: many(parserEvalResults),
	privacyAuditLogs: many(privacyAuditLog),
	documentTags: many(documentTags),
	documentRunStageStates: many(documentRunStageStates),
}));

export const usageEventsRelations = relations(usageEvents, ({one}) => ({
	projectRun: one(projectRuns, {
		fields: [usageEvents.runId],
		references: [projectRuns.id]
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

export const projectRunsRelations = relations(projectRuns, ({one, many}) => ({
	usageEvents: many(usageEvents),
	documents: many(documents),
	performanceLogs: many(performanceLog),
	projectRunEvents: many(projectRunEvents),
	documentCorrections: many(documentCorrections),
	pageStageStates: many(pageStageStates),
	documentChunks: many(documentChunks),
	documentPages: many(documentPages),
	documentSummaries: many(documentSummaries),
	auditLogs: many(auditLog),
	searchEvalFixtures: many(searchEvalFixtures),
	searchIndexStalenesses: many(searchIndexStaleness),
	documentPropositions: many(documentPropositions),
	piiDetections: many(piiDetections),
	parserEvalFixtures: many(parserEvalFixtures),
	parserEvalResults: many(parserEvalResults),
	project: one(projects, {
		fields: [projectRuns.projectId],
		references: [projects.id]
	}),
	user: one(user, {
		fields: [projectRuns.userId],
		references: [user.id]
	}),
	privacyAuditLogs: many(privacyAuditLog),
	kgNodes: many(kgNodes),
	kgEdges: many(kgEdges),
	kgCommunities: many(kgCommunities),
	projectRunStageStates: many(projectRunStageStates),
	documentRunStageStates: many(documentRunStageStates),
	chunkEntities: many(chunkEntities),
}));

export const projectsRelations = relations(projects, ({one, many}) => ({
	documents: many(documents),
	projectSecrets: many(projectSecrets),
	projectInvites: many(projectInvites),
	projectConnectors: many(projectConnectors),
	notificationPrefs: many(notificationPrefs),
	notificationDeliveries: many(notificationDeliveries),
	auditLogs: many(auditLog),
	chatSessions: many(chatSessions),
	user: one(user, {
		fields: [projects.userId],
		references: [user.id]
	}),
	chatAnswerEvidenceSpans: many(chatAnswerEvidenceSpans),
	uploadSessions: many(uploadSessions),
	projectRuns: many(projectRuns),
	searchZeroResults: many(searchZeroResults),
	projectSearchSettings: many(projectSearchSettings),
	querySuggestions: many(querySuggestions),
	privacyAuditLogs: many(privacyAuditLog),
	kgNodes: many(kgNodes),
	kgEdges: many(kgEdges),
	kgCommunities: many(kgCommunities),
	kgCommunityMembers: many(kgCommunityMembers),
	projectMembers: many(projectMembers),
	chunkEntities: many(chunkEntities),
}));

export const performanceLogRelations = relations(performanceLog, ({one}) => ({
	projectRun: one(projectRuns, {
		fields: [performanceLog.runId],
		references: [projectRuns.id]
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

export const projectRunEventsRelations = relations(projectRunEvents, ({one}) => ({
	projectRun: one(projectRuns, {
		fields: [projectRunEvents.runId],
		references: [projectRuns.id]
	}),
	document: one(documents, {
		fields: [projectRunEvents.documentId],
		references: [documents.id]
	}),
	user: one(user, {
		fields: [projectRunEvents.userId],
		references: [user.id]
	}),
}));

export const projectSecretsRelations = relations(projectSecrets, ({one}) => ({
	project: one(projects, {
		fields: [projectSecrets.projectId],
		references: [projects.id]
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

export const projectInvitesRelations = relations(projectInvites, ({one}) => ({
	project: one(projects, {
		fields: [projectInvites.projectId],
		references: [projects.id]
	}),
	organization: one(organizations, {
		fields: [projectInvites.orgId],
		references: [organizations.id]
	}),
	user_acceptedByUserId: one(user, {
		fields: [projectInvites.acceptedByUserId],
		references: [user.id],
		relationName: "projectInvites_acceptedByUserId_user_id"
	}),
	user_invitedByUserId: one(user, {
		fields: [projectInvites.invitedByUserId],
		references: [user.id],
		relationName: "projectInvites_invitedByUserId_user_id"
	}),
}));

export const documentCorrectionsRelations = relations(documentCorrections, ({one}) => ({
	document: one(documents, {
		fields: [documentCorrections.documentId],
		references: [documents.id]
	}),
	projectRun: one(projectRuns, {
		fields: [documentCorrections.runId],
		references: [projectRuns.id]
	}),
	user: one(user, {
		fields: [documentCorrections.userId],
		references: [user.id]
	}),
}));

export const pageStageStatesRelations = relations(pageStageStates, ({one}) => ({
	projectRun: one(projectRuns, {
		fields: [pageStageStates.runId],
		references: [projectRuns.id]
	}),
	document: one(documents, {
		fields: [pageStageStates.documentId],
		references: [documents.id]
	}),
}));

export const projectConnectorsRelations = relations(projectConnectors, ({one, many}) => ({
	project: one(projects, {
		fields: [projectConnectors.projectId],
		references: [projects.id]
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
	projectRun: one(projectRuns, {
		fields: [documentChunks.runId],
		references: [projectRuns.id]
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
	projectRun: one(projectRuns, {
		fields: [documentPages.runId],
		references: [projectRuns.id]
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
	project: one(projects, {
		fields: [notificationPrefs.projectId],
		references: [projects.id]
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
	project: one(projects, {
		fields: [notificationDeliveries.projectId],
		references: [projects.id]
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
	apiKeyUsages: many(apiKeyUsage),
}));

export const documentSummariesRelations = relations(documentSummaries, ({one}) => ({
	document: one(documents, {
		fields: [documentSummaries.documentId],
		references: [documents.id]
	}),
	projectRun: one(projectRuns, {
		fields: [documentSummaries.runId],
		references: [projectRuns.id]
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
	project: one(projects, {
		fields: [auditLog.projectId],
		references: [projects.id]
	}),
	projectRun: one(projectRuns, {
		fields: [auditLog.runId],
		references: [projectRuns.id]
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
	projectRun: one(projectRuns, {
		fields: [searchEvalFixtures.runId],
		references: [projectRuns.id]
	}),
	user: one(user, {
		fields: [searchEvalFixtures.userId],
		references: [user.id]
	}),
}));

export const searchIndexStalenessRelations = relations(searchIndexStaleness, ({one}) => ({
	projectRun: one(projectRuns, {
		fields: [searchIndexStaleness.runId],
		references: [projectRuns.id]
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
	projectRun: one(projectRuns, {
		fields: [documentPropositions.runId],
		references: [projectRuns.id]
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
	project: one(projects, {
		fields: [chatSessions.projectId],
		references: [projects.id]
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

export const piiDetectionsRelations = relations(piiDetections, ({one}) => ({
	document: one(documents, {
		fields: [piiDetections.documentId],
		references: [documents.id]
	}),
	projectRun: one(projectRuns, {
		fields: [piiDetections.runId],
		references: [projectRuns.id]
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
	project: one(projects, {
		fields: [chatAnswerEvidenceSpans.projectId],
		references: [projects.id]
	}),
	user: one(user, {
		fields: [chatAnswerEvidenceSpans.userId],
		references: [user.id]
	}),
}));

export const parserEvalFixturesRelations = relations(parserEvalFixtures, ({one}) => ({
	projectRun: one(projectRuns, {
		fields: [parserEvalFixtures.runId],
		references: [projectRuns.id]
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
	projectRun: one(projectRuns, {
		fields: [parserEvalResults.runId],
		references: [projectRuns.id]
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
	project: one(projects, {
		fields: [uploadSessions.projectId],
		references: [projects.id]
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
	project: one(projects, {
		fields: [searchZeroResults.projectId],
		references: [projects.id]
	}),
}));

export const projectSearchSettingsRelations = relations(projectSearchSettings, ({one}) => ({
	project: one(projects, {
		fields: [projectSearchSettings.projectId],
		references: [projects.id]
	}),
	user: one(user, {
		fields: [projectSearchSettings.userId],
		references: [user.id]
	}),
}));

export const querySuggestionsRelations = relations(querySuggestions, ({one}) => ({
	user: one(user, {
		fields: [querySuggestions.userId],
		references: [user.id]
	}),
	project: one(projects, {
		fields: [querySuggestions.projectId],
		references: [projects.id]
	}),
}));

export const privacyAuditLogRelations = relations(privacyAuditLog, ({one}) => ({
	document: one(documents, {
		fields: [privacyAuditLog.documentId],
		references: [documents.id]
	}),
	projectRun: one(projectRuns, {
		fields: [privacyAuditLog.runId],
		references: [projectRuns.id]
	}),
	project: one(projects, {
		fields: [privacyAuditLog.projectId],
		references: [projects.id]
	}),
}));

export const connectorSyncLogRelations = relations(connectorSyncLog, ({one}) => ({
	projectConnector: one(projectConnectors, {
		fields: [connectorSyncLog.connectorId],
		references: [projectConnectors.id]
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
	project: one(projects, {
		fields: [kgNodes.projectId],
		references: [projects.id]
	}),
	projectRun: one(projectRuns, {
		fields: [kgNodes.runId],
		references: [projectRuns.id]
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
	project: one(projects, {
		fields: [kgEdges.projectId],
		references: [projects.id]
	}),
	projectRun: one(projectRuns, {
		fields: [kgEdges.runId],
		references: [projectRuns.id]
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
	project: one(projects, {
		fields: [kgCommunities.projectId],
		references: [projects.id]
	}),
	projectRun: one(projectRuns, {
		fields: [kgCommunities.runId],
		references: [projectRuns.id]
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
	project: one(projects, {
		fields: [kgCommunityMembers.projectId],
		references: [projects.id]
	}),
}));

export const projectMembersRelations = relations(projectMembers, ({one}) => ({
	project: one(projects, {
		fields: [projectMembers.projectId],
		references: [projects.id]
	}),
	user_invitedByUserId: one(user, {
		fields: [projectMembers.invitedByUserId],
		references: [user.id],
		relationName: "projectMembers_invitedByUserId_user_id"
	}),
	user_userId: one(user, {
		fields: [projectMembers.userId],
		references: [user.id],
		relationName: "projectMembers_userId_user_id"
	}),
}));

export const projectRunStageStatesRelations = relations(projectRunStageStates, ({one}) => ({
	projectRun: one(projectRuns, {
		fields: [projectRunStageStates.runId],
		references: [projectRuns.id]
	}),
}));

export const documentRunStageStatesRelations = relations(documentRunStageStates, ({one}) => ({
	projectRun: one(projectRuns, {
		fields: [documentRunStageStates.runId],
		references: [projectRuns.id]
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
	project: one(projects, {
		fields: [chunkEntities.projectId],
		references: [projects.id]
	}),
	projectRun: one(projectRuns, {
		fields: [chunkEntities.runId],
		references: [projectRuns.id]
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