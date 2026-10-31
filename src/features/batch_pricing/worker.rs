//! The pricing worker's loop (`inventoryBatchPricingWorker.server.ts`'s tick): put back jobs whose
//! lease ran out, claim the most urgent queued one, and price it while its lease is renewed; when
//! the queue is empty, wait for the poll interval or for a request that queued a job.
//!
//! The loop is over a [`Jobs`] queue so its timing is tested on a paused clock; the Postgres queue
//! is [`super::queue`]. On shutdown the job in progress stops and its lease is given back, so the
//! next process claims it at once rather than after the lease runs out.
use std::{future::Future, sync::Arc, time::Duration};

use corten::Signal;
use tokio::{
    sync::Notify,
    time::{MissedTickBehavior, interval, sleep},
};

/// How long a claim lasts unless renewed.
pub const LEASE: Duration = Duration::from_millis(15_000);
/// How often a job in progress renews its claim.
pub const HEARTBEAT: Duration = Duration::from_millis(2_000);
/// How often an empty queue is looked at again.
pub const POLL: Duration = Duration::from_millis(1_000);

/// What tells the loop to stop: the task's [`Signal`] when served. A test cannot abort a
/// `Signal` (its `abort` is Corten's own), so the loop takes this and tests pass their own.
#[allow(async_fn_in_trait, reason = "used generically within this crate")]
pub trait Stop {
    fn is_stopped(&self) -> bool;
    async fn stopped(&self);
}

impl Stop for Signal {
    fn is_stopped(&self) -> bool {
        self.is_aborted()
    }
    async fn stopped(&self) {
        self.aborted().await;
    }
}

/// How a job ended.
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    Completed,
    Failed(String),
    /// Shutdown began: the job is given back to the queue.
    Released,
    /// Another worker holds the job now (the lease ran out): this one stops without writing.
    LeaseLost,
}

/// A queue of jobs and the work each is.
#[allow(async_fn_in_trait, reason = "used generically within this crate")]
pub trait Jobs {
    type Job;
    async fn requeue_expired(&self) -> Result<(), String>;
    async fn claim(&self) -> Result<Option<Self::Job>, String>;
    /// Renews the claim; false when the job is no longer this worker's.
    async fn renew(&self, job: &Self::Job) -> Result<bool, String>;
    /// Prices the job and saves what it priced: `Ok` completed, `Err` failed.
    fn work(&self, job: &Self::Job) -> impl Future<Output = Result<(), String>>;
    async fn finished(&self, job: &Self::Job, outcome: &Outcome) -> Result<(), String>;
}

/// One job, its claim renewed every [`HEARTBEAT`] while it runs; the work stops when shutdown
/// begins or the claim is lost.
pub async fn process<J: Jobs>(jobs: &J, job: &J::Job, stop: &impl Stop) -> Outcome {
    let work = jobs.work(job);
    tokio::pin!(work);
    let mut heartbeat = interval(HEARTBEAT);
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    heartbeat.tick().await; // the first tick is at once; the claim was just made
    let outcome = loop {
        tokio::select! {
            biased;
            _ = stop.stopped() => break Outcome::Released,
            done = &mut work => break match done {
                Ok(()) => Outcome::Completed,
                Err(why) => Outcome::Failed(why),
            },
            _ = heartbeat.tick() => match jobs.renew(job).await {
                Ok(true) => {}
                Ok(false) => break Outcome::LeaseLost,
                // A renewal that fails is retried at the next beat; the lease outlasts several.
                Err(why) => eprintln!("Pricing job heartbeat failed: {why}"),
            },
        }
    };
    if let Err(why) = jobs.finished(job, &outcome).await {
        eprintln!("Pricing job could not be marked {outcome:?}: {why}");
    }
    outcome
}

