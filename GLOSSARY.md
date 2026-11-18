# Glossary

Domain terms used across the server, worker and SDKs.

## Run creation

Admitting, materialising, publishing and starting a Run as one step. A Run is either fully created (published, then started or deferred) or it does not exist. Callers describe the Run's sources (new files, or new versions of existing Documents); they never write Documents or sequence publish/start themselves.

## Page basis

The pages a Document is split, indexed and billed on (its page count, and the billing pages measured when they differ), together with the spend check every change to them owes. A Run's documents change their page basis only by recording a measurement (a counted page tree, frames read from an image, Office pages counted from the extractor's text, page equivalents); the page basis decides which count changes, applies the floors, keeps the Run's page total in step and re-checks the Run's spend across all of its documents, pausing the Run or refusing the Document when the balance no longer covers it. Callers never write page counts or sum other documents' extra pages themselves, and a page basis that cannot check refuses rather than skips.
