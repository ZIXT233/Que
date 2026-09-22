//! Windows dispatcher handles contain only an ID and an atomic liveness flag.
//! The non-Send payload stays in its creator thread's local registry, including
//! destruction. A handle surviving the runtime never owns the payload.
use std::{
  any::Any,
  cell::RefCell,
  collections::HashMap,
  marker::PhantomData,
  rc::Rc,
  sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Arc},
  thread::{self, ThreadId},
};

thread_local! {
  static VALUES: RefCell<HashMap<u64, Box<dyn Any>>> = RefCell::new(HashMap::new());
}
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

pub struct Handle<T: 'static> {
  id: u64,
  thread: ThreadId,
  alive: Arc<AtomicBool>,
  // Describes the result type without pretending to own a T across threads.
  marker: PhantomData<fn() -> T>,
}

impl<T: 'static> Clone for Handle<T> {
  fn clone(&self) -> Self {
    Self { id: self.id, thread: self.thread, alive: self.alive.clone(), marker: PhantomData }
  }
}

impl<T: 'static> std::fmt::Debug for Handle<T> {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("MainThreadHandle").field("id", &self.id)
      .field("alive", &self.is_alive()).finish()
  }
}

impl<T: 'static> Handle<T> {
  pub fn is_alive(&self) -> bool { self.alive.load(Ordering::Acquire) }

  pub fn get(&self) -> Option<Rc<T>> {
    if thread::current().id() != self.thread || !self.is_alive() { return None; }
    VALUES.with(|values| values.borrow().get(&self.id)
      .and_then(|v| v.downcast_ref::<Rc<T>>()).cloned())
  }
}

pub struct Owner<T: 'static> {
  handle: Handle<T>,
  // Owner cannot leave the creator thread. No unsafe Send/Sync impl is needed.
  marker: PhantomData<Rc<T>>,
}

impl<T: 'static> Owner<T> {
  pub fn new(value: T) -> Self {
    let handle = Handle {
      id: NEXT_ID.fetch_add(1, Ordering::Relaxed), thread: thread::current().id(),
      alive: Arc::new(AtomicBool::new(true)), marker: PhantomData,
    };
    VALUES.with(|values| { values.borrow_mut().insert(handle.id, Box::new(Rc::new(value))); });
    Self { handle, marker: PhantomData }
  }

  pub fn handle(&self) -> Handle<T> { self.handle.clone() }
}

impl<T: 'static> Drop for Owner<T> {
  fn drop(&mut self) {
    self.handle.alive.store(false, Ordering::Release);
    // Release the registry borrow before user destructors can reenter it.
    let value = VALUES.with(|values| values.borrow_mut().remove(&self.handle.id));
    drop(value);
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::{mpsc, Barrier};

  struct Payload { report: mpsc::Sender<ThreadId>, _not_send: Rc<()> }
  impl Drop for Payload {
    fn drop(&mut self) { self.report.send(thread::current().id()).unwrap(); }
  }

  #[test]
  fn workers_clone_and_drop_handles_while_payload_stays_on_owner() {
    let (tx, rx) = mpsc::channel();
    let owner = Owner::new(Payload { report: tx, _not_send: Rc::new(()) });
    let handle = owner.handle();
    let workers: Vec<_> = (0..8).map(|_| {
      let handle = handle.clone();
      thread::spawn(move || {
        for _ in 0..10_000 {
          let copy = handle.clone();
          assert!(copy.is_alive());
          assert!(copy.get().is_none());
        }
      })
    }).collect();
    for worker in workers { worker.join().unwrap(); }
    assert!(rx.try_recv().is_err());
    drop(owner);
    assert_eq!(rx.recv().unwrap(), thread::current().id());
    assert!(handle.get().is_none());
  }

  #[test]
  fn worker_handle_outlives_shutdown_without_owning_payload() {
    let (tx, rx) = mpsc::channel();
    let owner = Owner::new(Payload { report: tx, _not_send: Rc::new(()) });
    let handle = owner.handle();
    let barrier = Arc::new(Barrier::new(2));
    let worker_barrier = barrier.clone();
    let worker = thread::spawn(move || {
      worker_barrier.wait();
      assert!(!handle.is_alive());
      assert!(handle.get().is_none());
      drop(handle);
    });
    drop(owner);
    assert_eq!(rx.recv().unwrap(), thread::current().id());
    barrier.wait();
    worker.join().unwrap();
  }

  #[test]
  fn in_flight_owner_borrow_finishes_on_owner_after_shutdown() {
    let (tx, rx) = mpsc::channel();
    let owner = Owner::new(Payload { report: tx, _not_send: Rc::new(()) });
    let handle = owner.handle();
    let borrowed = handle.get().unwrap();
    drop(owner);
    assert!(handle.get().is_none());
    assert!(rx.try_recv().is_err());
    drop(borrowed);
    assert_eq!(rx.recv().unwrap(), thread::current().id());
  }

  #[test]
  fn concurrent_clone_drop_during_owner_shutdown() {
    let (tx, rx) = mpsc::channel();
    let owner = Owner::new(Payload { report: tx, _not_send: Rc::new(()) });
    let barrier = Arc::new(Barrier::new(9));
    let workers: Vec<_> = (0..8).map(|_| {
      let handle = owner.handle();
      let barrier = barrier.clone();
      thread::spawn(move || {
        barrier.wait();
        for _ in 0..10_000 {
          let copy = handle.clone();
          assert!(copy.get().is_none());
          drop(copy);
        }
      })
    }).collect();
    barrier.wait();
    drop(owner);
    assert_eq!(rx.recv().unwrap(), thread::current().id());
    for worker in workers { worker.join().unwrap(); }
    assert!(rx.try_recv().is_err());
  }

  #[test]
  fn destructor_can_reenter_registry_after_invalidation() {
    struct Reentrant { handle: Rc<RefCell<Option<Handle<Reentrant>>>> }
    impl Drop for Reentrant {
      fn drop(&mut self) {
        assert!(self.handle.borrow().as_ref().unwrap().get().is_none());
        let another = Owner::new(42);
        assert_eq!(*another.handle().get().unwrap(), 42);
        drop(another);
      }
    }
    let slot = Rc::new(RefCell::new(None));
    let owner = Owner::new(Reentrant { handle: slot.clone() });
    *slot.borrow_mut() = Some(owner.handle());
    drop(owner);
  }
}
