if (process.env.DOCSLURP_PARSER_SANDBOX === undefined) {
  process.env.DOCSLURP_PARSER_SANDBOX = "none";
}
// Tests mock @huggingface/transformers in-process; a worker thread would load the real package.
if (process.env.DOCSLURP_LOCAL_EMBED_THREAD === undefined) {
  process.env.DOCSLURP_LOCAL_EMBED_THREAD = "off";
}
