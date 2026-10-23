import type { BetterAuthOptions } from "better-auth";

type AccountCreateHook = NonNullable<NonNullable<NonNullable<NonNullable<BetterAuthOptions["databaseHooks"]>["account"]>["create"]>["before"]>;

/** Better Auth has checked the provider's verified matching email before linking.
 * An unverified signup's password cannot survive that ownership proof: it could
 * have been chosen by someone who merely knew the owner's email address.
 */
export const beforeOAuthAccountCreate: AccountCreateHook = async (account, context) => {
  if (account.providerId !== "google" && account.providerId !== "github") return;
  if (!context) throw new Error("OAuth linking requires an authentication context");
  const adapter = context.context.internalAdapter;
  const user = await adapter.findUserById(account.userId);
  if (!user || user.emailVerified) return;
  const accounts = await adapter.findAccounts(account.userId);
  for (const existing of accounts) {
    if (existing.providerId === "credential") await adapter.deleteAccount(existing.id);
  }
  await adapter.deleteUserSessions(account.userId);
};
