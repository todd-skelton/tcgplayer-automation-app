// corten ui 0.1.0
//! The design system's components: the Corten UI kit's, which `corten ui add` copied into
//! `src/ui/` and are the app's to change, and the app's own built from them. Their colors, spacing
//! and corners are the app's one token file (`crate::theme`, `tokens/`), whose color names are the
//! kit's (`--background`, `--primary`, ...) with the tones an operator screen needs added
//! (`--success`, `--warning`, `--info`, each with `-foreground` and `-soft`).

use corten::Component;

pub mod accordion;
pub mod alert;
pub mod avatar;
pub mod badge;
pub mod breadcrumb;
pub mod button;
pub mod card;
pub mod checkbox;
pub mod combobox;
pub mod dialog;
pub mod dropdown_menu;
pub mod field;
pub mod input;
pub mod pagination;
pub mod panel;
pub mod popover;
pub mod radio_group;
pub mod segmented;
pub mod select;
pub mod separator;
pub mod sheet;
pub mod skeleton;
pub mod slider;
pub mod switch;
pub mod table;
pub mod tabs;
pub mod textarea;
pub mod toasts;

/// Each component with a stylesheet, after the tokens: `App::components(ui::COMPONENTS)`.
pub const COMPONENTS: &[Component] = &[
    accordion::Accordion,
    alert::Alert,
    avatar::Avatar,
    badge::Badge,
    breadcrumb::Breadcrumb,
    button::Button,
    card::Card,
    checkbox::Checkbox,
    combobox::Combobox,
    dialog::Dialog,
    dropdown_menu::DropdownMenu,
    field::Field,
    input::Input,
    pagination::Pagination,
    panel::Panel,
    popover::Popover,
    radio_group::RadioGroup,
    segmented::Segmented,
    select::Select,
    separator::Separator,
    sheet::Sheet,
    skeleton::Skeleton,
    slider::Slider,
    switch::Switch,
    table::Table,
    tabs::Tabs,
    textarea::Textarea,
    toasts::Toasts,
];

/// Asserts each `<label for>` in `html` names exactly one element's id: a kit `Field` is given its
/// control's id apart from the control, so a page's test checks the two agree. Returns the count.
#[cfg(test)]
pub fn assert_labels_name_their_controls(html: &str) -> usize {
    let starts: Vec<usize> = html
        .match_indices("<label for=\"")
        .map(|(at, _)| at + 12)
        .collect();
    for at in &starts {
        let id = &html[*at..];
        let id = &id[..id.find('"').unwrap()];
        assert_eq!(
            html.matches(&format!(" id=\"{id}\"")).count(),
            1,
            "label for {id}: {html}"
        );
    }
    starts.len()
}
