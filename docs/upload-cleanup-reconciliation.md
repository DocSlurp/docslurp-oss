# Original-upload cleanup reconciliation

Original-upload cleanup retains a daily tombstone to catch PUTs that finish after an earlier deletion. The separate ownership record survives session/document deletion.

If ownership cannot be verified, the sweep logs `status=ownership-quarantined` at error level, retains the queue row and its `last_error`, and sets `not_before` to infinity. It does not delete the object or retry silently.

Operators should inspect `storage_cleanup_queue` rows of kind `upload_original` with infinite `not_before`. Recover the original key, sealed key and organization from independently trusted upload audit records or a database backup. Never use the queue payload alone as ownership evidence. After verifying that tuple, insert its missing `upload_cleanup_owners` record and set the corresponding queue row's `not_before` to now. Existing conflicting ownership must be investigated, not overwritten.

If historical ownership cannot be established, keep the object quarantined and report the unresolved storage obligation. An owner must decide its disposition; automatic deletion is intentionally refused.

Deploy migrations and updated cleanup workers before enabling the updated upload finalizer. Older workers do not recognize the new cleanup kind.
