// corten ui 0.1.0: badge 8548824b950ec04c
//! A short label: a status, a count, a tag, as the classes of the element you write, so an id or a
//! patch target is on the badge itself. Its tone and its emphasis are separate, so one tone can be
//! a filled status, a soft one and an outlined count:
//!
//! ```rust,ignore
//! <span class={Badge { tone: BadgeTone::Success, emphasis: BadgeEmphasis::Solid }}>"Shipped"</span>
//! <span class={Badge { tone: BadgeTone::Success, emphasis: BadgeEmphasis::Outline }}>{count}" successful"</span>
//! ```
//!
//! The text of each tone and emphasis meets WCAG AA contrast in both themes (the kit's test).
use corten::prelude::*;

/// Each tone is a class in `badge.css`, so one without a rule does not compile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BadgeTone {
    Neutral,
    Primary,
    Info,
    Success,
    Warning,
    Destructive,
}

/// How much the badge stands out: filled with its tone, a tint of it, or an outline.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BadgeEmphasis {
    Solid,
    Soft,
    Outline,
}

/// A tone without a rule in `badge.css` does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Badge() -> impl ClassList {
///     (Badge, Shiny)
/// }
/// ```
#[component(css)]
pub fn Badge(tone: BadgeTone, emphasis: BadgeEmphasis) -> impl ClassList {
    let tone = match tone {
        BadgeTone::Neutral => Neutral,
        BadgeTone::Primary => Primary,
        BadgeTone::Info => Info,
        BadgeTone::Success => Success,
        BadgeTone::Warning => Warning,
        BadgeTone::Destructive => Destructive,
    };
    let emphasis = match emphasis {
        BadgeEmphasis::Solid => Solid,
        BadgeEmphasis::Soft => Soft,
        BadgeEmphasis::Outline => Outline,
    };
    (Badge, tone, emphasis)
}
