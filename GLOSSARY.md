# Glossary

Domain terms used across the server, worker and SDKs.

## Run creation

Admitting, materialising, publishing and starting a Run as one step. A Run is either fully created (published, then started or deferred) or it does not exist. Callers describe the Run's sources (new files, or new versions of existing Documents); they never write Documents or sequence publish/start themselves.
