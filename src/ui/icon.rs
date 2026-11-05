// corten ui 0.1.0: icon d8fb90a3726752e6
//! An icon from the kit's set, drawn as an `<svg>` in the page at the text's size and color, so it
//! needs no request and follows the theme, a hover's color and a disabled button's opacity. Each
//! glyph is a constant here, so a name the set lacks does not compile:
//!
//! ```rust,ignore
//! <button class={Button { variant: ButtonVariant::Ghost, size: ButtonSize::Icon }} type="button" aria-label="Delete">
//!     <Icon glyph={icon::TRASH} />
//! </button>
//! <a class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Sm }} href={url::Export}>
//!     <Icon glyph={icon::DOWNLOAD} />
//!     "Export"
//! </a>
//! ```
//!
//! An icon is a picture of what the text says, so a screen reader skips it (`aria-hidden`) and
//! the control carries the name: its text, an `aria-label` on a `<button>` or `<a>` of yours,
//! `VisuallyHidden` text where the kit draws the element (a `MenuButton`'s trigger). An icon that
//! says something on its own (a warning beside a row) has text beside it, visible or
//! `VisuallyHidden`, rather than a label of its own.
//!
//! The glyphs are [Lucide](https://lucide.dev)'s, the set's license below. To add one, copy the
//! elements inside its `<svg>` (lucide.dev, "Copy SVG") into a constant in a module of your own,
//! so this file stays as the kit wrote it; the stroke is the stylesheet's, so leave the `<svg>`'s
//! attributes out. A glyph a design fills (a rated star, a saved heart) is made with
//! `Glyph::filled`, so it is drawn filled wherever it is used:
//!
//! ```rust,ignore
//! // src/glyphs.rs
//! use crate::ui::icon::Glyph;
//!
//! /// `package`: a shipment.
//! pub const PACKAGE: Glyph = Glyph::new(r#"<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><polyline points="3.29 7 12 12 20.71 7"/><path d="m7.5 4.27 9 5.15"/>"#);
//! /// `star`, filled: rated.
//! pub const STAR: Glyph = Glyph::filled(r#"<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>"#);
//! ```
//!
//! A glyph's text is placed in the page as it is, so a `Glyph` takes only a `&'static str`, a
//! literal in the app's source: text a request brought does not compile, unless the app keeps it
//! for the life of the process (leaked, or in a static), as it could hand it to `raw` itself.
use corten::prelude::*;

/// The elements inside an icon's `<svg>`, on Lucide's 24 by 24 grid, as a `&'static str` (a
/// literal in the app's source), and whether it is drawn filled.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Glyph {
    svg: &'static str,
    filled: bool,
}

impl Glyph {
    /// A glyph drawn in lines, as Lucide draws it: `Glyph::new(r#"<path d=".."/>"#)`.
    pub const fn new(svg: &'static str) -> Self {
        Self { svg, filled: false }
    }

    /// A glyph drawn filled in the text's color as well as in lines, for a design whose glyph
    /// says a state by its fill (a rated star, a saved heart).
    pub const fn filled(svg: &'static str) -> Self {
        Self { svg, filled: true }
    }
}

/// A part without a rule in `icon.css` does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Icon() -> impl Render {
///     html! { <svg class={(Icon, Spinning)}></svg> }
/// }
/// ```
#[component(css)]
pub fn Icon(glyph: Glyph) -> impl Render {
    html! {
        <svg class={(Icon, glyph.filled.then_some(Filled))} viewBox="0 0 24 24" aria-hidden="true">
            {raw(glyph.svg)}
        </svg>
    }
}

