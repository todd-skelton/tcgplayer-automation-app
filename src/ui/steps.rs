// corten ui 0.1.0: steps 4ae151eac68abd9a
//! The steps of a workflow, in order: a `<nav>` named by `label` around the `<ol>` of them,
//! which tells a screen reader which step each is (a `Timeline`, which is not for going
//! anywhere, is the `<ol>` named by `label`, with no `<nav>`). A step is a link to its page (a GET, so it can
//! be linked to and works without a script), or text for one with no page to go to. Its state is
//! written, not worked out from where it is: a done step is drawn with a check mark in place of its
//! number and says its words after its name to a screen reader ("(done)"), which the page does not
//! show; the current one is `aria-current="step"`; a blocked one (it cannot start until
//! something before it is fixed) is drawn with `!` in the warning color in place of its number,
//! with its words ("(blocked)"); a failed one (it ran and went wrong) with a cross in the
//! destructive color, with its words ("(failed)"); any other is numbered, with its words ("(not
//! started)", "(skipped)"). So a skipped step is not drawn done, and a finished workflow is every
//! step done. A step's `description` is a line under its name, outside its link, so the link is
//! named by the step's name alone.
//!
//! `layout` is `StepsLayout::Row` for the steps a user moves through (checkout): one row that
//! wraps, where a description is a note that a narrow screen (under 40rem) reads and does not show.
//! `StepsLayout::Timeline` is for what happened to something (a payout, an order): one step per row
//! down the page, a line between the marks, and each description (a time, a reference, why it
//! failed) shown beside its mark at every width.
//!
//! ```rust,ignore
//! <Steps label={t.steps()} layout={StepsLayout::Row} steps={&[
//!     Step { label: t.load(), description: None, link: Some(&url::Load), state: StepState::Done(t.done()) },
//!     Step { label: t.pick(), description: Some(t.pick_note()), link: Some(&url::Pick), state: StepState::Current },
//!     Step { label: t.ship(), description: None, link: None, state: StepState::Blocked(t.blocked()) },
//! ]} />
//! ```
use corten::{Href, prelude::*};

/// Where a step is in the workflow: what draws its mark and what a screen reader hears. The words
/// are the only way a screen reader learns a step is done or not started, so give every one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepState<'a> {
    /// Finished: a check mark in place of its number, and these words after its name, read by a
    /// screen reader and not shown ("(done)").
    Done(&'a str),
    /// The step the user is on: `aria-current="step"`, drawn filled.
    Current,
    /// Not finished: its number, and these words after its name, read and not shown
    /// ("(not started)", "(skipped)").
    Todo(&'a str),
    /// Cannot start until something before it is fixed: `!` in the warning color in place of its
    /// number, and these words after its name, read and not shown ("(blocked)"). Say what to fix
    /// on the page: in a `Row`, a phone does not show the step's `description`.
    Blocked(&'a str),
    /// Ran and went wrong (a refused payment): a cross in the destructive color in place of its
    /// number, and these words after its name, read and not shown ("(failed)"). Say why in its
    /// `description`, in a `Timeline`, or on the page.
    Failed(&'a str),
}

/// How the steps are laid out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepsLayout {
    /// One row that wraps, a description under its step's name from 40rem: a workflow the user
    /// moves through.
    Row,
    /// One step per row down the page, a description beside its mark at every width: what
    /// happened to something, in order.
    Timeline,
}

/// One step: its name, a line under it (`None` for none), a link to its page (`None` for a step
/// with no page to go to) and its state.
pub struct Step<'a> {
    pub label: &'a str,
    pub description: Option<&'a str>,
    pub link: Option<&'a dyn Href>,
    pub state: StepState<'a>,
}

/// A part without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Steps() -> impl Render {
///     html! { <nav class={(Steps, Sideways)}></nav> }
/// }
/// ```
#[component(css)]
pub fn Steps<'a>(label: &'a str, layout: StepsLayout, steps: &'a [Step<'a>]) -> impl Render {
    html! {
        if layout == StepsLayout::Timeline {
            <div class={(Steps, Timeline)}>
                <ol aria-label={label}>
                    for step in steps {
                        <StepItem step={step} />
                    }
                </ol>
            </div>
        } else {
            <nav class={Steps} aria-label={label}>
                <ol>
                    for step in steps {
                        <StepItem step={step} />
                    }
                </ol>
            </nav>
        }
    }
}

/// A step's `<li>`: its link or text, with its words for a screen reader, and its description.
#[component(css = Steps)]
fn StepItem<'a>(step: &'a Step<'a>) -> impl Render {
    let (done, blocked, failed, current, words) = match step.state {
        StepState::Done(words) => (Some(Done), None, None, None, words),
        StepState::Current => (None, None, None, Some("step"), ""),
        StepState::Todo(words) => (None, None, None, None, words),
        StepState::Blocked(words) => (None, Some(Blocked), None, None, words),
        StepState::Failed(words) => (None, None, Some(Failed), None, words),
    };
    html! {
        <li class={(done, blocked, failed)}>
            if let Some(link) = step.link {
                <a href={link} aria-current={current}>
                    {step.label}
                    if !words.is_empty() { <span class={Status}>{words}</span> }
                </a>
            } else {
                <span aria-current={current}>
                    {step.label}
                    if !words.is_empty() { <span class={Status}>{words}</span> }
                </span>
            }
            if let Some(description) = step.description {
                <small class={Description}>{description}</small>
            }
        </li>
    }
}
