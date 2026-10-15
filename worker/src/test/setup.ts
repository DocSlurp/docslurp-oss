if (process.env.DOCSLURP_PARSER_SANDBOX_ENABLED === undefined) {
  process.env.DOCSLURP_PARSER_SANDBOX_ENABLED = "false";
}
// Tests mock @huggingface/transformers in-process; a worker thread would load the real package.
if (process.env.DOCSLURP_LOCAL_EMBED_THREAD === undefined) {
  process.env.DOCSLURP_LOCAL_EMBED_THREAD = "off";
}