/// `x`: close: a dialog, a sheet, a toast, a chip.
pub const X: Glyph = Glyph::new(r#"<path d="M18 6 6 18"/><path d="m6 6 12 12"/>"#);
/// `ellipsis-vertical`: more actions: a row's menu.
pub const ELLIPSIS_VERTICAL: Glyph = Glyph::new(
    r#"<circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>"#,
);
/// `menu`: a menu of the site.
pub const MENU: Glyph =
    Glyph::new(r#"<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/>"#);
/// `chevron-down`: opens below.
pub const CHEVRON_DOWN: Glyph = Glyph::new(r#"<path d="m6 9 6 6 6-6"/>"#);
/// `chevron-up`: closes above.
pub const CHEVRON_UP: Glyph = Glyph::new(r#"<path d="m18 15-6-6-6 6"/>"#);
/// `chevron-left`: back, previous.
pub const CHEVRON_LEFT: Glyph = Glyph::new(r#"<path d="m15 18-6-6 6-6"/>"#);
/// `chevron-right`: forward, next.
pub const CHEVRON_RIGHT: Glyph = Glyph::new(r#"<path d="m9 18 6-6-6-6"/>"#);
/// `arrow-up-right`: goes to another page.
pub const ARROW_UP_RIGHT: Glyph = Glyph::new(r#"<path d="M7 7h10v10"/><path d="M7 17 17 7"/>"#);
/// `external-link`: opens another site.
pub const EXTERNAL_LINK: Glyph = Glyph::new(
    r#"<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>"#,
);
/// `check`: done, chosen.
pub const CHECK: Glyph = Glyph::new(r#"<path d="M20 6 9 17l-5-5"/>"#);
/// `plus`: add.
pub const PLUS: Glyph = Glyph::new(r#"<path d="M5 12h14"/><path d="M12 5v14"/>"#);
/// `minus`: remove one.
pub const MINUS: Glyph = Glyph::new(r#"<path d="M5 12h14"/>"#);
/// `trash` (was `trash-2`): delete.
pub const TRASH: Glyph = Glyph::new(
    r#"<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>"#,
);
/// `copy`: copy.
pub const COPY: Glyph = Glyph::new(
    r#"<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>"#,
);
/// `download`: download.
pub const DOWNLOAD: Glyph = Glyph::new(
    r#"<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>"#,
);
/// `upload`: upload.
pub const UPLOAD: Glyph = Glyph::new(
    r#"<path d="M12 3v12"/><path d="m17 8-5-5-5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>"#,
);
/// `printer`: print.
pub const PRINTER: Glyph = Glyph::new(
    r#"<path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><rect x="6" y="14" width="12" height="8" rx="1"/>"#,
);
/// `save`: save.
pub const SAVE: Glyph = Glyph::new(
    r#"<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>"#,
);
/// `refresh-cw`: load again.
pub const REFRESH: Glyph = Glyph::new(
    r#"<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>"#,
);
/// `search`: search.
pub const SEARCH: Glyph =
    Glyph::new(r#"<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>"#);
/// `funnel`: filter.
pub const FUNNEL: Glyph = Glyph::new(
    r#"<path d="M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z"/>"#,
);
/// `layout-grid`: show as a grid.
pub const LAYOUT_GRID: Glyph = Glyph::new(
    r#"<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>"#,
);
/// `list`: show as a list.
pub const LIST: Glyph = Glyph::new(
    r#"<path d="M3 5h.01"/><path d="M3 12h.01"/><path d="M3 19h.01"/><path d="M8 5h13"/><path d="M8 12h13"/><path d="M8 19h13"/>"#,
);
/// `settings`: settings.
pub const SETTINGS: Glyph = Glyph::new(
    r#"<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>"#,
);
/// `keyboard`: keyboard shortcuts.
pub const KEYBOARD: Glyph = Glyph::new(
    r#"<path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/><path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/>"#,
);
/// `circle-question-mark` (was `circle-help`): help.
pub const CIRCLE_HELP: Glyph = Glyph::new(
    r#"<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>"#,
);
/// `info`: information.
pub const INFO: Glyph =
    Glyph::new(r#"<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>"#);
/// `triangle-alert`: a warning.
pub const TRIANGLE_ALERT: Glyph = Glyph::new(
    r#"<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>"#,
);

// ISC License
//
// Copyright (c) 2026 Lucide Icons and Contributors
//
// Permission to use, copy, modify, and/or distribute this software for any
// purpose with or without fee is hereby granted, provided that the above
// copyright notice and this permission notice appear in all copies.
//
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
// WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
// ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
// WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
// ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
// OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
//
// ---
//
// The following Lucide icons are derived from the Feather project:
//
// airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out
//
// The MIT License (MIT) (for the icons listed above)
//
// Copyright (c) 2013-present Cole Bemis
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
