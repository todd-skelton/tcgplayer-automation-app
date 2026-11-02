// corten ui 0.1.0: button 6620d9fa56c598fc
//! A button's look, as the classes of the `<button>` or `<a>` you write. The element is yours,
//! so `html!` still checks everything it takes (`type`, `disabled`, `href={url::Home}`,
//! `on:click`, `commandfor`), and the page has no element of the kit's around it:
//!
//! ```rust,ignore
//! <button type="submit" class={Button { variant: ButtonVariant::Destructive, size: ButtonSize::Sm }}>"Delete"</button>
//! <a href={url::Home} class={(Button { variant: ButtonVariant::Link, size: ButtonSize::Md }, Wide)}>"Home"</a>
//! ```
use corten::prelude::*;

/// Each variant is a class in `button.css`, so one without a rule does not compile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ButtonVariant {
    Primary,
    Secondary,
    Outline,
    Ghost,
    Destructive,
    Link,
    /// A step that goes ahead and cannot be taken back lightly, such as starting a batch.
    Success,
    /// An action that spends money or changes a mode, such as buying postage in test mode.
    Warning,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ButtonSize {
    Sm,
    Md,
    Lg,
    /// A square button holding an icon; give the element an `aria-label`.
    Icon,
}

/// A variant or size without a rule in `button.css` does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Button() -> impl Render {
///     html! { <span class={(Button, Huge)}></span> }
/// }
/// ```
#[component(css)]
pub fn Button(variant: ButtonVariant, size: ButtonSize) -> impl ClassList {
    let variant = match variant {
        ButtonVariant::Primary => Primary,
        ButtonVariant::Secondary => Secondary,
        ButtonVariant::Outline => Outline,
        ButtonVariant::Ghost => Ghost,
        ButtonVariant::Destructive => Destructive,
        ButtonVariant::Link => Link,
        ButtonVariant::Success => Success,
        ButtonVariant::Warning => Warning,
    };
    let size = match size {
        ButtonSize::Sm => Sm,
        ButtonSize::Md => Md,
        ButtonSize::Lg => Lg,
        ButtonSize::Icon => Icon,
    };
    (Button, variant, size)
}
