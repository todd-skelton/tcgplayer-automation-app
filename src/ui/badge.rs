// corten ui 0.1.0: badge 37abab51a2d97fc8
//! A short label: a status, a count, a tag. `<Badge variant={BadgeVariant::Secondary}>"Draft"</Badge>`.
use corten::prelude::*;

/// Each variant is a class in `badge.css`, so one without a rule does not compile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BadgeVariant {
    Primary,
    Secondary,
    Outline,
    Destructive,
    /// A status that is done or healthy.
    Success,
    /// A status to look at.
    Warning,
    /// A status to know.
    Info,
}

/// A variant without a rule in `badge.css` does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Badge() -> impl Render {
///     html! { <span class={(Badge, Shiny)}></span> }
/// }
/// ```
#[component(css)]
pub fn Badge<C: Render>(variant: BadgeVariant, children: C) -> impl Render {
    let variant = match variant {
        BadgeVariant::Primary => Primary,
        BadgeVariant::Secondary => Secondary,
        BadgeVariant::Outline => Outline,
        BadgeVariant::Destructive => Destructive,
        BadgeVariant::Success => Success,
        BadgeVariant::Warning => Warning,
        BadgeVariant::Info => Info,
    };
    html! { <span class={(Badge, variant)}>{children}</span> }
}
