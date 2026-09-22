// Real Windows Tao/Wry integration; no mock event loop or application profile.
use std::sync::{atomic::{AtomicUsize, Ordering}, mpsc, Arc, Barrier};
use std::thread;
use tauri_runtime::{Runtime, RuntimeHandle, RuntimeInitArgs};
use tauri_runtime_wry::Wry;

fn main() {
  let mode = std::env::args().nth(1).expect("run or drop");
  let runtime = Wry::<()>::new(RuntimeInitArgs::default()).expect("create real Wry runtime");
  let handle = runtime.handle();
  let shutdown = Arc::new(Barrier::new(9));
  let count = Arc::new(AtomicUsize::new(0));
  let (ready_tx, ready_rx) = mpsc::channel();
  let workers: Vec<_> = (0..8).map(|_| {
    let handle = handle.clone();
    let shutdown = shutdown.clone();
    let count = count.clone();
    let ready = ready_tx.clone();
    let run = mode == "run";
    thread::spawn(move || {
      for _ in 0..100_000 {
        let copy = handle.clone();
        let _ = format!("{copy:?}");
        drop(copy);
      }
      if run {
        assert!(!handle.available_monitors().is_empty());
        assert!(handle.primary_monitor().is_some());
        assert!(handle.display_handle().is_ok());
        handle.run_on_main_thread(move || { count.fetch_add(1, Ordering::SeqCst); }).unwrap();
      }
      ready.send(()).unwrap();
      shutdown.wait();
      assert!(handle.run_on_main_thread(|| panic!("executed after shutdown")).is_err());
      assert!(handle.request_exit(0).is_err());
      assert!(handle.display_handle().is_err());
      assert!(handle.available_monitors().is_empty());
      assert!(handle.primary_monitor().is_none());
      for _ in 0..10_000 { drop(handle.clone()); }
    })
  }).collect();
  if mode == "run" {
    let exit_handle = handle.clone();
    let coordinator = thread::spawn(move || {
      for _ in 0..8 { ready_rx.recv().unwrap(); }
      exit_handle.request_exit(0).unwrap();
    });
    assert_eq!(runtime.run_return(|_| {}), 0);
    coordinator.join().unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 8);
  } else {
    assert_eq!(mode, "drop");
    // Drop while worker threads are cloning live runtime handles.
    drop(runtime);
    for _ in 0..8 { ready_rx.recv().unwrap(); }
  }
  shutdown.wait();
  for worker in workers { worker.join().unwrap(); }
  drop(handle);
  println!("PASS {mode}: real Wry, 8 workers, 880000 clones, post-shutdown calls rejected");
}
