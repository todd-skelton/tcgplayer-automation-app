// corten ui 0.1.0: segmented 92327be22be5aaea
//! A segmented control: a few choices side by side, the chosen one raised, as the tab list in
//! `Tabs` is drawn. Three kinds of choice wear it:
//!
//! 1. corten-ui's `ChoiceGroup` written inside `Segmented`: one choice of a few that a script
//!    shows or a link loads (`role="radiogroup"`, the chosen one `aria-checked="true"`). Its
//!    behavior and markup are corten-ui's (docs/guide/ui.md), so the app lists
//!    `corten_ui::COMPONENTS` too.
//! 2. `SegmentedLinks` on a `<nav>` of links, each a view the server renders (a filter, an
//!    order), the current one `aria-current="page"`, which a screen reader announces. They are
//!    navigation, not a choice within the page, and work without a script.
//! 3. `SegmentedRadios`: a `<fieldset>` with its legend around native radio buttons, each the
//!    app's `<input type="radio">` in a `SegmentedRadio`. A form sends the choice and CSS reads
//!    it (`:has(:checked)`), which neither does for a `ChoiceGroup`'s options; it needs no
//!    script, and the arrow keys move it, as any radios'. The inputs are hidden under their
//!    labels, and the chosen one's label is raised. A disabled fieldset or input is drawn
//!    disabled. The legend is shown over the choices (`Legend::Shown`) or read by a screen reader
//!    only (`Legend::Hidden`), for a choice its place on the page already explains.
//!
//! ```rust,ignore
//! <Segmented><ChoiceGroup choice={&period} label={t.period()} options={&periods} /></Segmented>
//!
//! <nav class={SegmentedLinks {}} aria-label={t.filter()}>
//!     <a href={url::Accounts { filter: None }} aria-current={current(None)}>{t.all()}</a>
//!     <a href={url::Accounts { filter: Some(Filter::Credits) }} aria-current={current(Some(Filter::Credits))}>{t.credits()}</a>
//! </nav>
//!
//! <SegmentedRadios legend={Legend::Shown(t.mode())}>
//!     <SegmentedRadio label={t.observed()}><input type="radio" name={f.mode} value={Mode::Observed} checked></SegmentedRadio>
//!     <SegmentedRadio label={t.manual()}><input type="radio" name={f.mode} value={Mode::Manual}></SegmentedRadio>
//! </SegmentedRadios>
//! ```
use corten::prelude::*;

/// A part without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Segmented() -> impl Render {
///     html! { <div class={(Segmented, Vertical)}></div> }
/// }
/// ```
#[component(css)]
pub fn Segmented<C: Render>(children: C) -> impl Render {
    html! { <div class={Segmented}>{children}</div> }
}

/// The segmented look on a `<nav>` of links, the current one `aria-current="page"`.
#[component(css = Segmented)]
pub fn SegmentedLinks() -> impl ClassList {
    Links
}

/// A `SegmentedRadios` legend, which names the choice for a screen reader either way.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Legend<'a> {
    /// Drawn over the choices.
    Shown(&'a str),
    /// Read by a screen reader only: the choices' place on the page says what they choose.
    Hidden(&'a str),
}

/// Native radio buttons drawn as a segmented control: a `<fieldset>` with its legend, the
/// choices in a row under it.
#[component(css = Segmented)]
pub fn SegmentedRadios<'a, C: Render>(legend: Legend<'a>, children: C) -> impl Render {
    let (text, hidden) = match legend {
        Legend::Shown(text) => (text, None),
        Legend::Hidden(text) => (text, Some(Hidden)),
    };
    html! {
        <fieldset class={Radios}>
            <legend class={hidden}>{text}</legend>
            <div class={Track}>{children}</div>
        </fieldset>
    }
}

/// One choice: the app's `<input type="radio">`, hidden under its label.
#[component(css = Segmented)]
pub fn SegmentedRadio<'a, C: Render>(label: &'a str, children: C) -> impl Render {
    html! { <label class={Choice}>{children}<span>{label}</span></label> }
}
