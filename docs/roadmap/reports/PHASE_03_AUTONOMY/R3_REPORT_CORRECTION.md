# R3 REPORT CORRECTION — MAIN SHA TRANSCRIPTION ONLY

Correction type: append-only documentation correction. The original R3 evidence JSON and logs are unchanged.

## Correction

The `MAIN_SHA` value transcribed in `RH2_PRODUCTION_R3_REPORT.md` was incorrect:

```text
incorrect transcribed MAIN_SHA = 0400138123e11d8e20b0aaf1628bd02316037d96
```

The correct canonical GitHub `origin/main` SHA verified after a fresh `git fetch origin` is:

```text
correct canonical MAIN_SHA     = 0400138123e11e8d20b0aaf1628bd02316037d96
```

Reason: report transcription typo only.

The six-file R3 deployment hashes, Owner, Full SDDL, DACL, inheritance evidence, rollback status, and runtime soak evidence are unchanged and independently verified. This correction does not alter production code, production configuration, or raw evidence.
