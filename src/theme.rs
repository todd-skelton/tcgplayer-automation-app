//! The design tokens (`tokens.json`), in place of the React app's MUI theme: the same blue, a
//! light and a dark theme that follows the system, and the utility classes made from them.
corten::style::tokens!("tokens.json");

use corten::style::ClassList;

/// A raised panel: the surface, its border, and room inside.
pub fn panel() -> impl ClassList {
    (bg_surface(), rounded_md(), shadow_sm(), p_4())
}

/// A row of items, vertically centered, `space` apart, wrapping on a narrow screen.
pub fn row(space: Space) -> impl ClassList {
    (display_flex(), items_center(), flex_wrap(), gap(space))
}

/// Secondary text.
pub fn muted() -> impl ClassList {
    (fg_muted(), text_sm())
}
