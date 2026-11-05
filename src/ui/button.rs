// corten ui 0.1.0: button d057506fed65eb6d
//! A button's look, as the classes of the `<button>` or `<a>` you write. The element is yours,
//! so `html!` still checks everything it takes (`type`, `disabled`, `href={url::Home}`,
//! `on:click`, `commandfor`), and the page has no element of the kit's around it:
//!
//! ```rust,ignore
//! <button type="submit" class={Button { variant: ButtonVariant::Destructive, size: ButtonSize::Sm }}>"Delete"</button>
//! <button type="submit" class={Button { variant: ButtonVariant::Warning, size: ButtonSize::Md }}>"Buy postage"</button>
//! <a href={url::Home} class={(Button { variant: ButtonVariant::Link, size: ButtonSize::Md }, Wide)}>"Home"</a>
//! ```
use corten::prelude::*;

/// Each variant is a class in `button.css`, so one without a rule does not compile. `Info`,
/// `Success`, `Warning` and `Destructive` are filled with their tone, as a `Solid` Badge or
/// Alert is: what tells or opens more (`Info`), what goes ahead (`Success`), what spends money
/// or changes a mode (`Warning`), what deletes or cannot be undone (`Destructive`). Their text
/// meets WCAG AA in both themes (the theme's `-foreground` pairs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ButtonVariant {
    Primary,
    Secondary,
    Outline,
    Ghost,
    Info,
    Success,
    Warning,
    Destructive,
    Link,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ButtonSize {
    Sm,
    Md,
    Lg,
    /// A square button holding an icon. Name the `<button>` you write with `aria-label`; a
    /// control whose element the kit draws (a `MenuButton`'s trigger) takes `VisuallyHidden` text.
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
        ButtonVariant::Info => Info,
        ButtonVariant::Success => Success,
        ButtonVariant::Warning => Warning,
        ButtonVariant::Destructive => Destructive,
        ButtonVariant::Link => Link,
    };
    let size = match size {
        ButtonSize::Sm => Sm,
        ButtonSize::Md => Md,
        ButtonSize::Lg => Lg,
        ButtonSize::Icon => Icon,
    };
    (Button, variant, size)
}
