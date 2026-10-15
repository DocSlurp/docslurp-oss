import {
  docslurpAlgoliaClient,
  type DocSlurpAlgoliaClientOptions,
  type AlgoliaCompatSettings,
  type AlgoliaRuleEntry,
  type AlgoliaSearchRequest,
  type AlgoliaSearchResponse,
  type AlgoliaSynonymEntry
} from "@docslurp/contrib-search-compat/algolia";

export type DocSlurpAlgoliaServerClientOptions = DocSlurpAlgoliaClientOptions & {
  defaultIndexName?: string;
};

export function createDocSlurpAlgoliaServerClient(options: DocSlurpAlgoliaServerClientOptions) {
  const client = docslurpAlgoliaClient(options);

  return {
    ...client,
    searchIndex: async (indexName: string, request: AlgoliaSearchRequest): Promise<AlgoliaSearchResponse> => {
      return await client.initIndex(indexName).search(request);
    },
    syncSettings: async (indexName: string, settings: AlgoliaCompatSettings) => {
      return await client.initIndex(indexName).setSettings(settings);
    },
    syncSynonyms: async (indexName: string, synonyms: AlgoliaSynonymEntry[]) => {
      return await client.initIndex(indexName).saveSynonyms(synonyms);
    },
    syncRules: async (indexName: string, rules: AlgoliaRuleEntry[]) => {
      return await client.initIndex(indexName).saveRules(rules);
    }
  };
}

export default createDocSlurpAlgoliaServerClient;
