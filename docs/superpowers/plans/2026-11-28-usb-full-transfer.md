# USB full transfer implementation plan

**Goal:** Restore full USB transfers and reduce total offline time, including preparation and application, for Windows and Termux.

**Design**

Keep the v2 connection and full snapshot wire format. Updated peers prepare the receiver asynchronously while the source freezes its data, and skip the receiver basis. Detect live changes with local file metadata. Hash source bytes while copying. On the receiver, verify the stream, copy and hash the independent candidate together, and check the result against the received manifest. Move Git metadata within the candidate. Flush and validate the candidate before retiring the previous recovery point. Keep the actual post-apply baseline, transactional replacement and rollback. VPS and Drive use their existing preparation paths.

**Evidence:** The supplied log reports 301 seconds in preflight, 665 seconds preparing the receiver basis, and 14 seconds on the wire. These phase labels include local hashing/copying; no physical-device speedup is claimed from container tests.

**Alternatives considered**

Disabling delta negotiation alone would leave the full live hashes and a possible idle timeout before body consumption. Moving the received tree into the candidate would give external hard links or stale handles access to the files being installed. Combining copy and verification keeps independent candidate files and reduces disk reads while preserving integrity and rollback.

## Tasks

- [x] Add a USB-specific metadata change guard with tests for edits, restored mtimes, additions/deletions, Git identity and forbidden links.
- [x] Add opt-in copy-and-hash source snapshots; prove equivalence with ordinary snapshots and independent staged files.
- [x] Make full preparation/transfer the production USB path, retaining legacy v2 full fallback and safe asynchronous receipts for updated peers.
- [x] Copy and hash the independent application candidate together, verify its manifest, and move Git metadata within the candidate. Flush and validate it before retiring the previous recovery point. Keep the target edit guard, actual target baseline, health check and recovery.
- [x] Update full-transfer regression and integration tests, UI descriptions and release documentation.
- [x] Run USB and complete project tests, compare a reproducible local fixture, and resolve independent review findings.
- [ ] Publish only after the repository CI has validated the exact release commit.

## Review focus

- Updated and legacy peers in both directions, including manifests over the control JSON size limit.
- Slow receiver preparation and post-transfer validation without premature application or socket timeout.
- Same-size edits with restored modification times, malformed or truncated streams, extra or modified staged bytes, and candidate isolation from staged file aliases and handles.
- Preserve target local fields, deletion semantics and the previous recovery point before replacement.
- Windows/Termux file attributes, Git metadata and default non-USB behavior.

**Validation:** `npm run test:usb`, `npm run test:usb:integration`, `npm test`, existing CI commands as required. Local HTTP tests do not measure the user's cable or phone.

## Verification record

Local unit tests: 503 passed, 4 platform skips, 0 failed (507 total). VPS Python tests: 40 passed. Real SillyTavern USB integration: 10 checks passed. Independent review fixes were reproduced before correction and their regression tests now pass. See `docs/test-results/usb-full-transfer-linux.json` for measured loopback runs and hardware limitations.

Old v2 peers retain their original local scanning and socket timeout behavior; both endpoints must be updated to obtain the new asynchronous preparation and completion handling.
