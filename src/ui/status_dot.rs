// corten ui 0.1.0: status_dot 461a05a1486bb9f4
//! A dot in a status's color, before the words that name it:
//!
//! ```rust,ignore
//! <span class={Badge { tone: BadgeTone::Success, emphasis: BadgeEmphasis::Soft }}>
//!     <StatusDot tone={StatusTone::Success} />
//!     "Open"
//! </span>
//! ```
//!
//! The dot is drawn, not read (`aria-hidden`): color alone tells a status neither to everyone who
//! sees it nor to a screen reader, so the status is always in visible text beside it, never in a
//! `title` alone.
use corten::prelude::*;

/// The dot's color. Each is a class in `status_dot.css`, so one without a rule does not compile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatusTone {
    Neutral,
    Info,
    Success,
    Warning,
    Destructive,
}

/// A tone without a rule in `status_dot.css` does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn StatusDot() -> impl Render {
///     html! { <span class={(Dot, Pulsing)}></span> }
/// }
/// ```
#[component(css)]
pub fn StatusDot(tone: StatusTone) -> impl Render {
    let tone = match tone {
        StatusTone::Neutral => Neutral,
        StatusTone::Info => Info,
        StatusTone::Success => Success,
        StatusTone::Warning => Warning,
        StatusTone::Destructive => Destructive,
    };
    html! { <span class={(Dot, tone)} aria-hidden="true"></span> }
}
