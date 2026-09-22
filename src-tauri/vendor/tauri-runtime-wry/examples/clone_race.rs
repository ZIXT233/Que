use std::{hint::black_box, sync::{Arc, Barrier}, thread};
use tauri_runtime::{Runtime, RuntimeInitArgs};
use tauri_runtime_wry::Wry;
fn main() {
    let runtime = Wry::<()>::new(RuntimeInitArgs::default()).unwrap();
    let handle = runtime.handle();
    let start = Arc::new(Barrier::new(9));
    let workers: Vec<_> = (0..8).map(|_| {
        let handle = handle.clone();
        let start = start.clone();
        thread::spawn(move || {
            start.wait();
            for _ in 0..100_000 {
                let copy = black_box(handle.clone());
                black_box(&copy);
                drop(copy);
            }
        })
    }).collect();
    eprintln!("START 8 workers x 100000 clone/drop; runtime remains alive");
    start.wait();
    for worker in workers { worker.join().unwrap(); }
    eprintln!("JOINED workers");
    drop(handle);
    drop(runtime);
    println!("PASS clone/drop and runtime teardown");
}
