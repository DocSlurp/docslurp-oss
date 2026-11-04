-- The one definition of "may this user see this workspace". getWorkspaceAccess,
-- the accessible-workspace listings, search sessions, realtime authorization,
-- operation policy and workspace suggestions all call it instead of repeating the
-- predicate, so a change to the rule lands everywhere at once.
--   * An org member sees a workspace they own, were added to, administer the org
--     for (owner/admin), or that is the org's default workspace.
--   * Anyone with a direct share out of a personal org keeps it (its one member
--     can't be removed), without needing an org membership.
-- Removed org members keep nothing: every team-org branch requires org_memberships.
CREATE OR REPLACE FUNCTION docslurp_workspace_access(p_workspace_id text, p_user_id text)
RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM workspaces w
    JOIN organizations o ON o.id = w.org_id
    LEFT JOIN org_memberships om ON om.org_id = w.org_id AND om.user_id = p_user_id
    LEFT JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = p_user_id
    WHERE w.id = p_workspace_id
      AND p_user_id IS NOT NULL
      AND (
        (om.user_id IS NOT NULL AND (w.user_id = p_user_id OR wm.user_id IS NOT NULL OR om.role IN ('owner', 'admin') OR w.is_default))
        OR (wm.user_id IS NOT NULL AND o.is_personal)
      )
  )
$$;
