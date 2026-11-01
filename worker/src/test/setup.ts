if (process.env.DOCSLURP_PARSER_SANDBOX === undefined) {
  process.env.DOCSLURP_PARSER_SANDBOX = "none";
}
// "none" cannot filter UNIX sockets; the development opt-in lets tests run commands under it. Tests
// of the refusal unset it.
if (process.env.DOCSLURP_SANDBOX_ALLOW_UNFILTERED_SOCKETS === undefined) {
  process.env.DOCSLURP_SANDBOX_ALLOW_UNFILTERED_SOCKETS = "1";
}
// Tests mock @huggingface/transformers in-process; a worker thread would load the real package.
if (process.env.DOCSLURP_LOCAL_EMBED_THREAD === undefined) {
  process.env.DOCSLURP_LOCAL_EMBED_THREAD = "off";
}

// Unit suites do not launch paid VM preprocessing; orientation suites explicitly enable/mock it.
process.env.DOCSLURP_IMAGE_ORIENTATION = "false";
