// corten ui 0.1.0: status_dot ee2438a35862a606
//! A dot in a status's color, before the words that name it:
//!
//! ```rust,ignore
//! <p><StatusDot tone={StatusTone::Success} />" Open"</p>
//! ```
//!
//! In a badge the dot takes the badge's text color, `StatusTone::Text`, so the status's tone is
//! written once, on the badge, and the dot shows in a `Solid` badge too (one in the badge's own
//! tone would be the color of its fill):
//!
//! ```rust,ignore
//! <span class={Badge { tone, emphasis: BadgeEmphasis::Solid }}>
//!     <StatusDot tone={StatusTone::Text} />
//!     "Open"
//! </span>
//! ```
//!
//! The dot is drawn, not read (`aria-hidden`): color alone tells a status neither to everyone who
//! sees it nor to a screen reader, so the status is always in visible text beside it, never in a
//! `title` alone.
//!
//! `LiveDot` is the dot of a live view's badge: it pulses while the `<corten-live>` around it is
//! live, so a glance tells a live view from a frozen one, and is still while the stream connects,
//! reconnects or has closed or ended, before the runtime runs and without JavaScript. Outside a
//! `<corten-live>` it is still. It pulses only for a user who has not asked for less motion, and
//! the motion is never the only sign: the words beside it must follow the stream too, as the
//! element's `status` attribute does. Inside nested streams the dot pulses while any of them is
//! live, and the words the rules below show say "Live" then too.
//!
//! ```rust,ignore
//! <corten-live src={url::LotFeed { id }}>
//!     <span class={Badge { tone: BadgeTone::Info, emphasis: BadgeEmphasis::Soft }}>
//!         <LiveDot tone={StatusTone::Text} />
//!         <span class={WhenLive}>"Live"</span>
//!         <span class={WhenNot}>"Not live"</span>
//!     </span>
//!     ..
//! </corten-live>
//! ```
//!
//! with these rules in the stylesheet of the component that draws the badge, so the words are
//! "Not live" before the runtime runs and without JavaScript, as the dot is still:
//!
//! ```css
//! .when-live { display: none; }
//! :where(corten-live[status="live"]) .when-live { display: inline; }
//! :where(corten-live[status="live"]) .when-not { display: none; }
//! ```
//!
//! A word for each state (`connecting`, `reconnecting`, `closed`, `ended`) is the same rule
//! with that `status`, or text a `corten-status` handler writes (the live-data guide).
//!
//! It is a component of its own rather than a variant of `StatusDot`: where it is placed decides
//! what it draws, and every still dot stays `StatusDot { tone }`.
use corten::prelude::*;

/// The dot's color. Each is a class in `status_dot.css`, so one without a rule does not compile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatusTone {
    /// The color of the text around it: a badge's, in a badge.
    Text,
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
///     html! { <span class={(Dot, Blinking)}></span> }
/// }
/// ```
#[component(css)]
pub fn StatusDot(tone: StatusTone) -> impl Render {
    let tone = match tone {
        StatusTone::Text => Text,
        StatusTone::Neutral => Neutral,
        StatusTone::Info => Info,
        StatusTone::Success => Success,
        StatusTone::Warning => Warning,
        StatusTone::Destructive => Destructive,
    };
    html! { <span class={(Dot, tone)} aria-hidden="true"></span> }
}

/// A status dot that pulses while the `<corten-live>` around it is live.
#[component(css = StatusDot)]
pub fn LiveDot(tone: StatusTone) -> impl Render {
    let tone = match tone {
        StatusTone::Text => Text,
        StatusTone::Neutral => Neutral,
        StatusTone::Info => Info,
        StatusTone::Success => Success,
        StatusTone::Warning => Warning,
        StatusTone::Destructive => Destructive,
    };
    html! { <span class={(Dot, Live, tone)} aria-hidden="true"></span> }
}
