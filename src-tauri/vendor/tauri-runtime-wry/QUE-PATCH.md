# Que patch to tauri-runtime-wry 2.11.4

Upstream source: crates.io `tauri-runtime-wry` 2.11.4, with its MIT and Apache
licenses retained. Changes are in `src/lib.rs`, `src/main_thread_context.rs`,
and `examples/ownership_lifecycle.rs` / `examples/clone_race.rs`; Cargo example
discovery is enabled.

`Context` is shared through runtime/window dispatchers across threads. Its derived
Clone previously cloned `DispatcherMainThreadContext` by value, including Tao's
Windows `EventLoopWindowTarget`. In Tao 0.35.3 that target contains
`runner_shared: Rc<EventLoopRunner<T>>`. Cross-thread clone/drop therefore touched
a non-atomic reference count, even though actual window operations were correctly
marshalled to the main thread.

On Windows, store the payload in its creator thread's registry. Context carries
only an ID, owner thread ID and atomic liveness flag. Access yields an Rc only
on the owner thread. A non-Send Owner in Wry invalidates handles and removes the
payload before the event-loop field is destroyed. Registry borrows are released
before payload destruction to allow destructor reentry. Worker-held handles
cannot retain the payload or cause its final release on another thread.

## Lifecycle and scope

This replaces the earlier Arc-only mitigation, which could release the inner
target on the last worker thread. The payload's unsafe Send/Sync implementations
are disabled on Windows. Debug prints safe handle metadata, monitor getters use
the event-loop message path, and the Windows display handle has no native pointer.
New send_user_message/request_exit calls reject invalidated handles; monitor APIs
return None/empty on dispatch failure. A late new-window callback denies creation
after invalidation. Existing queued-message shutdown behavior is unchanged.

Other platforms retain upstream payload ownership. Five no-GUI tests of the new
ownership primitive cover concurrent clone/drop, shutdown with worker-held
handles, owner-local in-flight references, and destructor reentry.

The real Windows runtime example also passes in both modes:

```
cargo build --manifest-path src-tauri/Cargo.toml -p tauri-runtime-wry --example ownership_lifecycle
src-tauri/target/debug/examples/ownership_lifecycle.exe run
src-tauri/target/debug/examples/ownership_lifecycle.exe drop
```

Each mode uses 8 worker threads and 880,000 handle clones. The run mode starts
the real Tao event loop, dispatches monitor queries and main-thread tasks, then
requests exit and joins workers retaining handles past run_return. The drop mode
drops Wry while workers clone handles. Both assert rejected calls after shutdown.

The full debug application was built and launched with an isolated profile:
10 native card-window detach/attach cycles with live terminal output, 8 concurrent
PTY sessions and 80 resize requests passed. Destroying the last app window while
those PTYs were still running reached terminal-shutdown=complete; all recorded
test processes exited. No new Windows crash event or dump appeared. This bounded
debug run does not establish long-duration release-build reliability. The
installed application was not replaced. See docs/crash-2026-09-23.md.

Do not edit the Cargo registry cache. Keep this explicit Cargo patch until an
upstream release addresses the nested reference-count ownership, then remove it.
