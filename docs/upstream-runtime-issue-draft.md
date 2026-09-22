# Draft: Context Clone/Drop touches Tao Windows Rc across threads

Publication update: an existing matching upstream report and fix proposal were
found through GitHub API search. Evidence was posted to #15408 instead of opening
a duplicate issue:
https://github.com/tauri-apps/tauri/issues/15408#issuecomment-5781241142

Draft PR #16089 adds the standalone reproducer and instructions, complementing
the existing ownership-fix PR #15411 (not replacing it):
https://github.com/tauri-apps/tauri/pull/16089

The reproducer additionally crashed in 3/3 debug runs on upstream dev
0349b6fb8a77739146d6e0071cad33d9c083fc4f with Tao 0.37.0 / Wry 0.57.0.
Build and targeted Clippy passed; library tests passed with 0 tests.
The original local draft below is retained as investigation history.

Status: local draft, not submitted. A Windows-specific ownership patch is present
locally. A real Windows runtime regression and bounded full debug-app smoke test
have passed; see crash-2026-09-23.md. A same-source debug-build A/B reproduction
now crashes unpatched 2.11.4 in 5/5 runs and passes the patch in 5/5 runs.
Other platform payload ownership is unchanged and unvalidated.

Suggested repository: tauri-apps/tauri.

## Versions and evidence

- tauri 2.11.5, tauri-runtime-wry 2.11.4, tao 0.35.3, Windows x86_64.
- A release application terminated with STATUS_ILLEGAL_INSTRUCTION at an `ud2`
  in runtime Context::clone. Binary disassembly and a diagnostic LLVM IR build
  identify the non-atomic Rc strong-count increment in the nested Windows
  EventLoopWindowTarget clone. See crash-2026-09-23.md for the bounded evidence.
- The heap allocation was not captured in the minidump. The exact history of
  racing clone/drop operations cannot be reconstructed from this report.
- At review time the upstream dev branch still stores
  `main_thread: DispatcherMainThreadContext<T>` by value in a Clone Context.
  Confirm against a pinned upstream commit before submission.

## Ownership problem

### Minimal A/B reproduction

`examples/clone_race.rs` in the vendored crate uses only public safe APIs:
create Wry, keep it alive, synchronize 8 workers, and have each clone/drop its
runtime handle 100,000 times. Join the workers, then drop the runtime. It does
not call Debug on handles or assert patch-specific post-shutdown behavior.

Two isolated packages compiled identical source (SHA256
`8DC6A710F513D94B3CDD76CAEB7D4ABAFBCC09CD9A6A7E9ED4DC709F677C9BD6`), with the
same dependency names/versions: tauri-runtime-wry 2.11.4, tauri-runtime 2.11.3,
Tao 0.35.3, Wry 0.55.1. The sole dependency override was our patched runtime-wry.
The original used the unchanged crates.io package.

- Original, Windows debug: 5/5 processes exited with `0xC0000374` (heap corruption).
  Captured stderr includes an `alloc::rc` unsafe-precondition violation on a
  worker thread, before the workers-joined marker. Backtraces are incomplete.
- Patched, same source/settings: 5/5 processes exited 0 and printed PASS.
- Neither result was a timeout. No patch-specific assertion caused the original
  failures. Each process attempted 800,000 concurrent clone/drop operations.

This reproduces corruption through the safe handle-cloning path. Its exception
code differs from the application's original `0xC000001D`; do not claim identical
faulting instructions or a Release A/B result. Release A/B is not yet run.

Context is used through cross-thread runtime/window handles. Its derived Clone
copies DispatcherMainThreadContext, whose manually implemented Send/Sync safety
argument only discusses main-thread use. The inner Tao Windows target contains
`runner_shared: Rc<EventLoopRunner<T>>`.

Clone and Drop are uses too: they modify that non-atomic count even if no window
method is called on the worker. Safe handle-cloning APIs should not expose this
race to application code.

Related but not identical historical report:
https://github.com/tauri-apps/tauri/issues/10001 (different nested Rc field).

## Rejected Arc-only mitigation

Wrapping DispatcherMainThreadContext in Arc removes per-Context clones of the
inner Rc. This compiles in the application but is not a complete solution:

1. Keep a runtime/window handle on a worker while the runtime exits.
2. Release the runtime's owning reference on the event-loop thread.
3. Release the final handle on the worker.
4. The Arc then drops the inner thread-affine target on that worker.

The current LoopDestroyed branch invokes the Exit callback but does not establish
exclusive main-thread teardown of the shared context. Existing Debug and
monitor/display accessors should also be checked for thread-affine access.

## Requested upstream direction and regression coverage

The local Windows candidate uses owner-thread storage, a non-Send owner guard
and ID/liveness-only cross-thread handles. It removes the payload before Wry's
event-loop field is dropped and removes the payload's unsafe Send/Sync on Windows.
Monitor getters dispatch to the event-loop thread. Five ownership primitive
tests, a real Wry run_return/direct-drop test, and a bounded full debug-app test
with native windows and PTYs pass. Release stress and other desktop platforms
remain unvalidated. See QUE-PATCH.md for scope and implementation details.

Keep the thread-affine context owned and destroyed by the event-loop thread.
Cross-thread dispatchers should contain only safe shared metadata/proxies, with
well-defined failure after runtime shutdown. Do not solve shutdown by silently
leaking the context or enqueueing a destructor after the event loop has stopped.

Regression coverage should include concurrent handle clone/drop, window closure
with in-flight work, run_return and runtime destruction with worker-held handles,
and assertions that final thread-affine destruction occurs on the owner thread.
Validate other supported desktop backends before calling the change complete.

Do not upload the private application dump or user session data in the public
report. Use a minimal reproduction and sanitized instruction/stack evidence.
