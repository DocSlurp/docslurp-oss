import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SAML, ValidateInResponseTo } from "@node-saml/node-saml";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sensitiveSamlRequestCache, verifiedSamlSensitiveAuthTime } from "../lib/auth-sensitive-sso.js";

// Exercise node-saml's actual XML signature verification with a disposable test IdP key.
const samlRequire = createRequire(createRequire(import.meta.url).resolve("@node-saml/node-saml"));
const { SignedXml } = samlRequire("xml-crypto");
let scratch: string; let key: string; let cert: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "sensitive-saml-test."));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=synthetic-idp.test", "-days", "1", "-keyout", join(scratch, "key.pem"), "-out", join(scratch, "cert.pem")], { stdio: "ignore" });
  key = readFileSync(join(scratch, "key.pem"), "utf8"); cert = readFileSync(join(scratch, "cert.pem"), "utf8");
});
afterAll(() => { if (scratch) rmSync(scratch, { recursive: true }); });
const idp = "urn:synthetic-idp"; const audience = "https://api.example.com/docslurp-sp"; const recipient = "https://api.example.com/callback";
function signedResponse(request: string, authInstant = new Date().toISOString()) {
  const issued = new Date().toISOString(); const before = new Date(Date.now() - 60_000).toISOString(); const after = new Date(Date.now() + 300_000).toISOString();
  let xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="response-id" Version="2.0" IssueInstant="${issued}" Destination="${recipient}" InResponseTo="${request}"><saml:Issuer>${idp}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="assertion-id" Version="2.0" IssueInstant="${issued}"><saml:Issuer>${idp}</saml:Issuer><saml:Subject><saml:NameID>linked-subject</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${request}" NotOnOrAfter="${after}" Recipient="${recipient}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${before}" NotOnOrAfter="${after}"><saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${authInstant}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement></saml:Assertion></samlp:Response>`;
  for (const element of ["Assertion", "Response"]) {
    const signer = new SignedXml({ privateKey: key, publicCert: cert });
    signer.signatureAlgorithm = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
    signer.canonicalizationAlgorithm = "http://www.w3.org/2001/10/xml-exc-c14n#";
    signer.addReference({ xpath: `//*[local-name()='${element}']`, digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256", transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"] });
    signer.computeSignature(xml, { location: { reference: `//*[local-name()='${element}']/*[local-name()='Issuer']`, action: "after" } });
    xml = signer.getSignedXml();
  }
  return Buffer.from(xml).toString("base64");
}
function client(request: string) {
  return new SAML({ entryPoint: "https://idp.example.com/login", idpCert: cert, issuer: audience, callbackUrl: recipient, idpIssuer: idp, wantAssertionsSigned: true, wantAuthnResponseSigned: true, validateInResponseTo: ValidateInResponseTo.always, acceptedClockSkewMs: 5_000, cacheProvider: sensitiveSamlRequestCache(request, new Date().toISOString(), new Date(Date.now() + 600_000).toISOString()) });
}
describe("sensitive SAML signed proof", () => {
  it("reads fresh AuthnInstant only from the signature-verified assertion and rejects replay", async () => {
    const verifier = client("request-one"); const response = signedResponse("request-one");
    const validated = await verifier.validatePostResponseAsync({ SAMLResponse: response });
    expect(verifiedSamlSensitiveAuthTime(validated.profile as unknown as Record<string, unknown>, idp, "request-one")).toBeTypeOf("number");
    await expect(verifier.validatePostResponseAsync({ SAMLResponse: response })).rejects.toThrow();
  });
  it("rejects another consumed request's signed response instead of accepting a different cache entry", async () => {
    await expect(client("request-one").validatePostResponseAsync({ SAMLResponse: signedResponse("request-two") })).rejects.toThrow();
  });
  it("rejects XML changes to the authentication instant without a fresh IdP signature", async () => {
    const signed = Buffer.from(signedResponse("request-one"), "base64").toString("utf8");
    const tampered = signed.replace(/AuthnInstant="[^"]+"/, 'AuthnInstant="2020-01-01T00:00:00Z"');
    await expect(client("request-one").validatePostResponseAsync({ SAMLResponse: Buffer.from(tampered).toString("base64") })).rejects.toThrow();
  });
});
