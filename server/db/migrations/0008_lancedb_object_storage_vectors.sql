-- Keep PostgreSQL as the metadata, text, and audit ledger.
-- Vector payloads and ANN indexes now live in LanceDB/object storage.

drop index if exists document_chunks_vector_idx;
drop index if exists document_chunks_vector_idx1;
drop index if exists document_summaries_vector_idx;
drop index if exists document_summaries_vector_idx1;
drop index if exists document_propositions_vector_idx;
drop index if exists document_propositions_vector_idx1;

alter table if exists document_chunks
  drop column if exists vector;

alter table if exists document_summaries
  drop column if exists vector;

alter table if exists document_propositions
  drop column if exists vector;

alter table if exists kg_communities
  drop column if exists vector;

drop table if exists document_vector_chunks;

drop extension if exists vector;
