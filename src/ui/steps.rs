// corten ui 0.1.0: steps fea3d6bb989f05b3
//! The steps of a workflow, in order: a `<nav>` named by `label` around the `<ol>` of them,
//! which tells a screen reader which step each is. A step is a link to its page (a GET, so it can
//! be linked to and works without a script), or text for one with no page to go to. Its state is
//! written, not worked out from where it is: a done step is drawn with a check mark in place of its
//! number and says its words after its name to a screen reader ("(done)"), which the page does not
//! show; the current one is `aria-current="step"`; a blocked one (it cannot start until
//! something before it is fixed) is drawn with `!` in the warning color in place of its number,
//! with its words ("(blocked)"); any other is numbered, with its words ("(not started)",
//! "(skipped)"). So a skipped step is not drawn done, and a finished workflow is every step done.
//! A step's `description` is a line under its name, outside its link, so the link is named by the
//! step's name alone; on a narrow screen (under 40rem) it is not shown and is still read.
//!
//! ```rust,ignore
//! <Steps label={t.steps()} steps={&[
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
    /// on the page: a phone does not show the step's `description`.
    Blocked(&'a str),
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
///     html! { <nav class={(Steps, Vertical)}></nav> }
/// }
/// ```
#[component(css)]
pub fn Steps<'a>(label: &'a str, steps: &'a [Step<'a>]) -> impl Render {
    html! {
        <nav class={Steps} aria-label={label}>
            <ol>
                for step in steps {
                    <StepItem step={step} />
                }
            </ol>
        </nav>
    }
}

/// A step's `<li>`: its link or text, with its words for a screen reader, and its description.
#[component(css = Steps)]
fn StepItem<'a>(step: &'a Step<'a>) -> impl Render {
    let (done, blocked, current, words) = match step.state {
        StepState::Done(words) => (Some(Done), None, None, words),
        StepState::Current => (None, None, Some("step"), ""),
        StepState::Todo(words) => (None, None, None, words),
        StepState::Blocked(words) => (None, Some(Blocked), None, words),
    };
    html! {
        <li class={(done, blocked)}>
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
