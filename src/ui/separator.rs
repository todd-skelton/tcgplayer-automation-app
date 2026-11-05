// corten ui 0.1.0: separator a4b3ea5ee3c62eb0
//! A line between sections: `<hr>`, so it is a thematic break to a screen reader.
//! `<Separator orientation={Orientation::Vertical} />` stands between items in a row.
use corten::prelude::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Orientation {
    Horizontal,
    Vertical,
}

/// A orientation without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Separator() -> impl Render {
///     html! { <hr class={(Separator, Diagonal)}> }
/// }
/// ```
#[component(css)]
pub fn Separator(orientation: Orientation) -> impl Render {
    html! {
        match orientation {
            Orientation::Horizontal => <hr class={(Separator, Horizontal)}>,
            Orientation::Vertical => <hr class={(Separator, Vertical)} aria-orientation="vertical">,
        }
    }
}
