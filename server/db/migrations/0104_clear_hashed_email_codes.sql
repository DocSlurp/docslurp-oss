-- destructive-migration: deletes only pending emailed codes. They were stored hashed and live 10 minutes; codes are now stored encrypted (auth-email.ts), which can't read a hash, so a pending row would block resends until it expired. People request a fresh code.
DELETE FROM verification
 WHERE identifier LIKE 'email-verification-otp-%'
    OR identifier LIKE 'sign-in-otp-%'
    OR identifier LIKE 'forget-password-otp-%'
    OR identifier LIKE 'change-email-otp-%';
