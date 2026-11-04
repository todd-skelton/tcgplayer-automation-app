//! The app's glyphs beyond the kit's set, each copied from [Lucide](https://lucide.dev) as the kit
//! Icon's docs ask, so the copied `ui/icon.rs` stays as the kit wrote it. Lucide's ISC license is
//! at the end of `ui/icon.rs`.
use crate::ui::icon::Glyph;

/// `package`: inventory.
pub const PACKAGE: Glyph = Glyph::new(
    r#"<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><polyline points="3.29 7 12 12 20.71 7"/><path d="m7.5 4.27 9 5.15"/>"#,
);
/// `layers`: a batch.
pub const LAYERS: Glyph = Glyph::new(
    r#"<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>"#,
);
/// `repeat`: continuous pricing.
pub const REPEAT: Glyph = Glyph::new(
    r#"<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>"#,
);
/// `badge-dollar-sign`: a price.
pub const BADGE_DOLLAR_SIGN: Glyph = Glyph::new(
    r#"<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 18V6"/>"#,
);
/// `chart-line`: a strategy's figures.
pub const CHART_LINE: Glyph =
    Glyph::new(r#"<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m19 9-5 5-4-4-3 3"/>"#);
/// `wallet`: economics.
pub const WALLET: Glyph = Glyph::new(
    r#"<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>"#,
);
/// `truck`: shipping.
pub const TRUCK: Glyph = Glyph::new(
    r#"<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>"#,
);
/// `database`: stored data.
pub const DATABASE: Glyph = Glyph::new(
    r#"<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>"#,
);
/// `globe`: a connection to another site.
pub const GLOBE: Glyph = Glyph::new(
    r#"<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>"#,
);
/// `square`: a shipment not packed yet.
pub const SQUARE: Glyph = Glyph::new(r#"<rect width="18" height="18" x="3" y="3" rx="2"/>"#);
/// `square-check`: a shipment packed.
pub const SQUARE_CHECK: Glyph =
    Glyph::new(r#"<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/>"#);
