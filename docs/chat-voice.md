# Voice input for document chat

Click the microphone beside Send, speak, then stop. The transcript is appended
to the current draft for review before sending. The existing document retrieval,
cited answers, streaming, and non-streaming fallback handle the submitted text.
Typing remains available. This is speech input; answers are displayed as text.

Recording requires HTTPS (or localhost), microphone permission, and MediaRecorder
support. Chrome/Firefox record WebM; Safari can record MP4/M4A. The browser decodes
and resamples these to mono 16 kHz PCM WAV before upload, because the MAI provider
rejects WebM in live testing. Recording stops after
two minutes. Cancel, thread changes, and unmount release the microphone and discard
late results. Uploads are limited to 8 MiB, and transcription has a 60-second
provider timeout. Audio is forwarded for transcription without being saved as a
document or stored by DocSlurp.

## Model and configuration

Set the server's `OPENROUTER_API_KEY` (existing `OPENROUTER_KEY` alias also works).
No new dependency or database migration is required. The model is pinned to
`microsoft/mai-transcribe-2` through a request-scoped Mastra `MastraVoice` adapter.
The adapter implements `listen()` and retains the provider's JSON usage before
returning text. Text-to-speech is not enabled.

Verified on 2026-10-09: [OpenRouter lists MAI-Transcribe 2](https://openrouter.ai/microsoft/mai-transcribe-2)
at $0.10 per hour of audio (about $0.00167/minute), released September 3, 2026.
That is about 44% below GPT-4o Mini Transcribe's estimated $0.003/minute.
[Microsoft reports](https://microsoft.ai/news/mai-transcribe-2-is-the-fastest-most-accurate-and-cheapest-speech-recognition-model-in-the-world/)
60-language support and strong multilingual accuracy. These are provider claims;
this change does not establish a comparative quality benchmark on user recordings.

## API and accounting

`POST /v1/workspaces/:workspaceId/chat/transcribe` accepts a multipart `audio`
file in PCM WAV format and returns `{ text, model }`. The file must be typed
`audio/wav` (or `audio/x-wav`, `audio/wave`) and start with a RIFF/WAVE header;
anything else, including WebM and M4A, gets `415 unsupported_type` before any
spend check or provider call, because the hosted model rejects those formats.
It uses the dashboard session, checks workspace
access, and inherits the API's `chat-ai` rate limits (per user: 60/min on
starter organizations, 120/min on funded ones; per IP: 90/min), which it shares
with chat turns in the same window. It is a dashboard endpoint,
not an API-key or public embed endpoint. It is registered before `/chat/:agentId`.

The server sends base64 audio to [OpenRouter's transcription endpoint](https://openrouter.ai/docs/guides/overview/multimodal/stt).
The usage ledger logs `chat.transcription` and persists actual provider cost,
duration in seconds, reported token counts, generation ID, and organization/workspace
scope with `run_id = null`. Duration-priced providers can report zero or omit token
counts; `tokenUsageReported` records that distinction. Tokens are never estimated.
The existing charge parser includes separate BYOK upstream charges. Audio and
transcript content are excluded from usage metadata.

Missing credentials, malformed audio, empty speech, upstream failures, and usage
persistence failures do not submit a chat message. Cancel stops browser work; if
transcription has already reached the server, it may finish and incur a charge,
which is still recorded. No automatic model fallback or paid retry is performed.

## Verification

The 2026-10-09 functional smoke check used Chromium's fake microphone with the
system's ALSA front-center sample, passed through MediaRecorder, browser WAV
conversion, the authenticated endpoint, and the real OpenRouter provider.
The response appended to an existing draft without submitting it. The ledger
contained the matching 3-second event at 0.008333333333 cents with organization
and workspace scope. A separate 2-second WAV request cost 0.005555555556 cents.
Neither response reported token counts. This checks integration, not transcription
quality; no user microphone audio was captured.

The reconciled PR was also checked against the current main branch: 43 focused
tests, the full workspace typecheck, and the app build passed. Live microphone
transcription succeeded again, preserving the existing draft.

Desktop and 390px mobile layouts (including recording and cancel controls) had
no horizontal overflow. Automated tests
cover cancellation, delayed microphone permission, late responses after unmount,
denied permission, recording timeout, silence, WAV encoding, workspace access,
upload limits, provider failures, and usage persistence including BYOK.



