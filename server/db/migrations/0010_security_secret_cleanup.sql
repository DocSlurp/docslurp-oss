-- Security hardening cleanup:
-- - OAuth access/refresh/id tokens are encrypted into oauth_accounts by app code.
--   Remove any legacy plaintext copies left in Better Auth's account table.
-- - SSO client secrets now live in an encrypted clientSecretEncrypted field.
--   Existing plaintext JSON secrets cannot be safely encrypted inside SQL without
--   the application key, so drop them and require re-entry for affected orgs.

update "account"
set
  "accessToken" = null,
  "refreshToken" = null,
  "idToken" = null
where
  "accessToken" is not null
  or "refreshToken" is not null
  or "idToken" is not null;

update organizations
set sso_config = (sso_config - 'clientSecret') || jsonb_build_object('clientSecretEncrypted', null)
where sso_config is not null
  and sso_config ? 'clientSecret'
  and nullif(sso_config ->> 'clientSecret', '') is not null
  and not (sso_config ? 'clientSecretEncrypted');

update organizations
set sso_config = sso_config - 'clientSecret'
where sso_config is not null
  and sso_config ? 'clientSecret';
