// corten ui 0.1.0: control_width 7947ca4d42da0e68
//! A control's width, beside its look on the `<input>`, `<select>` or `<textarea>` you write.
//! In a `Field` a control fills the field's row; outside one an input or select has the
//! browser's natural width (a select its widest option's), so a search box sits beside its button,
//! and a textarea fills its container. Give it a width where the layout needs one:
//!
//! ```rust,ignore
//! <form class={Cluster { gap: Gap::Sm }} method="get" action={url::Orders::default()}>
//!     <input type="search" name={f.q} aria-label="Find an order" class={(Input {}, ControlWidth { width: Width::Md })}>
//!     <button class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}>"Find"</button>
//! </form>
//! ```
//!
//! `Sm`, `Md` and `Lg` are the theme's `--control-width-sm`, `-md` and `-lg` (8, 16 and 24rem),
//! never wider than the container, and a field's row grows the control only up to them (a postal
//! code in a field). `Full` fills the container. A widget's own parts (corten-ui's `ComboBox`
//! input) are out of its reach.
use corten::prelude::*;

/// Each width is a class in `control_width.css`, so one without a rule does not compile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Width {
    Sm,
    Md,
    Lg,
    Full,
}

/// A width without a rule in `control_width.css` does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn ControlWidth() -> impl ClassList {
///     (ControlWidth, Xl)
/// }
/// ```
#[component(css)]
pub fn ControlWidth(width: Width) -> impl ClassList {
    let width = match width {
        Width::Sm => Sm,
        Width::Md => Md,
        Width::Lg => Lg,
        Width::Full => Full,
    };
    (ControlWidth, width)
}
