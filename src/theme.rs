//! The design tokens (`tokens/`, W3C Design Tokens), in place of the React app's MUI theme: its
//! blue, a light and a dark theme that follows the system, and the utility classes made from them.
//!
//! Colors are roles, named as the Corten UI kit names them (`--background`, `--card`,
//! `--primary`, `--muted-foreground`, `--border`, `--input`, `--ring`, ...), with the tones an
//! operator screen needs added: `--success`, `--warning`, `--info` and `--destructive`, each with
//! `-foreground` for text on it and `-soft` for a surface tinted by it. Every text color meets
//! WCAG AA (4.5:1) on the surfaces it is drawn on, in both themes, and `--input` 3:1. The scales
//! (`--space-*`, `--radius-*`, `--font-size-*`, `--shadow-*`) are groups, with Rust enums and
//! utilities; `--radius` is the kit's corner.
corten::style::tokens!("tokens/tokens.resolver.json");

use corten::style::ClassList;

/// A raised panel: the surface, its border, and room inside.
pub fn panel() -> impl ClassList {
    (bg_card(), rounded_md(), shadow_sm(), p_4())
}

/// A row of items, vertically centered, `space` apart, wrapping on a narrow screen.
pub fn row(space: Space) -> impl ClassList {
    (display_flex(), items_center(), flex_wrap(), gap(space))
}

/// Secondary text.
pub fn muted() -> impl ClassList {
    (fg_muted(), text_sm())
}
