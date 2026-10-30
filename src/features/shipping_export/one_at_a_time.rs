//! Work that must not run twice at once, whichever tab or computer asks: buying postage, which
//! is paid for, and marking orders shipped, which messages buyers.
use std::sync::atomic::{AtomicBool, Ordering};

/// One kind of work, running or not.
pub struct OneAtATime(AtomicBool);

/// The work running, until it is dropped.
pub struct Running(&'static OneAtATime);

impl OneAtATime {
    pub const fn new() -> Self {
        OneAtATime(AtomicBool::new(false))
    }

    /// The work, or none while it is already running.
    pub fn start(&'static self) -> Option<Running> {
        self.0
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Running(self))
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        (self.0).0.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn work_runs_once_at_a_time() {
        static WORK: OneAtATime = OneAtATime::new();
        let first = WORK.start().expect("nothing is running");
        assert!(WORK.start().is_none(), "a second waits for the first");
        drop(first);
        assert!(WORK.start().is_some(), "the first is over");
    }
}