/// The loop, until shutdown. `queued` is notified by the request that queues a job.
pub async fn run<J: Jobs>(jobs: J, queued: Arc<Notify>, stop: impl Stop) {
    loop {
        if stop.is_stopped() {
            return;
        }
        let claimed = match jobs.requeue_expired().await {
            Ok(()) => jobs.claim().await,
            Err(why) => Err(why),
        };
        match claimed {
            Ok(Some(job)) => {
                if process(&jobs, &job, &stop).await == Outcome::Released {
                    return;
                }
                // Straight on to the next job, as Node's tick schedules itself at 0.
                continue;
            }
            Ok(None) => {}
            Err(why) => eprintln!("Pricing worker failed: {why}"),
        }
        // A sleep from now, not an interval: a long job must not leave ticks owed.
        tokio::select! {
            biased;
            _ = stop.stopped() => return,
            _ = queued.notified() => {}
            _ = sleep(POLL) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        cell::{Cell, RefCell},
        collections::VecDeque,
    };

    use tokio::{sync::watch, time::Instant};

    use super::*;

    /// A stop a test can trigger.
    struct Stopper(watch::Receiver<bool>);

    impl Stop for Stopper {
        fn is_stopped(&self) -> bool {
            *self.0.borrow()
        }
        async fn stopped(&self) {
            let mut seen = self.0.clone();
            let _ = seen.wait_for(|stopped| *stopped).await;
        }
    }

    /// Jobs that take a set time, each event logged with the clock.
    struct Fake {
        queue: RefCell<VecDeque<(u32, Duration)>>,
        log: RefCell<Vec<(u64, String)>>,
        renewals: Cell<u32>,
        lose_lease_after: Option<u32>,
        start: Instant,
    }

    impl Fake {
        fn new(jobs: &[(u32, u64)]) -> Self {
            Fake {
                queue: RefCell::new(
                    jobs.iter()
                        .map(|(id, secs)| (*id, Duration::from_secs(*secs)))
                        .collect(),
                ),
                log: RefCell::default(),
                renewals: Cell::new(0),
                lose_lease_after: None,
                start: Instant::now(),
            }
        }
        fn note(&self, what: String) {
            let at = self.start.elapsed().as_millis() as u64;
            self.log.borrow_mut().push((at, what));
        }
    }

    impl Jobs for &Fake {
        type Job = (u32, Duration);
        async fn requeue_expired(&self) -> Result<(), String> {
            Ok(())
        }
        async fn claim(&self) -> Result<Option<Self::Job>, String> {
            let job = self.queue.borrow_mut().pop_front();
            if let Some((id, _)) = job {
                self.note(format!("claim {id}"));
            }
            Ok(job)
        }
        async fn renew(&self, _: &Self::Job) -> Result<bool, String> {
            self.renewals.set(self.renewals.get() + 1);
            Ok(self
                .lose_lease_after
                .is_none_or(|n| self.renewals.get() <= n))
        }
        fn work(&self, job: &Self::Job) -> impl Future<Output = Result<(), String>> {
            sleep(job.1).then_ok()
        }
        async fn finished(&self, job: &Self::Job, outcome: &Outcome) -> Result<(), String> {
            self.note(format!("{} {outcome:?}", job.0));
            Ok(())
        }
    }

    trait ThenOk: Future<Output = ()> + Sized {
        async fn then_ok(self) -> Result<(), String> {
            self.await;
            Ok(())
        }
    }
    impl<F: Future<Output = ()>> ThenOk for F {}

    fn signal() -> (Stopper, impl FnOnce()) {
        let (send, receive) = watch::channel(false);
        (Stopper(receive), move || {
            send.send_replace(true);
        })
    }

    #[tokio::test(start_paused = true)]
    async fn a_long_job_renews_its_claim_and_leaves_no_ticks_owed() {
        let fake = Fake::new(&[(1, 10)]);
        let (signal, stop) = signal();
        let queued = Arc::new(Notify::new());
        let worker = run(&fake, queued.clone(), signal);
        tokio::select! {
            _ = worker => {}
            _ = async {
                sleep(Duration::from_millis(12_500)).await;
                fake.queue.borrow_mut().push_back((2, Duration::from_secs(1)));
                // Found at the next poll (13 s), a second after the queue was last seen empty:
                // not in a burst of polls owed for the ten seconds the first job took.
                sleep(Duration::from_secs(3)).await;
                stop();
                sleep(Duration::from_secs(1)).await;
            } => {}
        }
        assert_eq!(
            fake.renewals.get(),
            4,
            "at 2, 4, 6 and 8 seconds into a 10 second job"
        );
        let log = fake.log.borrow();
        assert_eq!(log[0], (0, "claim 1".into()));
        assert_eq!(log[1], (10_000, "1 Completed".into()));
        assert_eq!(log[2], (13_000, "claim 2".into()));
    }

    #[tokio::test(start_paused = true)]
    async fn shutdown_mid_job_gives_the_job_back_at_once() {
        let fake = Fake::new(&[(1, 60)]);
        let (signal, stop) = signal();
        let worker = run(&fake, Arc::new(Notify::new()), signal);
        tokio::join!(worker, async {
            sleep(Duration::from_millis(5_500)).await;
            stop();
        });
        assert_eq!(
            *fake.log.borrow().last().unwrap(),
            (5_500, "1 Released".into())
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_queued_job_wakes_the_worker_before_the_poll() {
        let fake = Fake::new(&[]);
        let (signal, stop) = signal();
        let queued = Arc::new(Notify::new());
        let worker = run(&fake, queued.clone(), signal);
        tokio::join!(worker, async {
            sleep(Duration::from_millis(1_250)).await;
            fake.queue.borrow_mut().push_back((7, Duration::ZERO));
            queued.notify_one();
            sleep(Duration::from_millis(100)).await;
            stop();
        });
        assert_eq!(fake.log.borrow()[0], (1_250, "claim 7".into()));
    }

    #[tokio::test(start_paused = true)]
    async fn a_lost_claim_stops_the_job_without_completing_it() {
        let mut fake = Fake::new(&[(1, 60)]);
        fake.lose_lease_after = Some(2);
        let (signal, stop) = signal();
        let worker = run(&fake, Arc::new(Notify::new()), signal);
        tokio::join!(worker, async {
            sleep(Duration::from_secs(8)).await;
            stop();
        });
        assert_eq!(fake.log.borrow()[1], (6_000, "1 LeaseLost".into()));
    }
}
